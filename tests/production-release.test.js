"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  createServer,
  createGracefulShutdown,
  productionReadiness,
  parseAnalysisLimit,
  CONTENT_SECURITY_POLICY
} = require("../server");

const root = path.resolve(__dirname, "..");
const productionEnv = Object.freeze({
  NODE_ENV: "production",
  GONKA_LIVE_ENABLED: "true",
  GONKA_API_KEY: "unit-test-production-key",
  GONKA_BASE_URL: "https://api.gonkarouter.io/v1",
  GONKA_ANALYST_MODEL: "deepseek-ai/DeepSeek-V4-Flash-0731",
  GONKA_REVIEWER_MODEL: "MiniMaxAI/MiniMax-M2.7",
  GONKA_MAX_ANALYSES_PER_PROCESS: "12"
});

async function startServer(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    if (!server.listening) return;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function safeServices() {
  return {
    decisionLedger: {
      registerAnalysisResult() {},
      recordDecision() { return { status: "RECORDED", executionStatus: "NOT_EXECUTED" }; },
      getAudit() { return { entries: [], valid: true }; }
    },
    briefService: {
      generateBrief() { return { brief: {}, proofCapsule: {} }; },
      verifyProof() { return { valid: true }; }
    }
  };
}

function createTestApp({ env = productionEnv, analyze, maxAnalysisSubmissions } = {}) {
  let analyzeCalls = 0;
  let factoryCalls = 0;
  const analyzeIncidentsFn = analyze || (async () => {
    analyzeCalls += 1;
    return { resources: [], rawReports: [], incidents: [], meta: { mode: "test" } };
  });
  const app = createServer({
    env: { ...env },
    maxAnalysisSubmissions,
    analyzeIncidentsFn,
    gonkaClientFactory: () => {
      factoryCalls += 1;
      return {
        baseUrl: productionEnv.GONKA_BASE_URL,
        models: {
          analyst: productionEnv.GONKA_ANALYST_MODEL,
          reviewer: productionEnv.GONKA_REVIEWER_MODEL
        }
      };
    },
    ...safeServices()
  });
  return {
    app,
    countAnalyze() { return analyzeCalls; },
    countFactory() { return factoryCalls; }
  };
}

async function postAnalyze(baseUrl) {
  return fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: ["synthetic report"] })
  });
}

test("Production without explicit Live enablement returns safe 503 and makes zero Gonka calls", async t => {
  const env = { ...productionEnv, GONKA_LIVE_ENABLED: "false" };
  const fixture = createTestApp({ env });
  const baseUrl = await startServer(t, fixture.app);
  const ready = await fetch(`${baseUrl}/api/health/ready`);
  const analyze = await postAnalyze(baseUrl);
  const body = await analyze.json();

  assert.equal(ready.status, 503);
  assert.equal(analyze.status, 503);
  assert.equal(body.error.code, "LIVE_ANALYSIS_DISABLED");
  assert.equal(fixture.countAnalyze(), 0);
  assert.equal(fixture.countFactory(), 0);
  assert.doesNotMatch(JSON.stringify(body), /unit-test-production-key|GONKA_API_KEY|api\.gonkarouter/);
});

test("Production missing API key is not Ready and makes zero Gonka calls", async t => {
  const env = { ...productionEnv };
  delete env.GONKA_API_KEY;
  const fixture = createTestApp({ env });
  const baseUrl = await startServer(t, fixture.app);
  const ready = await fetch(`${baseUrl}/api/health/ready`);
  const analyze = await postAnalyze(baseUrl);
  const body = await analyze.json();

  assert.equal(ready.status, 503);
  assert.equal(analyze.status, 503);
  assert.equal(body.error.code, "LIVE_CONFIGURATION_INCOMPLETE");
  assert.equal(fixture.countAnalyze(), 0);
  assert.equal(fixture.countFactory(), 0);
});

test("Production complete configuration returns Ready 200 with fixed safe fields", async t => {
  const fixture = createTestApp();
  const baseUrl = await startServer(t, fixture.app);
  const response = await fetch(`${baseUrl}/api/health/ready`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    service: "crisisroute-ai",
    liveAnalysisEnabled: true,
    modelsConfigured: true,
    analyzeProtectionEnabled: true
  });
  assert.equal(fixture.countFactory(), 0);
});

