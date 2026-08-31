const endpoint = "http://127.0.0.1:4173/api/incidents/analyze";
const healthEndpoint = "http://127.0.0.1:4173/api/health/gonka";
const LOCAL_SCENARIO_TIMEOUT_MS = 75_000;
const { CANONICAL_HAZE_MESSAGES } = require("../backend/hazeScenario");
const { DEFAULT_MODELS } = require("../backend/gonkaClient");

const messages = CANONICAL_HAZE_MESSAGES;

const expectedStates = new Map([
  ["01", "DISPATCH_CANDIDATE"],
  ["02", "MERGE_OR_VERIFY"],
  ["03", "URGENT_VERIFICATION"],
  ["04", "NEEDS_HUMAN_REVIEW"],
  ["05", "QUEUED_ACTION"]
]);

const requiredIncidentFields = [
  "caseId", "label", "title", "rawMessage", "source", "receivedAt", "location",
  "peopleCount", "needs", "riskFlags", "knownFacts", "unknownFacts", "claims",
  "evidence", "scores", "operationalState", "missingFields", "modelDebate",
  "modelReviews", "safetyGates", "recommendedAction", "actionPlan", "actionBrief",
  "proofCapsule", "gonka", "humanDecision", "qualityWarnings"
];

function containsSensitiveOrRawContent(value) {
  return /GONKA_API_KEY|authorization|sk-[A-Za-z0-9_-]{12,}|rawContent|rawModelContent|hiddenReasoning|message\.content/i
    .test(JSON.stringify(value));
}

function incidentShapeContractPassed(incident) {
  return Boolean(
    incident &&
    requiredIncidentFields.every(field => Object.hasOwn(incident, field)) &&
    expectedStates.get(incident.label) === incident.operationalState &&
    ["verification", "urgency", "actionability"].every(axis =>
      Number.isFinite(incident.scores?.[axis]) && incident.scores[axis] >= 0 && incident.scores[axis] <= 100) &&
    Array.isArray(incident.safetyGates) &&
    incident.safetyGates.length === 6 &&
    Array.isArray(incident.qualityWarnings) &&
    incident.gonka?.mode === "live"
  );
}

