export const CANONICAL_ACTIONS = Object.freeze([
  "APPROVE_ACTION",
  "REQUEST_VERIFICATION",
  "MERGE_REPORT",
  "HOLD_FOR_REVIEW",
  "QUEUE_ACTION",
  "REJECT_ACTION"
]);

export const ACTIONS_BY_STATE = Object.freeze({
  DISPATCH_CANDIDATE: Object.freeze([
    "APPROVE_ACTION", "REQUEST_VERIFICATION", "HOLD_FOR_REVIEW", "REJECT_ACTION"
  ]),
  URGENT_VERIFICATION: Object.freeze([
    "REQUEST_VERIFICATION", "HOLD_FOR_REVIEW", "REJECT_ACTION"
  ]),
  MERGE_OR_VERIFY: Object.freeze([
    "MERGE_REPORT", "REQUEST_VERIFICATION", "HOLD_FOR_REVIEW", "REJECT_ACTION"
  ]),
  NEEDS_HUMAN_REVIEW: Object.freeze([
    "HOLD_FOR_REVIEW", "REQUEST_VERIFICATION", "REJECT_ACTION"
  ]),
  QUEUED_ACTION: Object.freeze([
    "QUEUE_ACTION", "HOLD_FOR_REVIEW", "REJECT_ACTION"
  ])
});

const UNKNOWN_STATE_ACTIONS = Object.freeze(["HOLD_FOR_REVIEW", "REJECT_ACTION"]);

export function actionsForState(operationalState) {
  return [...(ACTIONS_BY_STATE[operationalState] || UNKNOWN_STATE_ACTIONS)];
}

export function conflictReviewRequired(incident) {
  return incident?.safetyGates?.some(gate => gate.id === "G_CONFLICT" && gate.status === "review") === true;
}

// Presentation only: never changes gates, consensus or the human-action policy.
export function dispatchPresentation(incident) {
  const gates = Array.isArray(incident?.safetyGates) ? incident.safetyGates : [];
  const prerequisites = gates.filter(gate => gate && gate.id !== "G_DISPATCH");
  const blockedCount = prerequisites.filter(gate => ["blocked", "locked"].includes(gate.status)).length;
  const reviewCount = prerequisites.filter(gate => gate.status === "review").length;
  const dispatchStatus = gates.find(gate => gate?.id === "G_DISPATCH")?.status;
  const requiredGatesPassed = ["G_LOCATION", "G_CONTACT", "G_RESOURCE"].every(id =>
    gates.some(gate => gate?.id === id && gate.status === "passed" && gate.passed === true)
  );
  const conflict = gates.find(gate => gate?.id === "G_CONFLICT");
  const consensus = incident?.modelDebate?.consensus;
  let status = "locked";
  if (["passed", "review"].includes(dispatchStatus) && blockedCount === 0 &&
      requiredGatesPassed && incident?.operationalState === "DISPATCH_CANDIDATE" &&
      ["AGREEMENT", "DISAGREEMENT"].includes(consensus) &&
      ["passed", "review"].includes(conflict?.status)) {
    if (dispatchStatus === "review" || reviewCount > 0 || consensus === "DISAGREEMENT") {
      status = "review";
    } else if (conflict.passed === true) {
      status = "passed";
    }
  }
  const copy = {
    passed: {
      label: "DISPATCH AVAILABLE",
      panelTitle: "Volunteer Dispatch — Available",
      requirement: "after explicit human approval",
      detail: "Safety gates have passed. Dispatch is available after explicit human approval. Nothing has been dispatched.",
      auditSafety: "Available after explicit human approval"
    },
    review: {
      label: "DISPATCH REVIEW REQUIRED",
      panelTitle: "Volunteer Dispatch — Human Review Required",
      requirement: "explicit human review and acknowledgement required",
      detail: "Model disagreement requires explicit human review and acknowledgement. Nothing has been dispatched.",
      auditSafety: "Human review required"
    },
    locked: {
      label: "DISPATCH LOCKED",
      panelTitle: "Volunteer Dispatch — Locked",
      requirement: "required gates or dispatch eligibility not confirmed",
      detail: "Required gates or dispatch eligibility have not been confirmed. Verify location, contact, resources and model conflict before approval. Nothing has been dispatched.",
      auditSafety: "Dispatch locked — required gates or eligibility not confirmed"
    }
  }[status];
  return {
    status,
    ...copy,
    blockedCount,
    reviewCount,
    prerequisiteCount: prerequisites.length,
    countText: `${blockedCount} prerequisite ${blockedCount === 1 ? "gate" : "gates"} blocked; ${reviewCount} prerequisite ${reviewCount === 1 ? "gate requires" : "gates require"} review.`,
    auditAction: incident?.humanDecision?.decision || incident?.humanDecision?.action
      ? "Recorded — not executed" : "Pending"
  };
}

