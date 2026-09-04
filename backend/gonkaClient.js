const { performance } = require("node:perf_hooks");

const DEFAULT_GONKA_BASE_URL = "https://api.gonkarouter.io/v1";
const DEFAULT_MODELS = Object.freeze({
  analyst: "deepseek-ai/DeepSeek-V4-Flash-0731",
  reviewer: "MiniMaxAI/MiniMax-M2.7"
});

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_ERROR_DIAGNOSTIC_CHARS = 700;
const MAX_PUBLIC_DIAGNOSTIC_MESSAGE_CHARS = 200;
const MAX_JSON_CANDIDATES = 8;
const MAX_JSON_NESTING_DEPTH = 64;
const clientSecrets = new WeakMap();
let lastGonkaFailureDiagnostic = null;

const ERROR_MESSAGES = Object.freeze({
  MISSING_API_KEY: "Gonka API key is not configured.",
  INVALID_BASE_URL: "Gonka base URL is invalid.",
  INVALID_REQUEST: "Gonka request configuration is invalid.",
  TIMEOUT: "Gonka request timed out.",
  NETWORK_ERROR: "Gonka network request failed.",
  HTTP_ERROR: "Gonka returned an unsuccessful HTTP status.",
  INVALID_RESPONSE: "Gonka returned an invalid response structure.",
  INVALID_JSON: "Gonka model output did not contain valid structured JSON.",
  INVALID_MODEL_DATA: "Gonka model output did not match the required data contract."
});

const SAFE_DIAGNOSTIC_ISSUES = new Set([
  "payload:no_contract_candidate",
  "payload:ambiguous_candidates",
  "payload:direct_array_wrong_length",
  "payload:string_unwrap_failed",
  "payload:candidate_limit_exceeded",
  "payload:nesting_limit_exceeded"
]);
const SAFE_CANDIDATE_KINDS = new Set([
  "object", "array", "string", "number", "boolean", "null"
]);

class GonkaClientError extends Error {
  constructor(code, {
    status,
    retryable,
    responseId,
    issues,
    candidateCount,
    candidateKinds,
    upstream
  } = {}) {
    super(ERROR_MESSAGES[code] || "Gonka client error.");
    this.name = "GonkaClientError";
    this.code = code;
    this.retryable = typeof retryable === "boolean" ? retryable : false;

    if (Number.isInteger(status)) this.status = status;
    if (typeof responseId === "string" && responseId.trim()) {
      this.responseId = responseId;
    }
    const safeIssues = Array.isArray(issues)
      ? [...new Set(issues.filter(issue => SAFE_DIAGNOSTIC_ISSUES.has(issue)))].slice(0, 5)
      : [];
    if (safeIssues.length) this.issues = safeIssues;
    if (Number.isInteger(candidateCount) && candidateCount >= 0) {
      this.candidateCount = Math.min(candidateCount, MAX_JSON_CANDIDATES);
    }
    const safeKinds = Array.isArray(candidateKinds)
      ? candidateKinds.filter(kind => SAFE_CANDIDATE_KINDS.has(kind)).slice(0, MAX_JSON_CANDIDATES)
      : [];
    if (safeKinds.length) this.candidateKinds = safeKinds;
    if (upstream && typeof upstream === "object" && !Array.isArray(upstream)) {
      this.upstream = sanitizeUpstreamDiagnostics(upstream);
    }
  }

  toPublicError() {
    const publicError = {
      code: this.code,
      message: this.message,
      retryable: this.retryable
    };
    if (Number.isInteger(this.status)) publicError.status = this.status;
    if (this.responseId) publicError.responseId = this.responseId;
    if (this.issues) publicError.issues = [...this.issues];
    if (Number.isInteger(this.candidateCount)) publicError.candidateCount = this.candidateCount;
    if (this.candidateKinds) publicError.candidateKinds = [...this.candidateKinds];
    return publicError;
  }

