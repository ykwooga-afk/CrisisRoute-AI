const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(error => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const succeed = finish(resolve);
    const fail = finish(reject);
    const timer = setTimeout(() => {
      fail(new Error(`Server start timeout. stderr: ${stderr}`));
    }, 5_000);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("CrisisRoute AI running at")) succeed();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", fail);
    child.once("exit", code => {
      if (!settled) {
        fail(new Error(`Server exited before startup with code ${code}. stderr: ${stderr}`));
      }
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;

  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 2_000))
  ]);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function assertSafeResponseBody(body) {
  assert.doesNotMatch(body, /GONKA_API_KEY/i);
  assert.doesNotMatch(body, /sk-[A-Za-z0-9_-]{12,}/i);
  assert.ok(!body.toLowerCase().includes(projectRoot.toLowerCase()));
  assert.doesNotMatch(body, /\[core\]|repositoryformatversion|filemode\s*=/i);
}

test("static server exposes only the public allowlist", { timeout: 20_000 }, async t => {
  const port = await findAvailablePort();
  const childEnv = { ...process.env };
  delete childEnv.GONKA_API_KEY;
  childEnv.HOST = "127.0.0.1";
  childEnv.PORT = String(port);

  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  t.after(async () => stopChild(child));
  await waitForServer(child);

  const baseUrl = `http://127.0.0.1:${port}`;
  const publicRoutes = [
    "/",
    "/index.html",
    "/CrisisRoute-AI-Latest-App.html",
    "/src/main.js",
    "/src/styles.css",
    "/src/ui/decisionWorkflow.js",
    "/src/ui/demoReliability.js",
    "/src/data/replayResponses.js",
    "/src/assets/favicon.svg"
  ];

  for (const route of publicRoutes) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, `${route} should be public`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }

  const sensitiveRoutes = [
    "/.env",
    "/.env.local",
    "/.env.example",
    "/.git/config",
    "/server.js",
    "/package.json",
    "/README.md",
    "/README-HANDOFF.md",
    "/docs/README.md",
    "/backend/gonkaClient.js",
    "/backend/incidentPipeline.js",
    "/backend/hazeScenario.js",
    "/backend/decisionLedger.js",
    "/backend/briefService.js",
    "/tests/gonka-client.test.js",
    "/tests/incident-pipeline.test.js",
    "/tests/server-api.test.js",
    "/tests/haze-scenario-pipeline.test.js",
    "/tests/decision-ledger.test.js",
    "/tests/brief-service.test.js",
    "/scripts/gonka-smoke.js",
    "/scripts/case01-live-smoke.js",
    "/scripts/full-scenario-live-smoke.js",
    "/scripts/decision-flow-smoke.js",
    "/scripts/brief-proof-smoke.js",
    "/scripts/frontend-workflow-smoke.js",
    "/scripts/judge-demo-smoke.js",
    "/scripts/live-judge-rehearsal.js",
    "/tests/frontend-workflow.test.js",
    "/tests/demo-reliability.test.js",
    "/src/../.env.local",
    "/src/%2e%2e/.env.local",
    "/src/%2e%2e%2f.env.local",
    "/src/%5c..%5c.env.local",
    "/src/%00main.js",
    "/src/.hidden.js",
    "/.ENV.LOCAL"
  ];

  for (const route of sensitiveRoutes) {
    const response = await fetch(`${baseUrl}${route}`);
    const body = await response.text();
    assert.equal(response.status, 404, `${route} should not be public`);
    assert.equal(body, "Not found");
    assertSafeResponseBody(body);
  }

  const malformedResponse = await fetch(`${baseUrl}/%E0%A4%A`);
  assert.equal(malformedResponse.status, 404);
  assert.equal(await malformedResponse.text(), "Not found");

  const headResponse = await fetch(`${baseUrl}/index.html`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await headResponse.text(), "");

  const missingHeadResponse = await fetch(`${baseUrl}/missing.html`, { method: "HEAD" });
  assert.equal(missingHeadResponse.status, 404);
  assert.equal(await missingHeadResponse.text(), "");

  const postResponse = await fetch(`${baseUrl}/index.html`, { method: "POST" });
  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get("allow"), "GET, HEAD");

  const healthResponse = await fetch(`${baseUrl}/api/health/gonka`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, false);

  const apiMissingResponse = await fetch(`${baseUrl}/api/not-found`);
  assert.equal(apiMissingResponse.status, 404);
  assert.match(apiMissingResponse.headers.get("content-type"), /^application\/json/i);
});
