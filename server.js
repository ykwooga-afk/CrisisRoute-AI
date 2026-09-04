const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  GonkaClientError,
  createGonkaClientFromEnv,
  DEFAULT_GONKA_BASE_URL,
  DEFAULT_MODELS
} = require("./backend/gonkaClient");
const {
  IncidentPipelineError,
  analyzeIncidents
} = require("./backend/incidentPipeline");
const {
  DecisionLedgerError,
  createDecisionLedger
} = require("./backend/decisionLedger");
const {
  BriefServiceError,
  createBriefService
} = require("./backend/briefService");
const {
  PublicSourceError,
  extractPublicSource
} = require("./backend/publicSourceExtractor");

const root = __dirname;
const srcRoot = path.resolve(root, "src");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const PRODUCTION_DEFAULT_MAX_ANALYSES = 12;
const MAX_ANALYSES_UPPER_BOUND = 100;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "object-src 'none'"
].join("; ");

const publicRootFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/CrisisRoute-AI-Latest-App.html", "CrisisRoute-AI-Latest-App.html"]
]);

const publicSrcExtensions = new Set([
  ".html",
  ".css",
  ".js",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".ico"
]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const safeFailedRoles = new Set(["analyst", "reviewer", "both"]);
const safeRoleErrorCodes = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "HTTP_ERROR",
  "INVALID_MODEL_DATA",
  "RESPONSE_TOO_LARGE"
]);

function safeFailureMetadata(error) {
  const metadata = {};
  if (safeFailedRoles.has(error?.role)) {
    metadata.role = error.role;
    metadata.failedRole = error.role;
  }
  if (error?.roleErrors && typeof error.roleErrors === "object" && !Array.isArray(error.roleErrors)) {
    const roleErrors = {};
    for (const role of ["analyst", "reviewer"]) {
      if (safeRoleErrorCodes.has(error.roleErrors[role])) roleErrors[role] = error.roleErrors[role];
    }
    if (Object.keys(roleErrors).length) metadata.roleErrors = roleErrors;
  }
  return metadata;
}

