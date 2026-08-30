const crypto = require("node:crypto");
const { GonkaClientError, DEFAULT_MODELS } = require("./gonkaClient");

const ANALYST_PROMPT_VERSION = "analyst-v1.1-minimal";
const REVIEWER_PROMPT_VERSION = "reviewer-v1.1-minimal";
const ANALYST_TIMEOUT_MS = 45_000;
const REVIEWER_TIMEOUT_MS = 45_000;
const CASE_01_SCENARIO = "malaysia_haze_fire_smoke";
const MAX_MESSAGE_LENGTH = 4_000;

const SCORE_AXES = ["verification", "urgency", "actionability"];

const COMMON_SAFETY_RULES = `
AI advises; humans decide.
LOW VERIFICATION DOES NOT MEAN LOW URGENCY.
Use only supplied evidence. Do not invent sources, contact, dispatch, approval, treatment, or corroboration.
Always include numeric scores.verification, scores.urgency, and scores.actionability from 0 to 100.
Return one compact JSON object only, with no Markdown, hidden reasoning, repetition, or extra fields.`.trim();

const ANALYST_SYSTEM_PROMPT = `${COMMON_SAFETY_RULES}
You are an independent Analyst. Assess the original reports only.
Limits: knownFacts<=3, unknownFacts<=3, riskFlags<=3; each item<=180 characters; recommendedAction<=240 characters. Use empty arrays when needed.
Return exactly:
{"scores":{"verification":0,"urgency":0,"actionability":0},"knownFacts":[],"unknownFacts":[],"riskFlags":[],"recommendedAction":"string"}`;

const REVIEWER_SYSTEM_PROMPT = `${COMMON_SAFETY_RULES}
You are a blind, independent Reviewer. Assess only original reports; never infer or discuss Analyst output.
Limits: counterEvidence<=3, unknowns<=3; each item<=180 characters; conclusion<=240 characters. Use empty arrays when needed. duplicateRisk must be exactly Low, Medium, or High.
Return exactly:
{"scores":{"verification":0,"urgency":0,"actionability":0},"counterEvidence":[],"unknowns":[],"duplicateRisk":"Low","conclusion":"string"}`;

class IncidentPipelineError extends Error {
  constructor(code, message, { retryable = false, role, issues = [] } = {}) {
    super(message);
    this.name = "IncidentPipelineError";
    this.code = code;
    this.retryable = retryable;
    if (["analyst", "reviewer", "both"].includes(role)) this.role = role;
    const safeIssues = sanitizeIssues(issues);
    if (safeIssues.length) this.issues = safeIssues;
  }

  toPublicError() {
    const result = {
      code: this.code,
      message: this.message,
      retryable: this.retryable
    };
    if (this.role) result.role = this.role;
    if (this.issues) result.issues = [...this.issues];
    return result;
  }
}

const ISSUE_PATHS = new Set([
  "payload",
  "scores.verification",
  "scores.urgency",
  "scores.actionability",
  "recommendedAction"
]);
const ISSUE_REASONS = new Set([
  "missing",
  "not_numeric",
  "out_of_range",
  "not_object",
  "unsafe_execution_claim"
]);

function sanitizeIssues(issues) {
  if (!Array.isArray(issues)) return [];
  const safe = [];
  for (const issue of issues) {
    if (typeof issue !== "string") continue;
    const separator = issue.lastIndexOf(":");
    if (separator < 1) continue;
    const path = issue.slice(0, separator);
    const reason = issue.slice(separator + 1);
    if (!ISSUE_PATHS.has(path) || !ISSUE_REASONS.has(reason)) continue;
    if (!safe.includes(`${path}:${reason}`)) safe.push(`${path}:${reason}`);
    if (safe.length === 5) break;
  }
  return safe;
}

function invalidRequest() {
  return new IncidentPipelineError(
    "INVALID_REQUEST",
    "Request messages must contain one or two non-empty strings, or the supported CASE 01 scenario."
  );
}

