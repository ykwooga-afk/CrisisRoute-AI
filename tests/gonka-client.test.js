const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  GonkaClient,
  GonkaClientError,
  createGonkaClientFromEnv,
  extractStructuredJson,
  extractStructuredJsonCandidates,
  DEFAULT_GONKA_BASE_URL,
  DEFAULT_MODELS,
  MAX_RESPONSE_BYTES,
  MAX_JSON_CANDIDATES,
  MAX_JSON_NESTING_DEPTH
} = require("../backend/gonkaClient");

const FAKE_TOKEN = "unit-test-token-not-a-real-secret";
const TEST_MODEL = DEFAULT_MODELS.analyst;
const TEST_MESSAGES = [{ role: "user", content: "Return one JSON object." }];

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function successfulPayload(content = '{"status":"ready"}', overrides = {}) {
  return {
    id: "mock-response-id",
    model: TEST_MODEL,
    choices: [{
      message: { role: "assistant", content },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18
    },
    ...overrides
  };
}

async function createMockServer(t, handler) {
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    try {
      await handler(req, res);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: "mock failure" });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(async () => {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    await new Promise(resolve => server.close(resolve));
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1/`,
    get requestCount() {
      return requestCount;
    }
  };
}

function createClient(baseUrl, options = {}) {
  return new GonkaClient({
    apiKey: FAKE_TOKEN,
    baseUrl,
    defaultTimeoutMs: options.defaultTimeoutMs || 1_000,
    fetchImpl: options.fetchImpl
  });
}

function complete(client, options = {}) {
  return client.completeJson({
    model: TEST_MODEL,
    messages: TEST_MESSAGES,
    maxTokens: 100,
    ...options
  });
}

test("exports the required safe defaults", () => {
  assert.equal(DEFAULT_GONKA_BASE_URL, "https://api.gonkarouter.io/v1");
  assert.equal(DEFAULT_MODELS.analyst, "deepseek-ai/DeepSeek-V4-Flash-0731");
  assert.equal(DEFAULT_MODELS.reviewer, "moonshotai/Kimi-K2.6");
});

test("createGonkaClientFromEnv rejects a missing API key", () => {
  assert.throws(
    () => createGonkaClientFromEnv({}),
    error => error instanceof GonkaClientError && error.code === "MISSING_API_KEY"
  );
});

test("rejects non-HTTPS non-loopback base URLs", () => {
  assert.throws(
    () => new GonkaClient({ apiKey: FAKE_TOKEN, baseUrl: "http://example.com/v1" }),
    error => error.code === "INVALID_BASE_URL"
  );
});

test("rejects base URLs containing credentials", () => {
  assert.throws(
    () => new GonkaClient({ apiKey: FAKE_TOKEN, baseUrl: "https://user:pass@example.com/v1" }),
    error => error.code === "INVALID_BASE_URL"
  );
});

test("rejects the Gonka production root before any network request", () => {
  let requestCount = 0;
  const mockFetch = async () => {
    requestCount += 1;
    throw new Error("must not run");
  };

  assert.throws(
    () => new GonkaClient({
      apiKey: FAKE_TOKEN,
      baseUrl: "https://api.gonkarouter.io",
      fetchImpl: mockFetch
    }),
    error => error.code === "INVALID_BASE_URL" &&
      error.retryable === false &&
      !JSON.stringify(error).includes(FAKE_TOKEN)
  );
  assert.equal(requestCount, 0);
});

test("accepts the Gonka /v1 base and derives the correct endpoint offline", async () => {
  let requestedEndpoint;
  let requestCount = 0;
  const mockFetch = async endpoint => {
    requestCount += 1;
    requestedEndpoint = String(endpoint);
    return new Response(JSON.stringify(successfulPayload()), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const client = createClient("https://api.gonkarouter.io/v1/", {
    fetchImpl: mockFetch
  });

  const result = await complete(client);
  assert.equal(requestedEndpoint, "https://api.gonkarouter.io/v1/chat/completions");
  assert.equal(requestCount, 1);
  assert.deepEqual(result.data, { status: "ready" });
});

test("allows loopback HTTP and removes trailing slashes", () => {
  const client = createClient("http://localhost:4173/v1///");
  assert.equal(client.baseUrl, "http://localhost:4173/v1");
  assert.doesNotMatch(JSON.stringify(client), new RegExp(FAKE_TOKEN));
});

test("rejects invalid request input without sending", async () => {
  const client = createClient("http://127.0.0.1:4173/v1");
  await assert.rejects(
    () => client.completeJson({ model: TEST_MODEL, messages: [], maxTokens: 0 }),
    error => error.code === "INVALID_REQUEST"
  );
  assert.equal(client.requestCount, 0);
});

test("extracts pure JSON", () => {
  assert.deepEqual(extractStructuredJson('{"status":"ready"}'), { status: "ready" });
});

test("extracts JSON surrounded by whitespace", () => {
  assert.deepEqual(extractStructuredJson(' \r\n {"score":100}\t '), { score: 100 });
});

test("extracts JSON from a Markdown code fence", () => {
  assert.deepEqual(
    extractStructuredJson('```json\n{"status":"ready"}\n```'),
    { status: "ready" }
  );
});

test("discards explanatory and hidden reasoning prefixes", () => {
  const content = "Internal reasoning that must be discarded. Final: {\"safe\":true}";
  assert.deepEqual(extractStructuredJson(content), { safe: true });
});

test("discards text after the JSON object", () => {
  assert.deepEqual(
    extractStructuredJson('{"status":"ready"} trailing explanation'),
    { status: "ready" }
  );
});

test("handles braces and escaped quotes inside JSON strings", () => {
  const content = '{"text":"brace { and } plus \\\"quoted\\\" text","ok":true}';
  assert.deepEqual(extractStructuredJson(content), {
    text: 'brace { and } plus "quoted" text',
    ok: true
  });
});

test("selects the last valid JSON object", () => {
  assert.deepEqual(
    extractStructuredJson('draft {"status":"old"} final {"status":"ready","score":100}'),
    { status: "ready", score: 100 }
  );
});

function extractedValues(content) {
  return extractStructuredJsonCandidates(content).candidates.map(candidate => candidate.value);
}

for (const sample of [
  { name: "pure Object", content: '{"status":"ready"}', expected: { status: "ready" } },
  { name: "pure Array", content: '[{"label":"01"}]', expected: [{ label: "01" }] },
  { name: "fenced Object", content: '```json\n{"status":"ready"}\n```', expected: { status: "ready" } },
  { name: "fenced Array", content: '```json\n[{"label":"01"}]\n```', expected: [{ label: "01" }] },
  { name: "prose plus Object", content: 'Result follows: {"status":"ready"} end.', expected: { status: "ready" } },
  { name: "prose plus Array", content: 'Result follows: [{"label":"01"}] end.', expected: [{ label: "01" }] },
  { name: "hidden-prefix-style Object", content: 'private thoughts omitted\nFINAL {"status":"ready"}', expected: { status: "ready" } },
  { name: "hidden-prefix-style Array", content: 'private thoughts omitted\nFINAL [{"label":"01"}]', expected: [{ label: "01" }] }
]) {
  test(`candidate extraction supports ${sample.name}`, () => {
    assert.deepEqual(extractedValues(sample.content).at(-1), sample.expected);
  });
}

test("candidate extraction ignores an earlier primitive and retains a later payload", () => {
  const extracted = extractStructuredJsonCandidates('draft 7 final {"status":"ready"}');
  assert.deepEqual(extracted.candidateKinds, ["object"]);
  assert.deepEqual(extracted.candidates[0].value, { status: "ready" });
});

test("candidate extraction retains multiple independent composite candidates", () => {
  const extracted = extractStructuredJsonCandidates('meta {"step":1} final [{"label":"01"}]');
  assert.equal(extracted.candidateCount, 2);
  assert.deepEqual(extracted.candidateKinds, ["object", "array"]);
});

test("candidate extraction handles brackets, braces and escaped quotes inside strings", () => {
  const content = '{"text":"literal [ ] { } and \\\"quoted\\\"","nested":{"items":[1,{"ok":true}]}}';
  assert.deepEqual(extractedValues(content)[0], {
    text: 'literal [ ] { } and "quoted"',
    nested: { items: [1, { ok: true }] }
  });
});

test("candidate extraction unwraps a JSON String containing one Object", () => {
  const extracted = extractStructuredJsonCandidates(JSON.stringify('{"status":"ready"}'));
  assert.deepEqual(extracted.candidateKinds, ["string", "object"]);
  assert.deepEqual(extracted.candidates[1].value, { status: "ready" });
});

test("candidate extraction unwraps a JSON String containing one Array", () => {
  const extracted = extractStructuredJsonCandidates(JSON.stringify('[{"label":"01"}]'));
  assert.deepEqual(extracted.candidateKinds, ["string", "array"]);
  assert.deepEqual(extracted.candidates[1].value, [{ label: "01" }]);
});

test("candidate extraction reports a failed one-level String unwrap without exposing it", () => {
  const privateText = "not inner JSON PRIVATE_MODEL_TEXT";
  const extracted = extractStructuredJsonCandidates(JSON.stringify(privateText));
  assert.deepEqual(extracted.candidateKinds, ["string"]);
  assert.deepEqual(extracted.issues, ["payload:string_unwrap_failed"]);
  assert.doesNotMatch(JSON.stringify({
    candidateCount: extracted.candidateCount,
    candidateKinds: extracted.candidateKinds,
    issues: extracted.issues
  }), /PRIVATE_MODEL_TEXT/);
});

test("candidate extraction rejects more than eight candidates with bounded metadata", () => {
  const privateContent = Array.from(
    { length: MAX_JSON_CANDIDATES + 1 },
    (_, index) => JSON.stringify({ index, private: `RAW_${index}` })
  ).join(" ");
  assert.throws(() => extractStructuredJsonCandidates(privateContent), error => {
    assert.equal(error.code, "INVALID_JSON");
    assert.deepEqual(error.issues, ["payload:candidate_limit_exceeded"]);
    assert.equal(error.candidateCount, MAX_JSON_CANDIDATES);
    assert.equal(error.candidateKinds.length, MAX_JSON_CANDIDATES);
    assert.doesNotMatch(JSON.stringify(error), /RAW_/);
    return true;
  });
});

test("candidate extraction rejects excessive nesting safely", () => {
  let nested = { ok: true };
  for (let index = 0; index < MAX_JSON_NESTING_DEPTH; index += 1) nested = { nested };
  assert.throws(() => extractStructuredJsonCandidates(JSON.stringify(nested)), error => {
    assert.equal(error.code, "INVALID_JSON");
    assert.deepEqual(error.issues, ["payload:nesting_limit_exceeded"]);
    return true;
  });
});

for (const malformed of ["", "private {broken", "```json\n[broken]\n```"] ) {
  test(`candidate extraction rejects empty or malformed content: ${JSON.stringify(malformed)}`, () => {
    assert.throws(
      () => extractStructuredJsonCandidates(malformed),
      error => error.code === "INVALID_JSON" &&
        error.issues.includes("payload:no_contract_candidate") &&
        !JSON.stringify(error).includes("broken")
    );
  });
}

test("rejects valid JSON values that are not objects", () => {
  for (const value of ["null", '"ready"', "100", "[1,2]"]) {
    assert.throws(() => extractStructuredJson(value), error => error.code === "INVALID_JSON");
  }
});

test("rejects content without a valid JSON object safely", () => {
  const discardedContent = "private reasoning {not valid json";
  assert.throws(
    () => extractStructuredJson(discardedContent),
    error => error.code === "INVALID_JSON" &&
      !error.message.includes(discardedContent) &&
      !JSON.stringify(error).includes(discardedContent)
  );
});

test("returns parsed data and an auditable trace without raw content", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    sendJson(res, 200, successfulPayload("hidden prefix {\"status\":\"ready\"}"));
  });
  const result = await complete(createClient(mock.baseUrl));

  assert.deepEqual(result.data, { status: "ready" });
  assert.equal(result.trace.responseId, "mock-response-id");
  assert.equal(result.trace.model, TEST_MODEL);
  assert.equal(result.trace.finishReason, "stop");
  assert.deepEqual(result.trace.usage, {
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18
  });
  assert.equal(typeof result.trace.latencyMs, "number");
  assert.doesNotMatch(JSON.stringify(result), /hidden prefix|raw|authorization/i);
});

test("opt-in candidate mode returns bounded candidates for role selection", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    sendJson(res, 200, successfulPayload('prefix [{"label":"01"}]'));
  });
  const result = await complete(createClient(mock.baseUrl), { returnCandidates: true });
  assert.equal(Object.hasOwn(result, "data"), false);
  assert.deepEqual(result.candidates.candidateKinds, ["array"]);
  assert.deepEqual(result.candidates.candidates[0].value, [{ label: "01" }]);
  assert.doesNotMatch(JSON.stringify(result.trace), /prefix|label|raw/i);
});

test("rejects an empty choices array as INVALID_RESPONSE", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    sendJson(res, 200, successfulPayload(undefined, { choices: [] }));
  });
  await assert.rejects(() => complete(createClient(mock.baseUrl)), error => {
    return error.code === "INVALID_RESPONSE" && error.retryable === false;
  });
});

test("rejects a missing message content as INVALID_RESPONSE", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    sendJson(res, 200, successfulPayload(undefined, {
      choices: [{ message: {}, finish_reason: "stop" }]
    }));
  });
  await assert.rejects(() => complete(createClient(mock.baseUrl)), error => {
    return error.code === "INVALID_RESPONSE" && error.responseId === "mock-response-id";
  });
});

test("classifies HTTP 401 safely and does not expose the mock token", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    sendJson(res, 401, { error: `rejected ${FAKE_TOKEN}` });
  });
  await assert.rejects(() => complete(createClient(mock.baseUrl)), error => {
    const serialized = JSON.stringify(error);
    return error.code === "HTTP_ERROR" &&
      error.status === 401 &&
      error.retryable === false &&
      !serialized.includes(FAKE_TOKEN) &&
      !Object.hasOwn(error.toPublicError(), "cause");
  });
});

test("marks HTTP 429 as retryable without retrying", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    sendJson(res, 429, { error: "rate limited" });
  });
  const client = createClient(mock.baseUrl);
  await assert.rejects(() => complete(client), error => {
    return error.code === "HTTP_ERROR" && error.status === 429 && error.retryable;
  });
  assert.equal(mock.requestCount, 1);
  assert.equal(client.requestCount, 1);
});

test("marks HTTP 500 as retryable without retrying", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    sendJson(res, 500, { error: "temporary" });
  });
  const client = createClient(mock.baseUrl);
  await assert.rejects(() => complete(client), error => {
    return error.code === "HTTP_ERROR" && error.status === 500 && error.retryable;
  });
  assert.equal(mock.requestCount, 1);
});

test("aborts timed-out requests without a loopback arrival race", async () => {
  let fetchCount = 0;
  const client = createClient("http://127.0.0.1:4173/v1", {
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      fetchCount += 1;
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  });
  await assert.rejects(() => complete(client, { timeoutMs: 10 }), error => {
    return error.code === "TIMEOUT" && error.retryable === true;
  });
  assert.equal(fetchCount, 1);
  assert.equal(client.requestCount, 1);
});

test("timeout covers a delayed response body after headers", async () => {
  let fetchCount = 0;
  const secretBodyText = "BODY_SECRET_MUST_NOT_LEAK";
  const fetchImpl = async (_url, options) => {
    fetchCount += 1;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const completion = setTimeout(() => {
          controller.enqueue(encoder.encode(JSON.stringify(successfulPayload(`{\"secret\":\"${secretBodyText}\"}`))));
          controller.close();
        }, 100);
        options.signal.addEventListener("abort", () => {
          clearTimeout(completion);
          controller.error(new Error("body aborted"));
        }, { once: true });
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const client = createClient("http://127.0.0.1:4173/v1", { fetchImpl });

  await assert.rejects(() => complete(client, { timeoutMs: 20 }), error => {
    const serialized = JSON.stringify(error);
    return error.code === "TIMEOUT" &&
      error.retryable === true &&
      !serialized.includes(secretBodyText);
  });
  assert.equal(fetchCount, 1);
  assert.equal(client.requestCount, 1);
});