test("Development preserves the existing Analyze behavior without production switches", async t => {
  const fixture = createTestApp({ env: { NODE_ENV: "development" } });
  const baseUrl = await startServer(t, fixture.app);
  const response = await postAnalyze(baseUrl);
  assert.equal(response.status, 200);
  assert.equal(fixture.countAnalyze(), 1);
});

test("Analyze concurrency limit rejects a second request without a model call", async t => {
  let calls = 0;
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const fixture = createTestApp({
    maxAnalysisSubmissions: 5,
    analyze: async () => {
      calls += 1;
      started();
      await new Promise(resolve => { release = resolve; });
      return { resources: [], rawReports: [], incidents: [], meta: {} };
    }
  });
  const baseUrl = await startServer(t, fixture.app);
  const first = postAnalyze(baseUrl);
  await startedPromise;
  const second = await postAnalyze(baseUrl);
  const secondBody = await second.json();
  release();
  const firstResponse = await first;

  assert.equal(firstResponse.status, 200);
  assert.equal(second.status, 429);
  assert.equal(secondBody.error.code, "ANALYSIS_BUSY");
  assert.equal(secondBody.error.retryable, true);
  assert.equal(calls, 1);
});

test("Analyze process budget rejects excess submissions without new model calls", async t => {
  let calls = 0;
  const fixture = createTestApp({
    maxAnalysisSubmissions: 2,
    analyze: async () => {
      calls += 1;
      return { resources: [], rawReports: [], incidents: [], meta: {} };
    }
  });
  const baseUrl = await startServer(t, fixture.app);
  assert.equal((await postAnalyze(baseUrl)).status, 200);
  assert.equal((await postAnalyze(baseUrl)).status, 200);
  const rejected = await postAnalyze(baseUrl);
  const body = await rejected.json();

  assert.equal(rejected.status, 429);
  assert.equal(body.error.code, "ANALYSIS_LIMIT_REACHED");
  assert.equal(body.error.retryable, false);
  assert.equal(calls, 2);
});

test("Upstream failure consumes one budget slot and exhausted budget makes zero new calls", async t => {
  let calls = 0;
  const fixture = createTestApp({
    maxAnalysisSubmissions: 1,
    analyze: async () => {
      calls += 1;
      throw new Error("private upstream detail");
    }
  });
  const baseUrl = await startServer(t, fixture.app);
  const failed = await postAnalyze(baseUrl);
  const rejected = await postAnalyze(baseUrl);
  const body = await rejected.json();

  assert.equal(failed.status, 500);
  assert.equal(rejected.status, 429);
  assert.equal(body.error.code, "ANALYSIS_LIMIT_REACHED");
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(body), /private upstream detail/);
});

test("Health, Decision, and Brief routes do not consume Analyze budget", async t => {
  let calls = 0;
  const fixture = createTestApp({
    maxAnalysisSubmissions: 1,
    analyze: async () => {
      calls += 1;
      return { resources: [], rawReports: [], incidents: [], meta: {} };
    }
  });
  const baseUrl = await startServer(t, fixture.app);
  await fetch(`${baseUrl}/api/health/ready`);
  await fetch(`${baseUrl}/api/health/gonka`);
  await fetch(`${baseUrl}/api/incidents/CR-TEST/decision`, { method: "POST", body: "{}" });
  await fetch(`${baseUrl}/api/incidents/CR-TEST/brief`, { method: "POST", body: "{}" });
  assert.equal((await postAnalyze(baseUrl)).status, 200);
  assert.equal((await postAnalyze(baseUrl)).status, 429);
  assert.equal(calls, 1);
});

test("HTML and API responses carry strict security headers without wildcard CORS", async t => {
  const fixture = createTestApp();
  const baseUrl = await startServer(t, fixture.app);
  const html = await fetch(`${baseUrl}/`);
  const api = await fetch(`${baseUrl}/api/health/ready`);

  for (const response of [html, api]) {
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(api.headers.get("cache-control"), "no-store");
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /script-src[^;]*\*|script-src[^;]*'unsafe-inline'/);
});

test("HSTS is limited to production requests identified as HTTPS", async t => {
  const fixture = createTestApp();
  const baseUrl = await startServer(t, fixture.app);
  const localHttp = await fetch(`${baseUrl}/`);
  const forwardedHttps = await fetch(`${baseUrl}/`, { headers: { "X-Forwarded-Proto": "https" } });

  assert.equal(localHttp.headers.get("strict-transport-security"), null);
  assert.match(forwardedHttps.headers.get("strict-transport-security"), /max-age=31536000/);
});