function invalidModelData(role, issues) {
  const displayRole = role === "analyst" ? "Analyst" : role === "reviewer" ? "Reviewer" : "One or more";
  return new IncidentPipelineError(
    "INVALID_MODEL_DATA",
    `${displayRole} model data was invalid.`,
    { role, issues }
  );
}

function validateMessageArray(messages, { min, max }) {
  if (!Array.isArray(messages) || messages.length < min || messages.length > max) {
    throw invalidRequest();
  }
  return messages.map(message => {
    if (typeof message !== "string") throw invalidRequest();
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > MAX_MESSAGE_LENGTH) throw invalidRequest();
    return trimmed;
  });
}

function validateAnalyzeRequest(payload) {
  if (!isObject(payload)) throw invalidRequest();

  if (Object.hasOwn(payload, "scenario")) {
    if (payload.scenario !== CASE_01_SCENARIO) throw invalidRequest();
    const messages = validateMessageArray(payload.messages, { min: 2, max: 20 });
    return {
      scenario: CASE_01_SCENARIO,
      source: "Hostel Telegram",
      messages: messages.slice(0, 2),
      receivedMessageCount: messages.length,
      processedMessageCount: 2,
      isScenario: true
    };
  }

  const messages = validateMessageArray(payload.messages, { min: 1, max: 2 });
  return {
    scenario: null,
    source: "Manual intake",
    messages,
    receivedMessageCount: messages.length,
    processedMessageCount: messages.length,
    isScenario: false
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickField(value, camelCase, snakeCase) {
  if (Object.hasOwn(value, camelCase)) return value[camelCase];
  if (snakeCase && Object.hasOwn(value, snakeCase)) return value[snakeCase];
  return undefined;
}

function normalizeText(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function normalizeStringArray(value, { maxItems, maxLength }) {
  if (value === null || value === undefined) return [];
  const source = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const result = [];
  for (const item of source) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().slice(0, maxLength);
    if (normalized && !result.includes(normalized)) result.push(normalized);
    if (result.length === maxItems) break;
  }
  return result;
}

function normalizeScore(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const converted = Number(trimmed);
  return Number.isFinite(converted) ? converted : null;
}

function normalizeScores(value, issues) {
  const scoresObject = isObject(value) ? value : {};
  const scores = {};
  for (const axis of SCORE_AXES) {
    const direct = Object.hasOwn(scoresObject, axis)
      ? scoresObject[axis]
      : scoresObject[`${axis}_score`];
    const path = `scores.${axis}`;
    if (direct === undefined || direct === null || direct === "") {
      issues.push(`${path}:missing`);
      continue;
    }
    const score = normalizeScore(direct);
    if (score === null) {
      issues.push(`${path}:not_numeric`);
      continue;
    }
    if (score < 0 || score > 100) {
      issues.push(`${path}:out_of_range`);
      continue;
    }
    scores[axis] = score;
  }
  return scores;
}

function normalizeDuplicateRisk(value) {
  if (typeof value !== "string") return "High";
  const normalized = value.trim().toLowerCase();
  if (normalized === "low") return "Low";
  if (normalized === "medium") return "Medium";
  if (normalized === "high") return "High";
  return "High";
}

function containsExecutionClaim(value) {
  return /\b(?:already|was|were|has been|have been)\s+(?:dispatched|approved|contacted|treated|completed)\b/i.test(value);
}

function normalizeAnalystData(value) {
  if (!isObject(value)) throw invalidModelData("analyst", ["payload:not_object"]);
  const issues = [];
  const recommendedAction = normalizeText(
    pickField(value, "recommendedAction", "recommended_action"),
    "Verify the report and obtain human approval before any dispatch.",
    240
  );
  if (containsExecutionClaim(recommendedAction)) issues.push("recommendedAction:unsafe_execution_claim");
  const normalized = {
    scores: normalizeScores(value.scores, issues),
    knownFacts: normalizeStringArray(pickField(value, "knownFacts", "known_facts"), { maxItems: 3, maxLength: 180 }),
    unknownFacts: normalizeStringArray(pickField(value, "unknownFacts", "unknown_facts"), { maxItems: 3, maxLength: 180 }),
    riskFlags: normalizeStringArray(pickField(value, "riskFlags", "risk_flags"), { maxItems: 3, maxLength: 180 }),
    recommendedAction
  };
  if (issues.length) throw invalidModelData("analyst", issues);
  return normalized;
}

function normalizeReviewerData(value) {
  if (!isObject(value)) throw invalidModelData("reviewer", ["payload:not_object"]);
  const issues = [];
  const normalized = {
    scores: normalizeScores(value.scores, issues),
    counterEvidence: normalizeStringArray(
      pickField(value, "counterEvidence", "counter_evidence"),
      { maxItems: 3, maxLength: 180 }
    ),
    unknowns: normalizeStringArray(value.unknowns, { maxItems: 3, maxLength: 180 }),
    duplicateRisk: normalizeDuplicateRisk(pickField(value, "duplicateRisk", "duplicate_risk")),
    conclusion: normalizeText(
      value.conclusion,
      "Reviewer did not provide a structured conclusion; human review remains required.",
      240
    )
  };
  if (issues.length) throw invalidModelData("reviewer", issues);
  return normalized;
}

const validateAnalystData = normalizeAnalystData;
const validateReviewerData = normalizeReviewerData;

function computeConsensus(analystScores, reviewerScores) {
  const scores = {};
  const gaps = {};
  for (const axis of SCORE_AXES) {
    scores[axis] = Math.round((analystScores[axis] + reviewerScores[axis]) / 2);
    gaps[axis] = Math.abs(analystScores[axis] - reviewerScores[axis]);
  }
  const maxScoreGap = Math.max(...Object.values(gaps));
  const level = maxScoreGap <= 15
    ? "AGREEMENT"
    : maxScoreGap <= 30
      ? "DISAGREEMENT"
      : "CRITICAL_CONFLICT";
  return { scores, gaps, maxScoreGap, level };
}

function hasMedicalRedFlag(messages, assessment = {}) {
  const searchable = [...messages, ...(assessment.riskFlags || [])].join(" ").toLowerCase();
  return /breathing difficulty|cannot breathe|unconscious|asthma|severe coughing|active fire|smoke inhalation/.test(searchable);
}

function deriveLocation(request) {
  const evidence = request.messages.join(" ");
  if (request.isScenario && /block\s+c/i.test(evidence)) {
    return /lobby/i.test(evidence) ? "Block C lobby" : "Hostel Block C";
  }
  const match = evidence.match(/\b(?:(?:hostel\s+)?block\s+[A-Za-z0-9-]+(?:\s+lobby)?|room\s+[A-Za-z0-9-]+|hostel\s+[A-Za-z0-9-]+)\b/i);
  if (match) return match[0];
  return "Unknown location";
}

function extractPeopleCount(messages) {
  const numberWords = Object.freeze({
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10
  });
  const evidence = messages.join(" ");
  const match = evidence.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:students?|residents?|people|persons?|patients?)\b/i);
  if (!match) return null;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : numberWords[match[1].toLowerCase()] ?? null;
}

