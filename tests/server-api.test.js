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
const { BriefServiceError } = require("../backend/briefService");
const { CANONICAL_HAZE_MESSAGES } = require("../backend/hazeScenario");
const {
  run: runCase01Smoke,
  LOCAL_SMOKE_TIMEOUT_MS
} = require("../scripts/case01-live-smoke");

const SCENARIO_MESSAGES = [...CANONICAL_HAZE_MESSAGES];

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

test("full scenario accepts canonical messages with whitespace-only differences", async t => {
  let modelCalls = 0;
  const client = configuredFakeClient(async request => {
    modelCalls += 1;
    const role = request.model === DEFAULT_MODELS.analyst ? "analyst" : "reviewer";
    return roleResult(request, batchRoleData(role));
  });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
  const messages = CANONICAL_HAZE_MESSAGES.map(message => `  ${message.replaceAll(" ", "  \n\t")}  `);
  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: "malaysia_haze_fire_smoke", messages })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.incidents.length, 5);
  assert.equal(modelCalls, 2);
});

test("changed fixed-scenario input returns safe 400 before model calls without canonical content", async t => {
  let modelCalls = 0;
  const client = configuredFakeClient(async () => { modelCalls += 1; });
  const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
  const messages = [...CANONICAL_HAZE_MESSAGES];
  messages[0] = "UNTRUSTED_INPUT_MUST_NOT_BE_BOUND";
  const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: "malaysia_haze_fire_smoke", messages })
  });
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 400);
  assert.deepEqual(body, {
    ok: false,
    error: {
      code: "INVALID_SCENARIO_INPUT",
      message: "The fixed haze demonstration scenario input is invalid.",
      retryable: false
    }
  });
  assert.equal(modelCalls, 0);
  for (const canonical of CANONICAL_HAZE_MESSAGES) assert.equal(serialized.includes(canonical), false);
  assert.doesNotMatch(serialized, /UNTRUSTED_INPUT|stack|cause|authorization|rawContent/i);
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

for (const failedRole of ["analyst", "reviewer"]) {
  test(`${failedRole} HTTP_ERROR maps to safe HTTP 502 with failedRole`, async t => {
    const client = configuredFakeClient(async request => {
      const role = request.model === DEFAULT_MODELS.analyst ? "analyst" : "reviewer";
      if (role === failedRole) throw unsafeUpstreamError("HTTP_ERROR");
      return roleResult(request, batchRoleData(role), "SUCCESS_MODEL_RAW_MUST_NOT_LEAK");
    });
    const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
    const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scenarioPayload())
    });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.error.code, "HTTP_ERROR");
    assert.equal(body.error.failedRole, failedRole);
    assertSafeErrorBody(body);
  });
}

