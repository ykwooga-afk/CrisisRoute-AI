const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BriefServiceError,
  createBriefService,
  hashBrief,
  hashCapsule,
  priorityForUrgency,
  verifyProof
} = require("../backend/briefService");
const {
  DecisionLedgerError,
  createDecisionLedger
} = require("../backend/decisionLedger");

function incident({
  caseId = "CR-LIVE-CASE-01",
  operationalState = "DISPATCH_CANDIDATE",
  urgency = 88,
  consensus = "AGREEMENT",
  conflictStatus = "passed"
} = {}) {
  return {
    caseId,
    label: caseId.slice(-2),
    title: "Safe submitted-evidence case",
    operationalState,
    location: "Hostel Block C lobby",
    peopleCount: 6,
    needs: ["N95 masks", "clinic transport"],
    riskFlags: ["reported breathing difficulty"],
    knownFacts: ["Six people were reported coughing"],
    unknownFacts: ["Current clinical condition"],
    safeNextActions: ["An external coordinator should re-check current conditions."],
    recommendedAction: "Prepare a bounded proposal for human review.",
    scores: { verification: 80, urgency, actionability: 82 },
    modelDebate: {
      consensus,
      scoreGaps: { verification: 2, urgency: 4, actionability: 3 }
    },
    safetyGates: [
      { id: "G_LOCATION", status: "passed", passed: true, detail: "PRIVATE_GATE_DETAIL" },
      { id: "G_CONTACT", status: "passed", passed: true, detail: "PRIVATE_GATE_DETAIL" },
      { id: "G_RESOURCE", status: "passed", passed: true, detail: "PRIVATE_GATE_DETAIL" },
      { id: "G_CONFLICT", status: conflictStatus, passed: conflictStatus === "passed", detail: "PRIVATE_GATE_DETAIL" },
      { id: "G_DISPATCH", status: operationalState === "DISPATCH_CANDIDATE" ? "passed" : "locked", passed: operationalState === "DISPATCH_CANDIDATE" }
    ],
    qualityWarnings: [],
    receivedAt: "2026-08-31T08:00:00.000Z",
    rawMessage: "RAW_MODEL_CONTENT_MUST_NOT_LEAK",
    prompt: "PROMPT_MUST_NOT_LEAK",
    authorization: "Bearer sk-BRIEF-SECRET-MUST-NOT-LEAK",
    gonka: {
      analyst: { model: "safe-analyst", responseId: "safe-response-a", rawContent: "RAW_A" },
      reviewer: { model: "safe-reviewer", responseId: "safe-response-r", prompt: "PROMPT_R" }
    }
  };
}

function setup({ incidentValue = incident(), action = "APPROVE_ACTION", reason, acknowledgeReview = false } = {}) {
  let decisionNumber = 0;
  let briefSecond = 0;
  const ledger = createDecisionLedger({
    clock: () => new Date(`2026-08-31T08:00:0${decisionNumber + 1}.000Z`),
    idGenerator: () => `DEC-BRIEF-${++decisionNumber}`
  });
  ledger.registerAnalysisResult({ incidents: [incidentValue] });
  const service = createBriefService({
    decisionLedger: ledger,
    clock: () => new Date(`2026-08-31T09:00:0${++briefSecond}.000Z`)
  });
  const payload = {
    action,
    reason: reason ?? (action === "APPROVE_ACTION" || action === "REJECT_ACTION" ? "Human supplied a bounded decision reason." : ""),
    acknowledgeHumanDecision: true,
    acknowledgeNoAutomaticExecution: true,
    acknowledgeReview
  };
  return { ledger, service, payload, caseId: incidentValue.caseId };
}

function record(setupValue, overrides = {}) {
  return setupValue.ledger.recordDecision({
    caseId: setupValue.caseId,
    payload: { ...setupValue.payload, ...overrides }
  });
}

function assertCode(fn, code) {
  assert.throws(fn, error =>
    (error instanceof BriefServiceError || error instanceof DecisionLedgerError) && error.code === code);
}

