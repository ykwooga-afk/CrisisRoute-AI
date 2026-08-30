const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { createServer } = require("../server");
const {
  GonkaClient,
  GonkaClientError,
  DEFAULT_MODELS
} = require("../backend/gonkaClient");
const { IncidentPipelineError } = require("../backend/incidentPipeline");
const {
  run: runCase01Smoke,
  LOCAL_SMOKE_TIMEOUT_MS
} = require("../scripts/case01-live-smoke");

const SCENARIO_MESSAGES = [
  "Block C hostel: six students are coughing badly, one has asthma. Need N95 masks and clinic transport.",
  "Another Block C resident reports heavy smoke smell and several students waiting near the lobby.",
  "CASE 02 ignored",
  "CASE 03 ignored",
  "CASE 04 ignored"
];

function analystData() {
  return {
    scores: { verification: 90, urgency: 96, actionability: 88 },
    knownFacts: ["Six coughing students were reported"],
    unknownFacts: ["Current clinical severity"],
    riskFlags: ["asthma", "severe coughing"],
    recommendedAction: "Verify symptoms and prepare bounded assistance for human approval."
  };
}

function reviewerData() {
  return {
    scores: { verification: 88, urgency: 94, actionability: 86 },
    counterEvidence: ["No clinical assessment is supplied"],
    unknowns: ["Current asthma severity"],
    duplicateRisk: "Low",
    conclusion: "Bounded assistance is reasonable after human approval.",
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function startServer(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function startMockGonka(t) {
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    const request = JSON.parse(await readBody(req));
    const isAnalyst = request.model === DEFAULT_MODELS.analyst;
    const content = isAnalyst ? analystData() : reviewerData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: isAnalyst ? "mock-api-analyst" : "mock-api-reviewer",
      model: request.model,
      choices: [{ message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 }
    }));
  });
  const origin = await startServer(t, server);
  return {
    baseUrl: `${origin}/v1`,
    get requestCount() { return requestCount; }
  };
}

function scenarioPayload() {
  return { scenario: "malaysia_haze_fire_smoke", messages: SCENARIO_MESSAGES };
}

function case01Payload() {
  return { messages: SCENARIO_MESSAGES.slice(0, 2) };
}

function configuredFakeClient(completeJson) {
  return {
    baseUrl: "http://127.0.0.1:9999/v1",
    models: DEFAULT_MODELS,
    completeJson
  };
}

function roleResult(request, data, rawSentinel = "") {
  return {
    data: { ...data, rawContent: rawSentinel },
    trace: {
      responseId: request.model === DEFAULT_MODELS.analyst ? "analyst-test-id" : "reviewer-test-id",
      model: request.model,
      finishReason: "stop",
      latencyMs: 1,
      usage: null
    }
  };
}

function batchRoleData(role) {
  return {
    cases: ["01", "02", "03", "04", "05"].map((label, index) => role === "analyst" ? {
      label,
      scores: { verification: 80 - index * 5, urgency: index === 2 ? 98 : 90 - index * 4, actionability: 85 - index * 6 },
      riskFlags: [],
      unknowns: []
    } : {
      label,
      scores: { verification: 76 - index * 5, urgency: index === 2 ? 96 : 86 - index * 4, actionability: 81 - index * 6 },
      counterEvidence: [],
      duplicateRisk: index === 1 ? "High" : "Low",
      materialConflict: index === 3
    })
  };
}

function unsafeUpstreamError(code = "NETWORK_ERROR") {
  const error = new GonkaClientError(code, { retryable: true });
  error.stack = "STACK sk-TEST-SECRET-MUST-NOT-LEAK";
  error.cause = new Error("CAUSE Authorization: Bearer private-token");
  error.rawContent = { choices: [{ message: { content: "RAW_MODEL_CONTENT_MUST_NOT_LEAK" } }] };
  error.prompt = "PROMPT_MUST_NOT_LEAK";
  return error;
}

