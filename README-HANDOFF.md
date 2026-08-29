# CrisisRoute AI Handoff Notes

This file explains how teammate B should continue after teammate A finishes the frontend product shell.

## Main Handoff Rule

Frontend, mock mode, replay mode and future live backend must all return the same incident data shape.

Do not redesign the UI when connecting Gonka. Keep the current vanilla architecture and replace the data source through the centralized adapter:

```text
src/services/crisisRouteClient.js
```

Do not scatter API calls inside UI rendering code.

## What Teammate A Finished

- Approved CrisisRoute AI frontend visual system
- Command Center
- Case Intelligence
- Evidence & Model Review
- Safety
- Action Brief
- Incident Queue with five Malaysia haze demo cases
- Three-axis scores: Verification, Urgency, Actionability
- Evidence connection map
- Blind dual-model review layout
- Consensus / disagreement display
- Safety gates and disabled dispatch behavior
- Human approval flow for CASE 01
- Proof Capsule
- Audit Timeline
- Demo / Replay / Live mode labels
- Centralized frontend client adapter
- Standalone teammate preview file: `CrisisRoute-AI-Latest-App.html`

## What Teammate B Should Build Next

1. Configure Gonka Router credentials server-side only.
2. Call the Gonka models endpoint and choose exact available model IDs.
3. Implement live backend logic for `POST /api/incidents/analyze`.
4. Implement live backend logic for `POST /api/incidents/review`.
5. Implement live backend logic for `POST /api/incidents/consensus`.
6. Implement live backend logic for `POST /api/incidents/:id/brief`.
7. Implement live backend logic for `POST /api/incidents/:id/decision`.
8. Return real model IDs and real response/request IDs from Gonka.
9. Add timeout, rate-limit and malformed-JSON handling.
10. Keep replay fallback clearly labelled as replay, not live.
11. Update `liveRoutesReady` or the equivalent backend-health flag only when the live routes actually work.

## Backend Routes

```text
POST /api/incidents/analyze
  Input: raw crisis report text or source URL
  Output: structured incidents, claims, evidence, first-pass scores

POST /api/incidents/review
  Input: raw report, extracted claims and evidence pack
  Output: skeptical reviewer result, counter-evidence, unknown facts, score review

POST /api/incidents/consensus
  Input: analyst JSON and reviewer JSON
  Output: final operational state, disagreement flags, safety-gate inputs

POST /api/incidents/:id/brief
  Input: approved incident
  Output: volunteer action brief, resources, multilingual copy if implemented

POST /api/incidents/:id/decision
  Input: human decision
  Output: audit event and proof capsule
```

## Data Contract

The frontend expects one incident object to contain this general shape. Keep the names stable.

```json
{
  "caseId": "case_001",
  "label": "CASE 01",
  "title": "Block C Respiratory Cluster",
  "rawMessage": "Block C: several students coughing badly...",
  "source": "Hostel Telegram",
  "receivedAt": "2026-08-28T20:15:00+08:00",
  "location": "Block C Hostel",
  "peopleCount": 6,
  "needs": ["N95 masks", "clinic transport"],
  "riskFlags": ["asthma", "multiple respiratory symptoms"],
  "claims": [
    {
      "id": "C-01",
      "text": "Students in Block C report respiratory symptoms.",
      "status": "supported",
      "evidenceIds": ["E-01", "E-02"]
    }
  ],
  "evidence": [
    {
      "id": "E-01",
      "type": "source_message",
      "summary": "Original report from hostel group.",
      "retrievedAt": "2026-08-28T20:16:00+08:00"
    }
  ],
  "scores": {
    "verification": 91,
    "urgency": 96,
    "actionability": 88
  },
  "operationalState": "DISPATCH_CANDIDATE",
  "missingFields": [],
  "modelDebate": {
    "agreement": ["respiratory risk is serious"],
    "disagreement": [],
    "counterEvidence": [],
    "consensus": "Dispatch can proceed after human approval."
  },
  "safetyGates": [
    {
      "id": "G_LOCATION",
      "label": "Exact Location",
      "status": "PASSED",
      "passed": true,
      "detail": "Location has been verified."
    }
  ],
  "recommendedAction": "Prepare N95 masks and clinic transport.",
  "actionBrief": null,
  "proofCapsule": null,
  "gonka": {
    "mode": "live",
    "analyst": {
      "model": "<exact model id>",
      "responseId": "<real response id>",
      "promptVersion": "analyst-v1",
      "latencyMs": 900
    },
    "reviewer": {
      "model": "<exact model id>",
      "responseId": "<real response id>",
      "promptVersion": "reviewer-v1",
      "latencyMs": 1100
    }
  },
  "humanDecision": null
}
```

## Mode Truthfulness

Keep the labels honest:

- Mock data: `MODE: DEMO SNAPSHOT`, `Gonka: DEMO DATA`
- Replay data: `MODE: REPLAY`, `Gonka: RECORDED RESPONSE`
- Live data: `MODE: LIVE`

Only show `Gonka: CONNECTED` when the backend has confirmed that live Gonka routes are ready. If live mode fails or returns placeholders, show an honest unavailable/error state.

## Safety Gates

Dispatch must be blocked when:

- Exact location is missing
- Verified contact is missing
- Analyst and reviewer disagree heavily
- Requested resources exceed available stock
- The case requires official emergency escalation before volunteer action

For medical or life-safety red flags, show official escalation guidance. Do not present the app as a replacement for official emergency services.

## Definition Of Done For Teammate B

- One new crisis report goes through real Gonka Analyst and Reviewer.
- UI shows real model IDs and real response/request IDs.
- Evidence Matrix is produced from structured JSON.
- Verification, Urgency and Actionability scores are returned.
- Safety Gates can block dispatch.
- CASE 03 remains urgent but not dispatchable.
- CASE 01 can be approved by a human and then generate an Action Brief.
- Proof Capsule records the decision chain without claiming blockchain proof.
- Failure states are honest: no fake consensus after timeout, 429 or malformed JSON.

## Files To Read First

- `README.md`
- `README-HANDOFF.md`
- `src/services/crisisRouteClient.js`
- `src/data/hazeScenario.mock.js`
- `src/data/replayResponses.js`
- `src/types/incident.schema.json`
- `docs/CrisisRoute_AI_3.0_Champion_Blueprint.docx`
- `docs/CrisisRoute_AI_3.0_Two_Person_Handoff_Guide.docx`
