"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createServer } = require("../server");
const {
  PublicSourceError,
  extractPublicSource,
  extractReadableContent,
  isPrivateAddress
} = require("../backend/publicSourceExtractor");

const root = path.resolve(__dirname, "..");

async function startServer(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function safeServices(registerAnalysisResult = () => {}) {
  return {
    decisionLedger: {
      registerAnalysisResult,
      recordDecision() { return { status: "RECORDED", executionStatus: "NOT_EXECUTED" }; },
      getAudit() { return { entries: [], valid: true }; }
    },
    briefService: {
      generateBrief() { return { brief: {}, proofCapsule: {} }; },
      verifyProof() { return { valid: true }; }
    }
  };
}

async function postPublicUrl(baseUrl, url = "https://news.example/haze-alert") {
  return fetch(`${baseUrl}/api/public-source/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
}

test("private, loopback, link-local and metadata addresses are blocked by default", async () => {
  for (const address of ["127.0.0.1", "10.0.0.7", "172.16.0.1", "192.168.1.5", "169.254.169.254", "::1", "fc00::1", "fe80::1"]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  await assert.rejects(
    extractPublicSource("http://127.0.0.1/private"),
    error => error instanceof PublicSourceError && error.code === "PUBLIC_URL_PRIVATE_ADDRESS_BLOCKED"
  );
  await assert.rejects(
    extractPublicSource("http://localhost/private"),
    error => error instanceof PublicSourceError && error.code === "PUBLIC_URL_PRIVATE_HOST_BLOCKED"
  );
  await assert.rejects(
    extractPublicSource("http://[::1]/private"),
    error => error instanceof PublicSourceError && error.code === "PUBLIC_URL_PRIVATE_ADDRESS_BLOCKED"
  );
});

test("readable HTML extraction strips active chrome and preserves useful article text", () => {
  const html = `
    <html>
      <head><title>Campus haze alert</title><style>.x{}</style></head>
      <body>
        <nav>Home Login Cookie banner</nav>
        <main>
          <h1>Campus haze alert</h1>
          <p>Students near Shah Alam report smoke exposure and breathing difficulty.</p>
          <p>Volunteers should verify location before any dispatch.</p>
        </main>
        <script>window.secret = "do not keep";</script>
      </body>
    </html>
  `;
  const result = extractReadableContent(html, "text/html");
  assert.equal(result.title, "Campus haze alert");
  assert.match(result.text, /Students near Shah Alam report smoke exposure/);
  assert.match(result.text, /verify location before any dispatch/);
  assert.doesNotMatch(result.text, /window\.secret|Cookie banner/);
});

test("Public URL API sends extracted text into the existing analyze pipeline and decorates source metadata", async t => {
  let capturedPayload;
  let registered = false;
  const app = createServer({
    env: { NODE_ENV: "development" },
    publicSourceExtractor: async url => ({
      originalUrl: url,
      finalUrl: "https://news.example/haze-alert",
      title: "Campus haze alert",
      text: "Students near Shah Alam report smoke exposure and breathing difficulty.",
      analysisText: "Public source URL: https://news.example/haze-alert\nExtracted public page text:\nStudents near Shah Alam report smoke exposure.",
      contentType: "text/html",
      bytesRead: 512,
      redirected: false
    }),
    analyzeIncidentsFn: async ({ payload }) => {
      capturedPayload = payload;
      return {
        ok: true,
        resources: [],
        rawReports: payload.messages,
        meta: { mode: "live_test" },
        incidents: [{
          caseId: "CR-LIVE-PUBLIC-01",
          label: "A",
          title: "Public source report",
          rawMessage: payload.messages[0],
          source: "Manual intake",
          evidence: [{ id: "E-01", type: "manual_input", summary: "" }],
          scores: { verification: 61, urgency: 82, actionability: 50 },
          operationalState: "NEEDS_HUMAN_REVIEW",
          safetyGates: []
        }]
      };
    },
    ...safeServices(() => { registered = true; })
  });
  const baseUrl = await startServer(t, app);
  const response = await postPublicUrl(baseUrl);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(capturedPayload.messages, [
    "Public source URL: https://news.example/haze-alert\nExtracted public page text:\nStudents near Shah Alam report smoke exposure."
  ]);
  assert.equal(body.meta.publicSource.finalUrl, "https://news.example/haze-alert");
  assert.equal(body.incidents[0].source, "Public URL: news.example");
  assert.equal(body.incidents[0].publicSource.title, "Campus haze alert");
  assert.equal(registered, true);
});

test("Public URL API returns a safe public extraction error without analyzing", async t => {
  let analyzeCalls = 0;
  const app = createServer({
    env: { NODE_ENV: "development" },
    publicSourceExtractor: async () => {
      throw new PublicSourceError(
        "PUBLIC_URL_UNSUPPORTED_CONTENT_TYPE",
        "This public source is not readable text or HTML. Paste the report text instead.",
        { status: 415 }
      );
    },
    analyzeIncidentsFn: async () => {
      analyzeCalls += 1;
      return { incidents: [], resources: [], rawReports: [], meta: {} };
    },
    ...safeServices()
  });
  const baseUrl = await startServer(t, app);
  const response = await postPublicUrl(baseUrl, "https://files.example/image.png");
  const body = await response.json();

  assert.equal(response.status, 415);
  assert.equal(body.error.code, "PUBLIC_URL_UNSUPPORTED_CONTENT_TYPE");
  assert.equal(body.error.retryable, false);
  assert.equal(analyzeCalls, 0);
});

test("Production disabled Live blocks Public URL extraction before fetch or model calls", async t => {
  let extractorCalls = 0;
  let analyzeCalls = 0;
  const app = createServer({
    env: { NODE_ENV: "production", GONKA_LIVE_ENABLED: "false" },
    publicSourceExtractor: async () => {
      extractorCalls += 1;
      throw new Error("should not extract");
    },
    analyzeIncidentsFn: async () => {
      analyzeCalls += 1;
      return { incidents: [], resources: [], rawReports: [], meta: {} };
    },
    ...safeServices()
  });
  const baseUrl = await startServer(t, app);
  const response = await postPublicUrl(baseUrl);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.code, "LIVE_ANALYSIS_DISABLED");
  assert.equal(extractorCalls, 0);
  assert.equal(analyzeCalls, 0);
});

test("URL extractor source includes redirect, timeout, content-type and size safeguards", () => {
  const source = fs.readFileSync(path.join(root, "backend/publicSourceExtractor.js"), "utf8");
  for (const required of [
    "DEFAULT_MAX_REDIRECTS",
    "PUBLIC_URL_REDIRECT_LIMIT",
    "PUBLIC_URL_TIMEOUT",
    "PUBLIC_URL_UNSUPPORTED_CONTENT_TYPE",
    "PUBLIC_URL_TOO_LARGE",
    "PUBLIC_URL_PRIVATE_ADDRESS_BLOCKED",
    "text/html",
    "text/plain"
  ]) {
    assert.ok(source.includes(required), `missing safeguard: ${required}`);
  }
});
