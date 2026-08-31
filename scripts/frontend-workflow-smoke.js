const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { createDecisionLedger } = require("../backend/decisionLedger");
const { createServer } = require("../server");
const { fakeScenario } = require("./decision-flow-smoke");

const HOST = "127.0.0.1";
const projectRoot = path.resolve(__dirname, "..");

async function importSource(relativePath, { stripImports = false } = {}) {
  let source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  if (stripImports) source = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];\s*/g, "");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`);
}

function isPortListening(port) {
  if (!port) return Promise.resolve(false);
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
  const { createCrisisRouteClient } = await importSource("src/services/crisisRouteClient.js", { stripImports: true });
  const workflow = await importSource("src/ui/decisionWorkflow.js");
  let externalNetworkCount = 0;
  let inferenceRequestCount = 0;
  let fakeAnalyzeCalls = 0;
  let localReadinessFactoryCalls = 0;
  const ledger = createDecisionLedger();
  const server = createServer({
    decisionLedger: ledger,
    analyzeIncidentsFn: async () => {
      fakeAnalyzeCalls += 1;
      return fakeScenario();
    },
    // This local configuration object is used only by GET /api/health/gonka.
    // The production Gonka factory is never installed or invoked by this smoke.
    gonkaClientFactory: () => {
      localReadinessFactoryCalls += 1;
      return {
        baseUrl: "offline-loopback-readiness",
        models: { analyst: "offline-fake-analyst", reviewer: "offline-fake-reviewer" }
      };
    }
  });

  let port;
  let summary = {};
  let success = false;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, HOST, resolve);
    });
    port = server.address().port;
    const baseUrl = `http://${HOST}:${port}`;
    const localFetch = (url, options) => {
      const target = new URL(url, baseUrl);
      if (target.protocol !== "http:" || ![HOST, "localhost"].includes(target.hostname) || Number(target.port) !== port) {
        externalNetworkCount += 1;
        throw new Error("External network is forbidden in the frontend smoke.");
      }
      if (/gonkarouter|chat\/completions|\/models/i.test(target.href)) inferenceRequestCount += 1;
      return fetch(target, options);
    };
    const client = createCrisisRouteClient({ fetchImpl: localFetch, baseUrl });

    const health = await client.getHealth();
    const readiness = workflow.liveReadiness(health);
    const analyzed = await client.loadScenario(["offline five-case frontend workflow fixture"]);
    const case01 = analyzed.incidents.find(item => item.label === "01");
    const case03 = analyzed.incidents.find(item => item.label === "03");

    const case01Submission = {
      action: "APPROVE_ACTION",
      reason: "Human reviewed the gates and approved this bounded handoff.",
      acknowledgeHumanDecision: true,
      acknowledgeNoAutomaticExecution: true,
      acknowledgeReview: false
    };
    const decisionKey = "frontend-smoke-case01-stable-key";
    const case01Decision = await client.recordHumanDecision({ caseId: case01.caseId, submission: case01Submission, idempotencyKey: decisionKey });
    const replay = await client.recordHumanDecision({ caseId: case01.caseId, submission: case01Submission, idempotencyKey: decisionKey });
    const briefResult = await client.generateDeterministicBrief(case01.caseId);
    const audit = await client.getCaseAudit(case01.caseId);
    const validProof = await client.verifyProofCapsule({ brief: briefResult.brief, proofCapsule: briefResult.proofCapsule });
    const changedBrief = structuredClone(briefResult.brief);
    changedBrief.summary = "Locally changed smoke payload";
    const invalidProof = await client.verifyProofCapsule({ brief: changedBrief, proofCapsule: briefResult.proofCapsule });

    let case03ApproveStatus = 0;
    let case03ApproveCode = "";
    try {
      await client.recordHumanDecision({ caseId: case03.caseId, submission: case01Submission, idempotencyKey: "frontend-smoke-case03-forbidden" });
    } catch (error) {
      case03ApproveStatus = error.status;
      case03ApproveCode = error.code;
    }
    const case03Decision = await client.recordHumanDecision({
      caseId: case03.caseId,
      idempotencyKey: "frontend-smoke-case03-verification",
      submission: {
        action: "REQUEST_VERIFICATION",
        reason: "Human requested urgent location and contact verification.",
        acknowledgeHumanDecision: false,
        acknowledgeNoAutomaticExecution: false,
        acknowledgeReview: false
      }
    });

    const demoProofRules = ["mock", "replay"].map(mode => {
      let state = workflow.createWorkflowState(case01, mode);
      state = { ...state, brief: { briefId: "DEMO" }, proofCapsule: { capsuleId: "DEMO" } };
      state = workflow.applyProofVerification(state, { valid: true });
      return workflow.displayRules(state);
    });
    const safeOutputs = JSON.stringify({
      health,
      case01Decision,
      replay,
      briefResult,
      audit,
      validProof,
      invalidProof,
      case03Decision
    });
    const secretMatches = safeOutputs.match(/sk-[A-Za-z0-9_-]{8,}|Authorization|RAW_MODEL|RAW_A|PROMPT_SMOKE|PROMPT_R|message\.content/gi) || [];

    summary = {
      healthReady: readiness.ready,
      fiveCases: analyzed.incidents.length === 5,
      decisionRecorded: case01Decision.decision?.recordStatus === "RECORDED",
      notExecuted: case01Decision.decision?.executionStatus === "NOT_EXECUTED" && briefResult.brief?.executionStatus === "NOT_EXECUTED",
      briefReady: briefResult.brief?.status === "READY_FOR_HANDOFF",
      auditValid: audit.chainValid === true,
      auditEntryCount: audit.entryCount,
      proofValid: validProof.valid === true,
      tamperInvalid: invalidProof.valid === false,
      replayStable: replay.replayed === true && audit.entryCount === 1,
      case03ApproveStatus,
      case03ApproveCode,
      case03Verification: case03Decision.decision?.action === "REQUEST_VERIFICATION",
      demoProofUnavailable: demoProofRules.every(rule => rule.proofVerificationEnabled === false && rule.proofStatus === "UNAVAILABLE"),
      fakeAnalyzeCalls,
      productionGonkaFactoryCalls: 0,
      localReadinessFactoryCalls,
      secretMatches: secretMatches.length
    };
    success =
      summary.healthReady && summary.fiveCases && summary.decisionRecorded && summary.notExecuted &&
      summary.briefReady && summary.auditValid && summary.auditEntryCount === 1 && summary.proofValid &&
      summary.tamperInvalid && summary.replayStable && summary.case03ApproveStatus === 409 &&
      summary.case03ApproveCode === "DECISION_NOT_ALLOWED" &&
      summary.case03Verification && summary.demoProofUnavailable && summary.fakeAnalyzeCalls === 1 &&
      summary.productionGonkaFactoryCalls === 0 && externalNetworkCount === 0 &&
      inferenceRequestCount === 0 && summary.secretMatches === 0;
  } catch (error) {
    summary = { safeError: error?.name || "Error" };
  } finally {
    await closeServer(server);
  }

  const randomPortResidue = await isPortListening(port);
  const fixedPortResidue = await isPortListening(4173);
  success = success && !randomPortResidue && !fixedPortResidue;
  log("B10 Frontend Workflow Smoke");
  log(`Health Analyze/Decision/Brief Ready: ${summary.healthReady ? "PASS" : "FAIL"}`);
  log(`Five-case Fake Analyze: ${summary.fiveCases ? "PASS" : "FAIL"}`);
  log(`CASE 01 Decision: ${summary.decisionRecorded ? "RECORDED" : "FAIL"}`);
  log(`Execution: ${summary.notExecuted ? "NOT_EXECUTED" : "FAIL"}`);
  log(`Brief: ${summary.briefReady ? "READY" : "FAIL"}`);
  log(`Audit Chain: ${summary.auditValid ? `VALID (${summary.auditEntryCount} entry)` : "FAIL"}`);
  log(`Proof Valid / Tamper Invalid: ${summary.proofValid && summary.tamperInvalid ? "PASS" : "FAIL"}`);
  log(`Idempotent Replay: ${summary.replayStable ? "PASS" : "FAIL"}`);
  log(`CASE 03 Approval: HTTP ${summary.case03ApproveStatus ?? "N/A"} ${summary.case03ApproveCode ?? ""}`.trim());
  log(`CASE 03 Verification: ${summary.case03Verification ? "PASS" : "FAIL"}`);
  log(`Mock/Replay Proof Safety: ${summary.demoProofUnavailable ? "PASS" : "FAIL"}`);
  log(`Production Gonka Factory Calls: ${summary.productionGonkaFactoryCalls ?? 0}`);
  log(`Local Readiness Factory Calls: ${summary.localReadinessFactoryCalls ?? 0}`);
  log(`External Network Count: ${externalNetworkCount}`);
  log(`Inference Request Count: ${inferenceRequestCount}`);
  log(`API Key/Raw Content Matches: ${summary.secretMatches ?? "FAIL"}`);
  log(`Random Port Residue: ${randomPortResidue ? "FAIL" : "PASS"}`);
  log(`Port 4173 Residue: ${fixedPortResidue ? "FAIL" : "PASS"}`);
  log(`Result: ${success ? "PASS" : "FAIL"}`);
  return success;
}

if (require.main === module) {
  run().then(success => {
    if (!success) process.exitCode = 1;
  });
}

module.exports = { run };
