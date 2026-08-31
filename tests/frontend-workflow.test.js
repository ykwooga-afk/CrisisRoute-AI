const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
