const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DecisionLedgerError,
  canonicalJson,
  createDecisionLedger,
  normalizeAction,
  verifyAuditChain
} = require("../backend/decisionLedger");

function incident({
  caseId = "CR-LIVE-CASE-01",
  operationalState = "DISPATCH_CANDIDATE",
  consensus = "AGREEMENT",
  conflictStatus = "passed",
  gateOverrides = {}
} = {}) {
  const gates = [
    ["G_LOCATION", true],
    ["G_CONTACT", true],
    ["G_RESOURCE", true],
    ["G_CONFLICT", conflictStatus === "passed"],
    ["G_DISPATCH", operationalState === "DISPATCH_CANDIDATE"]
  ].map(([id, passed]) => ({
    id,
    passed: Object.hasOwn(gateOverrides, id) ? gateOverrides[id] : passed,
    status: id === "G_CONFLICT" ? conflictStatus : passed ? "passed" : "blocked",
    detail: `PRIVATE_DETAIL_${id}`
  }));
  return {
    caseId,
    label: "01",
    operationalState,
    scores: { verification: 81, urgency: 93, actionability: 78 },
    modelDebate: {
      consensus,
      scoreGaps: { verification: 2, urgency: 4, actionability: 6 },
      counterEvidence: ["RAW_COUNTER_EVIDENCE"]
    },
    safetyGates: gates,
    qualityWarnings: ["SAFE_WARNING"],
    receivedAt: "2026-08-31T08:00:00.000Z",
    rawMessage: "RAW_MODEL_CONTENT_MUST_NOT_BE_STORED",
    prompt: "PROMPT_MUST_NOT_BE_STORED",
    authorization: "Bearer sk-SECRET-MUST-NOT-BE-STORED",
    gonka: {
      analyst: { model: "safe-analyst", responseId: "safe-response-a", rawContent: "RAW_A" },
      reviewer: { model: "safe-reviewer", responseId: "safe-response-r", prompt: "PROMPT_R" }
    }
  };
}

function ledgerWith(input = incident()) {
  let nextId = 1;
  const ledger = createDecisionLedger({
    clock: () => new Date(`2026-08-31T08:00:0${nextId}.000Z`),
    idGenerator: () => `DECISION-${nextId++}`
  });
  ledger.registerAnalysisResult({ incidents: [input] });
  return ledger;
}

function approvePayload(overrides = {}) {
  return {
    action: "APPROVE_ACTION",
    reason: "Human approved this bounded proposal.",
    acknowledgeHumanDecision: true,
    acknowledgeNoAutomaticExecution: true,
    ...overrides
  };
}

function assertCode(fn, code) {
  assert.throws(fn, error => error instanceof DecisionLedgerError && error.code === code);
}

