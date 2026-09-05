export const MODE_PROVENANCE = Object.freeze({
  live: Object.freeze({
    mode: "LIVE",
    title: "Live Gonka analysis",
    lines: Object.freeze(["Two live Gonka model requests", "Human decision recorded; real-world execution remains external"]),
    live: true,
    proofEligible: true
  }),
  replay: Object.freeze({
    mode: "REPLAY",
    title: "Sanitized recorded acceptance replay",
    lines: Object.freeze(["No network request in this load", "Response IDs redacted", "Not current live inference"]),
    live: false,
    proofEligible: false
  }),
  mock: Object.freeze({
    mode: "DEMO",
    title: "Synthetic local demonstration data",
    lines: Object.freeze(["Not a model result", "No server-issued Proof"]),
    live: false,
    proofEligible: false
  })
});

export const SAFE_FAILURE_CODES = Object.freeze([
  "NETWORK_ERROR",
  "TIMEOUT",
  "HTTP_ERROR",
  "INVALID_MODEL_DATA",
  "RESPONSE_TOO_LARGE",
  "UPSTREAM_ERROR",
  "INVALID_SCENARIO_INPUT",
  "CLIENT_WAIT_CANCELLED",
  "UNKNOWN_SAFE_ERROR"
]);

const RETRYABLE_CODES = new Set(["NETWORK_ERROR", "TIMEOUT", "HTTP_ERROR", "UPSTREAM_ERROR", "CLIENT_WAIT_CANCELLED"]);
const SAFE_ROLES = new Set(["analyst", "reviewer", "both", "not_available"]);
const SAFE_ROLE_ERROR_CODES = new Set([
  "NETWORK_ERROR", "TIMEOUT", "HTTP_ERROR", "INVALID_MODEL_DATA", "RESPONSE_TOO_LARGE", "UPSTREAM_ERROR"
]);

const FAILURE_COPY = Object.freeze({
  NETWORK_ERROR: "The local server could not complete the live network request.",
  TIMEOUT: "A model role did not complete within the configured server time limit.",
  HTTP_ERROR: "The live request returned a safe HTTP error.",
  INVALID_MODEL_DATA: "A model response did not satisfy the required safe data contract.",
  RESPONSE_TOO_LARGE: "A response exceeded the configured safe size limit.",
  UPSTREAM_ERROR: "The upstream model service returned a safe classified error.",
  INVALID_SCENARIO_INPUT: "The five fixed scenario reports did not match the required input contract.",
  CLIENT_WAIT_CANCELLED: "This browser stopped waiting; server or remote model cancellation is not confirmed.",
  UNKNOWN_SAFE_ERROR: "The live attempt failed without exposing internal details."
});

export const ANALYZE_PROGRESS_STAGES = Object.freeze([
  "Submitting five fixed reports",
  "Analyst and Blind Reviewer are evaluated independently",
  "Waiting for the slower model — this may take up to 60 seconds",
  "Validating incident and safety contracts"
]);

export const JUDGE_WALKTHROUGH_STEPS = Object.freeze([
  "Analyze five haze reports",
  "Inspect independent Analyst and Blind Reviewer scores",
  "Record an explicit Human Decision",
  "Generate Brief and verify the local Proof Capsule"
]);

export const RESET_SCOPE_COPY = "This resets the browser view only. Restart the local server to clear ephemeral Decision and Audit records.";
export const CANCEL_SCOPE_COPY = "Cancel UI Wait stops this browser from waiting. It does not prove the server or remote model computation was cancelled.";

export function modeProvenance(mode) {
  const source = MODE_PROVENANCE[mode] || MODE_PROVENANCE.mock;
  return { ...source, lines: [...source.lines] };
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
    missing: Object.entries(checks).filter(([, value]) => !value).map(([name]) => name)
  };
}

function safeRoleErrors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output = {};
  for (const role of ["analyst", "reviewer"]) {
    if (SAFE_ROLE_ERROR_CODES.has(value[role])) output[role] = value[role];
  }
  return Object.keys(output).length ? output : undefined;
}

export function classifyFailure(error) {
  const requestedCode = typeof error?.code === "string" ? error.code : "UNKNOWN_SAFE_ERROR";
  const code = SAFE_FAILURE_CODES.includes(requestedCode) ? requestedCode : "UNKNOWN_SAFE_ERROR";
  const status = Number.isInteger(error?.status) && error.status >= 0 && error.status <= 599 ? error.status : 0;
  const failedRole = SAFE_ROLES.has(error?.failedRole) ? error.failedRole : "not_available";
  const roleErrors = safeRoleErrors(error?.roleErrors);
  const retryable = error?.retryable === true && RETRYABLE_CODES.has(code);
  return {
    status,
    code,
    message: code === requestedCode && typeof error?.message === "string" && error.message.trim()
      ? error.message.trim().slice(0, 300)
      : FAILURE_COPY[code],
    retryable,
    failedRole,
    ...(roleErrors ? { roleErrors } : {})
  };
}

