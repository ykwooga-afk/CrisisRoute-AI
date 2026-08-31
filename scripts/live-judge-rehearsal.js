const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { CANONICAL_HAZE_MESSAGES } = require("../backend/hazeScenario");
const { createGonkaClientFromEnv } = require("../backend/gonkaClient");
const { createServer } = require("../server");
const { evaluateFullScenarioAcceptance } = require("./full-scenario-live-smoke");

const HOST = "127.0.0.1";
const projectRoot = path.resolve(__dirname, "..");
const PHASES = Object.freeze([
  "PREFLIGHT", "SERVER_START", "HEALTH", "ANALYZE", "QUALITY", "DECISION",
  "BRIEF", "AUDIT", "PROOF_VALID", "PROOF_TAMPER", "CLEANUP", "COMPLETE"
]);
const OPERATION_KEYS = Object.freeze(["health", "analyze", "decision", "brief", "audit", "proof"]);
const LOCAL_STATUS_VALUES = new Set(["not_attempted", "started", "network_error", "local_error"]);
const SAFE_FAILED_ROLES = new Set(["analyst", "reviewer", "both"]);
const SAFE_ROLE_ERROR_CODES = new Set([
  "NETWORK_ERROR", "TIMEOUT", "HTTP_ERROR", "INVALID_MODEL_DATA", "RESPONSE_TOO_LARGE"
]);
const SAFE_ERROR_CODES = new Set([
  ...SAFE_ROLE_ERROR_CODES,
  "UPSTREAM_ERROR", "INVALID_SCENARIO_INPUT", "CONFIGURATION_ERROR", "INVALID_RESPONSE",
  "LIVE_QUALITY_FAILURE", "LIVE_CONTRACT_FAILURE", "LOCAL_REHEARSAL_ERROR", "UNKNOWN_SAFE_ERROR"
]);
const UNSAFE_MESSAGE_PATTERN = /sk-|authorization|bearer|credential|stack|cause|raw|prompt|private|https?:\/\//i;
const LOCAL_ERROR_MESSAGE = "The local rehearsal control flow failed safely.";

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`;
}

async function importClient() {
  let source = fs.readFileSync(path.join(projectRoot, "src/services/crisisRouteClient.js"), "utf8");
  source = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];\s*/g, "");
  return import(dataModule(source));
}

function createInitialRunState({ startedAt = Date.now() } = {}) {
  return {
    phase: "PREFLIGHT",
    phaseLedger: ["PREFLIGHT"],
    failedPhase: null,
    statuses: Object.fromEntries(OPERATION_KEYS.map(key => [key, "not_attempted"])),
    durations: Object.fromEntries(OPERATION_KEYS.map(key => [key, null])),
    requestCounts: {
      analyzeSubmissions: 0,
      inferenceAttempts: 0,
      modelsRequests: 0,
      automaticRetries: 0,
      manualReruns: 0,
      loopbackExternalRequests: 0,
      clientFactoryCalls: 0
    },
    safeFailure: null,
    startedAt,
    serverHandle: null,
    port: null,
    cleanup: {
      closeSucceeded: null,
      randomPortListenerRemaining: null,
      fixedPortListenerRemaining: null,
      backgroundProjectProcessRemaining: false,
      issues: []
    },
    healthPassed: false,
    qualityPassed: false,
    workCompleted: false,
    summary: null,
    outcome: "B11-R2 BLOCKED — LOCAL REHEARSAL ERROR"
  };
}

function updatePhaseStatus(state, phase, operation, status) {
  if (PHASES.includes(phase)) {
    state.phase = phase;
    if (state.phaseLedger[state.phaseLedger.length - 1] !== phase) state.phaseLedger.push(phase);
  }
  if (OPERATION_KEYS.includes(operation)) {
    const validStatus = LOCAL_STATUS_VALUES.has(status) || (Number.isInteger(status) && status >= 100 && status <= 599);
    state.statuses[operation] = validStatus ? status : "local_error";
  }
  return state;
}

function toSafeFailureSummary(source, { phase = "PREFLIGHT", httpStatus } = {}) {
  const candidate = source?.error && typeof source.error === "object" && !Array.isArray(source.error)
    ? source.error
    : source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const code = SAFE_ERROR_CODES.has(candidate.code) ? candidate.code : "UNKNOWN_SAFE_ERROR";
  const failedRole = SAFE_FAILED_ROLES.has(candidate.failedRole) ? candidate.failedRole : "not_applicable";
  const roleErrors = {};
  if (candidate.roleErrors && typeof candidate.roleErrors === "object" && !Array.isArray(candidate.roleErrors)) {
    for (const role of ["analyst", "reviewer"]) {
      if (SAFE_ROLE_ERROR_CODES.has(candidate.roleErrors[role])) roleErrors[role] = candidate.roleErrors[role];
    }
  }
  const issueSource = [candidate.validationIssuePaths, candidate.issuePaths, candidate.issues]
    .find(value => Array.isArray(value)) || [];
  const validationIssuePaths = issueSource
    .filter(value => typeof value === "string" && value.length <= 120 && /^[A-Za-z0-9_.]+:[a-z_]+$/.test(value))
    .slice(0, 5);
  const message = typeof candidate.message === "string" && candidate.message.length <= 300 && !UNSAFE_MESSAGE_PATTERN.test(candidate.message)
    ? candidate.message
    : candidate.code === "LOCAL_REHEARSAL_ERROR" ? LOCAL_ERROR_MESSAGE : "The live rehearsal failed safely.";
  const candidateStatus = httpStatus ?? candidate.httpStatus ?? candidate.status;
  return {
    phase: PHASES.includes(phase) ? phase : "PREFLIGHT",
    httpStatus: Number.isInteger(candidateStatus) && candidateStatus >= 100 && candidateStatus <= 599
      ? candidateStatus
      : "not_available",
    code,
    message,
    retryable: candidate.retryable === true,
    failedRole,
    roleErrors,
    validationIssuePaths
  };
}

function localFailure(phase, httpStatus) {
  return toSafeFailureSummary({ code: "LOCAL_REHEARSAL_ERROR", message: LOCAL_ERROR_MESSAGE }, {
    phase,
    httpStatus
  });
}

function formatSafeFailureSummary(failure) {
  const safe = toSafeFailureSummary(failure, { phase: failure?.phase, httpStatus: failure?.httpStatus });
  const roleErrors = Object.entries(safe.roleErrors).map(([role, code]) => `${role}=${code}`).join(", ") || "None";
  const validationIssuePaths = safe.validationIssuePaths.join(", ") || "None";
  return [
    `Failed Phase: ${safe.phase}`,
    `HTTP Status: ${safe.httpStatus}`,
    `Safe Error Code: ${safe.code}`,
    `Safe Error Message: ${safe.message}`,
    `Retryable: ${safe.retryable ? "Yes" : "No"}`,
    `Failed Role: ${safe.failedRole}`,
    `Role Errors: ${roleErrors}`,
    `Validation Issue Paths: ${validationIssuePaths}`
  ];
}

function operationForPath(pathname) {
  if (pathname === "/api/health/gonka") return "health";
  if (pathname === "/api/incidents/analyze") return "analyze";
  if (/^\/api\/incidents\/[^/]+\/decision$/.test(pathname)) return "decision";
  if (/^\/api\/incidents\/[^/]+\/brief$/.test(pathname)) return "brief";
  if (/^\/api\/incidents\/[^/]+\/audit$/.test(pathname)) return "audit";
  if (pathname === "/api/proof/verify") return "proof";
  return null;
}

async function captureResponseFailure(response, phase) {
  try {
    const safeText = await response.clone().text();
    if (safeText.length > 200_000) throw new Error("oversized");
    return toSafeFailureSummary(JSON.parse(safeText), { phase, httpStatus: response.status });
  } catch {
    return toSafeFailureSummary({
      code: "INVALID_RESPONSE",
      message: "The local service returned an invalid response."
    }, { phase, httpStatus: response.status });
  }
}

function isPortListening(port) {
  if (!port) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: HOST, port });
    const finish = listening => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function approveAllowed(incident) {
  if (incident?.operationalState !== "DISPATCH_CANDIDATE") return false;
  if (incident?.modelDebate?.consensus === "CRITICAL_CONFLICT") return false;
  return ["G_LOCATION", "G_CONTACT", "G_RESOURCE"].every(id =>
    incident.safetyGates?.find(gate => gate.id === id)?.passed === true);
}

function chooseDecision(incident) {
  const reviewRequired = incident?.safetyGates?.some(gate => gate.id === "G_CONFLICT" && gate.status === "review") === true;
  const action = approveAllowed(incident) ? "APPROVE_ACTION" : "HOLD_FOR_REVIEW";
  return {
    action,
    reason: "B11-R2 scripted local acceptance rehearsal; no real-world action is authorized or executed.",
    acknowledgeHumanDecision: action === "APPROVE_ACTION",
    acknowledgeNoAutomaticExecution: action === "APPROVE_ACTION",
    acknowledgeReview: reviewRequired
  };
}

function makeTrustedFailure(code, message, status) {
  return Object.assign(new Error(message), { code, status, trustedRehearsalError: true });
}

function renderRunSummary(state = {}) {
  const statuses = state.statuses && typeof state.statuses === "object" ? state.statuses : {};
  const counts = state.requestCounts && typeof state.requestCounts === "object" ? state.requestCounts : {};
  const cleanup = state.cleanup && typeof state.cleanup === "object" ? state.cleanup : {};
  const summary = state.summary && typeof state.summary === "object" ? state.summary : {};
  const lines = [
    "B11-R2 Single Live Judge Rehearsal",
    `Phase Ledger: ${Array.isArray(state.phaseLedger) && state.phaseLedger.length ? state.phaseLedger.join(" > ") : "PREFLIGHT"}`,
    `Health Status: ${statuses.health ?? "not_attempted"}`,
    `Analyze Status: ${statuses.analyze ?? "not_attempted"}`,
    `Decision Status: ${statuses.decision ?? "not_attempted"}`,
    `Brief Status: ${statuses.brief ?? "not_attempted"}`,
    `Audit Status: ${statuses.audit ?? "not_attempted"}`,
    `Proof Status: ${statuses.proof ?? "not_attempted"}`,
    `Analyze Duration: ${state.durations?.analyze ?? "not_available"}ms`,
    `Incident Count: ${Array.isArray(summary.incidents) ? summary.incidents.length : "not_available"}`
  ];
  for (const incident of Array.isArray(summary.incidents) ? summary.incidents : []) {
    lines.push(`CASE ${incident.label}: Analyst V/U/A=${incident.analyst?.verification}/${incident.analyst?.urgency}/${incident.analyst?.actionability} Reviewer V/U/A=${incident.reviewer?.verification}/${incident.reviewer?.urgency}/${incident.reviewer?.actionability} Final V/U/A=${incident.final?.verification}/${incident.final?.urgency}/${incident.final?.actionability}`);
    lines.push(`CASE ${incident.label}: Consensus=${incident.consensus} State=${incident.state} Gates=${Array.isArray(incident.gates) ? incident.gates.join(" ") : "not_available"}`);
    lines.push(`CASE ${incident.label}: Analyst Model=${incident.analystModel} Response ID=${incident.analystResponseId} Latency=${incident.analystLatencyMs}ms`);
    lines.push(`CASE ${incident.label}: Reviewer Model=${incident.reviewerModel} Response ID=${incident.reviewerResponseId} Latency=${incident.reviewerLatencyMs}ms`);
  }
  lines.push(`Quality Acceptance: ${state.qualityPassed === true ? "PASS" : "BLOCKED"}`);
  lines.push(`Human Action: ${summary.action || "Not recorded"}`);
  lines.push(`Decision / Execution: ${summary.decisionStatus || "Not available"} / ${summary.executionStatus || "Not available"}`);
  lines.push(`Brief / Audit / Proof: ${summary.briefStatus || "Not available"} / ${summary.auditValid === true ? "VALID" : "Not available"} / ${summary.proofValid === true && summary.tamperInvalid === true ? "VALID + TAMPER DETECTED" : "Not available"}`);
  if (state.safeFailure) lines.push(...formatSafeFailureSummary(state.safeFailure));
  if (state.safeFailure && statuses.analyze !== "not_attempted") lines.push("Remote role acceptance: Unknown");
  lines.push(`Analyze Submissions: ${counts.analyzeSubmissions ?? 0}`);
  lines.push(`Inference Attempts: ${counts.inferenceAttempts ?? 0}`);
  lines.push(`Automatic Retries: ${counts.automaticRetries ?? 0}`);
  lines.push(`Manual Reruns: ${counts.manualReruns ?? 0}`);
  lines.push(`/models Requests: ${counts.modelsRequests ?? 0}`);
  lines.push(`Loopback Client External Requests: ${counts.loopbackExternalRequests ?? 0}`);
  lines.push(`Key/Raw Content Matches: ${summary.sensitiveMatches ?? "Not available"}`);
  lines.push(`Random Port Listener Remaining: ${cleanup.randomPortListenerRemaining == null ? "Unknown" : cleanup.randomPortListenerRemaining ? "Yes" : "No"}`);
  lines.push(`Port 4173 Listener Remaining: ${cleanup.fixedPortListenerRemaining == null ? "Unknown" : cleanup.fixedPortListenerRemaining ? "Yes" : "No"}`);
  lines.push(`Background Project Process Remaining: ${cleanup.backgroundProjectProcessRemaining === true ? "Yes" : "No"}`);
  lines.push(`Outcome: ${state.outcome || "B11-R2 BLOCKED — LOCAL REHEARSAL ERROR"}`);
  return lines;
}

async function runLiveRehearsal({
  log = console.log,
  createServerImpl = createServer,
  createGonkaClientImpl = createGonkaClientFromEnv,
  createCrisisRouteClientImpl,
  evaluateImpl = evaluateFullScenarioAcceptance,
  fetchImpl = (...args) => globalThis.fetch(...args),
  closeServerImpl = closeServer,
  isPortListeningImpl = isPortListening,
  renderImpl = renderRunSummary,
  now = () => Date.now()
} = {}) {
  const state = createInitialRunState({ startedAt: now() });
  let primaryFailure = null;

  const countedClientFactory = () => {
    state.requestCounts.clientFactoryCalls += 1;
    const client = createGonkaClientImpl();
    return Object.freeze({
      ...client,
      completeJson: async request => {
        state.requestCounts.inferenceAttempts += 1;
        return client.completeJson(request);
      }
    });
  };

  try {
    const clientModule = createCrisisRouteClientImpl ? null : await importClient();
    const createFrontendClient = createCrisisRouteClientImpl || clientModule.createCrisisRouteClient;
    updatePhaseStatus(state, "SERVER_START");
    state.serverHandle = createServerImpl({ gonkaClientFactory: countedClientFactory });
    await new Promise((resolve, reject) => {
      if (!state.serverHandle || typeof state.serverHandle.listen !== "function") {
        reject(makeTrustedFailure("LOCAL_REHEARSAL_ERROR", LOCAL_ERROR_MESSAGE));
        return;
      }
      if (typeof state.serverHandle.once === "function") state.serverHandle.once("error", reject);
      state.serverHandle.listen(0, HOST, resolve);
    });
    const address = state.serverHandle?.address?.();
    state.port = Number.isInteger(address?.port) && address.port > 0 ? address.port : null;
    if (!state.port) throw makeTrustedFailure("LOCAL_REHEARSAL_ERROR", LOCAL_ERROR_MESSAGE);
    const baseUrl = `http://${HOST}:${state.port}`;

    const localFetch = async (url, options) => {
      let target;
      try {
        target = new URL(url, baseUrl);
      } catch {
        state.requestCounts.loopbackExternalRequests += 1;
        throw makeTrustedFailure("LOCAL_REHEARSAL_ERROR", LOCAL_ERROR_MESSAGE);
      }
      if (target.protocol !== "http:" || target.hostname !== HOST || Number(target.port) !== state.port) {
        state.requestCounts.loopbackExternalRequests += 1;
        throw makeTrustedFailure("LOCAL_REHEARSAL_ERROR", LOCAL_ERROR_MESSAGE);
      }
      const operation = operationForPath(target.pathname);
      if (operation) updatePhaseStatus(state, state.phase, operation, "started");
      if (operation === "analyze") {
        state.requestCounts.analyzeSubmissions += 1;
        if (state.requestCounts.analyzeSubmissions > 1) {
          updatePhaseStatus(state, state.phase, operation, "local_error");
          throw makeTrustedFailure("LOCAL_REHEARSAL_ERROR", LOCAL_ERROR_MESSAGE);
        }
      }
      if (target.pathname.includes("/models")) state.requestCounts.modelsRequests += 1;
      const requestStartedAt = now();
      let response;
      try {
        response = await fetchImpl(target, options);
      } catch {
        if (operation) updatePhaseStatus(state, state.phase, operation, "network_error");
        throw makeTrustedFailure("NETWORK_ERROR", "The local CrisisRoute service is unavailable.");
      }
      if (!response || !Number.isInteger(response.status)) {
        if (operation) updatePhaseStatus(state, state.phase, operation, "local_error");
        throw makeTrustedFailure("INVALID_RESPONSE", "The local service returned an invalid response.");
      }
      if (operation) {
        updatePhaseStatus(state, state.phase, operation, response.status);
        state.durations[operation] = Math.max(0, now() - requestStartedAt);
      }
      if (!response.ok) state.safeFailure = await captureResponseFailure(response, state.phase);
      return response;
    };

    const client = createFrontendClient({ fetchImpl: localFetch, baseUrl });

    updatePhaseStatus(state, "HEALTH");
    const health = await client.getHealth();
    if (!(health?.ok === true && health?.liveRoutesReady === true && health?.capabilities?.fullScenario === true && health?.capabilities?.decision === true && health?.capabilities?.brief === true)) {
      throw makeTrustedFailure("HTTP_ERROR", "Live health capabilities are incomplete.", 503);
    }
    state.healthPassed = true;

    updatePhaseStatus(state, "ANALYZE");
    const analyzed = await client.loadScenario([...CANONICAL_HAZE_MESSAGES]);

    updatePhaseStatus(state, "QUALITY");
    const quality = evaluateImpl(analyzed, { durationMs: state.durations.analyze });
    if (!quality?.fullPassed) {
      throw makeTrustedFailure("LIVE_QUALITY_FAILURE", "The live five-case result failed the shared quality evaluator.", state.statuses.analyze);
    }
    state.qualityPassed = true;
    const case01 = Array.isArray(analyzed?.incidents) ? analyzed.incidents.find(incident => incident.label === "01") : null;
    if (!case01) throw makeTrustedFailure("LIVE_CONTRACT_FAILURE", "CASE 01 is missing.", state.statuses.analyze);
    const submission = chooseDecision(case01);

    updatePhaseStatus(state, "DECISION");
    const decision = await client.recordHumanDecision({
      caseId: case01.caseId,
      idempotencyKey: `b11-r2-live-rehearsal-${now().toString(36)}`,
      submission
    });

    updatePhaseStatus(state, "BRIEF");
    const brief = await client.generateDeterministicBrief(case01.caseId);

    updatePhaseStatus(state, "AUDIT");
    const audit = await client.getCaseAudit(case01.caseId);

    updatePhaseStatus(state, "PROOF_VALID");
    const proofValid = await client.verifyProofCapsule({ brief: brief.brief, proofCapsule: brief.proofCapsule });

    updatePhaseStatus(state, "PROOF_TAMPER");
    const changedBrief = structuredClone(brief.brief);
    changedBrief.summary = "B11-R2 local tamper-detection copy.";
    const proofInvalid = await client.verifyProofCapsule({ brief: changedBrief, proofCapsule: brief.proofCapsule });

    const safeScanPayload = JSON.stringify({ decision, brief, audit, proofValid, proofInvalid });
    const sensitiveMatches = safeScanPayload.match(/sk-[A-Za-z0-9_-]{8,}|Authorization|rawContent|hiddenReasoning|message\.content/gi) || [];
    const contractPassed =
      state.requestCounts.analyzeSubmissions === 1 && state.requestCounts.inferenceAttempts === 2 &&
      state.requestCounts.modelsRequests === 0 && state.requestCounts.automaticRetries === 0 &&
      state.requestCounts.loopbackExternalRequests === 0 &&
      decision.decision?.recordStatus === "RECORDED" && decision.decision?.executionStatus === "NOT_EXECUTED" &&
      brief.brief?.executionStatus === "NOT_EXECUTED" && audit.chainValid === true &&
      proofValid.valid === true && proofInvalid.valid === false && sensitiveMatches.length === 0;
    if (!contractPassed) {
      throw makeTrustedFailure("LIVE_CONTRACT_FAILURE", "Post-analysis Decision, Brief, Audit, Proof or security contract failed.", 200);
    }

    state.summary = {
      incidents: analyzed.incidents.map(incident => ({
        label: incident.label,
        analyst: incident.modelReviews?.analyst?.scores,
        reviewer: incident.modelReviews?.reviewer?.scores,
        final: incident.scores,
        consensus: incident.modelDebate?.consensus,
        state: incident.operationalState,
        gates: incident.safetyGates?.map(gate => `${gate.id}=${gate.status}`),
        analystModel: incident.gonka?.analyst?.model,
        analystResponseId: incident.gonka?.analyst?.responseId,
        analystLatencyMs: incident.gonka?.analyst?.latencyMs,
        reviewerModel: incident.gonka?.reviewer?.model,
        reviewerResponseId: incident.gonka?.reviewer?.responseId,
        reviewerLatencyMs: incident.gonka?.reviewer?.latencyMs
      })),
      action: submission.action,
      decisionStatus: decision.decision.recordStatus,
      executionStatus: decision.decision.executionStatus,
      briefStatus: brief.brief.status,
      briefId: brief.brief.briefId,
      capsuleId: brief.proofCapsule?.capsuleId,
      auditValid: audit.chainValid,
      auditEntryCount: Array.isArray(audit.audit) ? audit.audit.length : Array.isArray(audit.entries) ? audit.entries.length : 0,
      proofValid: proofValid.valid,
      tamperInvalid: proofInvalid.valid === false,
      sensitiveMatches: sensitiveMatches.length
    };
    state.workCompleted = true;
  } catch (error) {
    const operation = typeof state.phase === "string" ? state.phase.toLowerCase() : "";
    const operationStatus = Number.isInteger(state.statuses[operation]) ? state.statuses[operation] : undefined;
    primaryFailure = state.safeFailure || (error?.trustedRehearsalError || SAFE_ERROR_CODES.has(error?.code)
      ? toSafeFailureSummary(error, { phase: state.phase, httpStatus: error.status ?? operationStatus })
      : localFailure(state.phase, operationStatus));
    state.safeFailure = primaryFailure;
    state.failedPhase = primaryFailure.phase;
  } finally {
    updatePhaseStatus(state, "CLEANUP");
    const serverForCleanup = state.serverHandle;
    try {
      await closeServerImpl(serverForCleanup);
      state.cleanup.closeSucceeded = true;
    } catch {
      state.cleanup.closeSucceeded = false;
      state.cleanup.issues.push("server_close_failed");
      if (!primaryFailure) {
        primaryFailure = localFailure("CLEANUP");
        state.safeFailure = primaryFailure;
        state.failedPhase = "CLEANUP";
      }
    }
    state.serverHandle = null;
    try {
      state.cleanup.randomPortListenerRemaining = state.port ? await isPortListeningImpl(state.port) : false;
    } catch {
      state.cleanup.randomPortListenerRemaining = null;
      state.cleanup.issues.push("random_port_check_failed");
      if (!primaryFailure) {
        primaryFailure = localFailure("CLEANUP");
        state.safeFailure = primaryFailure;
        state.failedPhase = "CLEANUP";
      }
    }
    try {
      state.cleanup.fixedPortListenerRemaining = await isPortListeningImpl(4173);
    } catch {
      state.cleanup.fixedPortListenerRemaining = null;
      state.cleanup.issues.push("fixed_port_check_failed");
      if (!primaryFailure) {
        primaryFailure = localFailure("CLEANUP");
        state.safeFailure = primaryFailure;
        state.failedPhase = "CLEANUP";
      }
    }
    if (state.cleanup.randomPortListenerRemaining === true || state.cleanup.fixedPortListenerRemaining === true) {
      state.cleanup.issues.push("port_listener_remaining");
      if (!primaryFailure) {
        primaryFailure = localFailure("CLEANUP");
        state.safeFailure = primaryFailure;
        state.failedPhase = "CLEANUP";
      }
    }
  }

  let success = state.workCompleted === true && !primaryFailure;
  if (success) {
    updatePhaseStatus(state, "COMPLETE");
    state.outcome = "B11-R2 PASS — Full live workflow completed";
  } else {
    state.outcome = primaryFailure?.code === "LOCAL_REHEARSAL_ERROR"
      ? "B11-R2 BLOCKED — LOCAL REHEARSAL ERROR"
      : "B11-R2 BLOCKED — SAFE LIVE FAILURE CAPTURED";
  }

  let lines;
  try {
    lines = renderImpl(state);
    if (!Array.isArray(lines)) throw new Error("invalid renderer result");
  } catch {
    if (!primaryFailure) {
      primaryFailure = localFailure("COMPLETE");
      state.safeFailure = primaryFailure;
      state.failedPhase = "COMPLETE";
    }
    success = false;
    state.outcome = "B11-R2 BLOCKED — LOCAL REHEARSAL ERROR";
    lines = renderRunSummary(state);
  }
  for (const line of lines) {
    try { log(line); } catch { /* Terminal rendering must not affect cleanup or result. */ }
  }
  return { success, outcome: state.outcome, state, lines };
}

const run = runLiveRehearsal;

if (require.main === module) {
  runLiveRehearsal().then(result => {
    if (!result.success) process.exitCode = 1;
  }).catch(() => {
    console.log("B11-R2 BLOCKED — LOCAL REHEARSAL ERROR");
    process.exitCode = 1;
  });
}

module.exports = {
  PHASES,
  createInitialRunState,
  updatePhaseStatus,
  toSafeFailureSummary,
  sanitizeSafeFailure: toSafeFailureSummary,
  formatSafeFailureSummary,
  renderFailureSummary: formatSafeFailureSummary,
  renderRunSummary,
  runLiveRehearsal,
  run,
  approveAllowed,
  chooseDecision
};
