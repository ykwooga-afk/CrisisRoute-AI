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

const root = __dirname;
const srcRoot = path.resolve(root, "src");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);

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

function mapApiError(error) {
  if (error instanceof IncidentPipelineError) {
    const failureMetadata = safeFailureMetadata(error);
    if (error.code === "INVALID_REQUEST") {
      return { status: 400, code: error.code, message: "Request body or messages are invalid.", retryable: false };
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

async function handleApi(req, res, { gonkaClientFactory }) {
  if (req.method === "GET" && req.url === "/api/health/gonka") {
    const configuration = getLiveConfiguration(gonkaClientFactory);
    return sendJson(res, 200, {
      ok: configuration.ready,
      liveRoutesReady: configuration.ready,
      capabilities: {
        analyzeCase01: configuration.ready,
        fullScenario: configuration.ready,
        decision: false,
        brief: false
      },
      baseUrl: configuration.client?.baseUrl || process.env.GONKA_BASE_URL || DEFAULT_GONKA_BASE_URL,
      analystModel: configuration.client?.models.analyst || process.env.GONKA_ANALYST_MODEL || DEFAULT_MODELS.analyst,
      reviewerModel: configuration.client?.models.reviewer || process.env.GONKA_REVIEWER_MODEL || DEFAULT_MODELS.reviewer,
      message: configuration.ready
        ? "Live CASE 01 analysis route is configured; human approval remains required."
        : "Gonka configuration is missing or invalid."
    });
  }

  if (req.method === "POST" && req.url === "/api/incidents/analyze") {
    try {
      const payload = await parseJsonBody(req);
      const client = gonkaClientFactory();
      const result = await analyzeIncidents({
        payload,
        client
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
  gonkaClientFactory = createGonkaClientFromEnv
} = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.url?.startsWith("/api/")) {
        await handleApi(req, res, { gonkaClientFactory });
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
}

if (require.main === module) {
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`CrisisRoute AI running at http://${host}:${port}`);
  });
}

module.exports = { createServer };
