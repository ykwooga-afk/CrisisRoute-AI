const net = require("node:net");

const { createDecisionLedger } = require("../backend/decisionLedger");
const { createServer } = require("../server");
const { fakeScenario } = require("./decision-flow-smoke");

const HOST = "127.0.0.1";
const PORT = 4173;

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
    log("B9 Brief/Proof Smoke: BLOCKED — port 4173 is already in use");
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
      throw new Error("Gonka must not be initialized by the offline Brief smoke");
    }
  });
  const baseUrl = `http://${HOST}:${PORT}`;
  const localFetch = (pathname, options) => {
    const url = new URL(pathname, baseUrl);
    if (url.hostname !== HOST && url.hostname !== "localhost") externalNetworkCount += 1;
    return fetch(url, options);
  };

  let summary = {};
  let success = false;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, HOST, resolve);
    });
    const analyzeResponse = await localFetch("/api/incidents/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: ["offline brief smoke fixture"] })
    });
    await analyzeResponse.json();

    const decisionResponse = await localFetch("/api/incidents/CR-LIVE-CASE-03/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "brief-smoke-case03-decision"
      },
      body: JSON.stringify({
        action: "REQUEST_VERIFICATION",
        reason: "Human requested urgent verification.",
        acknowledgeHumanDecision: true,
        acknowledgeNoAutomaticExecution: true
      })
    });
    await decisionResponse.json();

    const briefResponse = await localFetch("/api/incidents/CR-LIVE-CASE-03/brief", { method: "POST" });
    const briefResult = await briefResponse.json();
    const replayResponse = await localFetch("/api/incidents/CR-LIVE-CASE-03/brief", { method: "POST" });
    const replay = await replayResponse.json();

    const verify = payload => localFetch("/api/proof/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const validProofResponse = await verify({
      brief: briefResult.brief,
      proofCapsule: briefResult.proofCapsule
    });
    const validProof = await validProofResponse.json();

    const changedBrief = structuredClone(briefResult.brief);
    changedBrief.summary = "Tampered local summary";
    const tamperedBrief = await (await verify({
      brief: changedBrief,
      proofCapsule: briefResult.proofCapsule
    })).json();

    const changedReference = structuredClone(briefResult.proofCapsule);
    changedReference.decisionEntryHash = "a".repeat(64);
    const tamperedReference = await (await verify({
      brief: briefResult.brief,
      proofCapsule: changedReference
    })).json();

    const decisionRequiredResponse = await localFetch("/api/incidents/CR-LIVE-CASE-02/brief", { method: "POST" });
    const decisionRequired = await decisionRequiredResponse.json();
    const captured = JSON.stringify({ briefResult, replay, validProof, tamperedBrief, tamperedReference, decisionRequired });
    const sensitiveFound = /sk-SMOKE|RAW_MODEL|RAW_A|PROMPT_SMOKE|PROMPT_R|Authorization/i.test(captured);
    const falseExecutionFound = /Ambulance dispatched|Hospital contacted|Masks delivered|Public notice sent|Rescue completed/i.test(captured);

    summary = {
      analyzeStatus: analyzeResponse.status,
      decisionStatus: decisionResponse.status,
      briefStatus: briefResponse.status,
      briefId: briefResult.brief?.briefId,
      priority: briefResult.brief?.priority,
      executionStatus: briefResult.brief?.executionStatus,
      replay: replayResponse.status === 200 && replay.replayed === true && replay.brief?.briefId === briefResult.brief?.briefId,
      capsuleId: briefResult.proofCapsule?.capsuleId,
      briefHashCheck: validProof.checks?.briefHash === true,
      capsuleHashCheck: validProof.checks?.capsuleHash === true,
      validProof: validProof.valid === true,
      tamperedBriefResult: tamperedBrief.valid,
      tamperedReferenceResult: tamperedReference.valid,
      decisionRequiredStatus: decisionRequiredResponse.status,
      decisionRequiredCode: decisionRequired.error?.code,
      sensitiveScan: sensitiveFound || falseExecutionFound ? "FAIL" : "PASS"
    };
    success =
      summary.analyzeStatus === 200 &&
      summary.decisionStatus === 200 &&
      summary.briefStatus === 200 &&
      /^BR-[A-F0-9]{16}$/.test(summary.briefId) &&
      ["HIGH", "CRITICAL"].includes(summary.priority) &&
      summary.executionStatus === "NOT_EXECUTED" &&
      summary.replay === true &&
      /^PC-[A-F0-9]{16}$/.test(summary.capsuleId) &&
      summary.briefHashCheck === true &&
      summary.capsuleHashCheck === true &&
      summary.validProof === true &&
      summary.tamperedBriefResult === false &&
      summary.tamperedReferenceResult === false &&
      summary.decisionRequiredStatus === 409 &&
      summary.decisionRequiredCode === "DECISION_REQUIRED" &&
      summary.sensitiveScan === "PASS" &&
      externalNetworkCount === 0 &&
      fakeAnalyzeCalls === 1 &&
      gonkaFactoryCalls === 0;
  } catch (error) {
    summary = { safeError: error?.name || "Error" };
  } finally {
    await closeServer(server);
  }

  const portResidue = await isPortListening();
  success = success && portResidue === false;
  log("B9 Brief/Proof Smoke");
  log(`Analyze Status: ${summary.analyzeStatus ?? "N/A"}`);
  log(`Decision Status: ${summary.decisionStatus ?? "N/A"}`);
  log(`Brief Status: ${summary.briefStatus ?? "N/A"}`);
  log(`Brief ID: ${summary.briefId ?? "N/A"}`);
  log(`Priority: ${summary.priority ?? "N/A"}`);
  log(`Execution Status: ${summary.executionStatus ?? "N/A"}`);
  log(`Replay: ${summary.replay === true ? "PASS" : "FAIL"}`);
  log(`Capsule ID: ${summary.capsuleId ?? "N/A"}`);
  log(`Brief Hash Check: ${summary.briefHashCheck === true ? "PASS" : "FAIL"}`);
  log(`Capsule Hash Check: ${summary.capsuleHashCheck === true ? "PASS" : "FAIL"}`);
  log(`Valid Proof: ${summary.validProof === true ? "PASS" : "FAIL"}`);
  log(`Tampered Brief Result: ${summary.tamperedBriefResult === false ? "PASS" : "FAIL"}`);
  log(`Tampered Reference Result: ${summary.tamperedReferenceResult === false ? "PASS" : "FAIL"}`);
  log(`Decision-required Result: HTTP ${summary.decisionRequiredStatus ?? "N/A"} ${summary.decisionRequiredCode ?? ""}`.trim());
  log(`External Network Count: ${externalNetworkCount}`);
  log(`Sensitive Scan: ${summary.sensitiveScan ?? "FAIL"}`);
  log(`Port 4173 Residue: ${portResidue ? "FAIL" : "PASS"}`);
  log(`Result: ${success ? "PASS" : "FAIL"}`);
  return success;
}

if (require.main === module) {
  run().then(success => {
    if (!success) process.exitCode = 1;
  });
}

module.exports = { run };
