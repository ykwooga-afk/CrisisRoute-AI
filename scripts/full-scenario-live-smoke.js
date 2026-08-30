const endpoint = "http://127.0.0.1:4173/api/incidents/analyze";
const healthEndpoint = "http://127.0.0.1:4173/api/health/gonka";
const LOCAL_SCENARIO_TIMEOUT_MS = 75_000;

const messages = [
  "Block C hostel: six students are coughing badly, one has asthma. Need N95 masks and clinic transport.",
  "Another Block C resident reports heavy smoke smell and several students waiting near the lobby.",
  "FORWARD: 20 students trapped in Hostel B!!! Send everything now!!!",
  "Family near Shah Alam says an elderly parent has breathing difficulty due to haze. Exact location and callback number are unclear.",
  "Sports day is still scheduled despite haze; one notice says proceed, while another group claims cancellation."
];

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

function incidentContractPassed(incident) {
  return Boolean(
    incident &&
    requiredIncidentFields.every(field => Object.hasOwn(incident, field)) &&
    expectedStates.get(incident.label) === incident.operationalState &&
    ["verification", "urgency", "actionability"].every(axis =>
      Number.isFinite(incident.scores?.[axis]) && incident.scores[axis] >= 0 && incident.scores[axis] <= 100) &&
    Array.isArray(incident.safetyGates) &&
    incident.safetyGates.length === 6 &&
    incident.gonka?.mode === "live"
  );
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
  const schemaPassed = incidents.length === 5 && incidents.every(incidentContractPassed);
  const uiPassed = schemaPassed && labels.join(",") === "01,02,03,04,05";
  const sensitiveFound = containsSensitiveOrRawContent(result);
  const analystIds = new Set(incidents.map(item => item.gonka?.analyst?.responseId));
  const reviewerIds = new Set(incidents.map(item => item.gonka?.reviewer?.responseId));

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
  log(`Analyst Model: ${first?.gonka?.analyst?.model || "Not Available"}`);
  log(`Analyst Response ID: ${first?.gonka?.analyst?.responseId || "Not Available"}`);
  log(`Analyst Latency: ${analystLatency ?? "Not Available"}ms`);
  log(`Analyst Shared Trace: ${analystIds.size === 1 ? "Yes" : "No"}`);
  log(`Reviewer Model: ${first?.gonka?.reviewer?.model || "Not Available"}`);
  log(`Reviewer Response ID: ${first?.gonka?.reviewer?.responseId || "Not Available"}`);
  log(`Reviewer Latency: ${reviewerLatency ?? "Not Available"}ms`);
  log(`Reviewer Shared Trace: ${reviewerIds.size === 1 ? "Yes" : "No"}`);
  log(`Timing Consistency: ${timingConsistent ? "PASS" : "LATENCY_INSTRUMENTATION_INCONSISTENT"}`);
  log(`Schema Contract: ${schemaPassed ? "PASS" : "FAIL"}`);
  log(`UI Root Contract: ${uiPassed ? "PASS" : "FAIL"}`);
  log(`Meta: slice=${result?.meta?.slice} partial=${result?.meta?.partial} received=${result?.meta?.receivedMessageCount} processedCases=${result?.meta?.processedCaseCount} fixtureCases=${(result?.meta?.scenarioFixtureCases || []).join(",")}`);
  log(`Model Request Count: ${result?.meta?.modelRequestCount ?? "Not Available"}`);
  log(`Key/raw-content scan: ${sensitiveFound ? "Yes" : "No"}`);

  return Boolean(
    response.status === 200 &&
    health?.capabilities?.fullScenario === true &&
    incidents.length === 5 &&
    uniqueCaseIds === 5 &&
    schemaPassed &&
    uiPassed &&
    analystIds.size === 1 &&
    reviewerIds.size === 1 &&
    timingConsistent &&
    result?.meta?.modelRequestCount === 2 &&
    !sensitiveFound
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

module.exports = { run, LOCAL_SCENARIO_TIMEOUT_MS };