export function acknowledgementRequirements(incident, action) {
  return {
    acknowledgeHumanDecision: action === "APPROVE_ACTION",
    acknowledgeNoAutomaticExecution: action === "APPROVE_ACTION",
    acknowledgeReview: conflictReviewRequired(incident)
  };
}

export function createDecisionForm(incident) {
  return {
    caseId: incident?.caseId || null,
    action: actionsForState(incident?.operationalState)[0],
    reason: "",
    acknowledgeHumanDecision: false,
    acknowledgeNoAutomaticExecution: false,
    acknowledgeReview: false,
    errors: []
  };
}

export function normalizeReason(reason) {
  if (typeof reason !== "string" || reason.includes("\0")) return null;
  const normalized = reason.trim();
  return normalized.length <= 500 ? normalized : null;
}

export function approvePrecheck(incident) {
  const failures = [];
  for (const [gateId, label] of [
    ["G_LOCATION", "Location gate must pass"],
    ["G_CONTACT", "Contact gate must pass"],
    ["G_RESOURCE", "Resource gate must pass"]
  ]) {
    const gate = incident?.safetyGates?.find(item => item.id === gateId);
    if (gate?.passed !== true) failures.push(label);
  }
  if (incident?.modelDebate?.consensus === "CRITICAL_CONFLICT") {
    failures.push("Critical model conflict blocks approval");
  }
  return failures;
}

