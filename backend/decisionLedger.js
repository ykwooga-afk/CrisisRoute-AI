const crypto = require("node:crypto");

const CASE_ID_PATTERN = /^CR-LIVE-(?:[A-F0-9]{10}|CASE-0[1-5])$/;
const MAX_CASE_ID_LENGTH = 32;
const GENESIS_HASH = null;

const CANONICAL_ACTIONS = Object.freeze([
  "APPROVE_ACTION",
  "REQUEST_VERIFICATION",
  "MERGE_REPORT",
  "HOLD_FOR_REVIEW",
  "QUEUE_ACTION",
  "REJECT_ACTION"
]);

const ACTION_ALIASES = Object.freeze({
  approve_action: "APPROVE_ACTION",
  approve: "APPROVE_ACTION",
  approved: "APPROVE_ACTION",
  request_verification: "REQUEST_VERIFICATION",
  verify: "REQUEST_VERIFICATION",
  urgent_verification: "REQUEST_VERIFICATION",
  needs_more_info: "REQUEST_VERIFICATION",
  merge_report: "MERGE_REPORT",
  merge: "MERGE_REPORT",
  merge_or_reject: "MERGE_REPORT",
  hold_for_review: "HOLD_FOR_REVIEW",
  hold: "HOLD_FOR_REVIEW",
  review: "HOLD_FOR_REVIEW",
  queue_action: "QUEUE_ACTION",
  queue: "QUEUE_ACTION",
  reject_action: "REJECT_ACTION",
  reject: "REJECT_ACTION"
});

const STATE_POLICY = Object.freeze({
  DISPATCH_CANDIDATE: Object.freeze([
    "APPROVE_ACTION", "REQUEST_VERIFICATION", "HOLD_FOR_REVIEW", "REJECT_ACTION"
  ]),
  MERGE_OR_VERIFY: Object.freeze([
    "MERGE_REPORT", "REQUEST_VERIFICATION", "HOLD_FOR_REVIEW", "REJECT_ACTION"
  ]),
  URGENT_VERIFICATION: Object.freeze([
    "REQUEST_VERIFICATION", "HOLD_FOR_REVIEW", "REJECT_ACTION"
  ]),
  NEEDS_HUMAN_REVIEW: Object.freeze([
    "HOLD_FOR_REVIEW", "REQUEST_VERIFICATION", "REJECT_ACTION"
  ]),
  QUEUED_ACTION: Object.freeze([
    "QUEUE_ACTION", "HOLD_FOR_REVIEW", "REJECT_ACTION"
  ])
});

const RECOMMENDED_ACTION = Object.freeze({
  DISPATCH_CANDIDATE: "APPROVE_ACTION",
  MERGE_OR_VERIFY: "MERGE_REPORT",
  URGENT_VERIFICATION: "REQUEST_VERIFICATION",
  NEEDS_HUMAN_REVIEW: "HOLD_FOR_REVIEW",
  QUEUED_ACTION: "QUEUE_ACTION"
});

const EXTERNAL_EXECUTION_ACTIONS = new Set([
  "APPROVE_ACTION", "REQUEST_VERIFICATION", "MERGE_REPORT", "QUEUE_ACTION"
]);

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  INVALID_DECISION_REQUEST: "The human decision request is invalid.",
  INVALID_CASE_ID: "The case ID is invalid.",
  UNKNOWN_DECISION_ACTION: "The requested human decision action is unknown.",
  ANALYSIS_CONTEXT_NOT_FOUND: "No in-process analysis context exists for this case.",
  DECISION_NOT_ALLOWED: "The requested decision is not allowed for the saved analysis context.",
  ACKNOWLEDGEMENT_REQUIRED: "Required human safety acknowledgements are missing.",
  IDEMPOTENCY_CONFLICT: "The idempotency key was already used for a different decision request."
});

