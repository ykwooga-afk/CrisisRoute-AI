export const resources = [
  { id: "res_masks", label: "N95 masks", available: 160, unit: "pcs", status: "ready" },
  { id: "res_water", label: "Water packs", available: 48, unit: "packs", status: "ready" },
  { id: "res_transport", label: "Clinic transport", available: 2, unit: "cars", status: "limited" },
  { id: "res_safe_room", label: "Indoor safe room", available: 3, unit: "rooms", status: "ready" },
  { id: "res_medical", label: "Medical volunteer", available: 1, unit: "person", status: "limited" }
];

export const rawReports = [
  "Block C hostel: six students are coughing badly, one has asthma. Need N95 masks and clinic transport.",
  "Another Block C resident reports heavy smoke smell and several students waiting near the lobby.",
  "FORWARD: 20 students trapped in Hostel B!!! Send everything now!!!",
  "Family near Shah Alam says an elderly parent has breathing difficulty due to haze. Exact location and callback number are unclear.",
  "Sports day is still scheduled despite haze; one notice says proceed, while another group claims cancellation."
];

export const incidents = [
  {
    caseId: "CR-2026-0041",
    label: "01",
    title: "Block C Respiratory Cluster",
    rawMessage: rawReports[0],
    source: "Hostel Telegram",
    receivedAt: "2026-08-28T14:18:00+08:00",
    location: "Hostel Block C",
    coordinates: "3.0735 N, 101.5181 E",
    aqi: 185,
    peopleCount: 6,
    needs: ["N95 masks", "clinic transport", "water"],
    riskFlags: ["asthma", "multiple respiratory symptoms", "haze exposure"],
    knownFacts: ["six students affected", "one student has asthma", "Block C lobby location is known"],
    unknownFacts: ["student count should be confirmed before public reporting"],
    priorityRationale:
      "Multiple reports support the location and respiratory symptoms. The case is urgent and actionable, so it is ready for human-approved dispatch.",
    insight:
      "Verified location and respiratory risk make this a controlled dispatch candidate, not an automatic AI decision.",
    safeNextActions: [
      "Confirm final student count with hostel coordinator",
      "Send N95 masks and water to Block C lobby",
      "Prepare clinic transport for the asthma case",
      "Escalate worsening symptoms to official emergency or clinic services"
    ],
    claims: [
      {
        id: "C-01",
        text: "Six students in Block C are coughing badly.",
        status: "supported",
        evidenceIds: ["E-01", "E-02"]
      },
      {
        id: "C-02",
        text: "One student has asthma and may need clinic transport.",
        status: "reported",
        evidenceIds: ["E-01"]
      },
      {
        id: "C-03",
        text: "Heavy smoke smell is present near Block C.",
        status: "supported",
        evidenceIds: ["E-02", "E-03"]
      }
    ],
    evidence: [
      {
        id: "E-01",
        type: "Hostel Telegram report",
        summary: "Original hostel report mentions six coughing students and one asthma case.",
        retrievedAt: "2026-08-28T14:18:00+08:00",
        reliability: "Primary source from hostel channel",
        contradictions: "None found",
        uncertainties: ["exact medical severity", "final headcount before departure"]
      },
      {
        id: "E-02",
        type: "Independent resident report",
        summary: "Second Block C resident reports heavy smoke smell and several students waiting near the lobby.",
        retrievedAt: "2026-08-28T14:19:00+08:00",
        reliability: "Independent corroboration",
        contradictions: "None found",
        uncertainties: ["whether all affected students are still at the lobby"]
      },
      {
        id: "E-03",
        type: "Campus haze snapshot",
        summary: "Demo haze knowledge snapshot marks outdoor air as unhealthy near campus.",
        retrievedAt: "2026-08-28T14:19:30+08:00",
        reliability: "Contextual demo data",
        contradictions: "None found",
        uncertainties: ["AQI may change rapidly"]
      }
    ],
    scores: { verification: 91, urgency: 96, actionability: 88 },
    operationalState: "DISPATCH_CANDIDATE",
    missingFields: ["student contact for asthma case"],
    modelDebate: {
      agreement: ["respiratory risk is serious", "Block C location is clear", "masks and transport are reasonable"],
      disagreement: ["exact headcount should be confirmed before final public reporting"],
      counterEvidence: ["no official evacuation notice has been issued"],
      consensus: "DISPATCH CANDIDATE"
    },
    modelReviews: {
      analyst: {
        conclusion: "Evidence supports a controlled dispatch of masks, water and clinic transport standby.",
        evidenceCited: ["E-01", "E-02", "E-03"],
        scores: { verification: 91, urgency: 96, actionability: 88 },
        rationale: "Two reports support the same location and symptoms. The asthma flag raises medical priority."
      },
      reviewer: {
        conclusion: "Dispatch is reasonable after human approval; confirm headcount before public escalation.",
        counterEvidence: ["No official evacuation notice"],
        unknowns: ["final student count", "current asthma severity"],
        duplicateRisk: "Low - two reports are not identical forwards",
        scores: { verification: 89, urgency: 94, actionability: 86 },
        rationale: "Enough information exists for a bounded resource dispatch, while medical escalation remains human-controlled."
      }
    },
    safetyGates: [
      { id: "G_MEDICAL", label: "Medical Red Flag", status: "triggered", passed: true, detail: "Asthma and respiratory symptoms flagged." },
      { id: "G_LOCATION", label: "Exact Location", status: "passed", passed: true, detail: "Hostel Block C lobby is actionable." },
      { id: "G_CONTACT", label: "Verified Contact", status: "passed", passed: true, detail: "Hostel Telegram coordinator can be contacted." },
      { id: "G_RESOURCE", label: "Resource Availability", status: "passed", passed: true, detail: "160 N95 masks and clinic transport standby are available." },
      { id: "G_CONFLICT", label: "Critical Model Conflict", status: "passed", passed: true, detail: "Analyst and reviewer agree on bounded dispatch." },
      { id: "G_DISPATCH", label: "Volunteer Dispatch", status: "passed", passed: true, detail: "Dispatch can proceed after human approval." }
    ],
    recommendedAction:
      "Approve masks, water and one clinic transport volunteer for Block C. Confirm the asthma student's condition before departure.",
    actionPlan: {
      destination: "Hostel Block C",
      priority: "HIGH",
      resources: [
        { label: "12 x N95 Masks", status: "Confirmed" },
        { label: "Clinic Transport", status: "Standby" },
        { label: "Volunteer Team", status: "2 persons" }
      ],
      instructions:
        "Proceed to Block C lobby. Confirm student count with hostel coordinator. Distribute N95 masks. Prioritize anyone experiencing breathing difficulty or known asthma. Escalate medical symptoms to official emergency or clinic services.",
      languages: {
        en: "Proceed to Block C lobby. Confirm student count with hostel coordinator. Distribute N95 masks. Prioritize anyone experiencing breathing difficulty or known asthma. Escalate medical symptoms to official emergency or clinic services.",
        zh: "前往 Block C lobby。先和宿舍负责人确认学生人数，分发 N95 口罩。优先照顾呼吸困难或有哮喘史的人，并把严重症状升级给官方紧急服务或诊所。",
        ms: "Pergi ke lobi Block C. Sahkan jumlah pelajar dengan penyelaras hostel. Edarkan topeng N95. Utamakan sesiapa yang sukar bernafas atau mempunyai asma. Rujuk gejala serius kepada perkhidmatan kecemasan rasmi atau klinik."
      }
    },
    actionBrief: null,
    proofCapsule: null,
    gonka: {
      mode: "demo_snapshot",
      analyst: {
        model: "demo-analyst-model",
        responseId: "demo-response-analyst-001",
        promptVersion: "analyst-v1.4",
        latencyMs: 1200
      },
      reviewer: {
        model: "demo-reviewer-model",
        responseId: "demo-response-reviewer-001",
        promptVersion: "reviewer-v1.4",
        latencyMs: 1400
      }
    },
    humanDecision: null
  },
  {
    caseId: "CR-2026-0042",
    label: "02",
    title: "Hostel B Duplicate Forwarding",
    rawMessage: rawReports[2],
    source: "Forwarded WhatsApp",
    receivedAt: "2026-08-28T14:20:00+08:00",
    location: "Hostel B",
    peopleCount: 20,
    needs: ["water", "masks", "verification call"],
    riskFlags: ["possible duplicate", "exaggerated wording", "unclear original source"],
    knownFacts: ["same message forwarded three times", "Hostel B mentioned", "no independent source yet"],
    unknownFacts: ["room or floor", "callback contact", "whether anyone is actually trapped"],
    priorityRationale:
      "The system prevents duplicate forwards from inflating confidence. It keeps the report visible but blocks dispatch until a real source appears.",
    insight: "A loud forwarded message is not three independent reports.",
    safeNextActions: [
      "Merge all identical forwards into one case",
      "Ask for original sender or room/floor",
      "Contact Hostel B warden",
      "Prepare supplies only after independent confirmation"
    ],
    claims: [
      {
        id: "C-01",
        text: "Twenty students are trapped in Hostel B.",
        status: "contradicted",
        evidenceIds: ["E-01", "E-02"]
      },
      {
        id: "C-02",
        text: "The forwarded messages come from the same original sender.",
        status: "supported",
        evidenceIds: ["E-02", "E-03"]
      }
    ],
    evidence: [
      {
        id: "E-01",
        type: "Forwarded WhatsApp message",
        summary: "Forwarded message claims 20 trapped students with urgent wording.",
        retrievedAt: "2026-08-28T14:20:00+08:00",
        reliability: "Single source, forwarded chain",
        contradictions: "Warden has not confirmed trapped students.",
        uncertainties: ["original sender", "room or floor", "contact number"]
      },
      {
        id: "E-02",
        type: "Duplicate detection",
        summary: "Three reports share identical text and forwarded origin metadata.",
        retrievedAt: "2026-08-28T14:21:00+08:00",
        reliability: "Strong duplicate signal",
        contradictions: "None",
        uncertainties: ["whether there is one valid original report"]
      },
      {
        id: "E-03",
        type: "Coordinator note",
        summary: "Hostel B warden has not confirmed trapped students yet.",
        retrievedAt: "2026-08-28T14:22:00+08:00",
        reliability: "Coordinator follow-up",
        contradictions: "No trapped students confirmed so far",
        uncertainties: ["warden may not have completed floor check"]
      }
    ],
    scores: { verification: 38, urgency: 61, actionability: 52 },
    operationalState: "MERGE_OR_VERIFY",
    missingFields: ["independent confirmation", "exact room or floor", "callback contact"],
    modelDebate: {
      agreement: ["duplicate forwards should be merged", "forwarded text does not count as independent evidence"],
      disagreement: ["reviewer assigns lower verification because the original source is missing"],
      counterEvidence: ["no second independent sender has verified trapped students"],
      consensus: "MERGE DUPLICATE"
    },
    modelReviews: {
      analyst: {
        conclusion: "Possible emergency, but evidence appears duplicated.",
        evidenceCited: ["E-01", "E-02"],
        scores: { verification: 42, urgency: 64, actionability: 55 },
        rationale: "Hostel and headcount are present, but forwarding pattern makes confidence weak."
      },
      reviewer: {
        conclusion: "Do not dispatch based on repeated forwards from one source.",
        counterEvidence: ["E-03"],
        unknowns: ["original source", "room or floor", "callback contact"],
        duplicateRisk: "High - 3 forwards -> 1 source",
        scores: { verification: 34, urgency: 58, actionability: 49 },
        rationale: "The message should be treated as one unverified source, not three corroborations."
      }
    },
    safetyGates: [
      { id: "G_MEDICAL", label: "Medical Red Flag", status: "passed", passed: true, detail: "No specific medical symptom reported." },
      { id: "G_LOCATION", label: "Exact Location", status: "blocked", passed: false, detail: "Hostel B is broad; no room or floor given." },
      { id: "G_CONTACT", label: "Verified Contact", status: "blocked", passed: false, detail: "No callback contact found." },
      { id: "G_RESOURCE", label: "Resource Availability", status: "passed", passed: true, detail: "Supplies are available if the report is verified." },
      { id: "G_CONFLICT", label: "Critical Model Conflict", status: "passed", passed: true, detail: "Models agree that duplicate risk is the main issue." },
      { id: "G_DISPATCH", label: "Volunteer Dispatch", status: "locked", passed: false, detail: "Dispatch locked until independent source and exact location are verified." }
    ],
    recommendedAction: "Merge duplicate messages, ask for room/floor/contact, and do not dispatch until independently verified.",
    actionPlan: null,
    actionBrief: null,
    proofCapsule: null,
    gonka: {
      mode: "demo_snapshot",
      analyst: {
        model: "demo-analyst-model",
        responseId: "demo-response-analyst-002",
        promptVersion: "analyst-v1.4",
        latencyMs: 1100
      },
      reviewer: {
        model: "demo-reviewer-model",
        responseId: "demo-response-reviewer-002",
        promptVersion: "reviewer-v1.4",
        latencyMs: 1300
      }
    },
    humanDecision: null
  },
  {
    caseId: "CR-2026-0043",
    label: "03",
    title: "Elderly Breathing Difficulty",
    rawMessage: rawReports[3],
    source: "Community WhatsApp Group",
    receivedAt: "2026-08-28T14:23:00+08:00",
    location: "Near Shah Alam",
    coordinates: "3.0738 N, 101.5183 E",
    aqi: 185,
    peopleCount: 1,
    needs: ["official escalation", "verification call", "clinic guidance"],
    riskFlags: ["elderly", "high-risk demographic", "respiratory difficulty", "possible medical emergency", "haze exposure"],
    knownFacts: ["elderly person affected", "breathing difficulty reported", "haze exposure suspected"],
    unknownFacts: ["exact location", "verified callback contact", "independent corroboration"],
    priorityRationale:
      "The system treats this as urgent because a life may be at stake, not because the evidence is complete. Respiratory distress in an elderly person during hazardous air quality creates immediate verification priority.",
    insight: "Evidence is incomplete, but respiratory distress creates immediate verification and escalation priority.",
    safeNextActions: [
      "Contact reporter immediately via WhatsApp",
      "Request exact address or GPS coordinates",
      "Request callback number",
      "Show official emergency escalation guidance",
      "Prepare N95 masks and escalation checklist"
    ],
    claims: [
      {
        id: "C-01",
        text: "An elderly person is experiencing breathing difficulty.",
        status: "reported_unverified",
        evidenceIds: ["E-01"]
      },
      {
        id: "C-02",
        text: "Symptoms may be related to haze exposure.",
        status: "plausible",
        evidenceIds: ["E-02", "E-03"]
      },
      {
        id: "C-03",
        text: "Volunteer assistance is requested.",
        status: "reported",
        evidenceIds: ["E-01"]
      },
      {
        id: "C-04",
        text: "Family location is near Shah Alam.",
        status: "unverifiable",
        evidenceIds: ["E-01", "E-04"]
      }
    ],
    evidence: [
      {
        id: "E-01",
        type: "Original WhatsApp Message",
        summary: "Single message reporting elderly breathing difficulty near Shah Alam.",
        retrievedAt: "2026-08-28T14:23:07+08:00",
        reliability: "Single source, unverified chain",
        contradictions: "None found",
        uncertainties: ["location", "identity", "medical severity"]
      },
      {
        id: "E-02",
        type: "Campus haze snapshot",
        summary: "Demo haze knowledge snapshot indicates unhealthy air quality in the wider response area.",
        retrievedAt: "2026-08-28T14:23:30+08:00",
        reliability: "Contextual support, not direct confirmation",
        contradictions: "None found",
        uncertainties: ["local indoor exposure", "exact distance from source"]
      },
      {
        id: "E-03",
        type: "Shah Alam AQI data",
        summary: "Demo AQI value is 185 for the scenario area, supporting haze-risk context.",
        retrievedAt: "2026-08-28T14:24:00+08:00",
        reliability: "Demo environmental signal",
        contradictions: "None found",
        uncertainties: ["real-time measurement variance"]
      },
      {
        id: "E-04",
        type: "No independent report found",
        summary: "No second independent report confirms exact address, caller identity or current condition.",
        retrievedAt: "2026-08-28T14:24:20+08:00",
        reliability: "Negative evidence for dispatch readiness",
        contradictions: "No direct contradiction",
        uncertainties: ["exact address", "callback number", "current medical status"]
      }
    ],
    scores: { verification: 43, urgency: 97, actionability: 24 },
    operationalState: "URGENT_VERIFICATION",
    missingFields: [
      "exact address or GPS coordinates",
      "verified callback number",
      "relationship of reporter to patient",
      "current medical status update"
    ],
    modelDebate: {
      agreement: ["dispatch unsafe", "urgency high", "verification required"],
      disagreement: ["score gap: 2 points between analyst and reviewer, minor"],
      counterEvidence: ["no independent corroboration found"],
      consensus: "URGENT VERIFICATION"
    },
    modelReviews: {
      analyst: {
        conclusion: "Insufficient information for safe volunteer dispatch. Verification required before any action.",
        evidenceCited: ["E-01", "E-02"],
        scores: { verification: 43, urgency: 97, actionability: 24 },
        rationale:
          "Single-source report. Location unconfirmed. Contact unverified. Respiratory risk is real but dispatch is unsafe without more information."
      },
      reviewer: {
        conclusion: "No independent corroboration found.",
        counterEvidence: ["E-04"],
        unknowns: ["location", "medical severity", "reporter identity"],
        duplicateRisk: "Low - single origin source",
        scores: { verification: 41, urgency: 97, actionability: 22 },
        rationale:
          "Agree dispatch is unsafe. Location and contact gaps are critical blockers. Urgency remains high regardless of low verification."
      }
    },
    safetyGates: [
      { id: "G_MEDICAL", label: "Medical Red Flag", status: "triggered", passed: true, detail: "Breathing difficulty flagged." },
      { id: "G_LOCATION", label: "Exact Location", status: "blocked", passed: false, detail: "Location unconfirmed - exact address required." },
      { id: "G_CONTACT", label: "Verified Contact", status: "blocked", passed: false, detail: "No callback number - required." },
      { id: "G_RESOURCE", label: "Resource Availability", status: "passed", passed: true, detail: "160 N95 masks available." },
      { id: "G_CONFLICT", label: "Critical Model Conflict", status: "passed", passed: true, detail: "Models agree on assessment." },
      { id: "G_DISPATCH", label: "Volunteer Dispatch", status: "locked", passed: false, detail: "Dispatch locked until exact location and verified contact are obtained." }
    ],
    recommendedAction: "Contact reporter immediately and obtain exact location and callback information.",
    actionPlan: null,
    actionBrief: null,
    proofCapsule: null,
    gonka: {
      mode: "demo_snapshot",
      analyst: {
        model: "demo-analyst-model",
        responseId: "demo-response-analyst-003",
        promptVersion: "analyst-v1.4",
        latencyMs: 1200
      },
      reviewer: {
        model: "demo-reviewer-model",
        responseId: "demo-response-reviewer-003",
        promptVersion: "reviewer-v1.4",
        latencyMs: 1400
      }
    },
    humanDecision: null
  },
  {
    caseId: "CR-2026-0044",
    label: "04",
    title: "Sports Day Haze Conflict",
    rawMessage: rawReports[4],
    source: "Student Council Discord",
    receivedAt: "2026-08-28T14:26:00+08:00",
    location: "Campus grounds",
    peopleCount: 180,
    needs: ["policy confirmation", "announcement draft", "indoor alternative"],
    riskFlags: ["conflicting notices", "large outdoor group", "model disagreement"],
    knownFacts: ["large outdoor event", "older notice says proceed", "student group claims cancellation"],
    unknownFacts: ["latest official notice", "organizer confirmation", "whether indoor backup is approved"],
    priorityRationale:
      "This case is less medically urgent than Case 03 but demonstrates meaningful model disagreement and should be escalated to a human coordinator.",
    insight: "Conflicting public instructions require human review, not automatic announcement.",
    safeNextActions: [
      "Contact event organizer",
      "Request latest official notice",
      "Prepare indoor contingency announcement",
      "Avoid public cancellation claim until confirmed"
    ],
    claims: [
      {
        id: "C-01",
        text: "Sports day is still scheduled despite haze.",
        status: "partially_supported",
        evidenceIds: ["E-01", "E-02"]
      },
      {
        id: "C-02",
        text: "Another group says the activity has been cancelled.",
        status: "reported_unverified",
        evidenceIds: ["E-03"]
      },
      {
        id: "C-03",
        text: "A large outdoor group could be exposed to unhealthy air.",
        status: "plausible",
        evidenceIds: ["E-02"]
      }
    ],
    evidence: [
      {
        id: "E-01",
        type: "Older announcement screenshot",
        summary: "Older notice says outdoor activities will proceed.",
        retrievedAt: "2026-08-28T14:26:00+08:00",
        reliability: "Official but stale",
        contradictions: "Conflicts with informal cancellation claim",
        uncertainties: ["whether the notice has been superseded"]
      },
      {
        id: "E-02",
        type: "Campus haze snapshot",
        summary: "Demo haze/fire-smoke snapshot indicates outdoor activity risk.",
        retrievedAt: "2026-08-28T14:26:40+08:00",
        reliability: "Contextual environmental signal",
        contradictions: "Does not confirm event status",
        uncertainties: ["current exact campus reading"]
      },
      {
        id: "E-03",
        type: "Informal student report",
        summary: "A student group claims cancellation but does not attach an official notice.",
        retrievedAt: "2026-08-28T14:27:00+08:00",
        reliability: "Unverified social report",
        contradictions: "Conflicts with older official notice",
        uncertainties: ["source of cancellation claim"]
      }
    ],
    scores: { verification: 64, urgency: 74, actionability: 58 },
    operationalState: "NEEDS_HUMAN_REVIEW",
    missingFields: ["latest official notice", "organizer confirmation"],
    modelDebate: {
      agreement: ["large outdoor group creates avoidable haze exposure risk"],
      disagreement: ["analyst treats older notice as sufficient; reviewer says official status is stale and conflicting"],
      counterEvidence: ["cancellation claim lacks official source"],
      consensus: "NEEDS HUMAN REVIEW"
    },
    modelReviews: {
      analyst: {
        conclusion: "Proceed notice is official enough to treat event as active unless updated.",
        evidenceCited: ["E-01", "E-02"],
        scores: { verification: 70, urgency: 72, actionability: 63 },
        rationale: "The only official artifact says proceed, and haze context supports preparing safer guidance."
      },
      reviewer: {
        conclusion: "Do not issue final guidance until organizer confirms latest status.",
        counterEvidence: ["E-03"],
        unknowns: ["latest organizer decision", "official cancellation notice"],
        duplicateRisk: "Medium - informal cancellation may be copied across groups",
        scores: { verification: 55, urgency: 77, actionability: 45 },
        rationale: "The official notice may be stale, and conflicting claims make automated action risky."
      }
    },
    safetyGates: [
      { id: "G_MEDICAL", label: "Medical Red Flag", status: "passed", passed: true, detail: "No individual medical emergency reported." },
      { id: "G_LOCATION", label: "Exact Location", status: "passed", passed: true, detail: "Campus grounds are known." },
      { id: "G_CONTACT", label: "Verified Contact", status: "blocked", passed: false, detail: "Organizer confirmation is missing." },
      { id: "G_RESOURCE", label: "Resource Availability", status: "passed", passed: true, detail: "Indoor alternatives can be prepared." },
      { id: "G_CONFLICT", label: "Critical Model Conflict", status: "blocked", passed: false, detail: "Analyst and reviewer materially disagree." },
      { id: "G_DISPATCH", label: "Volunteer Dispatch", status: "locked", passed: false, detail: "Public action locked until human review." }
    ],
    recommendedAction: "Contact organizer, request latest notice, and prepare an indoor contingency announcement.",
    actionPlan: null,
    actionBrief: null,
    proofCapsule: null,
    gonka: {
      mode: "demo_snapshot",
      analyst: {
        model: "demo-analyst-model",
        responseId: "demo-response-analyst-004",
        promptVersion: "analyst-v1.4",
        latencyMs: 1180
      },
      reviewer: {
        model: "demo-reviewer-model",
        responseId: "demo-response-reviewer-004",
        promptVersion: "reviewer-v1.4",
        latencyMs: 1510
      }
    },
    humanDecision: null
  },
  {
    caseId: "CR-2026-0045",
    label: "05",
    title: "Indoor Safe-Room Supply Request",
    rawMessage: "Hostel B has no air purifier and around 20 students need water, masks and an indoor safe room.",
    source: "Hostel Committee Form",
    receivedAt: "2026-08-28T14:29:00+08:00",
    location: "Student center",
    peopleCount: 20,
    needs: ["indoor safe room", "water", "N95 masks", "air purifier"],
    riskFlags: ["large group", "supply shortage", "indoor shelter"],
    knownFacts: ["20 students need shelter supplies", "masks and water are available", "safe room can be assigned"],
    unknownFacts: ["air purifier availability"],
    priorityRationale:
      "The request is credible and useful, but it should be queued behind direct respiratory-risk cases.",
    insight: "Actionable supply coordination can continue while urgent verification cases are escalated.",
    safeNextActions: [
      "Reserve one indoor safe room",
      "Send masks and water",
      "Record air purifier as unmet need",
      "Check whether any respiratory symptoms develop"
    ],
    claims: [
      {
        id: "C-01",
        text: "Around 20 Hostel B students need indoor shelter supplies.",
        status: "supported",
        evidenceIds: ["E-01", "E-02"]
      },
      {
        id: "C-02",
        text: "Hostel B has no available air purifier.",
        status: "partially_supported",
        evidenceIds: ["E-01"]
      }
    ],
    evidence: [
      {
        id: "E-01",
        type: "Hostel committee form",
        summary: "Hostel committee form reports 20 students and supply needs.",
        retrievedAt: "2026-08-28T14:29:00+08:00",
        reliability: "Structured request from committee",
        contradictions: "None found",
        uncertainties: ["air purifier stock"]
      },
      {
        id: "E-02",
        type: "Resource inventory",
        summary: "Resource board shows masks and water available, air purifier unavailable.",
        retrievedAt: "2026-08-28T14:30:00+08:00",
        reliability: "Current demo inventory",
        contradictions: "None found",
        uncertainties: ["delivery timing"]
      }
    ],
    scores: { verification: 78, urgency: 42, actionability: 81 },
    operationalState: "QUEUED_ACTION",
    missingFields: ["air purifier availability"],
    modelDebate: {
      agreement: ["resource request is actionable", "water and masks can be assigned before purifier is found"],
      disagreement: ["reviewer notes purifier need should not delay immediate supplies"],
      counterEvidence: ["no respiratory red flag reported for this case"],
      consensus: "QUEUED ACTION"
    },
    modelReviews: {
      analyst: {
        conclusion: "Queue supply dispatch after medical-risk cases.",
        evidenceCited: ["E-01", "E-02"],
        scores: { verification: 78, urgency: 42, actionability: 81 },
        rationale: "Structured request and available supplies make this operationally easy."
      },
      reviewer: {
        conclusion: "No emergency dispatch required unless respiratory symptoms appear.",
        counterEvidence: ["no medical red flag"],
        unknowns: ["air purifier availability"],
        duplicateRisk: "Low",
        scores: { verification: 75, urgency: 39, actionability: 83 },
        rationale: "This is important support work but less urgent than breathing-risk cases."
      }
    },
    safetyGates: [
      { id: "G_MEDICAL", label: "Medical Red Flag", status: "passed", passed: true, detail: "No medical emergency reported." },
      { id: "G_LOCATION", label: "Exact Location", status: "passed", passed: true, detail: "Student center is actionable." },
      { id: "G_CONTACT", label: "Verified Contact", status: "passed", passed: true, detail: "Hostel committee form has a coordinator." },
      { id: "G_RESOURCE", label: "Resource Availability", status: "passed", passed: true, detail: "Masks, water and safe room are available." },
      { id: "G_CONFLICT", label: "Critical Model Conflict", status: "passed", passed: true, detail: "No material model conflict." },
      { id: "G_DISPATCH", label: "Volunteer Dispatch", status: "passed", passed: true, detail: "Supply run can be queued after urgent cases." }
    ],
    recommendedAction: "Queue supply run after Block C. Assign masks, water and one indoor safe room; flag air purifier as unmet need.",
    actionPlan: null,
    actionBrief: null,
    proofCapsule: null,
    gonka: {
      mode: "demo_snapshot",
      analyst: {
        model: "demo-analyst-model",
        responseId: "demo-response-analyst-005",
        promptVersion: "analyst-v1.4",
        latencyMs: 1030
      },
      reviewer: {
        model: "demo-reviewer-model",
        responseId: "demo-response-reviewer-005",
        promptVersion: "reviewer-v1.4",
        latencyMs: 1270
      }
    },
    humanDecision: null
  }
];

export function cloneScenario() {
  return {
    resources: structuredClone(resources),
    rawReports: [...rawReports],
    incidents: structuredClone(incidents)
  };
}
