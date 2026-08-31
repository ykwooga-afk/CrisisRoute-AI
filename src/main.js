import {
  DATA_MODES,
  analyzeIncidents,
  generateActionBrief,
  getCaseAudit,
  getGonkaHealth,
  loadHazeScenario,
  submitHumanDecision,
  verifyProofCapsule
} from "./services/crisisRouteClient.js";
import {
  acknowledgementRequirements,
  actionsForState,
  applyAuditResult,
  applyBriefFailure,
  applyBriefSuccess,
  applyDecisionFailure,
  applyDecisionSuccess,
  applyProofVerification,
  beginBriefRetry,
  beginDecisionSubmission,
  createWorkflowState,
  displayRules,
  liveReadiness,
  safeReceiptExport
} from "./ui/decisionWorkflow.js";
import {
  CANCEL_SCOPE_COPY,
  RESET_SCOPE_COPY,
  analyzeProgress,
  beginLiveAttempt,
  completeLiveAttempt,
  createReliabilityState,
  failLiveAttempt,
  judgeWalkthroughState,
  modeProvenance,
  openSanitizedReplay,
  replayTraceLabels,
  shouldApplyLiveResult
} from "./ui/demoReliability.js";

const VIEWS = {
  command: "command",
  intelligence: "intelligence",
  evidence: "evidence",
  safety: "safety",
  action: "action"
};

const state = {
  currentView: VIEWS.command,
  mode: DATA_MODES.mock,
  incidents: [],
  resources: [],
  selectedCaseId: null,
  selectedEvidenceId: null,
  selectedLanguage: "en",
  intakeValue: "",
  loading: false,
  error: null,
  health: null,
  toast: null,
  decisionWorkflows: {},
  reliability: createReliabilityState(DATA_MODES.mock),
  replayMeta: null,
  liveProgress: null
};

let liveAttemptSequence = 0;
let liveAbortController = null;
let liveProgressTimer = null;

const app = document.querySelector("#app");

const viewLabels = {
  [VIEWS.command]: "Command Center",
  [VIEWS.intelligence]: "Case Intelligence",
  [VIEWS.evidence]: "Evidence",
  [VIEWS.safety]: "Safety",
  [VIEWS.action]: "Action Brief"
};

const statusLabels = {
  DISPATCH_CANDIDATE: "DISPATCH CANDIDATE",
  URGENT_VERIFICATION: "URGENT VERIFICATION",
  NEEDS_HUMAN_REVIEW: "NEEDS HUMAN REVIEW",
  MERGE_OR_VERIFY: "MERGE DUPLICATE",
  QUEUED_ACTION: "QUEUED ACTION"
};

const claimStatusLabels = {
  supported: "SUPPORTED",
  partially_supported: "PARTIAL",
  partially_corroborated: "PARTIAL",
  plausible: "PLAUSIBLE",
  reported: "REPORTED",
  reported_unverified: "REPORTED · UNVERIFIED",
  unverified: "UNVERIFIED",
  unverifiable: "UNVERIFIABLE",
  contradicted: "CONTRADICTION"
};

const gateStatusLabels = {
  triggered: "TRIGGERED",
  blocked: "BLOCKED",
  passed: "PASSED",
  locked: "LOCKED"
};

async function init() {
  state.intakeValue = [
    "Family near Shah Alam says an elderly parent has breathing difficulty due to haze. Exact location and callback number are unclear.",
    "Block C hostel: six students are coughing badly, one has asthma. Need N95 masks and clinic transport."
  ].join("\n");
  await withLoading(() => loadDemoScenario());
  await refreshHealth();
  bindEvents();
}

function bindEvents() {
  app.addEventListener("submit", event => {
    if (event.target.matches(".decision-form")) event.preventDefault();
  });

  app.addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    const caseTarget = event.target.closest("[data-case-id]");
    const evidenceTarget = event.target.closest("[data-evidence-id]");

    if (caseTarget && !button) {
      selectIncident(caseTarget.dataset.caseId);
      render();
      return;
    }

    if (evidenceTarget && !button) {
      state.selectedEvidenceId = evidenceTarget.dataset.evidenceId;
      render();
      return;
    }

    if (!button) return;

    const action = button.dataset.action;

    if (action === "view") {
      state.currentView = button.dataset.view;
      ensureEvidenceSelection();
      render();
      return;
    }

    if (action === "load-demo") {
      state.mode = DATA_MODES.mock;
      state.reliability = createReliabilityState(DATA_MODES.mock);
      state.replayMeta = null;
      await withLoading(() => loadDemoScenario());
      return;
    }

    if (action === "verify-input") {
      await handleVerifyInput();
      return;
    }

    if (action === "mode") {
      await loadModeScenario(button.dataset.mode);
      return;
    }

    if (action === "retry-live") {
      await retryLiveAnalyze();
      return;
    }

    if (action === "open-sanitized-replay") {
      await openReplayFromRecovery();
      return;
    }

    if (action === "cancel-live-wait") {
      cancelLiveUiWait();
      return;
    }

    if (action === "reset-browser-view") {
      resetBrowserView();
      return;
    }

    if (action === "select-evidence") {
      state.selectedEvidenceId = button.dataset.evidenceId;
      render();
      return;
    }

    if (action === "language") {
      state.selectedLanguage = button.dataset.lang;
      render();
      return;
    }

    if (action === "decision") {
      state.currentView = VIEWS.safety;
      render();
      return;
    }

    if (action === "decision-submit") {
      await handleDecisionSubmission();
      return;
    }

    if (action === "decision-reset") {
      resetDecisionForm();
      return;
    }

    if (action === "retry-brief") {
      await retryBrief();
      return;
    }

    if (action === "verify-proof") {
      await verifyCurrentProof();
      return;
    }

    if (action === "export-receipt") {
      exportCurrentReceipt();
    }
  });

  app.addEventListener("input", event => {
    if (event.target.matches("#verify-input")) {
      state.intakeValue = event.target.value;
      return;
    }
    const workflow = getDecisionWorkflow();
    if (workflow && event.target.matches("#human-reason")) {
      workflow.form.reason = event.target.value;
      workflow.form.errors = [];
    }
  });

  app.addEventListener("change", event => {
    const workflow = getDecisionWorkflow();
    if (!workflow) return;
    if (event.target.matches("#human-action")) {
      workflow.form.action = event.target.value;
      workflow.form.acknowledgeHumanDecision = false;
      workflow.form.acknowledgeNoAutomaticExecution = false;
      workflow.form.acknowledgeReview = false;
      workflow.form.errors = [];
      render();
      return;
    }
    const acknowledgement = event.target.dataset.acknowledgement;
    if (acknowledgement) {
      workflow.form[acknowledgement] = event.target.checked;
      workflow.form.errors = [];
    }
  });
}

async function loadDemoScenario() {
  state.error = null;
  const result = await loadHazeScenario(DATA_MODES.mock);
  state.incidents = result.incidents || [];
  state.resources = result.resources || [];
  state.decisionWorkflows = {};
  selectIncident(findCaseByLabel("03")?.caseId || state.incidents[0]?.caseId || null);
  state.currentView = VIEWS.command;
  showToast("Malaysia haze demo loaded. CASE 03 selected.");
}

async function loadModeScenario(mode) {
  if (mode === DATA_MODES.mock) {
    state.mode = DATA_MODES.mock;
    state.reliability = createReliabilityState(DATA_MODES.mock);
    state.replayMeta = null;
    await withLoading(() => loadDemoScenario());
    return;
  }
  if (mode === DATA_MODES.replay) {
    await withLoading(async () => {
      const result = await loadHazeScenario(DATA_MODES.replay);
      state.mode = DATA_MODES.replay;
      state.reliability = openSanitizedReplay(state.reliability);
      state.replayMeta = result.meta || null;
      applyScenarioResult(result, "03");
      showToast("Sanitized acceptance replay opened locally. Network requests: 0.");
    });
    return;
  }
  if (mode !== DATA_MODES.live) return;

  await refreshHealth();
  const readiness = liveReadiness(state.health);
  if (!readiness.ready) {
    const requestId = `live-readiness-${++liveAttemptSequence}`;
    state.reliability = beginLiveAttempt(state.reliability, { requestId, messages: [] });
    state.reliability = failLiveAttempt(state.reliability, {
      status: 503,
      code: "HTTP_ERROR",
      message: `Live readiness is incomplete: ${readiness.missing.join(", ")}.`,
      retryable: false,
      failedRole: "not_available"
    }, requestId);
    render();
    return;
  }
  await runLiveAnalyze({ kind: "fixed", messages: [] });
}

async function handleVerifyInput() {
  const messages = state.intakeValue
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  if (state.mode === DATA_MODES.replay) {
    await loadModeScenario(DATA_MODES.replay);
    return;
  }

  if (!messages.length && state.mode !== DATA_MODES.live) {
    showToast("Paste crisis report text first.");
    return;
  }

  if (state.mode === DATA_MODES.live) {
    await refreshHealth();
    if (!liveReadiness(state.health).ready) {
      await loadModeScenario(DATA_MODES.live);
      return;
    }
    await runLiveAnalyze({ kind: "fixed", messages: [] });
    return;
  }

  state.error = null;
  await withLoading(async () => {
    const result = await analyzeIncidents(messages, state.mode);
    applyScenarioResult(result, null);
    state.currentView = VIEWS.intelligence;
    showToast(state.mode === DATA_MODES.replay
      ? "Sanitized replay remains local; no current inference was performed."
      : "Synthetic demo analysis generated by the local adapter.");
  });
}

