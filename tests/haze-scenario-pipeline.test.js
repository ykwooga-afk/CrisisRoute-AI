const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ANALYST_TIMEOUT_MS,
  ANALYST_BATCH_MAX_TOKENS,
  REVIEWER_BATCH_MAX_TOKENS,
  BATCH_REVIEWER_TIMEOUT_MS,
  SCORING_RUBRIC,
  ANALYST_BATCH_SYSTEM_PROMPT,
  REVIEWER_BATCH_SYSTEM_PROMPT,
  IncidentPipelineError,
  normalizeCaseLabel,
  normalizeBatchAnalystData,
  normalizeBatchReviewerData,
  selectAnalystCandidate,
  selectReviewerCandidate,
  selectBatchAnalystCandidate,
  selectBatchReviewerCandidate,
  buildBatchEvidencePrompt,
  determineFullScenarioState,
  buildFullScenarioGates,
  buildQualityWarnings,
  analyzeCase01,
  analyzeFullHazeScenario
} = require("../backend/incidentPipeline");
const {
  DEFAULT_MODELS,
  GonkaClientError,
  extractStructuredJsonCandidates
} = require("../backend/gonkaClient");
const incidentSchema = require("../src/types/incident.schema.json");
const {
  CANONICAL_HAZE_MESSAGES,
  CASE_05_FIXTURE,
  createHazeScenarioCases,
  isCanonicalHazeMessages
} = require("../backend/hazeScenario");
const {
  run: runFullScenarioSmoke,
  evaluateScenarioQuality,
  LOCAL_SCENARIO_TIMEOUT_MS
} = require("../scripts/full-scenario-live-smoke");

const MESSAGES = [...CANONICAL_HAZE_MESSAGES];

function payload() {
  return { scenario: "malaysia_haze_fire_smoke", messages: [...MESSAGES] };
}

function scenarioCases() {
  return createHazeScenarioCases(MESSAGES);
}

function scores(index) {
  return [
    { verification: 80, urgency: 88, actionability: 82 },
    { verification: 30, urgency: 70, actionability: 25 },
    { verification: 20, urgency: 96, actionability: 30 },
    { verification: 45, urgency: 50, actionability: 35 },
    { verification: 60, urgency: 50, actionability: 70 }
  ][index];
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

function reviewerDirectArray() {
  return reviewerBatch().cases.map((item, index) => ({
    label: String(index + 1).padStart(2, "0"),
    scores: structuredClone(item.scores),
    ignoredReviewerField: "DROP_REVIEWER_FIELD"
  }));
}

function minimaxReviewerDirectArray() {
  return reviewerBatch().cases.map(item => ({
    caseLabel: item.caseLabel,
    scores: structuredClone(item.scores)
  }));
}

function candidatesFrom(content) {
  return extractStructuredJsonCandidates(content);
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

async function assertScenarioRejectedBeforeModelCalls(messages) {
  let modelCalls = 0;
  const client = { completeJson: async () => { modelCalls += 1; } };
  await assert.rejects(
    analyzeFullHazeScenario({
      payload: { scenario: "malaysia_haze_fire_smoke", messages },
      client
    }),
    error => {
      assert.equal(error.code, "INVALID_SCENARIO_INPUT");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /Block C|Shah Alam|Sports day|FORWARD/);
      return true;
    }
  );
  assert.equal(modelCalls, 0);
}

async function makePassingSmokeResult() {
  const result = await analyzeFullHazeScenario({ payload: payload(), client: new BatchFakeClient() });
  for (const incident of result.incidents) {
    incident.gonka.analyst.latencyMs = 1;
    incident.gonka.reviewer.latencyMs = 1;
  }
  return result;
}

async function runSmokeWithResult(result, health = {
  ok: true,
  liveRoutesReady: true,
  capabilities: { fullScenario: true }
}) {
  let call = 0;
  return runFullScenarioSmoke({
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return { json: async () => health };
      return { status: 200, ok: true, json: async () => result };
    },
    log: () => {}
  });
}