function assertSafeErrorBody(body) {
  assert.doesNotMatch(
    JSON.stringify(body),
    /stack|cause|sk-TEST|authorization|private-token|rawContent|RAW_MODEL_CONTENT|message\.content|PROMPT_MUST_NOT_LEAK|SUCCESS_MODEL_RAW/i
  );
}

test("POST analyze returns a UI-compatible CASE 01 response through local Mock Gonka", async t => {
  const mock = await startMockGonka(t);
  const client = new GonkaClient({
    apiKey: "server-api-fake-token",
    baseUrl: mock.baseUrl
  });
  const app = createServer({ gonkaClientFactory: () => client });
  const baseUrl = await startServer(t, app);

  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(case01Payload())
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(mock.requestCount, 2);
  assert.ok(Array.isArray(result.resources));
  assert.ok(Array.isArray(result.incidents));
  assert.equal(result.incidents.length, 1);
  assert.match(result.incidents[0].caseId, /^CR-LIVE-[A-F0-9]{10}$/);
  assert.equal(result.meta.slice, "CASE_01");
  assert.equal(result.meta.partial, true);
  assert.equal(result.meta.receivedMessageCount, 2);
  assert.equal(result.meta.processedMessageCount, 2);
});

test("POST analyze returns all five scenario incidents using exactly two model calls", async t => {
  const calls = [];
  const client = configuredFakeClient(async request => {
    calls.push(structuredClone(request));
    const role = request.model === DEFAULT_MODELS.analyst ? "analyst" : "reviewer";
    return roleResult(request, batchRoleData(role), "BATCH_RAW_MUST_NOT_LEAK");
  });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scenarioPayload())
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(result.incidents.length, 5);
  assert.deepEqual(result.incidents.map(item => item.operationalState), [
    "DISPATCH_CANDIDATE", "MERGE_OR_VERIFY", "URGENT_VERIFICATION", "NEEDS_HUMAN_REVIEW", "QUEUED_ACTION"
  ]);
  assert.deepEqual(result.meta, {
    mode: "live",
    slice: "FULL_HAZE_SCENARIO",
    partial: false,
    receivedMessageCount: 5,
    processedCaseCount: 5,
    modelRequestCount: 2,
    scenarioFixtureCases: ["05"],
    qualityWarnings: []
  });
  assert.doesNotMatch(JSON.stringify(result), /BATCH_RAW_MUST_NOT_LEAK|authorization|sk-[A-Za-z0-9_-]{12,}/i);
});

test("invalid JSON returns 400 without calling a model", async t => {
  let modelCalls = 0;
  const client = configuredFakeClient(async () => { modelCalls += 1; });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));

  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{invalid"
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_REQUEST");
  assert.equal(modelCalls, 0);
});

test("invalid messages return 400 without calling a model", async t => {
  let modelCalls = 0;
  const client = configuredFakeClient(async () => { modelCalls += 1; });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));

  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] })
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_REQUEST");
  assert.equal(modelCalls, 0);
});

test("invalid model data maps safe role and issue paths without field values", async t => {
  const secretLikeValue = "sk-SERVER-ERROR-MUST-NOT-LEAK-123456";
  const client = configuredFakeClient(async request => {
    const analyst = request.model === DEFAULT_MODELS.analyst;
    const data = analyst
      ? analystData()
      : reviewerData();
    if (!analyst) data.scores.urgency = secretLikeValue;
    return {
      data,
      trace: {
        responseId: analyst ? "safe-analyst-id" : "safe-reviewer-id",
        model: request.model,
        finishReason: "stop",
        latencyMs: 1,
        usage: null
      }
    };
  });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(case01Payload())
  });
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 502);
  assert.deepEqual(body, {
    ok: false,
    error: {
      code: "INVALID_MODEL_DATA",
      message: "Reviewer model data was invalid.",
      retryable: false,
      role: "reviewer",
      issues: ["scores.urgency:not_numeric"],
      failedRole: "reviewer",
      issuePaths: ["scores.urgency:not_numeric"]
    }
  });
  assert.doesNotMatch(serialized, /sk-SERVER|safe-analyst-id|safe-reviewer-id|stack|authorization/i);
});