function applyScenarioResult(result, preferredLabel) {
  state.incidents = result.incidents || [];
  state.resources = result.resources || state.resources;
  state.decisionWorkflows = {};
  const preferred = preferredLabel ? findCaseByLabel(preferredLabel)?.caseId : null;
  selectIncident(preferred || state.incidents[0]?.caseId || null);
}

async function runLiveAnalyze(requestSpec) {
  if (state.reliability.phase === "live_wait") return;
  const requestId = `live-attempt-${++liveAttemptSequence}`;
  const requestedCaseSet = state.selectedCaseId || "no-selected-case";
  const messages = Array.isArray(requestSpec.messages) ? requestSpec.messages : [];
  state.reliability = beginLiveAttempt(state.reliability, { requestId, messages });
  state.liveProgress = { requestId, startedAt: Date.now(), requestedCaseSet };
  state.error = null;
  state.replayMeta = null;
  liveAbortController = new AbortController();
  clearLiveProgressTimer();
  liveProgressTimer = window.setInterval(() => {
    if (state.liveProgress?.requestId === requestId) render();
  }, 1_000);
  render();

  try {
    const result = requestSpec.kind === "fixed"
      ? await loadHazeScenario(DATA_MODES.live, { signal: liveAbortController.signal })
      : await analyzeIncidents(messages, DATA_MODES.live, { signal: liveAbortController.signal });
    const canApply = shouldApplyLiveResult({
      requestId,
      activeRequestId: state.reliability.activeRequestId,
      requestedCaseSet,
      activeCaseSet: state.selectedCaseId || "no-selected-case"
    });
    if (!canApply) return;
    state.reliability = completeLiveAttempt(state.reliability, requestId);
    state.mode = DATA_MODES.live;
    applyScenarioResult(result, requestSpec.kind === "fixed" ? "03" : null);
    state.currentView = VIEWS.intelligence;
    showToast("Live five-case analysis returned. Human action is still required.");
  } catch (error) {
    state.reliability = failLiveAttempt(state.reliability, error, requestId);
    showToast(error?.code === "CLIENT_WAIT_CANCELLED"
      ? "Browser wait stopped. Server or remote cancellation is not confirmed."
      : "Live attempt failed safely. No Retry or Replay fallback was automatic.");
  } finally {
    if (state.liveProgress?.requestId === requestId) state.liveProgress = null;
    clearLiveProgressTimer();
    liveAbortController = null;
    render();
  }
}

async function retryLiveAnalyze() {
  const failure = state.reliability.lastFailure;
  if (!failure?.retry?.allowed || state.reliability.phase === "live_wait") return;
  await refreshHealth();
  if (!liveReadiness(state.health).ready) {
    showToast("Manual Retry is unavailable until LIVE capabilities are ready.");
    return;
  }
  const messages = state.reliability.lastLiveMessages || [];
  await runLiveAnalyze({ kind: messages.length ? "custom" : "fixed", messages });
}

async function openReplayFromRecovery() {
  await loadModeScenario(DATA_MODES.replay);
}

function cancelLiveUiWait() {
  if (!liveAbortController || !state.liveProgress) return;
  liveAbortController.abort();
}

function resetBrowserView() {
  state.currentView = VIEWS.command;
  state.error = null;
  state.toast = null;
  state.reliability = createReliabilityState(state.mode);
  state.liveProgress = null;
  clearLiveProgressTimer();
  render();
}

function clearLiveProgressTimer() {
  if (liveProgressTimer !== null) window.clearInterval(liveProgressTimer);
  liveProgressTimer = null;
}

async function handleDecisionSubmission() {
  const incident = getSelectedIncident();
  if (!incident) return;
  const caseId = incident.caseId;
  let workflow = beginDecisionSubmission(getDecisionWorkflow(incident), incident);
  setDecisionWorkflow(caseId, workflow);
  render();
  if (workflow.phase !== "decision_loading") {
    showToast("Review the Human Decision form before submitting.");
    return;
  }
  try {
    const response = await submitHumanDecision(
      incident,
      {
        action: workflow.form.action,
        reason: workflow.form.reason,
        acknowledgeHumanDecision: workflow.form.acknowledgeHumanDecision,
        acknowledgeNoAutomaticExecution: workflow.form.acknowledgeNoAutomaticExecution,
        acknowledgeReview: workflow.form.acknowledgeReview
      },
      state.mode,
      workflow.submissionIdentity.idempotencyKey
    );
    if (state.selectedCaseId !== caseId) return;
    workflow = applyDecisionSuccess(workflow, response, caseId);
    setDecisionWorkflow(caseId, workflow);
    updateIncident(caseId, {
      humanDecision: {
        decision: response.decision.action,
        reason: response.decision.reason,
        decidedAt: response.decision.recordedAt,
        decidedBy: state.mode === DATA_MODES.live ? "Demo local operator" : "Demo-only operator",
        recordStatus: response.decision.recordStatus,
        executionStatus: response.decision.executionStatus,
        requiresExternalExecution: response.decision.requiresExternalExecution,
        decisionId: response.decision.decisionId,
        entryHash: response.decision.entryHash
      }
    });
    render();
    await fetchBriefAndAudit(caseId);
  } catch (error) {
    if (state.selectedCaseId !== caseId) return;
    workflow = applyDecisionFailure(workflow, error, caseId);
    setDecisionWorkflow(caseId, workflow);
    showToast("Decision was not recorded. Review the safe error and retry.");
    render();
  }
}

async function fetchBriefAndAudit(caseId) {
  let workflow = state.decisionWorkflows[caseId];
  const incident = state.incidents.find(item => item.caseId === caseId);
  if (!workflow?.decision || !incident) return;
  try {
    const result = await generateActionBrief(incident, workflow.decision, state.mode);
    if (state.selectedCaseId !== caseId) return;
    workflow = applyBriefSuccess(workflow, result, caseId);
    setDecisionWorkflow(caseId, workflow);
    updateIncident(caseId, {
      operationalBrief: result.brief,
      proofCapsule: result.proofCapsule,
      actionBrief: { en: [result.brief.summary, ...(result.brief.nextSteps || [])].join(" ") }
    });
  } catch (error) {
    if (state.selectedCaseId !== caseId) return;
    workflow = applyBriefFailure(workflow, error, caseId);
    setDecisionWorkflow(caseId, workflow);
  }
  try {
    const audit = await getCaseAudit(caseId, state.mode, workflow.decision);
    if (state.selectedCaseId !== caseId) return;
    workflow = applyAuditResult(state.decisionWorkflows[caseId], audit, caseId);
    setDecisionWorkflow(caseId, workflow);
    updateIncident(caseId, { decisionAudit: audit });
  } catch {
    if (state.selectedCaseId === caseId) {
      workflow = state.decisionWorkflows[caseId];
      setDecisionWorkflow(caseId, { ...workflow, auditStatus: "UNAVAILABLE" });
    }
  }
  if (state.selectedCaseId === caseId) {
    state.currentView = workflow.briefStatus === "READY" ? VIEWS.action : VIEWS.safety;
    showToast(workflow.briefStatus === "READY"
      ? "Decision recorded. Deterministic Brief and Audit loaded."
      : "Decision recorded. Brief unavailable; retry will not resubmit the Decision.");
    render();
  }
}

async function retryBrief() {
  const incident = getSelectedIncident();
  if (!incident) return;
  const caseId = incident.caseId;
  const workflow = beginBriefRetry(getDecisionWorkflow(incident));
  setDecisionWorkflow(caseId, workflow);
  render();
  if (workflow.phase !== "brief_loading") return;
  await fetchBriefAndAudit(caseId);
}

async function verifyCurrentProof() {
  const incident = getSelectedIncident();
  const workflow = getDecisionWorkflow(incident);
  const rules = displayRules(workflow);
  if (!incident || !rules.proofVerificationEnabled) {
    showToast("Proof verification is unavailable outside a server-issued LIVE Capsule.");
    return;
  }
  setDecisionWorkflow(incident.caseId, { ...workflow, proofStatus: "VERIFYING" });
  render();
  try {
    const result = await verifyProofCapsule({ brief: workflow.brief, proofCapsule: workflow.proofCapsule });
    if (state.selectedCaseId !== incident.caseId) return;
    setDecisionWorkflow(incident.caseId, applyProofVerification(workflow, result));
    showToast(result.valid ? "Local payload is unchanged." : "Proof payload or reference changed.");
  } catch {
    if (state.selectedCaseId !== incident.caseId) return;
    setDecisionWorkflow(incident.caseId, { ...workflow, proofStatus: "UNAVAILABLE" });
    showToast("Local Proof verification is unavailable.");
  }
  render();
}

function resetDecisionForm() {
  const incident = getSelectedIncident();
  if (!incident) return;
  state.decisionWorkflows[incident.caseId] = createWorkflowState(incident, state.mode);
  render();
}

function exportCurrentReceipt() {
  const incident = getSelectedIncident();
  const workflow = getDecisionWorkflow(incident);
  const receipt = safeReceiptExport({
    mode: state.mode,
    caseId: incident?.caseId,
    brief: workflow?.brief,
    proofCapsule: workflow?.proofCapsule,
    audit: workflow?.audit
  });
  if (!receipt) {
    showToast("Receipt export requires a server-issued LIVE Brief, Capsule and Audit.");
    return;
  }
  const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `crisisroute-${incident.caseId.toLowerCase()}-receipt.json`;
  link.click();
  URL.revokeObjectURL(downloadUrl);
  showToast("Safe local receipt JSON exported.");
}

