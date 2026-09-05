const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ANALYST_PROMPT_VERSION,
  REVIEWER_PROMPT_VERSION,
  ANALYST_TIMEOUT_MS,
  SINGLE_CASE_ANALYST_TIMEOUT_MS,
  REVIEWER_TIMEOUT_MS,
  validateAnalyzeRequest,
  normalizeAnalystData,
  normalizeReviewerData,
  validateAnalystData,
  validateReviewerData,
  computeConsensus,
  hasMedicalRedFlag,
  normalizeLocationCandidate,
  deriveLocation,
  extractPeopleCount,
  extractNeeds,
  extractRiskFlags,
  contactSemantics,
  buildSafetyGates,
  normalizeMissingFields,
  classifyInput,
  deriveVerificationVerdict,
  splitAtomicClaims,
  determineOperationalState,
  analyzeCase01
} = require("../backend/incidentPipeline");
const { GonkaClientError, DEFAULT_MODELS } = require("../backend/gonkaClient");
const incidentSchema = require("../src/types/incident.schema.json");

const SCENARIO_MESSAGES = [
  "Block C hostel: six students are coughing badly, one has asthma. Need N95 masks and clinic transport.",
  "Another Block C resident reports heavy smoke smell and several students waiting near the lobby.",
  "CASE 02 MUST NOT BE SENT",
  "CASE 03 MUST NOT BE SENT",
  "CASE 04 MUST NOT BE SENT"
];

function analystData(overrides = {}) {
  return {
    scores: { verification: 91, urgency: 96, actionability: 88 },
    knownFacts: ["Six students were reported coughing", "One student was reported to have asthma"],
    unknownFacts: ["Current clinical severity"],
    riskFlags: ["asthma", "severe coughing", "haze exposure"],
    recommendedAction: "Prepare a proposed mask and clinic transport response for human approval.",
    title: "MODEL_MUST_NOT_CONTROL_TITLE",
    location: "MODEL_MUST_NOT_CONTROL_LOCATION",
    claims: [{ text: "MODEL_MUST_NOT_CONTROL_CLAIMS", status: "supported" }],
    operationalState: "MODEL_MUST_NOT_CONTROL_THIS",
    rawContent: "ANALYST_RAW_SENTINEL",
    ...overrides
  };
}

function reviewerData(overrides = {}) {
  return {
    scores: { verification: 89, urgency: 94, actionability: 86 },
    conclusion: "The evidence supports urgent, bounded assistance after human approval.",
    counterEvidence: ["No clinical assessment is supplied"],
    unknowns: ["Current asthma severity"],
    duplicateRisk: "Low",
    operationalState: "MODEL_REVIEW_STATE",
    rawContent: "REVIEWER_RAW_SENTINEL",
    ...overrides
  };
}

function resultForModel(model, data) {
  const analyst = model === DEFAULT_MODELS.analyst;
  return {
    data,
    trace: {
      responseId: analyst ? "analyst-role-result" : "reviewer-role-result",
      model,
      finishReason: "stop",
      latencyMs: analyst ? 111 : 222,
      usage: null
    }
  };
}

class FakeGonkaClient {
  constructor({ analyst = analystData(), reviewer = reviewerData() } = {}) {
    this.analyst = analyst;
    this.reviewer = reviewer;
    this.calls = [];
  }

  async completeJson(request) {
    this.calls.push(structuredClone(request));
    if (request.model === DEFAULT_MODELS.analyst) {
      return {
        data: this.analyst,
        trace: {
          responseId: "analyst-response-01",
          model: DEFAULT_MODELS.analyst,
          finishReason: "stop",
          latencyMs: 111,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
        }
      };
    }
    return {
      data: this.reviewer,
      trace: {
        responseId: "reviewer-response-01",
        model: DEFAULT_MODELS.reviewer,
        finishReason: "stop",
        latencyMs: 222,
        usage: { promptTokens: 11, completionTokens: 21, totalTokens: 32 }
      }
    };
  }
}

