const endpoint = "http://127.0.0.1:4173/api/incidents/analyze";
const LOCAL_SMOKE_TIMEOUT_MS = 60_000;

const messages = [
  "Block C hostel: six students are coughing badly, one has asthma. Need N95 masks and clinic transport.",
  "Another Block C resident reports heavy smoke smell and several students waiting near the lobby.",
  "FORWARD: 20 students trapped in Hostel B!!! Send everything now!!!",
  "Family near Shah Alam says an elderly parent has breathing difficulty due to haze. Exact location and callback number are unclear.",
  "Sports day is still scheduled despite haze; one notice says proceed, while another group claims cancellation."
];

function hasRequiredContract(result) {
  const incident = result?.incidents?.[0];
  const requiredIncidentFields = [
    "caseId", "label", "title", "rawMessage", "source", "receivedAt", "location",
    "peopleCount", "needs", "riskFlags", "knownFacts", "unknownFacts", "claims",
    "evidence", "scores", "operationalState", "missingFields", "modelDebate",
    "modelReviews", "safetyGates", "recommendedAction", "actionPlan", "actionBrief",
    "proofCapsule", "gonka", "humanDecision"
  ];
  return Boolean(
    result &&
    Array.isArray(result.resources) &&
    Array.isArray(result.rawReports) &&
    Array.isArray(result.incidents) &&
    result.incidents.length === 1 &&
    requiredIncidentFields.every(field => Object.hasOwn(incident, field)) &&
    incident?.gonka?.mode === "live" &&
    result?.meta?.slice === "CASE_01"
  );
}

function containsSensitiveOrRawModelContent(result) {
  const serialized = JSON.stringify(result);
  return /GONKA_API_KEY|authorization|sk-[A-Za-z0-9_-]{12,}|rawContent|rawModelContent|hiddenReasoning/i
    .test(serialized);
}

function safeValidationSummary(error) {
  const roles = new Set(["analyst", "reviewer", "both"]);
  const issuePattern = /^(?:payload|scores\.(?:verification|urgency|actionability)|recommendedAction|safeNextActions):(?:missing|not_numeric|out_of_range|not_object|unsafe_execution_claim)$/;
  return {
    role: roles.has(error?.role) ? error.role : "Not Available",
    issues: Array.isArray(error?.issues)
      ? error.issues.filter(issue => typeof issue === "string" && issuePattern.test(issue)).slice(0, 5)
      : []
  };
}

async function run({
  fetchImpl = globalThis.fetch,
  endpointUrl = endpoint,
  timeoutMs = LOCAL_SMOKE_TIMEOUT_MS,
  log = console.log
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
    log(`HTTP Status: ${response?.status ?? "Not Available"}`);
    log(`Error Code: ${controller.signal.aborted ? "LOCAL_SMOKE_TIMEOUT" : "SAFE_LOCAL_ERROR"}`);
    log("Failed Role: Not Available");
    log("Validation Issue Paths: None");
    log("Schema/Contract Check: No");
    log("Key or raw content found: No");
    return false;
  } finally {
    clearTimeout(timeout);
  }

  log(`HTTP Status: ${response.status}`);
  if (!response.ok) {
    const validation = safeValidationSummary(result?.error);
    log(`Error Code: ${result?.error?.code || "SAFE_UPSTREAM_ERROR"}`);
    log(`Failed Role: ${validation.role}`);
    log(`Validation Issue Paths: ${validation.issues.length ? validation.issues.join(", ") : "None"}`);
    log("Schema/Contract Check: No");
    log(`Key or raw content found: ${containsSensitiveOrRawModelContent(result) ? "Yes" : "No"}`);
    return false;
  }

  const incident = result.incidents?.[0];
  const contractPassed = hasRequiredContract(result);
  const sensitiveFound = containsSensitiveOrRawModelContent(result);
  log(`Incident Count: ${result.incidents?.length ?? 0}`);
  log(`Case ID: ${incident?.caseId || "Not Available"}`);
  log(`Label: ${incident?.label || "Not Available"}`);
  log(`Operational State: ${incident?.operationalState || "Not Available"}`);
  log(`Scores: V=${incident?.scores?.verification} U=${incident?.scores?.urgency} A=${incident?.scores?.actionability}`);
  log(`Consensus Level: ${incident?.modelDebate?.consensus || "Not Available"}`);
  log(`Safety Gates: ${(incident?.safetyGates || []).map(gate => `${gate.id}=${gate.status}`).join(" ")}`);
  log(`Analyst Model: ${incident?.gonka?.analyst?.model || "Not Available"}`);
  log(`Analyst Response ID: ${incident?.gonka?.analyst?.responseId || "Not Available"}`);
  log(`Analyst Latency: ${incident?.gonka?.analyst?.latencyMs ?? "Not Available"}ms`);
  log(`Reviewer Model: ${incident?.gonka?.reviewer?.model || "Not Available"}`);
  log(`Reviewer Response ID: ${incident?.gonka?.reviewer?.responseId || "Not Available"}`);
  log(`Reviewer Latency: ${incident?.gonka?.reviewer?.latencyMs ?? "Not Available"}ms`);
  log(`Meta: slice=${result.meta?.slice} partial=${result.meta?.partial} processed=${result.meta?.processedMessageCount}`);
  log(`Schema/Contract Check: ${contractPassed ? "Yes" : "No"}`);
  log(`Key or raw content found: ${sensitiveFound ? "Yes" : "No"}`);

  return contractPassed && !sensitiveFound;
}

if (require.main === module) {
  run().then(success => {
    if (!success) process.exitCode = 1;
  }).catch(() => {
    console.log("HTTP Status: Not Available");
    console.log("Error Code: SAFE_LOCAL_ERROR");
    console.log("Failed Role: Not Available");
    console.log("Validation Issue Paths: None");
    console.log("Schema/Contract Check: No");
    console.log("Key or raw content found: No");
    process.exitCode = 1;
  });
}

module.exports = { run, LOCAL_SMOKE_TIMEOUT_MS };