test("Graceful Shutdown is idempotent and closes the injected listener", async t => {
  const fixture = createTestApp();
  await startServer(t, fixture.app);
  const shutdown = createGracefulShutdown(fixture.app, { timeoutMs: 1_000 });
  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(fixture.app.listening, false);
  await shutdown();
});

test("Production helper validates explicit configuration and bounded limits", () => {
  assert.equal(productionReadiness(productionEnv).ready, true);
  assert.equal(productionReadiness({ ...productionEnv, GONKA_BASE_URL: "https://example.com/not-v1" }).ready, false);
  assert.equal(parseAnalysisLimit("1"), 1);
  assert.equal(parseAnalysisLimit("100"), 100);
  assert.equal(parseAnalysisLimit("0"), 12);
  assert.equal(parseAnalysisLimit("Infinity"), 12);
  assert.equal(parseAnalysisLimit("101"), 12);
});

test("Render config, lockfile, README, and UI meet the Production release contract", () => {
  const render = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
  const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const frontend = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

  assert.match(render, /healthCheckPath:\s*\/api\/health\/ready/);
  assert.match(render, /key:\s*GONKA_API_KEY\s*\r?\n\s*sync:\s*false/);
  assert.doesNotMatch(render, /GONKA_API_KEY\s*\r?\n\s*value:/);
  assert.equal(Object.keys(lockfile.packages).length, 1);
  assert.match(readme, /Proof Capsule has no blockchain or external anchoring/i);
  assert.match(readme, /ephemeral/i);
  assert.match(readme, /Public URL retrieval/i);
  assert.match(frontend, /Paste a crisis report or public source URL/);
  assert.match(frontend, /Publicly accessible HTTP\/HTTPS pages only/);
  assert.doesNotMatch(frontend, /Public URL content retrieval is not included in this demo\./);
});

test("Render Blueprint pins one free Singapore web service with a manual secret", () => {
  const render = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
  const serviceTypes = [...render.matchAll(/^  - type:\s*(\S+)\s*$/gm)].map(match => match[1]);
  const field = name => {
    const matches = [...render.matchAll(new RegExp(`^    ${name}:\\s*([^\\r\\n]+)\\s*$`, "gm"))];
    assert.equal(matches.length, 1, `${name} must occur exactly once on the service`);
    return matches[0][1].trim();
  };

  assert.deepEqual(serviceTypes, ["web"]);
  assert.equal(field("runtime"), "node");
  assert.equal(field("plan"), "free");
  assert.equal(field("region"), "singapore");
  assert.equal(field("branch"), "main");
  assert.equal(field("buildCommand"), "npm ci --omit=dev");
  assert.equal(field("startCommand"), "npm start");
  assert.equal(field("healthCheckPath"), "/api/health/ready");

  const plans = [...render.matchAll(/^\s+plan:\s*(\S+)\s*$/gm)].map(match => match[1]);
  assert.deepEqual(plans, ["free"]);
  assert.doesNotMatch(render, /^(?:databases|envVarGroups):/m);
  assert.doesNotMatch(render, /^\s+(?:disk|diskSizeGB|previewDiskSizeGB):/m);
  assert.doesNotMatch(render, /^  - type:\s*(?:pserv|worker|cron|keyvalue|redis)\s*$/m);

  const apiKeyBlocks = [...render.matchAll(
    /^      - key:\s*GONKA_API_KEY\s*\r?\n((?:^        [^\r\n]*(?:\r?\n|$))*)/gm
  )];
  assert.equal(apiKeyBlocks.length, 1);
  assert.equal(apiKeyBlocks[0][1].trim(), "sync: false");
  assert.doesNotMatch(apiKeyBlocks[0][1], /^\s*value:/m);
});

test("Release Audit stays offline and never reads .env.local", () => {
  const auditSource = fs.readFileSync(path.join(root, "scripts/release-audit.js"), "utf8");
  assert.doesNotMatch(auditSource, /read\(["']\.env\.local["']\)/);
  const output = execFileSync(process.execPath, ["scripts/release-audit.js"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  assert.match(output, /B12-A Release Audit: PASS/);
  assert.match(output, /Private env files read: 0/);
  assert.match(output, /External network requests: 0/);
});