function scenarioPayload() {
  return { scenario: "malaysia_haze_fire_smoke", messages: SCENARIO_MESSAGES };
}

test("normalizers preserve valid camelCase data in new whitelist objects", () => {
  const source = analystData({ unknownExtension: "DROP_ME" });
  const normalized = normalizeAnalystData(source);

  assert.deepEqual(normalized.scores, source.scores);
  assert.deepEqual(normalized.riskFlags, source.riskFlags);
  assert.notEqual(normalized, source);
  assert.notEqual(normalized.scores, source.scores);
  assert.equal(Object.hasOwn(normalized, "unknownExtension"), false);
  assert.equal(Object.hasOwn(normalized, "rawContent"), false);
  assert.equal(Object.hasOwn(normalized, "operationalState"), false);
});

test("normalizers accept snake_case aliases while preferring camelCase", () => {
  const normalized = normalizeAnalystData({
    riskFlags: ["camel wins"],
    risk_flags: ["snake loses"],
    known_facts: "Reported smoke",
    unknown_facts: null,
    recommended_action: "Verify before any dispatch.",
    scores: {
      verification: 72,
      verification_score: "91.0",
      urgency_score: "96",
      actionability_score: 88.0
    }
  });

  assert.deepEqual(normalized.riskFlags, ["camel wins"]);
  assert.deepEqual(normalized.knownFacts, ["Reported smoke"]);
  assert.deepEqual(normalized.unknownFacts, []);
  assert.deepEqual(normalized.scores, { verification: 72, urgency: 96, actionability: 88 });
  assert.equal(normalized.recommendedAction, "Verify before any dispatch.");

  const reviewer = normalizeReviewerData({
    counter_evidence: "No clinical assessment",
    duplicate_risk: "low",
    scores: { verification: "70", urgency: "90", actionability: "60" }
  });
  assert.deepEqual(reviewer.counterEvidence, ["No clinical assessment"]);
  assert.equal(reviewer.duplicateRisk, "Low");
});

test("description arrays normalize strings, blanks, duplicates, limits, and missing values", () => {
  const long = "x".repeat(300);
  const normalized = normalizeAnalystData(analystData({
    riskFlags: [" smoke ", "", "smoke", long, "a", "b", "c", "d"],
    knownFacts: null,
    unknownFacts: undefined
  }));

  assert.equal(normalized.riskFlags.length, 3);
  assert.equal(normalized.riskFlags[1].length, 180);
  assert.deepEqual(normalized.knownFacts, []);
  assert.deepEqual(normalized.unknownFacts, []);
});

test("removed Incident fields are discarded from the minimal Analyst contract", () => {
  const normalized = normalizeAnalystData(analystData({
    title: "Must be discarded",
    location: "Must be discarded",
    peopleCount: 99,
    needs: ["Must be discarded"],
    claims: ["Must be discarded"],
    safeNextActions: ["Must be discarded"]
  }));

  for (const field of ["title", "location", "peopleCount", "needs", "claims", "safeNextActions"]) {
    assert.equal(Object.hasOwn(normalized, field), false, field);
  }
});

test("duplicateRisk is case-normalized and conservatively defaults to High", () => {
  assert.equal(normalizeReviewerData(reviewerData({ duplicateRisk: "medium" })).duplicateRisk, "Medium");
  assert.equal(normalizeReviewerData(reviewerData({ duplicateRisk: "HIGH" })).duplicateRisk, "High");
  assert.equal(normalizeReviewerData(reviewerData({ duplicateRisk: undefined })).duplicateRisk, "High");
  assert.equal(normalizeReviewerData(reviewerData({ duplicateRisk: "unknown" })).duplicateRisk, "High");
});