class DecisionLedgerError extends Error {
  constructor(code) {
    super(PUBLIC_ERROR_MESSAGES[code] || "The decision request could not be processed.");
    this.name = "DecisionLedgerError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hashEntry(entry) {
  const { entryHash: _entryHash, ...stored } = entry;
  return sha256(canonicalJson(stored));
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function validateCaseId(caseId) {
  if (typeof caseId !== "string" ||
      caseId.length > MAX_CASE_ID_LENGTH ||
      caseId.includes("\0") ||
      !CASE_ID_PATTERN.test(caseId)) {
    throw new DecisionLedgerError("INVALID_CASE_ID");
  }
  return caseId;
}

function normalizeAction(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new DecisionLedgerError("INVALID_DECISION_REQUEST");
  }
  const normalized = value.trim().toLowerCase();
  const action = ACTION_ALIASES[normalized];
  if (!action) throw new DecisionLedgerError("UNKNOWN_DECISION_ACTION");
  return action;
}

function normalizeReason(payload) {
  const supplied = payload.reason !== undefined ? payload.reason : payload.note;
  if (supplied === undefined || supplied === null) return "";
  if (typeof supplied !== "string" || supplied.includes("\0")) {
    throw new DecisionLedgerError("INVALID_DECISION_REQUEST");
  }
  const reason = supplied.trim();
  if (reason.length > 500) throw new DecisionLedgerError("INVALID_DECISION_REQUEST");
  return reason;
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.includes("\0")) {
    throw new DecisionLedgerError("INVALID_DECISION_REQUEST");
  }
  const key = value.trim();
  if (key.length < 8 || key.length > 128) {
    throw new DecisionLedgerError("INVALID_DECISION_REQUEST");
  }
  return key;
}

function safeString(value, maxLength = 160) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : null;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function safeStringArray(value, { maxItems = 12, maxLength = 240 } = {}) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    const normalized = safeString(item, maxLength);
    if (normalized && !result.includes(normalized)) result.push(normalized);
    if (result.length === maxItems) break;
  }
  return result;
}

function safeInputClassification(value) {
  if (!isPlainObject(value)) return null;
  const activeIncident = value.activeIncident === true ? true : value.activeIncident === false ? false : null;
  return {
    kind: safeString(value.kind, 64),
    label: safeString(value.label, 120),
    activeIncident,
    detail: safeString(value.detail, 240)
  };
}

function buildAnalysisSnapshot(incident) {
  if (!isPlainObject(incident)) return null;
  let caseId;
  try {
    caseId = validateCaseId(incident.caseId);
  } catch {
    return null;
  }
  const gateIds = new Set(["G_LOCATION", "G_CONTACT", "G_RESOURCE", "G_CONFLICT", "G_DISPATCH"]);
  const safetyGates = Array.isArray(incident.safetyGates)
    ? incident.safetyGates
      .filter(gate => isPlainObject(gate) && gateIds.has(gate.id))
      .map(gate => ({
        id: gate.id,
        status: safeString(gate.status, 24),
        passed: gate.passed === true
      }))
    : [];
  const safeTrace = trace => ({
    model: safeString(trace?.model, 160),
    responseId: safeString(trace?.responseId, 160)
  });
  return {
    caseId,
    label: safeString(incident.label, 16),
    title: safeString(incident.title, 160),
    operationalState: safeString(incident.operationalState, 48),
    location: safeString(incident.location, 240),
    peopleCount: safeNumber(incident.peopleCount),
    needs: safeStringArray(incident.needs, { maxItems: 12, maxLength: 120 }),
    riskFlags: safeStringArray(incident.riskFlags),
    knownFacts: safeStringArray(incident.knownFacts),
    unknownFacts: safeStringArray(incident.unknownFacts),
    inputClassification: safeInputClassification(incident.inputClassification),
    safeNextActions: safeStringArray(incident.safeNextActions, { maxItems: 10 }),
    recommendedAction: safeString(incident.recommendedAction, 500),
    scores: {
      verification: safeNumber(incident.scores?.verification),
      urgency: safeNumber(incident.scores?.urgency),
      actionability: safeNumber(incident.scores?.actionability)
    },
    consensus: safeString(incident.modelDebate?.consensus, 48),
    scoreGaps: {
      verification: safeNumber(incident.modelDebate?.scoreGaps?.verification),
      urgency: safeNumber(incident.modelDebate?.scoreGaps?.urgency),
      actionability: safeNumber(incident.modelDebate?.scoreGaps?.actionability)
    },
    safetyGates,
    qualityWarnings: Array.isArray(incident.qualityWarnings)
      ? incident.qualityWarnings.filter(item => typeof item === "string").slice(0, 8).map(item => item.slice(0, 80))
      : [],
    analysisTimestamp: safeString(incident.receivedAt, 64),
    analysisReference: {
      analyst: safeTrace(incident.gonka?.analyst),
      reviewer: safeTrace(incident.gonka?.reviewer)
    }
  };
}

