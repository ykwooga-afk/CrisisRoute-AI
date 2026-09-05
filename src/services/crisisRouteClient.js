import { cloneScenario, rawReports } from "../data/hazeScenario.mock.js";
import { getReplayScenario } from "../data/replayResponses.js";

export const DATA_MODES = {
  mock: "mock",
  live: "live",
  replay: "replay"
};

export class CrisisRouteClientError extends Error {
  constructor({ status = 0, code = "CLIENT_ERROR", message = "The request could not be completed.", retryable = false, failedRole, roleErrors } = {}) {
    super(message);
    this.name = "CrisisRouteClientError";
    this.status = status;
    this.code = code;
    this.retryable = retryable === true;
    if (["analyst", "reviewer", "both", "not_available"].includes(failedRole)) this.failedRole = failedRole;
    if (roleErrors && typeof roleErrors === "object" && !Array.isArray(roleErrors)) {
      const safeRoleErrors = {};
      for (const role of ["analyst", "reviewer"]) {
        if (typeof roleErrors[role] === "string" && roleErrors[role].length <= 80) safeRoleErrors[role] = roleErrors[role];
      }
      if (Object.keys(safeRoleErrors).length) this.roleErrors = safeRoleErrors;
    }
  }
}

function joinUrl(baseUrl, path) {
  return baseUrl ? `${String(baseUrl).replace(/\/$/, "")}${path}` : path;
}

function safeClientError(status, body, fallbackMessage) {
  const source = body?.error && typeof body.error === "object" ? body.error : {};
  return new CrisisRouteClientError({
    status,
    code: typeof source.code === "string" ? source.code.slice(0, 80) : "HTTP_ERROR",
    message: typeof source.message === "string" ? source.message.slice(0, 300) : fallbackMessage,
    retryable: source.retryable === true,
    failedRole: source.failedRole,
    roleErrors: source.roleErrors
  });
}

export function createCrisisRouteClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  baseUrl = ""
} = {}) {
  async function requestJson(path, { method = "GET", body, headers = {}, signal } = {}) {
    let response;
    try {
      response = await fetchImpl(joinUrl(baseUrl, path), {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers
        },
        ...(signal ? { signal } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      if (signal?.aborted) {
        throw new CrisisRouteClientError({
          code: "CLIENT_WAIT_CANCELLED",
          message: "This browser stopped waiting for the local request; server or remote computation cancellation is not confirmed.",
          retryable: true
        });
      }
      throw new CrisisRouteClientError({ code: "NETWORK_ERROR", message: "The local CrisisRoute service is unavailable.", retryable: true });
    }
    let payload;
    try {
      const text = await response.text();
      if (text.length > 200_000) throw new Error("oversized");
      payload = JSON.parse(text);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid shape");
    } catch {
      throw new CrisisRouteClientError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "The local service returned an invalid response."
      });
    }
    if (!response.ok) throw safeClientError(response.status, payload, "The local request was not accepted.");
    return payload;
  }

  return Object.freeze({
    loadScenario: (messages, { signal } = {}) => requestJson("/api/incidents/analyze", {
      method: "POST",
      body: { scenario: "malaysia_haze_fire_smoke", messages },
      signal
    }),
    analyzeIncidents: (messages, { signal } = {}) => requestJson("/api/incidents/analyze", {
      method: "POST",
      body: { messages },
      signal
    }),
    analyzePublicUrl: (url, { signal } = {}) => requestJson("/api/public-source/analyze", {
      method: "POST",
      body: { url },
      signal
    }),
    recordHumanDecision: ({ caseId, submission, idempotencyKey }) => requestJson(
      `/api/incidents/${encodeURIComponent(caseId)}/decision`,
      {
        method: "POST",
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
        body: {
          action: submission.action,
          reason: submission.reason,
          acknowledgeHumanDecision: submission.acknowledgeHumanDecision === true,
          acknowledgeNoAutomaticExecution: submission.acknowledgeNoAutomaticExecution === true,
          acknowledgeReview: submission.acknowledgeReview === true
        }
      }
    ),
    getCaseAudit: caseId => requestJson(`/api/incidents/${encodeURIComponent(caseId)}/audit`),
    generateDeterministicBrief: caseId => requestJson(`/api/incidents/${encodeURIComponent(caseId)}/brief`, { method: "POST" }),
    verifyProofCapsule: ({ brief, proofCapsule }) => requestJson("/api/proof/verify", {
      method: "POST",
      body: { brief, proofCapsule }
    }),
    getHealth: () => requestJson("/api/health/gonka")
  });
}

const browserClient = createCrisisRouteClient();