export function validateDecisionForm(incident, form) {
  const errors = [];
  const allowed = actionsForState(incident?.operationalState);
  if (!allowed.includes(form?.action)) errors.push("Select an action allowed for this operational state.");
  const reason = normalizeReason(form?.reason);
  if (reason === null) errors.push("Reason must be text of at most 500 characters with no null byte.");
  const requiresReason = form?.action === "APPROVE_ACTION" ||
    form?.action === "REJECT_ACTION" || conflictReviewRequired(incident);
  if (requiresReason && (reason === null || reason.length < 8)) {
    errors.push("This action requires a human reason of at least 8 characters.");
  }
  const requirements = acknowledgementRequirements(incident, form?.action);
  for (const [field, required, message] of [
    ["acknowledgeHumanDecision", requirements.acknowledgeHumanDecision, "Confirm this is a human decision."],
    ["acknowledgeNoAutomaticExecution", requirements.acknowledgeNoAutomaticExecution, "Confirm the software does not execute real-world action."],
    ["acknowledgeReview", requirements.acknowledgeReview, "Confirm the model disagreement was reviewed."]
  ]) {
    if (required && form?.[field] !== true) errors.push(message);
  }
  if (form?.action === "APPROVE_ACTION") errors.push(...approvePrecheck(incident));
  return {
    valid: errors.length === 0,
    errors,
    normalized: {
      action: form?.action,
      reason: reason || "",
      acknowledgeHumanDecision: form?.acknowledgeHumanDecision === true,
      acknowledgeNoAutomaticExecution: form?.acknowledgeNoAutomaticExecution === true,
      acknowledgeReview: form?.acknowledgeReview === true
    }
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableHash(input) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function submissionFingerprint(caseId, normalizedSubmission) {
  return stableHash(canonicalJson({ caseId, ...normalizedSubmission }));
}

function defaultKeyFactory() {
  const randomPart = globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `ui-decision-${randomPart}`.slice(0, 128);
}

export function resolveSubmissionIdentity({ caseId, normalizedSubmission, previous, keyFactory = defaultKeyFactory }) {
  const fingerprint = submissionFingerprint(caseId, normalizedSubmission);
  if (previous?.fingerprint === fingerprint && previous?.caseId === caseId) return previous;
  return {
    caseId,
    fingerprint,
    idempotencyKey: String(keyFactory()).slice(0, 128)
  };
}

export function createWorkflowState(incident, mode = "mock") {
  return {
    caseId: incident?.caseId || null,
    mode,
    phase: "idle",
    form: createDecisionForm(incident),
    submissionIdentity: null,
    decision: null,
    brief: null,
    proofCapsule: null,
    audit: null,
    decisionStatus: "PENDING",
    briefStatus: "LOCKED",
    auditStatus: "LOCKED",
    proofStatus: mode === "live" ? "UNVERIFIED" : "UNAVAILABLE",
    canRetryBrief: false,
    error: null
  };
}

export function beginDecisionSubmission(workflow, incident, { keyFactory } = {}) {
  if (workflow.phase === "decision_loading" || workflow.phase === "brief_loading") {
    return { ...workflow, error: "A submission is already in progress." };
  }
  const validation = validateDecisionForm(incident, workflow.form);
  if (!validation.valid) {
    return {
      ...workflow,
      phase: "validation_error",
      form: { ...workflow.form, errors: validation.errors },
      error: "Review the required human decision fields."
    };
  }
  const submissionIdentity = resolveSubmissionIdentity({
    caseId: incident.caseId,
    normalizedSubmission: validation.normalized,
    previous: workflow.submissionIdentity,
    keyFactory
  });
  return {
    ...workflow,
    phase: "decision_loading",
    form: { ...workflow.form, ...validation.normalized, errors: [] },
    submissionIdentity,
    decisionStatus: "SUBMITTING",
    error: null
  };
}

export function applyDecisionSuccess(workflow, response, currentCaseId) {
  if (workflow.caseId !== currentCaseId || response?.decision?.caseId !== workflow.caseId) return workflow;
  return {
    ...workflow,
    phase: "brief_loading",
    decision: response.decision,
    decisionStatus: "RECORDED",
    briefStatus: "GENERATING",
    auditStatus: "LOADING",
    canRetryBrief: false,
    error: null
  };
}

export function applyDecisionFailure(workflow, error, currentCaseId) {
  if (workflow.caseId !== currentCaseId) return workflow;
  return {
    ...workflow,
    phase: "error",
    decisionStatus: "FAILED",
    error: error?.message || "Decision request failed."
  };
}

export function applyBriefSuccess(workflow, response, currentCaseId) {
  if (workflow.caseId !== currentCaseId) return workflow;
  return {
    ...workflow,
    phase: "audit_loading",
    brief: response.brief,
    proofCapsule: response.proofCapsule,
    briefStatus: "READY",
    proofStatus: workflow.mode === "live" ? "UNVERIFIED" : "UNAVAILABLE",
    canRetryBrief: false,
    error: null
  };
}

export function applyBriefFailure(workflow, error, currentCaseId) {
  if (workflow.caseId !== currentCaseId) return workflow;
  return {
    ...workflow,
    phase: "partial_success",
    decisionStatus: "RECORDED",
    briefStatus: "UNAVAILABLE",
    canRetryBrief: true,
    error: error?.message || "Brief is temporarily unavailable."
  };
}

export function beginBriefRetry(workflow) {
  if (!workflow.decision || workflow.briefStatus !== "UNAVAILABLE") return workflow;
  return {
    ...workflow,
    phase: "brief_loading",
    briefStatus: "GENERATING",
    canRetryBrief: false,
    error: null
  };
}

export function applyAuditResult(workflow, audit, currentCaseId) {
  if (workflow.caseId !== currentCaseId) return workflow;
  return {
    ...workflow,
    phase: workflow.briefStatus === "READY" ? "complete" : workflow.phase,
    audit,
    auditStatus: audit?.chainValid === true ? "VALID" : "INVALID"
  };
}

export function applyProofVerification(workflow, verification) {
  if (workflow.mode !== "live" || !workflow.proofCapsule) {
    return { ...workflow, proofStatus: "UNAVAILABLE" };
  }
  return {
    ...workflow,
    proofStatus: verification?.valid === true ? "VALID" : "INVALID"
  };
}

export function displayRules(workflow) {
  const liveProof = workflow.mode === "live" && workflow.brief && workflow.proofCapsule;
  return {
    briefVisible: Boolean(workflow.brief && workflow.decision),
    proofVisible: Boolean(workflow.brief && workflow.proofCapsule),
    auditVisible: Boolean(workflow.audit && workflow.decision),
    proofVerificationEnabled: Boolean(liveProof),
    proofStatus: liveProof ? workflow.proofStatus : "UNAVAILABLE"
  };
}

export function liveReadiness(health) {
  const capabilities = health?.capabilities || {};
  const checks = {
    health: health?.ok === true,
    liveRoutes: health?.liveRoutesReady === true,
    fullScenario: capabilities.fullScenario === true,
    decision: capabilities.decision === true,
    brief: capabilities.brief === true
  };
  return {
    ready: Object.values(checks).every(Boolean),
    missing: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  };
}

export function safeReceiptExport({ mode, caseId, brief, proofCapsule, audit }) {
  if (mode !== "live" || !brief || !proofCapsule || !audit) return null;
  return {
    exportVersion: "1.0",
    caseId,
    brief: structuredClone(brief),
    proofCapsule: structuredClone(proofCapsule),
    audit: {
      caseId: audit.caseId,
      entryCount: audit.entryCount,
      entries: structuredClone(audit.entries || []),
      chainValid: audit.chainValid,
      persistence: audit.persistence,
      externalAnchoring: audit.externalAnchoring,
      chainScope: audit.chainScope
    }
  };
}
