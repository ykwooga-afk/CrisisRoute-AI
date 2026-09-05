# CrisisRoute AI

CrisisRoute AI turns unverified crisis reports into evidence-backed, multi-model-reviewed, human-approved action.

- Live Demo: [https://crisisroute-ai.onrender.com/](https://crisisroute-ai.onrender.com/)
- 2-Minute Demo Video: [https://youtu.be/6gbRJ5ldPRM](https://youtu.be/6gbRJ5ldPRM)
- Track: Gonka Router / AI for Society

CrisisRoute AI is not an emergency service, not an autonomous dispatcher, and not a generic chatbot. It is crisis-triage decision support: uncertainty stays visible, AI assists, and humans decide.

## Problem

Crisis reports arrive as incomplete texts, public URLs, duplicated forwards, conflicting observations, and urgent claims without enough location or contact detail. A binary true/false label can hide a dangerous report simply because its evidence is weak.

CrisisRoute AI separates verification from urgency and actionability so operators can see what is known, what is missing, and what action is currently safe.

Core principles:

- LOW VERIFICATION ≠ LOW URGENCY
- URGENT ≠ DISPATCHABLE
- AI ASSISTS. HUMANS DECIDE.

Urgency determines how fast we respond. Verification and actionability determine what response is safe.

## Product Workflow

VERIFY -> CHALLENGE -> PRIORITIZE -> ACT

1. Accept pasted report text or Public URL retrieval from a safe public HTTP/HTTPS page.
2. Extract concise claims and source context.
3. Send the same evidence to two Gonka-hosted models for blind review.
4. Validate structured model responses.
5. Compare Truth / Verification, Urgency, and Actionability scores deterministically.
6. Apply safety gates before any operational next step.
7. Require an explicit Human Decision from the allowed action set.
8. Generate an Action Brief, local Proof Capsule, and Audit Trail.

The approved app flow is:

Command Center -> Case Intelligence -> Evidence -> Safety -> Human Decision inside Safety -> Action Brief

## Why Gonka Is Essential

All Live AI reasoning goes through Gonka Router using the OpenAI-compatible endpoint:

`https://api.gonkarouter.io/v1/chat/completions`

Current Live model roles:

- Incident Analyst: `deepseek-ai/DeepSeek-V4-Flash-0731`
- Skeptical Reviewer: `MiniMaxAI/MiniMax-M2.7`

Blind Dual-Model Review:

- Both models receive the same evidence independently.
- Neither model sees the other model's answer.
- Outputs are validated and compared deterministically afterward.

Two models citing the same source is not independent corroboration.

The Transparency UI displays model identifiers, Gonka request ID when exposed by the gateway, response/request trace identifiers, prompt version, latency, model reasoning, and model conclusions. The app does not claim a Gonka Request ID exists when the gateway does not expose one.

## Three-Axis Scoring

Truth / Verification:

- Measures how strongly available evidence supports the report.
- It is not the probability that the incident is true.

Urgency:

- Measures how dangerous or time-sensitive the situation would be if true.
- Low verification does not reduce urgency.

Actionability:

- Measures whether enough information exists for safe human-approved action.
- Missing location, contact, resources, or unresolved conflict can keep action blocked.

Scores are validated from 0-100. Missing, nonnumeric, infinite, or out-of-range values are rejected rather than guessed or clamped.

## Deterministic Consensus

The application averages each axis in code and measures the Analyst/Reviewer gap. Model prose does not control the final operational state.

- Gap <= 15: `AGREEMENT`
- Gap 16-30: `DISAGREEMENT` / evidence review
- Gap > 30 or material factual conflict: `CRITICAL_CONFLICT` / human review

## Safety Gates

CrisisRoute AI uses deterministic safety gates after model analysis. These gates do not change model scores; they constrain what action is safe.

Safety gates cover:

- Medical red flags that may trigger urgent verification or official emergency escalation guidance
- Missing exact actionable location, which can block volunteer dispatch
- Missing verified contact, which can block dispatch
- Resource conflicts, which can block dispatch
- Large model disagreement, which requires human review

AI never automatically executes real-world action. Human operators can only choose from currently allowed actions for the case state.

Haze is our validated demo scenario, not the limit of the platform. The same architecture can support floods, fires, landslides, medical emergencies, and other crisis domains.

## Human Decision

The Human Decision form records an operator's selected allowed action and optional reason. It does not approve arbitrary dispatch and does not execute action.

Examples of allowed decision categories include requesting urgent verification, requesting missing information, holding for review, queueing bounded action, or approving bounded assistance only when existing safety gates allow it.

`RECORDED` means the decision was saved in the app's local server process. `NOT_EXECUTED` means real-world action remains outside CrisisRoute AI.

## Deterministic Brief

After a valid decision, server-side code produces the Action Brief from validated analysis, safety state, audit context, and the recorded Human Decision.

The brief summarizes:

- What the human decided
- Why the action is allowed or constrained
- What happens next
- Whether anything was executed
- How the decision was recorded

The brief does not claim that contact, dispatch, treatment, delivery, or rescue occurred.

## Local Proof Capsule

The Proof Capsule is a server-issued local decision receipt. It is SHA-256 based and tamper-evident for local payload integrity.

It links:

- Analysis snapshot hash
- Human decision hash
- Action Brief hash
- Local audit hash

Proof Capsule has no blockchain or external anchoring. It provides local payload-integrity evidence only. It is not proof that the incident is true, not proof that a volunteer was dispatched, and not proof that real-world execution occurred.

Persistence is currently ephemeral. External anchoring is none.

## Data Modes

Demo:

- Synthetic curated scenario
- Designed for fast judge walkthroughs
- Clearly labelled as demo data

Replay:

- Sanitized recorded prior accepted run
- The current Replay load makes no model or network inference
- Never presented as Live

Live:

- Current Gonka inference
- Uses server-side credentials only
- Safe failures remain explicit and never silently become Demo or Replay

## Architecture

Frontend:

- HTML
- CSS
- Vanilla JavaScript ES modules

Backend:

- Node.js

```text
User Text / URL
|
v
Input + Claim Extraction
|
v
Gonka Router
|          |
Analyst    Reviewer
|          |
+----Blind Review----+
|
v
Deterministic Comparator
|
v
Truth / Urgency / Actionability
|
v
Safety Gates
|
v
Human Decision
|
v
Action Brief
|
v
Proof Capsule + Audit Trail
```

## Repository Structure

```text
backend/    Gonka client, incident pipeline, decision ledger, brief service, public URL extractor
src/        Browser UI, client adapter, demo and replay data
scripts/    Offline smokes, live rehearsal, release audit
tests/      Node test suite
docs/       Integration, runbook, pitch, and submission documentation
server.js   Static allowlist and API server
render.yaml Render Web Service configuration
```

Important modules:

- `src/main.js`
- `src/services/crisisRouteClient.js`
- `backend/gonkaClient.js`
- `backend/incidentPipeline.js`
- `backend/decisionLedger.js`
- `backend/briefService.js`
- `backend/publicSourceExtractor.js`

## Local Setup

Requirements: Node.js and npm.

```powershell
npm install
npm start
```

Open `http://localhost:4173`.

Live mode requires a server-side Gonka API key. Do not expose secrets in frontend code.

Example environment:

```text
GONKA_API_KEY=your_key_here
GONKA_BASE_URL=https://api.gonkarouter.io/v1
GONKA_ANALYST_MODEL=deepseek-ai/DeepSeek-V4-Flash-0731
GONKA_REVIEWER_MODEL=MiniMaxAI/MiniMax-M2.7
GONKA_LIVE_ENABLED=true
```

For local development, `.env.local` may be used and must not be committed.

## Available Commands

| Command | Purpose |
|---|---|
| `npm start` | Start the server using process environment variables |
| `npm test` | Run all offline tests |
| `npm run smoke:frontend` | Offline frontend workflow smoke |
| `npm run smoke:judge` | Offline judge-demo smoke |
| `npm run smoke:decision` | Offline human-decision smoke |
| `npm run smoke:brief` | Offline brief/proof smoke |
| `npm run audit:release` | Offline release package audit |
| `npm run rehearse:live` | Explicitly authorized Live rehearsal; consumes model requests |

## API Routes

- `GET /api/health/ready` - deployment readiness without contacting Gonka
- `GET /api/health/gonka` - safe configured-capability status without inference
- `POST /api/incidents/analyze` - Live text analysis or fixed demo scenario analysis
- `POST /api/public-source/analyze` - safe public URL extraction followed by Live analysis
- `POST /api/incidents/:id/decision` - record a bounded human decision
- `GET /api/incidents/:id/audit` - retrieve the in-memory audit chain
- `POST /api/incidents/:id/brief` - generate deterministic Action Brief and Proof Capsule
- `POST /api/proof/verify` - verify local payload integrity

## Render Deployment

`render.yaml` defines the Render Web Service using `npm ci --omit=dev`, `npm start`, and `/api/health/ready`.

Production secrets belong in Render's server-side environment settings. Render supplies `PORT`; no persistent disk is configured.

Decision records, audit entries, briefs, and proof records are ephemeral and reset when the server process restarts.

## Testing

```powershell
npm test
npm run smoke:frontend
npm run smoke:judge
```

The test suite covers strict model contracts, blind-review isolation, Public URL retrieval and SSRF protections, safe errors, timeouts, response limits, consensus thresholds, safety gates, human decisions, audit integrity, Proof Capsule tampering, Replay provenance, production readiness, and offline judge workflows.

## Security and Privacy

- Gonka secrets remain server-side.
- Public URL fetching blocks localhost, private IP ranges, link-local targets, and unsafe redirects.
- Static files are served from an explicit allowlist.
- API responses use safe error messages and do not expose prompts, API keys, raw model output, or crisis report payloads.
- Security headers include CSP, clickjacking protection, MIME sniffing protection, referrer policy, and permissions policy.

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Known Limitations

- CrisisRoute AI is not an emergency service.
- No automatic real-world dispatch or emergency-service integration.
- No formal production identity/authentication layer.
- No persistent database; server records are ephemeral.
- Proof Capsule has no blockchain or external anchoring.
- Live inference depends on Gonka Router and upstream model availability.
- Replay is sanitized recorded data from an earlier accepted Live run, not a fresh Live run.

## Demo and Submission

Recommended Live demo text:

```text
An elderly man in Shah Alam is having severe breathing difficulty during heavy haze. His daughter says he is conscious but getting worse. Exact apartment number is still unknown, but she can be contacted by phone.
```

This demonstrates incomplete verification, high urgency, incomplete actionability, a medical red flag, the exact-location safety gate, blind dual-model verification, human decision, Action Brief, and Proof Capsule.

Submission links:

- Live Demo: [https://crisisroute-ai.onrender.com/](https://crisisroute-ai.onrender.com/)
- 2-Minute Demo Video: [https://youtu.be/6gbRJ5ldPRM](https://youtu.be/6gbRJ5ldPRM)
- GitHub Repository: [https://github.com/ykwooga-afk/CrisisRoute-AI](https://github.com/ykwooga-afk/CrisisRoute-AI)

## License

Licensed under the [MIT License](LICENSE).