function extractNeeds(messages) {
  const evidence = messages.join(" ");
  const needs = [];
  if (/\bn95\b|\bmasks?\b/i.test(evidence)) needs.push("N95 masks");
  if (/\bwater\b|hydration/i.test(evidence)) needs.push("Water packs");
  if (/clinic\s+transport|transport\s+to\s+(?:a\s+)?clinic/i.test(evidence)) needs.push("Clinic transport");
  if (/medical\s+volunteer|volunteer\s+medic/i.test(evidence)) needs.push("Medical volunteer");
  if (/safe\s+room|indoor\s+(?:room|shelter)/i.test(evidence)) needs.push("Indoor safe room");
  return needs;
}

function extractRiskFlags(messages) {
  const evidence = messages.join(" ");
  const flags = [];
  if (/coughing\s+badly|severe\s+cough/i.test(evidence)) flags.push("severe coughing");
  if (/\basthma\b/i.test(evidence)) flags.push("asthma");
  if (/heavy\s+smoke|smoke\s+smell|\bhaze\b/i.test(evidence)) flags.push("smoke exposure");
  if (/breathing\s+difficulty|cannot\s+breathe/i.test(evidence)) flags.push("breathing difficulty");
  if (/active\s+fire/i.test(evidence)) flags.push("active fire");
  return flags;
}

