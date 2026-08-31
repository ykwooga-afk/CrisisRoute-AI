# CrisisRoute AI Handoff

The implementation source of truth is the root [README](README.md) and repository code. Historical DOCX planning files remain in `docs/` for context only.

## Current Status

| Capability | Status |
|---|---|
| Analyze | Implemented |
| Blind dual-model review | Implemented |
| Deterministic consensus and gates | Implemented |
| Human Decision | Implemented |
| In-memory audit chain | Implemented |
| Deterministic Brief | Implemented |
| Local Proof Capsule | Implemented |
| Frontend workflow | Implemented |
| Replay and failure recovery | Implemented |
| Deployment | Prepared, not yet published |

## Architecture Rule

The browser uses `src/services/crisisRouteClient.js` as its centralized adapter. Keep API access out of rendering code. Live, Replay, and Demo modes retain the same UI-facing Incident contract while preserving honest provenance labels.

## Operational Truth

- Live sends the fixed evidence independently to DeepSeek and Kimi through GonkaRouter.
- Replay is a sanitized deterministic record and makes no current inference request.
- Human decisions are recorded locally and never imply real-world execution.
- Audit, Brief, and Proof state is ephemeral and resets with the server.
- Proof Capsule is local payload-integrity evidence, not blockchain proof.
- Deployment configuration exists, but GitHub/Render publication belongs to B12-B.

## Start Here

1. Read [README.md](README.md).
2. Read [docs/GONKA_INTEGRATION.md](docs/GONKA_INTEGRATION.md).
3. Follow [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md).
4. Run `npm test` and `npm run audit:release` before any release.