test("transparent defaults remain neutral and never claim verification or dispatch", () => {
  const analyst = normalizeAnalystData({
    scores: { verification: 50, urgency: 80, actionability: 40 }
  });
  const reviewer = normalizeReviewerData({
    scores: { verification: 45, urgency: 85, actionability: 35 }
  });
  const defaults = JSON.stringify({ analyst, reviewer });

  assert.equal(reviewer.duplicateRisk, "High");
  assert.doesNotMatch(defaults, /confirmed fact|already dispatched|has been contacted|treatment completed/i);
  assert.match(analyst.recommendedAction, /verify.*human approval/i);
  assert.match(reviewer.conclusion, /human review remains required/i);
});

test("critical score diagnostics expose only safe paths and reasons", () => {
  const sensitiveValue = "sk-THIS-MUST-NOT-LEAK-123456789";
  assert.throws(() => normalizeReviewerData({
    scores: {
      verification: sensitiveValue,
      urgency: 101,
      actionability: null
    }
  }), error => {
    const serialized = JSON.stringify(error);
    return error.code === "INVALID_MODEL_DATA" &&
      error.role === "reviewer" &&
      error.message === "Reviewer model data was invalid." &&
      error.issues.length === 3 &&
      error.issues.includes("scores.verification:not_numeric") &&
      error.issues.includes("scores.urgency:out_of_range") &&
      error.issues.includes("scores.actionability:missing") &&
      !serialized.includes(sensitiveValue) &&
      !serialized.includes("101");
  });
});

test("payload type errors receive bounded role-specific diagnostics", () => {
  assert.throws(
    () => normalizeAnalystData("not an object"),
    error => error.role === "analyst" &&
      error.issues.length === 1 &&
      error.issues[0] === "payload:not_object"
  );
  assert.throws(
    () => normalizeReviewerData(null),
    error => error.role === "reviewer" &&
      error.issues[0] === "payload:not_object"
  );
});

test("CASE 01 calls Analyst and blind Reviewer exactly once each", async () => {
  const client = new FakeGonkaClient();
  await analyzeCase01({ payload: scenarioPayload(), client, now: new Date("2026-08-30T00:00:00Z") });

  assert.equal(client.calls.length, 2);
  assert.equal(client.calls.filter(call => call.model === DEFAULT_MODELS.analyst).length, 1);
  assert.equal(client.calls.filter(call => call.model === DEFAULT_MODELS.reviewer).length, 1);
  assert.equal(client.calls[0].temperature, 0);
  assert.equal(client.calls[1].temperature, 0);
});

test("CASE 01 passes role-specific bounded request settings", async () => {
  const client = new FakeGonkaClient();
  await analyzeCase01({ payload: scenarioPayload(), client });
  const analystCall = client.calls.find(call => call.model === DEFAULT_MODELS.analyst);
  const reviewerCall = client.calls.find(call => call.model === DEFAULT_MODELS.reviewer);

  assert.equal(ANALYST_TIMEOUT_MS, 90_000);
  assert.equal(SINGLE_CASE_ANALYST_TIMEOUT_MS, 90_000);
  assert.equal(REVIEWER_TIMEOUT_MS, 90_000);
  assert.equal(analystCall.timeoutMs, 90_000);
  assert.equal(reviewerCall.timeoutMs, 90_000);
  assert.equal(analystCall.maxTokens, 600);
  assert.equal(reviewerCall.maxTokens, 1_200);
  assert.match(analystCall.messages[0].content, /knownFacts<=3.*unknownFacts<=3.*riskFlags<=3/s);
  assert.match(reviewerCall.messages[0].content, /counterEvidence<=3.*unknowns<=3/s);
  for (const call of [analystCall, reviewerCall]) {
    assert.match(call.messages[0].content, /LOW VERIFICATION DOES NOT MEAN LOW URGENCY/);
    assert.match(call.messages[0].content, /AI advises; humans decide/);
    assert.equal((call.messages[0].content.match(/Return exactly:/g) || []).length, 1);
  }
  assert.ok(analystCall.messages[0].content.length <= 1_000);
  assert.ok(reviewerCall.messages[0].content.length <= 900);
  assert.ok(analystCall.messages.reduce((sum, message) => sum + message.content.length, 0) <= 1_300);
  assert.ok(reviewerCall.messages.reduce((sum, message) => sum + message.content.length, 0) <= 1_300);
  assert.doesNotMatch(analystCall.messages[0].content, /title|location|peopleCount|claims|safeNextActions|operationalState|safetyGates/i);
  assert.doesNotMatch(reviewerCall.messages[0].content, /safetyConcerns|rationale|operationalState|safetyGates/i);
});