function isActionableLocation(request, location) {
  if (typeof location !== "string" ||
      /^(?:unknown|unclear|not provided|n\/a)|\bnearby\b|\bsomewhere\b/i.test(location.trim())) {
    return false;
  }
  const evidence = request.messages.join(" ");
  return /\b(?:hostel|block|room|lobby)\s+[A-Za-z0-9-]+/i.test(evidence);
}

function hasContactPath(request) {
  if (request.isScenario) return true;
  return /\b(?:telegram|whatsapp|coordinator|warden|callback|contact|phone|email)\b|\+?\d[\d\s-]{6,}\d/i
    .test(request.messages.join(" "));
}

function canonicalResource(need) {
  const normalized = need.toLowerCase();
  if (/n95|mask/.test(normalized)) return "N95 masks";
  if (/water/.test(normalized)) return "Water packs";
  if (/clinic|transport/.test(normalized)) return "Clinic transport";
  if (/medical volunteer|volunteer/.test(normalized)) return "Medical volunteer";
  if (/safe room|indoor/.test(normalized)) return "Indoor safe room";
  return null;
}

function availableResourcesForNeeds(needs) {
  return [...new Set(needs.map(canonicalResource).filter(Boolean))];
}

function buildSafetyGates({ request, assessment, consensus, location }) {
  const medical = hasMedicalRedFlag(request.messages, assessment);
  const locationPassed = isActionableLocation(request, location);
  const contactPassed = hasContactPath(request);
  const matchedResources = availableResourcesForNeeds(assessment.needs);
  const resourcePassed = assessment.needs.length > 0 && matchedResources.length === assessment.needs.length;
  const conflictPassed = consensus.level !== "CRITICAL_CONFLICT";
  const dispatchPassed = locationPassed && contactPassed && resourcePassed && conflictPassed;

  return {
    flags: { medical, locationPassed, contactPassed, resourcePassed, conflictPassed, dispatchPassed },
    matchedResources,
    gates: [
      {
        id: "G_MEDICAL",
        label: "Medical Red Flag",
        status: medical ? "triggered" : "passed",
        passed: true,
        detail: medical
          ? "Respiratory or medical red flag detected; urgent human verification or official escalation is required."
          : "No configured medical red flag was detected."
      },
      {
        id: "G_LOCATION",
        label: "Actionable Location",
        status: locationPassed ? "passed" : "blocked",
        passed: locationPassed,
        detail: locationPassed ? `${location} is actionable.` : "An actionable room, lobby, hostel, or block is missing."
      },
      {
        id: "G_CONTACT",
        label: "Contact Path",
        status: contactPassed ? "passed" : "blocked",
        passed: contactPassed,
        detail: contactPassed
          ? request.isScenario
            ? "Hostel Telegram coordinator contact path is available."
            : "A contact path is present in the submitted evidence."
          : "No contact or callback path is present; none was invented."
      },
      {
        id: "G_RESOURCE",
        label: "Resource Availability",
        status: resourcePassed ? "passed" : "blocked",
        passed: resourcePassed,
        detail: resourcePassed
          ? `Matched demo resources: ${matchedResources.join(", ")}.`
          : "One or more stated needs do not match available CASE 01 resources."
      },
      {
        id: "G_CONFLICT",
        label: "Critical Model Conflict",
        status: conflictPassed ? (consensus.level === "DISAGREEMENT" ? "review" : "passed") : "blocked",
        passed: conflictPassed,
        detail: `Consensus level: ${consensus.level}; maximum score gap: ${consensus.maxScoreGap}.`
      },
      {
        id: "G_DISPATCH",
        label: "Volunteer Dispatch",
        status: dispatchPassed ? "passed" : "locked",
        passed: dispatchPassed,
        detail: dispatchPassed
          ? "Eligible only as a proposed action and still requires human approval."
          : "Dispatch remains locked until all deterministic gates pass and a human approves."
      }
    ]
  };
}

