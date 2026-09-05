const crypto = require("node:crypto");
const {
  DEFAULT_MODELS,
  MAX_JSON_CANDIDATES,
  extractStructuredJsonCandidates,
  recordGonkaModelDataDiagnostic
} = require("./gonkaClient");
const {
  SCENARIO_ID,
  CASE_LABELS,
  isCanonicalHazeMessages,
  createHazeScenarioCases,
  cloneResources
} = require("./hazeScenario");

const ANALYST_PROMPT_VERSION = "analyst-v1.1-minimal";
const REVIEWER_PROMPT_VERSION = "reviewer-v1.1-minimal";
const ANALYST_TIMEOUT_MS = 45_000;
const REVIEWER_TIMEOUT_MS = 45_000;
const CASE_01_SCENARIO = SCENARIO_ID;
const MAX_MESSAGE_LENGTH = 4_000;
const ANALYST_BATCH_PROMPT_VERSION = "analyst-batch-v1.0";
const REVIEWER_BATCH_PROMPT_VERSION = "reviewer-batch-v1.1-minimal-scores";
const ANALYST_BATCH_MAX_TOKENS = 1_100;
const REVIEWER_BATCH_MAX_TOKENS = 1_200;
const BATCH_REVIEWER_TIMEOUT_MS = 60_000;

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

const BATCH_COMMON_RULES = `
AI advises; humans decide. Use only the five supplied case evidence blocks.
LOW VERIFICATION DOES NOT MEAN LOW URGENCY. Do not invent corroboration, contact, approval, dispatch, treatment, delivery, or rescue.
Return one compact JSON object only. It must contain exactly five unique cases labelled 01 through 05, with all three numeric scores from 0 to 100.
Arrays contain at most two short items. Do not use Markdown, hidden reasoning, or extra fields.`.trim();

const SCORING_RUBRIC = `Score each axis independently; do not average uncertainty across axes.
Verification—how strongly the report is supported: 0-29 single/unverified/anonymous/forwarded/seriously incomplete; 30-59 plausible or partially supported but not independently confirmed; 60-79 corroborated by useful independent evidence; 80-100 strongly corroborated by multiple reliable sources.
Urgency—severity and time-sensitivity of harm IF TRUE: 0-29 routine/little immediate harm; 30-59 time-sensitive but not immediately severe; 60-79 serious harm needing prompt attention; 80-100 immediate threat to life, breathing, health, or public safety. Score harm if true; low verification must not reduce urgency.
Actionability—readiness for a human-approved response: 0-29 essential location/contact/resource/next-step information missing; 30-59 partially actionable with important gaps; 60-79 actionable with minor gaps; 80-100 location, contact path, resources, and next step ready for human approval.`;

const ANALYST_BATCH_SYSTEM_PROMPT = `${BATCH_COMMON_RULES}
${SCORING_RUBRIC}
You are an independent batch Analyst. Assess the original evidence only.
Return exactly: {"cases":[{"label":"01","scores":{"verification":0,"urgency":0,"actionability":0},"riskFlags":[],"unknowns":[]},{"label":"02","scores":{"verification":0,"urgency":0,"actionability":0},"riskFlags":[],"unknowns":[]},{"label":"03","scores":{"verification":0,"urgency":0,"actionability":0},"riskFlags":[],"unknowns":[]},{"label":"04","scores":{"verification":0,"urgency":0,"actionability":0},"riskFlags":[],"unknowns":[]},{"label":"05","scores":{"verification":0,"urgency":0,"actionability":0},"riskFlags":[],"unknowns":[]}]}`;

const REVIEWER_BATCH_SYSTEM_PROMPT = `Independent blind reviewer. Use only supplied facts; do not assume missing facts.
${SCORING_RUBRIC}
Return JSON only, no explanation, Markdown, or extra fields:{"cases":[{"label":"01","scores":{"verification":0,"urgency":0,"actionability":0}},{"label":"02","scores":{"verification":0,"urgency":0,"actionability":0}},{"label":"03","scores":{"verification":0,"urgency":0,"actionability":0}},{"label":"04","scores":{"verification":0,"urgency":0,"actionability":0}},{"label":"05","scores":{"verification":0,"urgency":0,"actionability":0}}]}`;

const SAFE_ROLE_ERROR_CODES = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "HTTP_ERROR",
  "INVALID_MODEL_DATA",
  "RESPONSE_TOO_LARGE"
]);

function sanitizeRoleErrors(roleErrors) {
  if (!roleErrors || typeof roleErrors !== "object" || Array.isArray(roleErrors)) return undefined;
  const safe = {};
  for (const role of ["analyst", "reviewer"]) {
    if (SAFE_ROLE_ERROR_CODES.has(roleErrors[role])) safe[role] = roleErrors[role];
  }
  return Object.keys(safe).length ? safe : undefined;
}

class IncidentPipelineError extends Error {
  constructor(code, message, { retryable = false, role, issues = [], roleErrors, modelDataDiagnostics } = {}) {
    super(message);
    this.name = "IncidentPipelineError";
    this.code = code;
    this.retryable = retryable;
    if (["analyst", "reviewer", "both"].includes(role)) this.role = role;
    const safeIssues = sanitizeIssues(issues);
    if (safeIssues.length) this.issues = safeIssues;
    const safeRoleErrors = sanitizeRoleErrors(roleErrors);
    if (safeRoleErrors) this.roleErrors = safeRoleErrors;
    if (modelDataDiagnostics && typeof modelDataDiagnostics === "object" && !Array.isArray(modelDataDiagnostics)) {
      this.modelDataDiagnostics = modelDataDiagnostics;
    }
  }