test("live crisis text preserves city while requiring exact location and callback detail", async () => {
  const client = new FakeGonkaClient({
    analyst: analystData({
      scores: { verification: 56, urgency: 92, actionability: 42 },
      knownFacts: ["Elderly man in Shah Alam", "Breathing difficulty getting worse", "Daughter can be contacted by phone"],
      unknownFacts: ["Exact apartment number unknown", "Location beyond Shah Alam unspecified", "Verified callback number missing"],
      riskFlags: ["breathing difficulty"],
      recommendedAction: "Request urgent verification before dispatch."
    }),
    reviewer: reviewerData({
      scores: { verification: 54, urgency: 94, actionability: 40 },
      unknowns: ["exact apartment number is unknown", "callback detail unknown"],
      counterEvidence: ["No independent corroboration"]
    })
  });
  const result = await analyzeCase01({
    payload: {
      messages: [
        "Elderly man in Shah Alam has severe breathing difficulty getting worse. Exact apartment number unknown. Daughter can be contacted by phone. Need medical volunteer."
      ]
    },
    client,
    now: new Date("2026-09-05T01:00:00Z")
  });
  const incident = result.incidents[0];
  assert.equal(incident.location, "Shah Alam · Exact location unknown");
  assert.equal(incident.peopleCount, 1);
  assert.equal(incident.inputClassification.kind, "ACTIVE_REPORT");
  assert.equal(incident.safetyGates.find(gate => gate.id === "G_LOCATION").status, "blocked");
  assert.equal(incident.safetyGates.find(gate => gate.id === "G_CONTACT").status, "passed");
  assert.match(incident.safetyGates.find(gate => gate.id === "G_CONTACT").detail, /contact channel is available/i);
  assert.ok(incident.missingFields.includes("exact location within Shah Alam"));
  assert.ok(incident.missingFields.includes("verified callback detail"));
  assert.equal(incident.missingFields.filter(item => /location/i.test(item)).length, 1);
  assert.equal(incident.missingFields.includes("contact or callback path"), false);
  assert.equal(incident.operationalState, "URGENT_VERIFICATION");
});

test("junk location fragments cannot pass as actionable locations", () => {
  const request = validateAnalyzeRequest({ messages: ["Smoke may block the view near the corridor."] });
  const consensus = { level: "AGREEMENT", maxScoreGap: 0, gaps: { verification: 0, urgency: 0, actionability: 0 } };
  const assessment = { needs: [], riskFlags: [] };
  assert.equal(normalizeLocationCandidate("block the"), null);
  assert.equal(normalizeLocationCandidate("the location"), null);
  assert.equal(normalizeLocationCandidate("near the"), null);
  assert.equal(normalizeLocationCandidate("Block C"), "Block C");
  assert.equal(normalizeLocationCandidate("Apartment 12-3, Block C"), "Apartment 12-3, Block C");
  assert.equal(deriveLocation(request), "Unknown location");
  const safety = buildSafetyGates({ request, assessment, consensus, location: "block the" });
  const locationGate = safety.gates.find(gate => gate.id === "G_LOCATION");
  assert.equal(locationGate.status, "blocked");
  assert.equal(locationGate.passed, false);
});