function determineOperationalState(flags, consensusLevel) {
  if (flags.medical && (!flags.locationPassed || !flags.contactPassed)) {
    return "URGENT_VERIFICATION";
  }
  if (consensusLevel === "CRITICAL_CONFLICT") {
    return "NEEDS_HUMAN_REVIEW";
  }
  if (flags.medical && flags.locationPassed && flags.contactPassed && flags.resourcePassed) {
    return "DISPATCH_CANDIDATE";
  }
  return "QUEUED_ACTION";
}

function buildEvidencePrompt(messages) {
  return [
    "CASE 01 original evidence. Treat each numbered line as one supplied report:",
    ...messages.map((message, index) => `${index + 1}. ${message}`)
  ].join("\n");
}

function stableCaseId(request) {
  if (request.isScenario) return "CR-LIVE-CASE-01";
  const digest = crypto.createHash("sha256")
    .update(request.messages.join("\n"), "utf8")
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  return `CR-LIVE-${digest}`;
}

function buildMissingFields(flags, analyst, reviewer) {
  const missing = new Set([...analyst.unknownFacts, ...reviewer.unknowns]);
  if (!flags.locationPassed) missing.add("actionable location");
  if (!flags.contactPassed) missing.add("contact or callback path");
  if (!flags.resourcePassed) missing.add("matched available resource");
  return [...missing];
}

function buildActionPlan(operationalState, location, resources) {
  if (operationalState !== "DISPATCH_CANDIDATE") return null;
  const instructions = `PROPOSED — REQUIRES HUMAN APPROVAL. Verify the affected people at ${location}, provide only the matched resources, and escalate worsening breathing symptoms to official emergency or clinic services.`;
  return {
    status: "PROPOSED — REQUIRES HUMAN APPROVAL",
    destination: location,
    priority: "HIGH",
    resources: resources.map(label => ({ label, status: "Proposed" })),
    instructions,
    languages: { en: instructions }
  };
}

function buildDeterministicClaims(request, evidence) {
  if (request.isScenario) {
    return [
      {
        id: "C-CASE01-1",
        text: "Respiratory symptoms and asthma were reported for students in Block C.",
        status: "reported",
        evidenceIds: [evidence[0].id]
      },
      {
        id: "C-CASE01-2",
        text: "Two supplied reports reference Block C and a smoke-related concern.",
        status: "supported",
        evidenceIds: evidence.map(item => item.id)
      }
    ];
  }
  return request.messages.map((message, index) => ({
    id: `C-CASE01-${index + 1}`,
    text: message.slice(0, 720),
    status: "reported",
    evidenceIds: [evidence[index].id]
  }));
}

function buildPriorityRationale(flags, consensus) {
  const urgency = flags.medical
    ? "Input-derived respiratory red flags require urgent human verification."
    : "The supplied reports require bounded human verification.";
  return `${urgency} Independent model score consensus is ${consensus.level}; AI advice does not authorize dispatch.`;
}

function buildSafeNextActions(flags) {
  const actions = [
    flags.contactPassed
      ? "Verify the current situation through the available coordinator or contact path."
      : "Obtain a reliable contact or callback path before operational action.",
    "Confirm the actionable location, affected-person count, and requested resources before any dispatch."
  ];
  if (flags.medical) {
    actions.push("Escalate worsening breathing symptoms to official clinic or emergency services.");
  }
  return actions;
}

