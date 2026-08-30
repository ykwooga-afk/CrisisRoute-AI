const { performance } = require("node:perf_hooks");

const DEFAULT_GONKA_BASE_URL = "https://api.gonkarouter.io/v1";
const DEFAULT_MODELS = Object.freeze({
  analyst: "deepseek-ai/DeepSeek-V4-Flash-0731",
  reviewer: "moonshotai/Kimi-K2.6"
});

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const clientSecrets = new WeakMap();

const ERROR_MESSAGES = Object.freeze({
  MISSING_API_KEY: "Gonka API key is not configured.",
  INVALID_BASE_URL: "Gonka base URL is invalid.",
  INVALID_REQUEST: "Gonka request configuration is invalid.",
  TIMEOUT: "Gonka request timed out.",
  NETWORK_ERROR: "Gonka network request failed.",
  HTTP_ERROR: "Gonka returned an unsuccessful HTTP status.",
  INVALID_RESPONSE: "Gonka returned an invalid response structure.",
  INVALID_JSON: "Gonka model output did not contain a valid JSON object."
});

class GonkaClientError extends Error {
  constructor(code, { status, retryable, responseId } = {}) {
    super(ERROR_MESSAGES[code] || "Gonka client error.");
    this.name = "GonkaClientError";
    this.code = code;
    this.retryable = typeof retryable === "boolean" ? retryable : false;

    if (Number.isInteger(status)) this.status = status;
    if (typeof responseId === "string" && responseId.trim()) {
      this.responseId = responseId;
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
    return publicError;
  }

  toJSON() {
    return this.toPublicError();
  }
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractStructuredJson(content) {
  if (typeof content !== "string") {
    throw new GonkaClientError("INVALID_JSON");
  }

  const trimmedContent = content.trim();
  if (!trimmedContent) {
    throw new GonkaClientError("INVALID_JSON");
  }

  try {
    const parsed = JSON.parse(trimmedContent);
    if (isJsonObject(parsed)) return parsed;
    throw new GonkaClientError("INVALID_JSON");
  } catch (error) {
    if (error instanceof GonkaClientError) throw error;
  }

  let lastValidCandidate = null;
  let lastValidEnd = -1;

  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

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
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = content.slice(start, index + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (isJsonObject(parsed) && index > lastValidEnd) {
              lastValidCandidate = parsed;
              lastValidEnd = index;
            }
          } catch {
            // Invalid candidates are discarded without logging their content.
          }
          break;
        }
        if (depth < 0) break;
      }
    }
  }

  if (lastValidCandidate) return lastValidCandidate;
  throw new GonkaClientError("INVALID_JSON");
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
    timeoutMs = this.defaultTimeoutMs
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
      timeoutMs <= 0
    ) {
      throw new GonkaClientError("INVALID_REQUEST");
    }

    const secret = clientSecrets.get(this);
    if (!secret) throw new GonkaClientError("MISSING_API_KEY");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();
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
        if (response.body) await response.body.cancel().catch(() => {});
        throw new GonkaClientError("HTTP_ERROR", {
          status: response.status,
          retryable: isRetryableHttpStatus(response.status)
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

      const data = extractStructuredJson(choice.message.content);
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

      return { data, trace };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GonkaClientError("TIMEOUT", { retryable: true });
      }
      if (error instanceof GonkaClientError) throw error;
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
  extractStructuredJson,
  DEFAULT_GONKA_BASE_URL,
  DEFAULT_MODELS,
  MAX_RESPONSE_BYTES
};