function safePipelineErrorMessage(code, role) {
  const displayRole = role === "analyst" ? "Analyst" : role === "reviewer" ? "Reviewer" : null;
  if (code === "INVALID_MODEL_DATA") {
    return displayRole ? `${displayRole} model data was invalid.` : "One or more model responses contained invalid data.";
  }
  if (code === "TIMEOUT") {
    return displayRole ? `${displayRole} model timed out.` : "One or more models timed out.";
  }
  if (code === "NETWORK_ERROR") return "One or more Gonka network requests failed.";
  if (code === "HTTP_ERROR") return "One or more Gonka requests returned an unsuccessful status.";
  if (code === "RESPONSE_TOO_LARGE") return "One or more Gonka responses exceeded the safe size limit.";
  return "One or more model requests failed.";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function sendFixedApiError(res, status, code, message, retryable = false) {
  return sendJson(res, status, {
    ok: false,
    error: { code, message, retryable }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function getLiveConfiguration(gonkaClientFactory) {
  try {
    const client = gonkaClientFactory();
    return { ready: true, client };
  } catch {
    return { ready: false, client: null };
  }
}

function hasConfiguredValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidProductionBaseUrl(value) {
  if (!hasConfiguredValue(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.replace(/\/+$/, "") === "/v1";
  } catch {
    return false;
  }
}

function productionReadiness(env) {
  const liveAnalysisEnabled = env.GONKA_LIVE_ENABLED === "true";
  const modelsConfigured = hasConfiguredValue(env.GONKA_ANALYST_MODEL) &&
    hasConfiguredValue(env.GONKA_REVIEWER_MODEL);
  const configurationComplete = hasConfiguredValue(env.GONKA_API_KEY) &&
    isValidProductionBaseUrl(env.GONKA_BASE_URL) &&
    modelsConfigured;
  const ready = liveAnalysisEnabled && configurationComplete;
  return {
    ready,
    liveAnalysisEnabled,
    modelsConfigured,
    errorCode: liveAnalysisEnabled
      ? configurationComplete ? null : "LIVE_CONFIGURATION_INCOMPLETE"
      : "LIVE_ANALYSIS_DISABLED"
  };
}

function runtimeReadiness({ env, isProduction, gonkaClientFactory, shuttingDown }) {
  if (shuttingDown) {
    return {
      ready: false,
      liveAnalysisEnabled: false,
      modelsConfigured: false,
      errorCode: "SERVICE_SHUTTING_DOWN",
      client: null
    };
  }
  if (isProduction) return { ...productionReadiness(env), client: null };
  const configuration = getLiveConfiguration(gonkaClientFactory);
  return {
    ready: configuration.ready,
    liveAnalysisEnabled: configuration.ready,
    modelsConfigured: configuration.ready,
    errorCode: configuration.ready ? null : "LIVE_CONFIGURATION_INCOMPLETE",
    client: configuration.client
  };
}

function parseAnalysisLimit(value, fallback = PRODUCTION_DEFAULT_MAX_ANALYSES) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= MAX_ANALYSES_UPPER_BOUND
      ? value
      : fallback;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_ANALYSES_UPPER_BOUND
    ? parsed
    : fallback;
}

function createAnalysisProtection({ enabled, maxSubmissions }) {
  let submissions = 0;
  let active = 0;
  let shuttingDown = false;

  return {
    beginShutdown() {
      shuttingDown = true;
    },
    isShuttingDown() {
      return shuttingDown;
    },
    isEnabled() {
      return enabled;
    },
    acquire() {
      if (shuttingDown) {
        return { code: "SERVICE_SHUTTING_DOWN", status: 503 };
      }
      if (enabled && active >= 1) {
        return { code: "ANALYSIS_BUSY", status: 429 };
      }
      if (enabled && submissions >= maxSubmissions) {
        return { code: "ANALYSIS_LIMIT_REACHED", status: 429 };
      }
      submissions += 1;
      active += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
        }
      };
    }
  };
}

function isForwardedHttps(req) {
  if (req.socket?.encrypted === true) return true;
  const forwarded = req.headers?.["x-forwarded-proto"];
  return typeof forwarded === "string" && forwarded.split(",")[0].trim().toLowerCase() === "https";
}

function applySecurityHeaders(req, res, { isProduction }) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  if (req.url?.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  if (isProduction && isForwardedHttps(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function mapApiError(error) {
  if (error instanceof PublicSourceError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      retryable: error.retryable
    };
  }

  if (error instanceof BriefServiceError) {
    const statusByCode = {
      INVALID_PROOF_REQUEST: 400,
      DECISION_REQUIRED: 409,
      AUDIT_INTEGRITY_FAILURE: 409
    };
    return {
      status: statusByCode[error.code] || 500,
      code: statusByCode[error.code] ? error.code : "INTERNAL_ERROR",
      message: statusByCode[error.code] ? error.message : "Internal server error.",
      retryable: false
    };
  }

  if (error instanceof DecisionLedgerError) {
    const statusByCode = {
      INVALID_DECISION_REQUEST: 400,
      INVALID_CASE_ID: 400,
      UNKNOWN_DECISION_ACTION: 422,
      ANALYSIS_CONTEXT_NOT_FOUND: 404,
      DECISION_NOT_ALLOWED: 409,
      ACKNOWLEDGEMENT_REQUIRED: 409,
      IDEMPOTENCY_CONFLICT: 409
    };
    return {
      status: statusByCode[error.code] || 500,
      code: statusByCode[error.code] ? error.code : "INTERNAL_ERROR",
      message: statusByCode[error.code] ? error.message : "Internal server error.",
      retryable: false
    };
  }

  if (error instanceof IncidentPipelineError) {
    const failureMetadata = safeFailureMetadata(error);
    if (error.code === "INVALID_REQUEST") {
      return { status: 400, code: error.code, message: "Request body or messages are invalid.", retryable: false };
    }
    if (error.code === "INVALID_SCENARIO_INPUT") {
      return {
        status: 400,
        code: error.code,
        message: "The fixed haze demonstration scenario input is invalid.",
        retryable: false
      };
    }
    if (error.code === "INVALID_MODEL_DATA") {
      return {
        status: 502,
        code: error.code,
        message: safePipelineErrorMessage(error.code, failureMetadata.role),
        retryable: false,
        ...failureMetadata,
        issues: error.issues,
        issuePaths: error.issues
      };
    }
    if (error.code === "CONFIGURATION_ERROR") {
      return { status: 503, code: error.code, message: "Live Gonka configuration is unavailable.", retryable: false };
    }
    if (error.code === "TIMEOUT") {
      return {
        status: 504,
        code: error.code,
        message: safePipelineErrorMessage(error.code, failureMetadata.role),
        retryable: true,
        ...failureMetadata
      };
    }
    if (["NETWORK_ERROR", "HTTP_ERROR", "RESPONSE_TOO_LARGE", "UPSTREAM_ERROR"].includes(error.code)) {
      return {
        status: 502,
        code: error.code,
        message: safePipelineErrorMessage(error.code, failureMetadata.role),
        retryable: error.retryable === true,
        ...failureMetadata
      };
    }
  }

  if (error instanceof GonkaClientError) {
    if (error.code === "MISSING_API_KEY" || error.code === "INVALID_BASE_URL") {
      return { status: 503, code: error.code, message: "Live Gonka configuration is unavailable.", retryable: false };
    }
    if (error.code === "TIMEOUT") {
      return { status: 504, code: error.code, message: "Gonka analysis timed out.", retryable: true };
    }
    if (["NETWORK_ERROR", "HTTP_ERROR", "INVALID_RESPONSE", "INVALID_JSON"].includes(error.code)) {
      return {
        status: 502,
        code: error.code,
        message: "Gonka analysis returned an unavailable or invalid upstream response.",
        retryable: error.retryable === true
      };
    }
  }

  return { status: 500, code: "INTERNAL_ERROR", message: "Internal server error.", retryable: false };
}

function sendApiError(res, error) {
  const mapped = mapApiError(error);
  const publicError = {
    code: mapped.code,
    message: mapped.message,
    retryable: mapped.retryable
  };
  if (["analyst", "reviewer", "both"].includes(mapped.role)) {
    publicError.role = mapped.role;
  }
  if (Array.isArray(mapped.issues)) {
    publicError.issues = mapped.issues.slice(0, 5);
  }
  if (["analyst", "reviewer", "both"].includes(mapped.failedRole)) {
    publicError.failedRole = mapped.failedRole;
  }
  if (Array.isArray(mapped.issuePaths)) {
    publicError.issuePaths = mapped.issuePaths.slice(0, 5);
  }
  if (mapped.roleErrors && typeof mapped.roleErrors === "object" && !Array.isArray(mapped.roleErrors)) {
    const roleErrors = {};
    for (const role of ["analyst", "reviewer"]) {
      if (safeRoleErrorCodes.has(mapped.roleErrors[role])) roleErrors[role] = mapped.roleErrors[role];
    }
    if (Object.keys(roleErrors).length) publicError.roleErrors = roleErrors;
  }
  return sendJson(res, mapped.status, {
    ok: false,
    error: publicError
  });
}

async function parseJsonBody(req) {
  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch {
    throw new IncidentPipelineError("INVALID_REQUEST", "Request body is invalid.");
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new IncidentPipelineError("INVALID_REQUEST", "Request body is invalid JSON.");
  }
}

function parseCaseRoute(requestTarget) {
  if (typeof requestTarget !== "string") return null;
  const separatorIndex = requestTarget.search(/[?#]/);
  const rawPathname = separatorIndex === -1
    ? requestTarget
    : requestTarget.slice(0, separatorIndex);
  if (!rawPathname.startsWith("/api/incidents/")) return null;

  const suffixMatch = rawPathname.match(/\/(decision|audit|brief)(?:\/|$)/);
  if (!suffixMatch) return null;
  const exactMatch = rawPathname.match(/^\/api\/incidents\/([^/]+)\/(decision|audit|brief)$/);
  if (!exactMatch || exactMatch[1].length > 96) {
    throw new DecisionLedgerError("INVALID_CASE_ID");
  }

  let caseId;
  try {
    caseId = decodeURIComponent(exactMatch[1]);
  } catch {
    throw new DecisionLedgerError("INVALID_CASE_ID");
  }
  if (caseId.includes("/") || caseId.includes("\\") || caseId.includes("\0")) {
    throw new DecisionLedgerError("INVALID_CASE_ID");
  }
  return { caseId, kind: exactMatch[2] };
}

function decoratePublicSourceResult(result, publicSource) {
  let hostname = "public source";
  try {
    hostname = new URL(publicSource.finalUrl).hostname;
  } catch {}
  const sourceMeta = {
    originalUrl: publicSource.originalUrl,
    finalUrl: publicSource.finalUrl,
    title: publicSource.title || "",
    contentType: publicSource.contentType,
    bytesRead: publicSource.bytesRead,
    redirected: publicSource.redirected === true
  };
  return {
    ...result,
    rawReports: [publicSource.analysisText],
    meta: {
      ...(result.meta || {}),
      publicSource: sourceMeta
    },
    incidents: Array.isArray(result.incidents)
      ? result.incidents.map((incident, index) => index === 0
        ? {
          ...incident,
          source: `Public URL: ${hostname}`,
          publicSource: sourceMeta,
          evidence: Array.isArray(incident.evidence)
            ? incident.evidence.map((item, itemIndex) => itemIndex === 0
              ? {
                ...item,
                type: "public_url_extract",
                summary: item.summary || `Readable text extracted from ${hostname}.`,
                sourceUrl: publicSource.finalUrl
              }
              : item)
            : incident.evidence
        }
        : incident)
      : result.incidents
  };
}

async function handleApi(req, res, {
  gonkaClientFactory,
  analyzeIncidentsFn,
  publicSourceExtractor,
  decisionLedger,
  briefService,
  env,
  isProduction,
  analysisProtection
}) {
  if (req.method === "GET" && req.url === "/api/health/ready") {
    const readiness = runtimeReadiness({
      env,
      isProduction,
      gonkaClientFactory,
      shuttingDown: analysisProtection.isShuttingDown()
    });
    const body = {
      ok: readiness.ready,
      service: "crisisroute-ai",
      liveAnalysisEnabled: readiness.liveAnalysisEnabled,
      modelsConfigured: readiness.modelsConfigured,
      analyzeProtectionEnabled: analysisProtection.isEnabled()
    };
    if (!readiness.ready) {
      body.error = {
        code: readiness.errorCode,
        message: "Live analysis is not ready for this deployment."
      };
    }
    return sendJson(res, readiness.ready ? 200 : 503, body);
  }

  if (req.method === "GET" && req.url === "/api/health/gonka") {
    const readiness = runtimeReadiness({
      env,
      isProduction,
      gonkaClientFactory,
      shuttingDown: analysisProtection.isShuttingDown()
    });
    let configuration = { ready: readiness.ready, client: readiness.client };
    if (isProduction && readiness.ready) {
      configuration = getLiveConfiguration(gonkaClientFactory);
    }
    const ready = readiness.ready && configuration.ready;
    return sendJson(res, 200, {
      ok: ready,
      liveRoutesReady: ready,
      capabilities: {
        analyzeCase01: ready,
        fullScenario: ready,
        decision: true,
        brief: true
      },
      decisionStorage: "ephemeral",
      decisionExternalAnchoring: "none",
      decisionAuthentication: "demo_local_only",
      briefGeneration: "deterministic",
      proofIntegrityScope: "local_payload_integrity",
      proofExternalAnchoring: "none",
      analyzeProtectionEnabled: analysisProtection.isEnabled(),
      baseUrl: configuration.client?.baseUrl || env.GONKA_BASE_URL || DEFAULT_GONKA_BASE_URL,
      analystModel: configuration.client?.models.analyst || env.GONKA_ANALYST_MODEL || DEFAULT_MODELS.analyst,
      reviewerModel: configuration.client?.models.reviewer || env.GONKA_REVIEWER_MODEL || DEFAULT_MODELS.reviewer,
      message: ready
        ? "Live CASE 01 analysis route is configured; human approval remains required."
        : "Gonka configuration is missing or invalid."
    });
  }

  if (req.method === "POST" && req.url === "/api/incidents/analyze") {
    if (isProduction) {
      const readiness = runtimeReadiness({
        env,
        isProduction,
        gonkaClientFactory,
        shuttingDown: analysisProtection.isShuttingDown()
      });
      if (!readiness.ready) {
        const code = readiness.errorCode === "LIVE_ANALYSIS_DISABLED"
          ? "LIVE_ANALYSIS_DISABLED"
          : "LIVE_CONFIGURATION_INCOMPLETE";
        return sendFixedApiError(
          res,
          503,
          code,
          code === "LIVE_ANALYSIS_DISABLED"
            ? "Live analysis is disabled for this deployment."
            : "Live analysis configuration is incomplete."
        );
      }
    }

    const lease = analysisProtection.acquire();
    if (lease.code) {
      const message = lease.code === "ANALYSIS_BUSY"
        ? "Another analysis is currently running."
        : lease.code === "ANALYSIS_LIMIT_REACHED"
          ? "This process has reached its analysis submission limit."
          : "The service is shutting down.";
      return sendFixedApiError(res, lease.status, lease.code, message, lease.code === "ANALYSIS_BUSY");
    }
    try {
      const payload = await parseJsonBody(req);
      const client = analyzeIncidentsFn === analyzeIncidents ? gonkaClientFactory() : undefined;
      const result = await analyzeIncidentsFn({ payload, client });
      decisionLedger.registerAnalysisResult(result);
      return sendJson(res, 200, result);
    } catch (error) {
      return sendApiError(res, error);
    } finally {
      lease.release();
    }
  }

  if (req.url === "/api/public-source/analyze") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, {
        ok: false,
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Method not allowed for this API route.",
          retryable: false
        }
      });
    }

    if (isProduction) {
      const readiness = runtimeReadiness({
        env,
        isProduction,
        gonkaClientFactory,
        shuttingDown: analysisProtection.isShuttingDown()
      });
      if (!readiness.ready) {
        const code = readiness.errorCode === "LIVE_ANALYSIS_DISABLED"
          ? "LIVE_ANALYSIS_DISABLED"
          : "LIVE_CONFIGURATION_INCOMPLETE";
        return sendFixedApiError(
          res,
          503,
          code,
          code === "LIVE_ANALYSIS_DISABLED"
            ? "Live analysis is disabled for this deployment."
            : "Live analysis configuration is incomplete."
        );
      }
    }

    const lease = analysisProtection.acquire();
    if (lease.code) {
      const message = lease.code === "ANALYSIS_BUSY"
        ? "Another analysis is currently running."
        : lease.code === "ANALYSIS_LIMIT_REACHED"
          ? "This process has reached its analysis submission limit."
          : "The service is shutting down.";
      return sendFixedApiError(res, lease.status, lease.code, message, lease.code === "ANALYSIS_BUSY");
    }

    try {
      const payload = await parseJsonBody(req);
      const publicSource = await publicSourceExtractor(payload?.url);
      const client = analyzeIncidentsFn === analyzeIncidents ? gonkaClientFactory() : undefined;
      const result = await analyzeIncidentsFn({
        payload: { messages: [publicSource.analysisText] },
        client
      });
      const decorated = decoratePublicSourceResult(result, publicSource);
      decisionLedger.registerAnalysisResult(decorated);
      return sendJson(res, 200, decorated);
    } catch (error) {
      return sendApiError(res, error);
    } finally {
      lease.release();
    }
  }

  if (req.url === "/api/proof/verify") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, {
        ok: false,
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Method not allowed for this API route.",
          retryable: false
        }
      });
    }
    try {
      let payload;
      try {
        payload = await parseJsonBody(req);
      } catch {
        throw new BriefServiceError("INVALID_PROOF_REQUEST");
      }
      return sendJson(res, 200, briefService.verifyProof(payload));
    } catch (error) {
      return sendApiError(res, error);
    }
  }

  let caseRoute;
  try {
    caseRoute = parseCaseRoute(req.url);
  } catch (error) {
    return sendApiError(res, error);
  }
  if (caseRoute) {
    const expectedMethod = caseRoute.kind === "audit" ? "GET" : "POST";
    if (req.method !== expectedMethod) {
      res.setHeader("Allow", expectedMethod);
      return sendJson(res, 405, {
        ok: false,
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Method not allowed for this API route.",
          retryable: false
        }
      });
    }
    try {
      if (caseRoute.kind === "audit") {
        return sendJson(res, 200, decisionLedger.getAudit(caseRoute.caseId));
      }
      if (caseRoute.kind === "brief") {
        return sendJson(res, 200, briefService.generateBrief(caseRoute.caseId));
      }
      let payload;
      try {
        payload = await parseJsonBody(req);
      } catch {
        throw new DecisionLedgerError("INVALID_DECISION_REQUEST");
      }
      const result = decisionLedger.recordDecision({
        caseId: caseRoute.caseId,
        payload,
        idempotencyKey: req.headers["idempotency-key"]
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendApiError(res, error);
    }
  }

  if (req.method === "POST" && req.url?.startsWith("/api/incidents")) {
    await readBody(req).catch(() => "{}");
    return sendJson(res, 501, {
      ok: false,
      handoff: true,
      message:
        "Backend handoff point: replace this placeholder with real Gonka Router Analyst, Reviewer, Consensus, Brief and Decision logic.",
      expectedRoutes: [
        "POST /api/incidents/analyze",
        "POST /api/incidents/review",
        "POST /api/incidents/consensus",
        "POST /api/incidents/:id/brief",
        "POST /api/incidents/:id/decision"
      ]
    });
  }

  return sendJson(res, 404, { ok: false, message: "API route not found" });
}