function buildIncident({ request, analyst, reviewer, analystTrace, reviewerTrace, now }) {
  const consensus = computeConsensus(analyst.scores, reviewer.scores);
  const location = deriveLocation(request);
  const peopleCount = extractPeopleCount(request.messages);
  const needs = extractNeeds(request.messages);
  const riskFlags = extractRiskFlags(request.messages);
  const assessment = { needs, riskFlags };
  const safety = buildSafetyGates({ request, assessment, consensus, location });
  const operationalState = determineOperationalState(safety.flags, consensus.level);
  const receivedAt = now.toISOString();
  const uncertainties = [...new Set([...analyst.unknownFacts, ...reviewer.unknowns])];
  const evidence = request.messages.map((message, index) => ({
    id: `E-CASE01-${index + 1}`,
    type: request.isScenario ? "Hostel Telegram report" : "Manual intake report",
    summary: message,
    retrievedAt: receivedAt,
    reliability: index === 0
      ? "Reported source; not independently verified by AI."
      : "Separate supplied report; source identity not independently verified by AI.",
    contradictions: "None deterministically established.",
    uncertainties
  }));
  const claims = buildDeterministicClaims(request, evidence);
  const disagreementAxes = SCORE_AXES.filter(axis => consensus.gaps[axis] > 15);
  const agreementAxes = SCORE_AXES.filter(axis => consensus.gaps[axis] <= 15);
  const priorityRationale = buildPriorityRationale(safety.flags, consensus);
  const safeNextActions = buildSafeNextActions(safety.flags);

  return {
    caseId: stableCaseId(request),
    label: "01",
    title: request.isScenario ? "Block C Respiratory Cluster" : "Crisis report under review",
    rawMessage: request.messages.join("\n"),
    source: request.source,
    receivedAt,
    location,
    peopleCount,
    needs,
    riskFlags,
    knownFacts: analyst.knownFacts,
    unknownFacts: analyst.unknownFacts,
    priorityRationale,
    safeNextActions,
    claims,
    evidence,
    scores: consensus.scores,
    operationalState,
    missingFields: buildMissingFields(safety.flags, analyst, reviewer),
    modelDebate: {
      agreement: agreementAxes.map(axis => `${axis} scores are within the agreement threshold.`),
      disagreement: disagreementAxes.map(axis => `${axis} score gap is ${consensus.gaps[axis]}.`),
      counterEvidence: reviewer.counterEvidence,
      consensus: consensus.level,
      maxScoreGap: consensus.maxScoreGap,
      scoreGaps: consensus.gaps
    },
    modelReviews: {
      analyst: {
        conclusion: analyst.recommendedAction,
        evidenceCited: evidence.map(item => item.id),
        scores: analyst.scores,
        rationale: "Independent scores and bounded evidence notes; final operational rules are deterministic."
      },
      reviewer: {
        conclusion: reviewer.conclusion,
        counterEvidence: reviewer.counterEvidence,
        unknowns: reviewer.unknowns,
        duplicateRisk: reviewer.duplicateRisk,
        scores: reviewer.scores,
        rationale: reviewer.conclusion,
        safetyConcerns: []
      }
    },
    safetyGates: safety.gates,
    recommendedAction: analyst.recommendedAction,
    actionPlan: buildActionPlan(operationalState, location, safety.matchedResources),
    actionBrief: null,
    proofCapsule: null,
    gonka: {
      mode: "live",
      analyst: {
        model: analystTrace.model,
        responseId: analystTrace.responseId,
        promptVersion: ANALYST_PROMPT_VERSION,
        latencyMs: analystTrace.latencyMs
      },
      reviewer: {
        model: reviewerTrace.model,
        responseId: reviewerTrace.responseId,
        promptVersion: REVIEWER_PROMPT_VERSION,
        latencyMs: reviewerTrace.latencyMs
      }
    },
    humanDecision: null
  };
}