test("reference public URL is classified without fabricating an operational incident", async () => {
  const client = new FakeGonkaClient({
    analyst: analystData({
      scores: { verification: 68, urgency: 34, actionability: 20 },
      knownFacts: ["Haze contains smoke and particulates", "Haze can reduce visibility"],
      unknownFacts: ["Current incident report missing", "No affected person identified"],
      riskFlags: ["smoke exposure"],
      recommendedAction: "Use as background only unless a current report is supplied."
    }),
    reviewer: reviewerData({
      scores: { verification: 66, urgency: 32, actionability: 22 },
      unknowns: ["current actionable incident report missing", "No affected population"],
      conclusion: "This is background content, not a current operational case."
    })
  });
  const result = await analyzeCase01({
    payload: {
      messages: [
        [
          "Public source URL: https://en.wikipedia.org/wiki/Haze",
          "Page title: Haze - Wikipedia",
          "Source hostname: en.wikipedia.org",
          "Extracted main content:",
          "Haze is traditionally an atmospheric phenomenon where dust, smoke and dry particulates obscure the clarity of the sky.",
          "Haze can reduce visibility.",
          "Severe haze exposure can create respiratory health risk."
        ].join("\n")
      ]
    },
    client,
    now: new Date("2026-09-05T01:00:00Z")
  });
  const incident = result.incidents[0];
  assert.equal(incident.inputClassification.kind, "REFERENCE_SOURCE");
  assert.equal(incident.inputClassification.activeIncident, false);
  assert.equal(incident.title, "Haze - Wikipedia");
  assert.equal(incident.location, "Unknown location");
  assert.equal(incident.peopleCount, null);
  assert.equal(incident.safetyGates.find(gate => gate.id === "G_LOCATION").passed, false);
  assert.ok(incident.claims.length >= 3);
  assert.ok(incident.claims.every(claim => claim.kind === "background"));
  assert.equal(incident.claims.some(claim => /Public source URL|Page title|Source hostname/.test(claim.text)), false);
  assert.ok(incident.missingFields.includes("current actionable incident report"));
  assert.match(incident.safeNextActions.join(" "), /No operational response is recommended/);
});

test("missing-info normalization dedupes equivalent location and contact uncertainty", () => {
  const missing = normalizeMissingFields([
    "Exact apartment number is unknown",
    "Exact apartment number unknown.",
    "Location beyond Shah Alam unspecified",
    "verified callback number",
    "callback detail unknown"
  ], { knownArea: "Shah Alam", contactChannelAvailable: true });
  assert.deepEqual(missing, ["exact location within Shah Alam", "verified callback detail"]);
});

test("verification verdict is a display-only mapping from existing scores and consensus", () => {
  assert.equal(deriveVerificationVerdict({ scores: { verification: 85 }, consensus: { level: "AGREEMENT" } }), "SUPPORTED");
  assert.equal(deriveVerificationVerdict({ scores: { verification: 45 }, consensus: { level: "AGREEMENT" } }), "LIMITED SUPPORT");
  assert.equal(deriveVerificationVerdict({ scores: { verification: 20 }, consensus: { level: "AGREEMENT" } }), "UNVERIFIED");
  assert.equal(deriveVerificationVerdict({ scores: { verification: 85 }, consensus: { level: "CRITICAL_CONFLICT" } }), "CONFLICTING");
});

test("Analyst timeout is safely identified without leaking successful Reviewer content", async () => {
  const calls = [];
  const client = {
    async completeJson(request) {
      calls.push(request);
      if (request.model === DEFAULT_MODELS.analyst) {
        throw new GonkaClientError("TIMEOUT", { retryable: true });
      }
      return resultForModel(request.model, reviewerData({ rawContent: "SUCCESS_REVIEWER_RAW" }));
    }
  };

  await assert.rejects(() => analyzeCase01({ payload: scenarioPayload(), client }), error => {
    const serialized = JSON.stringify(error);
    return error.code === "TIMEOUT" &&
      error.message === "Analyst model timed out." &&
      error.role === "analyst" &&
      error.retryable === true &&
      !serialized.includes("SUCCESS_REVIEWER_RAW") &&
      !serialized.includes("fake-key-for-timeout-test");
  });
  assert.equal(calls.filter(call => call.model === DEFAULT_MODELS.analyst).length, 1);
  assert.equal(calls.filter(call => call.model === DEFAULT_MODELS.reviewer).length, 1);
});

