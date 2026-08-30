const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ANALYST_TIMEOUT_MS,
  ANALYST_BATCH_MAX_TOKENS,
  REVIEWER_BATCH_MAX_TOKENS,
  BATCH_REVIEWER_TIMEOUT_MS,
  REVIEWER_BATCH_SYSTEM_PROMPT,
  IncidentPipelineError,
  normalizeCaseLabel,
  normalizeBatchAnalystData,
  normalizeBatchReviewerData,
  analyzeFullHazeScenario
} = require("../backend/incidentPipeline");
const { DEFAULT_MODELS } = require("../backend/gonkaClient");
const incidentSchema = require("../src/types/incident.schema.json");
const { LOCAL_SCENARIO_TIMEOUT_MS } = require("../scripts/full-scenario-live-smoke");

const MESSAGES = [
  "Block C hostel: six students are coughing badly, one has asthma. Need N95 masks and clinic transport.",
  "Another Block C resident reports heavy smoke smell and several students waiting near the lobby.",
  "FORWARD: 20 students trapped in Hostel B!!! Send everything now!!!",
  "Family near Shah Alam says an elderly parent has breathing difficulty due to haze. Exact location and callback number are unclear.",
  "Sports day is still scheduled despite haze; one notice says proceed, while another group claims cancellation."
];

function payload() {
  return { scenario: "malaysia_haze_fire_smoke", messages: [...MESSAGES] };
}

function scores(index) {
  return {
    verification: 80 - index * 7,
    urgency: index === 2 ? 96 : 88 - index * 5,
    actionability: 82 - index * 8
  };
}

function analystBatch(overrides = {}) {
  return {
    cases: ["01", "02", "03", "04", "05"].map((label, index) => ({
      label,
      scores: scores(index),
      riskFlags: index === 2 ? [" breathing difficulty ", "breathing difficulty", "DROP THIRD"] : ["bounded risk"],
      unknowns: ["source verification"],
      ignoredRawField: "ANALYST_RAW_MUST_NOT_ESCAPE"
    })),
    ignoredTopLevel: "DROP_ME",
    ...overrides
  };
}

function reviewerBatch(overrides = {}) {
  return {
    cases: ["01", "02", "03", "04", "05"].map((label, index) => ({
      caseLabel: Number(label),
      scores: {
        verification: String(scores(index).verification - 4),
        urgency: String(scores(index).urgency - 2),
        actionability: String(scores(index).actionability - 4)
      },
      counterEvidence: ["LEGACY_REVIEWER_MUST_NOT_ESCAPE"],
      duplicateRisk: index === 1 ? "HIGH" : "low",
      materialConflict: index === 3 ? "true" : "false",
      operationalState: "MODEL_MUST_NOT_CONTROL_STATE"
    })),
    ...overrides
  };
}

function trace(model, role) {
  return {
    responseId: `${role}-shared-batch-response`,
    model,
    finishReason: "stop",
    latencyMs: role === "analyst" ? 111 : 222,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
  };
}

class BatchFakeClient {
  constructor({ analyst = analystBatch(), reviewer = reviewerBatch() } = {}) {
    this.analyst = analyst;
    this.reviewer = reviewer;
    this.calls = [];
    this.pending = [];
  }

  completeJson(request) {
    this.calls.push(structuredClone(request));
    return new Promise(resolve => {
      const role = request.model === DEFAULT_MODELS.analyst ? "analyst" : "reviewer";
      this.pending.push(() => resolve({
        data: role === "analyst" ? this.analyst : this.reviewer,
        trace: trace(request.model, role)
      }));
      if (this.pending.length === 2) this.pending.splice(0).forEach(finish => finish());
    });
  }
}

function assertSchemaShape(incident) {
  for (const key of incidentSchema.required) assert.ok(Object.hasOwn(incident, key), `missing schema field ${key}`);
  assert.equal(typeof incident.caseId, "string");
  assert.equal(typeof incident.rawMessage, "string");
  assert.ok(Array.isArray(incident.claims));
  assert.ok(Array.isArray(incident.evidence));
  assert.ok(Array.isArray(incident.safetyGates));
  for (const axis of ["verification", "urgency", "actionability"]) {
    assert.equal(typeof incident.scores[axis], "number");
    assert.ok(incident.scores[axis] >= 0 && incident.scores[axis] <= 100);
  }
}

test("case labels normalize only the supported numeric forms", () => {
  assert.equal(normalizeCaseLabel(1), "01");
  assert.equal(normalizeCaseLabel("1"), "01");
  assert.equal(normalizeCaseLabel("01"), "01");
  assert.equal(normalizeCaseLabel("05"), "05");
  assert.equal(normalizeCaseLabel("6"), null);
  assert.equal(normalizeCaseLabel(true), null);
});

