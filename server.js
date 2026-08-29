const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);

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

function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, message: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`CrisisRoute AI running at http://${host}:${port}`);
});