test("canonical haze messages are frozen, ordered frontend reports without the CASE 05 fixture", () => {
  assert.equal(CANONICAL_HAZE_MESSAGES.length, 5);
  assert.equal(Object.isFrozen(CANONICAL_HAZE_MESSAGES), true);
  assert.deepEqual(CANONICAL_HAZE_MESSAGES, MESSAGES);
  assert.equal(CANONICAL_HAZE_MESSAGES.includes(CASE_05_FIXTURE), false);
  assert.equal(isCanonicalHazeMessages(CANONICAL_HAZE_MESSAGES), true);
});

test("frontend rawReports remain exactly aligned with the backend canonical messages", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/data/hazeScenario.mock.js"), "utf8");
  const match = source.match(/export const rawReports\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(match, "frontend rawReports array was not found");
  assert.deepEqual(JSON.parse(match[1]), CANONICAL_HAZE_MESSAGES);
});

test("canonical haze input accepts NFKC, case and whitespace-only differences", async () => {
  const whitespaceVariant = CANONICAL_HAZE_MESSAGES.map(message =>
    `  ${message.toUpperCase().replaceAll(" ", "  \n\t")}  `);
  whitespaceVariant[2] = whitespaceVariant[2].replace("20", "２０");
  assert.equal(isCanonicalHazeMessages(whitespaceVariant), true);
  const result = await analyzeFullHazeScenario({
    payload: { scenario: "malaysia_haze_fire_smoke", messages: whitespaceVariant },
    client: new BatchFakeClient()
  });
  assert.equal(result.incidents.length, 5);
});

for (let index = 0; index < 5; index += 1) {
  test(`changed canonical message ${index + 1} is rejected before model calls`, async () => {
    const changed = [...CANONICAL_HAZE_MESSAGES];
    changed[index] = `${changed[index]} changed`;
    await assertScenarioRejectedBeforeModelCalls(changed);
  });
}

test("reordered canonical messages are rejected before model calls", async () => {
  const reordered = [...CANONICAL_HAZE_MESSAGES];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await assertScenarioRejectedBeforeModelCalls(reordered);
});

test("missing and extra canonical messages are rejected before model calls", async () => {
  await assertScenarioRejectedBeforeModelCalls(CANONICAL_HAZE_MESSAGES.slice(0, 4));
  await assertScenarioRejectedBeforeModelCalls([...CANONICAL_HAZE_MESSAGES, "extra"]);
});

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

