import { cloneScenario, rawReports } from "../data/hazeScenario.mock.js";
import { getReplayScenario } from "../data/replayResponses.js";

export const DATA_MODES = {
  mock: "mock",
  live: "live",
  replay: "replay"
};

export async function loadHazeScenario(mode = DATA_MODES.mock) {
  await wait(320);

  if (mode === DATA_MODES.replay) {
    return getReplayScenario();
  }

  if (mode === DATA_MODES.live) {
    const response = await fetch("/api/incidents/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenario: "malaysia_haze_fire_smoke",
        messages: rawReports
      })
    });

    if (!response.ok) {
      const error = await safeJson(response);
      throw new Error(error?.message || "Live Gonka backend is not ready yet.");
    }

    return response.json();
  }

  return cloneScenario();
}

export async function analyzeIncidents(messages, mode = DATA_MODES.mock) {
  if (mode === DATA_MODES.live) {
    const response = await fetch("/api/incidents/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    });

    if (!response.ok) {
      const error = await safeJson(response);
      throw new Error(error?.message || "Live Gonka analysis failed.");
    }

    return response.json();
  }

  const scenario = mode === DATA_MODES.replay ? getReplayScenario() : cloneScenario();
  return {
    ...scenario,
    incidents: messages.length
      ? messages.map((message, index) => makeDraftIncident(message, index, mode))
      : scenario.incidents
  };
}

export async function submitHumanDecision(incident, decision, mode = DATA_MODES.mock) {
  const decidedAt = new Date().toISOString();

  if (mode === DATA_MODES.live) {
    const action = normalizeLiveDecision(decision, incident.operationalState);
    const reason = liveDecisionReason(decision);
    const acknowledgeReview = incident.safetyGates?.some(
      gate => gate.id === "G_CONFLICT" && gate.status === "review"
    ) === true;
    const response = await fetch(`/api/incidents/${incident.caseId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        reason,
        acknowledgeHumanDecision: true,
        acknowledgeNoAutomaticExecution: true,
        acknowledgeReview
      })
    });

    if (!response.ok) {
      const error = await safeJson(response);
      throw new Error(error?.error?.message || error?.message || "Decision API failed.");
    }

    const result = await response.json();
    let briefResult = null;
    if (result.decision.action === "APPROVE_ACTION") {
      const briefResponse = await fetch(`/api/incidents/${incident.caseId}/brief`, { method: "POST" });
      if (!briefResponse.ok) {
        const error = await safeJson(briefResponse);
        throw new Error(error?.error?.message || error?.message || "Brief generation failed.");
      }
      briefResult = await briefResponse.json();
    }
    return {
      ...incident,
      actionBrief: briefResult
        ? { en: [briefResult.brief.summary, ...briefResult.brief.nextSteps].join(" ") }
        : incident.actionBrief,
      operationalBrief: briefResult?.brief || incident.operationalBrief,
      proofCapsule: briefResult?.proofCapsule || incident.proofCapsule,
      humanDecision: {
        decision,
        canonicalAction: result.decision.action,
        decidedAt: result.decision.recordedAt,
        decidedBy: "Local human operator",
        recordStatus: result.decision.recordStatus,
        executionStatus: result.decision.executionStatus,
        requiresExternalExecution: result.decision.requiresExternalExecution
      },
      decisionAudit: result.audit
    };
  }

  const receiptPayload = {
    caseId: incident.caseId,
    evidenceHashes: incident.evidence.map(item => `sha256:${simpleHash(item.id + item.summary)}`),
    gonkaResponseIds: [incident.gonka.analyst.responseId, incident.gonka.reviewer.responseId],
    promptVersions: [incident.gonka.analyst.promptVersion, incident.gonka.reviewer.promptVersion],
    decision,
    approvedByRole: "Coordinator Aisha Rahman",
    timestamp: decidedAt
  };

  return {
    ...incident,
    humanDecision: {
      decision,
      decidedAt,
      decidedBy: "Coordinator Aisha Rahman"
    },
    proofCapsule: {
      ...receiptPayload,
      receiptHash: `sha256:${simpleHash(JSON.stringify(receiptPayload))}`
    }
  };
}

export async function generateActionBrief(incident, mode = DATA_MODES.mock) {
  if (mode === DATA_MODES.live) {
    return incident.actionBrief;
  }

  await wait(240);
  return incident.actionBrief || incident.actionPlan?.languages || {
    en: incident.recommendedAction,
    zh: "请先补充缺失资料，再安排志愿者行动。",
    ms: "Sila lengkapkan maklumat yang hilang sebelum tindakan sukarelawan."
  };
}

function normalizeLiveDecision(decision, operationalState) {
  const aliases = {
    APPROVED: "APPROVE_ACTION",
    URGENT_VERIFICATION: "REQUEST_VERIFICATION",
    NEEDS_MORE_INFO: "REQUEST_VERIFICATION"
  };
  if (decision === "MERGE_OR_REJECT") {
    return operationalState === "MERGE_OR_VERIFY" ? "MERGE_REPORT" : "REJECT_ACTION";
  }
  return aliases[decision] || decision;
}

function liveDecisionReason(decision) {
  const reasons = {
    APPROVED: "Human selected Approve Dispatch in the local demo UI.",
    URGENT_VERIFICATION: "Human selected Urgent Verify in the local demo UI.",
    NEEDS_MORE_INFO: "Human requested more information in the local demo UI.",
    MERGE_OR_REJECT: "Human selected Merge or Reject in the local demo UI."
  };
  return reasons[decision] || "Human selected this decision in the local demo UI.";
}

export async function getGonkaHealth() {
  try {
    const response = await fetch("/api/health/gonka");
    return await response.json();
  } catch {
    return { ok: false, message: "Local health route unavailable." };
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
    source: "Manual intake",
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
        type: "manual_input",
        summary: "Raw text provided by coordinator for analysis.",
        retrievedAt: new Date().toISOString()
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

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
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