function sendStaticText(res, status, message, extraHeaders = {}, headOnly = false) {
  const body = Buffer.from(message, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  res.end(headOnly ? undefined : body);
}

function resolveStaticFile(requestTarget) {
  if (
    typeof requestTarget !== "string" ||
    !requestTarget.startsWith("/") ||
    requestTarget.startsWith("//") ||
    requestTarget.includes("\\")
  ) {
    return null;
  }

  const separatorIndex = requestTarget.search(/[?#]/);
  const rawPathname = separatorIndex === -1
    ? requestTarget
    : requestTarget.slice(0, separatorIndex);

  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }

  if (
    pathname.includes("\0") ||
    pathname.includes("\\") ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//")
  ) {
    return null;
  }

  const segments = pathname.split("/").slice(1);
  if (segments.some(segment => segment.startsWith(".") || segment.includes(":"))) {
    return null;
  }

  const rootFile = publicRootFiles.get(pathname);
  if (rootFile) {
    const filePath = path.resolve(root, rootFile);
    return path.dirname(filePath) === root ? filePath : null;
  }

  if (!pathname.startsWith("/src/") || segments.length < 2) {
    return null;
  }

  const relativeSegments = segments.slice(1);
  if (relativeSegments.some(segment => segment.length === 0)) {
    return null;
  }

  const filePath = path.resolve(srcRoot, ...relativeSegments);
  const relativePath = path.relative(srcRoot, filePath);
  const extension = path.extname(filePath).toLowerCase();
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    !publicSrcExtensions.has(extension)
  ) {
    return null;
  }

  return filePath;
}

async function serveStatic(req, res) {
  const filePath = resolveStaticFile(req.url || "/");
  if (!filePath) {
    sendStaticText(res, 404, "Not found", {}, req.method === "HEAD");
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendStaticText(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return;
  }

  let content;
  try {
    content = await fs.promises.readFile(filePath);
  } catch {
    sendStaticText(res, 404, "Not found", {}, req.method === "HEAD");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext],
    "Content-Length": content.length,
    "X-Content-Type-Options": "nosniff"
  });
  res.end(req.method === "HEAD" ? undefined : content);
}