for (const invalidRole of ["analyst", "reviewer", "both"]) {
  test(`${invalidRole} fulfilled-invalid response maps to safe role diagnostics`, async t => {
    const client = configuredFakeClient(async request => {
      const role = request.model === DEFAULT_MODELS.analyst ? "analyst" : "reviewer";
      const data = batchRoleData(role);
      if (invalidRole === "both" || invalidRole === role) {
        data.cases[0].scores.urgency = "RAW_MODEL_CONTENT_MUST_NOT_LEAK";
      }
      return roleResult(request, data, "SUCCESS_MODEL_RAW_MUST_NOT_LEAK");
    });
    const baseUrl = await startServer(t, createServer({ gonkaClientFactory: () => client }));
    const response = await fetch(`${baseUrl}/api/incidents/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scenarioPayload())
    });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.error.code, "INVALID_MODEL_DATA");
    assert.equal(body.error.failedRole, invalidRole);
    assert.ok(body.error.issuePaths.length > 0);
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
    decision: true,
    brief: true
  });
  assert.equal(health.decisionStorage, "ephemeral");
  assert.equal(health.decisionExternalAnchoring, "none");
  assert.equal(health.decisionAuthentication, "demo_local_only");
  assert.equal(health.briefGeneration, "deterministic");
  assert.equal(health.proofIntegrityScope, "local_payload_integrity");
  assert.equal(health.proofExternalAnchoring, "none");
  assert.equal(modelCalls, 0);
  assert.doesNotMatch(JSON.stringify(health), /GONKA_API_KEY|authorization|server-api-fake-token/i);
});

function decisionIncident({
  caseId = "CR-LIVE-CASE-01",
  operationalState = "DISPATCH_CANDIDATE",
  consensus = "AGREEMENT",
  conflictStatus = "passed",
  gateOverrides = {}
} = {}) {
  return {
    caseId,
    label: caseId.slice(-2),
    operationalState,
    scores: { verification: 80, urgency: 90, actionability: 85 },
    modelDebate: {
      consensus,
      scoreGaps: { verification: 2, urgency: 3, actionability: 4 }
    },
    safetyGates: [
      ["G_LOCATION", true],
      ["G_CONTACT", true],
      ["G_RESOURCE", true],
      ["G_CONFLICT", conflictStatus === "passed"],
      ["G_DISPATCH", operationalState === "DISPATCH_CANDIDATE"]
    ].map(([id, defaultPassed]) => ({
      id,
      status: id === "G_CONFLICT" ? conflictStatus : defaultPassed ? "passed" : "blocked",
      passed: Object.hasOwn(gateOverrides, id) ? gateOverrides[id] : defaultPassed,
      detail: "SERVER_PRIVATE_GATE_DETAIL"
    })),
    qualityWarnings: [],
    receivedAt: "2026-08-31T08:00:00.000Z",
    rawMessage: "RAW_MODEL_CONTENT_MUST_NOT_LEAK",
    prompt: "PROMPT_MUST_NOT_LEAK",
    authorization: "Bearer sk-SERVER-SECRET-MUST-NOT-LEAK",
    gonka: {
      analyst: { model: "safe-analyst", responseId: "safe-a", rawContent: "RAW_A" },
      reviewer: { model: "safe-reviewer", responseId: "safe-r", prompt: "PROMPT_R" }
    }
  };
}

function decisionRequestBody(overrides = {}) {
  return {
    action: "APPROVE_ACTION",
    reason: "Human approved this bounded proposal.",
    acknowledgeHumanDecision: true,
    acknowledgeNoAutomaticExecution: true,
    ...overrides
  };
}

async function createDecisionApi(t, incidents = [decisionIncident()]) {
  let fakeAnalyzeCalls = 0;
  let gonkaFactoryCalls = 0;
  const analyzeIncidentsFn = async () => {
    fakeAnalyzeCalls += 1;
    return {
      incidents: structuredClone(incidents),
      resources: [],
      meta: { mode: "offline-test" }
    };
  };
  const server = createServer({
    analyzeIncidentsFn,
    gonkaClientFactory: () => {
      gonkaFactoryCalls += 1;
      throw new Error("Gonka factory must not run in decision tests");
    }
  });
  const baseUrl = await startServer(t, server);
  return {
    baseUrl,
    get fakeAnalyzeCalls() { return fakeAnalyzeCalls; },
    get gonkaFactoryCalls() { return gonkaFactoryCalls; }
  };
}

async function registerDecisionContexts(baseUrl) {
  return fetch(`${baseUrl}/api/incidents/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: ["offline fixture"] })
  });
}

test("injected analyzer registers context without invoking the Gonka factory", async t => {
  const app = await createDecisionApi(t);
  const analyzeResponse = await registerDecisionContexts(app.baseUrl);
  assert.equal(analyzeResponse.status, 200);
  assert.equal(app.fakeAnalyzeCalls, 1);
  assert.equal(app.gonkaFactoryCalls, 0);

  const decisionResponse = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decisionRequestBody())
  });
  const body = await decisionResponse.json();
  assert.equal(decisionResponse.status, 200);
  assert.equal(body.decision.executionStatus, "NOT_EXECUTED");
  assert.equal(body.decision.actorType, "human_operator");
  assertSafeErrorBody(body);
  assert.doesNotMatch(JSON.stringify(body), /RAW_MODEL|PROMPT|SERVER_PRIVATE|sk-SERVER|authorization/i);
});