  toJSON() {
    return this.toPublicError();
  }
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValueKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function createCandidateResult(candidates, issues = []) {
  return {
    candidates,
    candidateCount: candidates.length,
    candidateKinds: candidates.map(candidate => candidate.kind),
    issues: [...new Set(issues)]
  };
}

function candidateError(issue, candidates = []) {
  throw new GonkaClientError("INVALID_JSON", {
    issues: [issue],
    candidateCount: candidates.length,
    candidateKinds: candidates.map(candidate => candidate.kind)
  });
}

function exceedsNestingLimit(value) {
  if (value === null || typeof value !== "object") return false;
  const pending = [{ value, depth: 1 }];
  while (pending.length) {
    const current = pending.pop();
    if (current.depth > MAX_JSON_NESTING_DEPTH) return true;
    for (const child of Object.values(current.value)) {
      if (child !== null && typeof child === "object") {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

function addCandidate(candidates, value) {
  if (exceedsNestingLimit(value)) {
    candidateError("payload:nesting_limit_exceeded", candidates);
  }
  if (candidates.length === MAX_JSON_CANDIDATES) {
    candidateError("payload:candidate_limit_exceeded", candidates);
  }
  candidates.push({ value, kind: jsonValueKind(value) });
}

function extractStructuredJsonCandidates(content) {
  if (typeof content !== "string") {
    candidateError("payload:no_contract_candidate");
  }

  const trimmedContent = content.trim();
  if (!trimmedContent) {
    candidateError("payload:no_contract_candidate");
  }

  const candidates = [];
  const issues = [];
  try {
    const parsed = JSON.parse(trimmedContent);
    addCandidate(candidates, parsed);
    if (typeof parsed === "string") {
      let unwrapped;
      try {
        unwrapped = JSON.parse(parsed.trim());
      } catch {
        issues.push("payload:string_unwrap_failed");
      }
      if (unwrapped !== undefined) addCandidate(candidates, unwrapped);
    }
    return createCandidateResult(candidates, issues);
  } catch (error) {
    if (error instanceof GonkaClientError) throw error;
    // Continue with a bounded, string-aware scan for embedded composite JSON.
  }

  for (let start = 0; start < content.length; start += 1) {
    const opening = content[start];
    if (opening !== "{" && opening !== "[") continue;

    const stack = [];
    let inString = false;
    let escaped = false;
    let completedAt = -1;

    for (let index = start; index < content.length; index += 1) {
      const character = content[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === "{" || character === "[") {
        stack.push(character);
        if (stack.length > MAX_JSON_NESTING_DEPTH) {
          candidateError("payload:nesting_limit_exceeded", candidates);
        }
      } else if (character === "}" || character === "]") {
        const expected = character === "}" ? "{" : "[";
        if (stack.at(-1) !== expected) break;
        stack.pop();
        if (stack.length === 0) {
          completedAt = index;
          break;
        }
      }
    }

    if (completedAt < 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(content.slice(start, completedAt + 1));
    } catch {
      // Invalid candidates are discarded without logging their content.
      continue;
    }
    addCandidate(candidates, parsed);
    start = completedAt;
  }

  if (!candidates.length) candidateError("payload:no_contract_candidate");
  return createCandidateResult(candidates, issues);
}

function extractStructuredJson(content) {
  const extracted = extractStructuredJsonCandidates(content);
  return selectLegacyObject(extracted);
}

function selectLegacyObject(extracted) {
  const objects = extracted.candidates.filter(candidate => candidate.kind === "object");
  if (objects.length) return objects.at(-1).value;
  throw new GonkaClientError("INVALID_JSON", {
    issues: extracted.issues.length
      ? extracted.issues
      : ["payload:no_contract_candidate"],
    candidateCount: extracted.candidateCount,
    candidateKinds: extracted.candidateKinds
  });
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GonkaClientError("INVALID_BASE_URL");
  }

  const hostname = url.hostname.toLowerCase();
  const loopbackHost = hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]";
  const validProtocol = url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackHost);
  const normalizedPathname = url.pathname.replace(/\/+$/, "") || "/";

  if (
    !validProtocol ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new GonkaClientError("INVALID_BASE_URL");
  }

  if (hostname === "api.gonkarouter.io" && normalizedPathname !== "/v1") {
    throw new GonkaClientError("INVALID_BASE_URL");
  }

  url.pathname = normalizedPathname;
  return url.toString().replace(/\/$/, "");
}

function normalizeUsage(usage) {
  if (!isJsonObject(usage)) return null;
  const safeNumber = value => Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    promptTokens: safeNumber(usage.prompt_tokens),
    completionTokens: safeNumber(usage.completion_tokens),
    totalTokens: safeNumber(usage.total_tokens)
  };
}

function isRetryableHttpStatus(status) {
  return status === 429 || status >= 500;
}

function safeDiagnosticRole(value) {
  return value === "analyst" || value === "reviewer" ? value : "unknown";
}

function safeDiagnosticString(value, maxLength = MAX_ERROR_DIAGNOSTIC_CHARS, sensitiveValues = []) {
  if (typeof value !== "string") return "";
  let text = value;
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive === "string" && sensitive.length >= 6) {
      text = text.split(sensitive).join("[redacted-token]");
    }
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|gk|pk|rk)_[A-Za-z0-9._-]{12,}\b/g, "[redacted-token]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeUpstreamDiagnostics(value) {
  const upstream = {};
  if (Number.isInteger(value.status)) upstream.status = value.status;
  if (Number.isInteger(value.durationMs) && value.durationMs >= 0) upstream.durationMs = value.durationMs;
  if (Number.isInteger(value.timeoutMs) && value.timeoutMs > 0) upstream.timeoutMs = value.timeoutMs;
  const requestId = safeDiagnosticString(value.requestId, 160);
  if (requestId) upstream.requestId = requestId;
  const errorExcerpt = safeDiagnosticString(value.errorExcerpt);
  if (errorExcerpt) upstream.errorExcerpt = errorExcerpt;
  return upstream;
}

