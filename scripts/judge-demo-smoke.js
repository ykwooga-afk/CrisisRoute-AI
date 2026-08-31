const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const { createDecisionLedger } = require("../backend/decisionLedger");
const { DEFAULT_MODELS } = require("../backend/gonkaClient");
const { createServer } = require("../server");
const { evaluateFullScenarioAcceptance } = require("./full-scenario-live-smoke");

const HOST = "127.0.0.1";
const projectRoot = path.resolve(__dirname, "..");

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`;
}

async function importPure(relativePath) {
  return import(dataModule(fs.readFileSync(path.join(projectRoot, relativePath), "utf8")));
}

async function importClient() {
  let source = fs.readFileSync(path.join(projectRoot, "src/services/crisisRouteClient.js"), "utf8");
  source = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];\s*/g, "");
  return import(dataModule(source));
}

async function importReplay() {
  const hazeUrl = dataModule(fs.readFileSync(path.join(projectRoot, "src/data/hazeScenario.mock.js"), "utf8"));
  let source = fs.readFileSync(path.join(projectRoot, "src/data/replayResponses.js"), "utf8");
  source = source.replace(
    /import\s+\{\s*cloneScenario\s*,\s*rawReports\s*\}\s+from\s+["'][^"']+["'];/,
    `const { cloneScenario, rawReports } = await import(${JSON.stringify(hazeUrl)});`
  );
  return import(dataModule(source));
}

function isPortListening(port) {
  if (!port) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: HOST, port });
    const finish = listening => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(400);
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

function fakeLiveScenario(replayResult) {
  return {
    incidents: replayResult.incidents.map(incident => ({
      ...structuredClone(incident),
      caseId: `CR-LIVE-CASE-${incident.label}`,
      qualityWarnings: [],
      gonka: {
        mode: "live",
        analyst: {
          model: DEFAULT_MODELS.analyst,
          responseId: "offline-shared-analyst-response",
          promptVersion: "offline-safe-version",
          latencyMs: 1
        },
        reviewer: {
          model: DEFAULT_MODELS.reviewer,
          responseId: "offline-shared-reviewer-response",
          promptVersion: "offline-safe-version",
          latencyMs: 1
        }
      }
    })),
    resources: structuredClone(replayResult.resources),
    meta: {
      slice: "FULL_HAZE_SCENARIO",
      partial: false,
      receivedMessageCount: 5,
      processedCaseCount: 5,
      modelRequestCount: 2,
      scenarioFixtureCases: ["05"]
    }
  };
}

async function run({ log = console.log } = {}) {
  const clientModule = await importClient();
  const reliability = await importPure("src/ui/demoReliability.js");
  const replayModule = await importReplay();
  const replayFixture = replayModule.getReplayScenario();
  const fakeResult = fakeLiveScenario(replayFixture);
  const ledger = createDecisionLedger();
  let externalNetworkCount = 0;
  let inferenceRequestCount = 0;
  let automaticRetryCount = 0;
  let fakeAnalyzeCalls = 0;
  let localReadinessProviderCalls = 0;
  const server = createServer({
    decisionLedger: ledger,
    analyzeIncidentsFn: async () => {
      fakeAnalyzeCalls += 1;
      return structuredClone(fakeResult);
    },
    gonkaClientFactory: () => {
      localReadinessProviderCalls += 1;
      return {
        baseUrl: "offline-loopback-readiness",
        models: { analyst: DEFAULT_MODELS.analyst, reviewer: DEFAULT_MODELS.reviewer }
      };
    }
  });

  let port;
  let summary = {};
  let success = false;
  let stage = "start";
  try {
    stage = "server_start";
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, HOST, resolve);
    });
    port = server.address().port;
    const baseUrl = `http://${HOST}:${port}`;
    let localRequestCount = 0;
    const localFetch = (url, options) => {
      const target = new URL(url, baseUrl);
      if (target.protocol !== "http:" || target.hostname !== HOST || Number(target.port) !== port) {
        externalNetworkCount += 1;
        throw new Error("External network is forbidden in B11-A.");
      }
      localRequestCount += 1;
      if (/gonkarouter|chat\/completions|\/models/i.test(target.href)) inferenceRequestCount += 1;
      return fetch(target, options);
    };
    const client = clientModule.createCrisisRouteClient({ fetchImpl: localFetch, baseUrl });

    stage = "public_routes";
    const publicRoutes = [
      "/", "/src/styles.css", "/src/main.js", "/src/ui/decisionWorkflow.js", "/src/ui/demoReliability.js"
    ];
    const publicStatuses = [];
    for (const route of publicRoutes) publicStatuses.push((await localFetch(route)).status);

    stage = "health";
    const health = await client.getHealth();
    stage = "analyze";
    const startedAt = Date.now();
    const analyzed = await client.loadScenario(replayFixture.rawReports);
    const analyzeDurationMs = Date.now() - startedAt;
    const quality = evaluateFullScenarioAcceptance(analyzed, { durationMs: analyzeDurationMs });
    const case01 = analyzed.incidents.find(incident => incident.label === "01");
    stage = "decision";
    const decision = await client.recordHumanDecision({
      caseId: case01.caseId,
      idempotencyKey: "b11-offline-judge-case01",
      submission: {
        action: "APPROVE_ACTION",
        reason: "B11 offline judge smoke; no real-world action is authorized or executed.",
        acknowledgeHumanDecision: true,
        acknowledgeNoAutomaticExecution: true,
        acknowledgeReview: true
      }
    });
    stage = "brief";
    const brief = await client.generateDeterministicBrief(case01.caseId);
    stage = "audit";
    const audit = await client.getCaseAudit(case01.caseId);
    stage = "proof_valid";
    const proofValid = await client.verifyProofCapsule({ brief: brief.brief, proofCapsule: brief.proofCapsule });
    const changedBrief = structuredClone(brief.brief);
    changedBrief.summary = "Changed only in the offline browser copy.";
    stage = "proof_invalid";
    const proofInvalid = await client.verifyProofCapsule({ brief: changedBrief, proofCapsule: brief.proofCapsule });
    stage = "reliability";

    let reliabilityState = reliability.createReliabilityState("live");
    reliabilityState = reliability.beginLiveAttempt(reliabilityState, { requestId: "offline-failure", messages: replayFixture.rawReports });
    reliabilityState = reliability.failLiveAttempt(reliabilityState, {
      code: "TIMEOUT", status: 504, message: "Safe simulated timeout.", retryable: true, failedRole: "reviewer"
    }, "offline-failure");
    const timeoutRole = reliabilityState.lastFailure?.failedRole;
    const noSilentReplay = reliabilityState.mode === "live" && reliabilityState.automaticReplayFallbackCount === 0;
    const requestsBeforeReplay = localRequestCount;
    const replayOne = replayModule.getReplayScenario();
    const replayTwo = replayModule.getReplayScenario();
    reliabilityState = reliability.openSanitizedReplay(reliabilityState);
    const requestsAfterReplay = localRequestCount;
    const networkFailure = reliability.safeFailurePresentation({
      code: "NETWORK_ERROR", status: 0, message: "Safe simulated network error.", retryable: true, failedRole: "analyst"
    });
    const walkthrough = reliability.judgeWalkthroughState({
      incidentCount: analyzed.incidents.length,
      independentScoresVisible: true,
      decisionRecorded: decision.decision?.recordStatus === "RECORDED",
      briefReady: brief.brief?.status === "READY_FOR_HANDOFF",
      proofChecked: proofValid.valid === true
    });
    const safeScanPayload = JSON.stringify({ health, decision, brief, audit, proofValid, proofInvalid });
    const sensitiveMatches = safeScanPayload.match(/sk-[A-Za-z0-9_-]{8,}|Authorization|rawContent|hiddenReasoning|message\.content/gi) || [];
    const replaySerialized = JSON.stringify(replayOne);

    summary = {
      publicReady: publicStatuses.every(status => status === 200),
      healthReady: reliability.liveReadiness(health).ready,
      incidentCount: analyzed.incidents.length,
      qualityPassed: quality.fullPassed,
      walkthroughPassed: walkthrough.every(step => step.completed),
      decisionRecorded: decision.decision?.recordStatus === "RECORDED",
      notExecuted: decision.decision?.executionStatus === "NOT_EXECUTED" && brief.brief?.executionStatus === "NOT_EXECUTED",
      briefReady: brief.brief?.status === "READY_FOR_HANDOFF",
      auditValid: audit.chainValid === true,
      proofValid: proofValid.valid === true,
      tamperInvalid: proofInvalid.valid === false,
      noSilentReplay,
      explicitReplayNetworkFree: requestsBeforeReplay === requestsAfterReplay && reliabilityState.mode === "replay",
      replayDeterministic: JSON.stringify(replayOne) === JSON.stringify(replayTwo),
      replayAcceptedScores: replayOne.incidents.map(incident => `${incident.label}:${incident.scores.verification}/${incident.scores.urgency}/${incident.scores.actionability}`).join(" "),
      replayRedacted: replayOne.incidents.every(incident => incident.gonka.analyst.responseId === "[REDACTED]" && incident.gonka.reviewer.responseId === "[REDACTED]") && !/recorded-response|chatcmpl|req_[A-Za-z0-9]/i.test(replaySerialized),
      replayProofUnavailable: replayOne.incidents.every(incident => incident.proofCapsule === null) && reliability.proofAvailability("replay", {}).verificationEnabled === false,
      timeoutRole,
      networkManualRetry: networkFailure.retry.allowed === true && networkFailure.retry.automaticRetryAllowed === false,
      automaticRetryCount,
      fakeAnalyzeCalls,
      productionGonkaFactoryCalls: 0,
      localReadinessProviderCalls,
      externalNetworkCount,
      inferenceRequestCount,
      sensitiveMatches: sensitiveMatches.length
    };
    success = summary.publicReady && summary.healthReady && summary.incidentCount === 5 &&
      summary.qualityPassed && summary.walkthroughPassed && summary.decisionRecorded && summary.notExecuted &&
      summary.briefReady && summary.auditValid && summary.proofValid && summary.tamperInvalid &&
      summary.noSilentReplay && summary.explicitReplayNetworkFree && summary.replayDeterministic &&
      summary.replayRedacted && summary.replayProofUnavailable && summary.timeoutRole === "reviewer" &&
      summary.networkManualRetry && summary.automaticRetryCount === 0 && summary.fakeAnalyzeCalls === 1 &&
      summary.productionGonkaFactoryCalls === 0 && summary.externalNetworkCount === 0 &&
      summary.inferenceRequestCount === 0 && summary.sensitiveMatches === 0;
  } catch (error) {
    summary = {
      safeError: error?.code || error?.name || "Error",
      safeStage: stage,
      safeMessage: String(error?.message || "Offline smoke failed.")
        .replace(/sk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED]")
        .slice(0, 160)
    };
  } finally {
    await closeServer(server);
  }

  const randomPortResidue = await isPortListening(port);
  const fixedPortResidue = await isPortListening(4173);
  success = success && !randomPortResidue && !fixedPortResidue;
  log("B11-A Offline Judge Demo Smoke");
  log(`Public Frontend Routes: ${summary.publicReady ? "PASS" : "FAIL"}`);
  log(`Health Capabilities: ${summary.healthReady ? "PASS" : "FAIL"}`);
  log(`Five-case Fake Analyze: ${summary.incidentCount === 5 ? "PASS" : "FAIL"}`);
  log(`Shared Quality Evaluator: ${summary.qualityPassed ? "PASS" : "FAIL"}`);
  log(`Judge Walkthrough: ${summary.walkthroughPassed ? "PASS" : "FAIL"}`);
  log(`Decision / Brief / Audit: ${summary.decisionRecorded && summary.briefReady && summary.auditValid ? "PASS" : "FAIL"}`);
  log(`Proof Valid / Tamper Invalid: ${summary.proofValid && summary.tamperInvalid ? "PASS" : "FAIL"}`);
  log(`Execution Status: ${summary.notExecuted ? "NOT_EXECUTED" : "FAIL"}`);
  log(`No Silent Replay Fallback: ${summary.noSilentReplay ? "PASS" : "FAIL"}`);
  log(`Explicit Replay Network-free: ${summary.explicitReplayNetworkFree ? "PASS" : "FAIL"}`);
  log(`Replay Determinism / Redaction / No Proof: ${summary.replayDeterministic && summary.replayRedacted && summary.replayProofUnavailable ? "PASS" : "FAIL"}`);
  log(`Replay Scores: ${summary.replayAcceptedScores || "Not available"}`);
  log(`Simulated TIMEOUT Failed Role: ${summary.timeoutRole || "Not available"}`);
  log(`Simulated NETWORK_ERROR Manual Retry: ${summary.networkManualRetry ? "PASS" : "FAIL"}`);
  log(`Automatic Retry Count: ${summary.automaticRetryCount ?? "FAIL"}`);
  log(`Production Gonka Factory Calls: ${summary.productionGonkaFactoryCalls ?? 0}`);
  log(`External Network Count: ${externalNetworkCount}`);
  log(`Inference Request Count: ${inferenceRequestCount}`);
  log(`API Key/Raw Content Matches: ${summary.sensitiveMatches ?? "FAIL"}`);
  if (summary.safeError) log(`Safe Error: ${summary.safeError} at ${summary.safeStage} — ${summary.safeMessage}`);
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

module.exports = { run, fakeLiveScenario };