function evaluateScenarioQuality(result) {
  const incidents = Array.isArray(result?.incidents) ? result.incidents : [];
  const byLabel = new Map(incidents.map(incident => [incident?.label, incident]));
  const score = (label, axis) => byLabel.get(label)?.scores?.[axis];
  const finite = value => Number.isFinite(value);
  const directionalPassed = incidents.length === 5 && [
    finite(score("01", "urgency")) && score("01", "urgency") >= 60,
    finite(score("01", "actionability")) && score("01", "actionability") >= 50,
    finite(score("02", "verification")) && score("02", "verification") <= 59,
    finite(score("03", "urgency")) && score("03", "urgency") >= 60,
    finite(score("03", "actionability")) && score("03", "actionability") <= 59,
    finite(score("04", "actionability")) && score("04", "actionability") <= 59,
    finite(score("05", "actionability")) && score("05", "actionability") >= 50
  ].every(Boolean);

  const validConsensus = new Set(["AGREEMENT", "DISAGREEMENT", "CRITICAL_CONFLICT"]);
  const consensusValuesValid = incidents.length === 5 &&
    incidents.every(incident => validConsensus.has(incident?.modelDebate?.consensus));
  const criticalConflictCount = incidents.filter(
    incident => incident?.modelDebate?.consensus === "CRITICAL_CONFLICT"
  ).length;
  const consensusPassed = consensusValuesValid && criticalConflictCount <= 2;

  const fatalWarnings = new Set([
    "URGENT_STATE_LOW_URGENCY_SCORE",
    "ACTION_READY_LOW_ACTIONABILITY_SCORE"
  ]);
  const warningsPassed = incidents.length === 5 && incidents.every(incident =>
    Array.isArray(incident?.qualityWarnings) &&
    !incident.qualityWarnings.some(warning => fatalWarnings.has(warning)));

  const validTrace = (incident, role, expectedModel) => {
    const trace = incident?.gonka?.[role];
    return trace?.model === expectedModel &&
      typeof trace.responseId === "string" && trace.responseId.trim().length > 0 &&
      Number.isFinite(trace.latencyMs) && trace.latencyMs >= 0;
  };
  const analystIds = incidents.map(incident => incident?.gonka?.analyst?.responseId);
  const reviewerIds = incidents.map(incident => incident?.gonka?.reviewer?.responseId);
  const tracePassed = incidents.length === 5 &&
    incidents.every(incident => validTrace(incident, "analyst", DEFAULT_MODELS.analyst)) &&
    incidents.every(incident => validTrace(incident, "reviewer", DEFAULT_MODELS.reviewer)) &&
    new Set(analystIds).size === 1 &&
    new Set(reviewerIds).size === 1;

  const materialConflictLabels = new Set(["04"]);
  const gateConsistencyPassed = incidents.length === 5 && incidents.every(incident => {
    const consensus = incident?.modelDebate?.consensus;
    if (!validConsensus.has(consensus) || !Array.isArray(incident?.safetyGates)) return false;
    const conflictGate = incident.safetyGates.find(gate => gate?.id === "G_CONFLICT");
    const dispatchGate = incident.safetyGates.find(gate => gate?.id === "G_DISPATCH");
    if (!conflictGate || !dispatchGate) return false;
    const expectedConflict = consensus === "AGREEMENT" && !materialConflictLabels.has(incident.label)
      ? "passed"
      : "review";
    const expectedDispatch = incident.operationalState === "DISPATCH_CANDIDATE"
      ? consensus === "AGREEMENT" ? "passed" : "review"
      : "locked";
    return conflictGate.status === expectedConflict && dispatchGate.status === expectedDispatch;
  });

  return {
    directionalPassed,
    criticalConflictCount,
    consensusPassed,
    warningsPassed,
    tracePassed,
    gateConsistencyPassed,
    passed: directionalPassed && consensusPassed && warningsPassed && tracePassed && gateConsistencyPassed
  };
}

function evaluateFullScenarioAcceptance(result, { durationMs } = {}) {
  const incidents = Array.isArray(result?.incidents) ? result.incidents : [];
  const labels = incidents.map(incident => incident?.label);
  const uniqueCaseIds = new Set(incidents.map(incident => incident?.caseId)).size;
  const shapePassed = incidents.length === 5 && incidents.every(incidentShapeContractPassed);
  const uiPassed = shapePassed && labels.join(",") === "01,02,03,04,05";
  const quality = evaluateScenarioQuality(result);
  const first = incidents[0];
  const analystLatency = first?.gonka?.analyst?.latencyMs;
  const reviewerLatency = first?.gonka?.reviewer?.latencyMs;
  const timingEvaluated = Number.isFinite(durationMs);
  const timingConsistent = !timingEvaluated || (
    Number.isFinite(analystLatency) && Number.isFinite(reviewerLatency) &&
    durationMs + 100 >= Math.max(analystLatency, reviewerLatency)
  );
  const modelRequestCountPassed = result?.meta?.modelRequestCount === 2;
  const sensitiveContentPassed = !containsSensitiveOrRawContent(result);
  return {
    ...quality,
    incidentCount: incidents.length,
    labels,
    uniqueCaseIds,
    shapePassed,
    uiPassed,
    timingEvaluated,
    timingConsistent,
    modelRequestCountPassed,
    sensitiveContentPassed,
    fullPassed: quality.passed && incidents.length === 5 && uniqueCaseIds === 5 &&
      shapePassed && uiPassed && timingConsistent && modelRequestCountPassed && sensitiveContentPassed
  };
}

function safeErrorSummary(error) {
  const role = ["analyst", "reviewer", "both"].includes(error?.failedRole || error?.role)
    ? error.failedRole || error.role
    : "Not Available";
  const issues = Array.isArray(error?.issuePaths || error?.issues)
    ? (error.issuePaths || error.issues).filter(item => typeof item === "string").slice(0, 5)
    : [];
  return { role, issues };
}