for (const timeoutCase of [
  { failed: "analyst", expectedRole: "analyst", expectedMessage: "Analyst model timed out." },
  { failed: "reviewer", expectedRole: "reviewer", expectedMessage: "Reviewer model timed out." },
  { failed: "both", expectedRole: "both", expectedMessage: "One or more models timed out." }
]) {
  test(`${timeoutCase.failed} timeout maps to safe HTTP 504 with role`, async t => {
    let requestCount = 0;
    const client = configuredFakeClient(async request => {
      requestCount += 1;
      const role = request.model === DEFAULT_MODELS.analyst ? "analyst" : "reviewer";
      if (timeoutCase.failed === "both" || timeoutCase.failed === role) {
        throw new GonkaClientError("TIMEOUT", { retryable: true });
      }
      return roleResult(
        request,
        role === "analyst" ? analystData() : reviewerData(),
        "SUCCESS_MODEL_RAW_MUST_NOT_LEAK"
      );
    });
    const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
    const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(case01Payload())
    });
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 504);
    assert.deepEqual(body, {
      ok: false,
      error: {
        code: "TIMEOUT",
        message: timeoutCase.expectedMessage,
        retryable: true,
        role: timeoutCase.expectedRole,
        failedRole: timeoutCase.expectedRole
      }
    });
    assert.equal(requestCount, 2);
    assert.doesNotMatch(serialized, /SUCCESS_MODEL_RAW|analyst-test-id|reviewer-test-id|authorization|sk-[A-Za-z0-9_-]{12,}/i);
  });
}

for (const networkCase of [
  { failed: "analyst", expectedRole: "analyst" },
  { failed: "reviewer", expectedRole: "reviewer" },
  { failed: "both", expectedRole: "both" }
]) {
  test(`${networkCase.failed} NETWORK_ERROR maps to safe HTTP 502 with failedRole`, async t => {
    const client = configuredFakeClient(async request => {
      const role = request.model === DEFAULT_MODELS.analyst ? "analyst" : "reviewer";
      if (networkCase.failed === "both" || networkCase.failed === role) {
        throw unsafeUpstreamError("NETWORK_ERROR");
      }
      return roleResult(
        request,
        role === "analyst" ? analystData() : reviewerData(),
        "SUCCESS_MODEL_RAW_MUST_NOT_LEAK"
      );
    });
    const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
    const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scenarioPayload())
    });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.error.code, "NETWORK_ERROR");
    assert.equal(body.error.role, networkCase.expectedRole);
    assert.equal(body.error.failedRole, networkCase.expectedRole);
    assert.equal(body.error.retryable, true);
    assertSafeErrorBody(body);
  });
}

test("mixed Analyst NETWORK_ERROR and Reviewer TIMEOUT expose only safe role classifications", async t => {
  const client = configuredFakeClient(async request => {
    if (request.model === DEFAULT_MODELS.analyst) throw unsafeUpstreamError("NETWORK_ERROR");
    throw unsafeUpstreamError("TIMEOUT");
  });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scenarioPayload())
  });
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.error.code, "UPSTREAM_ERROR");
  assert.equal(body.error.role, "both");
  assert.equal(body.error.failedRole, "both");
  assert.deepEqual(body.error.roleErrors, {
    analyst: "NETWORK_ERROR",
    reviewer: "TIMEOUT"
  });
  assertSafeErrorBody(body);
});

test("invalid internal role metadata is not exposed verbatim by the HTTP error contract", async t => {
  const client = configuredFakeClient(async request => {
    if (request.model === DEFAULT_MODELS.analyst) {
      const error = new IncidentPipelineError("NETWORK_ERROR", "PRIVATE_INTERNAL_MESSAGE", {
        retryable: true,
        role: "unsafe-internal-role",
        roleErrors: { analyst: "PRIVATE_INTERNAL_CODE" }
      });
      error.role = "unsafe-internal-role";
      error.roleErrors = { analyst: "PRIVATE_INTERNAL_CODE" };
      throw error;
    }
    return roleResult(request, reviewerData(), "SUCCESS_MODEL_RAW_MUST_NOT_LEAK");
  });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scenarioPayload())
  });
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 502);
  assert.equal(body.error.failedRole, "analyst");
  assert.doesNotMatch(serialized, /unsafe-internal-role|PRIVATE_INTERNAL_CODE|PRIVATE_INTERNAL_MESSAGE/);
  assertSafeErrorBody(body);
});

