const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2_500_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_ANALYSIS_TEXT = 3_800;
const ACCEPTED_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/xhtml+xml"]);
const MAX_DIAGNOSTIC_MESSAGE = 200;
let lastPublicUrlFailureDiagnostic = null;

class PublicSourceError extends Error {
  constructor(code, message, { status = 400, retryable = false, diagnostic } = {}) {
    super(message);
    this.name = "PublicSourceError";
    this.code = code;
    this.status = status;
    this.retryable = retryable === true;
    this.diagnostic = sanitizeDiagnostic(diagnostic);
  }
}

function sanitizeDiagnosticText(value, maxLength = MAX_DIAGNOSTIC_MESSAGE) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|gk|pk|rk)_[A-Za-z0-9._-]{12,}\b/g, "[redacted-token]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeDiagnosticCode(value, fallback = "") {
  return sanitizeDiagnosticText(value || fallback, 80).replace(/[^\w:./-]+/g, "_").slice(0, 80);
}

function sanitizeHostname(value) {
  return sanitizeDiagnosticText(String(value || "").toLowerCase(), 180)
    .replace(/[^a-z0-9.:[\]-]+/g, "")
    .slice(0, 180);
}

function safeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function safeBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeAddressClassification(value) {
  return ["public", "private", "blocked", "unknown"].includes(value) ? value : undefined;
}

function sanitizeFailureStage(value) {
  return [
    "url_validation",
    "dns_resolution",
    "ssrf_check",
    "redirect",
    "request",
    "http_status",
    "content_type",
    "size_limit",
    "timeout",
    "text_extraction",
    "unknown"
  ].includes(value) ? value : "unknown";
}

function sanitizeDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe = {
    hostname: sanitizeHostname(value.hostname),
    failureStage: sanitizeFailureStage(value.failureStage),
    failureCode: sanitizeDiagnosticCode(value.failureCode),
    sanitizedMessage: sanitizeDiagnosticText(value.sanitizedMessage),
    httpStatus: safeInteger(value.httpStatus),
    contentType: sanitizeDiagnosticText(value.contentType, 120),
    redirectCount: safeInteger(value.redirectCount),
    durationMs: safeInteger(value.durationMs),
    dnsResolved: safeBoolean(value.dnsResolved),
    addressClassification: sanitizeAddressClassification(value.addressClassification),
    timeout: safeBoolean(value.timeout)
  };
  for (const key of Object.keys(safe)) {
    if (safe[key] === undefined || safe[key] === "") delete safe[key];
  }
  return safe;
}

function createDiagnosticContext(rawUrl) {
  const context = {
    startedAt: Date.now(),
    failureStage: "unknown",
    redirectCount: 0,
    dnsResolved: false,
    addressClassification: "unknown",
    timeout: false
  };
  try {
    context.hostname = new URL(String(rawUrl || "").trim()).hostname;
  } catch {}
  return context;
}

function diagnosticSnapshot(context, values = {}) {
  const startedAt = Number.isInteger(context?.startedAt) ? context.startedAt : Date.now();
  return sanitizeDiagnostic({
    ...context,
    ...values,
    durationMs: Date.now() - startedAt
  });
}

function attachDiagnostic(error, context, values = {}) {
  if (!(error instanceof PublicSourceError)) return error;
  error.diagnostic = sanitizeDiagnostic({
    ...context,
    ...error.diagnostic,
    ...values,
    failureCode: error.code,
    sanitizedMessage: values.sanitizedMessage || error.diagnostic?.sanitizedMessage || error.message
  });
  return error;
}

function recordPublicUrlFailureDiagnostic(error) {
  if (!(error instanceof PublicSourceError)) return;
  lastPublicUrlFailureDiagnostic = {
    timestamp: new Date().toISOString(),
    ...sanitizeDiagnostic({
      ...error.diagnostic,
      failureCode: error.code,
      sanitizedMessage: error.diagnostic?.sanitizedMessage || error.message
    })
  };
}

function getLastPublicUrlFailureDiagnostic() {
  return lastPublicUrlFailureDiagnostic
    ? { ...lastPublicUrlFailureDiagnostic }
    : null;
}