async function refreshHealth() {
  state.health = await getGonkaHealth();
  render();
}

async function withLoading(fn) {
  state.loading = true;
  render();
  try {
    await fn();
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  const incident = getSelectedIncident();
  app.innerHTML = `
    <div class="app-shell">
      ${renderTopNavigation()}
      ${state.error ? `<div class="system-alert">${escapeHtml(state.error)}</div>` : ""}
      ${renderModeTrustPanel()}
      ${renderReliabilityPanel()}
      ${renderJudgeWalkthrough()}
      ${renderCurrentView(incident)}
      ${state.toast ? `<div class="toast" role="status">${escapeHtml(state.toast)}</div>` : ""}
      ${state.loading ? `<div class="loading-indicator" aria-live="polite">Processing</div>` : ""}
    </div>
  `;
}

function renderModeTrustPanel() {
  const provenance = modeProvenance(state.mode);
  const replayLabels = state.mode === DATA_MODES.replay ? replayTraceLabels(state.replayMeta || {}) : null;
  return `
    <section class="mode-trust-panel mode-${escapeHtml(state.mode)}" aria-label="Current mode provenance">
      <div>
        <span class="section-kicker">${escapeHtml(provenance.mode)} TRUST LABEL</span>
        <strong>${escapeHtml(provenance.title)}</strong>
      </div>
      <ul>${provenance.lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      ${replayLabels ? `<p>${escapeHtml(replayLabels.source)} · ${escapeHtml(replayLabels.network)} · ${escapeHtml(replayLabels.responseIds)}</p>` : ""}
      <button type="button" class="text-link" data-action="reset-browser-view">Reset browser view</button>
      <small>${escapeHtml(RESET_SCOPE_COPY)}</small>
    </section>
  `;
}

function renderReliabilityPanel() {
  if (state.liveProgress) {
    const progress = analyzeProgress(Date.now() - state.liveProgress.startedAt, { cancelSupported: true });
    return `
      <section class="reliability-panel progress-panel" aria-live="polite" aria-busy="true">
        <div>
          <span class="section-kicker">LIVE ANALYZE · ${escapeHtml(progress.elapsedSeconds)}s elapsed</span>
          <h2>${escapeHtml(progress.stage)}</h2>
          <p>These are workflow explanations, not server-confirmed internal model progress.</p>
          <p>${escapeHtml(progress.blindReviewStatement)} No automatic Retry will occur.</p>
        </div>
        <ol>${progress.stages.map((stage, index) => `<li class="${index === progress.stageIndex ? "active" : ""}">${escapeHtml(stage)}</li>`).join("")}</ol>
        <button type="button" class="secondary-action" data-action="cancel-live-wait">Cancel UI Wait</button>
        <small>${escapeHtml(CANCEL_SCOPE_COPY)}</small>
      </section>
    `;
  }
  const failure = state.reliability.lastFailure;
  if (!failure) return "";
  return `
    <section class="reliability-panel failure-panel" role="alert">
      <div>
        <span class="section-kicker">SAFE LIVE FAILURE</span>
        <h2>${escapeHtml(failure.headline)}</h2>
        <p>${escapeHtml(failure.message)}</p>
        <p>${escapeHtml(failure.roleLine)} · HTTP ${escapeHtml(failure.status || "not available")}</p>
        ${failure.roleErrors ? `<p>Role errors: ${escapeHtml(Object.entries(failure.roleErrors).map(([role, code]) => `${role}=${code}`).join(" · "))}</p>` : ""}
        <p>${escapeHtml(failure.retryLine)}</p>
        ${state.reliability.cancelledUiWait ? `<p>${escapeHtml(CANCEL_SCOPE_COPY)}</p>` : ""}
      </div>
      <div class="recovery-actions">
        <button type="button" class="primary-action" data-action="retry-live" ${failure.retry.allowed ? "" : "disabled"}>Retry Live</button>
        <button type="button" class="secondary-action" data-action="open-sanitized-replay">Open Sanitized Replay</button>
      </div>
      <small>Existing ${escapeHtml(modeLabel(state.mode))} data remains unchanged. Replay opens only after an explicit operator click.</small>
    </section>
  `;
}

function renderJudgeWalkthrough() {
  const workflows = Object.values(state.decisionWorkflows);
  const steps = judgeWalkthroughState({
    incidentCount: state.incidents.length,
    independentScoresVisible: state.incidents.length === 5 && state.incidents.every(incident => incident.modelReviews?.analyst?.scores && incident.modelReviews?.reviewer?.scores),
    decisionRecorded: workflows.some(workflow => workflow.decisionStatus === "RECORDED"),
    briefReady: workflows.some(workflow => workflow.briefStatus === "READY"),
    proofChecked: workflows.some(workflow => ["VALID", "INVALID"].includes(workflow.proofStatus))
  });
  return `
    <details class="judge-walkthrough">
      <summary>Judge Walkthrough — operator guide only</summary>
      <ol>
        ${steps.map(step => `<li class="${step.completed ? "completed" : "pending"}"><span>${step.completed ? "Completed" : "Pending"}</span> ${escapeHtml(step.number)}. ${escapeHtml(step.label)}</li>`).join("")}
      </ol>
      <p>This guide does not click, submit a Human Decision, check acknowledgements, bypass a Safety Gate, or claim real-world execution.</p>
    </details>
  `;
}

function renderTopNavigation() {
  return `
    <header class="top-nav">
      <div class="nav-upper">
        <div class="brand-area">
          <img class="brand-logo" src="src/assets/crisisroute-logo.png" alt="" aria-hidden="true" />
          <strong>CrisisRoute AI</strong>
          <span>Malaysia Haze Response</span>
        </div>
        <div class="mode-area">
          <div class="mode-switch" aria-label="Mode selector">
            ${Object.values(DATA_MODES)
              .map(
                mode => `
                  <button class="${state.mode === mode ? "active" : ""}" data-action="mode" data-mode="${mode}">
                    ${escapeHtml(shortModeLabel(mode))}
                  </button>
                `
              )
              .join("")}
          </div>
          <span class="mode-pill">MODE: ${escapeHtml(modeLabel(state.mode))}</span>
          <span class="gonka-pill ${gonkaTone()}">Gonka: ${escapeHtml(gonkaLabel())}</span>
          <span class="avatar">AR</span>
        </div>
      </div>
      <nav class="view-nav" aria-label="Product navigation">
        ${Object.entries(viewLabels)
          .map(
            ([view, label]) => `
              <button class="${state.currentView === view ? "active" : ""}" data-action="view" data-view="${view}">
                ${escapeHtml(label)}
              </button>
            `
          )
          .join("")}
      </nav>
    </header>
  `;
}

function renderCurrentView(incident) {
  if (!incident) {
    return `
      <main class="page-canvas">
        <section class="empty-page">
          <h1>CrisisRoute AI</h1>
          <p>No incident loaded yet.</p>
          <button class="primary-action" data-action="load-demo">Load Malaysia Haze Demo</button>
        </section>
      </main>
    `;
  }

  if (state.currentView === VIEWS.intelligence) return renderCaseIntelligence(incident);
  if (state.currentView === VIEWS.evidence) return renderEvidenceView(incident);
  if (state.currentView === VIEWS.safety) return renderSafetyView(incident);
  if (state.currentView === VIEWS.action) return renderActionBriefView(incident);
  return renderCommandCenter(incident);
}

function renderCommandCenter(incident) {
  return `
    <main class="page-canvas command-center">
      ${renderStatusLine()}
      ${renderWorkflowRail("Safety Gate")}
      <section class="command-grid">
        <aside class="incident-queue" aria-label="Incident Queue">
          <h2 class="section-kicker">Incident Queue</h2>
          ${state.incidents.map(renderQueueItem).join("")}
        </aside>
        <section class="command-main-panel">
          ${renderSelectedCaseSummary(incident)}
          ${renderThreeAxisScores(incident, "command")}
          ${renderKeyInsight(incident)}
        </section>
        <aside class="safety-assessment">
          ${renderSafetyAssessment(incident)}
        </aside>
      </section>
      ${renderVerifyInput()}
    </main>
  `;
}

function renderStatusLine() {
  const reviewCount = countByState("NEEDS_HUMAN_REVIEW");
  const urgentCount = countByState("URGENT_VERIFICATION");
  const dispatchCount = countByState("DISPATCH_CANDIDATE");
  const masks = state.resources.find(resource => resource.id === "res_masks")?.available || 0;

  return `
    <section class="status-line" aria-label="Incident summary">
      <strong>${state.incidents.length} Active Incidents</strong>
      <span class="divider"></span>
      <span><i class="dot violet"></i>${reviewCount} Needs Human Review</span>
      <span class="divider"></span>
      <span><i class="dot amber"></i>${urgentCount} Urgent Verification</span>
      <span class="divider"></span>
      <span><i class="dot green"></i>${dispatchCount} Dispatch Candidate</span>
      <span class="divider"></span>
      <span>${masks} N95 Masks Available</span>
    </section>
  `;
}

function renderWorkflowRail(activeLabel) {
  const items = ["Incoming", "Evidence", "Blind AI Review", "Safety Gate", "Human Decision", "Action Brief"];
  return `
    <section class="workflow-rail" aria-label="Workflow">
      ${items
        .map(
          (item, index) => `
            <span class="${item === activeLabel ? "active" : ""}">
              <i class="dot ${item === activeLabel ? "amber" : ""}"></i>${escapeHtml(item)}
            </span>
            ${index < items.length - 1 ? "<b>--></b>" : ""}
          `
        )
        .join("")}
    </section>
  `;
}

function renderQueueItem(incident) {
  const active = incident.caseId === state.selectedCaseId ? "active" : "";
  const status = statusLabels[incident.operationalState] || normalizeLabel(incident.operationalState);
  const subtitle = queueSubtitle(incident);

  return `
    <article class="queue-item ${active}" data-case-id="${escapeHtml(incident.caseId)}" tabindex="0">
      <div class="queue-meta">
        <span>CASE ${escapeHtml(incident.label)}</span>
        <b class="${stateClass(incident.operationalState)}">${escapeHtml(status)}</b>
      </div>
      <h3>${escapeHtml(incident.title)}</h3>
      <p>${escapeHtml(subtitle)}</p>
      <small>${scoreText(incident)}</small>
    </article>
  `;
}

function renderSelectedCaseSummary(incident) {
  return `
    <article class="selected-case-summary">
      <span class="section-kicker">CASE ${escapeHtml(incident.label)}</span>
      <h1>${escapeHtml(incident.title)}</h1>
      <div class="case-meta-line">
        <span>${escapeHtml(incident.location || "Location unknown")}</span>
        ${incident.coordinates ? `<span>${escapeHtml(incident.coordinates)}</span>` : ""}
        ${incident.aqi ? `<span class="aqi">AQI ${escapeHtml(String(incident.aqi))}</span>` : ""}
      </div>
      <p class="source-line">${escapeHtml(incident.source)} · Received ${formatTime(incident.receivedAt)}</p>
      <blockquote>${escapeHtml(incident.rawMessage)}</blockquote>
      <div class="knowledge-grid">
        <div>
          <h2>What We Know</h2>
          <ul class="known-list">
            ${listItems(incident.knownFacts || [])}
          </ul>
        </div>
        <div>
          <h2 class="red-title">What We Don't Know</h2>
          <ul class="unknown-list">
            ${listItems(incident.unknownFacts || incident.missingFields || [])}
          </ul>
        </div>
      </div>
    </article>
  `;
}

function renderThreeAxisScores(incident, variant = "default") {
  return `
    <section class="three-axis ${variant}">
      ${renderScoreAxis("Verification", incident.scores.verification, "Limited evidence", "verification")}
      ${renderScoreAxis("Urgency", incident.scores.urgency, urgencyCaption(incident), "urgency")}
      ${renderScoreAxis("Actionability", incident.scores.actionability, actionabilityCaption(incident), "actionability")}
    </section>
  `;
}

function renderScoreAxis(label, value, caption, type) {
  return `
    <article class="score-axis ${type}">
      <div class="score-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value))}</strong>
      </div>
      <div class="score-track" aria-hidden="true">
        <i style="width:${Number(value)}%"></i>
      </div>
      <p>${escapeHtml(caption)}</p>
    </article>
  `;
}

function renderKeyInsight(incident) {
  return `
    <section class="key-insight">
      <span class="section-kicker">Key Insight</span>
      <h2>LOW VERIFICATION</h2>
      <strong>≠</strong>
      <h2>LOW URGENCY</h2>
      <p>${escapeHtml(insightCopy(incident))}</p>
      <div class="operational-state">
        <span>Operational State</span>
        <b class="${stateClass(incident.operationalState)}">${escapeHtml(statusLabels[incident.operationalState] || normalizeLabel(incident.operationalState))}</b>
      </div>
    </section>
  `;
}

function renderSafetyAssessment(incident) {
  const dispatchBlocked = isDispatchBlocked(incident);
  return `
    <section>
      <h2 class="section-kicker">Safety Assessment</h2>
      <div class="assessment-list">
        ${assessmentRow(incident, "G_MEDICAL")}
        ${assessmentRow(incident, "G_LOCATION")}
        ${assessmentRow(incident, "G_CONTACT")}
        ${assessmentRow(incident, "G_RESOURCE")}
        ${assessmentRow(incident, "G_DISPATCH")}
      </div>
      <p class="recommendation">${escapeHtml(incident.recommendedAction)}</p>
      <div class="decision-stack">
        <button class="primary-action" data-action="view" data-view="safety">Open Human Decision Form</button>
        <p class="honesty-note">No action is recorded until a human completes and submits the form.</p>
      </div>
      <div class="case-link-summary">
        <span>${incident.claims.length} claims · ${supportedClaimCount(incident)} supported · ${unverifiedClaimCount(incident)} unverified</span>
        <button data-action="view" data-view="intelligence">→ Inspect Case</button>
      </div>
    </section>
  `;
}

function assessmentRow(incident, gateId) {
  const gate = getGate(incident, gateId);
  if (!gate) return "";
  const status = gate.status || (gate.passed ? "passed" : "blocked");
  return `
    <div class="assessment-row">
      <span>${escapeHtml(gate.label)}</span>
      <b class="gate-status ${status}">${escapeHtml(gateStatusLabels[status] || normalizeLabel(status))}</b>
    </div>
  `;
}

function renderVerifyInput() {
  const buttonLabel = state.mode === DATA_MODES.live
    ? "Analyze Five Fixed Reports"
    : state.mode === DATA_MODES.replay
      ? "Reload Sanitized Replay"
      : "Run Synthetic Demo Analysis";
  return `
    <section class="verify-panel">
      <h2 class="section-kicker">Verify a Crisis Report</h2>
      <p>Paste crisis report text. Public URL content retrieval is not included in this demo.</p>
      <textarea id="verify-input" placeholder="Paste a Telegram message, WhatsApp report, or emergency text...">${escapeHtml(state.intakeValue)}</textarea>
      <div class="verify-actions">
        <button class="primary-action" data-action="verify-input">${escapeHtml(buttonLabel)}</button>
        <button class="secondary-action" data-action="load-demo">Load Malaysia Haze Demo</button>
      </div>
      <small>${escapeHtml(modeFootnote())}</small>
    </section>
  `;
}

function renderCaseIntelligence(incident) {
  return `
    <main class="page-canvas intelligence-page">
      <section class="case-intel-header">
        <span class="section-kicker">CASE ${escapeHtml(incident.label)}</span>
        <h1>${escapeHtml(incident.title)}</h1>
        ${renderMetadataLine(incident)}
      </section>
      ${renderThreeAxisScores(incident, "intelligence")}
      <p class="editorial-quote">"${escapeHtml(incident.insight || insightCopy(incident))}"</p>
      <section class="text-section">
        <h2 class="section-kicker">Why This Case Is Prioritized</h2>
        <p>${escapeHtml(incident.priorityRationale || incident.recommendedAction)}</p>
      </section>
      <section class="claims-section">
        <h2 class="section-kicker">Extracted Claims</h2>
        <div class="claims-table">
          ${incident.claims.map(claim => renderClaimRow(claim)).join("")}
        </div>
      </section>
      <section class="intel-bottom-grid">
        <div>
          <h2 class="section-kicker red">Missing Information</h2>
          <ul class="missing-list">${listItems(incident.missingFields || [])}</ul>
        </div>
        <div>
          <h2 class="section-kicker">Risk Flags</h2>
          <div class="risk-tags">${(incident.riskFlags || []).map(flag => `<span>${escapeHtml(flag)}</span>`).join("")}</div>
        </div>
      </section>
      <button class="primary-action wide-cta" data-action="view" data-view="evidence">→ Inspect Evidence & Model Review</button>
    </main>
  `;
}

function renderMetadataLine(incident) {
  return `
    <div class="metadata-line">
      <span>${escapeHtml(incident.caseId)}</span>
      <span>${escapeHtml(incident.source)}</span>
      <span>${formatTime(incident.receivedAt)}</span>
      <span>${escapeHtml(incident.location || "Location unknown")}</span>
      ${incident.aqi ? `<span class="aqi">AQI ${escapeHtml(String(incident.aqi))}</span>` : ""}
      <span>${formatPeople(incident.peopleCount)}</span>
    </div>
  `;
}

function renderClaimRow(claim) {
  const status = claimStatusLabels[claim.status] || normalizeLabel(claim.status);
  return `
    <article class="claim-row">
      <span>${escapeHtml(claim.id)}</span>
      <p>${escapeHtml(claim.text)}</p>
      <b class="claim-status ${claimStatusClass(claim.status)}">${escapeHtml(status)}</b>
    </article>
  `;
}

function renderEvidenceView(incident) {
  const selectedEvidence = getSelectedEvidence(incident);
  return `
    <main class="page-canvas evidence-page">
      <section class="screen-heading">
        <div>
          <span class="section-kicker">CASE ${escapeHtml(incident.label)}</span>
          <h1>Evidence & Model Review</h1>
          <p><strong>${escapeHtml(incident.title)}</strong> · Claim-evidence mapping and blind dual-model assessment</p>
        </div>
        <button class="primary-action" data-action="view" data-view="safety">→ Safety Decision</button>
      </section>
      <section class="evidence-layout">
        <aside class="claims-sidebar">
          <h2 class="section-kicker">Claims</h2>
          ${incident.claims.map(claim => renderEvidenceClaimItem(claim)).join("")}
        </aside>
        <section class="evidence-network-panel">
          <h2 class="section-kicker">Evidence Connections</h2>
          ${renderEvidenceNetwork(incident)}
        </section>
        <aside class="evidence-inspector">
          <h2 class="section-kicker">Evidence Inspector</h2>
          ${renderEvidenceInspector(selectedEvidence)}
        </aside>
      </section>
      ${renderBlindModelReview(incident)}
    </main>
  `;
}

function renderEvidenceClaimItem(claim) {
  return `
    <article class="evidence-claim-item ${claimStatusClass(claim.status)}">
      <span>${escapeHtml(claim.id)}</span>
      <strong>${escapeHtml(claim.text)}</strong>
      <b>${escapeHtml(claimStatusLabels[claim.status] || normalizeLabel(claim.status))}</b>
    </article>
  `;
}

function renderEvidenceNetwork(incident) {
  const selectedId = getSelectedEvidence(incident)?.id;
  const claims = incident.claims;
  const evidence = incident.evidence;
  const claimY = index => 88 + index * 88;
  const evidenceY = index => 88 + index * 88;
  const width = 880;
  const height = Math.max(430, Math.max(claims.length, evidence.length) * 90 + 100);
  const evidenceIndex = new Map(evidence.map((item, index) => [item.id, index]));

  const paths = claims
    .flatMap((claim, claimIndex) =>
      claim.evidenceIds.map(evidenceId => {
        const targetIndex = evidenceIndex.get(evidenceId);
        if (targetIndex === undefined) return "";
        const active = evidenceId === selectedId;
        const kind = connectionKind(claim, evidence[targetIndex]);
        const y1 = claimY(claimIndex);
        const y2 = evidenceY(targetIndex);
        return `<path class="connection ${kind} ${active ? "active" : "quiet"}" d="M190 ${y1} C360 ${y1}, 520 ${y2}, 690 ${y2}" />`;
      })
    )
    .join("");

  return `
    <svg class="evidence-network" viewBox="0 0 ${width} ${height}" role="img" aria-label="Claim to evidence network">
      ${paths}
      ${claims
        .map((claim, index) => {
          const y = claimY(index);
          return `
            <g class="network-claim ${claimStatusClass(claim.status)}" transform="translate(70 ${y})">
              <circle r="8"></circle>
              <text x="22" y="5">${escapeSvg(claim.id)}</text>
            </g>
          `;
        })
        .join("")}
      ${evidence
        .map((item, index) => {
          const y = evidenceY(index);
          const active = item.id === selectedId ? "active" : "";
          return `
            <g class="network-evidence ${active}" data-evidence-id="${escapeSvg(item.id)}" transform="translate(690 ${y})">
              <rect x="-8" y="-8" width="16" height="16"></rect>
              <text x="24" y="5">${escapeSvg(item.id)} ${escapeSvg(item.type)}</text>
            </g>
          `;
        })
        .join("")}
      <g class="network-legend" transform="translate(70 ${height - 46})">
        <line class="connection supports active" x1="0" x2="34" y1="0" y2="0"></line>
        <text x="48" y="5">Supports</text>
        <line class="connection partial active" x1="160" x2="194" y1="0" y2="0"></line>
        <text x="208" y="5">Partial</text>
        <line class="connection contradiction active" x1="310" x2="344" y1="0" y2="0"></line>
        <text x="358" y="5">Contradiction</text>
        <line class="connection none active" x1="510" x2="544" y1="0" y2="0"></line>
        <text x="558" y="5">No independent source</text>
      </g>
    </svg>
  `;
}

function renderEvidenceInspector(evidence) {
  if (!evidence) return `<div class="empty-panel">No evidence selected.</div>`;
  return `
    <article class="inspector-card">
      <div class="inspector-title">
        <span>${escapeHtml(evidence.id)}</span>
        <strong>${escapeHtml(evidence.type)}</strong>
      </div>
      ${inspectorRow("Retrieved", formatTime(evidence.retrievedAt))}
      ${inspectorRow("Reliability", evidence.reliability || "Reliability metadata unavailable")}
      ${inspectorRow("Contradictions", evidence.contradictions || "None recorded")}
      ${inspectorRow("Uncertainties", Array.isArray(evidence.uncertainties) ? evidence.uncertainties.join(" · ") : "Not specified")}
      <hr />
      <p>${escapeHtml(evidence.summary)}</p>
    </article>
    <div class="evidence-pick-list">
      ${getSelectedIncident().evidence
        .map(
          item => `
            <button class="${item.id === evidence.id ? "active" : ""}" data-action="select-evidence" data-evidence-id="${escapeHtml(item.id)}">
              <span>${escapeHtml(item.id)}</span>${escapeHtml(item.type)}
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function inspectorRow(label, value) {
  return `
    <div class="inspector-row">
      <span>${escapeHtml(label)}</span>
      <p>${escapeHtml(value)}</p>
    </div>
  `;
}

function renderBlindModelReview(incident) {
  const analyst = incident.modelReviews?.analyst || fallbackAnalystReview(incident);
  const reviewer = incident.modelReviews?.reviewer || fallbackReviewerReview(incident);

  return `
    <section class="model-review-section">
      <h2 class="section-kicker">Blind Dual-Model Review</h2>
      <p class="review-note">Models receive identical evidence. Neither sees the other's output.</p>
      <div class="model-review-grid">
        ${renderModelReviewCard("Incident Analyst", incident.gonka.analyst, analyst, "analyst")}
        ${renderModelReviewCard("Skeptical Reviewer", incident.gonka.reviewer, reviewer, "reviewer")}
      </div>
      <div class="review-summary-grid">
        ${reviewSummaryBlock("Agreement", incident.modelDebate.agreement.join(" · "))}
        ${reviewSummaryBlock("Disagreement", incident.modelDebate.disagreement.join(" · "))}
        ${reviewSummaryBlock("Consensus", incident.modelDebate.consensus, true)}
      </div>
    </section>
  `;
}

function renderModelReviewCard(title, trace, review, role) {
  const traceCopy = state.mode === DATA_MODES.replay
    ? `${trace.model} · Response ID [REDACTED] · Sanitized recorded trace; not this load's latency`
    : `${trace.model} · ${trace.responseId} · ${trace.promptVersion} · ${String(trace.latencyMs)}ms`;
  return `
    <article class="model-card ${role}">
      <h3>${escapeHtml(title)}</h3>
      <p class="trace-line">${escapeHtml(traceCopy)}</p>
      ${modelRow("Conclusion", review.conclusion)}
      ${review.evidenceCited ? modelRow("Evidence cited", review.evidenceCited.join(" · ")) : ""}
      ${review.counterEvidence ? modelRow("Counter-evidence", arrayText(review.counterEvidence)) : ""}
      ${review.unknowns ? modelRow("Unknown facts", arrayText(review.unknowns)) : ""}
      ${review.duplicateRisk ? modelRow("Duplicate risk", review.duplicateRisk) : ""}
      ${modelRow("Scores", scoreText({ scores: review.scores || getSelectedIncident().scores }))}
      ${modelRow("Rationale", review.rationale)}
    </article>
  `;
}

function modelRow(label, value) {
  return `
    <div class="model-row">
      <span>${escapeHtml(label)}</span>
      <p>${escapeHtml(value || "Not provided")}</p>
    </div>
  `;
}

function reviewSummaryBlock(label, value, isConsensus = false) {
  return `
    <article class="review-summary ${isConsensus ? "consensus" : ""}">
      <span>${escapeHtml(label)}</span>
      <p>${escapeHtml(value || "None")}</p>
    </article>
  `;
}

function renderSafetyView(incident) {
  return `
    <main class="page-canvas safety-page">
      <section class="safety-header">
        <span class="section-kicker">CASE ${escapeHtml(incident.label)}</span>
        <h1>${escapeHtml(incident.title)}</h1>
        <p>${escapeHtml(incident.caseId)} · ${escapeHtml(incident.location || "Location unknown")} · ${scoreText(incident)}</p>
      </section>
      <section class="safety-hero-grid">
        ${renderDecisionPath(incident)}
        <div class="urgent-not-dispatchable">
          <h2>URGENT</h2>
          <strong>≠</strong>
          <h2>DISPATCHABLE</h2>
          <p>High urgency triggers immediate verification priority, not automatic dispatch.</p>
        </div>
      </section>
      ${renderSafetyGateTable(incident)}
      ${renderDispatchLockPanel(incident)}
      <section class="safe-action-grid">
        <div>
          <h2 class="section-kicker">Next Safe Actions</h2>
          <ol class="safe-actions">
            ${(incident.safeNextActions || []).map(action => `<li>${escapeHtml(action)}</li>`).join("")}
          </ol>
        </div>
        <div class="human-decision-panel">
          <h2 class="section-kicker">Human Decision</h2>
          ${renderHumanDecisionButtons(incident)}
        </div>
      </section>
      <section class="footer-principle">
        <h2>AI ASSISTS.<br />HUMANS DECIDE.</h2>
        <p>The system cannot override Safety Gates. Only a human coordinator can escalate to emergency services.</p>
      </section>
    </main>
  `;
}

function renderDecisionPath(incident) {
  const medical = getGate(incident, "G_MEDICAL");
  const location = getGate(incident, "G_LOCATION");
  const contact = getGate(incident, "G_CONTACT");
  const dispatch = getGate(incident, "G_DISPATCH");
  const steps = [
    { label: "REPORT RECEIVED", status: "passed", detail: "" },
    { label: `URGENCY: ${incident.scores.urgency}`, status: medical?.status || "passed", detail: medical?.detail || "" },
    { label: "LOCATION", status: location?.status || "passed", detail: location?.detail || "" },
    { label: "CONTACT", status: contact?.status || "passed", detail: contact?.detail || "" }
  ];

  return `
    <section class="decision-path">
      <h2 class="section-kicker">Decision Path</h2>
      <div class="path-steps">
        ${steps
          .map(
            step => `
              <div class="path-step ${step.status}">
                <span></span>
                <strong>${escapeHtml(step.label)}</strong>
                <p>${escapeHtml(pathDetail(step.status, step.detail))}</p>
              </div>
            `
          )
          .join("")}
      </div>
      <div class="dispatch-box ${dispatch?.status === "passed" ? "passed" : "locked"}">
        ${dispatch?.status === "passed" ? "DISPATCH AVAILABLE" : "DISPATCH LOCKED"}<br />
        <small>${dispatch?.status === "passed" ? "after human approval" : "required gates blocked"}</small>
      </div>
      <p class="path-footnote">${blockedGateCount(incident)} of ${dispatchRelevantGates(incident).length} gates blocked. ${escapeHtml(dispatch?.detail || "")}</p>
    </section>
  `;
}

function renderSafetyGateTable(incident) {
  const gateOrder = ["G_MEDICAL", "G_LOCATION", "G_CONTACT", "G_RESOURCE", "G_CONFLICT"];
  return `
    <section class="gate-table-section">
      <h2 class="section-kicker">Safety Gate Checks</h2>
      <div class="gate-table">
        ${gateOrder
          .map(id => {
            const gate = getGate(incident, id);
            if (!gate) return "";
            const status = gate.status || (gate.passed ? "passed" : "blocked");
            return `
              <div class="gate-table-row">
                <strong>${escapeHtml(gate.label)}</strong>
                <span class="gate-status ${status}">${escapeHtml(gateStatusLabels[status] || normalizeLabel(status))}</span>
                <p>${escapeHtml(gate.detail)}</p>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderDispatchLockPanel(incident) {
  const blocked = isDispatchBlocked(incident);
  return `
    <section class="dispatch-lock-panel ${blocked ? "locked" : "passed"}">
      <h2>${blocked ? "Volunteer Dispatch — Locked" : "Volunteer Dispatch — Available"}</h2>
      <p>${escapeHtml(
        blocked
          ? "Exact location and verified contact are required before volunteer dispatch can be approved."
          : "Safety gates have passed. A human coordinator can approve a bounded volunteer action."
      )}</p>
    </section>
  `;
}

function renderHumanDecisionButtons(incident) {
  const workflow = getDecisionWorkflow(incident);
  const form = workflow.form;
  const requirements = acknowledgementRequirements(incident, form.action);
  const actions = actionsForState(incident.operationalState);
  const busy = ["decision_loading", "brief_loading", "audit_loading"].includes(workflow.phase);
  const liveReady = state.mode !== DATA_MODES.live || liveReadiness(state.health).ready;
  return `
    <form class="decision-form" aria-busy="${busy}">
      <div class="decision-context">
        <span>Case ID <strong>${escapeHtml(incident.caseId)}</strong></span>
        <span>State <strong>${escapeHtml(incident.operationalState)}</strong></span>
        <span>Consensus <strong>${escapeHtml(incident.modelDebate?.consensus || "Not available")}</strong></span>
      </div>
      <label for="human-action">Human Action</label>
      <select id="human-action" ${busy ? "disabled" : ""}>
        ${actions.map(action => `<option value="${escapeHtml(action)}" ${form.action === action ? "selected" : ""}>${escapeHtml(actionLabel(action))}</option>`).join("")}
      </select>
      <label for="human-reason">Human Reason ${["APPROVE_ACTION", "REJECT_ACTION"].includes(form.action) || conflictReviewRequiredForUi(incident) ? "(minimum 8 characters)" : "(optional)"}</label>
      <textarea id="human-reason" maxlength="500" placeholder="Enter the operator's own reason. CrisisRoute AI will not fill this for you." ${busy ? "disabled" : ""}>${escapeHtml(form.reason)}</textarea>
      <fieldset class="acknowledgement-list">
        <legend>Human Acknowledgements</legend>
        ${acknowledgementControl("acknowledgeHumanDecision", "I confirm this is a human decision.", form, requirements, busy)}
        ${acknowledgementControl("acknowledgeNoAutomaticExecution", "I understand CrisisRoute AI does not execute real-world action.", form, requirements, busy)}
        ${requirements.acknowledgeReview || form.action === "APPROVE_ACTION"
          ? acknowledgementControl("acknowledgeReview", "I reviewed the model disagreement/conflict.", form, requirements, busy)
          : ""}
      </fieldset>
      <div class="gate-summary" aria-label="Safety Gate summary">
        ${(incident.safetyGates || []).filter(gate => ["G_LOCATION", "G_CONTACT", "G_RESOURCE", "G_CONFLICT"].includes(gate.id))
          .map(gate => `<span>${escapeHtml(gate.id.replace("G_", ""))}: <strong>${escapeHtml(gate.status || (gate.passed ? "passed" : "blocked"))}</strong></span>`).join("")}
      </div>
      <p class="demo-auth-notice">Demo local operator — no production identity authentication.</p>
      ${!liveReady ? `<p class="form-error" role="alert">LIVE workflow unavailable: ${escapeHtml(liveReadiness(state.health).missing.join(", "))}</p>` : ""}
      ${form.errors?.length ? `<ul class="form-errors" role="alert">${form.errors.map(error => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
      ${workflow.error ? `<p class="form-error" role="alert">${escapeHtml(workflow.error)}</p>` : ""}
      <p class="workflow-status" aria-live="polite">
        Decision: ${escapeHtml(workflow.decisionStatus)} · Brief: ${escapeHtml(workflow.briefStatus)} · Audit: ${escapeHtml(workflow.auditStatus)}
      </p>
      ${workflow.decisionStatus === "RECORDED" ? `<p class="recorded-status">RECORDED — NOT EXECUTED</p>` : ""}
      <div class="decision-form-actions">
        <button type="button" class="primary-action" data-action="decision-submit" ${busy || !liveReady || workflow.decisionStatus === "RECORDED" ? "disabled" : ""}>${busy ? "Recording…" : "Submit Decision"}</button>
        <button type="button" class="secondary-action" data-action="decision-reset" ${busy ? "disabled" : ""}>Cancel / Reset</button>
        ${workflow.canRetryBrief ? `<button type="button" class="secondary-action" data-action="retry-brief">Retry Brief — Decision remains recorded</button>` : ""}
      </div>
    </form>
  `;
}

function acknowledgementControl(field, label, form, requirements, disabled = false) {
  const required = requirements[field] === true;
  return `
    <label class="checkbox-row">
      <input type="checkbox" data-acknowledgement="${field}" ${form[field] ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span>${escapeHtml(label)} <small>${required ? "Required" : "Optional for this action"}</small></span>
    </label>
  `;
}

function actionLabel(action) {
  const labels = {
    APPROVE_ACTION: "Approve bounded action",
    REQUEST_VERIFICATION: "Request urgent verification",
    MERGE_REPORT: "Merge duplicate reports",
    HOLD_FOR_REVIEW: "Hold for human review",
    QUEUE_ACTION: "Queue proposed resources",
    REJECT_ACTION: "Reject proposed action"
  };
  return labels[action] || normalizeLabel(action);
}

function conflictReviewRequiredForUi(incident) {
  return incident.safetyGates?.some(gate => gate.id === "G_CONFLICT" && gate.status === "review") === true;
}

function renderActionBriefView(incident) {
  const workflow = getDecisionWorkflow(incident);
  const brief = workflow.brief || incident.operationalBrief;
  const proof = workflow.proofCapsule || incident.proofCapsule;
  if (!workflow.decision || !brief) return renderActionBriefLocked(incident, workflow);
  const rules = displayRules(workflow);
  const liveProof = state.mode === DATA_MODES.live && proof;

  return `
    <main class="page-canvas action-page">
      <section class="approval-strip recorded">RECORDED — NOT EXECUTED · ${escapeHtml(workflow.decision.action)} · ${escapeHtml(incident.caseId)}</section>
      <section class="action-layout">
        <section class="action-brief-main">
          <h1>Deterministic Operational Brief</h1>
          <p class="action-subtitle">${escapeHtml(incident.caseId)} · ${escapeHtml(incident.title)}</p>
          <div class="brief-meta-grid">
            ${briefMeta("Human Action", workflow.decision.action)}
            ${briefMeta("Priority", brief.priority || "Not available", "red")}
            ${briefMeta("Recorded", formatTime(workflow.decision.recordedAt))}
          </div>
          <div class="brief-section">
            <h2 class="section-kicker">Human Reason</h2>
            <p>${escapeHtml(workflow.decision.reason || "No additional reason supplied for this action.")}</p>
          </div>
          <div class="brief-section instructions">
            <h2 class="section-kicker">Brief Summary</h2>
            <p>${escapeHtml(brief.summary)}</p>
          </div>
          <div class="brief-section">
            <h2 class="section-kicker">Safe Next Actions</h2>
            <ol class="safe-actions">${listItems(brief.nextSteps || [])}</ol>
          </div>
          <div class="brief-section">
            <h2 class="section-kicker">Verification Items & Constraints</h2>
            <ul class="constraint-list">${listItems(brief.safetyConstraints || [])}</ul>
          </div>
          <div class="execution-contract">
            <strong>${escapeHtml(brief.recordStatus || "RECORDED")} — ${escapeHtml(brief.executionStatus || "NOT_EXECUTED")}</strong>
            <p>External execution remains outside CrisisRoute AI.</p>
          </div>
        </section>
        <aside class="proof-column">
          <div class="proof-heading">
            <div>
              <h2 class="section-kicker">Proof Capsule</h2>
              <p>${liveProof ? "Server-issued local payload receipt" : "DEMO ONLY — no server-issued capsule"}</p>
            </div>
            <div class="proof-actions">
              <button type="button" class="secondary-action" data-action="verify-proof" ${!rules.proofVerificationEnabled ? "disabled" : ""}>Verify Local Proof</button>
              <button type="button" class="secondary-action" data-action="export-receipt" ${!liveProof || !workflow.audit ? "disabled" : ""}>Export Receipt JSON</button>
            </div>
          </div>
          <div class="proof-verification ${escapeHtml(workflow.proofStatus.toLowerCase())}" role="status" aria-live="polite">
            ${escapeHtml(proofStatusLabel(workflow))}
          </div>
          ${liveProof ? renderServerProof(brief, proof) : renderDemoProofNotice()}
        </aside>
      </section>
      ${renderServerAudit(workflow.audit)}
      ${renderIntegrityNotice()}
    </main>
  `;
}

function renderActionBriefLocked(incident, workflow = getDecisionWorkflow(incident)) {
  const decisionRecorded = workflow?.decisionStatus === "RECORDED";
  return `
    <main class="page-canvas action-page">
      <section class="action-locked-state">
        <span class="section-kicker">Action Brief</span>
        <h1>${escapeHtml(incident.title)}</h1>
        ${decisionRecorded
          ? `<p><strong>Decision status: RECORDED</strong><br />Brief status: UNAVAILABLE<br />Execution status: NOT_EXECUTED</p>
             <p>The Human Decision remains recorded. Retrying the Brief will not resubmit the Decision.</p>`
          : `<p>A Human Decision must be explicitly completed and recorded before any deterministic Brief can be shown.</p>`}
        <div class="locked-actions">
          <button type="button" class="primary-action" data-action="view" data-view="safety">Open Safety Decision</button>
          ${workflow?.canRetryBrief ? `<button type="button" class="secondary-action" data-action="retry-brief">Retry Brief</button>` : ""}
        </div>
      </section>
      ${decisionRecorded ? renderServerAudit(workflow.audit) : ""}
    </main>
  `;
}

function proofStatusLabel(workflow) {
  if (state.mode !== DATA_MODES.live || !workflow.proofCapsule) return "UNAVAILABLE — not a server-issued live capsule";
  if (workflow.proofStatus === "VALID") return "VALID — unchanged local payload";
  if (workflow.proofStatus === "INVALID") return "INVALID — payload or reference changed";
  if (workflow.proofStatus === "VERIFYING") return "VERIFYING — local integrity check in progress";
  return "UNVERIFIED — select Verify Local Proof";
}

function renderServerProof(brief, proof) {
  return `
    <article class="proof-receipt server-proof">
      ${receiptRow("Brief ID", brief.briefId)}
      ${hashReceiptRow("Brief Hash", proof.briefHash)}
      ${receiptRow("Capsule ID", proof.capsuleId)}
      ${hashReceiptRow("Capsule Hash", proof.capsuleHash)}
      ${hashReceiptRow("Analysis Snapshot Hash", proof.analysisSnapshotHash)}
      ${hashReceiptRow("Decision Entry Hash", proof.decisionEntryHash)}
      ${hashReceiptRow("Audit Chain Head", proof.auditChainHead)}
      ${receiptRow("Integrity Scope", proof.integrityScope)}
      ${receiptRow("Persistence", proof.persistence)}
      ${receiptRow("External Anchoring", proof.externalAnchoring)}
    </article>
  `;
}

function renderDemoProofNotice() {
  return `
    <article class="proof-receipt demo-proof">
      <strong>DEMO ONLY</strong>
      <p>Mock and Replay data cannot be marked Proof Valid and cannot use server Proof verification.</p>
    </article>
  `;
}

function hashReceiptRow(label, value) {
  return `
    <div class="receipt-row hash-row">
      <span>${escapeHtml(label)}</span>
      <details>
        <summary>${escapeHtml(shortHash(value))}</summary>
        <code>${escapeHtml(value)}</code>
      </details>
    </div>
  `;
}

function renderServerAudit(audit) {
  if (!audit) return `<section class="audit-chain"><h2 class="section-kicker">Local Audit Chain</h2><p>Audit unavailable.</p></section>`;
  return `
    <section class="audit-chain">
      <div class="audit-heading">
        <div><h2 class="section-kicker">Local Audit Chain</h2><p>Current-process, temporary audit history.</p></div>
        <strong>Chain: ${audit.chainValid === true ? "VALID" : audit.demoOnly ? "DEMO ONLY" : "INVALID"}</strong>
      </div>
      <div class="audit-entry-list">
        ${(audit.entries || []).map(entry => `
          <article class="audit-entry">
            <span>Sequence ${escapeHtml(entry.sequence)}</span>
            <strong>${escapeHtml(entry.action)}</strong>
            <time>${escapeHtml(formatDateTime(entry.recordedAt))}</time>
            ${hashReceiptRow("Previous Hash", entry.previousHash === null ? "GENESIS: null" : entry.previousHash)}
            ${hashReceiptRow("Entry Hash", entry.entryHash)}
          </article>
        `).join("")}
      </div>
      <p>Persistence: ${escapeHtml(audit.persistence)} · External anchoring: ${escapeHtml(audit.externalAnchoring)}</p>
    </section>
  `;
}

function renderIntegrityNotice() {
  return `
    <section class="integrity-notice">
      <strong>Local payload integrity only</strong>
      <p>Ephemeral — resets when the local server restarts.</p>
      <p>No blockchain or external anchoring.</p>
      <p>Does not prove the report is true or that real-world action occurred.</p>
      <p>Demo local operator — no production identity authentication.</p>
    </section>
  `;
}

function briefMeta(label, value, tone = "") {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong class="${tone}">${escapeHtml(value || "Not available")}</strong>
    </div>
  `;
}

function languageButton(lang, label) {
  return `
    <button class="${state.selectedLanguage === lang ? "active" : ""}" data-action="language" data-lang="${lang}">
      ${escapeHtml(label)}${state.selectedLanguage === lang ? " / active" : ""}
    </button>
  `;
}

function briefGate(label, passed) {
  return `<span class="${passed ? "passed" : "blocked"}">${passed ? "PASSED" : "BLOCKED"} · ${escapeHtml(label)}</span>`;
}

function renderProofReceipt(incident, proof) {
  const evidenceHashes = proof?.evidenceHashes || incident.evidence.map(item => `sha256:${simpleHash(item.id + item.summary)}`);
  const receiptHash = proof?.receiptHash || "pending-human-approval";
  const human = incident.humanDecision || {};

  return `
    <article class="proof-receipt">
      <h3>Decision Record</h3>
      ${receiptRow("Case ID", incident.caseId)}
      ${receiptRow("Incident", incident.title)}
      ${receiptRow("Human Decision", human.decision || "PENDING")}
      <h3>Evidence Chain</h3>
      ${receiptRow("Evidence hashes", evidenceHashes.map(shortHash).join("   "))}
      <h3>AI Verification</h3>
      ${receiptRow("Analyst", incident.gonka.analyst.model)}
      ${receiptRow("Analyst resp.", incident.gonka.analyst.responseId)}
      ${receiptRow("Reviewer", incident.gonka.reviewer.model)}
      ${receiptRow("Reviewer resp.", incident.gonka.reviewer.responseId)}
      ${receiptRow("Prompt version", incident.gonka.analyst.promptVersion)}
      ${receiptRow("Consensus", scoreText(incident))}
      <h3>Human Decision</h3>
      ${receiptRow("Approved by", human.decidedBy || "Not approved")}
      ${receiptRow("Timestamp", human.decidedAt || "Pending")}
      <h3>Receipt</h3>
      ${receiptRow("Receipt hash", shortHash(receiptHash))}
      <p class="receipt-footnote">This receipt records the decision chain. It is not a blockchain claim.</p>
    </article>
  `;
}

function receiptRow(label, value) {
  return `
    <div class="receipt-row">
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(value)}</b>
    </div>
  `;
}

function renderAuditTimeline(incident) {
  const events = auditEvents(incident);
  return `
    <section class="audit-timeline">
      <h2 class="section-kicker">Audit Timeline</h2>
      <div class="timeline-line">
        ${events
          .map(
            event => `
              <article>
                <time>${escapeHtml(formatTime(event.time))}</time>
                <span></span>
                <strong>${escapeHtml(event.label)}</strong>
                <p>${escapeHtml(event.detail)}</p>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function auditEvents(incident) {
  const reportTime = incident.receivedAt;
  const evidenceTime = incident.evidence[0]?.retrievedAt || addMinutes(reportTime, 1);
  const analystTime = addMinutes(reportTime, 3);
  const reviewerTime = addMinutes(reportTime, 4);
  const consensusTime = addMinutes(reportTime, 5);
  const safetyTime = addMinutes(reportTime, 6);
  const humanTime = incident.humanDecision?.decidedAt || addMinutes(reportTime, 10);

  return [
    { label: "Report", time: reportTime, detail: "Received" },
    { label: "Evidence", time: evidenceTime, detail: `Linked ${incident.evidence.length} items` },
    { label: "Analyst", time: analystTime, detail: incident.gonka.analyst.responseId },
    { label: "Reviewer", time: reviewerTime, detail: incident.gonka.reviewer.responseId },
    { label: "Consensus", time: consensusTime, detail: scoreText(incident) },
    { label: "Safety", time: safetyTime, detail: isDispatchBlocked(incident) ? "Gates blocked" : "Gates pass" },
    { label: "Human", time: humanTime, detail: incident.humanDecision?.decidedBy || "Pending" },
    { label: "Action", time: humanTime, detail: incident.humanDecision?.decision === "APPROVED" ? "Approved" : "Locked" }
  ];
}

function selectIncident(caseId) {
  state.selectedCaseId = caseId;
  ensureEvidenceSelection();
  const incident = getSelectedIncident();
  if (incident && !state.decisionWorkflows[incident.caseId]) {
    state.decisionWorkflows[incident.caseId] = createWorkflowState(incident, state.mode);
  }
}

function getDecisionWorkflow(incident = getSelectedIncident()) {
  if (!incident) return null;
  if (!state.decisionWorkflows[incident.caseId]) {
    state.decisionWorkflows[incident.caseId] = createWorkflowState(incident, state.mode);
  }
  return state.decisionWorkflows[incident.caseId];
}

function setDecisionWorkflow(caseId, workflow) {
  state.decisionWorkflows[caseId] = workflow;
}

function updateIncident(caseId, patch) {
  state.incidents = state.incidents.map(item => item.caseId === caseId ? { ...item, ...patch } : item);
}

function ensureEvidenceSelection() {
  const incident = getSelectedIncident();
  if (!incident) {
    state.selectedEvidenceId = null;
    return;
  }
  const hasSelected = incident.evidence.some(item => item.id === state.selectedEvidenceId);
  if (!hasSelected) {
    state.selectedEvidenceId = incident.evidence[0]?.id || null;
  }
}

function getSelectedIncident() {
  return state.incidents.find(item => item.caseId === state.selectedCaseId) || state.incidents[0] || null;
}

function getSelectedEvidence(incident) {
  return incident.evidence.find(item => item.id === state.selectedEvidenceId) || incident.evidence[0] || null;
}

function findCaseByLabel(label) {
  return state.incidents.find(incident => incident.label === label);
}

function getGate(incident, id) {
  return incident.safetyGates.find(gate => gate.id === id);
}

function gatePassed(incident, id) {
  return getGate(incident, id)?.passed === true;
}

function isDispatchBlocked(incident) {
  const dispatchGate = getGate(incident, "G_DISPATCH");
  return dispatchGate?.status === "locked" || incident.safetyGates.some(gate => gate.status === "blocked");
}

function dispatchRelevantGates(incident) {
  return incident.safetyGates.filter(gate => gate.id !== "G_DISPATCH");
}

function blockedGateCount(incident) {
  return dispatchRelevantGates(incident).filter(gate => gate.status === "blocked").length;
}

function supportedClaimCount(incident) {
  return incident.claims.filter(claim => ["supported", "partially_supported", "partially_corroborated", "plausible"].includes(claim.status)).length;
}

function unverifiedClaimCount(incident) {
  return incident.claims.filter(claim => ["reported_unverified", "unverified", "unverifiable"].includes(claim.status)).length;
}

function countByState(operationalState) {
  return state.incidents.filter(incident => incident.operationalState === operationalState).length;
}

function queueSubtitle(incident) {
  if (incident.label === "02") return "Hostel B · 3 forwards → 1 source";
  if (incident.label === "04") return "Campus grounds · Models disagree";
  return incident.location || incident.source;
}

function scoreText(incident) {
  return `V${incident.scores.verification} · U${incident.scores.urgency} · A${incident.scores.actionability}`;
}

function urgencyCaption(incident) {
  if (incident.scores.urgency >= 90) return "Potential respiratory emergency";
  if (incident.scores.urgency >= 70) return "Time-sensitive public safety risk";
  return "Important but lower immediate danger";
}

function actionabilityCaption(incident) {
  if (incident.scores.actionability < 35) return "Critical information missing";
  if (incident.scores.actionability < 70) return "Needs coordinator clarification";
  return "Enough information for bounded action";
}

function insightCopy(incident) {
  if (incident.operationalState === "URGENT_VERIFICATION") {
    return "A report can be poorly evidenced and still represent a life-threatening situation.";
  }
  if (incident.operationalState === "DISPATCH_CANDIDATE") {
    return "AI prepares the decision chain, but the coordinator still approves the dispatch.";
  }
  return incident.insight || "CrisisRoute separates evidence confidence from operational urgency.";
}

function pathDetail(status, detail) {
  if (!detail) return "";
  const label = gateStatusLabels[status] || normalizeLabel(status);
  return `${label} - ${detail}`;
}

function connectionKind(claim, evidence) {
  const status = claim.status || "";
  if (status.includes("contradict")) return "contradiction";
  if ((evidence?.type || "").toLowerCase().includes("no independent")) return "none";
  if (status.includes("partial") || status.includes("plausible") || status.includes("unverifiable")) return "partial";
  return "supports";
}

function claimStatusClass(status) {
  if (String(status).includes("contradict")) return "contradiction";
  if (["plausible", "partially_supported", "partially_corroborated", "unverifiable"].includes(status)) return "partial";
  if (["reported", "reported_unverified", "unverified"].includes(status)) return "reported";
  return "supported";
}

function stateClass(stateName) {
  if (stateName === "DISPATCH_CANDIDATE") return "state-green";
  if (stateName === "URGENT_VERIFICATION") return "state-amber";
  if (stateName === "NEEDS_HUMAN_REVIEW") return "state-violet";
  if (stateName === "MERGE_OR_VERIFY") return "state-blue";
  return "state-muted";
}

function modeLabel(mode) {
  if (mode === DATA_MODES.replay) return "REPLAY";
  if (mode === DATA_MODES.live) return "LIVE";
  return "DEMO";
}

function shortModeLabel(mode) {
  if (mode === DATA_MODES.replay) return "Replay";
  if (mode === DATA_MODES.live) return "Live";
  return "Demo";
}

function gonkaLabel() {
  if (state.mode === DATA_MODES.mock) return "DEMO DATA";
  if (state.mode === DATA_MODES.replay) return "SANITIZED REPLAY";
  return isLiveConnected() ? "CONNECTED" : "UNAVAILABLE";
}

function gonkaTone() {
  if (state.mode === DATA_MODES.live && isLiveConnected()) return "connected";
  if (state.mode === DATA_MODES.live) return "unavailable";
  return "";
}

function modeFootnote() {
  if (state.mode === DATA_MODES.mock) return "Synthetic local demonstration data. Not a model result. No server-issued Proof.";
  if (state.mode === DATA_MODES.replay) return "Sanitized recorded acceptance replay. No network request in this load. Response IDs redacted. Not current live inference.";
  const readiness = liveReadiness(state.health);
  return readiness.ready
    ? "Live mode has Analyze, Decision, Brief, and full-scenario capabilities available."
    : `Live workflow unavailable. Missing capabilities: ${readiness.missing.join(", ") || "unknown"}.`;
}

function isLiveConnected() {
  return state.mode === DATA_MODES.live && liveReadiness(state.health).ready;
}

function listItems(items) {
  return items.map(item => `<li>${escapeHtml(item)}</li>`).join("");
}

function normalizeLabel(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, char => char.toUpperCase());
}

function formatPeople(value) {
  if (value === null || value === undefined) return "people unknown";
  return `${value} ${Number(value) === 1 ? "person" : "people"}`;
}

function formatTime(value) {
  if (!value) return "Pending";
  try {
    return `${new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Kuala_Lumpur"
    }).format(new Date(value))} MYT`;
  } catch {
    return value;
  }
}

function formatDateTime(value) {
  if (!value) return "Pending";
  try {
    const date = new Date(value);
    const datePart = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Asia/Kuala_Lumpur"
    }).format(date);
    return `${datePart} ${formatTime(value)}`;
  } catch {
    return value;
  }
}

function addMinutes(value, minutes) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

function arrayText(value) {
  return Array.isArray(value) ? value.join(" · ") : value;
}

function shortHash(value) {
  const text = String(value);
  if (/^[a-f0-9]{64}$/i.test(text)) return `${text.slice(0, 10)}...${text.slice(-8)}`;
  return text.replace(/^(sha256:[a-z0-9]{4})[a-z0-9]+([a-z0-9]{4})$/i, "$1...$2");
}

function fallbackAnalystReview(incident) {
  return {
    conclusion: incident.modelDebate.consensus,
    evidenceCited: incident.evidence.slice(0, 2).map(item => item.id),
    scores: incident.scores,
    rationale: incident.recommendedAction
  };
}

function fallbackReviewerReview(incident) {
  return {
    conclusion: incident.modelDebate.counterEvidence.join(" · ") || "No counter-evidence recorded",
    counterEvidence: incident.modelDebate.counterEvidence,
    unknowns: incident.missingFields,
    duplicateRisk: "Not specified",
    scores: incident.scores,
    rationale: incident.modelDebate.disagreement.join(" · ") || incident.modelDebate.consensus
  };
}

function showToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    state.toast = null;
    render();
  }, 2800);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeSvg(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function simpleHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

init();