function safeDiagnosticCode(value, fallback = "") {
  const code = safeDiagnosticString(String(value || fallback), 80);
  return code.replace(/[^\w:./-]+/g, "_").slice(0, 80);
}

function safeDiagnosticMessage(value) {
  return safeDiagnosticString(
    typeof value === "string" ? value : "",
    MAX_PUBLIC_DIAGNOSTIC_MESSAGE_CHARS
  );
}

function firstSafeField(source, fields) {
  if (!isJsonObject(source)) return "";
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}

function extractKnownSafeErrorFields(errorExcerpt) {
  const fallback = { code: "", message: safeDiagnosticMessage(errorExcerpt) };
  if (!errorExcerpt) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(errorExcerpt);
  } catch {
    return fallback;
  }

  const candidates = [
    parsed,
    parsed?.error,
    parsed?.error?.error,
    Array.isArray(parsed?.errors) ? parsed.errors[0] : null
  ].filter(isJsonObject);
  for (const candidate of candidates) {
    const code = firstSafeField(candidate, [
      "code",
      "errorCode",
      "error_code",
      "type",
      "errorType",
      "error_type",
      "reason"
    ]);
    const message = firstSafeField(candidate, [
      "message",
      "errorMessage",
      "error_message",
      "detail",
      "description"
    ]);
    if (code || message) {
      return {
        code: safeDiagnosticCode(code),
        message: safeDiagnosticMessage(message)
      };
    }
  }

  if (typeof parsed?.error === "string") {
    return { code: "", message: safeDiagnosticMessage(parsed.error) };
  }
  return { code: "", message: "" };
}

async function readBoundedErrorText(response, sensitiveValues = []) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    try {
      return safeDiagnosticString(await response.text?.(), MAX_ERROR_DIAGNOSTIC_CHARS, sensitiveValues);
    } catch {
      return "";
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  try {
    while (bytesRead < MAX_ERROR_DIAGNOSTIC_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const buffer = Buffer.from(value);
      const remaining = MAX_ERROR_DIAGNOSTIC_BYTES - bytesRead;
      chunks.push(buffer.subarray(0, Math.max(0, remaining)));
      bytesRead += Math.min(buffer.length, remaining);
      if (buffer.length > remaining) break;
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => {});
  }
  return safeDiagnosticString(Buffer.concat(chunks).toString("utf8"), MAX_ERROR_DIAGNOSTIC_CHARS, sensitiveValues);
}

function responseRequestId(headers) {
  if (!headers || typeof headers.get !== "function") return "";
  for (const header of [
    "x-request-id",
    "x-gonka-request-id",
    "x-router-request-id",
    "x-amzn-requestid",
    "cf-ray"
  ]) {
    const value = headers.get(header);
    if (value) return safeDiagnosticString(value, 160);
  }
  return "";
}

function shouldLogGonkaDiagnostics() {
  return process.env.NODE_ENV === "production" || process.env.GONKA_DIAGNOSTICS === "true";
}

