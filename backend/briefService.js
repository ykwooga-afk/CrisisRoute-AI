const {
  canonicalJson,
  sha256,
  verifyAuditChain
} = require("./decisionLedger");

const BRIEF_TEMPLATE_VERSION = "1.0";
const CAPSULE_VERSION = "1.0";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  DECISION_REQUIRED: "A valid human decision is required before a brief can be generated.",
  AUDIT_INTEGRITY_FAILURE: "The local decision audit chain failed integrity verification.",
  INVALID_PROOF_REQUEST: "The proof verification request is invalid."
});

class BriefServiceError extends Error {
  constructor(code) {
    super(PUBLIC_ERROR_MESSAGES[code] || "The brief request could not be processed.");
    this.name = "BriefServiceError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return structuredClone(value);
}

function priorityForUrgency(urgency) {
  if (urgency >= 80) return "CRITICAL";
  if (urgency >= 60) return "HIGH";
  if (urgency >= 30) return "MEDIUM";
  return "LOW";
}

function briefHashPayload(brief) {
  const { briefId: _briefId, ...payload } = brief;
  return payload;
}

function hashBrief(brief) {
  return sha256(canonicalJson(briefHashPayload(brief)));
}

function capsuleHashPayload(capsule) {
  const { capsuleId: _capsuleId, capsuleHash: _capsuleHash, ...payload } = capsule;
  return payload;
}

function hashCapsule(capsule) {
  return sha256(canonicalJson(capsuleHashPayload(capsule)));
}

function formatGate(snapshot, gateId, label) {
  const gate = snapshot.safetyGates.find(item => item.id === gateId);
  const status = gate?.passed === true ? "passed" : gate?.status || "not_available";
  return `${label}: ${status}`;
}

function formatConflictGate(snapshot) {
  const gate = snapshot.safetyGates.find(item => item.id === "G_CONFLICT");
  const status = String(gate?.status || "").toLowerCase();
  const consensus = String(snapshot.consensus || "").toUpperCase();
  if (gate?.passed === true && status === "passed" && consensus !== "DISAGREEMENT" && consensus !== "CRITICAL_CONFLICT") {
    return "Conflict gate: passed";
  }
  if (status === "blocked" || consensus === "CRITICAL_CONFLICT") {
    return "Model conflict blocks dispatch approval.";
  }
  if (status === "review" || status === "review_required" || consensus === "DISAGREEMENT") {
    return "Model conflict requires human review.";
  }
  return `Conflict gate: ${status || "not_available"}`;
}

function isReferenceSnapshot(snapshot) {
  return snapshot?.inputClassification?.activeIncident === false;
}

function actionContent(snapshot, decision) {
  const baseConstraint = "This software records and prepares a handoff; it does not execute real-world action.";
  if (isReferenceSnapshot(snapshot) && decision.action === "REQUEST_VERIFICATION") {
    return {
      title: "Reference source verification record",
      summary: "The human decision was recorded for a reference source. No current operational incident or real-world action is claimed.",
      safetyConstraints: [
        snapshot.inputClassification?.label || "Reference source; no active incident detected.",
        formatGate(snapshot, "G_LOCATION", "Location gate"),
        formatGate(snapshot, "G_CONTACT", "Contact gate"),
        baseConstraint
      ],
      nextSteps: [
        "No operational response is recommended from this source alone because it contains general reference information rather than a current incident.",
        "Obtain or verify a current incident report before operational action."
      ]
    };
  }
  const byAction = {
    APPROVE_ACTION: {
      title: "Approved action handoff",
      summary: "Human approval was recorded. External execution is still required. Nothing has been dispatched automatically.",
      safetyConstraints: [
        formatGate(snapshot, "G_LOCATION", "Location gate"),
        formatGate(snapshot, "G_CONTACT", "Contact gate"),
        formatGate(snapshot, "G_RESOURCE", "Resource gate"),
        `Model consensus: ${snapshot.consensus || "not_available"}`,
        `Human reason recorded: ${decision.reason}`,
        `Model disagreement review acknowledged: ${decision.reviewAcknowledged === true ? "yes" : "not_required_or_no"}`,
        baseConstraint
      ],
      nextSteps: [
        "An authorized external operator should re-check current conditions and the recorded safety gates.",
        "An authorized external operator must perform any approved real-world action outside this software."
      ]
    },
    REQUEST_VERIFICATION: {
      title: "Urgent verification handoff",
      summary: "Urgent verification was requested. Low verification does not reduce medical urgency, and no external contact has been performed by this software.",
      safetyConstraints: [
        "Treat high urgency independently from evidence confidence.",
        "Do not claim a verified location, callback or medical outcome until an authorized person verifies it.",
        baseConstraint
      ],
      nextSteps: [
        "An authorized external operator should obtain the exact location and a reliable callback path.",
        "An authorized external operator should follow official medical guidance if breathing difficulty is reported."
      ]
    },
    MERGE_REPORT: {
      title: "Report merge and verification handoff",
      summary: "Human direction to merge related reports was recorded. Repeated forwarding is not independent corroboration.",
      safetyConstraints: [
        "Preserve the original-source gap and duplicate or forward risk.",
        "Do not increase confidence merely because the same wording was forwarded repeatedly.",
        baseConstraint
      ],
      nextSteps: [
        "An authorized external operator should identify the original source.",
        "Merge matching forwards, then verify any distinct location or callback evidence separately."
      ]
    },
    HOLD_FOR_REVIEW: {
      title: "Human review hold",
      summary: "A human review hold was recorded. No definitive public instruction is authorized by this brief.",
      safetyConstraints: [
        formatConflictGate(snapshot),
        `Human reason recorded: ${decision.reason || "No additional reason supplied"}`,
        "Resolve material conflicts before any definitive public instruction.",
        baseConstraint
      ],
      nextSteps: [
        "An authorized reviewer should resolve the outstanding conflict or blocked gate.",
        "Keep the case in human review until a later recorded decision changes its state."
      ]
    },
    QUEUE_ACTION: {
      title: "Resource queue handoff",
      summary: "A human queue decision was recorded. Resources remain proposed; no delivery is claimed.",
      safetyConstraints: [
        "Queued resources are planning items, not evidence of availability or delivery.",
        baseConstraint
      ],
      nextSteps: [
        "An authorized external operator should confirm each resource before making a commitment.",
        "Record unmet resources and retain them as unresolved needs."
      ]
    },
    REJECT_ACTION: {
      title: "Rejected action record",
      summary: "Human rejection was recorded. The proposed action will not advance from this local handoff.",
      safetyConstraints: [
        `Human reason recorded: ${decision.reason}`,
        "Retain the original analysis and append-only audit history.",
        baseConstraint
      ],
      nextSteps: [
        "No external execution is requested by this decision.",
        "A future change requires a separate human decision and a new audit entry."
      ]
    }
  };
  return byAction[decision.action] || {
    title: "Human decision handoff",
    summary: "A bounded human decision was recorded for review.",
    safetyConstraints: [baseConstraint],
    nextSteps: ["An authorized human should review the saved decision before any external action."]
  };
}

function validateSafeStructure(value) {
  let nodes = 0;
  const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
  function visit(item, depth) {
    nodes += 1;
    if (nodes > 1_000 || depth > 8) throw new BriefServiceError("INVALID_PROOF_REQUEST");
    if (item === null || typeof item === "boolean" || typeof item === "string") {
      if (typeof item === "string" && item.length > 2_000) throw new BriefServiceError("INVALID_PROOF_REQUEST");
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new BriefServiceError("INVALID_PROOF_REQUEST");
      return;
    }
    if (Array.isArray(item)) {
      if (item.length > 64) throw new BriefServiceError("INVALID_PROOF_REQUEST");
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (!isPlainObject(item)) throw new BriefServiceError("INVALID_PROOF_REQUEST");
    const keys = Object.keys(item);
    if (keys.length > 64 || keys.some(key => dangerousKeys.has(key))) {
      throw new BriefServiceError("INVALID_PROOF_REQUEST");
    }
    for (const key of keys) visit(item[key], depth + 1);
  }
  visit(value, 0);
  if (canonicalJson(value).length > 100_000) throw new BriefServiceError("INVALID_PROOF_REQUEST");
}

function assertProofShape(brief, capsule) {
  if (!isPlainObject(brief) || !isPlainObject(capsule)) {
    throw new BriefServiceError("INVALID_PROOF_REQUEST");
  }
  const briefStrings = [
    "briefVersion", "briefId", "caseId", "generatedAt", "status", "title",
    "operationalState", "decisionAction", "decisionId", "decisionEntryHash", "analysisSnapshotHash"
  ];
  const capsuleStrings = [
    "capsuleVersion", "capsuleId", "caseId", "generatedAt", "hashAlgorithm", "canonicalization",
    "analysisSnapshotHash", "decisionId", "decisionEntryHash", "auditChainHead", "briefId",
    "briefHash", "provenanceHash", "persistence", "externalAnchoring", "integrityScope", "capsuleHash"
  ];
  if (briefStrings.some(key => typeof brief[key] !== "string" || brief[key].length === 0) ||
      capsuleStrings.some(key => typeof capsule[key] !== "string" || capsule[key].length === 0)) {
    throw new BriefServiceError("INVALID_PROOF_REQUEST");
  }
}

function verifyProof({ brief, proofCapsule } = {}) {
  validateSafeStructure({ brief, proofCapsule });
  assertProofShape(brief, proofCapsule);
  const computedBriefHash = hashBrief(brief);
  const computedCapsuleHash = hashCapsule(proofCapsule);
  const checks = {
    briefHash: proofCapsule.briefHash === computedBriefHash,
    capsuleHash: proofCapsule.capsuleHash === computedCapsuleHash,
    capsuleId: proofCapsule.capsuleId === `PC-${computedCapsuleHash.slice(0, 16).toUpperCase()}`,
    references:
      proofCapsule.hashAlgorithm === "SHA-256" &&
      proofCapsule.canonicalization === "sorted-json-v1" &&
      proofCapsule.persistence === "ephemeral" &&
      proofCapsule.externalAnchoring === "none" &&
      proofCapsule.integrityScope === "local_payload_integrity" &&
      HASH_PATTERN.test(proofCapsule.analysisSnapshotHash) &&
      HASH_PATTERN.test(proofCapsule.decisionEntryHash) &&
      HASH_PATTERN.test(proofCapsule.auditChainHead) &&
      HASH_PATTERN.test(proofCapsule.provenanceHash) &&
      HASH_PATTERN.test(proofCapsule.briefHash) &&
      HASH_PATTERN.test(proofCapsule.capsuleHash) &&
      brief.briefId === `BR-${computedBriefHash.slice(0, 16).toUpperCase()}` &&
      proofCapsule.caseId === brief.caseId &&
      proofCapsule.briefId === brief.briefId &&
      proofCapsule.decisionId === brief.decisionId &&
      proofCapsule.analysisSnapshotHash === brief.analysisSnapshotHash &&
      proofCapsule.decisionEntryHash === brief.decisionEntryHash &&
      proofCapsule.auditChainHead === brief.decisionEntryHash
  };
  return {
    ok: true,
    valid: Object.values(checks).every(Boolean),
    checks
  };
}

function createBriefService({ decisionLedger, clock = () => new Date() } = {}) {
  if (!decisionLedger || typeof decisionLedger.getContext !== "function" || typeof decisionLedger.getAudit !== "function") {
    throw new TypeError("A decision ledger is required.");
  }
  const versions = new Map();
  const replays = new Map();
  const issuedCapsules = new Map();

  function generateBrief(caseId) {
    const context = decisionLedger.getContext(caseId);
    const audit = decisionLedger.getAudit(caseId);
    if (!Array.isArray(audit.entries) || audit.entries.length === 0) {
      throw new BriefServiceError("DECISION_REQUIRED");
    }
    if (audit.chainValid !== true || !verifyAuditChain(audit.entries)) {
      throw new BriefServiceError("AUDIT_INTEGRITY_FAILURE");
    }
    const decision = audit.entries[audit.entries.length - 1];
    if (decision.analysisSnapshotHash !== context.analysisSnapshotHash) {
      throw new BriefServiceError("DECISION_REQUIRED");
    }
    const binding = {
      caseId,
      analysisSnapshotHash: context.analysisSnapshotHash,
      decisionId: decision.decisionId,
      decisionEntryHash: decision.entryHash,
      auditChainHead: audit.entries[audit.entries.length - 1].entryHash,
      briefTemplateVersion: BRIEF_TEMPLATE_VERSION
    };
    const replayKey = sha256(canonicalJson(binding));
    if (replays.has(replayKey)) {
      return { ...clone(replays.get(replayKey)), replayed: true };
    }

    const caseVersions = versions.get(caseId) || [];
    const recordVersion = caseVersions.length + 1;
    const generatedAt = new Date(clock()).toISOString();
    const snapshot = context.snapshot;
    const content = actionContent(snapshot, decision);
    const briefWithoutId = {
      briefVersion: BRIEF_TEMPLATE_VERSION,
      recordVersion,
      caseId,
      generatedAt,
      status: "READY_FOR_HANDOFF",
      title: content.title,
      incidentTitle: snapshot.title,
      operationalState: snapshot.operationalState,
      decisionAction: decision.action,
      aiRecommendation: decision.aiRecommendation,
      override: decision.override,
      priority: priorityForUrgency(snapshot.scores.urgency),
      summary: content.summary,
      reportedFacts: clone(snapshot.knownFacts),
      unknowns: clone(snapshot.unknownFacts),
      location: snapshot.location,
      peopleCount: snapshot.peopleCount,
      requestedResources: clone(snapshot.needs),
      riskFlags: clone(snapshot.riskFlags),
      inputClassification: clone(snapshot.inputClassification || null),
      safetyConstraints: content.safetyConstraints,
      nextSteps: [...content.nextSteps, ...snapshot.safeNextActions].slice(0, 10),
      humanReason: decision.reason,
      reviewAcknowledged: decision.reviewAcknowledged === true,
      recordStatus: decision.recordStatus,
      executionStatus: "NOT_EXECUTED",
      requiresExternalExecution: decision.requiresExternalExecution,
      decisionId: decision.decisionId,
      decisionEntryHash: decision.entryHash,
      analysisSnapshotHash: context.analysisSnapshotHash
    };
    const briefHash = sha256(canonicalJson(briefWithoutId));
    const brief = {
      ...briefWithoutId,
      briefId: `BR-${briefHash.slice(0, 16).toUpperCase()}`
    };
    const provenanceHash = sha256(canonicalJson({
      analysisReference: snapshot.analysisReference,
      scores: snapshot.scores,
      consensus: snapshot.consensus
    }));
    const capsuleWithoutDerived = {
      capsuleVersion: CAPSULE_VERSION,
      recordVersion,
      caseId,
      generatedAt,
      hashAlgorithm: "SHA-256",
      canonicalization: "sorted-json-v1",
      analysisSnapshotHash: context.analysisSnapshotHash,
      decisionId: decision.decisionId,
      decisionEntryHash: decision.entryHash,
      auditChainHead: binding.auditChainHead,
      auditChainValidAtCreation: true,
      briefId: brief.briefId,
      briefHash,
      provenanceHash,
      evidenceHashes: [context.analysisSnapshotHash, decision.entryHash],
      receiptHash: provenanceHash,
      persistence: "ephemeral",
      externalAnchoring: "none",
      integrityScope: "local_payload_integrity",
      integrityStatement: "The supplied brief and capsule have not changed since local capsule creation.",
      limitations: [
        "Report truth and model correctness are not proven.",
        "Human identity is not formally authenticated.",
        "No real-world action or external record is proven."
      ]
    };
    const capsuleHash = sha256(canonicalJson(capsuleWithoutDerived));
    const proofCapsule = {
      ...capsuleWithoutDerived,
      capsuleId: `PC-${capsuleHash.slice(0, 16).toUpperCase()}`,
      capsuleHash
    };
    const response = {
      ok: true,
      brief,
      proofCapsule,
      replayed: false
    };
    caseVersions.push(clone(response));
    versions.set(caseId, caseVersions);
    replays.set(replayKey, clone(response));
    issuedCapsules.set(proofCapsule.capsuleId, {
      brief: clone(brief),
      proofCapsule: clone(proofCapsule)
    });
    return clone(response);
  }

  function verifyIssuedProof(payload) {
    const result = verifyProof(payload);
    const issued = issuedCapsules.get(payload.proofCapsule.capsuleId);
    const localRecordMatches = issued !== undefined &&
      canonicalJson(issued.brief) === canonicalJson(payload.brief) &&
      canonicalJson(issued.proofCapsule) === canonicalJson(payload.proofCapsule);
    result.checks.references = result.checks.references && localRecordMatches;
    result.valid = Object.values(result.checks).every(Boolean);
    return result;
  }

  return Object.freeze({
    generateBrief,
    verifyProof: verifyIssuedProof,
    getVersions: caseId => clone(versions.get(caseId) || []),
    getVersionCount: caseId => (versions.get(caseId) || []).length
  });
}

module.exports = {
  BRIEF_TEMPLATE_VERSION,
  CAPSULE_VERSION,
  BriefServiceError,
  priorityForUrgency,
  hashBrief,
  hashCapsule,
  verifyProof,
  createBriefService
};