function verifyAuditChain(entries) {
  if (!Array.isArray(entries)) return false;
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isPlainObject(entry) ||
        entry.sequence !== index + 1 ||
        entry.previousHash !== previousHash ||
        typeof entry.entryHash !== "string" ||
        entry.entryHash !== hashEntry(entry)) {
      return false;
    }
    previousHash = entry.entryHash;
  }
  return true;
}

function createDecisionLedger({
  clock = () => new Date(),
  idGenerator = () => `DEC-${crypto.randomUUID()}`
} = {}) {
  const contexts = new Map();
  const chains = new Map();
  const idempotency = new Map();

  function registerAnalysisResult(result) {
    const incidents = Array.isArray(result?.incidents) ? result.incidents : [];
    let registered = 0;
    for (const incident of incidents) {
      const snapshot = buildAnalysisSnapshot(incident);
      if (!snapshot) continue;
      contexts.set(snapshot.caseId, {
        snapshot: clone(snapshot),
        analysisSnapshotHash: sha256(canonicalJson(snapshot))
      });
      if (!chains.has(snapshot.caseId)) chains.set(snapshot.caseId, []);
      registered += 1;
    }
    return registered;
  }

  function getContext(caseId) {
    const validCaseId = validateCaseId(caseId);
    const context = contexts.get(validCaseId);
    if (!context) throw new DecisionLedgerError("ANALYSIS_CONTEXT_NOT_FOUND");
    return clone(context);
  }

  function validatePolicy(context, request) {
    const allowed = STATE_POLICY[context.snapshot.operationalState] || [];
    if (!allowed.includes(request.action)) throw new DecisionLedgerError("DECISION_NOT_ALLOWED");

    const conflictGate = context.snapshot.safetyGates.find(gate => gate.id === "G_CONFLICT");
    const conflictReview = conflictGate?.status === "review";
    if ((request.action === "APPROVE_ACTION" || request.action === "REJECT_ACTION" || conflictReview) &&
        request.reason.length < 8) {
      throw new DecisionLedgerError("INVALID_DECISION_REQUEST");
    }
    if (conflictReview && request.acknowledgeReview !== true) {
      throw new DecisionLedgerError("ACKNOWLEDGEMENT_REQUIRED");
    }

    if (request.action === "APPROVE_ACTION") {
      if (context.snapshot.consensus === "CRITICAL_CONFLICT") {
        throw new DecisionLedgerError("DECISION_NOT_ALLOWED");
      }
      for (const gateId of ["G_LOCATION", "G_CONTACT", "G_RESOURCE"]) {
        if (context.snapshot.safetyGates.find(gate => gate.id === gateId)?.passed !== true) {
          throw new DecisionLedgerError("DECISION_NOT_ALLOWED");
        }
      }
      if (request.acknowledgeHumanDecision !== true ||
          request.acknowledgeNoAutomaticExecution !== true) {
        throw new DecisionLedgerError("ACKNOWLEDGEMENT_REQUIRED");
      }
    }
  }

  function recordDecision({ caseId, payload, idempotencyKey } = {}) {
    const validCaseId = validateCaseId(caseId);
    const context = getContext(validCaseId);
    if (!isPlainObject(payload)) throw new DecisionLedgerError("INVALID_DECISION_REQUEST");
    const request = {
      action: normalizeAction(payload.action !== undefined ? payload.action : payload.decision),
      reason: normalizeReason(payload),
      acknowledgeHumanDecision: payload.acknowledgeHumanDecision === true,
      acknowledgeNoAutomaticExecution: payload.acknowledgeNoAutomaticExecution === true,
      acknowledgeReview: payload.acknowledgeReview === true
    };
    const key = normalizeIdempotencyKey(idempotencyKey);
    const fingerprint = sha256(canonicalJson({ caseId: validCaseId, ...request }));

    if (key && idempotency.has(key)) {
      const prior = idempotency.get(key);
      if (prior.fingerprint !== fingerprint) throw new DecisionLedgerError("IDEMPOTENCY_CONFLICT");
      return { ...clone(prior.response), replayed: true };
    }

    validatePolicy(context, request);
    const chain = chains.get(validCaseId) || [];
    const recordedAt = new Date(clock()).toISOString();
    const recommended = RECOMMENDED_ACTION[context.snapshot.operationalState] || null;
    const entry = {
      sequence: chain.length + 1,
      decisionId: String(idGenerator()),
      caseId: validCaseId,
      action: request.action,
      reason: request.reason,
      actorType: "human_operator",
      authentication: "demo_local_only",
      recordedAt,
      aiRecommendation: context.snapshot.operationalState,
      override: recommended !== request.action,
      recordStatus: "RECORDED",
      executionStatus: "NOT_EXECUTED",
      requiresExternalExecution: EXTERNAL_EXECUTION_ACTIONS.has(request.action),
      humanDecisionAcknowledged: request.acknowledgeHumanDecision,
      noAutomaticExecutionAcknowledged: request.acknowledgeNoAutomaticExecution,
      reviewAcknowledged: request.acknowledgeReview,
      analysisSnapshotHash: context.analysisSnapshotHash,
      previousHash: chain.length ? chain[chain.length - 1].entryHash : GENESIS_HASH
    };
    entry.entryHash = hashEntry(entry);
    chain.push(Object.freeze({ ...entry }));
    chains.set(validCaseId, chain);

    const response = {
      ok: true,
      replayed: false,
      decision: clone(entry),
      audit: {
        sequence: entry.sequence,
        chainValid: verifyAuditChain(chain),
        persistence: "ephemeral",
        externalAnchoring: "none",
        chainScope: "per_case"
      }
    };
    if (key) idempotency.set(key, { fingerprint, response: clone(response) });
    return response;
  }

  function getAudit(caseId) {
    const validCaseId = validateCaseId(caseId);
    if (!contexts.has(validCaseId)) throw new DecisionLedgerError("ANALYSIS_CONTEXT_NOT_FOUND");
    const entries = chains.get(validCaseId) || [];
    return {
      ok: true,
      caseId: validCaseId,
      entryCount: entries.length,
      entries: clone(entries),
      chainValid: verifyAuditChain(entries),
      persistence: "ephemeral",
      externalAnchoring: "none",
      chainScope: "per_case"
    };
  }

  return Object.freeze({
    registerAnalysisResult,
    recordDecision,
    getAudit,
    getContext,
    getContextCount: () => contexts.size,
    verifyChain: caseId => verifyAuditChain(getAudit(caseId).entries)
  });
}

module.exports = {
  CASE_ID_PATTERN,
  CANONICAL_ACTIONS,
  ACTION_ALIASES,
  STATE_POLICY,
  RECOMMENDED_ACTION,
  DecisionLedgerError,
  canonicalJson,
  sha256,
  hashEntry,
  verifyAuditChain,
  validateCaseId,
  normalizeAction,
  createDecisionLedger
};