function logGonkaDiagnostic(event) {
  const safe = {
    event: "gonka_upstream_diagnostic",
    role: safeDiagnosticRole(event.role),
    model: safeDiagnosticString(event.model, 160),
    classification: safeDiagnosticString(event.classification, 80),
    status: Number.isInteger(event.status) ? event.status : undefined,
    retryable: typeof event.retryable === "boolean" ? event.retryable : undefined,
    durationMs: Number.isInteger(event.durationMs) ? event.durationMs : undefined,
    timeoutMs: Number.isInteger(event.timeoutMs) ? event.timeoutMs : undefined,
    requestId: safeDiagnosticString(event.requestId, 160) || undefined,
    errorExcerpt: safeDiagnosticString(event.errorExcerpt) || undefined
  };
  for (const key of Object.keys(safe)) {
    if (safe[key] === undefined || safe[key] === "") delete safe[key];
  }
  const upstreamError = extractKnownSafeErrorFields(safe.errorExcerpt || "");
  lastGonkaFailureDiagnostic = {
    timestamp: new Date().toISOString(),
    role: safe.role,
    model: safe.model,
    upstreamStatus: safe.status,
    durationMs: safe.durationMs,
    upstreamRequestId: safe.requestId,
    sanitizedErrorCode: safeDiagnosticCode(upstreamError.code, safe.classification),
    sanitizedErrorMessage: upstreamError.message || safeDiagnosticMessage(safe.classification)
  };
  for (const key of Object.keys(lastGonkaFailureDiagnostic)) {
    if (lastGonkaFailureDiagnostic[key] === undefined || lastGonkaFailureDiagnostic[key] === "") {
      delete lastGonkaFailureDiagnostic[key];
    }
  }
  if (shouldLogGonkaDiagnostics()) console.error(JSON.stringify(safe));
}

function getLastGonkaFailureDiagnostic() {
  return lastGonkaFailureDiagnostic
    ? { ...lastGonkaFailureDiagnostic }
    : null;
}

class GonkaClient {
  constructor({
    apiKey,
    baseUrl = DEFAULT_GONKA_BASE_URL,
    models = DEFAULT_MODELS,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      throw new GonkaClientError("MISSING_API_KEY");
    }
    if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
      throw new GonkaClientError("INVALID_REQUEST");
    }
    if (typeof fetchImpl !== "function") {
      throw new GonkaClientError("INVALID_REQUEST");
    }