test("brief generation requires analysis context, a decision and a valid audit chain", () => {
  const emptyLedger = createDecisionLedger();
  const emptyService = createBriefService({ decisionLedger: emptyLedger });
  assertCode(() => emptyService.generateBrief("CR-LIVE-CASE-01"), "ANALYSIS_CONTEXT_NOT_FOUND");

  const noDecision = setup();
  assertCode(() => noDecision.service.generateBrief(noDecision.caseId), "DECISION_REQUIRED");

  const valid = setup();
  record(valid);
  const invalidAuditLedger = {
    getContext: caseId => valid.ledger.getContext(caseId),
    getAudit: caseId => ({ ...valid.ledger.getAudit(caseId), chainValid: false })
  };
  const invalidAuditService = createBriefService({ decisionLedger: invalidAuditLedger });
  assertCode(() => invalidAuditService.generateBrief(valid.caseId), "AUDIT_INTEGRITY_FAILURE");
});

test("priority boundaries are deterministic and do not clamp scores", () => {
  assert.equal(priorityForUrgency(80), "CRITICAL");
  assert.equal(priorityForUrgency(79.99), "HIGH");
  assert.equal(priorityForUrgency(60), "HIGH");
  assert.equal(priorityForUrgency(59.99), "MEDIUM");
  assert.equal(priorityForUrgency(30), "MEDIUM");
  assert.equal(priorityForUrgency(29.99), "LOW");
});

test("reference-source verification brief does not imply a current medical casualty", () => {
  const referenceIncident = {
    ...incident({ operationalState: "URGENT_VERIFICATION", urgency: 34 }),
    title: "Haze - Wikipedia",
    location: "Unknown location",
    peopleCount: null,
    needs: [],
    riskFlags: ["smoke exposure"],
    knownFacts: ["Haze can reduce visibility."],
    unknownFacts: ["current actionable incident report"],
    safeNextActions: ["Obtain or verify a current incident report before operational action."],
    inputClassification: {
      kind: "REFERENCE_SOURCE",
      label: "REFERENCE SOURCE · NO ACTIVE INCIDENT DETECTED",
      activeIncident: false,
      detail: "This source contains background/reference information rather than a current actionable crisis report."
    },
    safetyGates: [
      { id: "G_LOCATION", status: "blocked", passed: false, detail: "No actionable location." },
      { id: "G_CONTACT", status: "blocked", passed: false, detail: "No contact path." },
      { id: "G_RESOURCE", status: "blocked", passed: false, detail: "No operational resource need." },
      { id: "G_CONFLICT", status: "passed", passed: true, detail: "Agreement." },
      { id: "G_DISPATCH", status: "locked", passed: false, detail: "Locked." }
    ]
  };
  const value = setup({ incidentValue: referenceIncident, action: "REQUEST_VERIFICATION" });
  record(value);
  const { brief } = value.service.generateBrief(value.caseId);
  const serialized = JSON.stringify(brief);
  assert.equal(brief.inputClassification.activeIncident, false);
  assert.match(brief.summary, /reference source/i);
  assert.match(serialized, /No operational response is recommended/);
  assert.doesNotMatch(serialized, /breathing difficulty|medical guidance/i);
});

test("APPROVE brief records approval without claiming automatic execution", () => {
  const value = setup();
  record(value);
  const result = value.service.generateBrief(value.caseId);
  assert.equal(result.brief.decisionAction, "APPROVE_ACTION");
  assert.equal(result.brief.executionStatus, "NOT_EXECUTED");
  assert.equal(result.brief.requiresExternalExecution, true);
  assert.match(result.brief.summary, /Nothing has been dispatched automatically/i);
  assert.ok(result.brief.safetyConstraints.some(item => /Location gate: passed/.test(item)));
  assert.ok(result.brief.safetyConstraints.some(item => /Contact gate: passed/.test(item)));
  assert.ok(result.brief.safetyConstraints.some(item => /Resource gate: passed/.test(item)));
  assert.ok(result.brief.safetyConstraints.some(item => /Model consensus: AGREEMENT/.test(item)));
  assert.ok(result.brief.safetyConstraints.some(item => /Human reason recorded/.test(item)));
});

