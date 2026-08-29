# CrisisRoute AI

Evidence-backed crisis verification and triage decision-support system for the MUBA Hacks 2026 Gonka - AI for Society track.

CrisisRoute AI turns chaotic public-safety reports into extracted claims, evidence mapping, three-axis scores, safety gates, human decisions, action briefs and proof capsules.

Core product idea:

```text
LOW VERIFICATION does not mean LOW URGENCY.
AI assists. Humans decide.
```

## Demo Focus

The current demo is a Malaysia haze / fire-smoke response scenario:

- Campus hostel respiratory reports
- Duplicate forwarded emergency messages
- Low-confidence but high-urgency elderly breathing distress
- Conflicting sports-day haze reports
- Resource matching for N95 masks, clinic transport and indoor safe rooms

The five demo cases are already included in `src/data/hazeScenario.mock.js`.

## How To Preview

For a quick teammate preview, open this file directly:

```text
CrisisRoute-AI-Latest-App.html
```

This standalone HTML file contains the latest approved frontend demo and does not require the server.

For the normal project version, run:

```bash
npm run dev
```

Then open:

```text
http://localhost:4173
```

No `npm install` is currently required because the app uses the existing vanilla HTML/CSS/JavaScript architecture and has no external runtime dependencies.

## Current Frontend Stack

- Vanilla HTML/CSS/JavaScript
- ES modules
- `index.html`
- `src/main.js`
- `src/styles.css`
- Existing Node static server in `server.js`

Do not migrate this project to React, Next.js, Vite, TypeScript or another framework during backend handoff.

## Core Flow

```text
Incoming crisis report
-> Claim extraction
-> Evidence matrix
-> Gonka Incident Analyst
-> Gonka Skeptical Reviewer
-> Consensus and three-axis scoring
-> Safety gates
-> Human decision
-> Action brief
-> Proof capsule
```

## Data Modes

- `Demo Snapshot`: local mock data for the current frontend demo.
- `Replay`: recorded-style responses with the same incident contract.
- `Live`: backend route placeholders under `/api/incidents/*`.

Important mode rule:

- Demo mode must show `MODE: DEMO SNAPSHOT` and `Gonka: DEMO DATA`.
- Replay mode must show `MODE: REPLAY` and `Gonka: RECORDED RESPONSE`.
- Live mode must not show `Gonka: CONNECTED` unless real backend connectivity is confirmed.

## Gonka Router Integration Plan

All AI reasoning should eventually run through Gonka Router on the backend:

- Claim extraction
- Evidence-aware analysis
- Blind dual-model review
- Consensus logic
- Three-axis scoring
- Safety-gate reasoning
- Action brief generation

Required server-side environment variables:

```bash
GONKA_API_KEY=replace_with_server_side_key
GONKA_BASE_URL=https://api.gonkarouter.io/v1
GONKA_ANALYST_MODEL=replace_with_exact_model_id_from_models
GONKA_REVIEWER_MODEL=replace_with_exact_model_id_from_models
GONKA_ADJUDICATOR_MODEL=optional_exact_model_id
```

Never expose `GONKA_API_KEY` in frontend code.

## Important Handoff Files

- `CrisisRoute-AI-Latest-App.html`: single-file preview for teammate review.
- `src/services/crisisRouteClient.js`: centralized frontend adapter for mock, replay and live data.
- `src/data/hazeScenario.mock.js`: fixed Malaysia haze scenario and data-contract example.
- `src/data/replayResponses.js`: replay-mode data shaped like future live responses.
- `src/types/incident.schema.json`: expected incident object shape.
- `server.js`: static server and backend handoff placeholders.
- `README-HANDOFF.md`: detailed teammate backend handoff notes.
- `docs/CrisisRoute_AI_3.0_Champion_Blueprint.docx`: product blueprint.
- `docs/CrisisRoute_AI_3.0_Two_Person_Handoff_Guide.docx`: two-person work split and handoff guide.
- `docs/archive-old-drafts/`: older drafts kept only for reference. Use the two `3.0` files above as the latest version.

## Submission Checklist

- Live demo URL
- GitHub repository
- Clear README explaining Gonka Router integration
- 2-minute video showing the crisis verification flow
- UI showing demo / recorded / live model IDs honestly
- No fake live Gonka connection in mock mode
- No real personal information in demo data