async function extractPublicSource(rawUrl, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  dnsLookup = dns.promises.lookup
} = {}) {
  const diagnostics = createDiagnosticContext(rawUrl);
  try {
    const originalUrl = parsePublicUrl(rawUrl);
    diagnostics.hostname = originalUrl.hostname;
    const response = await fetchReadableText(originalUrl, {
      timeoutMs,
      maxBytes,
      maxRedirects,
      dnsLookup,
      diagnostics
    });
    const extracted = extractReadableContent(response.body, response.contentType);
    if (extracted.text.length < 40) {
      throw new PublicSourceError(
        "PUBLIC_URL_EMPTY_TEXT",
        "This public page did not expose enough readable text. Paste the report text instead.",
        { status: 422, diagnostic: diagnosticSnapshot(diagnostics, { failureStage: "text_extraction" }) }
      );
    }
    const analysisText = buildAnalysisText({
      originalUrl: originalUrl.toString(),
      finalUrl: response.finalUrl.toString(),
      title: extracted.title,
      text: extracted.text
    });
    return {
      originalUrl: originalUrl.toString(),
      finalUrl: response.finalUrl.toString(),
      title: extracted.title,
      text: extracted.text,
      analysisText,
      contentType: response.contentType,
      bytesRead: response.bytesRead,
      redirected: originalUrl.toString() !== response.finalUrl.toString()
    };
  } catch (error) {
    throw attachDiagnostic(error, diagnostics);
  }
}

async function fetchReadableText(startUrl, options, redirectCount = 0) {
  if (options.diagnostics) {
    options.diagnostics.hostname = startUrl.hostname;
    options.diagnostics.redirectCount = redirectCount;
  }
  const validatedAddresses = await assertPublicTarget(startUrl, options.dnsLookup, options.diagnostics);
  const response = await requestOnce(startUrl, { ...options, validatedAddresses });
  if (response.redirectUrl) {
    if (redirectCount >= options.maxRedirects) {
      throw new PublicSourceError(
        "PUBLIC_URL_REDIRECT_LIMIT",
        "This public page redirects too many times. Paste the report text instead.",
        { status: 400, diagnostic: diagnosticSnapshot(options.diagnostics, {
          failureStage: "redirect",
          httpStatus: response.httpStatus,
          redirectCount
        }) }
      );
    }
    return fetchReadableText(response.redirectUrl, options, redirectCount + 1);
  }
  return response;
}