  toPublicError() {
    const result = {
      code: this.code,
      message: this.message,
      retryable: this.retryable
    };
    if (this.role) {
      result.role = this.role;
      result.failedRole = this.role;
    }
    if (this.issues) result.issues = [...this.issues];
    if (this.roleErrors) result.roleErrors = { ...this.roleErrors };
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
  "not_array",
  "no_contract_candidate",
  "ambiguous_candidates",
  "direct_array_wrong_length",
  "string_unwrap_failed",
  "candidate_limit_exceeded",
  "nesting_limit_exceeded",
  "invalid_label",
  "duplicate_label",
  "unknown_label",
  "invalid_boolean",
  "unsafe_execution_claim"
]);

function isSafeIssuePath(path) {
  if (ISSUE_PATHS.has(path)) return true;
  return /^(?:cases|cases\.(?:01|02|03|04|05)(?:\.(?:label|scores\.(?:verification|urgency|actionability)|materialConflict))?)$/.test(path);
}

function sanitizeIssues(issues) {
  if (!Array.isArray(issues)) return [];
  const safe = [];
  for (const issue of issues) {
    if (typeof issue !== "string") continue;
    const separator = issue.lastIndexOf(":");
    if (separator < 1) continue;
    const path = issue.slice(0, separator);
    const reason = issue.slice(separator + 1);
    if (!isSafeIssuePath(path) || !ISSUE_REASONS.has(reason)) continue;
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

function invalidScenarioInput() {
  return new IncidentPipelineError(
    "INVALID_SCENARIO_INPUT",
    "The fixed haze demonstration scenario input is invalid."
  );
}

function invalidModelData(role, issues, { modelDataDiagnostics } = {}) {
  const displayRole = role === "analyst" ? "Analyst" : role === "reviewer" ? "Reviewer" : "One or more";
  return new IncidentPipelineError(
    "INVALID_MODEL_DATA",
    `${displayRole} model data was invalid.`,
    { role, issues, modelDataDiagnostics }
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

function normalizeCaseLabel(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 5
      ? String(value).padStart(2, "0")
      : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^0?[1-5]$/.test(trimmed)) return null;
  return String(Number(trimmed)).padStart(2, "0");
}

function normalizeBatchScores(value, issues, label) {
  const localIssues = [];
  const scores = normalizeScores(value, localIssues);
  for (const issue of localIssues) {
    issues.push(`cases.${label}.${issue}`);
  }
  return scores;
}

function normalizeBatchData(value, role) {
  if (!isObject(value)) throw invalidModelData(role, ["payload:not_object"]);
  if (!Array.isArray(value.cases)) throw invalidModelData(role, ["cases:not_array"]);

  const issues = [];
  const byLabel = new Map();
  for (const item of value.cases) {
    if (!isObject(item)) {
      issues.push("cases:not_object");
      continue;
    }
    const label = normalizeCaseLabel(
      Object.hasOwn(item, "label")
        ? item.label
        : Object.hasOwn(item, "caseLabel")
          ? item.caseLabel
          : item.case_label
    );
    if (!label) {
      issues.push("cases:unknown_label");
      continue;
    }
    if (byLabel.has(label)) {
      issues.push(`cases.${label}:duplicate_label`);
      continue;
    }

    const normalized = {
      label,
      scores: normalizeBatchScores(item.scores, issues, label)
    };
    if (role === "analyst") {
      normalized.riskFlags = normalizeStringArray(
        pickField(item, "riskFlags", "risk_flags"),
        { maxItems: 2, maxLength: 120 }
      );
      normalized.unknowns = normalizeStringArray(item.unknowns, { maxItems: 2, maxLength: 120 });
    }
    byLabel.set(label, normalized);
  }

  for (const label of CASE_LABELS) {
    if (!byLabel.has(label)) issues.push(`cases.${label}:missing`);
  }
  if (value.cases.length !== CASE_LABELS.length && !issues.length) {
    issues.push("cases:missing");
  }
  if (issues.length) throw invalidModelData(role, issues);
  return { cases: CASE_LABELS.map(label => byLabel.get(label)) };
}

function normalizeBatchAnalystData(value) {
  return normalizeBatchData(value, "analyst");
}

function normalizeBatchReviewerData(value) {
  return normalizeBatchData(value, "reviewer");
}

function mergeModelDataDiagnostics(...items) {
  const merged = {};
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const [key, value] of Object.entries(item)) {
      if (Array.isArray(value)) {
        const existing = Array.isArray(merged[key]) ? merged[key] : [];
        merged[key] = [...new Set([...existing, ...value].filter(entry => typeof entry === "string"))].slice(0, 12);
      } else if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

const PRESENTATION_WRAPPER_KEYS = new Set([
  "answer",
  "assessment",
  "content",
  "data",
  "final",
  "finalAnswer",
  "final_answer",
  "json",
  "message",
  "output",
  "output_text",
  "payload",
  "response",
  "result",
  "results",
  "review",
  "reviewer",
  "structured",
  "structured_output",
  "text"
]);
const MAX_PRESENTATION_WRAPPER_DEPTH = 4;

function normalizeCandidateBatchLabel(item) {
  if (!isObject(item)) return null;
  const value = Object.hasOwn(item, "label")
    ? item.label
    : Object.hasOwn(item, "caseLabel")
      ? item.caseLabel
      : item.case_label;
  return normalizeCaseLabel(value);
}

function looksLikeDirectBatchArray(value) {
  return Array.isArray(value) &&
    value.length === CASE_LABELS.length &&
    value.every(item => normalizeCandidateBatchLabel(item) !== null);
}

function stripOuterMarkdownFence(value) {
  const match = value.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/);
  return match ? match[1].trim() : "";
}

function parsePresentationText(value) {
  const texts = [value];
  const stripped = stripOuterMarkdownFence(value.trim());
  if (stripped) texts.push(stripped);

  const parsed = [];
  for (const text of texts) {
    try {
      const extracted = extractStructuredJsonCandidates(text);
      for (const candidate of extracted.candidates) {
        if (candidate.kind === "object" || candidate.kind === "array") {
          parsed.push(candidate.value);
        }
      }
    } catch {
      // Presentation wrapper text is optional; invalid text remains non-diagnostic.
    }
  }
  return parsed;
}

function diagnosticTopLevelKey(value) {
  if (Array.isArray(value)) return "array";
  if (!isObject(value)) return "wrong_root_type";
  const keys = Object.keys(value)
    .map(key => key.replace(/[^\w:./-]+/g, "_").slice(0, 80))
    .filter(Boolean)
    .slice(0, 6);
  return keys.length ? `object:${keys.join(",")}` : "object";
}

function addDiagnosticReason(reasons, reason) {
  const safe = sanitizeIssues([reason]);
  if (safe.length && !reasons.includes(safe[0]) && reasons.length < 12) reasons.push(safe[0]);
}

function addDiagnosticReasons(reasons, issues, fallback = "payload:not_object") {
  const safe = sanitizeIssues(Array.isArray(issues) && issues.length ? issues : [fallback]);
  for (const issue of safe) {
    if (!reasons.includes(issue)) reasons.push(issue);
    if (reasons.length === 12) break;
  }
}

function wrapperKeysFor(value) {
  const keys = Object.keys(value);
  const wrappers = keys.filter(key => PRESENTATION_WRAPPER_KEYS.has(key));
  if (wrappers.length) return wrappers;
  if (keys.length === 1 && !Object.hasOwn(value, "cases") && !Object.hasOwn(value, "scores")) {
    return keys;
  }
  return [];
}

function expandPresentationWrappedValues(root, { allowDirectBatchArray = false } = {}) {
  const expanded = [];
  const seen = new Set();
  const queue = [{ value: root, depth: 0 }];

  while (queue.length && expanded.length < MAX_JSON_CANDIDATES) {
    const { value, depth } = queue.shift();
    if (isObject(value) || Array.isArray(value)) {
      const identity = JSON.stringify(value);
      if (!seen.has(identity)) {
        seen.add(identity);
        expanded.push(value);
      }
      if (depth >= MAX_PRESENTATION_WRAPPER_DEPTH) continue;

      if (Array.isArray(value)) {
        if (!allowDirectBatchArray) continue;
        if (looksLikeDirectBatchArray(value) || value.length > MAX_JSON_CANDIDATES) continue;
        for (const item of value) {
          if (isObject(item) || typeof item === "string") queue.push({ value: item, depth: depth + 1 });
        }
        continue;
      }

      for (const key of wrapperKeysFor(value)) {
        const nested = value[key];
        if (isObject(nested) || Array.isArray(nested) || typeof nested === "string") {
          queue.push({ value: nested, depth: depth + 1 });
        }
      }
      continue;
    }

    if (typeof value === "string" && depth < MAX_PRESENTATION_WRAPPER_DEPTH) {
      for (const parsed of parsePresentationText(value)) {
        queue.push({ value: parsed, depth: depth + 1 });
      }
    }
  }

  return expanded;
}

function selectContractCandidate(extracted, { role, validator, allowDirectBatchArray = false }) {
  const candidates = Array.isArray(extracted?.candidates) ? extracted.candidates : [];
  const diagnostics = Array.isArray(extracted?.issues) ? [...extracted.issues] : [];
  const distinct = new Map();
  const candidateTopLevelKeys = [];
  const candidateRejectionReasons = [];

  for (const candidate of candidates) {
    if (!candidate || !["object", "array"].includes(candidate.kind)) {
      addDiagnosticReason(candidateRejectionReasons, "payload:not_object");
      continue;
    }
    for (const candidateValue of expandPresentationWrappedValues(candidate.value, { allowDirectBatchArray })) {
      let value = candidateValue;
      const topLevelKey = diagnosticTopLevelKey(value);
      if (!candidateTopLevelKeys.includes(topLevelKey) && candidateTopLevelKeys.length < 8) {
        candidateTopLevelKeys.push(topLevelKey);
      }
      if (Array.isArray(value)) {
        if (!allowDirectBatchArray) {
          addDiagnosticReason(candidateRejectionReasons, "payload:not_object");
          continue;
        }
        if (value.length !== CASE_LABELS.length) {
          diagnostics.push("payload:direct_array_wrong_length");
          addDiagnosticReason(candidateRejectionReasons, "payload:direct_array_wrong_length");
          continue;
        }
        const directLabels = value.map(normalizeCandidateBatchLabel);
        if (
          directLabels.some(label => !CASE_LABELS.includes(label)) ||
          new Set(directLabels).size !== CASE_LABELS.length ||
          CASE_LABELS.some(label => !directLabels.includes(label))
        ) {
          addDiagnosticReason(candidateRejectionReasons, "cases:unknown_label");
          continue;
        }
        value = { cases: value };
      }

      try {
        const normalized = validator(value);
        const identity = JSON.stringify(normalized);
        if (!distinct.has(identity)) distinct.set(identity, normalized);
      } catch (error) {
        if (!(error instanceof IncidentPipelineError) || error.code !== "INVALID_MODEL_DATA") {
          throw error;
        }
        addDiagnosticReasons(candidateRejectionReasons, error.issues);
      }
    }
  }

  if (distinct.size === 1) return distinct.values().next().value;

  const issues = distinct.size > 1
    ? ["payload:ambiguous_candidates"]
    : [
        "payload:no_contract_candidate",
        ...diagnostics.filter(issue => typeof issue === "string" && issue.startsWith("payload:"))
      ];
  throw invalidModelData(role, issues, {
    modelDataDiagnostics: {
      extractedJsonCandidateCount: candidates.length,
      contractCandidateCount: distinct.size,
      candidateTopLevelKeys,
      candidateRejectionReasons
    }
  });
}

function selectAnalystCandidate(extracted) {
  return selectContractCandidate(extracted, {
    role: "analyst",
    validator: normalizeAnalystData
  });
}

function selectReviewerCandidate(extracted) {
  return selectContractCandidate(extracted, {
    role: "reviewer",
    validator: normalizeReviewerData
  });
}

function selectBatchAnalystCandidate(extracted) {
  return selectContractCandidate(extracted, {
    role: "analyst",
    validator: normalizeBatchAnalystData,
    allowDirectBatchArray: true
  });
}

function selectBatchReviewerCandidate(extracted) {
  return selectContractCandidate(extracted, {
    role: "reviewer",
    validator: normalizeBatchReviewerData,
    allowDirectBatchArray: true
  });
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

function validateFullScenarioRequest(payload) {
  if (!isObject(payload) || payload.scenario !== SCENARIO_ID) throw invalidRequest();
  if (!Array.isArray(payload.messages) || payload.messages.length !== 5) throw invalidScenarioInput();
  const messages = payload.messages.map(message => {
    if (typeof message !== "string") throw invalidScenarioInput();
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > MAX_MESSAGE_LENGTH) throw invalidScenarioInput();
    return trimmed;
  });
  if (!isCanonicalHazeMessages(messages)) throw invalidScenarioInput();
  return {
    scenario: SCENARIO_ID,
    messages,
    cases: createHazeScenarioCases(messages)
  };
}

function buildBatchEvidencePrompt(cases) {
  const blocks = cases.map(item => [
    `CASE${item.label}`,
    `Src: ${item.source}`,
    `Reports: ${item.messages.map((message, index) => `${index + 1}) ${message}`).join(" ")}`,
    `Loc: ${item.locationStatus}`,
    `Con: ${item.contactStatus}`,
    `Res: ${item.resourceStatus}`,
    `Notes: ${item.scenarioNotes.join(" ")}`
  ].join("\n"));
  return ["Five cases.", ...blocks].join("\n\n");
}

function uniqueStrings(values, maxItems = 5) {
  const result = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().slice(0, 180);
    if (normalized && !result.includes(normalized)) result.push(normalized);
    if (result.length === maxItems) break;
  }
  return result;
}

function determineFullScenarioState(facts) {
  if (facts.materialConflict === true) return "NEEDS_HUMAN_REVIEW";
  if (facts.duplicateOrForwardRisk === true) return "MERGE_OR_VERIFY";
  if (facts.medicalRedFlag === true && (!facts.locationKnown || !facts.contactAvailable)) {
    return "URGENT_VERIFICATION";
  }
  if (facts.medicalRedFlag === true && facts.locationKnown === true &&
      facts.contactAvailable === true && facts.relevantResourceAvailable === true) {
    return "DISPATCH_CANDIDATE";
  }
  if (facts.structuredResourceRequest === true && facts.medicalRedFlag !== true) {
    return "QUEUED_ACTION";
  }
  return "NEEDS_HUMAN_REVIEW";
}

function buildFullScenarioGates(caseDefinition, consensus, operationalState) {
  const conflictReview = caseDefinition.materialConflict === true || consensus.level !== "AGREEMENT";
  const dispatchEligible = operationalState === "DISPATCH_CANDIDATE";
  const dispatchPassed = dispatchEligible && consensus.level === "AGREEMENT";
  const dispatchStatus = dispatchPassed ? "passed" : dispatchEligible ? "review" : "locked";
  return [
    {
      id: "G_MEDICAL",
      label: "Medical Red Flag",
      status: caseDefinition.medicalRedFlag ? "triggered" : "passed",
      passed: true,
      detail: caseDefinition.medicalRedFlag
        ? "Input evidence contains a respiratory medical red flag requiring human attention."
        : "No immediate medical red flag is present in the supplied scenario evidence."
    },
    {
      id: "G_LOCATION",
      label: "Actionable Location",
      status: caseDefinition.locationKnown ? "passed" : "blocked",
      passed: caseDefinition.locationKnown,
      detail: caseDefinition.locationStatus
    },
    {
      id: "G_CONTACT",
      label: "Contact Path",
      status: caseDefinition.contactAvailable ? "passed" : "blocked",
      passed: caseDefinition.contactAvailable,
      detail: caseDefinition.contactStatus
    },
    {
      id: "G_RESOURCE",
      label: "Resource Availability",
      status: caseDefinition.relevantResourceAvailable ? "passed" : "blocked",
      passed: caseDefinition.relevantResourceAvailable,
      detail: caseDefinition.resourceStatus
    },
    {
      id: "G_CONFLICT",
      label: "Evidence / Model Conflict",
      status: conflictReview ? "review" : "passed",
      passed: !conflictReview,
      detail: caseDefinition.materialConflict
        ? `Material scenario conflict requires human review; model score consensus is ${consensus.level}.`
        : consensus.level === "AGREEMENT"
          ? "No material scenario conflict; independent model scores agree."
          : `No material scenario conflict, but model score consensus is ${consensus.level}; human review is required.`
    },
    {
      id: "G_DISPATCH",
      label: "Volunteer Dispatch",
      status: dispatchStatus,
      passed: dispatchPassed,
      detail: dispatchEligible
        ? consensus.level === "AGREEMENT"
          ? "PROPOSED ONLY — eligible for explicit human approval; nothing has been dispatched."
          : `PROPOSED ONLY — ${consensus.level} requires human review before any approval or dispatch.`
        : "Dispatch is locked; the AI has not contacted, dispatched, delivered, or rescued anyone."
    }
  ];
}

function fullScenarioRecommendation(label) {
  const recommendations = {
    "01": "Propose masks and clinic-transport standby for Block C; verify current conditions and require human approval before dispatch.",
    "02": "Merge the forwarded item with related reports or verify its original source, exact location and callback contact before action.",
    "03": "Urgently verify by callback, determine the exact location, and follow official emergency medical guidance for worsening breathing difficulty.",
    "04": "Request authoritative organizer confirmation before publishing any proceed-or-cancel instruction.",
    "05": "Queue water, masks and an indoor safe room; record the air purifier as unmet and do not claim delivery."
  };
  return recommendations[label];
}

function deterministicReviewFacts(label) {
  const facts = {
    "01": { counterEvidence: ["No clinical assessment is supplied."], duplicateRisk: "Low", materialConflict: false },
    "02": { counterEvidence: ["Forwarding does not establish independent corroboration."], duplicateRisk: "High", materialConflict: false },
    "03": { counterEvidence: ["Exact location and callback contact are missing."], duplicateRisk: "Low", materialConflict: false },
    "04": { counterEvidence: ["Proceed and cancellation notices materially conflict."], duplicateRisk: "Low", materialConflict: true },
    "05": { counterEvidence: ["Air-purifier availability is not established."], duplicateRisk: "Low", materialConflict: false }
  };
  return facts[label];
}

function fullScenarioSafeActions(label) {
  const actions = {
    "01": ["Confirm the affected people and current respiratory condition.", "Seek human approval before any bounded resource dispatch."],
    "02": ["Find the original source and merge duplicate forwards.", "Obtain an exact location and reliable callback contact."],
    "03": ["Call back urgently and determine the exact location.", "Use official emergency medical guidance if symptoms worsen."],
    "04": ["Escalate the conflicting notices to an authorized organizer.", "Hold definitive public instructions until the conflict is resolved."],
    "05": ["Queue available water, masks and indoor safe-room support.", "Confirm air-purifier availability before promising it."]
  };
  return actions[label];
}

function buildFullScenarioActionPlan(caseDefinition, operationalState) {
  if (operationalState !== "DISPATCH_CANDIDATE") return null;
  const instructions = "PROPOSED — REQUIRES HUMAN APPROVAL. Verify current conditions at Hostel Block C lobby, then provide only approved masks and clinic-transport standby.";
  return {
    status: "PROPOSED — REQUIRES HUMAN APPROVAL",
    destination: caseDefinition.location,
    priority: "HIGH",
    resources: [
      { label: "N95 masks", status: "Proposed" },
      { label: "Clinic transport", status: "Standby proposed" }
    ],
    instructions,
    languages: { en: instructions }
  };
}

function buildQualityWarnings({ operationalState, consensus, scores }) {
  const warnings = [];
  if (consensus.level === "CRITICAL_CONFLICT") warnings.push("CRITICAL_MODEL_CONFLICT");
  if (operationalState === "URGENT_VERIFICATION" && scores.urgency < 60) {
    warnings.push("URGENT_STATE_LOW_URGENCY_SCORE");
  }
  if (["DISPATCH_CANDIDATE", "QUEUED_ACTION"].includes(operationalState) && scores.actionability < 50) {
    warnings.push("ACTION_READY_LOW_ACTIONABILITY_SCORE");
  }
  return warnings;
}

function buildFullScenarioIncident({ caseDefinition, analyst, reviewer, analystTrace, reviewerTrace, now }) {
  const consensus = computeConsensus(analyst.scores, reviewer.scores);
  const operationalState = determineFullScenarioState(caseDefinition);
  const gates = buildFullScenarioGates(caseDefinition, consensus, operationalState);
  const qualityWarnings = buildQualityWarnings({ operationalState, consensus, scores: consensus.scores });
  const receivedAt = now.toISOString();
  const evidence = caseDefinition.messages.map((message, index) => ({
    id: `E-CASE${caseDefinition.label}-${index + 1}`,
    type: caseDefinition.fixture ? "Hackathon scenario fixture" : `${caseDefinition.source} report`,
    summary: message,
    retrievedAt: receivedAt,
    reliability: caseDefinition.fixture
      ? "Fixed demonstration fixture; not asserted as a live field report."
      : "Supplied report; source identity was not independently verified by AI.",
    contradictions: caseDefinition.label === "04" ? "Proceed and cancellation notices conflict." : "None deterministically established.",
    uncertainties: uniqueStrings([...caseDefinition.unknowns, ...analyst.unknowns], 4)
  }));
  const claims = caseDefinition.messages.map((message, index) => ({
    id: `C-CASE${caseDefinition.label}-${index + 1}`,
    text: message.slice(0, 720),
    status: caseDefinition.label === "04" ? "contradicted" : caseDefinition.fixture ? "reported_unverified" : "reported",
    evidenceIds: [evidence[index].id]
  }));
  const agreementAxes = SCORE_AXES.filter(axis => consensus.gaps[axis] <= 15);
  const disagreementAxes = SCORE_AXES.filter(axis => consensus.gaps[axis] > 15);
  const riskFlags = uniqueStrings([...caseDefinition.riskFlags, ...analyst.riskFlags], 5);
  const unknownFacts = uniqueStrings([...caseDefinition.unknowns, ...analyst.unknowns], 5);
  const recommendation = fullScenarioRecommendation(caseDefinition.label);
  const deterministicReview = deterministicReviewFacts(caseDefinition.label);

  return {
    caseId: `CR-LIVE-CASE-${caseDefinition.label}`,
    label: caseDefinition.label,
    title: caseDefinition.title,
    rawMessage: caseDefinition.messages.join("\n"),
    source: caseDefinition.source,
    receivedAt,
    location: caseDefinition.location,
    peopleCount: caseDefinition.peopleCount,
    needs: [...caseDefinition.needs],
    riskFlags,
    knownFacts: [...caseDefinition.facts],
    unknownFacts,
    priorityRationale: `${recommendation} Operational state and gates are assigned by deterministic scenario rules.`,
    insight: caseDefinition.label === "03"
      ? "Low verification does not reduce the urgency of a reported breathing emergency."
      : "Model scores inform review; deterministic evidence and safety rules control operations.",
    safeNextActions: fullScenarioSafeActions(caseDefinition.label),
    claims,
    evidence,
    scores: consensus.scores,
    operationalState,
    missingFields: unknownFacts,
    modelDebate: {
      agreement: agreementAxes.map(axis => `${axis} scores are within the agreement threshold.`),
      disagreement: disagreementAxes.map(axis => `${axis} score gap is ${consensus.gaps[axis]}.`),
      counterEvidence: deterministicReview.counterEvidence,
      consensus: consensus.level,
      maxScoreGap: consensus.maxScoreGap,
      scoreGaps: consensus.gaps
    },
    modelReviews: {
      analyst: {
        conclusion: "Independent batch scores and bounded risk/unknown fields supplied for deterministic assembly.",
        evidenceCited: evidence.map(item => item.id),
        scores: analyst.scores,
        rationale: analyst.riskFlags.join("; ") || "No additional analyst risk flag supplied."
      },
      reviewer: {
        conclusion: "Blind batch review supplied independent scores and bounded challenge fields.",
        counterEvidence: deterministicReview.counterEvidence,
        unknowns: [...caseDefinition.unknowns],
        duplicateRisk: deterministicReview.duplicateRisk,
        scores: reviewer.scores,
        rationale: "Reviewer received the same original evidence package, never Analyst output.",
        safetyConcerns: deterministicReview.materialConflict ? ["material evidence conflict"] : []
      }
    },
    safetyGates: gates,
    qualityWarnings,
    recommendedAction: recommendation,
    actionPlan: buildFullScenarioActionPlan(caseDefinition, operationalState),
    actionBrief: null,
    proofCapsule: null,
    gonka: {
      mode: "live",
      analyst: {
        model: analystTrace.model,
        responseId: analystTrace.responseId,
        promptVersion: ANALYST_BATCH_PROMPT_VERSION,
        latencyMs: analystTrace.latencyMs
      },
      reviewer: {
        model: reviewerTrace.model,
        responseId: reviewerTrace.responseId,
        promptVersion: REVIEWER_BATCH_PROMPT_VERSION,
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

  const normalizeCode = reason => {
    if (["INVALID_JSON", "INVALID_RESPONSE", "INVALID_MODEL_DATA"].includes(reason?.code)) {
      return "INVALID_MODEL_DATA";
    }
    return SAFE_ROLE_ERROR_CODES.has(reason?.code) ? reason.code : "UPSTREAM_ERROR";
  };
  const classified = failures.map(item => ({
    ...item,
    code: normalizeCode(item.result.reason)
  }));
  const failedRole = classified.length === 1 ? classified[0].role.value : "both";
  const codes = new Set(classified.map(item => item.code));

  if (codes.size === 1) {
    const code = classified[0].code;
    if (code === "INVALID_MODEL_DATA") {
      const issues = classified.flatMap(item =>
        Array.isArray(item.result.reason?.issues) && item.result.reason.issues.length
          ? item.result.reason.issues
          : ["payload:no_contract_candidate"]);
      recordGonkaModelDataDiagnostic({
        role: failedRole,
        model: failedRole === "analyst"
          ? DEFAULT_MODELS.analyst
          : failedRole === "reviewer"
            ? DEFAULT_MODELS.reviewer
            : "multiple",
        sourceCode: classified[0]?.result.reason?.code || "INVALID_MODEL_DATA",
        issues,
        shapeDiagnostics: mergeModelDataDiagnostics(
          ...classified.map(item => item.result.reason?.shapeDiagnostics)
        )
      });
      throw invalidModelData(failedRole, issues);
    }
    const message = code === "TIMEOUT"
      ? classified.length === 1 ? `${classified[0].role.display} model timed out.` : "One or more models timed out."
      : code === "NETWORK_ERROR" ? "One or more Gonka network requests failed."
      : code === "HTTP_ERROR" ? "One or more Gonka requests returned an unsuccessful status."
      : code === "RESPONSE_TOO_LARGE" ? "One or more Gonka responses exceeded the safe size limit."
      : "One or more model requests failed.";
    throw new IncidentPipelineError(code, message, {
      retryable: classified.some(item => item.result.reason?.retryable === true) || ["TIMEOUT", "NETWORK_ERROR"].includes(code),
      role: failedRole
    });
  }

  const allSafelyClassified = classified.every(item => SAFE_ROLE_ERROR_CODES.has(item.code));
  const roleErrors = allSafelyClassified
    ? Object.fromEntries(classified.map(item => [item.role.value, item.code]))
    : undefined;
  throw new IncidentPipelineError("UPSTREAM_ERROR", "One or more model requests failed.", {
    retryable: classified.some(item => item.result.reason?.retryable === true || ["TIMEOUT", "NETWORK_ERROR"].includes(item.code)),
    role: failedRole,
    roleErrors
  });
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

function validateFulfilledRoleData({
  analystValidator,
  analystData,
  analystCandidates,
  analystSelector,
  analystModel = DEFAULT_MODELS.analyst,
  analystDiagnostics,
  reviewerValidator,
  reviewerData,
  reviewerCandidates,
  reviewerSelector,
  reviewerModel = DEFAULT_MODELS.reviewer,
  reviewerDiagnostics
}) {
  const outcomes = [
    {
      role: "analyst",
      validator: analystValidator,
      data: analystData,
      candidates: analystCandidates,
      selector: analystSelector,
      diagnostics: analystDiagnostics
    },
    {
      role: "reviewer",
      validator: reviewerValidator,
      data: reviewerData,
      candidates: reviewerCandidates,
      selector: reviewerSelector,
      diagnostics: reviewerDiagnostics
    }
  ].map(item => {
    try {
      const value = item.candidates && typeof item.selector === "function"
        ? item.selector(item.candidates)
        : validateRoleData(item.role, item.validator, item.data);
      return { role: item.role, value };
    } catch (error) {
      return {
        role: item.role,
        error,
        diagnostics: mergeModelDataDiagnostics(item.diagnostics, error?.modelDataDiagnostics)
      };
    }
  });
  const failures = outcomes.filter(outcome => outcome.error);
  if (failures.length) {
    const role = failures.length === 2 ? "both" : failures[0].role;
    const issues = failures.flatMap(outcome =>
      Array.isArray(outcome.error?.issues) && outcome.error.issues.length
        ? outcome.error.issues
        : ["payload:not_object"]);
    recordGonkaModelDataDiagnostic({
      role,
      model: role === "analyst"
        ? analystModel
        : role === "reviewer"
          ? reviewerModel
          : "multiple",
      sourceCode: "INVALID_MODEL_DATA",
      issues,
      shapeDiagnostics: mergeModelDataDiagnostics(...failures.map(outcome => outcome.diagnostics))
    });
    throw invalidModelData(role, issues);
  }
  return {
    analyst: outcomes[0].value,
    reviewer: outcomes[1].value
  };
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
    timeoutMs: ANALYST_TIMEOUT_MS,
    returnCandidates: true,
    diagnosticRole: "analyst"
  };
  const reviewerRequest = {
    model: DEFAULT_MODELS.reviewer,
    messages: [
      { role: "system", content: REVIEWER_SYSTEM_PROMPT },
      { role: "user", content: evidencePrompt }
    ],
    temperature: 0,
    maxTokens: 1_200,
    timeoutMs: REVIEWER_TIMEOUT_MS,
    returnCandidates: true,
    diagnosticRole: "reviewer"
  };

  const settledResults = await Promise.allSettled([
    client.completeJson(analystRequest),
    client.completeJson(reviewerRequest)
  ]);
  safeRoleFailure(settledResults);
  const analystResult = settledResults[0].value;
  const reviewerResult = settledResults[1].value;
  const { analyst, reviewer } = validateFulfilledRoleData({
    analystValidator: normalizeAnalystData,
    analystData: analystResult.data,
    analystCandidates: analystResult.candidates,
    analystSelector: selectAnalystCandidate,
    analystModel: analystRequest.model,
    analystDiagnostics: analystResult.diagnostics,
    reviewerValidator: normalizeReviewerData,
    reviewerData: reviewerResult.data,
    reviewerCandidates: reviewerResult.candidates,
    reviewerSelector: selectReviewerCandidate,
    reviewerModel: reviewerRequest.model,
    reviewerDiagnostics: reviewerResult.diagnostics
  });
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

async function analyzeFullHazeScenario({ payload, client, now = new Date() }) {
  const request = validateFullScenarioRequest(payload);
  if (!client || typeof client.completeJson !== "function") {
    throw new IncidentPipelineError("CONFIGURATION_ERROR", "Live analysis is not configured.");
  }

  const evidencePrompt = buildBatchEvidencePrompt(request.cases);
  const analystRequest = {
    model: DEFAULT_MODELS.analyst,
    messages: [
      { role: "system", content: ANALYST_BATCH_SYSTEM_PROMPT },
      { role: "user", content: evidencePrompt }
    ],
    temperature: 0,
    maxTokens: ANALYST_BATCH_MAX_TOKENS,
    timeoutMs: ANALYST_TIMEOUT_MS,
    returnCandidates: true,
    diagnosticRole: "analyst"
  };
  const reviewerRequest = {
    model: DEFAULT_MODELS.reviewer,
    messages: [
      { role: "system", content: REVIEWER_BATCH_SYSTEM_PROMPT },
      { role: "user", content: evidencePrompt }
    ],
    temperature: 0,
    maxTokens: REVIEWER_BATCH_MAX_TOKENS,
    timeoutMs: BATCH_REVIEWER_TIMEOUT_MS,
    returnCandidates: true,
    diagnosticRole: "reviewer"
  };

  const settledResults = await Promise.allSettled([
    client.completeJson(analystRequest),
    client.completeJson(reviewerRequest)
  ]);
  safeRoleFailure(settledResults);
  const analystResult = settledResults[0].value;
  const reviewerResult = settledResults[1].value;
  const { analyst: analystBatch, reviewer: reviewerBatch } = validateFulfilledRoleData({
    analystValidator: normalizeBatchAnalystData,
    analystData: analystResult.data,
    analystCandidates: analystResult.candidates,
    analystSelector: selectBatchAnalystCandidate,
    analystModel: analystRequest.model,
    analystDiagnostics: analystResult.diagnostics,
    reviewerValidator: normalizeBatchReviewerData,
    reviewerData: reviewerResult.data,
    reviewerCandidates: reviewerResult.candidates,
    reviewerSelector: selectBatchReviewerCandidate,
    reviewerModel: reviewerRequest.model,
    reviewerDiagnostics: reviewerResult.diagnostics
  });
  const normalizedNow = now instanceof Date ? now : new Date(now);
  const incidents = request.cases.map((caseDefinition, index) => buildFullScenarioIncident({
    caseDefinition,
    analyst: analystBatch.cases[index],
    reviewer: reviewerBatch.cases[index],
    analystTrace: analystResult.trace,
    reviewerTrace: reviewerResult.trace,
    now: normalizedNow
  }));

  return {
    resources: cloneResources(),
    rawReports: [...request.messages],
    incidents,
    meta: {
      mode: "live",
      slice: "FULL_HAZE_SCENARIO",
      partial: false,
      receivedMessageCount: request.messages.length,
      processedCaseCount: incidents.length,
      modelRequestCount: 2,
      scenarioFixtureCases: ["05"],
      qualityWarnings: incidents
        .filter(incident => incident.qualityWarnings.length > 0)
        .map(incident => ({
          caseId: incident.caseId,
          label: incident.label,
          warnings: [...incident.qualityWarnings]
        }))
    }
  };
}

async function analyzeIncidents(options) {
  if (options?.payload?.scenario === SCENARIO_ID) {
    return analyzeFullHazeScenario(options);
  }
  return analyzeCase01(options);
}

module.exports = {
  ANALYST_PROMPT_VERSION,
  REVIEWER_PROMPT_VERSION,
  ANALYST_TIMEOUT_MS,
  REVIEWER_TIMEOUT_MS,
  ANALYST_BATCH_PROMPT_VERSION,
  REVIEWER_BATCH_PROMPT_VERSION,
  ANALYST_BATCH_MAX_TOKENS,
  REVIEWER_BATCH_MAX_TOKENS,
  BATCH_REVIEWER_TIMEOUT_MS,
  SCORING_RUBRIC,
  ANALYST_BATCH_SYSTEM_PROMPT,
  REVIEWER_BATCH_SYSTEM_PROMPT,
  IncidentPipelineError,
  validateAnalyzeRequest,
  normalizeAnalystData,
  normalizeReviewerData,
  normalizeCaseLabel,
  normalizeBatchAnalystData,
  normalizeBatchReviewerData,
  selectAnalystCandidate,
  selectReviewerCandidate,
  selectBatchAnalystCandidate,
  selectBatchReviewerCandidate,
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
  buildBatchEvidencePrompt,
  determineFullScenarioState,
  buildFullScenarioGates,
  buildQualityWarnings,
  analyzeCase01,
  analyzeFullHazeScenario,
  analyzeIncidents
};