export async function loadHazeScenario(mode = DATA_MODES.mock, { signal } = {}) {
  await wait(320);
  if (mode === DATA_MODES.replay) return getReplayScenario();
  if (mode === DATA_MODES.live) return browserClient.loadScenario(rawReports, { signal });
  return cloneScenario();
}

export async function analyzeIncidents(messages, mode = DATA_MODES.mock, { signal } = {}) {
  if (mode === DATA_MODES.live) return browserClient.analyzeIncidents(messages, { signal });
  const scenario = mode === DATA_MODES.replay ? getReplayScenario() : cloneScenario();
  return {
    ...scenario,
    incidents: messages.length
      ? messages.map((message, index) => makeDraftIncident(message, index, mode))
      : scenario.incidents
  };
}

export async function analyzePublicUrl(url, mode = DATA_MODES.mock, { signal } = {}) {
  if (mode === DATA_MODES.live) return browserClient.analyzePublicUrl(url, { signal });
  if (mode === DATA_MODES.replay) return getReplayScenario();
  const scenario = cloneScenario();
  return {
    ...scenario,
    rawReports: [url],
    meta: {
      ...(scenario.meta || {}),
      mode: DATA_MODES.mock,
      publicSource: {
        originalUrl: url,
        finalUrl: url,
        extraction: "demo_placeholder"
      }
    },
    incidents: [makeDraftUrlIncident(url, mode)]
  };
}

export async function submitHumanDecision(incident, submission, mode = DATA_MODES.mock, idempotencyKey) {
  if (mode === DATA_MODES.live) {
    return browserClient.recordHumanDecision({ caseId: incident.caseId, submission, idempotencyKey });
  }
  const recordedAt = new Date().toISOString();
  return {
    ok: true,
    replayed: false,
    demoOnly: true,
    decision: {
      decisionId: `DEMO-${simpleHash(`${incident.caseId}:${recordedAt}`)}`,
      caseId: incident.caseId,
      action: submission.action,
      reason: submission.reason,
      actorType: "demo_operator",
      authentication: "demo_only",
      recordedAt,
      aiRecommendation: incident.operationalState,
      override: false,
      recordStatus: "RECORDED",
      executionStatus: "NOT_EXECUTED",
      requiresExternalExecution: ["APPROVE_ACTION", "REQUEST_VERIFICATION", "MERGE_REPORT", "QUEUE_ACTION"].includes(submission.action)
    }
  };
}

export async function generateActionBrief(incident, decision, mode = DATA_MODES.mock) {
  if (mode === DATA_MODES.live) return browserClient.generateDeterministicBrief(incident.caseId);
  await wait(120);
  const priority = incident.scores.urgency >= 80 ? "CRITICAL" : incident.scores.urgency >= 60 ? "HIGH" : "MEDIUM";
  return {
    ok: true,
    replayed: false,
    demoOnly: true,
    brief: {
      briefVersion: "DEMO_ONLY",
      briefId: `DEMO-${incident.caseId}`,
      caseId: incident.caseId,
      status: "DEMO_ONLY",
      title: "Demo-only decision handoff",
      decisionAction: decision.action,
      priority,
      summary: "DEMO ONLY — this local snapshot is not a server-issued operational brief.",
      nextSteps: [...(incident.safeNextActions || [])],
      safetyConstraints: ["No real-world action is executed by this demo."],
      recordStatus: "RECORDED",
      executionStatus: "NOT_EXECUTED"
    },
    proofCapsule: null
  };
}

export async function getCaseAudit(caseId, mode = DATA_MODES.mock, decision) {
  if (mode === DATA_MODES.live) return browserClient.getCaseAudit(caseId);
  return {
    ok: true,
    demoOnly: true,
    caseId,
    entryCount: decision ? 1 : 0,
    entries: decision ? [{
      sequence: 1,
      action: decision.action,
      recordedAt: decision.recordedAt,
      previousHash: null,
      entryHash: "DEMO_ONLY_NOT_SERVER_ISSUED"
    }] : [],
    chainValid: null,
    persistence: "demo_only",
    externalAnchoring: "none"
  };
}

export const verifyProofCapsule = payload => browserClient.verifyProofCapsule(payload);

export async function getGonkaHealth() {
  try {
    return await browserClient.getHealth();
  } catch (error) {
    return { ok: false, liveRoutesReady: false, message: error.message };
  }
}