function requestOnce(url, { timeoutMs, maxBytes, diagnostics, validatedAddresses }) {
  return new Promise((resolve, reject) => {
    const requestModule = url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const requestOptions = {
      method: "GET",
      timeout: timeoutMs,
      headers: {
        Accept: "text/html,text/plain;q=0.9,application/xhtml+xml;q=0.8",
        "User-Agent": "CrisisRouteAI-PublicSourceExtractor/1.0"
      },
      lookup: createPinnedLookup(validatedAddresses, diagnostics)
    };
    if (url.protocol === "https:" && !net.isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
      requestOptions.servername = url.hostname;
    }

    const request = requestModule.request(url, requestOptions, response => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        try {
          finish(resolve, {
            redirectUrl: parsePublicUrl(new URL(location, url).toString()),
            httpStatus: response.statusCode
          });
        } catch (error) {
          finish(reject, error);
        }
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const contentType = normalizeContentType(response.headers["content-type"]);
        response.resume();
        finish(reject, new PublicSourceError(
          "PUBLIC_URL_HTTP_ERROR",
          "This page is not publicly accessible. Paste the report text instead.",
          {
            status: response.statusCode >= 400 && response.statusCode <= 499 ? 400 : 502,
            retryable: response.statusCode >= 500,
            diagnostic: diagnosticSnapshot(diagnostics, {
              failureStage: "http_status",
              httpStatus: response.statusCode,
              contentType
            })
          }
        ));
        return;
      }

      const contentType = normalizeContentType(response.headers["content-type"]);
      if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
        response.resume();
        finish(reject, new PublicSourceError(
          "PUBLIC_URL_UNSUPPORTED_CONTENT_TYPE",
          "This public source is not readable text or HTML. Paste the report text instead.",
          { status: 415, diagnostic: diagnosticSnapshot(diagnostics, {
            failureStage: "content_type",
            httpStatus: response.statusCode,
            contentType
          }) }
        ));
        return;
      }

      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > maxBytes) {
        response.resume();
        finish(reject, new PublicSourceError(
          "PUBLIC_URL_TOO_LARGE",
          "This public page is too large to process safely. Paste the relevant report text instead.",
          { status: 413, diagnostic: diagnosticSnapshot(diagnostics, {
            failureStage: "size_limit",
            httpStatus: response.statusCode,
            contentType
          }) }
        ));
        return;
      }

      const chunks = [];
      let bytesRead = 0;
      response.on("data", chunk => {
        bytesRead += chunk.length;
        if (bytesRead > maxBytes) {
          request.destroy(new PublicSourceError(
            "PUBLIC_URL_TOO_LARGE",
            "This public page is too large to process safely. Paste the relevant report text instead.",
            { status: 413, diagnostic: diagnosticSnapshot(diagnostics, {
              failureStage: "size_limit",
              httpStatus: response.statusCode,
              contentType
            }) }
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        finish(resolve, {
          finalUrl: url,
          contentType,
          bytesRead,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new PublicSourceError(
        "PUBLIC_URL_TIMEOUT",
        "This public page took too long to respond. Paste the report text instead.",
        { status: 504, retryable: true, diagnostic: diagnosticSnapshot(diagnostics, {
          failureStage: "timeout",
          timeout: true
        }) }
      ));
    });
    request.on("error", error => {
      finish(reject, error instanceof PublicSourceError
        ? attachDiagnostic(error, diagnostics)
        : new PublicSourceError(
          "PUBLIC_URL_FETCH_FAILED",
          "This public page could not be fetched safely. Paste the report text instead.",
          { status: 502, retryable: true, diagnostic: diagnosticSnapshot(diagnostics, {
            failureStage: classifyRequestErrorStage(error),
            sanitizedMessage: sanitizedRequestErrorMessage(error),
            timeout: false
          }) }
        ));
    });
    request.end();
  });
}

async function assertPublicTarget(url, dnsLookup, diagnostics) {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new PublicSourceError(
      "PUBLIC_URL_UNSUPPORTED_PROTOCOL",
      "Only public HTTP and HTTPS pages can be analyzed.",
      { status: 400, diagnostic: diagnosticSnapshot(diagnostics, {
        failureStage: "url_validation",
        addressClassification: "blocked"
      }) }
    );
  }
  if (url.username || url.password) {
    throw new PublicSourceError(
      "PUBLIC_URL_CREDENTIALS_BLOCKED",
      "URLs with embedded credentials are not allowed.",
      { status: 400, diagnostic: diagnosticSnapshot(diagnostics, {
        failureStage: "url_validation",
        addressClassification: "blocked"
      }) }
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (diagnostics) diagnostics.hostname = hostname;
  const hostAddress = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostAddress)) {
    if (isPrivateAddress(hostAddress)) throw privateAddressError(diagnostics);
    if (diagnostics) {
      diagnostics.addressClassification = "public";
      diagnostics.dnsResolved = false;
    }
    return [{ address: hostAddress, family: net.isIP(hostAddress) }];
  }
  if (isBlockedHostname(hostname)) {
    throw new PublicSourceError(
      "PUBLIC_URL_PRIVATE_HOST_BLOCKED",
      "Private, local, or internal URLs are blocked. Paste the report text instead.",
      { status: 400, diagnostic: diagnosticSnapshot(diagnostics, {
        failureStage: "ssrf_check",
        addressClassification: "blocked",
        dnsResolved: false
      }) }
    );
  }
  let addresses;
  try {
    addresses = await lookupAll(hostname, dnsLookup);
  } catch (error) {
    throw new PublicSourceError(
      "PUBLIC_URL_FETCH_FAILED",
      "This public page could not be fetched safely. Paste the report text instead.",
      { status: 502, retryable: true, diagnostic: diagnosticSnapshot(diagnostics, {
        failureStage: "dns_resolution",
        dnsResolved: false,
        sanitizedMessage: sanitizedRequestErrorMessage(error)
      }) }
    );
  }
  if (diagnostics) diagnostics.dnsResolved = addresses.length > 0;
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw privateAddressError(diagnostics);
  }
  if (diagnostics) diagnostics.addressClassification = "public";
  return addresses;
}

function createPinnedLookup(validatedAddresses, diagnostics) {
  const pinned = normalizePinnedAddresses(validatedAddresses);
  return function pinnedLookup(_hostname, opts, callback) {
    const selected = selectPinnedAddresses(pinned, opts);
    if (!selected.length) {
      callback(new PublicSourceError(
        "PUBLIC_URL_FETCH_FAILED",
        "This public page could not be fetched safely. Paste the report text instead.",
        { status: 502, retryable: true, diagnostic: diagnosticSnapshot(diagnostics, {
          failureStage: "request",
          sanitizedMessage: "Validated DNS result did not match the requested address family."
        }) }
      ));
      return;
    }
    if (opts?.all === true) {
      callback(null, selected.map(item => ({ address: item.address, family: item.family })));
      return;
    }
    callback(null, selected[0].address, selected[0].family);
  };
}

