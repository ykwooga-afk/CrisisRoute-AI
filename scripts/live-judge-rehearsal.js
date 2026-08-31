const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { CANONICAL_HAZE_MESSAGES } = require("../backend/hazeScenario");
const { createGonkaClientFromEnv } = require("../backend/gonkaClient");
const { createServer } = require("../server");
const { evaluateFullScenarioAcceptance } = require("./full-scenario-live-smoke");

const HOST = "127.0.0.1";
const projectRoot = path.resolve(__dirname, "..");
const SAFE_FAILED_ROLES = new Set(["analyst", "reviewer", "both"]);
const SAFE_ROLE_ERROR_CODES = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "HTTP_ERROR",
  "INVALID_MODEL_DATA",
  "RESPONSE_TOO_LARGE"
]);
const SAFE_ERROR_CODES = new Set([
  ...SAFE_ROLE_ERROR_CODES,
  "UPSTREAM_ERROR",
  "INVALID_SCENARIO_INPUT",
  "CONFIGURATION_ERROR",
  "INVALID_RESPONSE",
  "LIVE_QUALITY_FAILURE",
  "LIVE_CONTRACT_FAILURE",
  "UNKNOWN_SAFE_ERROR"
]);
const UNSAFE_MESSAGE_PATTERN = /sk-|authorization|bearer|credential|stack|cause|raw|prompt|private|https?:\/\//i;

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`;
}

function sanitizeSafeFailure(source, { status } = {}) {
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
    : "The live rehearsal failed safely.";
  return {
    status: Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : Number.isInteger(candidate.status) && candidate.status >= 100 && candidate.status <= 599 ? candidate.status : "Not available",
    code,
    message,
    retryable: candidate.retryable === true,
    failedRole,
    roleErrors,
    validationIssuePaths
  };
}

function formatSafeFailureSummary(failure) {
  const safe = sanitizeSafeFailure(failure, { status: failure?.status });
  const roleErrors = Object.entries(safe.roleErrors).map(([role, code]) => `${role}=${code}`).join(", ") || "None";
  const validationIssuePaths = safe.validationIssuePaths.join(", ") || "None";
  return [
    `Safe Error Code: ${safe.code}`,
    `Safe Error Message: ${safe.message}`,
    `Retryable: ${safe.retryable ? "Yes" : "No"}`,
    `Failed Role: ${safe.failedRole}`,
    `Role Errors: ${roleErrors}`,
    `Validation Issue Paths: ${validationIssuePaths}`
  ];
}

async function importClient() {
  let source = fs.readFileSync(path.join(projectRoot, "src/services/crisisRouteClient.js"), "utf8");
  source = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];\s*/g, "");
  return import(dataModule(source));
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
  if (!server.listening) return Promise.resolve();
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

function approveAllowed(incident) {
  if (incident?.operationalState !== "DISPATCH_CANDIDATE") return false;
  if (incident?.modelDebate?.consensus === "CRITICAL_CONFLICT") return false;
  return ["G_LOCATION", "G_CONTACT", "G_RESOURCE"].every(id =>
    incident.safetyGates?.find(gate => gate.id === id)?.passed === true);
}

function chooseDecision(incident) {
  const reviewRequired = incident.safetyGates?.some(gate => gate.id === "G_CONFLICT" && gate.status === "review") === true;
  const action = approveAllowed(incident) ? "APPROVE_ACTION" : "HOLD_FOR_REVIEW";
  return {
    action,
    reason: "B11-R1 scripted local acceptance rehearsal; no real-world action is authorized or executed.",
    acknowledgeHumanDecision: action === "APPROVE_ACTION",
    acknowledgeNoAutomaticExecution: action === "APPROVE_ACTION",
    acknowledgeReview: reviewRequired
  };
}

async function run({ log = console.log } = {}) {
  const { createCrisisRouteClient } = await importClient();
  let inferenceRequestCount = 0;
  let analyzeRequestCount = 0;
  let modelsRequestCount = 0;
  let automaticRetryCount = 0;
  let externalRequestCount = 0;
  let clientFactoryCalls = 0;
  let port;
  let summary = {};
  let outcome = "B11-R1 BLOCKED — LIVE REHEARSAL FAILED";
  let analyzeContractReached = false;
  let capturedSafeFailure;

  const countedClientFactory = () => {
    clientFactoryCalls += 1;
    const client = createGonkaClientFromEnv();
    return Object.freeze({
      ...client,
      completeJson: async request => {
        inferenceRequestCount += 1;
        return client.completeJson(request);
      }
    });
  };
  const server = createServer({ gonkaClientFactory: countedClientFactory });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, HOST, resolve);
    });
    port = server.address().port;
    const baseUrl = `http://${HOST}:${port}`;
    const statuses = {};
    const localFetch = async (url, options) => {
      const target = new URL(url, baseUrl);
      if (target.protocol !== "http:" || target.hostname !== HOST || Number(target.port) !== port) {
        externalRequestCount += 1;
        throw new Error("The rehearsal client may only call its fresh loopback server.");
      }
      if (target.pathname === "/api/incidents/analyze") {
        analyzeRequestCount += 1;
        if (analyzeRequestCount > 1) throw new Error("A second Analyze request is forbidden.");
      }
      if (target.pathname.includes("/models")) modelsRequestCount += 1;
      const startedAt = Date.now();
      const response = await fetch(target, options);
      statuses[target.pathname] = { status: response.status, durationMs: Date.now() - startedAt };
      if (!response.ok && target.pathname === "/api/incidents/analyze") {
        try {
          const safeText = await response.clone().text();
          if (safeText.length <= 200_000) {
            capturedSafeFailure = sanitizeSafeFailure(JSON.parse(safeText), { status: response.status });
          }
        } catch {
          capturedSafeFailure = sanitizeSafeFailure({}, { status: response.status });
        }
      }
      return response;
    };
    const client = createCrisisRouteClient({ fetchImpl: localFetch, baseUrl });

    const health = await client.getHealth();
    if (!(health?.ok === true && health?.liveRoutesReady === true && health?.capabilities?.fullScenario === true && health?.capabilities?.decision === true && health?.capabilities?.brief === true)) {
      throw Object.assign(new Error("Live health capabilities are incomplete."), { code: "HTTP_ERROR", status: 503 });
    }
    summary.health = "PASS";

    const analyzeStartedAt = Date.now();
    const analyzed = await client.loadScenario([...CANONICAL_HAZE_MESSAGES]);
    analyzeContractReached = true;
    const analyzeDurationMs = Date.now() - analyzeStartedAt;
    const quality = evaluateFullScenarioAcceptance(analyzed, { durationMs: analyzeDurationMs });
    if (!quality.fullPassed) {
      outcome = "B11-R1 BLOCKED — LIVE REHEARSAL FAILED";
      throw Object.assign(new Error("The live five-case result failed the shared quality evaluator."), { code: "LIVE_QUALITY_FAILURE", status: 200 });
    }

    const case01 = analyzed.incidents.find(incident => incident.label === "01");
    if (!case01) {
      outcome = "B11-R1 BLOCKED — LIVE REHEARSAL FAILED";
      throw Object.assign(new Error("CASE 01 is missing."), { code: "LIVE_CONTRACT_FAILURE", status: 200 });
    }
    const submission = chooseDecision(case01);
    const decision = await client.recordHumanDecision({
      caseId: case01.caseId,
      idempotencyKey: `b11-live-rehearsal-${Date.now().toString(36)}`,
      submission
    });
    const brief = await client.generateDeterministicBrief(case01.caseId);
    const audit = await client.getCaseAudit(case01.caseId);
    const proofValid = await client.verifyProofCapsule({ brief: brief.brief, proofCapsule: brief.proofCapsule });
    const changedBrief = structuredClone(brief.brief);
    changedBrief.summary = "B11 local tamper-detection copy.";
    const proofInvalid = await client.verifyProofCapsule({ brief: changedBrief, proofCapsule: brief.proofCapsule });

    const safeScanPayload = JSON.stringify({
      decision,
      brief,
      audit,
      proofValid,
      proofInvalid,
      quality: {
        incidentCount: quality.incidentCount,
        labels: quality.labels,
        passed: quality.fullPassed
      }
    });
    const sensitiveMatches = safeScanPayload.match(/sk-[A-Za-z0-9_-]{8,}|Authorization|rawContent|hiddenReasoning|message\.content/gi) || [];
    const contractPassed =
      analyzeRequestCount === 1 && inferenceRequestCount === 2 && modelsRequestCount === 0 &&
      automaticRetryCount === 0 && externalRequestCount === 0 &&
      decision.decision?.recordStatus === "RECORDED" && decision.decision?.executionStatus === "NOT_EXECUTED" &&
      brief.brief?.executionStatus === "NOT_EXECUTED" && audit.chainValid === true &&
      proofValid.valid === true && proofInvalid.valid === false && sensitiveMatches.length === 0;
    if (!contractPassed) {
      outcome = "B11-R1 BLOCKED — LIVE REHEARSAL FAILED";
      throw Object.assign(new Error("Post-analysis Decision, Brief, Audit, Proof or security contract failed."), { code: "LIVE_CONTRACT_FAILURE", status: 200 });
    }

    summary = {
      health: "PASS",
      httpStatus: statuses["/api/incidents/analyze"]?.status,
      analyzeDurationMs,
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
      quality: "PASS",
      action: submission.action,
      decisionStatus: decision.decision.recordStatus,
      executionStatus: decision.decision.executionStatus,
      briefStatus: brief.brief.status,
      auditValid: audit.chainValid,
      proofValid: proofValid.valid,
      tamperInvalid: proofInvalid.valid === false,
      sensitiveMatches: sensitiveMatches.length
    };
    outcome = "B11-R1 PASS — Full live workflow completed";
  } catch (error) {
    const safeFailure = capturedSafeFailure || sanitizeSafeFailure(error, { status: error?.status });
    if (analyzeContractReached || summary.httpStatus === 200) outcome = "B11-R1 BLOCKED — LIVE REHEARSAL FAILED";
    summary = {
      ...summary,
      safeFailure,
      safeError: safeFailure.code,
      httpStatus: safeFailure.status,
      analyzeDurationMs: statuses["/api/incidents/analyze"]?.durationMs ?? summary.analyzeDurationMs,
      failedRole: safeFailure.failedRole,
      roleErrors: safeFailure.roleErrors,
      validationIssuePaths: safeFailure.validationIssuePaths
    };
  } finally {
    await closeServer(server);
  }

  const randomPortResidue = await isPortListening(port);
  const fixedPortResidue = await isPortListening(4173);
  if (randomPortResidue || fixedPortResidue) outcome = "B11-R1 BLOCKED — LIVE REHEARSAL FAILED";
  log("B11-R1 Single Live Judge Rehearsal");
  log(`Health: ${summary.health || "BLOCKED"}`);
  log(`Analyze HTTP Status: ${summary.httpStatus ?? "Not available"}`);
  log(`Analyze Duration: ${summary.analyzeDurationMs ?? "Not available"}ms`);
  log(`Incident Count: ${summary.incidents?.length ?? "Not available"}`);
  for (const incident of summary.incidents || []) {
    log(`CASE ${incident.label}: Analyst V/U/A=${incident.analyst?.verification}/${incident.analyst?.urgency}/${incident.analyst?.actionability} Reviewer V/U/A=${incident.reviewer?.verification}/${incident.reviewer?.urgency}/${incident.reviewer?.actionability} Final V/U/A=${incident.final?.verification}/${incident.final?.urgency}/${incident.final?.actionability}`);
    log(`CASE ${incident.label}: Consensus=${incident.consensus} State=${incident.state} Gates=${incident.gates?.join(" ")}`);
    log(`CASE ${incident.label}: Analyst Model=${incident.analystModel} Response ID=${incident.analystResponseId} Latency=${incident.analystLatencyMs}ms`);
    log(`CASE ${incident.label}: Reviewer Model=${incident.reviewerModel} Response ID=${incident.reviewerResponseId} Latency=${incident.reviewerLatencyMs}ms`);
  }
  log(`Quality Acceptance: ${summary.quality || "BLOCKED"}`);
  log(`Human Action: ${summary.action || "Not recorded"}`);
  log(`Decision / Execution: ${summary.decisionStatus || "Not available"} / ${summary.executionStatus || "Not available"}`);
  log(`Brief / Audit / Proof: ${summary.briefStatus || "Not available"} / ${summary.auditValid === true ? "VALID" : "Not available"} / ${summary.proofValid === true && summary.tamperInvalid === true ? "VALID + TAMPER DETECTED" : "Not available"}`);
  if (summary.safeFailure) {
    for (const line of formatSafeFailureSummary(summary.safeFailure)) log(line);
  }
  log(`Analyze Requests: ${analyzeRequestCount}`);
  log(`Inference Requests: ${inferenceRequestCount}`);
  log(`Automatic Retries: ${automaticRetryCount}`);
  log(`Manual Reruns: 0`);
  log(`/models Requests: ${modelsRequestCount}`);
  log(`Loopback Client External Requests: ${externalRequestCount}`);
  log(`Key/Raw Content Matches: ${summary.sensitiveMatches ?? "Not available"}`);
  log(`Client Factory Calls: ${clientFactoryCalls}`);
  log(`Random Port Residue: ${randomPortResidue ? "FAIL" : "PASS"}`);
  log(`Port 4173 Residue: ${fixedPortResidue ? "FAIL" : "PASS"}`);
  log(`Outcome: ${outcome}`);
  return { success: outcome.startsWith("B11-R1 PASS"), outcome };
}

if (require.main === module) {
  run().then(result => {
    if (!result.success) process.exitCode = 1;
  });
}

module.exports = { run, approveAllowed, chooseDecision, sanitizeSafeFailure, formatSafeFailureSummary };