async function run({
  fetchImpl = globalThis.fetch,
  endpointUrl = endpoint,
  healthUrl = healthEndpoint,
  timeoutMs = LOCAL_SCENARIO_TIMEOUT_MS,
  log = console.log
} = {}) {
  let health = null;
  try {
    const healthResponse = await fetchImpl(healthUrl);
    health = await healthResponse.json();
  } catch {
    log("Health fullScenario: No");
    log("HTTP Status: Not Available");
    log("Error Code: LOCAL_HEALTH_UNAVAILABLE");
    log("Key/raw-content scan: No");
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  let result;
  try {
    response = await fetchImpl(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "malaysia_haze_fire_smoke", messages }),
      signal: controller.signal
    });
    result = await response.json();
  } catch {
    log(`Health fullScenario: ${health?.capabilities?.fullScenario === true ? "Yes" : "No"}`);
    log(`HTTP Status: ${response?.status ?? "Not Available"}`);
    log(`Duration: ${Date.now() - startedAt}ms`);
    log(`Error Code: ${controller.signal.aborted ? "LOCAL_SCENARIO_TIMEOUT" : "SAFE_LOCAL_ERROR"}`);
    log("Key/raw-content scan: No");
    return false;
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - startedAt;
  log(`Health fullScenario: ${health?.capabilities?.fullScenario === true ? "Yes" : "No"}`);
  log(`HTTP Status: ${response.status}`);
  log(`Duration: ${durationMs}ms`);
  if (!response.ok) {
    const safe = safeErrorSummary(result?.error);
    log(`Error Code: ${result?.error?.code || "SAFE_UPSTREAM_ERROR"}`);
    log(`Failed Role: ${safe.role}`);
    log(`Validation Issue Paths: ${safe.issues.length ? safe.issues.join(", ") : "None"}`);
    log(`Key/raw-content scan: ${containsSensitiveOrRawContent(result) ? "Yes" : "No"}`);
    return false;
  }

  const incidents = Array.isArray(result?.incidents) ? result.incidents : [];
  const labels = incidents.map(item => item.label);
  const uniqueCaseIds = new Set(incidents.map(item => item.caseId)).size;
  const shapePassed = incidents.length === 5 && incidents.every(incidentShapeContractPassed);
  const uiPassed = shapePassed && labels.join(",") === "01,02,03,04,05";
  const sensitiveFound = containsSensitiveOrRawContent(result);
  const analystIds = new Set(incidents.map(item => item.gonka?.analyst?.responseId));
  const reviewerIds = new Set(incidents.map(item => item.gonka?.reviewer?.responseId));
  const analystSharedTrace = incidents.length === 5 &&
    incidents.every(item => typeof item.gonka?.analyst?.responseId === "string" && item.gonka.analyst.responseId.trim()) &&
    analystIds.size === 1;
  const reviewerSharedTrace = incidents.length === 5 &&
    incidents.every(item => typeof item.gonka?.reviewer?.responseId === "string" && item.gonka.reviewer.responseId.trim()) &&
    reviewerIds.size === 1;
  const quality = evaluateFullScenarioAcceptance(result, { durationMs });
  const healthPassed = health?.ok === true &&
    health?.liveRoutesReady === true &&
    health?.capabilities?.fullScenario === true;

  log(`Incident Count: ${incidents.length}`);
  log(`Labels: ${labels.join(", ") || "None"}`);
  log(`Unique Case IDs: ${uniqueCaseIds}`);
  for (const incident of incidents) {
    const analystScores = incident.modelReviews?.analyst?.scores;
    const reviewerScores = incident.modelReviews?.reviewer?.scores;
    const finalScores = incident.scores;
    const gaps = incident.modelDebate?.scoreGaps;
    log(`CASE ${incident.label}: State=${incident.operationalState}`);
    log(`CASE ${incident.label} Analyst Scores: V=${analystScores?.verification} U=${analystScores?.urgency} A=${analystScores?.actionability}`);
    log(`CASE ${incident.label} Reviewer Scores: V=${reviewerScores?.verification} U=${reviewerScores?.urgency} A=${reviewerScores?.actionability}`);
    log(`CASE ${incident.label} Final Scores: V=${finalScores?.verification} U=${finalScores?.urgency} A=${finalScores?.actionability}`);
    log(`CASE ${incident.label} Axis Gaps: V=${gaps?.verification} U=${gaps?.urgency} A=${gaps?.actionability}`);
    log(`CASE ${incident.label} Consensus: ${incident.modelDebate?.consensus || "Not Available"}`);
    log(`CASE ${incident.label} Quality Warnings: ${incident.qualityWarnings?.length ? incident.qualityWarnings.join(",") : "None"}`);
    log(`CASE ${incident.label} Gates: ${(incident.safetyGates || []).map(gate => `${gate.id}=${gate.status}`).join(" ")}`);
  }
  const first = incidents[0];
  const analystLatency = first?.gonka?.analyst?.latencyMs;
  const reviewerLatency = first?.gonka?.reviewer?.latencyMs;
  const latencyPresent = Number.isFinite(analystLatency) && Number.isFinite(reviewerLatency);
  const timingConsistent = latencyPresent && durationMs + 100 >= Math.max(analystLatency, reviewerLatency);
  const overallQualityPassed = healthPassed && quality.fullPassed;
  log(`Analyst Model: ${first?.gonka?.analyst?.model || "Not Available"}`);
  log(`Analyst Response ID: ${first?.gonka?.analyst?.responseId || "Not Available"}`);
  log(`Analyst Latency: ${analystLatency ?? "Not Available"}ms`);
  log(`Analyst Shared Trace: ${analystSharedTrace ? "Yes" : "No"}`);
  log(`Reviewer Model: ${first?.gonka?.reviewer?.model || "Not Available"}`);
  log(`Reviewer Response ID: ${first?.gonka?.reviewer?.responseId || "Not Available"}`);
  log(`Reviewer Latency: ${reviewerLatency ?? "Not Available"}ms`);
  log(`Reviewer Shared Trace: ${reviewerSharedTrace ? "Yes" : "No"}`);
  log(`Timing Consistency: ${timingConsistent ? "PASS" : "LATENCY_INSTRUMENTATION_INCONSISTENT"}`);
  log(`Directional Quality: ${quality.directionalPassed ? "PASS" : "FAIL"}`);
  log(`Critical Conflict Count: ${quality.criticalConflictCount}`);
  log(`Consensus Quality: ${quality.consensusPassed ? "PASS" : "FAIL"}`);
  log(`Trace Contract: ${quality.tracePassed ? "PASS" : "FAIL"}`);
  log(`Gate Consistency: ${quality.gateConsistencyPassed ? "PASS" : "FAIL"}`);
  log(`Overall Quality Acceptance: ${overallQualityPassed ? "PASS" : "FAIL"}`);
  log(`Incident Shape Contract: ${shapePassed ? "PASS" : "FAIL"}`);
  log("Full generic JSON Schema validation: Not implemented");
  log(`UI Root Contract: ${uiPassed ? "PASS" : "FAIL"}`);
  log(`Meta: slice=${result?.meta?.slice} partial=${result?.meta?.partial} received=${result?.meta?.receivedMessageCount} processedCases=${result?.meta?.processedCaseCount} fixtureCases=${(result?.meta?.scenarioFixtureCases || []).join(",")}`);
  log(`Model Request Count: ${result?.meta?.modelRequestCount ?? "Not Available"}`);
  log(`Key/raw-content scan: ${sensitiveFound ? "Yes" : "No"}`);

  return Boolean(
    response.status === 200 &&
    healthPassed &&
    incidents.length === 5 &&
    uniqueCaseIds === 5 &&
    shapePassed &&
    uiPassed &&
    quality.fullPassed
  );
}

if (require.main === module) {
  run().then(success => {
    if (!success) process.exitCode = 1;
  }).catch(() => {
    console.log("HTTP Status: Not Available");
    console.log("Error Code: SAFE_LOCAL_ERROR");
    console.log("Key/raw-content scan: No");
    process.exitCode = 1;
  });
}

module.exports = {
  run,
  evaluateScenarioQuality,
  evaluateFullScenarioAcceptance,
  incidentShapeContractPassed,
  LOCAL_SCENARIO_TIMEOUT_MS
};
