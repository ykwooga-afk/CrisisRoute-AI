# GonkaRouter Integration

## Endpoint and Credentials

- Base URL: `https://api.gonkarouter.io/v1`
- Request path: `POST /chat/completions`
- Analyst: `deepseek-ai/DeepSeek-V4-Flash-0731`
- Reviewer: `MiniMaxAI/MiniMax-M2.7`

`GONKA_API_KEY` is read server-side. It is never included in browser responses, tracked files, debug headers, or public errors.

## Blind Dual-Model Flow

For one complete five-case Analyze, the pipeline starts exactly two requests in parallel. The Analyst and Reviewer receive the same original evidence. The Reviewer request is constructed before either result returns and contains no Analyst output, response ID, score, or rationale. There is no automatic retry.

The configured role timeouts are enforced independently by the Node client: CASE 01 allows 90 seconds per role; the five-case batch allows 90 seconds for the Analyst and 60 seconds for the Reviewer. The generic client default remains 20 seconds when a pipeline does not provide an override. A timeout, network failure, HTTP failure, or invalid structured response fails safely and preserves the allowlisted failed role when known. Live inference remains dependent on GonkaRouter and upstream model availability.

## Structured Contracts

The Analyst canonical batch shape is an object containing five cases. Each case has `label`, all three `scores`, and bounded `riskFlags`/`unknowns`. The Reviewer canonical batch shape is an object containing five labelled score objects. CASE 01 uses the corresponding single-role object contracts.

The client extracts bounded JSON Object/Array candidates using string-aware, escape-aware balanced scanning. It supports fenced or prose-wrapped JSON and one JSON-string unwrap, retains at most eight candidates, and enforces a nesting limit. Raw candidate text is not logged or returned in errors.

Role-aware selection validates every candidate independently:

- One valid normalized candidate is accepted.
- Multiple candidates that normalize identically are accepted once.
- Multiple different valid candidates fail as ambiguous.
- No valid candidate fails safely.

The Full Scenario allowlist accepts the canonical `{ "cases": [...] }` wrapper or a direct five-item Array. Direct Arrays require exactly five ordinary objects with exact unique labels `01`–`05`; ordering may differ because output is restored to canonical label order. Missing, duplicate, or extra labels are rejected.

## Score and Consensus Rules

Verification, urgency, and actionability must each be finite numbers from 0–100. Pure numeric strings and the implemented camelCase/snake_case aliases are normalized. Missing, Boolean, object, array, nonnumeric, infinite, or out-of-range values are rejected—never clamped or defaulted.

Consensus is deterministic: maximum role gap `0–15` is `AGREEMENT`, `16–30` is `DISAGREEMENT`, and above `30` is `CRITICAL_CONFLICT`. Deterministic safety gates, not model prose, control operational eligibility.

## Safe Errors and Observability

Public errors expose only safe code, retryability, `failedRole` (`analyst`, `reviewer`, or `both`), allowlisted `roleErrors`, and bounded validation issue paths. They never expose prompt, candidate value, raw model content, stack, cause, or credentials.

Successful Live incidents include each role's safe model ID, Gonka Response ID, prompt version, and latency. Response IDs support observability only; they are not proof of factual truth, execution, or blockchain anchoring.

## Replay Boundary

Replay loads a sanitized deterministic record of an earlier accepted Live run. The current Replay load does not call Gonka, and the UI labels it as Replay rather than presenting it as fresh Live output.
