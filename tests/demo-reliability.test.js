const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`;
}

async function importPure(relativePath) {
  return import(dataModule(fs.readFileSync(path.join(projectRoot, relativePath), "utf8")));
}

async function importReplay() {
  const hazeUrl = dataModule(fs.readFileSync(path.join(projectRoot, "src/data/hazeScenario.mock.js"), "utf8"));
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
