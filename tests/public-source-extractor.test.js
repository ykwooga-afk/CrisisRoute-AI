"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
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
    error => error instanceof PublicSourceError
      && error.code === "PUBLIC_URL_PRIVATE_ADDRESS_BLOCKED"
      && error.diagnostic?.failureStage === "ssrf_check"
      && error.diagnostic?.addressClassification === "private"
  );
  await assert.rejects(
    extractPublicSource("http://localhost/private"),
    error => error instanceof PublicSourceError
      && error.code === "PUBLIC_URL_PRIVATE_HOST_BLOCKED"
      && error.diagnostic?.failureStage === "ssrf_check"
      && error.diagnostic?.addressClassification === "blocked"
  );
  await assert.rejects(
    extractPublicSource("http://[::1]/private"),
    error => error instanceof PublicSourceError && error.code === "PUBLIC_URL_PRIVATE_ADDRESS_BLOCKED"
  );
});

test("DNS failures attach safe diagnostic metadata without exposing full URLs", async () => {
  let caught;
  try {
    await extractPublicSource("https://example.test/news?token=do-not-leak", {
      dnsLookup: async () => {
        const error = new Error("getaddrinfo ENOTFOUND example.test");
        error.code = "ENOTFOUND";
        throw error;
      }
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof PublicSourceError);
  assert.equal(caught.code, "PUBLIC_URL_FETCH_FAILED");
  assert.equal(caught.diagnostic.hostname, "example.test");
  assert.equal(caught.diagnostic.failureStage, "dns_resolution");
  assert.equal(caught.diagnostic.failureCode, "PUBLIC_URL_FETCH_FAILED");
  assert.equal(caught.diagnostic.dnsResolved, false);
  assert.equal(caught.diagnostic.addressClassification, "unknown");
  assert.equal(caught.diagnostic.timeout, false);
  assert.match(caught.diagnostic.sanitizedMessage, /ENOTFOUND/);
  assert.doesNotMatch(JSON.stringify(caught.diagnostic), /do-not-leak|\/news/i);
});

test("validated public DNS results are handed to HTTPS lookup in Node-compatible pinned shape", async t => {
  const originalRequest = https.request;
  let lookupResult;
  t.after(() => {
    https.request = originalRequest;
  });

  https.request = (url, options, onResponse) => {
    assert.equal(url.hostname, "example.test");
    assert.equal(options.servername, "example.test");
    assert.equal(options.rejectUnauthorized, undefined);

    const request = new EventEmitter();
    request.destroy = error => {
      process.nextTick(() => request.emit("error", error));
    };
    request.end = () => {
      options.lookup(url.hostname, { family: undefined, hints: 0, all: true }, (error, addresses, family) => {
        if (error) {
          request.emit("error", error);
          return;
        }
        lookupResult = { addresses, family };
        if (!Array.isArray(addresses)) {
          const invalidAddressError = new Error("Invalid IP address: undefined");
          invalidAddressError.code = "ERR_INVALID_IP_ADDRESS";
          request.emit("error", invalidAddressError);
          return;
        }

        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { "content-type": "text/html; charset=utf-8" };
        response.resume = () => {};
        onResponse(response);
        process.nextTick(() => {
          response.emit("data", Buffer.from(`
            <html>
              <head><title>Public weather report</title></head>
              <body>
                <main>
                  <p>This public article contains enough readable crisis report text for safe analysis.</p>
                  <p>Coordinators should verify location and contact details before action.</p>
                </main>
              </body>
            </html>
          `));
          response.emit("end");
        });
      });
    };
    return request;
  };

  const result = await extractPublicSource("https://example.test/report", {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }]
  });

  assert.deepEqual(lookupResult, {
    addresses: [{ address: "93.184.216.34", family: 4 }],
    family: undefined
  });
  assert.equal(result.finalUrl, "https://example.test/report");
  assert.match(result.text, /readable crisis report text/);
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

test("Public URL diagnostic endpoint exposes only sanitized latest failure metadata", async t => {
  const allowedKeys = new Set([
    "timestamp",
    "hostname",
    "failureStage",
    "failureCode",
    "sanitizedMessage",
    "httpStatus",
    "contentType",
    "redirectCount",
    "durationMs",
    "dnsResolved",
    "addressClassification",
    "timeout"
  ]);
  const app = createServer({
    env: { NODE_ENV: "development" },
    publicSourceExtractor: async () => {
      throw new PublicSourceError(
        "PUBLIC_URL_FETCH_FAILED",
        "This public page could not be fetched safely. Paste the report text instead.",
        {
          status: 502,
          retryable: true,
          diagnostic: {
            hostname: "en.wikipedia.org",
            failureStage: "request",
            sanitizedMessage: "Network failure before HTTP response: ECONNRESET.",
            httpStatus: 502,
            contentType: "text/html; charset=utf-8",
            redirectCount: 1,
            durationMs: 1234,
            dnsResolved: true,
            addressClassification: "public",
            timeout: false
          }
        }
      );
    },
    analyzeIncidentsFn: async () => {
      throw new Error("should not analyze");
    },
    ...safeServices()
  });
  const baseUrl = await startServer(t, app);
  const response = await postPublicUrl(baseUrl, "https://en.wikipedia.org/wiki/Haze?private=do-not-leak");
  const publicBody = await response.json();

  assert.equal(response.status, 502);
  assert.equal(publicBody.error.code, "PUBLIC_URL_FETCH_FAILED");
  assert.equal(publicBody.error.retryable, true);
  assert.equal(publicBody.error.diagnostic, undefined);
  assert.equal(publicBody.diagnostic, undefined);

  const diagnosticResponse = await fetch(`${baseUrl}/api/diagnostics/last-public-url-failure`);
  const diagnosticBody = await diagnosticResponse.json();
  const diagnostic = diagnosticBody.diagnostic;

  assert.equal(diagnosticResponse.status, 200);
  assert.equal(diagnosticBody.ok, true);
  assert.match(diagnostic.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  for (const key of Object.keys(diagnostic)) {
    assert.equal(allowedKeys.has(key), true, `unexpected diagnostic key: ${key}`);
  }
  assert.equal(diagnostic.hostname, "en.wikipedia.org");
  assert.equal(diagnostic.failureStage, "request");
  assert.equal(diagnostic.failureCode, "PUBLIC_URL_FETCH_FAILED");
  assert.equal(diagnostic.sanitizedMessage, "Network failure before HTTP response: ECONNRESET.");
  assert.equal(diagnostic.httpStatus, 502);
  assert.equal(diagnostic.contentType, "text/html; charset=utf-8");
  assert.equal(diagnostic.redirectCount, 1);
  assert.equal(diagnostic.durationMs, 1234);
  assert.equal(diagnostic.dnsResolved, true);
  assert.equal(diagnostic.addressClassification, "public");
  assert.equal(diagnostic.timeout, false);
  assert.doesNotMatch(JSON.stringify(publicBody), /do-not-leak|wiki\/Haze|ECONNRESET/i);
  assert.doesNotMatch(JSON.stringify(diagnosticBody), /do-not-leak|wiki\/Haze/i);
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