test("unknown cases return safe 404 and are not analyzed automatically", async t => {
  const app = await createDecisionApi(t);
  const response = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-02/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "HOLD_FOR_REVIEW" })
  });
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "ANALYSIS_CONTEXT_NOT_FOUND");
  assert.equal(app.fakeAnalyzeCalls, 0);
  assert.equal(app.gonkaFactoryCalls, 0);
  assertSafeErrorBody(body);
});

test("decision routes reject traversal, encoded slashes, null bytes and extra slashes", async t => {
  const app = await createDecisionApi(t);
  for (const route of [
    "/api/incidents/%2e%2e%2FCR-LIVE-CASE-01/decision",
    "/api/incidents/CR-LIVE-CASE-01%2Fextra/decision",
    "/api/incidents/CR-LIVE-CASE-01%00/decision",
    "/api/incidents/CR-LIVE-CASE-01/extra/decision",
    "/api/incidents/CR-LIVE-CASE-01/decision/extra"
  ]) {
    const response = await fetch(`${app.baseUrl}${route}`, { method: "POST" });
    const body = await response.json();
    assert.equal(response.status, 400, route);
    assert.equal(body.error.code, "INVALID_CASE_ID", route);
    assertSafeErrorBody(body);
  }
});

test("decision and audit routes enforce exact methods with Allow", async t => {
  const app = await createDecisionApi(t);
  for (const [route, method, expectedAllow] of [
    ["/api/incidents/CR-LIVE-CASE-01/decision", "GET", "POST"],
    ["/api/incidents/CR-LIVE-CASE-01/audit", "POST", "GET"]
  ]) {
    const response = await fetch(`${app.baseUrl}${route}`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), expectedAllow);
    assert.equal((await response.json()).error.code, "METHOD_NOT_ALLOWED");
  }
});

test("decision API maps unknown actions and malformed reasons to safe errors", async t => {
  const app = await createDecisionApi(t);
  await registerDecisionContexts(app.baseUrl);
  const checks = [
    [{ action: "dispatch-now" }, 422, "UNKNOWN_DECISION_ACTION"],
    [decisionRequestBody({ reason: "x".repeat(501) }), 400, "INVALID_DECISION_REQUEST"],
    [decisionRequestBody({ reason: "valid\0reason" }), 400, "INVALID_DECISION_REQUEST"]
  ];
  for (const [payload, status, code] of checks) {
    const response = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    assert.equal(response.status, status);
    assert.equal(body.error.code, code);
    assertSafeErrorBody(body);
  }
});

test("decision API ignores forged fields and normalizes frontend aliases", async t => {
  const app = await createDecisionApi(t);
  await registerDecisionContexts(app.baseUrl);
  const response = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decisionRequestBody({
      action: "APPROVED",
      actorType: "administrator",
      role: "owner",
      approvedBy: "forged",
      recordedAt: "1900-01-01T00:00:00.000Z",
      decisionId: "FORGED",
      sequence: 99,
      entryHash: "FORGED",
      override: true
    }))
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.decision.action, "APPROVE_ACTION");
  assert.equal(body.decision.actorType, "human_operator");
  assert.equal(body.decision.authentication, "demo_local_only");
  assert.equal(body.decision.sequence, 1);
  assert.notEqual(body.decision.decisionId, "FORGED");
  assert.notEqual(body.decision.entryHash, "FORGED");
  assert.equal(body.decision.override, false);
  assert.equal(Object.hasOwn(body.decision, "approvedBy"), false);
});

