import { cloneScenario, rawReports } from "./hazeScenario.mock.js";

export const REPLAY_PROVENANCE = Object.freeze({
  fixtureKind: "sanitized_acceptance_replay",
  sourceRun: "B7-Q2-R1",
  acceptedAt: "2026-08-31T08:00:00.000Z",
  sanitized: true,
  networkRequestsThisLoad: 0,
  responseIdsRedacted: true,
  proofAvailable: false
});

const ACCEPTED_RESULTS = Object.freeze({
  "01": Object.freeze({ analyst: Object.freeze({ verification: 40, urgency: 85, actionability: 80 }), reviewer: Object.freeze({ verification: 65, urgency: 75, actionability: 85 }), final: Object.freeze({ verification: 53, urgency: 80, actionability: 83 }), consensus: "DISAGREEMENT", state: "DISPATCH_CANDIDATE" }),
  "02": Object.freeze({ analyst: Object.freeze({ verification: 10, urgency: 90, actionability: 20 }), reviewer: Object.freeze({ verification: 15, urgency: 70, actionability: 20 }), final: Object.freeze({ verification: 13, urgency: 80, actionability: 20 }), consensus: "DISAGREEMENT", state: "MERGE_OR_VERIFY" }),
  "03": Object.freeze({ analyst: Object.freeze({ verification: 20, urgency: 80, actionability: 15 }), reviewer: Object.freeze({ verification: 20, urgency: 75, actionability: 15 }), final: Object.freeze({ verification: 20, urgency: 78, actionability: 15 }), consensus: "AGREEMENT", state: "URGENT_VERIFICATION" }),
  "04": Object.freeze({ analyst: Object.freeze({ verification: 30, urgency: 50, actionability: 30 }), reviewer: Object.freeze({ verification: 35, urgency: 30, actionability: 40 }), final: Object.freeze({ verification: 33, urgency: 40, actionability: 35 }), consensus: "DISAGREEMENT", state: "NEEDS_HUMAN_REVIEW" }),
  "05": Object.freeze({ analyst: Object.freeze({ verification: 50, urgency: 40, actionability: 70 }), reviewer: Object.freeze({ verification: 70, urgency: 45, actionability: 75 }), final: Object.freeze({ verification: 60, urgency: 43, actionability: 73 }), consensus: "DISAGREEMENT", state: "QUEUED_ACTION" })
});

function scoreGaps(analyst, reviewer) {
  return {
    verification: Math.abs(analyst.verification - reviewer.verification),
    urgency: Math.abs(analyst.urgency - reviewer.urgency),
    actionability: Math.abs(analyst.actionability - reviewer.actionability)
  };
}

function replayGate(gate, accepted) {
  if (gate.id === "G_CONFLICT") {
    const passed = accepted.consensus === "AGREEMENT" && accepted.state !== "NEEDS_HUMAN_REVIEW";
    return {
      ...gate,
      status: passed ? "passed" : "review",
      passed,
      detail: passed
        ? "Sanitized acceptance replay recorded model agreement."
        : "Sanitized acceptance replay recorded disagreement requiring human review."
    };
  }
  if (gate.id === "G_DISPATCH") {
    const status = accepted.state === "DISPATCH_CANDIDATE"
      ? accepted.consensus === "AGREEMENT" ? "passed" : "review"
      : "locked";
    return {
      ...gate,
      status,
      passed: status === "passed",
      detail: status === "review"
        ? "Dispatch remains subject to explicit human review in this sanitized replay."
        : gate.detail
    };
  }
  return gate;
}

export function getReplayScenario() {
  const scenario = cloneScenario();
  const incidents = scenario.incidents.map(incident => {
    const accepted = ACCEPTED_RESULTS[incident.label];
    if (!accepted) throw new Error("Sanitized replay fixture is incomplete.");
    return {
      ...incident,
      scores: { ...accepted.final },
      operationalState: accepted.state,
      modelDebate: {
        ...incident.modelDebate,
        consensus: accepted.consensus,
        scoreGaps: scoreGaps(accepted.analyst, accepted.reviewer),
        replayNotice: "Sanitized B7-Q2-R1 acceptance result; not current live inference."
      },
      modelReviews: {
        analyst: { ...incident.modelReviews.analyst, scores: { ...accepted.analyst } },
        reviewer: { ...incident.modelReviews.reviewer, scores: { ...accepted.reviewer } }
      },
      safetyGates: incident.safetyGates.map(gate => replayGate(gate, accepted)),
      actionPlan: null,
      actionBrief: null,
      operationalBrief: null,
      proofCapsule: null,
      humanDecision: null,
      gonka: {
        mode: "replay",
        fixtureKind: REPLAY_PROVENANCE.fixtureKind,
        sourceRun: REPLAY_PROVENANCE.sourceRun,
        sanitized: true,
        networkRequestsThisLoad: 0,
        responseIdsRedacted: true,
        analyst: {
          model: "REDACTED_ACCEPTANCE_ANALYST",
          responseId: "[REDACTED]",
          promptVersion: "[REDACTED]",
          latencyMs: 0,
          traceLabel: "Sanitized recorded trace; latency is not this load's runtime."
        },
        reviewer: {
          model: "REDACTED_ACCEPTANCE_REVIEWER",
          responseId: "[REDACTED]",
          promptVersion: "[REDACTED]",
          latencyMs: 0,
          traceLabel: "Sanitized recorded trace; latency is not this load's runtime."
        }
      }
    };
  });

  return {
    resources: structuredClone(scenario.resources),
    rawReports: [...rawReports],
    incidents,
    meta: {
      mode: "replay",
      ...REPLAY_PROVENANCE,
      canonicalMessageCount: rawReports.length
    }
  };
}