test("REQUEST_VERIFICATION brief preserves high urgency independently from verification", () => {
  const value = setup({
    incidentValue: incident({ caseId: "CR-LIVE-CASE-03", operationalState: "URGENT_VERIFICATION", urgency: 98 }),
    action: "REQUEST_VERIFICATION"
  });
  record(value);
  const result = value.service.generateBrief(value.caseId);
  assert.equal(result.brief.priority, "CRITICAL");
  assert.match(result.brief.summary, /Low verification does not reduce medical urgency/i);
  assert.match(result.brief.nextSteps.join(" "), /exact location|callback|official medical guidance/i);
  assert.doesNotMatch(result.brief.summary, /hospital (?:was )?contacted|patient (?:was )?contacted/i);
});

test("MERGE_REPORT brief treats forwarding as a source gap rather than corroboration", () => {
  const value = setup({
    incidentValue: incident({ caseId: "CR-LIVE-CASE-02", operationalState: "MERGE_OR_VERIFY" }),
    action: "MERGE_REPORT"
  });
  record(value);
  const result = value.service.generateBrief(value.caseId);
  assert.match(result.brief.summary, /not independent corroboration/i);
  assert.match(result.brief.nextSteps.join(" "), /original source|Merge matching forwards/i);
});

test("HOLD_FOR_REVIEW brief keeps public instructions unresolved", () => {
  const value = setup({
    incidentValue: incident({ caseId: "CR-LIVE-CASE-04", operationalState: "NEEDS_HUMAN_REVIEW", conflictStatus: "review" }),
    action: "HOLD_FOR_REVIEW",
    reason: "Human reviewed the unresolved conflict.",
    acknowledgeReview: true
  });
  record(value);
  const result = value.service.generateBrief(value.caseId);
  assert.match(result.brief.summary, /No definitive public instruction is authorized/i);
  assert.ok(result.brief.safetyConstraints.some(item => /Conflict gate: review/.test(item)));
});

test("QUEUE_ACTION brief distinguishes planning from delivery", () => {
  const value = setup({
    incidentValue: incident({ caseId: "CR-LIVE-CASE-05", operationalState: "QUEUED_ACTION" }),
    action: "QUEUE_ACTION"
  });
  record(value);
  const result = value.service.generateBrief(value.caseId);
  assert.deepEqual(result.brief.requestedResources, ["N95 masks", "clinic transport"]);
  assert.match(result.brief.summary, /no delivery is claimed/i);
});

test("REJECT_ACTION brief retains its analysis and audit history", () => {
  const value = setup({ action: "REJECT_ACTION" });
  record(value);
  const before = value.ledger.getAudit(value.caseId);
  const result = value.service.generateBrief(value.caseId);
  const after = value.ledger.getAudit(value.caseId);
  assert.equal(result.brief.requiresExternalExecution, false);
  assert.match(result.brief.summary, /Human rejection was recorded/i);
  assert.deepEqual(after, before);
});

test("brief uses only the safe server context and latest decision", () => {
  const value = setup();
  const first = record(value);
  const result = value.service.generateBrief(value.caseId);
  const serialized = JSON.stringify(result);
  assert.equal(result.brief.decisionId, first.decision.decisionId);
  assert.equal(result.brief.decisionEntryHash, first.decision.entryHash);
  assert.doesNotMatch(serialized, /RAW_MODEL|PROMPT|Authorization|sk-BRIEF|PRIVATE_GATE_DETAIL|RAW_A|PROMPT_R/);
});

test("same binding replays the identical Brief and Proof without a new version", () => {
  const value = setup();
  record(value);
  const first = value.service.generateBrief(value.caseId);
  const replay = value.service.generateBrief(value.caseId);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.brief, first.brief);
  assert.deepEqual(replay.proofCapsule, first.proofCapsule);
  assert.equal(value.service.getVersionCount(value.caseId), 1);
});

test("a new human decision creates a new version while retaining the old version", () => {
  const value = setup();
  record(value);
  const first = value.service.generateBrief(value.caseId);
  record(value, { action: "HOLD_FOR_REVIEW", reason: "" });
  const second = value.service.generateBrief(value.caseId);
  const versions = value.service.getVersions(value.caseId);
  assert.equal(second.brief.recordVersion, 2);
  assert.notEqual(second.brief.briefId, first.brief.briefId);
  assert.notEqual(second.proofCapsule.capsuleId, first.proofCapsule.capsuleId);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].brief.briefId, first.brief.briefId);
});