function createServer({
  gonkaClientFactory = createGonkaClientFromEnv,
  analyzeIncidentsFn = analyzeIncidents,
  publicSourceExtractor = extractPublicSource,
  decisionLedger = createDecisionLedger(),
  briefService = createBriefService({ decisionLedger }),
  env = process.env,
  maxAnalysisSubmissions,
  analysisProtectionEnabled
} = {}) {
  const isProduction = env.NODE_ENV === "production";
  const maxSubmissions = parseAnalysisLimit(
    maxAnalysisSubmissions ?? env.GONKA_MAX_ANALYSES_PER_PROCESS,
    PRODUCTION_DEFAULT_MAX_ANALYSES
  );
  const analysisProtection = createAnalysisProtection({
    enabled: isProduction || analysisProtectionEnabled === true || maxAnalysisSubmissions !== undefined,
    maxSubmissions
  });
  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(req, res, { isProduction });
    try {
      if (req.url?.startsWith("/api/")) {
        await handleApi(req, res, {
          gonkaClientFactory,
          analyzeIncidentsFn,
          publicSourceExtractor,
          decisionLedger,
          briefService,
          env,
          isProduction,
          analysisProtection
        });
        return;
      }
      await serveStatic(req, res);
    } catch (error) {
      if (req.url?.startsWith("/api/")) {
        sendApiError(res, error);
      } else {
        sendJson(res, 500, { ok: false, message: "Internal server error" });
      }
    }
  });
  server.beginShutdown = () => analysisProtection.beginShutdown();
  return server;
}

function createGracefulShutdown(server, { timeoutMs = 30_000 } = {}) {
  let shutdownPromise;
  return function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    server.beginShutdown?.();
    shutdownPromise = new Promise(resolve => {
      if (!server.listening) {
        resolve();
        return;
      }
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, timeoutMs);
      timer.unref?.();
      server.close(() => finish());
    });
    return shutdownPromise;
  };
}

if (require.main === module) {
  const server = createServer();
  const shutdown = createGracefulShutdown(server);
  process.once("SIGTERM", () => {
    shutdown().then(() => process.exitCode = 0);
  });
  process.once("SIGINT", () => {
    shutdown().then(() => process.exitCode = 0);
  });
  server.listen(port, host, () => {
    console.log(`CrisisRoute AI running at http://${host}:${port}`);
  });
}

module.exports = {
  createServer,
  createGracefulShutdown,
  productionReadiness,
  parseAnalysisLimit,
  CONTENT_SECURITY_POLICY
};