export function manualRetryEligibility(failure) {
  const safe = classifyFailure(failure);
  return {
    allowed: safe.retryable,
    automaticRetryAllowed: false,
    label: safe.retryable ? "Retry Live" : "Manual retry unavailable for this error"
  };
}

export function manualReplayFallbackEligibility(failure) {
  return {
    allowed: Boolean(failure),
    automaticFallbackAllowed: false,
    label: "Open Sanitized Replay"
  };
}

export function safeFailurePresentation(error) {
  const failure = classifyFailure(error);
  const retry = manualRetryEligibility(failure);
  const replay = manualReplayFallbackEligibility(failure);
  return {
    ...failure,
    retry,
    replay,
    headline: `LIVE attempt failed — ${failure.code}`,
    roleLine: failure.failedRole === "not_available" ? "Failed role: not available" : `Failed role: ${failure.failedRole}`,
    retryLine: retry.allowed ? "Manual Retry available; no automatic retry was performed." : "No automatic retry was performed."
  };
}

export function analyzeProgress(elapsedMs = 0, { cancelSupported = false } = {}) {
  const safeElapsedMs = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const stageIndex = safeElapsedMs >= 50_000 ? 3 : safeElapsedMs >= 20_000 ? 2 : safeElapsedMs >= 5_000 ? 1 : 0;
  return {
    elapsedMs: safeElapsedMs,
    elapsedSeconds: Math.floor(safeElapsedMs / 1_000),
    stageIndex,
    stage: ANALYZE_PROGRESS_STAGES[stageIndex],
    stages: [...ANALYZE_PROGRESS_STAGES],
    processOnly: true,
    noAutomaticRetry: true,
    blindReviewStatement: "Blind Reviewer does not receive the Analyst output.",
    cancelSupported,
    cancelScope: CANCEL_SCOPE_COPY
  };
}

export function judgeWalkthroughState({ incidentCount = 0, independentScoresVisible = false, decisionRecorded = false, briefReady = false, proofChecked = false } = {}) {
  const completed = [
    incidentCount === 5,
    incidentCount === 5 && independentScoresVisible === true,
    decisionRecorded === true,
    briefReady === true && proofChecked === true
  ];
  return JUDGE_WALKTHROUGH_STEPS.map((label, index) => ({ number: index + 1, label, completed: completed[index] }));
}

export function replayTraceLabels(meta = {}) {
  const valid = meta.fixtureKind === "sanitized_acceptance_replay" &&
    meta.sanitized === true && meta.networkRequestsThisLoad === 0 &&
    meta.responseIdsRedacted === true && meta.proofAvailable === false;
  return {
    valid,
    mode: "REPLAY",
    source: valid ? "Sanitized acceptance replay" : "Replay provenance unavailable",
    network: valid ? "Network requests: 0" : "Network request provenance unavailable",
    responseIds: valid ? "Response IDs: Redacted" : "Response ID provenance unavailable",
    currentInference: false
  };
}

export function proofAvailability(mode, proofCapsule) {
  const available = mode === "live" && Boolean(proofCapsule);
  return {
    available,
    verificationEnabled: available,
    status: available ? "UNVERIFIED" : "UNAVAILABLE",
    reason: available ? "Server-issued live capsule available." : "No server-issued Proof is available in this mode."
  };
}

export function createReliabilityState(mode = "mock") {
  return {
    mode,
    phase: "idle",
    activeRequestId: null,
    lastLiveMessages: [],
    lastFailure: null,
    automaticRetryCount: 0,
    automaticReplayFallbackCount: 0,
    cancelledUiWait: false
  };
}

export function beginLiveAttempt(state, { requestId, messages }) {
  return {
    ...state,
    phase: "live_wait",
    activeRequestId: requestId,
    lastLiveMessages: Array.isArray(messages) ? [...messages] : [],
    lastFailure: null,
    cancelledUiWait: false
  };
}

export function failLiveAttempt(state, error, requestId) {
  if (state.activeRequestId !== requestId) return state;
  return {
    ...state,
    phase: "live_failed",
    activeRequestId: null,
    lastFailure: safeFailurePresentation(error),
    cancelledUiWait: error?.code === "CLIENT_WAIT_CANCELLED"
  };
}

export function completeLiveAttempt(state, requestId) {
  if (state.activeRequestId !== requestId) return state;
  return {
    ...state,
    mode: "live",
    phase: "live_complete",
    activeRequestId: null,
    lastFailure: null,
    cancelledUiWait: false
  };
}

export function openSanitizedReplay(state) {
  return {
    ...state,
    mode: "replay",
    phase: "replay_open",
    activeRequestId: null,
    lastFailure: null,
    cancelledUiWait: false
  };
}

export function shouldApplyLiveResult({ requestId, activeRequestId, requestedCaseSet, activeCaseSet }) {
  return requestId === activeRequestId && requestedCaseSet === activeCaseSet;
}