test("successful completeJson clears its timeout timer", async () => {
  let abortEvents = 0;
  const fetchImpl = async (_url, options) => {
    options.signal.addEventListener("abort", () => { abortEvents += 1; }, { once: true });
    return new Response(JSON.stringify(successfulPayload()), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const client = createClient("http://127.0.0.1:4173/v1", { fetchImpl });
  await complete(client, { timeoutMs: 100 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(abortEvents, 0);
});

test("rejects declared and actual responses larger than 2 MiB without retrying", async () => {
  assert.equal(MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
  let declaredFetches = 0;
  const declaredClient = createClient("http://127.0.0.1:4173/v1", {
    fetchImpl: async () => {
      declaredFetches += 1;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1) }
      });
    }
  });
  await assert.rejects(
    () => complete(declaredClient),
    error => error.code === "INVALID_RESPONSE" && !Object.hasOwn(error, "body")
  );
  assert.equal(declaredFetches, 1);

  let actualFetches = 0;
  const actualClient = createClient("http://127.0.0.1:4173/v1", {
    fetchImpl: async () => {
      actualFetches += 1;
      return new Response("x".repeat(MAX_RESPONSE_BYTES + 1), { status: 200 });
    }
  });
  await assert.rejects(
    () => complete(actualClient),
    error => error.code === "INVALID_RESPONSE" && !JSON.stringify(error).includes("xxxxx")
  );
  assert.equal(actualFetches, 1);
  assert.equal(actualClient.requestCount, 1);
});

test("one completeJson call sends exactly one HTTP request", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    sendJson(res, 200, successfulPayload());
  });
  const client = createClient(mock.baseUrl);
  await complete(client);
  assert.equal(mock.requestCount, 1);
  assert.equal(client.requestCount, 1);
});