test("analysis registration keeps only the safe decision snapshot", () => {
  const ledger = ledgerWith();
  const context = ledger.getContext("CR-LIVE-CASE-01");
  const serialized = JSON.stringify(context);
  assert.equal(ledger.getContextCount(), 1);
  assert.match(context.analysisSnapshotHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(context.snapshot.analysisReference, {
    analyst: { model: "safe-analyst", responseId: "safe-response-a" },
    reviewer: { model: "safe-reviewer", responseId: "safe-response-r" }
  });
  assert.doesNotMatch(serialized, /RAW_MODEL|PROMPT|Authorization|sk-SECRET|PRIVATE_DETAIL|RAW_A|PROMPT_R/);
});

test("unknown context and invalid case IDs are rejected", () => {
  const ledger = ledgerWith();
  assertCode(() => ledger.getAudit("CR-LIVE-CASE-02"), "ANALYSIS_CONTEXT_NOT_FOUND");
  for (const caseId of ["../CR-LIVE-CASE-01", "CR-LIVE-CASE-01/extra", "CR-LIVE-CASE-01\0", "too-long"]) {
    assertCode(() => ledger.getAudit(caseId), "INVALID_CASE_ID");
  }
});

test("canonical actions use explicit trim and case-insensitive aliases", () => {
  assert.equal(normalizeAction("  ApPrOvE  "), "APPROVE_ACTION");
  assert.equal(normalizeAction("URGENT_VERIFICATION"), "REQUEST_VERIFICATION");
  assert.equal(normalizeAction("needs_more_info"), "REQUEST_VERIFICATION");
  assert.equal(normalizeAction("merge_or_reject"), "MERGE_REPORT");
  assertCode(() => normalizeAction("approve-ish"), "UNKNOWN_DECISION_ACTION");
});

test("reason is trimmed and unsafe reason values are rejected", () => {
  const ledger = ledgerWith();
  const result = ledger.recordDecision({
    caseId: "CR-LIVE-CASE-01",
    payload: approvePayload({ reason: "  Human approved this bounded proposal.  " })
  });
  assert.equal(result.decision.reason, "Human approved this bounded proposal.");

  const noteLedger = ledgerWith();
  const fromNote = noteLedger.recordDecision({
    caseId: "CR-LIVE-CASE-01",
    payload: approvePayload({ reason: undefined, note: "  Human note supplied for this approval.  " })
  });
  assert.equal(fromNote.decision.reason, "Human note supplied for this approval.");

  for (const reason of ["short", `valid\0reason`, "x".repeat(501), 123]) {
    const separate = ledgerWith();
    assertCode(() => separate.recordDecision({
      caseId: "CR-LIVE-CASE-01",
      payload: approvePayload({ reason })
    }), "INVALID_DECISION_REQUEST");
  }
});

test("safe dispatch approval is recorded but never executed", () => {
  const ledger = ledgerWith();
  const result = ledger.recordDecision({ caseId: "CR-LIVE-CASE-01", payload: approvePayload() });
  assert.equal(result.decision.action, "APPROVE_ACTION");
  assert.equal(result.decision.actorType, "human_operator");
  assert.equal(result.decision.authentication, "demo_local_only");
  assert.equal(result.decision.recordStatus, "RECORDED");
  assert.equal(result.decision.executionStatus, "NOT_EXECUTED");
  assert.equal(result.decision.requiresExternalExecution, true);
  assert.equal(result.decision.override, false);
});

test("dispatch approval requires reason and both human safety acknowledgements", () => {
  for (const payload of [
    approvePayload({ reason: "" }),
    approvePayload({ acknowledgeHumanDecision: false }),
    approvePayload({ acknowledgeNoAutomaticExecution: false })
  ]) {
    const ledger = ledgerWith();
    const expected = payload.reason === "" ? "INVALID_DECISION_REQUEST" : "ACKNOWLEDGEMENT_REQUIRED";
    assertCode(() => ledger.recordDecision({ caseId: "CR-LIVE-CASE-01", payload }), expected);
  }
});

test("conflict review requires a reason and explicit review acknowledgement", () => {
  const context = incident({ conflictStatus: "review" });
  const missingReview = ledgerWith(context);
  assertCode(() => missingReview.recordDecision({
    caseId: context.caseId,
    payload: approvePayload()
  }), "ACKNOWLEDGEMENT_REQUIRED");

  const acknowledged = ledgerWith(context);
  const result = acknowledged.recordDecision({
    caseId: context.caseId,
    payload: approvePayload({ acknowledgeReview: true })
  });
  assert.equal(result.decision.recordStatus, "RECORDED");
});

test("critical conflict and failed dispatch gates block approval", () => {
  const unsafeContexts = [
    incident({ consensus: "CRITICAL_CONFLICT" }),
    incident({ gateOverrides: { G_LOCATION: false } }),
    incident({ gateOverrides: { G_CONTACT: false } }),
    incident({ gateOverrides: { G_RESOURCE: false } })
  ];
  for (const context of unsafeContexts) {
    const ledger = ledgerWith(context);
    assertCode(() => ledger.recordDecision({ caseId: context.caseId, payload: approvePayload() }), "DECISION_NOT_ALLOWED");
  }
});

test("each operational state enforces its deterministic allowlist", () => {
  const cases = [
    ["MERGE_OR_VERIFY", "MERGE_REPORT", true],
    ["MERGE_OR_VERIFY", "APPROVE_ACTION", false],
    ["URGENT_VERIFICATION", "REQUEST_VERIFICATION", true],
    ["URGENT_VERIFICATION", "APPROVE_ACTION", false],
    ["NEEDS_HUMAN_REVIEW", "HOLD_FOR_REVIEW", true],
    ["NEEDS_HUMAN_REVIEW", "APPROVE_ACTION", false],
    ["QUEUED_ACTION", "QUEUE_ACTION", true],
    ["QUEUED_ACTION", "APPROVE_ACTION", false],
    ["UNKNOWN_STATE", "APPROVE_ACTION", false]
  ];
  for (const [state, action, allowed] of cases) {
    const input = incident({ operationalState: state });
    const ledger = ledgerWith(input);
    const payload = action === "APPROVE_ACTION" ? approvePayload() : { action };
    if (allowed) {
      assert.equal(ledger.recordDecision({ caseId: input.caseId, payload }).decision.action, action);
    } else {
      assertCode(() => ledger.recordDecision({ caseId: input.caseId, payload }), "DECISION_NOT_ALLOWED");
    }
  }
});

test("external execution and override flags are computed by the server", () => {
  const holdLedger = ledgerWith();
  const hold = holdLedger.recordDecision({
    caseId: "CR-LIVE-CASE-01",
    payload: { action: "HOLD_FOR_REVIEW", actorType: "administrator", override: false }
  });
  assert.equal(hold.decision.requiresExternalExecution, false);
  assert.equal(hold.decision.override, true);
  assert.equal(hold.decision.actorType, "human_operator");

  const rejectLedger = ledgerWith();
  const reject = rejectLedger.recordDecision({
    caseId: "CR-LIVE-CASE-01",
    payload: { action: "REJECT_ACTION", reason: "Human rejected this bounded proposal." }
  });
  assert.equal(reject.decision.requiresExternalExecution, false);

  for (const [state, action] of [
    ["MERGE_OR_VERIFY", "MERGE_REPORT"],
    ["URGENT_VERIFICATION", "REQUEST_VERIFICATION"],
    ["QUEUED_ACTION", "QUEUE_ACTION"]
  ]) {
    const input = incident({ operationalState: state });
    const actionLedger = ledgerWith(input);
    const decision = actionLedger.recordDecision({ caseId: input.caseId, payload: { action } });
    assert.equal(decision.decision.requiresExternalExecution, true);
    assert.equal(decision.decision.executionStatus, "NOT_EXECUTED");
  }
});

test("forged server-owned identity, time, ID, sequence, hash and override are ignored", () => {
  const ledger = ledgerWith();
  const result = ledger.recordDecision({
    caseId: "CR-LIVE-CASE-01",
    payload: approvePayload({
      actorType: "system_admin",
      authentication: "verified",
      approvedBy: "forged",
      recordedAt: "1900-01-01T00:00:00.000Z",
      decisionId: "FORGED-ID",
      sequence: 900,
      entryHash: "FORGED-HASH",
      override: true
    })
  });
  assert.equal(result.decision.actorType, "human_operator");
  assert.equal(result.decision.authentication, "demo_local_only");
  assert.equal(result.decision.decisionId, "DECISION-1");
  assert.equal(result.decision.sequence, 1);
  assert.notEqual(result.decision.recordedAt, "1900-01-01T00:00:00.000Z");
  assert.notEqual(result.decision.entryHash, "FORGED-HASH");
  assert.equal(result.decision.override, false);
  assert.equal(Object.hasOwn(result.decision, "approvedBy"), false);
});

test("idempotency replays identical normalized requests without appending", () => {
  const ledger = ledgerWith();
  const request = {
    caseId: "CR-LIVE-CASE-01",
    payload: approvePayload({ action: " approve ", reason: "  Human approved this bounded proposal. " }),
    idempotencyKey: "decision-key-0001"
  };
  const first = ledger.recordDecision(request);
  const replay = ledger.recordDecision({
    ...request,
    payload: approvePayload({ action: "APPROVE_ACTION", reason: "Human approved this bounded proposal." })
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.decision.decisionId, first.decision.decisionId);
  assert.equal(ledger.getAudit(request.caseId).entryCount, 1);
});

test("idempotency conflicts and invalid keys are rejected", () => {
  const ledger = ledgerWith();
  ledger.recordDecision({
    caseId: "CR-LIVE-CASE-01",
    payload: approvePayload(),
    idempotencyKey: "decision-key-0002"
  });
  assertCode(() => ledger.recordDecision({
    caseId: "CR-LIVE-CASE-01",
    payload: approvePayload({ reason: "A different human reason is supplied." }),
    idempotencyKey: "decision-key-0002"
  }), "IDEMPOTENCY_CONFLICT");
  assertCode(() => ledger.recordDecision({
    caseId: "CR-LIVE-CASE-01",
    payload: approvePayload(),
    idempotencyKey: "short"
  }), "INVALID_DECISION_REQUEST");
});

test("requests without a key append independent linked entries", () => {
  const ledger = ledgerWith();
  const first = ledger.recordDecision({ caseId: "CR-LIVE-CASE-01", payload: approvePayload() });
  const second = ledger.recordDecision({
    caseId: "CR-LIVE-CASE-01",
    payload: { action: "HOLD_FOR_REVIEW" }
  });
  const audit = ledger.getAudit("CR-LIVE-CASE-01");
  assert.equal(first.decision.sequence, 1);
  assert.equal(second.decision.sequence, 2);
  assert.notEqual(first.decision.decisionId, second.decision.decisionId);
  assert.equal(second.decision.previousHash, first.decision.entryHash);
  assert.equal(audit.entryCount, 2);
  assert.equal(audit.chainValid, true);
  assert.equal(audit.persistence, "ephemeral");
  assert.equal(audit.externalAnchoring, "none");
  assert.equal(audit.chainScope, "per_case");
});

test("canonical JSON is stable across object key order", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: [3, { b: 4, a: 5 }] } }),
    canonicalJson({ a: { x: [3, { a: 5, b: 4 }], y: 2 }, z: 1 })
  );
});

test("audit verification detects changes to every protected link field", () => {
  const ledger = ledgerWith();
  ledger.recordDecision({ caseId: "CR-LIVE-CASE-01", payload: approvePayload() });
  ledger.recordDecision({ caseId: "CR-LIVE-CASE-01", payload: { action: "HOLD_FOR_REVIEW" } });
  const original = ledger.getAudit("CR-LIVE-CASE-01").entries;
  assert.equal(verifyAuditChain(original), true);

  for (const [index, field, value] of [
    [0, "action", "REJECT_ACTION"],
    [0, "reason", "tampered reason"],
    [0, "recordedAt", "2000-01-01T00:00:00.000Z"],
    [1, "previousHash", "0".repeat(64)],
    [0, "entryHash", "f".repeat(64)],
    [0, "sequence", 9]
  ]) {
    const tampered = structuredClone(original);
    tampered[index][field] = value;
    assert.equal(verifyAuditChain(tampered), false, `${field} tampering must fail verification`);
  }
});
