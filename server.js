const http = require("http");
const fs = require("fs");
const path = require("path");

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

async function handleApi(req, res) {
  if (req.method === "GET" && req.url === "/api/health/gonka") {
    return sendJson(res, 200, {
      ok: Boolean(process.env.GONKA_API_KEY),
      baseUrl: process.env.GONKA_BASE_URL || "https://api.gonkarouter.io/v1",
      analystModel: process.env.GONKA_ANALYST_MODEL || null,
      reviewerModel: process.env.GONKA_REVIEWER_MODEL || null,
      message: process.env.GONKA_API_KEY
        ? "Gonka environment variables are present. Replace placeholder routes with real inference calls."
        : "Gonka API key is not configured yet. Use mock or replay mode."
    });
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

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, message: "Internal server error" });
  }
});

server.listen(port, host, () => {
  console.log(`CrisisRoute AI running at http://${host}:${port}`);
});
