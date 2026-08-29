import { cloneScenario } from "./hazeScenario.mock.js";

export function getReplayScenario() {
  const scenario = cloneScenario();
  scenario.incidents = scenario.incidents.map((incident, index) => ({
    ...incident,
    gonka: {
      mode: "replay",
      analyst: {
        model: "recorded-analyst-model",
        responseId: `recorded-response-analyst-${String(index + 1).padStart(3, "0")}`,
        promptVersion: incident.gonka.analyst.promptVersion,
        latencyMs: incident.gonka.analyst.latencyMs
      },
      reviewer: {
        model: "recorded-reviewer-model",
        responseId: `recorded-response-reviewer-${String(index + 1).padStart(3, "0")}`,
        promptVersion: incident.gonka.reviewer.promptVersion,
        latencyMs: incident.gonka.reviewer.latencyMs
      }
    }
  }));

  return scenario;
}