test("Reviewer timeout is safely identified without returning a partial Incident", async () => {
  const calls = [];
  const client = {
    async completeJson(request) {
      calls.push(request);
      if (request.model === DEFAULT_MODELS.reviewer) {
        throw new GonkaClientError("TIMEOUT", { retryable: true });
      }
      return resultForModel(request.model, analystData({ rawContent: "SUCCESS_ANALYST_RAW" }));
    }
  };

  await assert.rejects(() => analyzeCase01({ payload: scenarioPayload(), client }), error => {
    const serialized = JSON.stringify(error);
    return error.code === "TIMEOUT" &&
      error.message === "Reviewer model timed out." &&
      error.role === "reviewer" &&
      !serialized.includes("SUCCESS_ANALYST_RAW") &&
      !serialized.includes("incidents");
  });
  assert.equal(calls.length, 2);
});

test("simultaneous timeouts return one safe error with no raw content", async () => {
  let calls = 0;
  const client = {
    async completeJson() {
      calls += 1;
      throw new GonkaClientError("TIMEOUT", { retryable: true });
    }
  };
  await assert.rejects(() => analyzeCase01({ payload: scenarioPayload(), client }), error => {
    return error.code === "TIMEOUT" &&
      error.message === "One or more models timed out." &&
      error.role === "both" &&
      !JSON.stringify(error).match(/raw|authorization|sk-[A-Za-z0-9_-]{12,}/i);
  });
  assert.equal(calls, 2);
});

test("both role requests start before either role is allowed to finish", async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = {
    completeJson(request) {
      calls.push(request);
      return gate.then(() => resultForModel(
        request.model,
        request.model === DEFAULT_MODELS.analyst ? analystData() : reviewerData()
      ));
    }
  };

  const pending = analyzeCase01({ payload: scenarioPayload(), client });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  release();
  const result = await pending;
  assert.equal(result.incidents.length, 1);
  assert.equal(calls.filter(call => call.model === DEFAULT_MODELS.analyst).length, 1);
  assert.equal(calls.filter(call => call.model === DEFAULT_MODELS.reviewer).length, 1);
});

test("fulfilled invalid Analyst data receives role diagnosis without leaking Reviewer content", async () => {
  const client = {
    async completeJson(request) {
      if (request.model === DEFAULT_MODELS.analyst) {
        const invalid = analystData();
        delete invalid.scores.urgency;
        return resultForModel(request.model, invalid);
      }
      return resultForModel(request.model, reviewerData({ rawContent: "REVIEWER_SUCCESS_RAW" }));
    }
  };

  await assert.rejects(() => analyzeCase01({ payload: scenarioPayload(), client }), error => {
    const serialized = JSON.stringify(error);
    return error.code === "INVALID_MODEL_DATA" &&
      error.message === "Analyst model data was invalid." &&
      error.role === "analyst" &&
      error.issues.includes("scores.urgency:missing") &&
      !serialized.includes("REVIEWER_SUCCESS_RAW");
  });
});

test("Reviewer receives the same evidence but no Analyst prompt or output", async () => {
  const client = new FakeGonkaClient();
  await analyzeCase01({ payload: scenarioPayload(), client });
  const analystCall = client.calls.find(call => call.model === DEFAULT_MODELS.analyst);
  const reviewerCall = client.calls.find(call => call.model === DEFAULT_MODELS.reviewer);

  assert.equal(analystCall.messages[1].content, reviewerCall.messages[1].content);
  assert.doesNotMatch(JSON.stringify(reviewerCall), /ANALYST_RAW_SENTINEL|analyst-response-01/i);
  assert.match(reviewerCall.messages[0].content, /blind, independent Reviewer/i);
});

