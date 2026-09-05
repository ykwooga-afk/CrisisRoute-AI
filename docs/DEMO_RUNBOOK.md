# Judge Demo Runbook

## Before Judging

- [ ] Wake the Render service and wait for the public page.
- [ ] Open `/api/health/ready`; continue with Live only when it returns HTTP 200 and `ok: true`.
- [ ] Open `/api/health/gonka`; confirm Live capabilities without triggering inference.
- [ ] Keep the Render environment/secret screen off the projector.
- [ ] Restart the service if a clean ephemeral Decision/Audit ledger is required.
- [ ] Confirm Sanitized Replay loads before considering Live.
- [ ] Prepare a screen recording of the accepted workflow.
- [ ] Remember that service restart clears Decision, Audit, Brief, and Proof state.

## Guaranteed Replay Route

1. Select **Open Sanitized Replay**.
2. Say: “This is a sanitized deterministic replay of an earlier accepted Live run; this load makes no network request.”
3. Show all five labelled cases.
4. Open CASE 03 and compare low Verification with high Urgency.
5. Show the safety gates keeping Dispatch locked until location/contact evidence is complete.
6. Open CASE 01 and explain why its evidence and operational details are stronger.
7. Record an allowed Human Decision with the required acknowledgements.
8. Show `RECORDED` and `NOT_EXECUTED`.
9. Generate the deterministic Brief.
10. Verify the local Proof Capsule, then demonstrate that a modified local copy fails verification.

## Optional Live Route

- Try Live only when readiness is green and the Analyze budget is available.
- State that one Analyze calls DeepSeek and MiniMax independently through Gonka Router.
- Click Analyze once and wait up to 60 seconds.
- Do not double-click, automatically retry, switch models, or imply that a timed-out call succeeded.
- If Live fails, show the safe error, choose **Open Sanitized Replay**, and explicitly say Replay is not the just-failed Live response.

## Recovery

| Situation | Safe response |
|---|---|
| Upstream timeout | Do not retry during judging; explain upstream dependency and open Replay. |
| HTTP 502 | Read only the safe failed-role/error code; open Replay. |
| `INVALID_MODEL_DATA` | Explain strict schema rejection; never show raw output; open Replay. |
| Render cold start | Wait for `/api/health/ready`; do not click Analyze while unready. |
| Analyze budget exhausted | Restart only if authorized and explain that the in-memory demo budget resets. Otherwise use Replay. |
| Server restart | Reopen the page; Decision/Audit/Brief/Proof state is intentionally reset. |
| Proof/Audit reset | Repeat the local Human Decision and Brief steps; do not claim persistence. |

## Closing Safety Line

“CrisisRoute AI separates uncertainty from urgency, keeps dispatch behind deterministic gates, and records the human decision without pretending that software executed a rescue.”