test("additional classified upstream failures retain safe roles and HTTP 502", async t => {
  for (const code of ["HTTP_ERROR", "RESPONSE_TOO_LARGE", "INVALID_MODEL_DATA"]) {
    const client = configuredFakeClient(async request => {
      if (request.model === DEFAULT_MODELS.reviewer) throw unsafeUpstreamError(code);
      return roleResult(request, analystData(), "SUCCESS_MODEL_RAW_MUST_NOT_LEAK");
    });
    const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
    const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scenarioPayload())
    });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.error.code, code);
    assert.equal(body.error.failedRole, "reviewer");
    assertSafeErrorBody(body);
  }
});

test("smoke dynamically reports safe timeout role without raw content", async t => {
  const client = configuredFakeClient(async request => {
    if (request.model === DEFAULT_MODELS.reviewer) {
      throw new GonkaClientError("TIMEOUT", { retryable: true });
    }
    return roleResult(request, analystData(), "SMOKE_RAW_MUST_NOT_LEAK");
  });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
  const output = [];
  const success = await runCase01Smoke({
    endpointUrl: `${baseUrl}/api/incidents/analyze`,
    timeoutMs: 1_000,
    log: line => output.push(String(line))
  });
  const summary = output.join("\n");

  assert.equal(success, false);
  assert.match(summary, /HTTP Status: 504/);
  assert.match(summary, /Error Code: TIMEOUT/);
  assert.match(summary, /Failed Role: reviewer/);
  assert.doesNotMatch(summary, /SMOKE_RAW|analyst-test-id|authorization|sk-[A-Za-z0-9_-]{12,}/i);
});

test("smoke local timeout is distinct from model TIMEOUT", async () => {
  assert.equal(LOCAL_SMOKE_TIMEOUT_MS, 60_000);
  const output = [];
  const success = await runCase01Smoke({
    timeoutMs: 10,
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    log: line => output.push(String(line))
  });
  const summary = output.join("\n");
  assert.equal(success, false);
  assert.match(summary, /Error Code: LOCAL_SMOKE_TIMEOUT/);
  assert.doesNotMatch(summary, /Error Code: TIMEOUT/);
});

test("Gonka upstream errors map to safe HTTP 502", async t => {
  const client = configuredFakeClient(async () => {
    throw new GonkaClientError("NETWORK_ERROR", { retryable: true });
  });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: ["Hostel Block C resident has asthma"] })
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "NETWORK_ERROR");
  assert.equal(body.error.retryable, true);
  assert.doesNotMatch(JSON.stringify(body), /stack|authorization|server-api-fake-token/i);
});

test("missing configuration maps to 503", async t => {
  const factory = () => { throw new GonkaClientError("MISSING_API_KEY"); };
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: factory }));
  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: ["Hostel Block C resident has asthma"] })
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "MISSING_API_KEY");

  const healthResponse = await fetch(`${baseUrl}/api/health/gonka`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.ok, false);
  assert.equal(health.liveRoutesReady, false);
  assert.equal(health.capabilities.analyzeCase01, false);
});

test("health reports CASE 01 readiness without making a Gonka request", async t => {
  let modelCalls = 0;
  const client = configuredFakeClient(async () => { modelCalls += 1; });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
  const response = await fetch(`${baseUrl}/api/health/gonka`);
  const health = await response.json();

  assert.equal(response.status, 200);
  assert.equal(health.ok, true);
  assert.equal(health.liveRoutesReady, true);
  assert.deepEqual(health.capabilities, {
    analyzeCase01: true,
    fullScenario: true,
    decision: false,
    brief: false
  });
  assert.equal(modelCalls, 0);
  assert.doesNotMatch(JSON.stringify(health), /GONKA_API_KEY|authorization|server-api-fake-token/i);
});