test("scenario processing sends only the first two CASE 01 messages", async () => {
  const client = new FakeGonkaClient();
  const result = await analyzeCase01({ payload: scenarioPayload(), client });
  const prompt = client.calls[0].messages[1].content;

  assert.match(prompt, /Block C hostel/);
  assert.match(prompt, /near the lobby/);
  assert.doesNotMatch(prompt, /CASE 02|CASE 03|CASE 04/);
  assert.equal(result.meta.receivedMessageCount, 5);
  assert.equal(result.meta.processedMessageCount, 2);
});

test("consensus rounds the independent score averages", () => {
  const result = computeConsensus(
    { verification: 91, urgency: 96, actionability: 88 },
    { verification: 88, urgency: 93, actionability: 85 }
  );
  assert.deepEqual(result.scores, { verification: 90, urgency: 95, actionability: 87 });
});

test("consensus applies all three gap levels", () => {
  assert.equal(computeConsensus(
    { verification: 50, urgency: 50, actionability: 50 },
    { verification: 65, urgency: 50, actionability: 50 }
  ).level, "AGREEMENT");
  assert.equal(computeConsensus(
    { verification: 50, urgency: 50, actionability: 50 },
    { verification: 66, urgency: 50, actionability: 50 }
  ).level, "DISAGREEMENT");
  assert.equal(computeConsensus(
    { verification: 50, urgency: 50, actionability: 50 },
    { verification: 81, urgency: 50, actionability: 50 }
  ).level, "CRITICAL_CONFLICT");
});

test("rejects out-of-range model scores", () => {
  assert.throws(
    () => validateAnalystData(analystData({
      scores: { verification: 101, urgency: 50, actionability: 50 }
    })),
    error => error.code === "INVALID_MODEL_DATA" &&
      error.role === "analyst" &&
      error.issues.includes("scores.verification:out_of_range")
  );
});

test("rejects missing core score fields", () => {
  const invalid = analystData();
  delete invalid.scores.actionability;
  assert.throws(
    () => validateAnalystData(invalid),
    error => error.code === "INVALID_MODEL_DATA" &&
      error.issues.includes("scores.actionability:missing")
  );
});

test("detects configured medical red flags", () => {
  assert.equal(hasMedicalRedFlag(["One resident cannot breathe"], {}), true);
  assert.equal(hasMedicalRedFlag(["One student has asthma"], {}), true);
  assert.equal(hasMedicalRedFlag(["Supplies requested with no symptoms"], {}), false);
});

test("medical risk without location or contact becomes URGENT_VERIFICATION", () => {
  const request = validateAnalyzeRequest({ messages: ["A person cannot breathe and needs an N95 mask"] });
  const consensus = computeConsensus(analystData().scores, reviewerData().scores);
  const assessment = {
    needs: extractNeeds(request.messages),
    riskFlags: extractRiskFlags(request.messages)
  };
  const safety = buildSafetyGates({ request, assessment, consensus, location: deriveLocation(request) });
  assert.equal(determineOperationalState(safety.flags, consensus.level), "URGENT_VERIFICATION");
});

test("critical model conflict becomes NEEDS_HUMAN_REVIEW", () => {
  const flags = {
    medical: false,
    locationPassed: true,
    contactPassed: true,
    resourcePassed: true
  };
  assert.equal(determineOperationalState(flags, "CRITICAL_CONFLICT"), "NEEDS_HUMAN_REVIEW");
});

test("CASE 01 with deterministic safety conditions becomes DISPATCH_CANDIDATE", async () => {
  const result = await analyzeCase01({ payload: scenarioPayload(), client: new FakeGonkaClient() });
  const incident = result.incidents[0];
  assert.equal(incident.operationalState, "DISPATCH_CANDIDATE");
  assert.equal(incident.safetyGates.find(gate => gate.id === "G_DISPATCH").passed, true);
  assert.equal(incident.actionPlan.status, "PROPOSED — REQUIRES HUMAN APPROVAL");
  assert.equal(incident.humanDecision, null);
  assert.equal(incident.title, "Block C Respiratory Cluster");
  assert.equal(incident.source, "Hostel Telegram");
  assert.equal(incident.location, "Block C lobby");
  assert.equal(incident.peopleCount, 6);
  assert.deepEqual(incident.needs, ["N95 masks", "Clinic transport"]);
  assert.deepEqual(incident.riskFlags, ["severe coughing", "asthma", "smoke exposure"]);
  assert.deepEqual(incident.claims.map(claim => claim.status), ["reported", "supported"]);
  assert.deepEqual(incident.claims[0].evidenceIds, ["E-CASE01-1"]);
  assert.deepEqual(incident.claims[1].evidenceIds, ["E-CASE01-1", "E-CASE01-2"]);
});

