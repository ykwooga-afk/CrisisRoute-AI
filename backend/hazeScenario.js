const SCENARIO_ID = "malaysia_haze_fire_smoke";
const CASE_LABELS = Object.freeze(["01", "02", "03", "04", "05"]);
const CASE_05_FIXTURE = "Hostel B has no air purifier and around 20 students need water, masks and an indoor safe room.";

const RESOURCES = Object.freeze([
  Object.freeze({ id: "res_masks", label: "N95 masks", available: 160, unit: "pcs", status: "ready" }),
  Object.freeze({ id: "res_water", label: "Water packs", available: 48, unit: "packs", status: "ready" }),
  Object.freeze({ id: "res_transport", label: "Clinic transport", available: 2, unit: "cars", status: "limited" }),
  Object.freeze({ id: "res_safe_room", label: "Indoor safe room", available: 3, unit: "rooms", status: "ready" }),
  Object.freeze({ id: "res_medical", label: "Medical volunteer", available: 1, unit: "person", status: "limited" })
]);

function createHazeScenarioCases(messages) {
  if (!Array.isArray(messages) || messages.length !== 5) {
    throw new TypeError("The full haze scenario requires exactly five frontend messages.");
  }

  return [
    {
      label: "01",
      title: "Block C Respiratory Cluster",
      source: "Hostel Telegram",
      messages: [messages[0], messages[1]],
      location: "Hostel Block C lobby",
      contactPath: true,
      peopleCount: 6,
      needs: ["N95 masks", "Clinic transport"],
      riskFlags: ["severe coughing", "asthma", "smoke exposure"],
      facts: ["Two supplied reports reference Block C.", "Respiratory symptoms and asthma were reported."],
      unknowns: ["Current asthma severity", "Final affected-person count"],
      targetState: "DISPATCH_CANDIDATE"
    },
    {
      label: "02",
      title: "Hostel B Duplicate Forwarding",
      source: "Forwarded WhatsApp",
      messages: [messages[2]],
      location: "Hostel B (exact location unconfirmed)",
      contactPath: false,
      peopleCount: 20,
      needs: ["Verification call"],
      riskFlags: ["forwarded report", "possible duplicate"],
      facts: ["The supplied item is explicitly marked as a forward."],
      unknowns: ["Original source", "Reliable callback contact"],
      targetState: "MERGE_OR_VERIFY"
    },
    {
      label: "03",
      title: "Elderly Breathing Difficulty",
      source: "Community WhatsApp Group",
      messages: [messages[3]],
      location: "Near Shah Alam (exact location unclear)",
      contactPath: false,
      peopleCount: 1,
      needs: ["Urgent verification", "Official medical guidance"],
      riskFlags: ["breathing difficulty", "elderly person", "haze exposure"],
      facts: ["An elderly person's breathing difficulty was reported."],
      unknowns: ["Exact location", "Callback number"],
      targetState: "URGENT_VERIFICATION"
    },
    {
      label: "04",
      title: "Sports Day Haze Conflict",
      source: "Student Council Discord",
      messages: [messages[4]],
      location: "Campus grounds",
      contactPath: false,
      peopleCount: null,
      needs: ["Official organizer confirmation"],
      riskFlags: ["conflicting notices"],
      facts: ["One notice says proceed while another claims cancellation."],
      unknowns: ["Authoritative organizer decision"],
      targetState: "NEEDS_HUMAN_REVIEW"
    },
    {
      label: "05",
      title: "Indoor Safe-Room Supply Request",
      source: "Hostel Committee Form",
      messages: [CASE_05_FIXTURE],
      location: "Hostel B",
      contactPath: true,
      peopleCount: 20,
      needs: ["Water packs", "N95 masks", "Indoor safe room", "Air purifier"],
      riskFlags: [],
      facts: ["A fixed hackathon fixture requests supplies and an indoor safe room."],
      unknowns: ["Air purifier availability", "Delivery timing"],
      targetState: "QUEUED_ACTION",
      fixture: true
    }
  ];
}

function cloneResources() {
  return RESOURCES.map(resource => ({ ...resource }));
}

module.exports = {
  SCENARIO_ID,
  CASE_LABELS,
  CASE_05_FIXTURE,
  createHazeScenarioCases,
  cloneResources
};