function safeRoleFailure(settledResults) {
  const roles = [
    { display: "Analyst", value: "analyst" },
    { display: "Reviewer", value: "reviewer" }
  ];
  const failures = settledResults
    .map((result, index) => ({ result, role: roles[index] }))
    .filter(item => item.result.status === "rejected");
  if (!failures.length) return;

  const timedOut = failures.filter(item => item.result.reason?.code === "TIMEOUT");
  if (timedOut.length) {
    const message = timedOut.length === 1
      ? `${timedOut[0].role.display} model timed out.`
      : "One or more models timed out.";
    throw new IncidentPipelineError("TIMEOUT", message, {
      retryable: true,
      role: timedOut.length === 1 ? timedOut[0].role.value : "both"
    });
  }

  const invalid = failures.filter(item =>
    ["INVALID_JSON", "INVALID_RESPONSE", "INVALID_MODEL_DATA"].includes(item.result.reason?.code));
  if (invalid.length) {
    const role = invalid.length === 1 ? invalid[0].role.value : "both";
    throw invalidModelData(role, ["payload:not_object"]);
  }

  const firstReason = failures[0].result.reason;
  if (firstReason instanceof GonkaClientError || firstReason instanceof IncidentPipelineError) {
    throw firstReason;
  }
  throw new IncidentPipelineError("UPSTREAM_ERROR", "One or more model requests failed.", { retryable: true });
}

function validateRoleData(role, validator, data) {
  try {
    return validator(data);
  } catch (error) {
    if (error instanceof IncidentPipelineError && error.code === "INVALID_MODEL_DATA") {
      throw error;
    }
    throw invalidModelData(role, ["payload:not_object"]);
  }
}

async function analyzeCase01({ payload, client, now = new Date() }) {
  const request = validateAnalyzeRequest(payload);
  if (!client || typeof client.completeJson !== "function") {
    throw new IncidentPipelineError("CONFIGURATION_ERROR", "Live analysis is not configured.");
  }

  const evidencePrompt = buildEvidencePrompt(request.messages);
  const analystRequest = {
    model: DEFAULT_MODELS.analyst,
    messages: [
      { role: "system", content: ANALYST_SYSTEM_PROMPT },
      { role: "user", content: evidencePrompt }
    ],
    temperature: 0,
    maxTokens: 600,
    timeoutMs: ANALYST_TIMEOUT_MS
  };
  const reviewerRequest = {
    model: DEFAULT_MODELS.reviewer,
    messages: [
      { role: "system", content: REVIEWER_SYSTEM_PROMPT },
      { role: "user", content: evidencePrompt }
    ],
    temperature: 0,
    maxTokens: 500,
    timeoutMs: REVIEWER_TIMEOUT_MS
  };

  const settledResults = await Promise.allSettled([
    client.completeJson(analystRequest),
    client.completeJson(reviewerRequest)
  ]);
  safeRoleFailure(settledResults);
  const analystResult = settledResults[0].value;
  const reviewerResult = settledResults[1].value;
  const analyst = validateRoleData("analyst", normalizeAnalystData, analystResult.data);
  const reviewer = validateRoleData("reviewer", normalizeReviewerData, reviewerResult.data);
  const incident = buildIncident({
    request,
    analyst,
    reviewer,
    analystTrace: analystResult.trace,
    reviewerTrace: reviewerResult.trace,
    now: now instanceof Date ? now : new Date(now)
  });

  return {
    resources: [],
    rawReports: [],
    incidents: [incident],
    meta: {
      mode: "live",
      slice: "CASE_01",
      partial: true,
      receivedMessageCount: request.receivedMessageCount,
      processedMessageCount: request.processedMessageCount
    }
  };
}

module.exports = {
  ANALYST_PROMPT_VERSION,
  REVIEWER_PROMPT_VERSION,
  ANALYST_TIMEOUT_MS,
  REVIEWER_TIMEOUT_MS,
  IncidentPipelineError,
  validateAnalyzeRequest,
  normalizeAnalystData,
  normalizeReviewerData,
  validateAnalystData,
  validateReviewerData,
  computeConsensus,
  hasMedicalRedFlag,
  deriveLocation,
  extractPeopleCount,
  extractNeeds,
  extractRiskFlags,
  buildSafetyGates,
  determineOperationalState,
  analyzeCase01
};