test("Brief and Capsule hashes are stable across object key order", () => {
  const value = setup();
  record(value);
  const result = value.service.generateBrief(value.caseId);
  const reverseKeys = object => Object.fromEntries(Object.entries(object).reverse());
  assert.equal(hashBrief(reverseKeys(result.brief)), result.proofCapsule.briefHash);
  assert.equal(hashCapsule(reverseKeys(result.proofCapsule)), result.proofCapsule.capsuleHash);
});

test("Proof Capsule derives IDs and records honest local-only integrity scope", () => {
  const value = setup();
  record(value);
  const { brief, proofCapsule } = value.service.generateBrief(value.caseId);
  assert.equal(proofCapsule.briefHash, hashBrief(brief));
  assert.equal(proofCapsule.capsuleHash, hashCapsule(proofCapsule));
  assert.equal(proofCapsule.capsuleId, `PC-${proofCapsule.capsuleHash.slice(0, 16).toUpperCase()}`);
  assert.equal(proofCapsule.persistence, "ephemeral");
  assert.equal(proofCapsule.externalAnchoring, "none");
  assert.equal(proofCapsule.integrityScope, "local_payload_integrity");
  assert.match(proofCapsule.integrityStatement, /have not changed since local capsule creation/i);
});

test("valid proof passes all fixed verification checks", () => {
  const value = setup();
  record(value);
  const result = value.service.generateBrief(value.caseId);
  assert.deepEqual(verifyProof(result), {
    ok: true,
    valid: true,
    checks: { briefHash: true, capsuleHash: true, capsuleId: true, references: true }
  });
});

test("tampering with Brief content is detected without throwing", () => {
  const value = setup();
  record(value);
  const result = value.service.generateBrief(value.caseId);
  result.brief.summary = "Tampered summary";
  const verification = verifyProof(result);
  assert.equal(verification.valid, false);
  assert.equal(verification.checks.briefHash, false);
});

test("tampering each Capsule reference or derived hash is detected", () => {
  const value = setup();
  record(value);
  const original = value.service.generateBrief(value.caseId);
  for (const [field, replacement] of [
    ["caseId", "CR-LIVE-CASE-02"],
    ["decisionEntryHash", "a".repeat(64)],
    ["auditChainHead", "b".repeat(64)],
    ["briefHash", "c".repeat(64)],
    ["capsuleHash", "d".repeat(64)]
  ]) {
    const changed = structuredClone(original);
    changed.proofCapsule[field] = replacement;
    assert.equal(verifyProof(changed).valid, false, `${field} tampering must fail`);
  }
});

test("self-rehashed client payload is not accepted as a locally issued capsule", () => {
  const value = setup();
  record(value);
  const changed = structuredClone(value.service.generateBrief(value.caseId));
  changed.brief.summary = "Client-created replacement summary";
  const replacementBriefHash = hashBrief(changed.brief);
  changed.brief.briefId = `BR-${replacementBriefHash.slice(0, 16).toUpperCase()}`;
  changed.proofCapsule.briefHash = replacementBriefHash;
  changed.proofCapsule.briefId = changed.brief.briefId;
  const replacementCapsuleHash = hashCapsule(changed.proofCapsule);
  changed.proofCapsule.capsuleHash = replacementCapsuleHash;
  changed.proofCapsule.capsuleId = `PC-${replacementCapsuleHash.slice(0, 16).toUpperCase()}`;

  assert.equal(verifyProof(changed).valid, true, "self-consistent hashes should be internally valid");
  const issuedVerification = value.service.verifyProof(changed);
  assert.equal(issuedVerification.valid, false);
  assert.equal(issuedVerification.checks.references, false);
});

test("malformed, prototype-polluting and deeply nested proof requests are rejected", () => {
  assertCode(() => verifyProof({ brief: null, proofCapsule: null }), "INVALID_PROOF_REQUEST");

  const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
  assertCode(() => verifyProof({ brief: {}, proofCapsule: polluted }), "INVALID_PROOF_REQUEST");
  assert.equal({}.polluted, undefined);

  let deep = "leaf";
  for (let index = 0; index < 12; index += 1) deep = { nested: deep };
  assertCode(() => verifyProof({ brief: deep, proofCapsule: {} }), "INVALID_PROOF_REQUEST");
});
