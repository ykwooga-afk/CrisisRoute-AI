const net = require("node:net");

const { createDecisionLedger } = require("../backend/decisionLedger");
const { createServer } = require("../server");

const HOST = "127.0.0.1";
const PORT = 4173;

function fakeIncident(label, operationalState, overrides = {}) {
  const dispatchCandidate = operationalState === "DISPATCH_CANDIDATE";
  return {
    caseId: `CR-LIVE-CASE-${label}`,
    label,
    operationalState,
    scores: { verification: label === "03" ? 35 : 82, urgency: label === "03" ? 98 : 88, actionability: 76 },
    modelDebate: {
      consensus: overrides.consensus || "AGREEMENT",
      scoreGaps: { verification: 3, urgency: 4, actionability: 5 }
    },
    safetyGates: [
      { id: "G_LOCATION", status: overrides.location === false ? "blocked" : "passed", passed: overrides.location !== false },
      { id: "G_CONTACT", status: overrides.contact === false ? "blocked" : "passed", passed: overrides.contact !== false },
      { id: "G_RESOURCE", status: "passed", passed: true },
      { id: "G_CONFLICT", status: "passed", passed: true },
      { id: "G_DISPATCH", status: dispatchCandidate ? "passed" : "locked", passed: dispatchCandidate }
    ],
    qualityWarnings: [],
    receivedAt: "2026-08-31T08:00:00.000Z",
    rawMessage: "RAW_MODEL_CONTENT_SMOKE_SENTINEL",
    prompt: "PROMPT_SMOKE_SENTINEL",
    authorization: "Bearer sk-SMOKE-SENTINEL-MUST-NOT-LEAK",
    gonka: {
      analyst: { model: "offline-fake-analyst", responseId: `offline-a-${label}`, rawContent: "RAW_A" },
      reviewer: { model: "offline-fake-reviewer", responseId: `offline-r-${label}`, prompt: "PROMPT_R" }
    }
  };
}

function fakeScenario() {
  return {
    incidents: [
      fakeIncident("01", "DISPATCH_CANDIDATE"),
      fakeIncident("02", "MERGE_OR_VERIFY"),
      fakeIncident("03", "URGENT_VERIFICATION", { location: false, contact: false }),
      fakeIncident("04", "NEEDS_HUMAN_REVIEW", { consensus: "CRITICAL_CONFLICT" }),
      fakeIncident("05", "QUEUED_ACTION")
    ],
    resources: [],
    meta: { mode: "offline-decision-smoke", modelRequestCount: 0 }
  };
}

function isPortListening(port = PORT) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: HOST, port });
    const finish = listening => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