for (const roleCase of [
  {
    role: "Analyst",
    selector: selectBatchAnalystCandidate,
    wrapper: () => analystBatch(),
    direct: () => structuredClone(analystBatch().cases)
  },
  {
    role: "Reviewer",
    selector: selectBatchReviewerCandidate,
    wrapper: () => ({ cases: reviewerDirectArray(), ignoredTopLevel: "DROP_ME" }),
    direct: reviewerDirectArray
  }
]) {
  test(`${roleCase.role} role selector accepts the canonical wrapper and drops unknown fields`, () => {
    const selected = roleCase.selector(candidatesFrom(JSON.stringify(roleCase.wrapper())));
    assert.deepEqual(selected.cases.map(item => item.label), ["01", "02", "03", "04", "05"]);
    assert.doesNotMatch(JSON.stringify(selected), /DROP_ME|DROP_REVIEWER_FIELD|ANALYST_RAW_MUST_NOT_ESCAPE/);
  });

  for (const variant of [
    { name: "direct five-item Array", wrap: value => JSON.stringify(value) },
    { name: "fenced direct Array", wrap: value => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` },
    { name: "prose before direct Array", wrap: value => `Final safe payload: ${JSON.stringify(value)}` }
  ]) {
    test(`${roleCase.role} role selector accepts ${variant.name}`, () => {
      const selected = roleCase.selector(candidatesFrom(variant.wrap(roleCase.direct())));
      assert.deepEqual(selected.cases.map(item => item.label), ["01", "02", "03", "04", "05"]);
    });
  }

  test(`${roleCase.role} role selector accepts reordered direct items by exact labels`, () => {
    const direct = roleCase.direct().reverse();
    const selected = roleCase.selector(candidatesFrom(JSON.stringify(direct)));
    assert.deepEqual(selected.cases.map(item => item.label), ["01", "02", "03", "04", "05"]);
  });

  test(`${roleCase.role} role selector accepts numeric String scores`, () => {
    const direct = roleCase.direct();
    direct[0].scores = { verification: "10", urgency: "20.5", actionability: "30" };
    const selected = roleCase.selector(candidatesFrom(JSON.stringify(direct)));
    assert.deepEqual(selected.cases[0].scores, { verification: 10, urgency: 20.5, actionability: 30 });
  });

  test(`${roleCase.role} role selector accepts multiple identical normalized candidates once`, () => {
    const direct = roleCase.direct();
    const wrapper = { cases: structuredClone(direct) };
    const selected = roleCase.selector(candidatesFrom(`${JSON.stringify(wrapper)} ${JSON.stringify(direct)}`));
    assert.equal(selected.cases.length, 5);
  });

  test(`${roleCase.role} role selector ignores an earlier unrelated Object`, () => {
    const content = `metadata {"score":7} final ${JSON.stringify(roleCase.direct())}`;
    const selected = roleCase.selector(candidatesFrom(content));
    assert.equal(selected.cases.length, 5);
  });

  test(`${roleCase.role} role selector rejects multiple different valid candidates`, () => {
    const first = roleCase.direct();
    const second = structuredClone(first);
    second[0].scores.verification = Number(second[0].scores.verification) + 1;
    assert.throws(
      () => roleCase.selector(candidatesFrom(`${JSON.stringify(first)} ${JSON.stringify(second)}`)),
      error => error.code === "INVALID_MODEL_DATA" &&
        error.role === roleCase.role.toLowerCase() &&
        error.issues.includes("payload:ambiguous_candidates")
    );
  });

  test(`${roleCase.role} role selector reports a wrong direct Array length safely`, () => {
    const direct = roleCase.direct().slice(0, 4);
    assert.throws(() => roleCase.selector(candidatesFrom(JSON.stringify(direct))), error => {
      assert.equal(error.code, "INVALID_MODEL_DATA");
      assert.ok(error.issues.includes("payload:no_contract_candidate"));
      assert.ok(error.issues.includes("payload:direct_array_wrong_length"));
      assert.doesNotMatch(JSON.stringify(error.toPublicError()), /riskFlags|counterEvidence|DROP_/);
      return true;
    });
  });

  for (const invalid of [
    { name: "missing Label", mutate(value) { delete value[0].label; } },
    { name: "duplicate Label", mutate(value) { value[4].label = "04"; } },
    { name: "extra Label", mutate(value) { value[4].label = "06"; } },
    { name: "invalid Item type", mutate(value) { value[2] = null; } },
    { name: "missing Score", mutate(value) { delete value[1].scores.urgency; } },
    { name: "out-of-range Score", mutate(value) { value[1].scores.urgency = 101; } }
  ]) {
    test(`${roleCase.role} role selector rejects ${invalid.name} in a direct Array`, () => {
      const direct = roleCase.direct();
      invalid.mutate(direct);
      assert.throws(
        () => roleCase.selector(candidatesFrom(JSON.stringify(direct))),
        error => error.code === "INVALID_MODEL_DATA" &&
          error.issues.includes("payload:no_contract_candidate")
      );
    });
  }

  test(`${roleCase.role} role selector drops prototype-pollution keys`, () => {
    const direct = roleCase.direct();
    Object.defineProperty(direct[0], "__proto__", {
      value: { polluted: true },
      enumerable: true
    });
    direct[0].constructor = { prototype: { polluted: true } };
    const selected = roleCase.selector(candidatesFrom(JSON.stringify(direct)));
    assert.equal(Object.hasOwn(selected.cases[0], "__proto__"), false);
    assert.equal(Object.hasOwn(selected.cases[0], "constructor"), false);
    assert.equal({}.polluted, undefined);
  });
}

for (const variant of [
  {
    name: "plain valid Reviewer JSON",
    content: value => JSON.stringify({ cases: value })
  },
  {
    name: "valid Reviewer JSON inside markdown fences",
    content: value => `\`\`\`json\n${JSON.stringify({ cases: value })}\n\`\`\``
  },
  {
    name: "prose before valid Reviewer JSON",
    content: value => `Reviewer payload follows:\n${JSON.stringify({ cases: value })}`
  },
  {
    name: "prose after valid Reviewer JSON",
    content: value => `${JSON.stringify({ cases: value })}\nNo real-world action executed.`
  },
  {
    name: "direct array with numeric case labels",
    content: value => JSON.stringify(value)
  },
  {
    name: "nested presentation wrapper",
    content: value => JSON.stringify({ result: { cases: value } })
  },
  {
    name: "escaped JSON string presentation wrapper",
    content: value => JSON.stringify({ output_text: JSON.stringify({ cases: value }) })
  },
  {
    name: "multiple JSON candidates where only one satisfies Reviewer contract",
    content: value => `${JSON.stringify({ note: "metadata" })}\n${JSON.stringify({ answer: { cases: value } })}`
  }
]) {
  test(`Reviewer selector accepts MiniMax-compatible ${variant.name}`, () => {
    const selected = selectBatchReviewerCandidate(candidatesFrom(variant.content(minimaxReviewerDirectArray())));
    assert.deepEqual(selected.cases.map(item => item.label), ["01", "02", "03", "04", "05"]);
    assert.deepEqual(Object.keys(selected.cases[0]), ["label", "scores"]);
  });
}

test("Reviewer selector rejects malformed MiniMax JSON safely", () => {
  assert.throws(
    () => candidatesFrom("```json\n[{broken]\n```"),
    error => error.code === "INVALID_JSON" &&
      error.issues.includes("payload:no_contract_candidate") &&
      !JSON.stringify(error).includes("broken")
  );
});

test("Reviewer selector rejects valid JSON that does not satisfy Reviewer schema", () => {
  assert.throws(
    () => selectBatchReviewerCandidate(candidatesFrom(JSON.stringify({
      result: {
        cases: [
          { label: "01", scores: { verification: 10, actionability: 30 } }
        ]
      }
    }))),
    error => error.code === "INVALID_MODEL_DATA" &&
      error.role === "reviewer" &&
      error.issues.includes("payload:no_contract_candidate")
  );
});

test("full scenario maps malformed Reviewer JSON to INVALID_MODEL_DATA without partial output", async () => {
  const client = {
    async completeJson(request) {
      if (request.model === DEFAULT_MODELS.reviewer) {
        throw new GonkaClientError("INVALID_JSON", {
          issues: ["payload:no_contract_candidate"],
          candidateCount: 0,
          candidateKinds: []
        });
      }
      return {
        candidates: candidatesFrom(JSON.stringify(analystBatch())),
        trace: trace(request.model, "analyst")
      };
    }
  };

  await assert.rejects(
    () => analyzeFullHazeScenario({ payload: payload(), client }),
    error => error.code === "INVALID_MODEL_DATA" &&
      error.role === "reviewer" &&
      error.issues.includes("payload:no_contract_candidate")
  );
});

test("CASE 01 role selectors retain Object-only contracts", () => {
  const analyst = analystBatch().cases[0];
  const reviewer = {
    scores: scores(0),
    counterEvidence: [],
    unknowns: [],
    duplicateRisk: "Low",
    conclusion: "Human review required."
  };
  const selectedAnalyst = selectAnalystCandidate(candidatesFrom(JSON.stringify({
    scores: analyst.scores,
    knownFacts: [],
    unknownFacts: [],
    riskFlags: [],
    recommendedAction: "Verify before human approval."
  })));
  const selectedReviewer = selectReviewerCandidate(candidatesFrom(JSON.stringify(reviewer)));
  assert.deepEqual(selectedAnalyst.scores, analyst.scores);
  assert.deepEqual(selectedReviewer.scores, reviewer.scores);
  assert.throws(
    () => selectAnalystCandidate(candidatesFrom(JSON.stringify([selectedAnalyst]))),
    error => error.code === "INVALID_MODEL_DATA" && error.issues.includes("payload:no_contract_candidate")
  );
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

test("both batch roles receive the same complete scoring rubric", () => {
  assert.match(SCORING_RUBRIC, /Verification/);
  assert.match(SCORING_RUBRIC, /Urgency/);
  assert.match(SCORING_RUBRIC, /Actionability/);
  assert.match(SCORING_RUBRIC, /0-29/);
  assert.match(SCORING_RUBRIC, /30-59/);
  assert.match(SCORING_RUBRIC, /60-79/);
  assert.match(SCORING_RUBRIC, /80-100/);
  assert.match(SCORING_RUBRIC, /harm IF TRUE/);
  assert.match(SCORING_RUBRIC, /low verification must not reduce urgency/i);
  assert.match(SCORING_RUBRIC, /Score each axis independently/i);
  assert.ok(ANALYST_BATCH_SYSTEM_PROMPT.includes(SCORING_RUBRIC));
  assert.ok(REVIEWER_BATCH_SYSTEM_PROMPT.includes(SCORING_RUBRIC));
});

test("Analyst batch prompt explicitly contains each required label exactly once", () => {
  const contract = ANALYST_BATCH_SYSTEM_PROMPT.slice(ANALYST_BATCH_SYSTEM_PROMPT.indexOf('{'));
  const parsed = JSON.parse(contract);
  assert.deepEqual(parsed.cases.map(item => item.label), ["01", "02", "03", "04", "05"]);
  assert.equal(new Set(parsed.cases.map(item => item.label)).size, 5);
  assert.equal(parsed.cases.length, 5);
});

test("Reviewer prompt remains a low-output-burden scores-only contract", () => {
  const expectedJson = REVIEWER_BATCH_SYSTEM_PROMPT.slice(REVIEWER_BATCH_SYSTEM_PROMPT.indexOf('{'));
  assert.ok(expectedJson.length <= 700);
  assert.doesNotMatch(REVIEWER_BATCH_SYSTEM_PROMPT, /counterEvidence|duplicateRisk|materialConflict|conclusion|recommendedAction|operationalState|safetyGates/);
  assert.match(REVIEWER_BATCH_SYSTEM_PROMPT, /independent blind reviewer/i);
  assert.match(REVIEWER_BATCH_SYSTEM_PROMPT, /low verification must not reduce urgency/i);
});

test("B7-R1 uses bounded role and local smoke timeouts", () => {
  assert.equal(ANALYST_TIMEOUT_MS, 90_000);
  assert.equal(ANALYST_BATCH_MAX_TOKENS, 1_100);
  assert.equal(REVIEWER_BATCH_MAX_TOKENS, 1_200);
  assert.equal(BATCH_REVIEWER_TIMEOUT_MS, 60_000);
  assert.equal(LOCAL_SCENARIO_TIMEOUT_MS, 75_000);
});

test("shared evidence prompt contains scoring facts without leaking expected outcomes", () => {
  const prompt = buildBatchEvidencePrompt(scenarioCases());
  assert.ok(prompt.length <= 1_800);
  for (const label of ["01", "02", "03", "04", "05"]) assert.match(prompt, new RegExp(`CASE${label}`));
  for (const fact of [
    "severe", "asthma", "Block C lobby", "reliable hostel callback", "N95 masks and clinic transport",
    "FORWARD", "not independent corroboration", "original source and callback",
    "elderly", "breathing harm is severe/time-sensitive", "not U",
    "Proceed/cancel notices conflict", "organizer confirmation",
    "Hackathon Scenario Fixture", "about 20 people", "safe space available", "not delivered"
  ]) assert.match(prompt, new RegExp(fact, "i"));
  assert.doesNotMatch(prompt, /targetState|expectedScores|expectedConsensus|DISPATCH_CANDIDATE|MERGE_OR_VERIFY|URGENT_VERIFICATION|NEEDS_HUMAN_REVIEW|QUEUED_ACTION/);
});

test("full scenario state classification uses facts rather than case labels", () => {
  assert.ok(scenarioCases().every(item => !Object.hasOwn(item, "targetState")));
  const base = {
    label: "01",
    materialConflict: false,
    duplicateOrForwardRisk: false,
    medicalRedFlag: false,
    locationKnown: false,
    contactAvailable: false,
    relevantResourceAvailable: false,
    structuredResourceRequest: false
  };
  const cases = [
    [{ ...base, materialConflict: true }, "NEEDS_HUMAN_REVIEW"],
    [{ ...base, duplicateOrForwardRisk: true }, "MERGE_OR_VERIFY"],
    [{ ...base, medicalRedFlag: true }, "URGENT_VERIFICATION"],
    [{ ...base, medicalRedFlag: true, locationKnown: true, contactAvailable: true, relevantResourceAvailable: true }, "DISPATCH_CANDIDATE"],
    [{ ...base, structuredResourceRequest: true }, "QUEUED_ACTION"],
    [base, "NEEDS_HUMAN_REVIEW"]
  ];
  for (const [facts, expected] of cases) {
    assert.equal(determineFullScenarioState(facts), expected);
    assert.equal(determineFullScenarioState({ ...facts, label: "99" }), expected);
  }
});

test("conflict and dispatch gates conservatively reflect model consensus", () => {
  const case01 = scenarioCases()[0];
  const case04 = scenarioCases()[3];
  const agreement = { level: "AGREEMENT", maxScoreGap: 10 };
  const disagreement = { level: "DISAGREEMENT", maxScoreGap: 20 };
  const critical = { level: "CRITICAL_CONFLICT", maxScoreGap: 50 };

  const agreedGates = buildFullScenarioGates(case01, agreement, determineFullScenarioState(case01));
  assert.equal(agreedGates.find(gate => gate.id === "G_CONFLICT").status, "passed");
  assert.equal(agreedGates.find(gate => gate.id === "G_DISPATCH").status, "passed");

  for (const consensus of [disagreement, critical]) {
    const gates = buildFullScenarioGates(case01, consensus, determineFullScenarioState(case01));
    assert.equal(gates.find(gate => gate.id === "G_CONFLICT").status, "review");
    assert.equal(gates.find(gate => gate.id === "G_DISPATCH").status, "review");
    assert.equal(gates.find(gate => gate.id === "G_DISPATCH").passed, false);
  }

  const materialGates = buildFullScenarioGates(case04, agreement, determineFullScenarioState(case04));
  assert.equal(materialGates.find(gate => gate.id === "G_CONFLICT").status, "review");
});

test("quality warnings flag incoherence without changing scores", () => {
  const scores = { verification: 8, urgency: 30, actionability: 5 };
  const original = structuredClone(scores);
  assert.deepEqual(buildQualityWarnings({
    operationalState: "URGENT_VERIFICATION",
    consensus: { level: "CRITICAL_CONFLICT" },
    scores
  }), ["CRITICAL_MODEL_CONFLICT", "URGENT_STATE_LOW_URGENCY_SCORE"]);
  assert.deepEqual(buildQualityWarnings({
    operationalState: "DISPATCH_CANDIDATE",
    consensus: { level: "AGREEMENT" },
    scores: { verification: 70, urgency: 80, actionability: 49 }
  }), ["ACTION_READY_LOW_ACTIONABILITY_SCORE"]);
  assert.deepEqual(scores, original);
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

for (const invalidCase of [
  { name: "Analyst", analyst: null, reviewer: reviewerBatch(), role: "analyst" },
  { name: "Reviewer", analyst: analystBatch(), reviewer: null, role: "reviewer" },
  { name: "both roles", analyst: null, reviewer: null, role: "both" }
]) {
  test(`${invalidCase.name} fulfilled-invalid batch payload reports the safe failed role`, async () => {
    await assert.rejects(
      analyzeFullHazeScenario({
        payload: payload(),
        client: new BatchFakeClient({ analyst: invalidCase.analyst, reviewer: invalidCase.reviewer })
      }),
      error => {
        assert.equal(error.code, "INVALID_MODEL_DATA");
        assert.equal(error.role, invalidCase.role);
        assert.deepEqual(error.issues, ["payload:not_object"]);
        assert.doesNotMatch(JSON.stringify(error.toPublicError()), /rawContent|ANALYST_RAW|LEGACY_REVIEWER/);
        return true;
      }
    );
  });
}

test("different fulfilled-invalid issues merge under both without values or duplicates", async () => {
  const analyst = analystBatch();
  const reviewer = reviewerBatch();
  delete analyst.cases[0].scores.verification;
  reviewer.cases[1].scores.urgency = 101;
  await assert.rejects(
    analyzeFullHazeScenario({ payload: payload(), client: new BatchFakeClient({ analyst, reviewer }) }),
    error => {
      assert.equal(error.code, "INVALID_MODEL_DATA");
      assert.equal(error.role, "both");
      assert.ok(error.issues.includes("cases.01.scores.verification:missing"));
      assert.ok(error.issues.includes("cases.02.scores.urgency:out_of_range"));
      assert.equal(new Set(error.issues).size, error.issues.length);
      assert.ok(error.issues.length <= 5);
      assert.doesNotMatch(JSON.stringify(error.toPublicError()), /101|rawContent|ANALYST_RAW|LEGACY_REVIEWER/);
      return true;
    }
  );
});

test("CASE 01 also reports both fulfilled-invalid roles without leaking either payload", async () => {
  const client = {
    completeJson: async request => ({
      data: null,
      trace: trace(request.model, request.model === DEFAULT_MODELS.analyst ? "analyst" : "reviewer")
    })
  };
  await assert.rejects(
    analyzeCase01({ payload: { messages: CANONICAL_HAZE_MESSAGES.slice(0, 2) }, client }),
    error => {
      assert.equal(error.code, "INVALID_MODEL_DATA");
      assert.equal(error.role, "both");
      assert.deepEqual(error.issues, ["payload:not_object"]);
      return true;
    }
  );
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

test("full scenario smoke safely displays role scores, gaps, warnings and latency", async () => {
  const result = await makePassingSmokeResult();
  let call = 0;
  const output = [];
  const success = await runFullScenarioSmoke({
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return {
        json: async () => ({ ok: true, liveRoutesReady: true, capabilities: { fullScenario: true } })
      };
      return { status: 200, ok: true, json: async () => result };
    },
    log: line => output.push(String(line))
  });
  const summary = output.join("\n");
  assert.equal(success, true);
  assert.match(summary, /CASE 01 Analyst Scores: V=/);
  assert.match(summary, /CASE 01 Reviewer Scores: V=/);
  assert.match(summary, /CASE 01 Final Scores: V=/);
  assert.match(summary, /CASE 01 Axis Gaps: V=/);
  assert.match(summary, /Quality Warnings:/);
  assert.match(summary, /Analyst Latency: 1ms/);
  assert.match(summary, /Reviewer Latency: 1ms/);
  assert.match(summary, /Timing Consistency: PASS/);
  assert.match(summary, /Directional Quality: PASS/);
  assert.match(summary, /Critical Conflict Count: 0/);
  assert.match(summary, /Consensus Quality: PASS/);
  assert.match(summary, /Trace Contract: PASS/);
  assert.match(summary, /Gate Consistency: PASS/);
  assert.match(summary, /Overall Quality Acceptance: PASS/);
  assert.match(summary, /Incident Shape Contract: PASS/);
  assert.match(summary, /Full generic JSON Schema validation: Not implemented/);
  assert.doesNotMatch(summary, /ANALYST_RAW_MUST_NOT_ESCAPE|LEGACY_REVIEWER_MUST_NOT_ESCAPE|GONKA_API_KEY|authorization|sk-[A-Za-z0-9_-]{12,}/i);
});

test("passing five-case result satisfies every pure Smoke quality gate", async () => {
  const quality = evaluateScenarioQuality(await makePassingSmokeResult());
  assert.deepEqual(quality, {
    directionalPassed: true,
    criticalConflictCount: 0,
    consensusPassed: true,
    warningsPassed: true,
    tracePassed: true,
    gateConsistencyPassed: true,
    passed: true
  });
});

for (const scoreFailure of [
  { name: "CASE 03 low Urgency", label: "03", axis: "urgency", value: 59 },
  { name: "CASE 01 low Actionability", label: "01", axis: "actionability", value: 49 },
  { name: "CASE 05 low Actionability", label: "05", axis: "actionability", value: 49 }
]) {
  test(`${scoreFailure.name} fails directional Smoke quality`, async () => {
    const result = await makePassingSmokeResult();
    result.incidents.find(item => item.label === scoreFailure.label).scores[scoreFailure.axis] = scoreFailure.value;
    const quality = evaluateScenarioQuality(result);
    assert.equal(quality.directionalPassed, false);
    assert.equal(quality.passed, false);
  });
}

test("three Critical Conflicts fail consensus quality without changing scores", async () => {
  const result = await makePassingSmokeResult();
  for (const incident of result.incidents.slice(0, 3)) {
    incident.modelDebate.consensus = "CRITICAL_CONFLICT";
    incident.safetyGates.find(gate => gate.id === "G_CONFLICT").status = "review";
    if (incident.operationalState === "DISPATCH_CANDIDATE") {
      incident.safetyGates.find(gate => gate.id === "G_DISPATCH").status = "review";
    }
  }
  const quality = evaluateScenarioQuality(result);
  assert.equal(quality.criticalConflictCount, 3);
  assert.equal(quality.consensusPassed, false);
  assert.equal(quality.passed, false);
});

for (const warning of ["URGENT_STATE_LOW_URGENCY_SCORE", "ACTION_READY_LOW_ACTIONABILITY_SCORE"]) {
  test(`${warning} causes Smoke quality failure`, async () => {
    const result = await makePassingSmokeResult();
    result.incidents[0].qualityWarnings.push(warning);
    const quality = evaluateScenarioQuality(result);
    assert.equal(quality.warningsPassed, false);
    assert.equal(quality.passed, false);
  });
}

for (const traceFailure of [
  { name: "missing Analyst Response ID", mutate: result => { result.incidents[0].gonka.analyst.responseId = ""; } },
  { name: "missing Reviewer Response ID", mutate: result => { result.incidents[0].gonka.reviewer.responseId = undefined; } },
  { name: "wrong Analyst model ID", mutate: result => { result.incidents[0].gonka.analyst.model = "wrong/model"; } },
  { name: "missing Reviewer latency", mutate: result => { result.incidents[0].gonka.reviewer.latencyMs = undefined; } }
]) {
  test(`${traceFailure.name} fails the Smoke trace contract`, async () => {
    const result = await makePassingSmokeResult();
    traceFailure.mutate(result);
    const quality = evaluateScenarioQuality(result);
    assert.equal(quality.tracePassed, false);
    assert.equal(quality.passed, false);
  });
}

test("Gate and Consensus inconsistency fails Smoke quality", async () => {
  const result = await makePassingSmokeResult();
  const case01 = result.incidents.find(item => item.label === "01");
  case01.safetyGates.find(gate => gate.id === "G_CONFLICT").status = "review";
  const quality = evaluateScenarioQuality(result);
  assert.equal(case01.modelDebate.consensus, "AGREEMENT");
  assert.equal(quality.gateConsistencyPassed, false);
  assert.equal(quality.passed, false);
});

test("health ok false makes Smoke fail even when result quality passes", async () => {
  const result = await makePassingSmokeResult();
  let call = 0;
  const output = [];
  const success = await runFullScenarioSmoke({
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return {
        json: async () => ({ ok: false, liveRoutesReady: true, capabilities: { fullScenario: true } })
      };
      return { status: 200, ok: true, json: async () => result };
    },
    log: line => output.push(String(line))
  });
  assert.equal(success, false);
  assert.match(output.join("\n"), /Overall Quality Acceptance: FAIL/);
});

test("run returns false when any wired quality category fails", async () => {
  const mutations = [
    result => { result.incidents.find(item => item.label === "03").scores.urgency = 59; },
    result => {
      for (const incident of result.incidents.slice(0, 3)) {
        incident.modelDebate.consensus = "CRITICAL_CONFLICT";
        incident.safetyGates.find(gate => gate.id === "G_CONFLICT").status = "review";
        if (incident.operationalState === "DISPATCH_CANDIDATE") {
          incident.safetyGates.find(gate => gate.id === "G_DISPATCH").status = "review";
        }
      }
    },
    result => { result.incidents[0].qualityWarnings.push("ACTION_READY_LOW_ACTIONABILITY_SCORE"); },
    result => { result.incidents[0].gonka.analyst.responseId = ""; },
    result => { result.incidents[0].safetyGates.find(gate => gate.id === "G_CONFLICT").status = "review"; }
  ];
  for (const mutate of mutations) {
    const result = await makePassingSmokeResult();
    mutate(result);
    assert.equal(await runSmokeWithResult(result), false);
  }
});
