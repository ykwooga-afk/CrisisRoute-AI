const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

async function importSource(relativePath, { stripImports = false } = {}) {
  let source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  if (stripImports) {
    source = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];\s*/g, "");
  }
  const encoded = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`);
}

function incident(operationalState = "DISPATCH_CANDIDATE", overrides = {}) {
  return {
    caseId: overrides.caseId || "CR-LIVE-CASE-01",
    operationalState,
    modelDebate: { consensus: overrides.consensus || "AGREEMENT" },
    safetyGates: [
      { id: "G_LOCATION", status: overrides.location === false ? "blocked" : "passed", passed: overrides.location !== false },
      { id: "G_CONTACT", status: overrides.contact === false ? "blocked" : "passed", passed: overrides.contact !== false },
      { id: "G_RESOURCE", status: overrides.resource === false ? "blocked" : "passed", passed: overrides.resource !== false },
      { id: "G_CONFLICT", status: overrides.conflict || "passed", passed: overrides.conflict !== "review" }
    ]
  };
}

function response(status, payload, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === "content-type" ? contentType : null },
    text: async () => typeof payload === "string" ? payload : JSON.stringify(payload)
  };
}

let workflow;
let clientModule;

test.before(async () => {
  workflow = await importSource("src/ui/decisionWorkflow.js");
  clientModule = await importSource("src/services/crisisRouteClient.js", { stripImports: true });
});

test("five operational states expose the exact conservative action allowlists", () => {
  const expected = {
    DISPATCH_CANDIDATE: ["APPROVE_ACTION", "REQUEST_VERIFICATION", "HOLD_FOR_REVIEW", "REJECT_ACTION"],
    URGENT_VERIFICATION: ["REQUEST_VERIFICATION", "HOLD_FOR_REVIEW", "REJECT_ACTION"],
    MERGE_OR_VERIFY: ["MERGE_REPORT", "REQUEST_VERIFICATION", "HOLD_FOR_REVIEW", "REJECT_ACTION"],
    NEEDS_HUMAN_REVIEW: ["HOLD_FOR_REVIEW", "REQUEST_VERIFICATION", "REJECT_ACTION"],
    QUEUED_ACTION: ["QUEUE_ACTION", "HOLD_FOR_REVIEW", "REJECT_ACTION"]
  };
  for (const [state, actions] of Object.entries(expected)) {
    assert.deepEqual(workflow.actionsForState(state), actions);
  }
});

test("unknown state permits only hold or reject", () => {
  assert.deepEqual(workflow.actionsForState("UNRECOGNIZED"), ["HOLD_FOR_REVIEW", "REJECT_ACTION"]);
});

test("required reason and acknowledgements block approval locally", () => {
  const case01 = incident();
  const form = workflow.createDecisionForm(case01);
  form.action = "APPROVE_ACTION";
  let result = workflow.validateDecisionForm(case01, form);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /reason/i);
  assert.match(result.errors.join(" "), /human decision/i);
  assert.match(result.errors.join(" "), /does not execute/i);

  Object.assign(form, {
    reason: "Human reviewed all bounded safety gates.",
    acknowledgeHumanDecision: true,
    acknowledgeNoAutomaticExecution: true
  });
  result = workflow.validateDecisionForm(case01, form);
  assert.equal(result.valid, true);
});

test("reject and conflict review enforce the server reason/review contract", () => {
  const conflicted = incident("NEEDS_HUMAN_REVIEW", { conflict: "review" });
  const form = workflow.createDecisionForm(conflicted);
  form.action = "REJECT_ACTION";
  form.reason = "too short";
  let result = workflow.validateDecisionForm(conflicted, form);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /model disagreement/i);
  form.reason = "Human rejected after reviewing the unresolved conflict.";
  form.acknowledgeReview = true;
  result = workflow.validateDecisionForm(conflicted, form);
  assert.equal(result.valid, true);
});

test("approval precheck blocks failed gates and critical conflict", () => {
  const blocked = incident("DISPATCH_CANDIDATE", { location: false, consensus: "CRITICAL_CONFLICT" });
  const form = workflow.createDecisionForm(blocked);
  Object.assign(form, {
    action: "APPROVE_ACTION",
    reason: "Human attempted a bounded approval.",
    acknowledgeHumanDecision: true,
    acknowledgeNoAutomaticExecution: true
  });
  const result = workflow.validateDecisionForm(blocked, form);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /Location gate/);
  assert.match(result.errors.join(" "), /Critical model conflict/);
});

test("submission fingerprint is stable across object key order", () => {
  const a = workflow.submissionFingerprint("CASE-1", { action: "HOLD_FOR_REVIEW", reason: "wait" });
  const b = workflow.submissionFingerprint("CASE-1", { reason: "wait", action: "HOLD_FOR_REVIEW" });
  assert.equal(a, b);
});

test("same submission reuses its key while a form change gets a new identity", () => {
  const values = ["key-one", "key-two"];
  const keyFactory = () => values.shift();
  const normalized = { action: "HOLD_FOR_REVIEW", reason: "", acknowledgeHumanDecision: false, acknowledgeNoAutomaticExecution: false, acknowledgeReview: false };
  const first = workflow.resolveSubmissionIdentity({ caseId: "CASE-1", normalizedSubmission: normalized, keyFactory });
  const same = workflow.resolveSubmissionIdentity({ caseId: "CASE-1", normalizedSubmission: { ...normalized }, previous: first, keyFactory });
  const changed = workflow.resolveSubmissionIdentity({ caseId: "CASE-1", normalizedSubmission: { ...normalized, reason: "changed" }, previous: same, keyFactory });
  assert.equal(same.idempotencyKey, "key-one");
  assert.equal(changed.idempotencyKey, "key-two");
});

test("loading rejects duplicate submission and stale case success cannot overwrite state", () => {
  const case01 = incident();
  let state = workflow.createWorkflowState(case01, "live");
  state.form.action = "HOLD_FOR_REVIEW";
  state = workflow.beginDecisionSubmission(state, case01, { keyFactory: () => "one" });
  assert.equal(state.phase, "decision_loading");
  const duplicate = workflow.beginDecisionSubmission(state, case01, { keyFactory: () => "two" });
  assert.equal(duplicate.phase, "decision_loading");
  assert.match(duplicate.error, /already in progress/i);
  const stale = workflow.applyDecisionSuccess(state, { decision: { caseId: case01.caseId } }, "CASE-2");
  assert.equal(stale.decision, null);
});

test("decision success plus brief failure is partial success and retry preserves decision", () => {
  const case01 = incident();
  let state = workflow.createWorkflowState(case01, "live");
  state.form.action = "HOLD_FOR_REVIEW";
  state = workflow.beginDecisionSubmission(state, case01, { keyFactory: () => "partial-key" });
  state = workflow.applyDecisionSuccess(state, { decision: { caseId: case01.caseId, action: "HOLD_FOR_REVIEW" } }, case01.caseId);
  const decision = state.decision;
  state = workflow.applyBriefFailure(state, new Error("Brief unavailable."), case01.caseId);
  assert.equal(state.decisionStatus, "RECORDED");
  assert.equal(state.briefStatus, "UNAVAILABLE");
  assert.equal(state.canRetryBrief, true);
  state = workflow.beginBriefRetry(state);
  assert.strictEqual(state.decision, decision);
  assert.equal(state.briefStatus, "GENERATING");
});

test("mock and replay workflows cannot become valid proof", () => {
  for (const mode of ["mock", "replay"]) {
    let state = workflow.createWorkflowState(incident(), mode);
    state = { ...state, brief: { briefId: "demo" }, proofCapsule: { capsuleId: "demo" } };
    state = workflow.applyProofVerification(state, { valid: true });
    assert.equal(state.proofStatus, "UNAVAILABLE");
    assert.equal(workflow.displayRules(state).proofVerificationEnabled, false);
  }
});

test("live readiness requires all five server capabilities", () => {
  const ready = { ok: true, liveRoutesReady: true, capabilities: { fullScenario: true, decision: true, brief: true } };
  assert.deepEqual(workflow.liveReadiness(ready), { ready: true, missing: [] });
  const missing = workflow.liveReadiness({ ...ready, capabilities: { ...ready.capabilities, brief: false } });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missing, ["brief"]);
});

test("client sends an explicit decision contract with idempotency and no authorization", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(200, { ok: true, decision: { caseId: "CASE/1" } });
  };
  const client = clientModule.createCrisisRouteClient({ fetchImpl, baseUrl: "http://127.0.0.1:9000" });
  await client.recordHumanDecision({
    caseId: "CASE/1",
    idempotencyKey: "same-ui-submission",
    submission: {
      action: "APPROVE_ACTION",
      reason: "Human provided this reason.",
      acknowledgeHumanDecision: true,
      acknowledgeNoAutomaticExecution: true,
      acknowledgeReview: false
    }
  });
  assert.equal(calls[0].url, "http://127.0.0.1:9000/api/incidents/CASE%2F1/decision");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "same-ui-submission");
  assert.equal("Authorization" in calls[0].options.headers, false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    action: "APPROVE_ACTION",
    reason: "Human provided this reason.",
    acknowledgeHumanDecision: true,
    acknowledgeNoAutomaticExecution: true,
    acknowledgeReview: false
  });
});

test("client uses GET for audit and POST for brief and proof verification", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(200, { ok: true });
  };
  const client = clientModule.createCrisisRouteClient({ fetchImpl, baseUrl: "http://localhost:9999" });
  await client.getCaseAudit("CASE-1");
  await client.generateDeterministicBrief("CASE-1");
  await client.verifyProofCapsule({ brief: { id: 1 }, proofCapsule: { id: 2 } });
  assert.deepEqual(calls.map(call => [new URL(call.url).pathname, call.options.method]), [
    ["/api/incidents/CASE-1/audit", "GET"],
    ["/api/incidents/CASE-1/brief", "POST"],
    ["/api/proof/verify", "POST"]
  ]);
});

test("client sends Public URL analysis through the centralized adapter", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(200, { ok: true, incidents: [] });
  };
  const client = clientModule.createCrisisRouteClient({ fetchImpl, baseUrl: "http://127.0.0.1:4173" });
  await client.analyzePublicUrl("https://example.org/haze-report");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:4173/api/public-source/analyze");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { url: "https://example.org/haze-report" });
});

test("Command Center starts empty and Live custom input is not replaced by the fixed scenario", () => {
  const main = fs.readFileSync(path.join(projectRoot, "src/main.js"), "utf8");
  assert.match(main, /intakeValue:\s*""/);
  assert.match(main, /urlValue:\s*""/);
  assert.match(main, /selectedCaseId:\s*null/);
  assert.doesNotMatch(main, /state\.intakeValue\s*=\s*\[/);
  assert.match(main, /Paste a crisis report or load demo cases to begin analysis\./);
  assert.match(main, /currentIntakeRequest\(\)/);
  assert.match(main, /await runLiveAnalyze\(requestSpec\)/);
  assert.doesNotMatch(main, /await runLiveAnalyze\(\{\s*kind:\s*"fixed",\s*messages:\s*\[\]\s*\}\);\s*return;\s*\}\s*state\.error = null;\s*await withLoading/);
});

test("decision failure prevents the orchestration from requesting a brief", async () => {
  const calls = [];
  const client = clientModule.createCrisisRouteClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(409, { error: { code: "ACTION_NOT_ALLOWED", message: "The selected action is not allowed.", retryable: false } });
    }
  });
  await assert.rejects(
    async () => {
      await client.recordHumanDecision({ caseId: "CASE-3", idempotencyKey: "k", submission: { action: "APPROVE_ACTION" } });
      await client.generateDeterministicBrief("CASE-3");
    },
    error => error.status === 409 && error.code === "ACTION_NOT_ALLOWED"
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /decision$/);
});

test("decision success allows the caller to request brief explicitly", async () => {
  const calls = [];
  const client = clientModule.createCrisisRouteClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, url.endsWith("/decision") ? { decision: { caseId: "CASE-1" } } : { brief: { caseId: "CASE-1" } });
    }
  });
  await client.recordHumanDecision({ caseId: "CASE-1", idempotencyKey: "k", submission: { action: "HOLD_FOR_REVIEW" } });
  await client.generateDeterministicBrief("CASE-1");
  assert.deepEqual(calls.map(call => call.url.split("/").pop()), ["decision", "brief"]);
});

test("client maps only safe error fields and rejects malformed responses", async () => {
  const client = clientModule.createCrisisRouteClient({
    fetchImpl: async () => response(504, {
      error: {
        code: "TIMEOUT",
        message: "Safe timeout.",
        retryable: true,
        failedRole: "analyst",
        roleErrors: { analyst: "TIMEOUT" },
        stack: "SECRET_STACK",
        rawContent: "RAW_SECRET"
      }
    })
  });
  await assert.rejects(client.getHealth(), error => {
    assert.equal(error.status, 504);
    assert.equal(error.code, "TIMEOUT");
    assert.equal(error.failedRole, "analyst");
    assert.equal(error.stack.includes("SECRET_STACK"), false);
    assert.equal("rawContent" in error, false);
    return true;
  });

  const malformed = clientModule.createCrisisRouteClient({ fetchImpl: async () => response(200, "<html>private details</html>", "text/html") });
  await assert.rejects(malformed.getHealth(), error => {
    assert.equal(error.code, "INVALID_RESPONSE");
    assert.doesNotMatch(error.message, /private details/);
    return true;
  });
});

test("UI source connects explicit human fields, all actions, proof controls and honest limitations", () => {
  const main = fs.readFileSync(path.join(projectRoot, "src/main.js"), "utf8");
  for (const required of [
    'id="human-reason"', "data-acknowledgement", "RECORDED — NOT EXECUTED",
    "Local payload integrity only", "Ephemeral — resets when the local server restarts",
    "No blockchain or external anchoring", "Verify Local Proof", "Export Receipt JSON",
    "DEMO ONLY", "UNAVAILABLE — not a server-issued live capsule",
    "APPROVE_ACTION", "REQUEST_VERIFICATION", "MERGE_REPORT", "HOLD_FOR_REVIEW", "QUEUE_ACTION", "REJECT_ACTION"
  ]) assert.ok(main.includes(required), `missing connected UI contract: ${required}`);
  assert.match(main, /import\s+\{[\s\S]*liveReadiness[\s\S]*\}\s+from\s+"\.\/ui\/decisionWorkflow\.js"/);
  assert.doesNotMatch(main, /acknowledgeHumanDecision:\s*true[\s\S]*acknowledgeNoAutomaticExecution:\s*true/);
});

function dispatchIncident(status = "passed", overrides = {}) {
  const value = incident(overrides.state || "DISPATCH_CANDIDATE", overrides);
  value.safetyGates.push({ id: "G_DISPATCH", status, passed: status === "passed" });
  return value;
}

async function replayFixture() {
  const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const hazeUrl = asModule(fs.readFileSync(path.join(projectRoot, "src/data/hazeScenario.mock.js"), "utf8"));
  const source = fs.readFileSync(path.join(projectRoot, "src/data/replayResponses.js"), "utf8")
    .replace(/import\s+\{\s*cloneScenario\s*,\s*rawReports\s*\}\s+from\s+["'][^"']+["'];/,
      `const { cloneScenario, rawReports } = await import(${JSON.stringify(hazeUrl)});`);
  return (await import(asModule(source))).getReplayScenario();
}

// Execute the actual renderers, without app initialization, DOM mutations or a server.
async function renderers() {
  const source = fs.readFileSync(path.join(projectRoot, "src/main.js"), "utf8")
    .replace(/import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];\s*/g, "")
    .replace(/\binit\(\);\s*$/, "");
  const reliability = await importSource("src/ui/demoReliability.js");
  return vm.runInNewContext(`${source}\n({ state, setDecisionWorkflow, renderCommandReadinessPanel, renderSafetyView, renderActionBriefView, renderDecisionPath, renderDispatchLockPanel, renderSafetyAssessment, renderHumanDecisionButtons, renderAuditTimeline, auditEvents });`, {
    ...workflow,
    ...reliability,
    DATA_MODES: { mock: "mock", replay: "replay", live: "live" },
    document: { querySelector: () => ({}) },
    fetch: () => { throw new Error("Rendering must not access the network."); }
  });
}

test("Command Center result summarizes Decision Readiness before Human Decision", async () => {
  const demo = (await importSource("src/data/hazeScenario.mock.js")).cloneScenario();
  const ui = await renderers();
  const case01 = demo.incidents.find(item => item.label === "01");
  const case03 = demo.incidents.find(item => item.label === "03");
  const case04 = demo.incidents.find(item => item.label === "04");

  const case01Html = ui.renderCommandReadinessPanel(case01);
  assert.match(case01Html, /Decision Readiness/);
  assert.match(case01Html, /DISPATCH CANDIDATE/);
  assert.match(case01Html, /3 \/ 4 checks ready/);
  assert.match(case01Html, /Review Case Intelligence →/);
  assert.doesNotMatch(case01Html, /Open Human Decision/);
  assert.doesNotMatch(case01Html, /<h2>Safety Gates<\/h2>/);
  assert.doesNotMatch(case01Html, /Volunteer Dispatch/);

  const case03Html = ui.renderCommandReadinessPanel(case03);
  assert.match(case03Html, /URGENT VERIFICATION/);
  assert.match(case03Html, /Exact location and verified contact missing/);
  assert.match(case03Html, /Review Case Intelligence →/);

  const case04Html = ui.renderCommandReadinessPanel(case04);
  assert.match(case04Html, /NEEDS HUMAN REVIEW/);
  assert.match(case04Html, /Model disagreement requires review/);
  assert.match(case04Html, /Review Case Intelligence →/);
});

test("Safety page keeps Evidence back-navigation and adaptive human actions", async () => {
  const demo = (await importSource("src/data/hazeScenario.mock.js")).cloneScenario();
  const ui = await renderers();
  const case03 = demo.incidents.find(item => item.label === "03");
  const case01 = demo.incidents.find(item => item.label === "01");

  const safetyHtml = ui.renderSafetyView(case03);
  assert.match(safetyHtml, /← Back to Evidence/);
  assert.match(safetyHtml, /data-view="evidence"/);
  assert.match(safetyHtml, /Safety Summary/);
  assert.match(safetyHtml, /URGENT/);
  assert.match(safetyHtml, /≠/);
  assert.match(safetyHtml, /DISPATCHABLE/);
  assert.match(safetyHtml, /Human Decision/);
  assert.match(safetyHtml, /DISPATCH LOCKED/);
  assert.doesNotMatch(ui.renderHumanDecisionButtons(case03), /APPROVE_ACTION/);
  assert.match(ui.renderHumanDecisionButtons(case03), /REQUEST_VERIFICATION/);
  assert.match(ui.renderHumanDecisionButtons(case01), /APPROVE_ACTION/);
});

test("Action Brief renders recorded decision handoff with compact proof and audit hierarchy", async () => {
  const demo = (await importSource("src/data/hazeScenario.mock.js")).cloneScenario();
  const ui = await renderers();
  const case03 = demo.incidents.find(item => item.label === "03");
  const decision = {
    caseId: case03.caseId,
    action: "REQUEST_VERIFICATION",
    reason: "",
    recordedAt: "2026-09-04T13:48:00.000Z",
    recordStatus: "RECORDED",
    executionStatus: "NOT_EXECUTED"
  };
  const brief = {
    caseId: case03.caseId,
    decisionAction: decision.action,
    priority: "CRITICAL",
    summary: "Urgent verification was requested. Low verification does not reduce medical urgency.",
    nextSteps: [...case03.safeNextActions],
    safetyConstraints: ["No real-world action is executed by this demo."],
    recordStatus: "RECORDED",
    executionStatus: "NOT_EXECUTED"
  };
  ui.state.mode = "mock";
  ui.setDecisionWorkflow(case03.caseId, {
    ...workflow.createWorkflowState(case03, "mock"),
    decision,
    brief,
    proofCapsule: null,
    audit: {
      demoOnly: true,
      entryCount: 1,
      entries: [{ sequence: 1, action: decision.action, recordedAt: decision.recordedAt, previousHash: null, entryHash: "DEMO_ONLY_NOT_SERVER_ISSUED" }],
      chainValid: null,
      persistence: "demo_only",
      externalAnchoring: "none"
    },
    decisionStatus: "RECORDED",
    briefStatus: "READY",
    auditStatus: "VALID",
    proofStatus: "UNAVAILABLE"
  });

  const html = ui.renderActionBriefView(case03);
  assert.match(html, /← Back to Safety/);
  assert.match(html, /data-view="safety"/);
  assert.match(html, /<h1>Action Brief<\/h1>/);
  assert.doesNotMatch(html, /Deterministic Operational Brief/);
  assert.match(html, /Decision Recorded/);
  assert.match(html, /Request Urgent Verification/);
  assert.match(html, /CRITICAL/);
  assert.match(html, /NOT EXECUTED/);
  assert.match(html, /What Happens Next/);
  assert.match(html, /Contact reporter immediately via WhatsApp/);
  assert.match(html, /class="execution-note"/);
  assert.match(html, /Proof Capsule/);
  assert.match(html, /DEMO ONLY/);
  assert.match(html, /Audit Trail/);
  assert.match(html, /View Audit Details →/);
  assert.match(html, /Demo Provenance/);
});

test("dispatch passed presentation requires explicit human approval and zero blocked/review counts", () => {
  const result = workflow.dispatchPresentation(dispatchIncident());
  assert.equal(result.status, "passed");
  assert.equal(result.label, "DISPATCH AVAILABLE");
  assert.equal(result.requirement, "after explicit human approval");
  assert.match(result.detail, /Nothing has been dispatched/);
  assert.equal(result.blockedCount, 0);
  assert.equal(result.reviewCount, 0);
  assert.equal(result.prerequisiteCount, 4);
});

test("dispatch review presentation separates blocked and review prerequisites without claiming availability", () => {
  const result = workflow.dispatchPresentation(dispatchIncident("review", { consensus: "DISAGREEMENT", conflict: "review" }));
  assert.equal(result.status, "review");
  assert.equal(result.label, "DISPATCH REVIEW REQUIRED");
  assert.equal(result.panelTitle, "Volunteer Dispatch — Human Review Required");
  assert.match(result.detail, /Model disagreement.*human review and acknowledgement/);
  assert.match(result.detail, /Nothing has been dispatched/);
  assert.doesNotMatch(JSON.stringify(result), /Available|required gates blocked/i);
  assert.equal(result.blockedCount, 0);
  assert.equal(result.reviewCount, 1);
  assert.equal(result.countText, "0 prerequisite gates blocked; 1 prerequisite gate requires review.");
});

test("dispatch locked presentation counts failed prerequisites and never offers availability", () => {
  const result = workflow.dispatchPresentation(dispatchIncident("locked", { location: false, contact: false }));
  assert.equal(result.status, "locked");
  assert.equal(result.label, "DISPATCH LOCKED");
  assert.match(result.detail, /Required gates or dispatch eligibility have not been confirmed/);
  assert.match(result.detail, /location, contact, resources/);
  assert.equal(result.blockedCount, 2);
  assert.equal(result.reviewCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /Available/i);
});

test("missing, unknown and illegal dispatch statuses remain locked even when other gates pass", () => {
  for (const value of [null, {}, { safetyGates: null }, incident(), ...[undefined, null, "", "PASSED", "available", true, {}, "<script>"].map(status => {
    const value = dispatchIncident();
    value.safetyGates.find(gate => gate.id === "G_DISPATCH").status = status;
    return value;
  })]) {
    const result = workflow.dispatchPresentation(value);
    assert.equal(result.status, "locked");
    assert.doesNotMatch(JSON.stringify(result), /Available|<script>/i);
  }
});

test("only an agreement dispatch candidate with required gates passed can display available", () => {
  for (const overrides of [{ location: false }, { contact: false }, { resource: false },
    { state: "URGENT_VERIFICATION" }, { consensus: "CRITICAL_CONFLICT" }, { consensus: "UNKNOWN" }]) {
    assert.equal(workflow.dispatchPresentation(dispatchIncident("passed", overrides)).status, "locked");
  }
  assert.equal(workflow.dispatchPresentation(dispatchIncident("passed", { consensus: "DISAGREEMENT" })).status, "review");
  assert.equal(workflow.dispatchPresentation(dispatchIncident("passed", { conflict: "review" })).status, "review");
  const missing = dispatchIncident();
  missing.safetyGates = missing.safetyGates.filter(gate => gate.id !== "G_LOCATION");
  assert.equal(workflow.dispatchPresentation(missing).status, "locked");
  assert.equal(workflow.dispatchPresentation(dispatchIncident("review", { location: false })).status, "locked");
});

test("prerequisite counts exclude dispatch and use correct singular/plural grammar", () => {
  const value = dispatchIncident("locked", { location: false, conflict: "review" });
  value.safetyGates.push({ id: "G_EXTRA", status: "review" });
  const result = workflow.dispatchPresentation(value);
  assert.equal(result.blockedCount, 1);
  assert.equal(result.reviewCount, 2);
  assert.equal(result.countText, "1 prerequisite gate blocked; 2 prerequisite gates require review.");
});

test("Replay CASE 01 renders consistent review semantics on all five dispatch surfaces", async () => {
  const replay = await replayFixture();
  const original = JSON.stringify(replay);
  const case01 = replay.incidents.find(item => item.label === "01");
  const ui = await renderers();
  for (const render of [ui.renderDecisionPath, ui.renderDispatchLockPanel, ui.renderSafetyAssessment]) {
    const html = render(case01);
    assert.match(html, /review required/i);
    assert.match(html, /Nothing has been dispatched/);
    assert.doesNotMatch(html, /dispatch[^<]*locked|dispatch[^<]*available|required gates blocked/i);
  }
  const pathHtml = ui.renderDecisionPath(case01);
  assert.match(pathHtml, /0 prerequisite gates blocked; 1 prerequisite gate requires review/);
  const formHtml = ui.renderHumanDecisionButtons(case01);
  const note = formHtml.match(/<p class="dispatch-status-note[^>]*>[\s\S]*?<\/p>/)[0];
  assert.match(note, /DISPATCH REVIEW REQUIRED/);
  assert.doesNotMatch(note, /locked|available/i);
  assert.match(formHtml, /data-acknowledgement="acknowledgeReview"[^>]*\/>\s*<span>[^<]*<small>Required<\/small>/);
  assert.doesNotMatch(formHtml, /\schecked(?:\s|>)/);
  const form = { ...workflow.createDecisionForm(case01), reason: "Offline test of explicit review acknowledgement.",
    acknowledgeHumanDecision: true, acknowledgeNoAutomaticExecution: true };
  assert.equal(workflow.validateDecisionForm(case01, form).valid, false);
  assert.equal(workflow.validateDecisionForm(case01, { ...form, acknowledgeReview: true }).valid, true);
  const events = ui.auditEvents(case01);
  assert.equal(events.find(item => item.label === "Safety").detail, "Human review required");
  assert.equal(events.find(item => item.label === "Action").detail, "Pending");
  assert.match(ui.renderAuditTimeline(case01), /Human review required/);
  assert.deepEqual(case01.scores, { verification: 53, urgency: 80, actionability: 83 });
  assert.equal(case01.modelDebate.consensus, "DISAGREEMENT");
  assert.equal(case01.operationalState, "DISPATCH_CANDIDATE");
  assert.equal(JSON.stringify(replay), original, "rendering must not mutate any of the five replay incidents");
});

test("Replay CASE 03 remains locked across surfaces with blocked Location/Contact and unchanged scores", async () => {
  const case03 = (await replayFixture()).incidents.find(item => item.label === "03");
  const ui = await renderers();
  const result = workflow.dispatchPresentation(case03);
  assert.equal(result.status, "locked");
  assert.equal(result.blockedCount, case03.safetyGates.filter(gate => gate.id !== "G_DISPATCH" && ["blocked", "locked"].includes(gate.status)).length);
  for (const id of ["G_LOCATION", "G_CONTACT"]) assert.equal(case03.safetyGates.find(gate => gate.id === id).status, "blocked");
  for (const render of [ui.renderDecisionPath, ui.renderDispatchLockPanel, ui.renderSafetyAssessment]) {
    const html = render(case03);
    assert.match(html, /dispatch[^<]*locked/i);
    assert.doesNotMatch(html, /dispatch[^<]*available/i);
  }
  assert.match(ui.renderHumanDecisionButtons(case03), /DISPATCH LOCKED/);
  assert.match(ui.auditEvents(case03).find(item => item.label === "Safety").detail, /Dispatch locked/);
  assert.deepEqual(case03.scores, { verification: 20, urgency: 78, actionability: 15 });
});

test("passed candidate actual UI output consistently says available only after explicit approval", async () => {
  const case01 = (await replayFixture()).incidents.find(item => item.label === "01");
  case01.modelDebate.consensus = "AGREEMENT";
  for (const gate of case01.safetyGates.filter(item => ["G_CONFLICT", "G_DISPATCH"].includes(item.id))) {
    gate.status = "passed";
    gate.passed = true;
  }
  const ui = await renderers();
  for (const render of [ui.renderDecisionPath, ui.renderDispatchLockPanel, ui.renderSafetyAssessment, ui.renderHumanDecisionButtons]) {
    const html = render(case01);
    assert.match(html, /DISPATCH AVAILABLE|Volunteer Dispatch — Available/);
    assert.match(html, /after explicit human approval/);
    assert.match(html, /Nothing has been dispatched/);
  }
  assert.equal(ui.auditEvents(case01).find(item => item.label === "Action").detail, "Pending");
});

test("missing dispatch gate renders locked in every detailed dispatch surface", async () => {
  const case01 = (await replayFixture()).incidents.find(item => item.label === "01");
  case01.safetyGates = case01.safetyGates.filter(gate => gate.id !== "G_DISPATCH");
  const ui = await renderers();
  for (const render of [ui.renderDecisionPath, ui.renderDispatchLockPanel, ui.renderSafetyAssessment, ui.renderHumanDecisionButtons]) {
    const html = render(case01);
    assert.match(html, /dispatch[^<]*locked/i);
    assert.doesNotMatch(html, /dispatch[^<]*available/i);
  }
});

test("Audit distinguishes pending from a recorded human decision without claiming execution", async () => {
  const case01 = (await replayFixture()).incidents.find(item => item.label === "01");
  const ui = await renderers();
  assert.equal(ui.auditEvents(case01).find(item => item.label === "Action").detail, "Pending");
  case01.humanDecision = { decision: "APPROVE_ACTION" };
  assert.equal(ui.auditEvents(case01).find(item => item.label === "Action").detail, "Recorded — not executed");
  assert.equal(ui.auditEvents(case01).find(item => item.label === "Safety").detail, "Human review required");
});

test("actual Demo CASE 01 renders agreement and available after explicit human approval", async () => {
  const case01 = (await importSource("src/data/hazeScenario.mock.js")).cloneScenario().incidents[0];
  const ui = await renderers();
  for (const render of [ui.renderDecisionPath, ui.renderDispatchLockPanel, ui.renderSafetyAssessment, ui.renderHumanDecisionButtons]) {
    const html = render(case01);
    assert.match(html, /DISPATCH AVAILABLE|Volunteer Dispatch — Available/);
    assert.match(html, /after explicit human approval/);
    assert.match(html, /Nothing has been dispatched/);
    assert.doesNotMatch(html, /DISPATCH LOCKED|DISPATCH REVIEW REQUIRED/);
  }
  const form = ui.renderHumanDecisionButtons(case01);
  assert.match(form, /State <strong>DISPATCH_CANDIDATE<\/strong>/);
  assert.match(form, /Consensus <strong>AGREEMENT<\/strong>/);
  assert.doesNotMatch(form, /\schecked(?:\s|>)/);
  assert.equal(ui.auditEvents(case01).find(item => item.label === "Action").detail, "Pending");
});

test("actual Demo non-dispatch states never offer volunteer dispatch and CASE 04 requires conflict review", async () => {
  const demo = (await importSource("src/data/hazeScenario.mock.js")).cloneScenario();
  const ui = await renderers();
  for (const item of demo.incidents.slice(1)) {
    for (const render of [ui.renderDecisionPath, ui.renderDispatchLockPanel, ui.renderSafetyAssessment, ui.renderHumanDecisionButtons]) {
      const html = render(item);
      assert.match(html, /dispatch[^<]*locked/i);
      assert.doesNotMatch(html, /dispatch[^<]*available/i);
    }
    const form = ui.renderHumanDecisionButtons(item);
    assert.ok(form.includes(`State <strong>${item.operationalState}</strong>`));
    assert.ok(form.includes(`Consensus <strong>${item.modelDebate.consensus}</strong>`));
  }
  const case04 = demo.incidents.find(item => item.label === "04");
  assert.equal(workflow.acknowledgementRequirements(case04, "HOLD_FOR_REVIEW").acknowledgeReview, true);
  const form = ui.renderHumanDecisionButtons(case04);
  assert.match(form, /data-acknowledgement="acknowledgeReview"[^>]*\/>\s*<span>[^<]*<small>Required<\/small>/);
  assert.match(form, /CONFLICT: <strong>review<\/strong>/);
  assert.equal(workflow.validateDecisionForm(case04, { ...workflow.createDecisionForm(case04), reason: "Offline human review test." }).valid, false);
});