async function run({ log = console.log } = {}) {
  if (await isPortListening()) {
    log("B8 Decision Flow Smoke: BLOCKED — port 4173 is already in use");
    return false;
  }

  let fakeAnalyzeCalls = 0;
  let gonkaFactoryCalls = 0;
  let externalNetworkCount = 0;
  const ledger = createDecisionLedger();
  const server = createServer({
    decisionLedger: ledger,
    analyzeIncidentsFn: async () => {
      fakeAnalyzeCalls += 1;
      return fakeScenario();
    },
    gonkaClientFactory: () => {
      gonkaFactoryCalls += 1;
      throw new Error("Gonka must not be initialized by the offline decision smoke");
    }
  });
  const baseUrl = `http://${HOST}:${PORT}`;
  const localFetch = (pathname, options) => {
    const url = new URL(pathname, baseUrl);
    if (url.hostname !== HOST && url.hostname !== "localhost") externalNetworkCount += 1;
    return fetch(url, options);
  };

  let summary;
  let success = false;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, HOST, resolve);
    });

    const analyzeResponse = await localFetch("/api/incidents/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: ["offline smoke fixture"] })
    });
    await analyzeResponse.json();

    const postDecision = (caseId, payload, key) => localFetch(`/api/incidents/${caseId}/decision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {})
      },
      body: JSON.stringify(payload)
    });
    const case03Payload = {
      action: "REQUEST_VERIFICATION",
      reason: "Human requested urgent verification.",
      acknowledgeHumanDecision: true,
      acknowledgeNoAutomaticExecution: true
    };
    const case01Payload = {
      action: "APPROVE_ACTION",
      reason: "Human approved this bounded proposal after reviewing all gates.",
      acknowledgeHumanDecision: true,
      acknowledgeNoAutomaticExecution: true
    };

    const case03Response = await postDecision("CR-LIVE-CASE-03", case03Payload, "smoke-case03-key");
    const case03Decision = await case03Response.json();
    const case01Response = await postDecision("CR-LIVE-CASE-01", case01Payload, "smoke-case01-key");
    const case01Decision = await case01Response.json();
    const replayResponse = await postDecision("CR-LIVE-CASE-01", case01Payload, "smoke-case01-key");
    const replay = await replayResponse.json();
    const conflictResponse = await postDecision("CR-LIVE-CASE-01", {
      ...case01Payload,
      reason: "A different human-entered reason for the same key."
    }, "smoke-case01-key");
    const forbiddenResponse = await postDecision("CR-LIVE-CASE-03", case01Payload);
    const case01Audit = await (await localFetch("/api/incidents/CR-LIVE-CASE-01/audit")).json();
    const case03Audit = await (await localFetch("/api/incidents/CR-LIVE-CASE-03/audit")).json();

    const captured = JSON.stringify({ case01Decision, case03Decision, replay, case01Audit, case03Audit });
    const sensitiveContentFound = /sk-SMOKE|RAW_MODEL|RAW_A|PROMPT_SMOKE|PROMPT_R|Authorization/i.test(captured);
    const falseExecutionClaimFound = /Ambulance dispatched|Hospital contacted|Masks delivered|Public notice sent|Rescue completed/i.test(captured);
    summary = {
      analyzeStatus: analyzeResponse.status,
      registeredContextCount: ledger.getContextCount(),
      case01DecisionStatus: case01Response.status,
      case03DecisionStatus: case03Response.status,
      idempotentReplay: replayResponse.status === 200 && replay.replayed === true,
      idempotencyConflictStatus: conflictResponse.status,
      forbiddenDecisionStatus: forbiddenResponse.status,
      case01AuditEntries: case01Audit.entryCount,
      case03AuditEntries: case03Audit.entryCount,
      case01ChainValid: case01Audit.chainValid,
      case03ChainValid: case03Audit.chainValid,
      executionStatus: case01Decision.decision?.executionStatus,
      externalNetworkCount,
      sensitiveContentScan: sensitiveContentFound || falseExecutionClaimFound ? "FAIL" : "PASS",
      fakeAnalyzeCalls,
      gonkaFactoryCalls
    };
    success =
      summary.analyzeStatus === 200 &&
      summary.registeredContextCount === 5 &&
      summary.case01DecisionStatus === 200 &&
      summary.case03DecisionStatus === 200 &&
      summary.idempotentReplay === true &&
      summary.idempotencyConflictStatus === 409 &&
      summary.forbiddenDecisionStatus === 409 &&
      summary.case01AuditEntries === 1 &&
      summary.case03AuditEntries === 1 &&
      summary.case01ChainValid === true &&
      summary.case03ChainValid === true &&
      summary.executionStatus === "NOT_EXECUTED" &&
      summary.externalNetworkCount === 0 &&
      summary.sensitiveContentScan === "PASS" &&
      summary.fakeAnalyzeCalls === 1 &&
      summary.gonkaFactoryCalls === 0;
  } catch (error) {
    summary = { safeError: error?.name || "Error" };
  } finally {
    await closeServer(server);
  }

  const portResidue = await isPortListening();
  success = success && portResidue === false;
  log("B8 Decision Flow Smoke");
  log(`Analyze Status: ${summary.analyzeStatus ?? "Not available"}`);
  log(`Registered Context Count: ${summary.registeredContextCount ?? "Not available"}`);
  log(`Decision Statuses: CASE 01=${summary.case01DecisionStatus ?? "N/A"}, CASE 03=${summary.case03DecisionStatus ?? "N/A"}`);
  log(`Idempotent Replay: ${summary.idempotentReplay === true ? "PASS" : "FAIL"}`);
  log(`Idempotency Conflict: HTTP ${summary.idempotencyConflictStatus ?? "N/A"}`);
  log(`Forbidden Decision Status: HTTP ${summary.forbiddenDecisionStatus ?? "N/A"}`);
  log(`Audit Entry Counts: CASE 01=${summary.case01AuditEntries ?? "N/A"}, CASE 03=${summary.case03AuditEntries ?? "N/A"}`);
  log(`Chain Validity: CASE 01=${summary.case01ChainValid === true ? "PASS" : "FAIL"}, CASE 03=${summary.case03ChainValid === true ? "PASS" : "FAIL"}`);
  log(`Execution Status: ${summary.executionStatus ?? "N/A"}`);
  log(`External Network Count: ${externalNetworkCount}`);
  log(`Sensitive-content Scan: ${summary.sensitiveContentScan ?? "FAIL"}`);
  log(`Port 4173 Residue: ${portResidue ? "FAIL" : "PASS"}`);
  log(`Result: ${success ? "PASS" : "FAIL"}`);
  return success;
}

if (require.main === module) {
  run().then(success => {
    if (!success) process.exitCode = 1;
  });
}

module.exports = { run, fakeScenario };