test("batch normalizers whitelist Analyst arrays and reduce Reviewer to labels and scores", () => {
  const analyst = normalizeBatchAnalystData(analystBatch());
  const reviewer = normalizeBatchReviewerData(reviewerBatch());
  assert.deepEqual(analyst.cases.map(item => item.label), ["01", "02", "03", "04", "05"]);
  assert.deepEqual(analyst.cases[2].riskFlags, ["breathing difficulty", "DROP THIRD"]);
  assert.equal(Object.hasOwn(analyst.cases[0], "ignoredRawField"), false);
  assert.equal(Object.hasOwn(analyst, "ignoredTopLevel"), false);
  assert.deepEqual(Object.keys(reviewer.cases[0]), ["label", "scores"]);
  for (const removed of ["counterEvidence", "duplicateRisk", "materialConflict", "operationalState"]) {
    assert.equal(Object.hasOwn(reviewer.cases[0], removed), false);
  }
});

for (const invalidCase of [
  {
    name: "missing label",
    mutate(data) { data.cases.pop(); },
    issue: "cases.05:missing"
  },
  {
    name: "duplicate label",
    mutate(data) { data.cases[4].label = "04"; },
    issue: "cases.04:duplicate_label"
  },
  {
    name: "unknown label",
    mutate(data) { data.cases[4].label = "09"; },
    issue: "cases:unknown_label"
  }
]) {
  test(`batch normalizer rejects ${invalidCase.name}`, () => {
    const data = analystBatch();
    invalidCase.mutate(data);
    assert.throws(() => normalizeBatchAnalystData(data), error => {
      assert.ok(error instanceof IncidentPipelineError);
      assert.equal(error.code, "INVALID_MODEL_DATA");
      assert.equal(error.role, "analyst");
      assert.ok(error.issues.includes(invalidCase.issue));
      return true;
    });
  });
}

for (const invalidScore of [undefined, "not-a-number", 101, -1, Infinity]) {
  test(`batch normalizer rejects invalid score ${String(invalidScore)}`, () => {
    const data = analystBatch();
    data.cases[0].scores.verification = invalidScore;
    assert.throws(() => normalizeBatchAnalystData(data), error => {
      assert.equal(error.code, "INVALID_MODEL_DATA");
      assert.equal(error.role, "analyst");
      assert.ok(error.issues.some(issue => issue.startsWith("cases.01.scores.verification:")));
      return true;
    });
  });
}

test("Reviewer minimal contract succeeds without legacy fields and drops them when supplied", () => {
  const data = reviewerBatch();
  for (const item of data.cases) {
    delete item.counterEvidence;
    delete item.duplicateRisk;
    delete item.materialConflict;
    delete item.operationalState;
  }
  const minimal = normalizeBatchReviewerData(data);
  assert.equal(minimal.cases.length, 5);
  assert.ok(minimal.cases.every(item => Object.keys(item).join(",") === "label,scores"));
});

test("Reviewer still rejects invalid required scores with safe role diagnostics", () => {
  const data = reviewerBatch();
  data.cases[0].scores.urgency = "not-numeric";
  assert.throws(() => normalizeBatchReviewerData(data), error => {
    assert.equal(error.code, "INVALID_MODEL_DATA");
    assert.equal(error.role, "reviewer");
    assert.ok(error.issues.includes("cases.01.scores.urgency:not_numeric"));
    return true;
  });
});

test("Reviewer prompt remains a low-burden scores-only contract", () => {
  assert.ok(REVIEWER_BATCH_SYSTEM_PROMPT.length <= 600);
  const expectedJson = REVIEWER_BATCH_SYSTEM_PROMPT.slice(REVIEWER_BATCH_SYSTEM_PROMPT.indexOf('{'));
  assert.ok(expectedJson.length <= 700);
  assert.doesNotMatch(REVIEWER_BATCH_SYSTEM_PROMPT, /counterEvidence|duplicateRisk|materialConflict|conclusion|recommendedAction|operationalState|safetyGates/);
  assert.match(REVIEWER_BATCH_SYSTEM_PROMPT, /independent blind reviewer/i);
  assert.match(REVIEWER_BATCH_SYSTEM_PROMPT, /low verification does not mean low urgency/i);
});

test("B7-R1 uses bounded role and local smoke timeouts", () => {
  assert.equal(ANALYST_TIMEOUT_MS, 45_000);
  assert.equal(BATCH_REVIEWER_TIMEOUT_MS, 60_000);
  assert.equal(LOCAL_SCENARIO_TIMEOUT_MS, 75_000);
});