function normalizePinnedAddresses(addresses) {
  return (Array.isArray(addresses) ? addresses : [])
    .filter(item => item && typeof item.address === "string")
    .map(item => ({ address: item.address, family: item.family || net.isIP(item.address) }))
    .filter(item => (item.family === 4 || item.family === 6) && !isPrivateAddress(item.address));
}

function selectPinnedAddresses(addresses, opts) {
  const family = opts?.family === 4 || opts?.family === 6 ? opts.family : null;
  return family ? addresses.filter(item => item.family === family) : addresses;
}

function classifyRequestErrorStage(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (["ENOTFOUND", "EAI_AGAIN", "ETIMEOUT"].includes(code)) return "dns_resolution";
  if (/CERT|TLS|SSL|PROTO|HANDSHAKE/i.test(code)) return "request";
  return "request";
}

function sanitizedRequestErrorMessage(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (!code) return "Network failure before HTTP response.";
  return `Network failure before HTTP response: ${sanitizeDiagnosticCode(code)}.`;
}

async function lookupAll(hostname, dnsLookup) {
  const raw = await dnsLookup(hostname, { all: true, verbatim: false });
  return (Array.isArray(raw) ? raw : [raw])
    .filter(item => item && typeof item.address === "string")
    .map(item => ({ address: item.address, family: item.family || net.isIP(item.address) }));
}

function parsePublicUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PublicSourceError(
      "PUBLIC_URL_INVALID",
      "Provide a valid public HTTP or HTTPS URL.",
      { status: 400 }
    );
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PublicSourceError(
      "PUBLIC_URL_INVALID",
      "Provide a valid public HTTP or HTTPS URL.",
      { status: 400 }
    );
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new PublicSourceError(
      "PUBLIC_URL_UNSUPPORTED_PROTOCOL",
      "Only public HTTP and HTTPS pages can be analyzed.",
      { status: 400 }
    );
  }
  return url;
}

function isBlockedHostname(hostname) {
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (!net.isIP(hostname) && !hostname.includes(".")) return true;
  return false;
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const ipv4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped) return isPrivateAddress(ipv4Mapped[1]);
  const family = net.isIP(normalized);
  if (family === 4) {
    const parts = normalized.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }
  if (family === 6) {
    return normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff");
  }
  return true;
}

function privateAddressError(diagnostics) {
  return new PublicSourceError(
    "PUBLIC_URL_PRIVATE_ADDRESS_BLOCKED",
    "Private, local, or internal network addresses are blocked. Paste the report text instead.",
    { status: 400, diagnostic: diagnosticSnapshot(diagnostics, {
      failureStage: "ssrf_check",
      addressClassification: "private"
    }) }
  );
}

function normalizeContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function extractReadableContent(body, contentType) {
  if (contentType === "text/plain") {
    return { title: "", text: trimToAnalysisLimit(normalizeWhitespace(body)) };
  }
  const title = decodeEntities((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim());
  const structural = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:nav|footer|header|form|button|aside)[\s\S]*?<\/(?:nav|footer|header|form|button|aside)>/gi, " ")
    .replace(/<\/(?:h1|h2|h3|p|li|article|section|main|div)>/gi, "\n");
  const text = trimToAnalysisLimit(normalizeWhitespace(decodeEntities(stripTags(structural))));
  return { title: trimToAnalysisLimit(normalizeWhitespace(title), 220), text };
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildAnalysisText({ originalUrl, finalUrl, title, text }) {
  const prefix = [
    `Public source URL: ${finalUrl}`,
    originalUrl !== finalUrl ? `Original submitted URL: ${originalUrl}` : "",
    title ? `Page title: ${title}` : "",
    "Extracted public page text:"
  ].filter(Boolean).join("\n");
  const available = Math.max(600, MAX_ANALYSIS_TEXT - prefix.length - 2);
  return `${prefix}\n${trimToAnalysisLimit(text, available)}`.slice(0, MAX_ANALYSIS_TEXT);
}

function trimToAnalysisLimit(value, limit = MAX_ANALYSIS_TEXT) {
  const normalized = String(value || "").trim();
  if (normalized.length <= limit) return normalized;
  const sliced = normalized.slice(0, limit);
  const lastSpace = sliced.lastIndexOf(" ");
  return `${sliced.slice(0, lastSpace > 400 ? lastSpace : limit).trim()}...`;
}

module.exports = {
  PublicSourceError,
  extractPublicSource,
  getLastPublicUrlFailureDiagnostic,
  parsePublicUrl,
  recordPublicUrlFailureDiagnostic,
  isPrivateAddress,
  extractReadableContent
};