test("manual input does not invent a contact path", async () => {
  const client = new FakeGonkaClient();
  const result = await analyzeCase01({
    payload: { messages: ["Hostel Block D resident has asthma and needs an N95 mask"] },
    client
  });
  const incident = result.incidents[0];
  assert.equal(incident.safetyGates.find(gate => gate.id === "G_CONTACT").passed, false);
  assert.equal(incident.operationalState, "URGENT_VERIFICATION");
});

test("Incident includes required contract fields and independent traces", async () => {
  const result = await analyzeCase01({ payload: scenarioPayload(), client: new FakeGonkaClient() });
  const incident = result.incidents[0];
  const required = [
    "caseId", "label", "title", "rawMessage", "source", "receivedAt", "location",
    "peopleCount", "needs", "riskFlags", "knownFacts", "unknownFacts",
    "priorityRationale", "safeNextActions", "claims", "evidence", "scores",
    "operationalState", "missingFields", "modelDebate", "modelReviews", "safetyGates",
    "recommendedAction", "actionPlan", "actionBrief", "proofCapsule", "gonka", "humanDecision"
  ];
  for (const field of required) assert.ok(Object.hasOwn(incident, field), field);
  for (const field of incidentSchema.required) {
    assert.ok(Object.hasOwn(incident, field), `schema required: ${field}`);
  }
  assert.ok(incident.claims.every(claim =>
    incidentSchema.properties.claims.items.required.every(field => Object.hasOwn(claim, field))));
  assert.ok(incident.evidence.every(item =>
    incidentSchema.properties.evidence.items.required.every(field => Object.hasOwn(item, field))));
  assert.ok(incident.safetyGates.every(gate =>
    incidentSchema.properties.safetyGates.items.required.every(field => Object.hasOwn(gate, field))));
  assert.equal(incident.gonka.analyst.responseId, "analyst-response-01");
  assert.equal(incident.gonka.reviewer.responseId, "reviewer-response-01");
  assert.equal(incident.gonka.analyst.promptVersion, ANALYST_PROMPT_VERSION);
  assert.equal(incident.gonka.reviewer.promptVersion, REVIEWER_PROMPT_VERSION);
});

test("sanitized response contains no raw model content or model-selected state", async () => {
  const result = await analyzeCase01({ payload: scenarioPayload(), client: new FakeGonkaClient() });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /ANALYST_RAW_SENTINEL|REVIEWER_RAW_SENTINEL|MODEL_MUST_NOT_CONTROL_THIS|MODEL_REVIEW_STATE/);
  assert.doesNotMatch(serialized, /authorization|GONKA_API_KEY|sk-[A-Za-z0-9_-]{12,}/i);
});

test("invalid requests never call either model", async () => {
  const client = new FakeGonkaClient();
  await assert.rejects(
    () => analyzeCase01({ payload: { messages: [] }, client }),
    error => error.code === "INVALID_REQUEST"
  );
  assert.equal(client.calls.length, 0);
});

test("CASE 01 case ID is stable and generated by code", async () => {
  const first = await analyzeCase01({ payload: scenarioPayload(), client: new FakeGonkaClient() });
  const second = await analyzeCase01({ payload: scenarioPayload(), client: new FakeGonkaClient() });
  assert.equal(first.incidents[0].caseId, "CR-LIVE-CASE-01");
  assert.equal(second.incidents[0].caseId, first.incidents[0].caseId);
});
