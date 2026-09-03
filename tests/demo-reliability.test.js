const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { computeConsensus } = require("../backend/incidentPipeline");

const projectRoot = path.resolve(__dirname, "..");

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`;
}

async function importPure(relativePath) {
  return import(dataModule(fs.readFileSync(path.join(projectRoot, relativePath), "utf8")));
}

async function importReplay(demoSource = fs.readFileSync(path.join(projectRoot, "src/data/hazeScenario.mock.js"), "utf8")) {
  const hazeUrl = dataModule(demoSource);
  let source = fs.readFileSync(path.join(projectRoot, "src/data/replayResponses.js"), "utf8");
  source = source.replace(
    /import\s+\{\s*cloneScenario\s*,\s*rawReports\s*\}\s+from\s+["'][^"']+["'];/,
    `const { cloneScenario, rawReports } = await import(${JSON.stringify(hazeUrl)});`
  );
  return import(dataModule(source));
}

async function importClient() {
  let source = fs.readFileSync(path.join(projectRoot, "src/services/crisisRouteClient.js"), "utf8");
  source = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];\s*/g, "");
  return import(dataModule(source));
}

function rehearsalIncident(label) {
  const score = Number(label) * 5 + 50;
  const gates = ["G_LOCATION", "G_CONTACT", "G_RESOURCE", "G_CONFLICT"].map(id => ({
    id,
    passed: true,
    status: "passed"
  }));
  return {
    label,
    caseId: `CR-OFFLINE-${label}`,
    scores: { verification: score, urgency: 80, actionability: 82 },
    modelReviews: {
      analyst: { scores: { verification: score - 2, urgency: 82, actionability: 80 } },
      reviewer: { scores: { verification: score + 2, urgency: 78, actionability: 84 } }
    },
    modelDebate: { consensus: "AGREEMENT" },
    operationalState: label === "01" ? "DISPATCH_CANDIDATE" : "QUEUED_ACTION",
    safetyGates: gates,
    gonka: {
      analyst: { model: "offline-analyst", responseId: `offline-analyst-${label}`, latencyMs: 1 },
      reviewer: { model: "offline-reviewer", responseId: `offline-reviewer-${label}`, latencyMs: 1 }
    }
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function createRehearsalHarness({
  failurePhase,
  failureStatus = 502,
  failureBody,
  networkFailure = false,
  nonJsonFailure = false,
  qualityFailure = false,
  cleanupFailure = false,
  rendererFailure = false,
  serverStartFailure = false
} = {}) {
  const rehearsal = require("../scripts/live-judge-rehearsal");
  const incidents = ["01", "02", "03", "04", "05"].map(rehearsalIncident);
  const logs = [];
  let serverOptions;
  let proofCalls = 0;
  const fakeServer = {
    listening: false,
    once() {},
    listen(_port, _host, callback) {
      this.listening = true;
      callback();
    },
    address() { return { port: 43111 }; },
    close(callback) {
      this.listening = false;
      callback();
    }
  };

  const routePhase = pathname => {
    if (pathname === "/api/health/gonka") return "HEALTH";
    if (pathname === "/api/incidents/analyze") return "ANALYZE";
    if (pathname.endsWith("/decision")) return "DECISION";
    if (pathname.endsWith("/brief")) return "BRIEF";
    if (pathname.endsWith("/audit")) return "AUDIT";
    if (pathname === "/api/proof/verify") return "PROOF";
    return "UNKNOWN";
  };

  const fetchImpl = async (target, options = {}) => {
    const pathname = target.pathname;
    const phase = routePhase(pathname);
    if (phase === "ANALYZE" && !networkFailure) {
      const gonkaClient = serverOptions.gonkaClientFactory();
      await Promise.all([
        gonkaClient.completeJson({ model: "offline-analyst" }),
        gonkaClient.completeJson({ model: "offline-reviewer" })
      ]);
    }
    if (phase === failurePhase) {
      if (networkFailure) throw new Error("PRIVATE_NETWORK_STACK_MUST_NOT_LEAK");
      if (nonJsonFailure) return new Response("PRIVATE_NON_JSON_BODY_MUST_NOT_LEAK", { status: failureStatus });
      return jsonResponse(failureBody || {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: "The local request was not accepted.",
          retryable: false,
          failedRole: phase === "ANALYZE" ? "reviewer" : undefined,
          rawBody: "PRIVATE_RAW_BODY_MUST_NOT_LEAK",
          stack: "PRIVATE_STACK_MUST_NOT_LEAK"
        }
      }, failureStatus);
    }
    if (phase === "HEALTH") {
      return jsonResponse({
        ok: true,
        liveRoutesReady: true,
        capabilities: { fullScenario: true, decision: true, brief: true }
      });
    }
    if (phase === "ANALYZE") return jsonResponse({ ok: true, incidents });
    if (phase === "DECISION") {
      return jsonResponse({ decision: { recordStatus: "RECORDED", executionStatus: "NOT_EXECUTED" } });
    }
    if (phase === "BRIEF") {
      return jsonResponse({
        brief: { briefId: "BR-OFFLINE", status: "READY", executionStatus: "NOT_EXECUTED", summary: "Offline brief" },
        proofCapsule: { capsuleId: "PC-OFFLINE" }
      });
    }
    if (phase === "AUDIT") return jsonResponse({ chainValid: true, audit: [{ sequence: 1 }] });
    if (phase === "PROOF") {
      proofCalls += 1;
      return jsonResponse({ valid: proofCalls === 1 });
    }
    return jsonResponse({ ok: false }, 404);
  };

  const dependencies = {
    log: line => logs.push(String(line)),
    createServerImpl: options => {
      serverOptions = options;
      return serverStartFailure ? null : fakeServer;
    },
    createGonkaClientImpl: () => ({
      completeJson: async () => ({ data: {}, trace: {} })
    }),
    evaluateImpl: () => ({
      fullPassed: !qualityFailure,
      incidentCount: 5,
      labels: ["01", "02", "03", "04", "05"]
    }),
    fetchImpl,
    closeServerImpl: async server => {
      if (server?.listening) server.listening = false;
      if (cleanupFailure) throw new Error("PRIVATE_CLEANUP_STACK_MUST_NOT_LEAK");
    },
    isPortListeningImpl: async () => false,
    renderImpl: rendererFailure ? () => { throw new Error("PRIVATE_RENDER_STACK_MUST_NOT_LEAK"); } : rehearsal.renderRunSummary,
    now: (() => {
      let value = 1_000;
      return () => ++value;
    })()
  };
  return { rehearsal, dependencies, logs, incidents, fakeServer };
}

let reliability;
let replay;

test.before(async () => {
  reliability = await importPure("src/ui/demoReliability.js");
  replay = await importReplay();
});

test("three modes expose exact trust labels and proof boundaries", () => {
  const live = reliability.modeProvenance("live");
  const replayMode = reliability.modeProvenance("replay");
  const demo = reliability.modeProvenance("mock");
  assert.equal(live.title, "Live Gonka analysis");
  assert.deepEqual(live.lines, ["Two model requests", "Human action still required"]);
  assert.equal(replayMode.title, "Sanitized recorded acceptance replay");
  assert.ok(replayMode.lines.includes("No network request in this load"));
  assert.ok(replayMode.lines.includes("Response IDs redacted"));
  assert.equal(demo.title, "Synthetic local demonstration data");
  assert.ok(demo.lines.includes("Not a model result"));
  assert.equal(reliability.proofAvailability("replay", {}).verificationEnabled, false);
  assert.equal(reliability.proofAvailability("mock", {}).verificationEnabled, false);
});

test("replay provenance is explicit, sanitized and network-free", () => {
  assert.deepEqual(replay.REPLAY_PROVENANCE, {
    fixtureKind: "sanitized_acceptance_replay",
    sourceRun: "B7-Q2-R1",
    acceptedAt: "2026-08-31T08:00:00.000Z",
    sanitized: true,
    networkRequestsThisLoad: 0,
    responseIdsRedacted: true,
    proofAvailable: false
  });
  const labels = reliability.replayTraceLabels(replay.getReplayScenario().meta);
  assert.equal(labels.valid, true);
  assert.equal(labels.currentInference, false);
});

test("replay is deterministic across consecutive loads", () => {
  assert.deepEqual(replay.getReplayScenario(), replay.getReplayScenario());
});

test("replay preserves all five canonical messages in order", () => {
  const result = replay.getReplayScenario();
  assert.deepEqual(result.rawReports, [
    "Block C hostel: six students are coughing badly, one has asthma. Need N95 masks and clinic transport.",
    "Another Block C resident reports heavy smoke smell and several students waiting near the lobby.",
    "FORWARD: 20 students trapped in Hostel B!!! Send everything now!!!",
    "Family near Shah Alam says an elderly parent has breathing difficulty due to haze. Exact location and callback number are unclear.",
    "Sports day is still scheduled despite haze; one notice says proceed, while another group claims cancellation."
  ]);
});

test("replay five-case accepted scores, consensus and states are exact", () => {
  const expected = {
    "01": [[40, 85, 80], [65, 75, 85], [53, 80, 83], "DISAGREEMENT", "DISPATCH_CANDIDATE"],
    "02": [[10, 90, 20], [15, 70, 20], [13, 80, 20], "DISAGREEMENT", "MERGE_OR_VERIFY"],
    "03": [[20, 80, 15], [20, 75, 15], [20, 78, 15], "AGREEMENT", "URGENT_VERIFICATION"],
    "04": [[30, 50, 30], [35, 30, 40], [33, 40, 35], "DISAGREEMENT", "NEEDS_HUMAN_REVIEW"],
    "05": [[50, 40, 70], [70, 45, 75], [60, 43, 73], "DISAGREEMENT", "QUEUED_ACTION"]
  };
  const axes = scores => [scores.verification, scores.urgency, scores.actionability];
  for (const incident of replay.getReplayScenario().incidents) {
    const accepted = expected[incident.label];
    assert.deepEqual(axes(incident.modelReviews.analyst.scores), accepted[0]);
    assert.deepEqual(axes(incident.modelReviews.reviewer.scores), accepted[1]);
    assert.deepEqual(axes(incident.scores), accepted[2]);
    assert.equal(incident.modelDebate.consensus, accepted[3]);
    assert.equal(incident.operationalState, accepted[4]);
  }
});

test("replay contains no live IDs, prompt, raw model output, decision, brief or proof", () => {
  const result = replay.getReplayScenario();
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /recorded-response|chatcmpl|req_[A-Za-z0-9]|sk-[A-Za-z0-9_-]{8,}|rawContent|hiddenReasoning|Authorization/i);
  for (const incident of result.incidents) {
    assert.equal(incident.gonka.analyst.responseId, "[REDACTED]");
    assert.equal(incident.gonka.reviewer.responseId, "[REDACTED]");
    assert.equal(incident.humanDecision, null);
    assert.equal(incident.actionBrief, null);
    assert.equal(incident.operationalBrief, null);
    assert.equal(incident.proofCapsule, null);
  }
});

test("all required safe failure codes classify without internal fields", () => {
  for (const code of reliability.SAFE_FAILURE_CODES) {
    const failure = reliability.classifyFailure({
      status: 502,
      code,
      message: `${code} safe message`,
      retryable: true,
      failedRole: "reviewer",
      roleErrors: { reviewer: code, intruder: "STACK_SECRET" },
      stack: "STACK_SECRET",
      cause: "CAUSE_SECRET",
      rawBody: "RAW_SECRET"
    });
    assert.equal(failure.code, code);
    assert.equal(failure.failedRole, "reviewer");
    assert.equal("stack" in failure, false);
    assert.equal("cause" in failure, false);
    assert.equal("rawBody" in failure, false);
    assert.equal("intruder" in (failure.roleErrors || {}), false);
  }
});

test("invalid role and unknown code fail closed", () => {
  const failure = reliability.classifyFailure({ code: "INTERNAL_STACK_DUMP", failedRole: "secret-role", message: "secret" });
  assert.equal(failure.code, "UNKNOWN_SAFE_ERROR");
  assert.equal(failure.failedRole, "not_available");
  assert.doesNotMatch(failure.message, /secret/);
});

test("network failure permits only explicit manual retry and never automatic retry", () => {
  let state = reliability.createReliabilityState("mock");
  state = reliability.beginLiveAttempt(state, { requestId: "one", messages: ["fixed"] });
  state = reliability.failLiveAttempt(state, { code: "NETWORK_ERROR", message: "Safe network error", retryable: true, failedRole: "analyst" }, "one");
  assert.equal(state.mode, "mock");
  assert.equal(state.lastFailure.failedRole, "analyst");
  assert.equal(state.lastFailure.retry.allowed, true);
  assert.equal(state.automaticRetryCount, 0);
  assert.equal(state.automaticReplayFallbackCount, 0);
});

test("timeout never switches model or silently opens replay", () => {
  let state = reliability.createReliabilityState("live");
  state = reliability.beginLiveAttempt(state, { requestId: "timeout", messages: [] });
  state = reliability.failLiveAttempt(state, { code: "TIMEOUT", retryable: true, failedRole: "reviewer" }, "timeout");
  assert.equal(state.mode, "live");
  assert.equal(state.phase, "live_failed");
  assert.equal(state.lastFailure.replay.automaticFallbackAllowed, false);
  assert.equal(state.lastFailure.roleLine, "Failed role: reviewer");
  const replayState = reliability.openSanitizedReplay(state);
  assert.equal(replayState.mode, "replay");
});

test("stale live response protection binds request and case set", () => {
  assert.equal(reliability.shouldApplyLiveResult({ requestId: "a", activeRequestId: "a", requestedCaseSet: "case-1", activeCaseSet: "case-1" }), true);
  assert.equal(reliability.shouldApplyLiveResult({ requestId: "old", activeRequestId: "new", requestedCaseSet: "case-1", activeCaseSet: "case-1" }), false);
  assert.equal(reliability.shouldApplyLiveResult({ requestId: "a", activeRequestId: "a", requestedCaseSet: "case-1", activeCaseSet: "case-2" }), false);
});

test("progress copy is explanatory and preserves cancellation boundary", () => {
  const progress = reliability.analyzeProgress(22_000, { cancelSupported: true });
  assert.equal(progress.stage, "Waiting for the slower model — this may take up to 60 seconds");
  assert.equal(progress.processOnly, true);
  assert.equal(progress.noAutomaticRetry, true);
  assert.match(progress.blindReviewStatement, /does not receive the Analyst output/);
  assert.match(progress.cancelScope, /does not prove the server or remote model computation was cancelled/);
});

test("judge walkthrough reports state but never embeds automatic actions", () => {
  const steps = reliability.judgeWalkthroughState({ incidentCount: 5, independentScoresVisible: true, decisionRecorded: false, briefReady: false, proofChecked: false });
  assert.deepEqual(steps.map(step => step.completed), [true, true, false, false]);
  assert.doesNotMatch(JSON.stringify(steps), /auto.*submit|auto.*approve|auto.*check/i);
});

test("reset statement distinguishes browser state from ephemeral server records", () => {
  assert.equal(reliability.RESET_SCOPE_COPY, "This resets the browser view only. Restart the local server to clear ephemeral Decision and Audit records.");
});

test("shared scenario evaluator import is side-effect free", () => {
  const smokePath = path.join(projectRoot, "scripts/full-scenario-live-smoke.js");
  delete require.cache[require.resolve(smokePath)];
  const before = process._getActiveHandles().filter(handle => handle?.constructor?.name === "Server").length;
  const shared = require(smokePath);
  const after = process._getActiveHandles().filter(handle => handle?.constructor?.name === "Server").length;
  assert.equal(typeof shared.evaluateScenarioQuality, "function");
  assert.equal(typeof shared.evaluateFullScenarioAcceptance, "function");
  assert.equal(after, before);
});

test("live rehearsal import is side-effect free and exports safe diagnostics", () => {
  const rehearsalPath = path.join(projectRoot, "scripts/live-judge-rehearsal.js");
  delete require.cache[require.resolve(rehearsalPath)];
  const before = process._getActiveHandles().filter(handle => handle?.constructor?.name === "Server").length;
  const rehearsal = require(rehearsalPath);
  const after = process._getActiveHandles().filter(handle => handle?.constructor?.name === "Server").length;
  assert.equal(typeof rehearsal.createInitialRunState, "function");
  assert.equal(typeof rehearsal.updatePhaseStatus, "function");
  assert.equal(typeof rehearsal.runLiveRehearsal, "function");
  assert.equal(typeof rehearsal.sanitizeSafeFailure, "function");
  assert.equal(typeof rehearsal.formatSafeFailureSummary, "function");
  assert.equal(after, before);
});

test("live rehearsal prints only allowlisted role diagnostics", () => {
  const { sanitizeSafeFailure, formatSafeFailureSummary } = require("../scripts/live-judge-rehearsal");
  const safe = sanitizeSafeFailure({
    error: {
      code: "UPSTREAM_ERROR",
      message: "One or more model requests failed.",
      retryable: true,
      failedRole: "both",
      roleErrors: {
        analyst: "NETWORK_ERROR",
        reviewer: "TIMEOUT",
        intruder: "PRIVATE_INTERNAL_CODE"
      },
      issuePaths: ["cases.01.scores.urgency:not_numeric", "unsafe path with value"],
      stack: "STACK_MUST_NOT_LEAK",
      rawBody: "RAW_BODY_MUST_NOT_LEAK"
    }
  }, { phase: "ANALYZE", httpStatus: 502 });
  const output = formatSafeFailureSummary(safe).join("\n");

  assert.equal(safe.httpStatus, 502);
  assert.equal(safe.phase, "ANALYZE");
  assert.equal(safe.failedRole, "both");
  assert.deepEqual(safe.roleErrors, { analyst: "NETWORK_ERROR", reviewer: "TIMEOUT" });
  assert.deepEqual(safe.validationIssuePaths, ["cases.01.scores.urgency:not_numeric"]);
  assert.match(output, /Safe Error Code: UPSTREAM_ERROR/);
  assert.match(output, /Failed Role: both/);
  assert.match(output, /analyst=NETWORK_ERROR, reviewer=TIMEOUT/);
  assert.doesNotMatch(output, /intruder|PRIVATE_INTERNAL|STACK|RAW_BODY/);
});

test("live rehearsal rejects unsafe message, role, code and raw fields", () => {
  const { sanitizeSafeFailure, formatSafeFailureSummary } = require("../scripts/live-judge-rehearsal");
  const safe = sanitizeSafeFailure({
    code: "PRIVATE_CODE",
    message: "CREDENTIAL_PRIVATE_SECRET",
    failedRole: "private-role",
    roleErrors: { analyst: "PRIVATE_ERROR" },
    validationIssuePaths: ["private/value"],
    stack: "PRIVATE_STACK",
    cause: "PRIVATE_CAUSE",
    rawBody: "PRIVATE_RAW"
  }, { phase: "ANALYZE", httpStatus: 502 });
  const serialized = JSON.stringify(safe);
  const output = formatSafeFailureSummary(safe).join("\n");

  assert.equal(safe.code, "UNKNOWN_SAFE_ERROR");
  assert.equal(safe.failedRole, "not_applicable");
  assert.deepEqual(safe.roleErrors, {});
  assert.deepEqual(safe.validationIssuePaths, []);
  assert.doesNotMatch(`${serialized}\n${output}`, /CREDENTIAL_PRIVATE_SECRET|PRIVATE_STACK|PRIVATE_CAUSE|PRIVATE_RAW|private-role|PRIVATE_ERROR/);
});

test("rehearsal initial state and incomplete renderer are deterministic", () => {
  const rehearsal = require("../scripts/live-judge-rehearsal");
  const state = rehearsal.createInitialRunState({ startedAt: 123 });
  assert.equal(state.phase, "PREFLIGHT");
  assert.equal(state.port, null);
  assert.equal(state.serverHandle, null);
  assert.deepEqual(state.statuses, {
    health: "not_attempted",
    analyze: "not_attempted",
    decision: "not_attempted",
    brief: "not_attempted",
    audit: "not_attempted",
    proof: "not_attempted"
  });
  assert.doesNotThrow(() => rehearsal.renderRunSummary({}));
  assert.match(rehearsal.renderRunSummary({}).join("\n"), /Health Status: not_attempted/);
});

test("full offline rehearsal success reaches COMPLETE and cleans up", async () => {
  const harness = createRehearsalHarness();
  const result = await harness.rehearsal.runLiveRehearsal(harness.dependencies);

  assert.equal(result.success, true);
  assert.equal(result.state.phase, "COMPLETE");
  assert.deepEqual(result.state.phaseLedger, [
    "PREFLIGHT", "SERVER_START", "HEALTH", "ANALYZE", "QUALITY", "DECISION",
    "BRIEF", "AUDIT", "PROOF_VALID", "PROOF_TAMPER", "CLEANUP", "COMPLETE"
  ]);
  assert.deepEqual(result.state.statuses, {
    health: 200,
    analyze: 200,
    decision: 200,
    brief: 200,
    audit: 200,
    proof: 200
  });
  assert.equal(result.state.qualityPassed, true);
  assert.equal(result.state.summary.incidents.length, 5);
  assert.equal(result.state.summary.decisionStatus, "RECORDED");
  assert.equal(result.state.summary.executionStatus, "NOT_EXECUTED");
  assert.equal(result.state.summary.auditValid, true);
  assert.equal(result.state.summary.proofValid, true);
  assert.equal(result.state.summary.tamperInvalid, true);
  assert.equal(result.state.requestCounts.analyzeSubmissions, 1);
  assert.equal(result.state.requestCounts.inferenceAttempts, 2);
  assert.equal(result.state.requestCounts.loopbackExternalRequests, 0);
  assert.equal(result.state.cleanup.closeSucceeded, true);
  assert.equal(result.state.cleanup.randomPortListenerRemaining, false);
  assert.equal(result.state.cleanup.fixedPortListenerRemaining, false);
});

test("offline Analyze HTTP 502 preserves reviewer role without a secondary exception", async () => {
  const harness = createRehearsalHarness({
    failurePhase: "ANALYZE",
    failureStatus: 502,
    failureBody: {
      ok: false,
      error: {
        code: "HTTP_ERROR",
        message: "One or more Gonka requests returned an unsuccessful status.",
        retryable: false,
        failedRole: "reviewer",
        rawBody: "PRIVATE_RAW_BODY_MUST_NOT_LEAK",
        stack: "PRIVATE_STACK_MUST_NOT_LEAK"
      }
    }
  });
  const result = await harness.rehearsal.runLiveRehearsal(harness.dependencies);
  const output = result.lines.join("\n");

  assert.equal(result.success, false);
  assert.equal(result.state.failedPhase, "ANALYZE");
  assert.equal(result.state.statuses.analyze, 502);
  assert.equal(result.state.safeFailure.code, "HTTP_ERROR");
  assert.equal(result.state.safeFailure.failedRole, "reviewer");
  for (const operation of ["decision", "brief", "audit", "proof"]) {
    assert.equal(result.state.statuses[operation], "not_attempted");
  }
  assert.equal(result.state.cleanup.closeSucceeded, true);
  assert.doesNotMatch(output, /ReferenceError|PRIVATE_RAW_BODY|PRIVATE_STACK/);
});

test("offline mixed role failure displays only allowlisted roleErrors", async () => {
  const harness = createRehearsalHarness({
    failurePhase: "ANALYZE",
    failureStatus: 502,
    failureBody: {
      ok: false,
      error: {
        code: "UPSTREAM_ERROR",
        message: "One or more model requests failed.",
        retryable: true,
        failedRole: "both",
        roleErrors: {
          analyst: "NETWORK_ERROR",
          reviewer: "TIMEOUT",
          intruder: "PRIVATE_ERROR"
        }
      }
    }
  });
  const result = await harness.rehearsal.runLiveRehearsal(harness.dependencies);
  const output = result.lines.join("\n");

  assert.equal(result.state.failedPhase, "ANALYZE");
  assert.deepEqual(result.state.safeFailure.roleErrors, {
    analyst: "NETWORK_ERROR",
    reviewer: "TIMEOUT"
  });
  assert.match(output, /Role Errors: analyst=NETWORK_ERROR, reviewer=TIMEOUT/);
  assert.doesNotMatch(output, /intruder|PRIVATE_ERROR/);
});

for (const failureCase of [
  { name: "Health non-200", options: { failurePhase: "HEALTH", failureStatus: 503 }, phase: "HEALTH", statusKey: "health", status: 503, code: "HTTP_ERROR" },
  { name: "Analyze network error", options: { failurePhase: "ANALYZE", networkFailure: true }, phase: "ANALYZE", statusKey: "analyze", status: "network_error", code: "NETWORK_ERROR" },
  { name: "Analyze non-JSON body", options: { failurePhase: "ANALYZE", failureStatus: 502, nonJsonFailure: true }, phase: "ANALYZE", statusKey: "analyze", status: 502, code: "INVALID_RESPONSE" },
  { name: "Quality contract", options: { qualityFailure: true }, phase: "QUALITY", statusKey: "analyze", status: 200, code: "LIVE_QUALITY_FAILURE" },
  { name: "Decision 409", options: { failurePhase: "DECISION", failureStatus: 409 }, phase: "DECISION", statusKey: "decision", status: 409, code: "HTTP_ERROR" },
  { name: "Brief 500", options: { failurePhase: "BRIEF", failureStatus: 500 }, phase: "BRIEF", statusKey: "brief", status: 500, code: "HTTP_ERROR" },
  { name: "Audit failure", options: { failurePhase: "AUDIT", failureStatus: 500 }, phase: "AUDIT", statusKey: "audit", status: 500, code: "HTTP_ERROR" },
  { name: "Proof verify failure", options: { failurePhase: "PROOF", failureStatus: 500 }, phase: "PROOF_VALID", statusKey: "proof", status: 500, code: "HTTP_ERROR" }
]) {
  test(`full offline control flow safely captures ${failureCase.name}`, async () => {
    const harness = createRehearsalHarness(failureCase.options);
    const result = await harness.rehearsal.runLiveRehearsal(harness.dependencies);
    const output = result.lines.join("\n");

    assert.equal(result.success, false);
    assert.equal(result.state.failedPhase, failureCase.phase);
    assert.equal(result.state.statuses[failureCase.statusKey], failureCase.status);
    assert.equal(result.state.safeFailure.code, failureCase.code);
    assert.equal(result.state.cleanup.closeSucceeded, true);
    assert.equal(result.state.cleanup.randomPortListenerRemaining, false);
    assert.equal(result.state.cleanup.fixedPortListenerRemaining, false);
    assert.equal(result.state.requestCounts.loopbackExternalRequests, 0);
    assert.doesNotMatch(output, /PRIVATE_.*(?:STACK|BODY)|ReferenceError|Authorization|Bearer/);
  });
}

test("cleanup failure becomes local error without masking completed work", async () => {
  const harness = createRehearsalHarness({ cleanupFailure: true });
  const result = await harness.rehearsal.runLiveRehearsal(harness.dependencies);
  const output = result.lines.join("\n");

  assert.equal(result.success, false);
  assert.equal(result.state.failedPhase, "CLEANUP");
  assert.equal(result.state.safeFailure.code, "LOCAL_REHEARSAL_ERROR");
  assert.equal(result.state.cleanup.closeSucceeded, false);
  assert.equal(result.state.workCompleted, true);
  assert.doesNotMatch(output, /PRIVATE_CLEANUP|ReferenceError/);
});

test("cleanup failure never replaces an earlier safe HTTP failure", async () => {
  const harness = createRehearsalHarness({
    failurePhase: "ANALYZE",
    failureStatus: 502,
    cleanupFailure: true
  });
  const result = await harness.rehearsal.runLiveRehearsal(harness.dependencies);
  const output = result.lines.join("\n");

  assert.equal(result.success, false);
  assert.equal(result.state.failedPhase, "ANALYZE");
  assert.equal(result.state.safeFailure.code, "HTTP_ERROR");
  assert.equal(result.state.safeFailure.failedRole, "reviewer");
  assert.equal(result.state.cleanup.closeSucceeded, false);
  assert.match(output, /Failed Phase: ANALYZE/);
  assert.doesNotMatch(output, /PRIVATE_CLEANUP|ReferenceError/);
});

test("summary renderer failure returns deterministic local error after cleanup", async () => {
  const harness = createRehearsalHarness({ rendererFailure: true });
  const result = await harness.rehearsal.runLiveRehearsal(harness.dependencies);
  const output = result.lines.join("\n");

  assert.equal(result.success, false);
  assert.equal(result.state.failedPhase, "COMPLETE");
  assert.equal(result.state.safeFailure.code, "LOCAL_REHEARSAL_ERROR");
  assert.equal(result.state.cleanup.closeSucceeded, true);
  assert.doesNotMatch(output, /PRIVATE_RENDER|ReferenceError/);
});

test("unset server, port and statuses return deterministic local error", async () => {
  const harness = createRehearsalHarness({ serverStartFailure: true });
  const result = await harness.rehearsal.runLiveRehearsal(harness.dependencies);
  const output = result.lines.join("\n");

  assert.equal(result.success, false);
  assert.equal(result.state.failedPhase, "SERVER_START");
  assert.equal(result.state.port, null);
  assert.equal(result.state.serverHandle, null);
  assert.equal(result.state.statuses.health, "not_attempted");
  assert.equal(result.state.safeFailure.code, "LOCAL_REHEARSAL_ERROR");
  assert.match(output, /Health Status: not_attempted/);
  assert.doesNotMatch(output, /ReferenceError|TypeError/);
});

test("client Abort stops browser wait without claiming server cancellation", async () => {
  const clientModule = await importClient();
  const controller = new AbortController();
  const client = clientModule.createCrisisRouteClient({
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  });
  const pending = client.loadScenario(["fixed"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => {
    assert.equal(error.code, "CLIENT_WAIT_CANCELLED");
    assert.match(error.message, /cancellation is not confirmed/);
    return true;
  });
});

test("reliability UI strings are connected through escaped rendering", () => {
  const main = fs.readFileSync(path.join(projectRoot, "src/main.js"), "utf8");
  for (const marker of [
    "Judge Walkthrough", "Retry Live", "Open Sanitized Replay", "Cancel UI Wait",
    "No automatic Retry", "Existing ${escapeHtml(modeLabel(state.mode))} data remains unchanged",
    "renderModeTrustPanel()", "renderReliabilityPanel()", "renderJudgeWalkthrough()"
  ]) assert.ok(main.includes(marker), `missing connected UI marker: ${marker}`);
  assert.match(main, /failure\.headline\)}/);
  assert.match(main, /escapeHtml\(failure\.message\)/);
  assert.doesNotMatch(main, /innerHTML\s*\+=/);
});

test("Demo five-case final scores, gaps, maximum gaps and consensus match the production arithmetic", async () => {
  const demo = (await importPure("src/data/hazeScenario.mock.js")).cloneScenario();
  const expected = [
    [[91, 96, 88], [89, 94, 86], [90, 95, 87], [2, 2, 2], 2, "AGREEMENT"],
    [[42, 64, 55], [34, 58, 49], [38, 61, 52], [8, 6, 6], 8, "AGREEMENT"],
    [[43, 97, 24], [41, 97, 22], [42, 97, 23], [2, 0, 2], 2, "AGREEMENT"],
    [[70, 72, 63], [55, 77, 45], [63, 75, 54], [15, 5, 18], 18, "DISAGREEMENT"],
    [[78, 42, 81], [75, 39, 83], [77, 41, 82], [3, 3, 2], 3, "AGREEMENT"]
  ];
  const axes = scores => [scores.verification, scores.urgency, scores.actionability];
  assert.deepEqual(demo.incidents.map(item => item.label), ["01", "02", "03", "04", "05"]);
  demo.incidents.forEach((item, index) => {
    const actual = computeConsensus(item.modelReviews.analyst.scores, item.modelReviews.reviewer.scores);
    const [analyst, reviewer, final, gaps, max, consensus] = expected[index];
    assert.deepEqual(axes(item.modelReviews.analyst.scores), analyst);
    assert.deepEqual(axes(item.modelReviews.reviewer.scores), reviewer);
    assert.deepEqual(axes(item.scores), final);
    assert.deepEqual(axes(item.modelDebate.scoreGaps), gaps);
    assert.equal(item.modelDebate.maxScoreGap, max);
    assert.equal(item.modelDebate.consensus, consensus);
    assert.ok(["AGREEMENT", "DISAGREEMENT", "CRITICAL_CONFLICT"].includes(item.modelDebate.consensus));
    assert.deepEqual(item.scores, actual.scores);
    assert.deepEqual(item.modelDebate.scoreGaps, actual.gaps);
    assert.equal(item.modelDebate.maxScoreGap, actual.maxScoreGap);
    assert.equal(item.modelDebate.consensus, actual.level);
  });
});

test("consensus boundaries remain 15 inclusive, 30 inclusive and above 30 critical", () => {
  for (const [gap, expected] of [[0, "AGREEMENT"], [15, "AGREEMENT"], [16, "DISAGREEMENT"], [30, "DISAGREEMENT"], [31, "CRITICAL_CONFLICT"], [100, "CRITICAL_CONFLICT"]]) {
    const result = computeConsensus({ verification: 0, urgency: 50, actionability: 50 }, { verification: gap, urgency: 50, actionability: 50 });
    assert.equal(result.level, expected);
    assert.equal(result.maxScoreGap, gap);
  }
});

test("Demo operational states stay separate from consensus and only CASE 01 passes dispatch", async () => {
  const demo = (await importPure("src/data/hazeScenario.mock.js")).cloneScenario();
  assert.deepEqual(demo.incidents.map(item => item.operationalState), ["DISPATCH_CANDIDATE", "MERGE_OR_VERIFY", "URGENT_VERIFICATION", "NEEDS_HUMAN_REVIEW", "QUEUED_ACTION"]);
  for (const item of demo.incidents) {
    assert.notEqual(item.operationalState, item.modelDebate.consensus);
    const gate = id => item.safetyGates.find(value => value.id === id);
    const canDispatch = item.operationalState === "DISPATCH_CANDIDATE" && item.modelDebate.consensus === "AGREEMENT" &&
      ["G_LOCATION", "G_CONTACT", "G_RESOURCE"].every(id => gate(id).passed === true);
    assert.equal(gate("G_DISPATCH").status, canDispatch ? "passed" : "locked");
    assert.equal(gate("G_DISPATCH").passed, canDispatch);
    assert.equal(gate("G_CONFLICT").status, item.label === "04" ? "review" : "passed");
    if (item.label === "03") {
      for (const id of ["G_LOCATION", "G_CONTACT"]) {
        assert.equal(gate(id).status, "blocked");
        assert.equal(gate(id).passed, false);
      }
    }
  }
});

test("Replay maximum gaps are calculated from its own accepted role scores", () => {
  const result = replay.getReplayScenario();
  assert.deepEqual(result.incidents.map(item => item.modelDebate.maxScoreGap), [25, 20, 5, 20, 20]);
  for (const item of result.incidents) {
    const expected = computeConsensus(item.modelReviews.analyst.scores, item.modelReviews.reviewer.scores);
    const gaps = item.modelDebate.scoreGaps;
    assert.deepEqual(gaps, expected.gaps);
    assert.equal(item.modelDebate.maxScoreGap, Math.max(gaps.verification, gaps.urgency, gaps.actionability));
    assert.equal(item.modelDebate.maxScoreGap, expected.maxScoreGap);
  }
});

test("Replay ignores missing, added or changed Demo maxScoreGap and scoreGaps metadata", async () => {
  const source = fs.readFileSync(path.join(projectRoot, "src/data/hazeScenario.mock.js"), "utf8");
  const expected = replay.getReplayScenario();
  for (const mutation of [
    "delete item.modelDebate.maxScoreGap; delete item.modelDebate.scoreGaps;",
    "item.modelDebate.maxScoreGap = 99; item.modelDebate.scoreGaps = { verification: 99, urgency: 99, actionability: 99 };",
    "item.modelDebate.maxScoreGap = 0; item.modelDebate.scoreGaps = { verification: 0, urgency: 0, actionability: 0 };"
  ]) {
    const isolatedReplay = await importReplay(`${source}\nfor (const item of incidents) { ${mutation} }`);
    assert.deepEqual(isolatedReplay.getReplayScenario(), expected);
  }
});

test("Replay retains its entire pre-F2 payload except the authorized maximum gap addition", () => {
  const result = replay.getReplayScenario();
  for (const item of result.incidents) delete item.modelDebate.maxScoreGap;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  // Canonical SHA-256 captured from the complete sanitized Replay at baseline 1f8bee4.
  const hash = createHash("sha256").update(JSON.stringify(canonical(result))).digest("hex");
  assert.equal(hash, "2e9c738fa2425e38a2715fad925db8b560360f3a098a5bedd071bc2afc07c8ea");
});

test("mutating a Demo or Replay clone cannot contaminate later loads of either mode", async () => {
  const fixture = await importPure("src/data/hazeScenario.mock.js");
  const demoBefore = fixture.cloneScenario();
  const replayBefore = replay.getReplayScenario();
  const demoCopy = fixture.cloneScenario();
  const replayCopy = replay.getReplayScenario();
  demoCopy.incidents[0].modelDebate.maxScoreGap = 100;
  demoCopy.incidents[0].modelReviews.analyst.scores.urgency = 0;
  replayCopy.incidents[0].modelDebate.maxScoreGap = 0;
  replayCopy.incidents[0].scores.verification = 100;
  assert.deepEqual(fixture.cloneScenario(), demoBefore);
  assert.deepEqual(replay.getReplayScenario(), replayBefore);
});

test("Judge smoke stays loopback-only with fake analysis and no production Gonka factory", async () => {
  const lines = [];
  const success = await require("../scripts/judge-demo-smoke").run({ log: line => lines.push(line) });
  assert.equal(success, true);
  const output = lines.join("\n");
  for (const required of ["Five-case Fake Analyze: PASS", "Production Gonka Factory Calls: 0", "External Network Count: 0", "Inference Request Count: 0", "Execution Status: NOT_EXECUTED", "Random Port Residue: PASS"]) {
    assert.ok(output.includes(required), required);
  }
});