function makeDraftIncident(message, index, mode) {
  const id = `draft_${index + 1}`;
  const tracePrefix = mode === DATA_MODES.replay ? "recorded" : "demo";
  const lower = message.toLowerCase();
  const hasBreathingRisk = /asthma|breath|cough|smoke|respir/i.test(message);
  const hasLocation = /block|hostel|shah alam|campus|room|hall/i.test(message);
  const urgency = hasBreathingRisk ? 86 : 58;
  const actionability = hasLocation ? 64 : 28;
  const verification = message.length > 80 ? 62 : 48;

  return {
    caseId: id,
    label: String.fromCharCode(65 + index),
    title: `Custom report ${index + 1}`,
    rawMessage: message,
    source: "Source Report - User Submitted",
    receivedAt: new Date().toISOString(),
    location: hasLocation ? extractLocationHint(message) : "Unknown location",
    peopleCount: lower.match(/\b\d+\b/) ? Number(lower.match(/\b\d+\b/)[0]) : null,
    needs: inferNeeds(message),
    riskFlags: hasBreathingRisk ? ["possible respiratory risk"] : ["needs classification"],
    claims: [
      {
        id: `${id}_claim_1`,
        text: message,
        status: "unverified",
        evidenceIds: [`${id}_E1`]
      }
    ],
    evidence: [
      {
        id: `${id}_E1`,
        type: "Source Report - User Submitted",
        summary: "Raw text provided by coordinator for analysis.",
        retrievedAt: new Date().toISOString(),
        reliability: "PRIMARY SOURCE - UNVERIFIED. User-submitted report; not independently verified by AI."
      }
    ],
    scores: { verification, urgency, actionability },
    operationalState: actionability < 40 ? "URGENT_VERIFICATION" : urgency > 80 ? "NEEDS_HUMAN_REVIEW" : "QUEUED_ACTION",
    missingFields: actionability < 40 ? ["exact location", "callback contact"] : ["independent evidence"],
    modelDebate: {
      agreement: ["Manual input needs structured verification"],
      disagreement: ["Mock mode cannot prove independent corroboration"],
      counterEvidence: ["No live Gonka backend connected yet"],
      consensus: mode === DATA_MODES.replay ? "Replay response should be replaced by live Gonka before final pitch." : "Mock draft generated for UI testing."
    },
    safetyGates: [
      {
        id: "G_LOCATION",
        label: "Exact location present",
        passed: hasLocation,
        detail: hasLocation ? "Location hint found." : "Location missing; dispatch blocked."
      },
      {
        id: "G_CONTACT",
        label: "Contact path available",
        passed: false,
        detail: "Manual input does not include verified callback contact."
      }
    ],
    recommendedAction: hasBreathingRisk
      ? "Confirm location/contact immediately and prepare respiratory support resources."
      : "Ask for missing details and queue for coordinator review.",
    actionBrief: null,
    proofCapsule: null,
    gonka: {
      mode,
      analyst: {
        model: `${tracePrefix}-analyst-model`,
        responseId: `${tracePrefix}-response-${id}-analyst`,
        promptVersion: "analyst-v1",
        latencyMs: 0
      },
      reviewer: {
        model: `${tracePrefix}-reviewer-model`,
        responseId: `${tracePrefix}-response-${id}-reviewer`,
        promptVersion: "reviewer-v1",
        latencyMs: 0
      }
    },
    humanDecision: null
  };
}

function makeDraftUrlIncident(url, mode) {
  const incident = makeDraftIncident(`Public source URL submitted for analysis: ${url}`, 0, mode);
  incident.caseId = "draft_url_1";
  incident.label = "A";
  incident.title = "Public URL report 1";
  incident.source = "Public URL demo";
  incident.location = "Location pending extraction";
  incident.scores = { verification: 44, urgency: 58, actionability: 30 };
  incident.operationalState = "QUEUED_ACTION";
  incident.missingFields = ["live page extraction", "independent evidence", "coordinator review"];
  incident.riskFlags = ["public URL demo placeholder"];
  incident.recommendedAction = "Switch to Live to extract the public page through the server-side safe URL pipeline.";
  if (incident.evidence?.[0]) {
    incident.evidence[0].type = "Public Source - Retrieved";
    incident.evidence[0].reliability = "PRIMARY SOURCE - UNVERIFIED. Retrieved source; not independently verified by AI.";
  }
  incident.gonka.analyst.responseId = "demo-response-public-url-analyst-001";
  incident.gonka.reviewer.responseId = "demo-response-public-url-reviewer-001";
  return incident;
}

function inferNeeds(message) {
  const needs = [];
  if (/mask|n95/i.test(message)) needs.push("N95 masks");
  if (/water/i.test(message)) needs.push("water");
  if (/clinic|transport|hospital/i.test(message)) needs.push("clinic transport");
  if (/room|shelter|indoor/i.test(message)) needs.push("indoor safe room");
  return needs.length ? needs : ["verification call"];
}

function extractLocationHint(message) {
  const match = message.match(/(Block\s+[A-Z]|Hostel\s+[A-Z]|Shah Alam|campus field|room\s+\w+)/i);
  return match ? match[0] : "Location mentioned, needs cleanup";
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function simpleHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