test("HTTP idempotency replays identical requests and rejects key reuse conflicts", async t => {
  const app = await createDecisionApi(t);
  await registerDecisionContexts(app.baseUrl);
  const endpoint = `${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/decision`;
  const request = payload => fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "server-idempotency-key-01"
    },
    body: JSON.stringify(payload)
  });
  const first = await (await request(decisionRequestBody())).json();
  const replayResponse = await request(decisionRequestBody());
  const replay = await replayResponse.json();
  assert.equal(replayResponse.status, 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.decision.decisionId, first.decision.decisionId);

  const conflictResponse = await request(decisionRequestBody({ reason: "A different human-entered reason." }));
  const conflict = await conflictResponse.json();
  assert.equal(conflictResponse.status, 409);
  assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");

  const audit = await (await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/audit`)).json();
  assert.equal(audit.entryCount, 1);
});

test("API state policy blocks unsafe approval and allows bounded state actions", async t => {
  const incidents = [
    decisionIncident({ caseId: "CR-LIVE-CASE-01" }),
    decisionIncident({ caseId: "CR-LIVE-CASE-02", operationalState: "MERGE_OR_VERIFY" }),
    decisionIncident({ caseId: "CR-LIVE-CASE-03", operationalState: "URGENT_VERIFICATION", gateOverrides: { G_LOCATION: false, G_CONTACT: false } }),
    decisionIncident({ caseId: "CR-LIVE-CASE-04", operationalState: "NEEDS_HUMAN_REVIEW", conflictStatus: "review" }),
    decisionIncident({ caseId: "CR-LIVE-CASE-05", operationalState: "QUEUED_ACTION" })
  ];
  const app = await createDecisionApi(t, incidents);
  await registerDecisionContexts(app.baseUrl);

  const post = (caseId, body) => fetch(`${app.baseUrl}/api/incidents/${caseId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal((await post("CR-LIVE-CASE-02", { action: "merge" })).status, 200);
  assert.equal((await post("CR-LIVE-CASE-03", { action: "verify" })).status, 200);
  assert.equal((await post("CR-LIVE-CASE-04", {
    action: "hold",
    reason: "Human reviewed the material conflict.",
    acknowledgeReview: true
  })).status, 200);
  assert.equal((await post("CR-LIVE-CASE-05", { action: "queue" })).status, 200);
  const forbidden = await post("CR-LIVE-CASE-03", decisionRequestBody());
  assert.equal(forbidden.status, 409);
  assert.equal((await forbidden.json()).error.code, "DECISION_NOT_ALLOWED");
});