test("sends the expected authorization header and request shape to loopback", async t => {
  let authorization;
  let requestBody;
  const mock = await createMockServer(t, async (req, res) => {
    authorization = req.headers.authorization;
    requestBody = JSON.parse(await readRequestBody(req));
    sendJson(res, 200, successfulPayload());
  });
  await complete(createClient(mock.baseUrl));

  assert.equal(authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(requestBody.model, TEST_MODEL);
  assert.deepEqual(requestBody.messages, TEST_MESSAGES);
  assert.equal(requestBody.temperature, 0);
  assert.equal(requestBody.max_tokens, 100);
  assert.equal(requestBody.stream, false);
});

test("falls back to the requested model and normalizes absent usage", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    const payload = successfulPayload();
    delete payload.model;
    delete payload.usage;
    sendJson(res, 200, payload);
  });
  const result = await complete(createClient(mock.baseUrl));
  assert.equal(result.trace.model, TEST_MODEL);
  assert.equal(result.trace.usage, null);
});

test("classifies unparseable successful HTTP responses as INVALID_RESPONSE", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("not-json");
  });
  await assert.rejects(
    () => complete(createClient(mock.baseUrl)),
    error => error.code === "INVALID_RESPONSE" && error.retryable === false
  );
});

test("classifies model text without an object as INVALID_JSON", async t => {
  const mock = await createMockServer(t, async (req, res) => {
    await readRequestBody(req);
    sendJson(res, 200, successfulPayload("no structured result"));
  });
  await assert.rejects(() => complete(createClient(mock.baseUrl)), error => {
    return error.code === "INVALID_JSON" &&
      !JSON.stringify(error).includes("no structured result");
  });
});