test("full scenario performs one parallel call per role with identical evidence", async () => {
  const client = new BatchFakeClient();
  const result = await analyzeFullHazeScenario({ payload: payload(), client, now: new Date("2026-08-30T00:00:00Z") });

  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls.map(call => call.model), [DEFAULT_MODELS.analyst, DEFAULT_MODELS.reviewer]);
  assert.equal(client.calls[0].messages[1].content, client.calls[1].messages[1].content);
  assert.doesNotMatch(client.calls[1].messages.map(item => item.content).join("\n"), /analyst-shared-batch-response|ANALYST_RAW_MUST_NOT_ESCAPE|"verification":80/);
  assert.equal(client.calls[0].timeoutMs, ANALYST_TIMEOUT_MS);
  assert.equal(client.calls[1].timeoutMs, BATCH_REVIEWER_TIMEOUT_MS);
  assert.equal(client.calls[0].maxTokens, ANALYST_BATCH_MAX_TOKENS);
  assert.equal(client.calls[1].maxTokens, REVIEWER_BATCH_MAX_TOKENS);
  assert.equal(result.meta.modelRequestCount, 2);
});

test("five incidents use deterministic states, gates, schema and shared traces", async () => {
  const result = await analyzeFullHazeScenario({
    payload: payload(),
    client: new BatchFakeClient(),
    now: new Date("2026-08-30T00:00:00Z")
  });
  const expectedStates = [
    "DISPATCH_CANDIDATE",
    "MERGE_OR_VERIFY",
    "URGENT_VERIFICATION",
    "NEEDS_HUMAN_REVIEW",
    "QUEUED_ACTION"
  ];

  assert.equal(result.incidents.length, 5);
  assert.deepEqual(result.incidents.map(item => item.label), ["01", "02", "03", "04", "05"]);
  assert.deepEqual(result.incidents.map(item => item.operationalState), expectedStates);
  assert.equal(new Set(result.incidents.map(item => item.caseId)).size, 5);
  assert.deepEqual(result.meta.scenarioFixtureCases, ["05"]);
  assert.equal(result.rawReports.length, 5);
  assert.equal(result.rawReports.includes(result.incidents[4].rawMessage), false);

  for (const incident of result.incidents) {
    assertSchemaShape(incident);
    assert.equal(incident.safetyGates.length, 6);
    assert.deepEqual(incident.safetyGates.map(gate => gate.id), [
      "G_MEDICAL", "G_LOCATION", "G_CONTACT", "G_RESOURCE", "G_CONFLICT", "G_DISPATCH"
    ]);
    assert.equal(incident.gonka.analyst.responseId, "analyst-shared-batch-response");
    assert.equal(incident.gonka.reviewer.responseId, "reviewer-shared-batch-response");
  }

  assert.equal(result.incidents[0].safetyGates.find(gate => gate.id === "G_MEDICAL").status, "triggered");
  assert.equal(result.incidents[0].safetyGates.find(gate => gate.id === "G_DISPATCH").status, "passed");
  assert.match(result.incidents[0].recommendedAction, /human approval/i);
  assert.equal(result.incidents[1].safetyGates.find(gate => gate.id === "G_DISPATCH").passed, false);
  assert.equal(result.incidents[2].safetyGates.find(gate => gate.id === "G_MEDICAL").status, "triggered");
  assert.equal(result.incidents[2].safetyGates.find(gate => gate.id === "G_DISPATCH").passed, false);
  assert.ok(result.incidents[2].scores.verification < result.incidents[2].scores.urgency);
  assert.equal(result.incidents[3].safetyGates.find(gate => gate.id === "G_CONFLICT").status, "review");
  assert.equal(result.incidents[4].safetyGates.find(gate => gate.id === "G_MEDICAL").status, "passed");
  assert.doesNotMatch(JSON.stringify(result), /ANALYST_RAW_MUST_NOT_ESCAPE|LEGACY_REVIEWER_MUST_NOT_ESCAPE|MODEL_MUST_NOT_CONTROL|GONKA_API_KEY|sk-[A-Za-z0-9_-]{12,}/i);
});

test("CASE 03 stays urgent even when both verification scores are low", async () => {
  const analyst = analystBatch();
  const reviewer = reviewerBatch();
  analyst.cases[2].scores.verification = 5;
  reviewer.cases[2].scores.verification = 9;
  analyst.cases[2].scores.urgency = 98;
  reviewer.cases[2].scores.urgency = 96;
  const result = await analyzeFullHazeScenario({ payload: payload(), client: new BatchFakeClient({ analyst, reviewer }) });
  assert.equal(result.incidents[2].scores.verification, 7);
  assert.equal(result.incidents[2].scores.urgency, 97);
  assert.equal(result.incidents[2].operationalState, "URGENT_VERIFICATION");
});