test("audit API returns only the append-only safe chain and honest storage markers", async t => {
  const app = await createDecisionApi(t);
  await registerDecisionContexts(app.baseUrl);
  await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decisionRequestBody())
  });
  const response = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/audit`);
  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.equal(response.status, 200);
  assert.equal(body.entryCount, 1);
  assert.equal(body.chainValid, true);
  assert.equal(body.persistence, "ephemeral");
  assert.equal(body.externalAnchoring, "none");
  assert.equal(body.chainScope, "per_case");
  assert.match(body.entries[0].analysisSnapshotHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(serialized, /RAW_MODEL|PROMPT|Authorization|sk-SERVER|SERVER_PRIVATE|on-chain|blockchain/i);
});

test("Brief API requires analysis and then a valid human decision", async t => {
  const app = await createDecisionApi(t);
  const beforeAnalysis = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/brief`, { method: "POST" });
  assert.equal(beforeAnalysis.status, 404);
  assert.equal((await beforeAnalysis.json()).error.code, "ANALYSIS_CONTEXT_NOT_FOUND");

  await registerDecisionContexts(app.baseUrl);
  const beforeDecision = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/brief`, { method: "POST" });
  assert.equal(beforeDecision.status, 409);
  assert.equal((await beforeDecision.json()).error.code, "DECISION_REQUIRED");
  assert.equal(app.gonkaFactoryCalls, 0);
});

test("Brief API maps audit-integrity failure to a safe 409", async t => {
  const briefService = {
    generateBrief() { throw new BriefServiceError("AUDIT_INTEGRITY_FAILURE"); },
    verifyProof() { throw new Error("not used"); }
  };
  const server = createServer({
    briefService,
    gonkaClientFactory: () => configuredFakeClient(async () => {})
  });
  const baseUrl = await startServer(t, server);
  const response = await fetch(`${baseUrl}/api/incidents/CR-LIVE-CASE-01/brief`, { method: "POST" });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error.code, "AUDIT_INTEGRITY_FAILURE");
  assertSafeErrorBody(body);
});

test("Brief and Proof APIs complete a deterministic local integrity round trip", async t => {
  const app = await createDecisionApi(t);
  await registerDecisionContexts(app.baseUrl);
  const decisionResponse = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decisionRequestBody())
  });
  assert.equal(decisionResponse.status, 200);

  const briefResponse = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/brief`, { method: "POST" });
  const briefResult = await briefResponse.json();
  const serialized = JSON.stringify(briefResult);
  assert.equal(briefResponse.status, 200);
  assert.equal(briefResult.brief.executionStatus, "NOT_EXECUTED");
  assert.equal(briefResult.proofCapsule.integrityScope, "local_payload_integrity");
  assert.doesNotMatch(serialized, /RAW_MODEL|PROMPT|Authorization|sk-SERVER|SERVER_PRIVATE/i);

  const replay = await (await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/brief`, { method: "POST" })).json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.brief.briefId, briefResult.brief.briefId);
  assert.equal(replay.proofCapsule.capsuleHash, briefResult.proofCapsule.capsuleHash);

  const verifyResponse = await fetch(`${app.baseUrl}/api/proof/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: briefResult.brief, proofCapsule: briefResult.proofCapsule })
  });
  assert.equal(verifyResponse.status, 200);
  assert.deepEqual(await verifyResponse.json(), {
    ok: true,
    valid: true,
    checks: { briefHash: true, capsuleHash: true, capsuleId: true, references: true }
  });
  assert.equal(app.gonkaFactoryCalls, 0);
});

test("Proof API reports tampering without echoing the supplied payload", async t => {
  const app = await createDecisionApi(t);
  await registerDecisionContexts(app.baseUrl);
  await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decisionRequestBody())
  });
  const result = await (await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/brief`, { method: "POST" })).json();
  result.brief.summary = "UNTRUSTED_TAMPERED_SUMMARY_MUST_NOT_ECHO";
  const response = await fetch(`${app.baseUrl}/api/proof/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: result.brief, proofCapsule: result.proofCapsule })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.valid, false);
  assert.equal(body.checks.briefHash, false);
  assert.doesNotMatch(JSON.stringify(body), /UNTRUSTED_TAMPERED_SUMMARY|summary|caseId|decisionId/);
});

test("Proof API rejects malformed, prototype-polluting and deeply nested requests", async t => {
  const app = await createDecisionApi(t);
  const payloads = [
    { brief: null, proofCapsule: null },
    JSON.parse('{"brief":{},"proofCapsule":{"__proto__":{"polluted":true}}}'),
    (() => {
      let deep = "leaf";
      for (let index = 0; index < 12; index += 1) deep = { nested: deep };
      return { brief: deep, proofCapsule: {} };
    })()
  ];
  for (const payload of payloads) {
    const response = await fetch(`${app.baseUrl}/api/proof/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_PROOF_REQUEST");
    assertSafeErrorBody(body);
  }
  assert.equal({}.polluted, undefined);
});

test("Brief and Proof routes enforce exact methods and safe case paths", async t => {
  const app = await createDecisionApi(t);
  const briefMethod = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01/brief`);
  assert.equal(briefMethod.status, 405);
  assert.equal(briefMethod.headers.get("allow"), "POST");
  const proofMethod = await fetch(`${app.baseUrl}/api/proof/verify`);
  assert.equal(proofMethod.status, 405);
  assert.equal(proofMethod.headers.get("allow"), "POST");
  const unsafe = await fetch(`${app.baseUrl}/api/incidents/CR-LIVE-CASE-01%2Fextra/brief`, { method: "POST" });
  assert.equal(unsafe.status, 400);
  assert.equal((await unsafe.json()).error.code, "INVALID_CASE_ID");
});