    const analyst = models?.analyst || DEFAULT_MODELS.analyst;
    const reviewer = models?.reviewer || DEFAULT_MODELS.reviewer;
    if (typeof analyst !== "string" || !analyst.trim() ||
        typeof reviewer !== "string" || !reviewer.trim()) {
      throw new GonkaClientError("INVALID_REQUEST");
    }

    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.models = Object.freeze({ analyst, reviewer });
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.requestCount = 0;
    clientSecrets.set(this, { apiKey, fetchImpl });
  }

  async completeJson({
    model,
    messages,
    temperature = 0,
    maxTokens,
    timeoutMs = this.defaultTimeoutMs,
    returnCandidates = false,
    diagnosticRole
  } = {}) {
    if (
      typeof model !== "string" ||
      !model.trim() ||
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages.some(message => !isJsonObject(message) ||
        typeof message.role !== "string" ||
        typeof message.content !== "string") ||
      !Number.isFinite(temperature) ||
      !Number.isInteger(maxTokens) ||
      maxTokens <= 0 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      typeof returnCandidates !== "boolean"
    ) {
      throw new GonkaClientError("INVALID_REQUEST");
    }

    const secret = clientSecrets.get(this);
    if (!secret) throw new GonkaClientError("MISSING_API_KEY");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();
    const role = safeDiagnosticRole(diagnosticRole);
    let response;
    let rawResponse;
    let payload;

    this.requestCount += 1;
    try {
      response = await secret.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false
        }),
        signal: controller.signal
      });
      if (!response || typeof response.ok !== "boolean") {
        throw new GonkaClientError("INVALID_RESPONSE");
      }

      if (!response.ok) {
        const durationMs = Math.round(performance.now() - startedAt);
        const requestId = responseRequestId(response.headers);
        const errorExcerpt = await readBoundedErrorText(response, [secret.apiKey]);
        const retryable = isRetryableHttpStatus(response.status);
        logGonkaDiagnostic({
          role,
          model,
          classification: "HTTP_ERROR",
          status: response.status,
          retryable,
          durationMs,
          timeoutMs,
          requestId,
          errorExcerpt
        });
        throw new GonkaClientError("HTTP_ERROR", {
          status: response.status,
          retryable,
          upstream: {
            status: response.status,
            durationMs,
            timeoutMs,
            requestId,
            errorExcerpt
          }
        });
      }

      const declaredLength = response.headers?.get?.("content-length");
      if (typeof declaredLength === "string" && /^\d+$/.test(declaredLength.trim()) &&
          BigInt(declaredLength.trim()) > BigInt(MAX_RESPONSE_BYTES)) {
        if (response.body) await response.body.cancel().catch(() => {});
        throw new GonkaClientError("INVALID_RESPONSE");
      }

      try {
        rawResponse = await response.text();
      } catch {
        throw new GonkaClientError("INVALID_RESPONSE");
      }
      if (Buffer.byteLength(rawResponse, "utf8") > MAX_RESPONSE_BYTES) {
        throw new GonkaClientError("INVALID_RESPONSE");
      }

      try {
        payload = JSON.parse(rawResponse);
      } catch {
        throw new GonkaClientError("INVALID_RESPONSE");
      }

      if (!isJsonObject(payload) ||
          typeof payload.id !== "string" ||
          !payload.id.trim() ||
          !Array.isArray(payload.choices) ||
          payload.choices.length === 0) {
        throw new GonkaClientError("INVALID_RESPONSE");
      }

      const choice = payload.choices[0];
      if (!isJsonObject(choice) ||
          !isJsonObject(choice.message) ||
          typeof choice.message.content !== "string") {
        throw new GonkaClientError("INVALID_RESPONSE", {
          responseId: payload.id
        });
      }

      const extracted = extractStructuredJsonCandidates(choice.message.content);
      const data = returnCandidates ? undefined : selectLegacyObject(extracted);
      const trace = {
        responseId: payload.id,
        model: typeof payload.model === "string" && payload.model.trim()
          ? payload.model
          : model,
        finishReason: typeof choice.finish_reason === "string"
          ? choice.finish_reason
          : null,
        latencyMs: Math.round(performance.now() - startedAt),
        usage: normalizeUsage(payload.usage)
      };

      return returnCandidates
        ? { candidates: extracted, trace }
        : { data, trace };
    } catch (error) {
      if (controller.signal.aborted) {
        logGonkaDiagnostic({
          role,
          model,
          classification: "TIMEOUT",
          retryable: true,
          durationMs: Math.round(performance.now() - startedAt),
          timeoutMs
        });
        throw new GonkaClientError("TIMEOUT", { retryable: true });
      }
      if (error instanceof GonkaClientError) throw error;
      logGonkaDiagnostic({
        role,
        model,
        classification: response ? "INVALID_RESPONSE" : "NETWORK_ERROR",
        retryable: response ? false : true,
        durationMs: Math.round(performance.now() - startedAt),
        timeoutMs
      });
      throw new GonkaClientError(
        response ? "INVALID_RESPONSE" : "NETWORK_ERROR",
        { retryable: response ? false : true }
      );
    } finally {
      clearTimeout(timeout);
      response = null;
      rawResponse = null;
      payload = null;
    }
  }
}

function createGonkaClientFromEnv(env = process.env) {
  const models = {
    analyst: env.GONKA_ANALYST_MODEL || DEFAULT_MODELS.analyst,
    reviewer: env.GONKA_REVIEWER_MODEL || DEFAULT_MODELS.reviewer
  };
  return new GonkaClient({
    apiKey: env.GONKA_API_KEY,
    baseUrl: env.GONKA_BASE_URL || DEFAULT_GONKA_BASE_URL,
    models
  });
}

module.exports = {
  GonkaClient,
  GonkaClientError,
  createGonkaClientFromEnv,
  getLastGonkaFailureDiagnostic,
  extractStructuredJson,
  extractStructuredJsonCandidates,
  DEFAULT_GONKA_BASE_URL,
  DEFAULT_MODELS,
  MAX_RESPONSE_BYTES,
  MAX_JSON_CANDIDATES,
  MAX_JSON_NESTING_DEPTH
};
