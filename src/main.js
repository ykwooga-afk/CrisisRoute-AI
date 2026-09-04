import {
  DATA_MODES,
  analyzePublicUrl,
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
  dispatchPresentation,
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
  intakeMode: "text",
  intakeValue: "",
  urlValue: "",
  loading: false,
  error: null,
  health: null,
  toast: null,
  decisionWorkflows: {},
  reliability: createReliabilityState(DATA_MODES.mock),
  replayMeta: null,
  liveProgress: null,
  lastLiveRequestSpec: null
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
  review: "REVIEW REQUIRED",
  locked: "LOCKED"
};

async function init() {
  render();
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

    if (action === "input-mode") {
      state.intakeMode = button.dataset.inputMode === "url" ? "url" : "text";
      render();
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

    if (action === "request-info") {
      showToast("Request More Info is a coordinator action placeholder in this demo.");
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
    if (event.target.matches("#verify-url")) {
      state.urlValue = event.target.value;
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
    clearAnalysisState();
    state.reliability = createReliabilityState(DATA_MODES.mock);
    state.replayMeta = null;
    state.liveProgress = null;
    state.error = null;
    showToast("Demo mode selected. Load demo cases or analyze pasted text when ready.");
    render();
    return;
  }
  if (mode === DATA_MODES.replay) {
    await withLoading(async () => {
      const result = await loadHazeScenario(DATA_MODES.replay);
      state.mode = DATA_MODES.replay;
      state.reliability = openSanitizedReplay(state.reliability);
      state.replayMeta = result.meta || null;
      applyScenarioResult(result, "03");
      state.currentView = VIEWS.command;
      showToast("Sanitized acceptance replay opened locally. Network requests: 0.");
    });
    return;
  }
  if (mode !== DATA_MODES.live) return;

  await refreshHealth();
  state.mode = DATA_MODES.live;
  clearAnalysisState();
  state.reliability = createReliabilityState(DATA_MODES.live);
  state.replayMeta = null;
  state.liveProgress = null;
  const readiness = liveReadiness(state.health);
  if (!readiness.ready) {
    showToast(`Live mode selected, but backend is unavailable: ${readiness.missing.join(", ") || "configuration"}.`);
    render();
    return;
  }
  showToast("Live mode selected. Paste text or a public URL, then Analyze Report.");
  render();
}

async function handleVerifyInput() {
  if (state.mode === DATA_MODES.replay) {
    showToast("Replay displays a recorded run. Switch to Demo or Live to analyze new input.");
    return;
  }

  const requestSpec = currentIntakeRequest();
  if (!requestSpec) return;

  if (requestSpec.kind === "url" && state.mode !== DATA_MODES.live) {
    state.error = null;
    await withLoading(async () => {
      const result = await analyzePublicUrl(requestSpec.url, state.mode);
      applyScenarioResult(result, null);
      state.currentView = VIEWS.command;
      showToast("Synthetic demo URL intake generated locally. Switch to Live for real public-page extraction.");
    });
    return;
  }

  if (state.mode === DATA_MODES.live) {
    await refreshHealth();
    if (!liveReadiness(state.health).ready) {
      const readiness = liveReadiness(state.health);
      const requestId = `live-readiness-${++liveAttemptSequence}`;
      state.reliability = beginLiveAttempt(state.reliability, { requestId, messages: requestSpec.messages || [requestSpec.url] });
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
    await runLiveAnalyze(requestSpec);
    return;
  }

  state.error = null;
  await withLoading(async () => {
    const result = await analyzeIncidents(requestSpec.messages, state.mode);
    applyScenarioResult(result, null);
    state.currentView = VIEWS.command;
    showToast("Synthetic demo analysis generated by the local adapter.");
  });
}

function currentIntakeRequest() {
  if (state.intakeMode === "url") {
    const url = state.urlValue.trim();
    if (!url) {
      showToast("Paste a public source URL first.");
      return null;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      showToast("Use a valid public HTTP or HTTPS URL.");
      return null;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      showToast("Public URL analysis supports HTTP and HTTPS pages only.");
      return null;
    }
    return { kind: "url", url: parsed.toString(), messages: [parsed.toString()] };
  }

  const text = state.intakeValue.trim();
  if (!text) {
    showToast("Paste crisis report text first.");
    return null;
  }
  return { kind: "custom", messages: [text] };
}

function applyScenarioResult(result, preferredLabel) {
  state.incidents = result.incidents || [];
  state.resources = result.resources || state.resources;
  state.decisionWorkflows = {};
  const preferred = preferredLabel ? findCaseByLabel(preferredLabel)?.caseId : null;
  selectIncident(preferred || state.incidents[0]?.caseId || null);
}

function clearAnalysisState() {
  state.incidents = [];
  state.resources = [];
  state.selectedCaseId = null;
  state.selectedEvidenceId = null;
  state.selectedLanguage = "en";
  state.decisionWorkflows = {};
}

async function runLiveAnalyze(requestSpec) {
  if (state.reliability.phase === "live_wait") return;
  const requestId = `live-attempt-${++liveAttemptSequence}`;
  const requestedCaseSet = state.selectedCaseId || "no-selected-case";
  const messages = Array.isArray(requestSpec.messages) ? requestSpec.messages : [];
  state.lastLiveRequestSpec = {
    kind: requestSpec.kind,
    messages: [...messages],
    url: requestSpec.url || ""
  };
  state.reliability = beginLiveAttempt(state.reliability, { requestId, messages });
  state.liveProgress = { requestId, startedAt: Date.now(), requestedCaseSet, requestKind: requestSpec.kind };
  state.error = null;
  state.replayMeta = null;
  liveAbortController = new AbortController();
  clearLiveProgressTimer();
  liveProgressTimer = window.setInterval(() => {
    if (state.liveProgress?.requestId === requestId) render();
  }, 1_000);
  render();

  try {
    const result = requestSpec.kind === "url"
      ? await analyzePublicUrl(requestSpec.url, DATA_MODES.live, { signal: liveAbortController.signal })
      : requestSpec.kind === "fixed"
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
    state.currentView = VIEWS.command;
    showToast(requestSpec.kind === "fixed"
      ? "Live five-case analysis returned. Human action is still required."
      : requestSpec.kind === "url"
        ? "Live public URL analysis returned. Human action is still required."
        : "Live text analysis returned. Human action is still required.");
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
  const retrySpec = state.lastLiveRequestSpec || {
    kind: (state.reliability.lastLiveMessages || []).length ? "custom" : "fixed",
    messages: state.reliability.lastLiveMessages || []
  };
  await runLiveAnalyze(retrySpec);
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
      ${renderOperatorPanels()}
      ${renderCurrentView(incident)}
      ${state.toast ? `<div class="toast" role="status">${escapeHtml(state.toast)}</div>` : ""}
      ${state.loading ? `<div class="loading-indicator" aria-live="polite">Processing</div>` : ""}
    </div>
  `;
}

function renderOperatorPanels() {
  return renderReliabilityPanel();
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
    const stage = progressStageCopy(progress.stage);
    return `
      <section class="reliability-panel progress-panel" aria-live="polite" aria-busy="true">
        <div>
          <span class="section-kicker">LIVE ANALYZE · ${escapeHtml(progress.elapsedSeconds)}s elapsed</span>
          <h2>${escapeHtml(stage)}</h2>
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
          <span class="provenance-pill ${gonkaTone()}">${escapeHtml(compactProvenanceLabel())}</span>
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
  if (state.currentView === VIEWS.intelligence) {
    return renderCaseIntelligence(getStrictSelectedIncident());
  }

  if (!incident) {
    if (state.currentView === VIEWS.command) return renderCommandEmpty();
    return `
      <main class="page-canvas">
        <section class="empty-page">
          <h1>No case selected.</h1>
          <p>Load a demo scenario or complete an analysis before opening this workflow screen.</p>
          <button class="primary-action" data-action="view" data-view="command">Back to Command Center</button>
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

function renderCommandEmpty() {
  return `
    <main class="page-canvas command-empty-page command-initial">
      ${renderVerifyInput({ compact: false })}
      ${renderIntakeWorkflowRail()}
      <section class="command-initial-grid">
        <article class="command-start-panel">
          <div class="empty-illustration" aria-hidden="true">
            <span></span>
          </div>
          <h1>Paste a crisis report or load demo cases to begin analysis.</h1>
          <div class="starter-card-grid">
            ${starterCard("Extract claims", "Identify key claims and entities from the report.", "document")}
            ${starterCard("Check evidence", "Assess supporting and conflicting evidence.", "search")}
            ${starterCard("Recommend safe next actions", "Prioritize actions while respecting safety constraints.", "shield")}
          </div>
        </article>
        <aside class="next-panel">
          <h2>What happens next</h2>
          <ol>
            <li><span>1</span><p>We extract claims and gather relevant evidence.</p></li>
            <li><span>2</span><p>Independent AI models evaluate the case.</p></li>
            <li><span>3</span><p>You review the findings and make the final decision.</p></li>
          </ol>
        </aside>
      </section>
    </main>
  `;
}

function renderCommandCenter(incident) {
  return `
    <main class="page-canvas command-center command-result">
      ${renderVerifyInput({ compact: true })}
      ${renderIntakeWorkflowRail()}
      ${renderSummaryCards()}
      <section class="command-grid">
        <aside class="incident-queue" aria-label="Incident Queue">
          <div class="panel-title-line">
            <h2>Incident Queue</h2>
          </div>
          ${state.incidents.map(renderQueueItem).join("")}
          <button type="button" class="secondary-action queue-footer-action">View all incidents →</button>
        </aside>
        <section class="command-main-panel result-case-panel">
          ${renderResultCasePanel(incident)}
        </section>
        <aside class="decision-readiness result-side-panel">
          ${renderCommandReadinessPanel(incident)}
        </aside>
      </section>
    </main>
  `;
}

function starterCard(title, copy, type) {
  return `
    <article class="starter-card ${type}">
      <span aria-hidden="true">${starterIcon(type)}</span>
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(copy)}</p>
      </div>
    </article>
  `;
}

function starterIcon(type) {
  const icons = {
    document: "□",
    search: "⌕",
    shield: "✓"
  };
  return icons[type] || "•";
}

function renderIntakeWorkflowRail() {
  const items = [
    ["Incoming", "Receive report"],
    ["Evidence", "Gather & verify"],
    ["AI Review", "Independent analysis"],
    ["Safety", "Check impact"],
    ["Human Decision", "Review & decide"],
    ["Action Brief", "Communicate & act"]
  ];
  return `
    <section class="intake-workflow" aria-label="CrisisRoute workflow">
      ${items.map(([title, subtitle], index) => `
        <article class="${index === 0 ? "active" : ""}">
          <span>${index + 1}</span>
          <div>
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(subtitle)}</p>
          </div>
        </article>
        ${index < items.length - 1 ? `<b aria-hidden="true">›</b>` : ""}
      `).join("")}
    </section>
  `;
}

function renderSummaryCards() {
  const items = [
    ["Active Incidents", state.incidents.length, "green"],
    ["Needs Human Review", countByState("NEEDS_HUMAN_REVIEW"), "violet"],
    ["Urgent Verification", countByState("URGENT_VERIFICATION"), "amber"],
    ["Dispatch Candidate", countByState("DISPATCH_CANDIDATE"), "green"],
    ["N95 Masks Available", state.resources.find(resource => resource.id === "res_masks")?.available || 0, "blue"]
  ];
  return `
    <section class="summary-card-grid" aria-label="Incident summary">
      ${items.map(([label, value, tone]) => `
        <article class="summary-card ${tone}">
          <span aria-hidden="true"></span>
          <div>
            <p>${escapeHtml(label)}</p>
            <strong>${escapeHtml(String(value))}</strong>
          </div>
        </article>
      `).join("")}
    </section>
  `;
}

function renderResultCasePanel(incident) {
  return `
    <article class="selected-case-summary result-selected-case">
      <div class="panel-title-line">
        <h2>Selected Case</h2>
        <span>CASE ${escapeHtml(incident.label)}</span>
      </div>
      <h1>${escapeHtml(incident.title)}</h1>
      <div class="result-meta-line">
        <span>${escapeHtml(incident.location || "Location unknown")}</span>
        <span>${escapeHtml(formatDateTime(incident.receivedAt).replace(" 2026", ""))}</span>
        ${incident.aqi ? `<span class="aqi">AQI ${escapeHtml(String(incident.aqi))}</span>` : ""}
        <span>${escapeHtml(incident.source)}</span>
        <span>Received ${escapeHtml(formatTime(incident.receivedAt))}</span>
      </div>
      <blockquote>${escapeHtml(incident.rawMessage)}</blockquote>
      <div class="knowledge-grid result-knowledge-grid">
        <div>
          <h2>What We Know</h2>
          <ul class="known-list">
            ${listItems((incident.knownFacts || []).slice(0, 3))}
          </ul>
        </div>
        <div>
          <h2 class="red-title">What We Don’t Know</h2>
          <ul class="unknown-list">
            ${listItems((incident.unknownFacts || incident.missingFields || []).slice(0, 3))}
          </ul>
        </div>
      </div>
      <div class="compact-insight">
        <strong>Low verification does not mean low urgency.</strong>
        <p>Evidence gaps reduce actionability, but they do not erase possible harm.</p>
      </div>
      <section class="command-metrics">
        <h2>Verification · Urgency · Actionability</h2>
        <div class="metric-card-grid command-score-grid">
          ${renderMetricCard("Verification", incident.scores.verification, metricCaption(incident, "verification"), "verification")}
          ${renderMetricCard("Urgency", incident.scores.urgency, metricCaption(incident, "urgency"), "urgency")}
          ${renderMetricCard("Actionability", incident.scores.actionability, metricCaption(incident, "actionability"), "actionability")}
        </div>
      </section>
    </article>
  `;
}

function renderCommandReadinessPanel(incident) {
  const readiness = decisionReadinessSummary(incident);

  return `
    <section>
      <div class="panel-title-line">
        <h2 class="readiness-title">
          <span class="readiness-title-icon" aria-hidden="true">${readinessIcon("ready")}</span>
          Decision Readiness
        </h2>
      </div>
      <p class="readiness-note">High-level summary. See Case Intelligence, Evidence and Safety for full details.</p>
      <div class="readiness-list">
        <article class="readiness-row">
          <span class="readiness-icon ${escapeHtml(readiness.statusTone)}" aria-hidden="true">
            ${readinessIcon("status")}
          </span>
          <div>
            <div class="readiness-row-heading">
              <h3>Current Status</h3>
              <b class="${stateClass(incident.operationalState)}">${escapeHtml(readiness.status)}</b>
            </div>
            <p>${escapeHtml(readiness.statusCopy)}</p>
          </div>
        </article>
        <article class="readiness-row">
          <span class="readiness-icon progress" aria-hidden="true">
            ${readinessIcon("progress")}
          </span>
          <div>
            <div class="readiness-row-heading">
              <h3>Review Progress</h3>
              <strong>${escapeHtml(readiness.progressText)}</strong>
            </div>
            <div class="readiness-track" aria-hidden="true">
              <i style="width:${readiness.progressPercent}%"></i>
            </div>
          </div>
        </article>
        <article class="readiness-row">
          <span class="readiness-icon concern" aria-hidden="true">
            ${readinessIcon("concern")}
          </span>
          <div>
            <h3>Key Concern</h3>
            <strong>${escapeHtml(readiness.concernTitle)}</strong>
            <p>${escapeHtml(readiness.concernDetail)}</p>
          </div>
        </article>
        <article class="readiness-row">
          <span class="readiness-icon gap" aria-hidden="true">
            ${readinessIcon("gap")}
          </span>
          <div>
            <h3>Main Information Gap</h3>
            <strong>${escapeHtml(readiness.gapTitle)}</strong>
            <p>${escapeHtml(readiness.gapDetail)}</p>
          </div>
        </article>
        <article class="readiness-row">
          <span class="readiness-icon next" aria-hidden="true">
            ${readinessIcon("next")}
          </span>
          <div>
            <h3>Recommended Next Step</h3>
            <strong>${escapeHtml(readiness.nextTitle)}</strong>
            <p>${escapeHtml(readiness.nextDetail)}</p>
          </div>
        </article>
      </div>
      <div class="decision-stack">
        <button class="primary-action" data-action="view" data-view="intelligence">Review Case Intelligence →</button>
        <button class="secondary-action" data-action="request-info">Request More Info</button>
      </div>
    </section>
  `;
}

function readinessIcon(type) {
  const icons = {
    status: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M12 3.8 21 19H3L12 3.8Z" /><path d="M12 9v4.6" /><path d="M12 17h.01" /></svg>',
    progress: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M12 3v9h9" /><path d="M19.2 15.9A8 8 0 1 1 8.1 4.8" /></svg>',
    concern: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M6 4v16" /><path d="M6 5h11l-1.7 3L17 11H6" /></svg>',
    gap: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M12 21s6-5.2 6-11a6 6 0 0 0-12 0c0 5.8 6 11 6 11Z" /><circle cx="12" cy="10" r="2.1" /></svg>',
    next: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M4 12h15" /><path d="m13 6 6 6-6 6" /></svg>',
    ready: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M12 3.5 19 6.6v5.2c0 4.4-2.9 7.2-7 8.7-4.1-1.5-7-4.3-7-8.7V6.6l7-3.1Z" /><path d="m8.8 12.2 2.2 2.2 4.5-5" /></svg>'
  };
  return icons[type] || icons.next;
}

function decisionReadinessSummary(incident) {
  const gates = Array.isArray(incident.safetyGates) ? incident.safetyGates : [];
  const dispatch = dispatchPresentation(incident);
  const status = statusLabels[incident.operationalState] || normalizeLabel(incident.operationalState);
  const evidenceReady = Array.isArray(incident.evidence) && incident.evidence.length > 0;
  const modelReady = Boolean(incident.modelReviews?.analyst && incident.modelReviews?.reviewer);
  const safetyReady = dispatch.status !== "locked";
  const humanDecisionReady = Boolean(incident.humanDecision?.decision || incident.humanDecision?.action);
  const readyCount = [evidenceReady, modelReady, safetyReady, humanDecisionReady].filter(Boolean).length;
  const totalChecks = 4;
  const conflictGate = getGate(incident, "G_CONFLICT");
  const medicalGate = getGate(incident, "G_MEDICAL");
  const blockedRequiredGates = gates.filter(gate =>
    ["G_LOCATION", "G_CONTACT", "G_RESOURCE"].includes(gate.id) &&
    ["blocked", "locked", "review"].includes(gate.status)
  );
  const missingFields = Array.isArray(incident.missingFields) ? incident.missingFields : [];
  const hasModelDisagreement = conflictGate?.status === "review" || incident.modelDebate?.consensus === "DISAGREEMENT";

  return {
    status,
    statusTone: readinessTone(incident),
    statusCopy: readinessStatusCopy(incident),
    progressText: `${readyCount} / ${totalChecks} checks ready`,
    progressPercent: Math.round((readyCount / totalChecks) * 100),
    ...readinessConcern(incident, { hasModelDisagreement, medicalGate, blockedRequiredGates }),
    ...readinessGap(incident, { blockedRequiredGates, missingFields, dispatch }),
    ...readinessNextStep(incident, { hasModelDisagreement, blockedRequiredGates, dispatch })
  };
}

function readinessTone(incident) {
  if (incident.operationalState === "DISPATCH_CANDIDATE") return "ready";
  if (incident.operationalState === "URGENT_VERIFICATION") return "urgent";
  if (incident.operationalState === "NEEDS_HUMAN_REVIEW") return "review";
  return "neutral";
}

function readinessStatusCopy(incident) {
  if (incident.operationalState === "DISPATCH_CANDIDATE") {
    return "This case is a strong candidate for further review and potential action.";
  }
  if (incident.operationalState === "URGENT_VERIFICATION") {
    return "High urgency requires immediate verification before any dispatch.";
  }
  if (incident.operationalState === "NEEDS_HUMAN_REVIEW") {
    return "Conflicting or sensitive evidence requires human review before action.";
  }
  if (incident.operationalState === "MERGE_OR_VERIFY") {
    return "Possible duplicate forwarding needs source review before action.";
  }
  if (incident.operationalState === "QUEUED_ACTION") {
    return "Useful support can be queued after higher-risk cases are reviewed.";
  }
  return "This case needs coordinator review before any operational action.";
}

function readinessConcern(incident, context) {
  const { hasModelDisagreement, medicalGate, blockedRequiredGates } = context;
  if (hasModelDisagreement) {
    return {
      concernTitle: "Model disagreement requires review",
      concernDetail: incident.modelDebate?.disagreement?.[0] ||
        getGate(incident, "G_CONFLICT")?.detail ||
        "Independent reviewers do not fully agree."
    };
  }
  if (medicalGate?.status === "triggered") {
    return {
      concernTitle: "Medical red flag requires review",
      concernDetail: medicalGate.detail || "Health risk is present and needs careful coordinator review."
    };
  }
  if (blockedRequiredGates.length) {
    const gate = blockedRequiredGates[0];
    return {
      concernTitle: `${gate.label} needs review`,
      concernDetail: gate.detail || "A required detail is incomplete."
    };
  }
  return {
    concernTitle: "No critical concern detected",
    concernDetail: "No major blocker is visible in the current summary."
  };
}

function readinessGap(incident, context) {
  const { blockedRequiredGates, missingFields, dispatch } = context;
  const locationBlocked = blockedRequiredGates.some(gate => gate.id === "G_LOCATION");
  const contactBlocked = blockedRequiredGates.some(gate => gate.id === "G_CONTACT");

  if (locationBlocked && contactBlocked) {
    return {
      gapTitle: "Exact location and verified contact missing",
      gapDetail: "Both are required before a dispatch decision can be considered."
    };
  }
  if (locationBlocked) {
    return {
      gapTitle: "Exact location missing",
      gapDetail: getGate(incident, "G_LOCATION")?.detail || "Exact address or GPS coordinates are still needed."
    };
  }
  if (contactBlocked) {
    return {
      gapTitle: "Verified contact missing",
      gapDetail: getGate(incident, "G_CONTACT")?.detail || "A trusted callback or coordinator contact is still needed."
    };
  }
  if (dispatch.status !== "locked" && incident.operationalState === "DISPATCH_CANDIDATE") {
    return {
      gapTitle: "None blocking",
      gapDetail: "All key readiness checks appear available for deeper review."
    };
  }
  if (missingFields.length) {
    return {
      gapTitle: sentenceCase(missingFields[0]),
      gapDetail: missingFields.length > 1
        ? `Also check: ${missingFields.slice(1, 3).join(", ")}.`
        : "This detail should be checked during review."
    };
  }
  return {
    gapTitle: "None",
    gapDetail: "No major information gap is recorded in the current case data."
  };
}

function readinessNextStep(incident, context) {
  const { hasModelDisagreement, blockedRequiredGates, dispatch } = context;
  if (hasModelDisagreement) {
    return {
      nextTitle: "Review case intelligence and evidence before safety approval.",
      nextDetail: "Inspect the model disagreement and supporting evidence first."
    };
  }
  if (blockedRequiredGates.length) {
    return {
      nextTitle: "Review case intelligence and obtain missing information.",
      nextDetail: incident.recommendedAction || "Check the full case details before moving to Safety."
    };
  }
  if (dispatch.status === "passed" || incident.operationalState === "DISPATCH_CANDIDATE") {
    return {
      nextTitle: "Review case intelligence and evidence before safety approval.",
      nextDetail: "Check the full case details and supporting evidence."
    };
  }
  return {
    nextTitle: "Review case intelligence before the next operational step.",
    nextDetail: incident.recommendedAction || "Use the next screen to understand why this case is prioritized."
  };
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
  const items = ["Incoming", "Evidence", "Blind AI Review", "Safety Gates", "Human Decision", "Action Brief"];
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
  const dispatch = dispatchPresentation(incident);
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
      <p class="dispatch-status-note ${dispatch.status}">${escapeHtml(dispatch.detail)}</p>
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
  if (gateId === "G_DISPATCH") {
    const dispatch = dispatchPresentation(incident);
    return `<div class="assessment-row"><span>Volunteer Dispatch</span><b class="gate-status ${dispatch.status}">${escapeHtml(dispatch.label)}</b></div>`;
  }
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

function renderVerifyInput({ compact = false } = {}) {
  const textActive = state.intakeMode !== "url";
  return `
    <section class="verify-hero ${compact ? "compact" : ""}">
      <div class="verify-symbol" aria-hidden="true">
        <span></span>
      </div>
      <div class="verify-content">
        <h1>Verify a Crisis Report</h1>
        <p>Paste a crisis report or public source URL. CrisisRoute AI extracts claims, evaluates evidence, and recommends safe next actions.</p>
        <div class="intake-tabs" role="tablist" aria-label="Input type">
          <button type="button" class="${textActive ? "active" : ""}" data-action="input-mode" data-input-mode="text">Paste Text</button>
          <button type="button" class="${!textActive ? "active" : ""}" data-action="input-mode" data-input-mode="url">Public URL</button>
        </div>
        ${textActive ? `
          <label class="sr-only" for="verify-input">Crisis report text</label>
          <div class="intake-field">
            <textarea id="verify-input" maxlength="8000" placeholder="Paste crisis report text here...">${escapeHtml(state.intakeValue)}</textarea>
            <span>${escapeHtml(String(state.intakeValue.length))} / 8000</span>
          </div>
        ` : `
          <label class="sr-only" for="verify-url">Public source URL</label>
          <div class="intake-field url-field">
            <input id="verify-url" type="url" placeholder="Paste a public article or report URL..." value="${escapeHtml(state.urlValue)}" />
            <small>Publicly accessible HTTP/HTTPS pages only.</small>
          </div>
        `}
      </div>
      <div class="verify-action-column">
        <button class="primary-action" data-action="verify-input">Analyze Report</button>
        <button class="secondary-action" data-action="load-demo">Load Malaysia Haze Demo</button>
        ${compact ? renderCompactInsightBox() : `<small>Try one of the demo cases for a guided walkthrough.</small>`}
      </div>
    </section>
  `;
}

function renderCompactInsightBox() {
  return `
    <aside class="verify-insight-box">
      <strong>Low verification ≠ low urgency.</strong>
      <p>Low verification means we lack information, not that the event is not serious.</p>
      <small>AI support · Not a final decision</small>
    </aside>
  `;
}

function renderCaseIntelligence(incident) {
  if (!incident) return renderNoSelectedCase();
  const reasons = priorityReasons(incident);

  return `
    <main class="page-canvas intelligence-page case-analysis-page">
      <button class="text-action back-link" data-action="view" data-view="command">← Back to Command Center</button>

      <section class="case-analysis-header">
        <div>
          <span class="section-kicker">CASE ${escapeHtml(incident.label)}</span>
          <h1>${escapeHtml(incident.title)}</h1>
          ${renderCompactCaseMetadata(incident)}
        </div>
        <aside class="operational-state-card ${stateClass(incident.operationalState)}">
          <span>Operational State</span>
          <strong>${escapeHtml(statusLabels[incident.operationalState] || normalizeLabel(incident.operationalState))}</strong>
          <p>Received ${escapeHtml(formatTime(incident.receivedAt))}</p>
        </aside>
      </section>

      <section class="analysis-card-grid overview-grid">
        <article class="analysis-card">
          <h2><span>1.</span> Case Overview</h2>
          <p>${escapeHtml(caseOverviewCopy(incident))}</p>
        </article>
        <article class="analysis-card">
          <h2><span>2.</span> Priority Rationale</h2>
          <ul class="rationale-list">
            ${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}
          </ul>
        </article>
      </section>

      <section class="metrics-section">
        <h2><span>3.</span> Key Metrics</h2>
        <div class="metric-card-grid">
          ${renderMetricCard("Verification", incident.scores.verification, metricCaption(incident, "verification"), "verification")}
          ${renderMetricCard("Urgency", incident.scores.urgency, metricCaption(incident, "urgency"), "urgency")}
          ${renderMetricCard("Actionability", incident.scores.actionability, metricCaption(incident, "actionability"), "actionability")}
        </div>
      </section>

      <section class="analysis-card-grid detail-grid">
        <article class="analysis-card claims-analysis-card">
          <h2><span>4.</span> Extracted Claims</h2>
          <div class="intelligence-claims-table">
            <div class="claims-head">
              <span>ID</span>
              <span>Claim</span>
              <span>Assessment</span>
            </div>
            ${incident.claims.map(claim => renderIntelligenceClaimRow(claim)).join("")}
          </div>
        </article>

        <article class="analysis-card missing-analysis-card">
          <h2><span>5.</span> Missing Information</h2>
          <ul class="missing-analysis-list">${(incident.missingFields || []).map(item => `<li>${escapeHtml(item)}</li>`).join("") || "<li>No missing information recorded.</li>"}</ul>
        </article>

        <article class="analysis-card risk-analysis-card">
          <h2><span>6.</span> Risk Flags</h2>
          <div class="risk-chip-list">
            ${(incident.riskFlags || []).map(flag => renderRiskFlagChip(flag)).join("") || `<span class="risk-chip neutral">No risk flags recorded</span>`}
          </div>
        </article>
      </section>

      <div class="case-analysis-cta">
        <button class="primary-action wide-cta" data-action="view" data-view="evidence">Inspect Evidence & Model Review →</button>
      </div>

      <section class="case-analysis-footer">
        <div>
          <h2 class="section-kicker">Why This Case Is Prioritized</h2>
          <p>${escapeHtml(incident.priorityRationale || incident.recommendedAction)}</p>
        </div>
        ${renderCompactProvenance()}
      </section>
    </main>
  `;
}

function renderNoSelectedCase() {
  return `
    <main class="page-canvas intelligence-page case-analysis-page">
      <section class="case-empty-state">
        <span class="section-kicker">Case Intelligence</span>
        <h1>No case selected.</h1>
        <p>Load demo cases or complete an analysis before opening Case Intelligence.</p>
        <button class="primary-action" data-action="view" data-view="command">Back to Command Center</button>
      </section>
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

function renderCompactCaseMetadata(incident) {
  const items = [
    incident.location || "Location unknown",
    incident.source,
    formatTime(incident.receivedAt),
    incident.aqi ? `AQI ${incident.aqi}` : "",
    formatPeople(incident.peopleCount)
  ].filter(Boolean);
  return `<div class="case-analysis-meta">${items.map(item => `<span>${escapeHtml(item)}</span>`).join("")}</div>`;
}

function caseOverviewCopy(incident) {
  const facts = Array.isArray(incident.knownFacts) ? incident.knownFacts.slice(0, 3) : [];
  const needs = Array.isArray(incident.needs) ? incident.needs.slice(0, 3) : [];
  const gaps = Array.isArray(incident.missingFields) ? incident.missingFields.slice(0, 2) : [];
  const sentences = [];

  if (facts.length) {
    sentences.push(`The report currently indicates ${facts.join(", ")}.`);
  } else if (incident.rawMessage) {
    sentences.push(incident.rawMessage.slice(0, 220));
  }

  if (incident.location) {
    sentences.push(`The approximate location is ${incident.location}.`);
  }

  if (needs.length) {
    sentences.push(`Requested or relevant support includes ${needs.join(", ")}.`);
  }

  if (gaps.length) {
    sentences.push(`Important details remain unclear: ${gaps.join(", ")}.`);
  }

  return sentences.join(" ");
}

function priorityReasons(incident) {
  const reasons = [];
  const risks = (incident.riskFlags || []).map(flag => String(flag).toLowerCase());
  const known = (incident.knownFacts || []).map(fact => String(fact).toLowerCase());
  const missing = incident.missingFields || [];

  if (risks.some(flag => /elderly|high-risk|asthma|medical|respiratory|breath/.test(flag)) ||
      known.some(fact => /elderly|asthma|breath|cough|respiratory/.test(fact))) {
    reasons.push("Reported health or respiratory risk raises the harm level if the report is true.");
  }
  if (incident.aqi) {
    reasons.push(`AQI ${incident.aqi} gives the case relevant haze-risk context.`);
  }
  if (incident.scores?.verification < 60 && incident.scores?.urgency >= 80) {
    reasons.push("Verification is incomplete, but urgency remains high because potential harm is time-sensitive.");
  }
  if (missing.length) {
    reasons.push(`Missing information keeps actionability constrained: ${missing.slice(0, 2).join(", ")}.`);
  }
  if (incident.modelDebate?.consensus === "DISAGREEMENT") {
    reasons.push("Model disagreement means this case should remain visible for human review.");
  }
  if (!reasons.length && incident.priorityRationale) {
    reasons.push(incident.priorityRationale);
  }
  if (!reasons.length && incident.recommendedAction) {
    reasons.push(incident.recommendedAction);
  }
  return reasons.slice(0, 5);
}

function renderMetricCard(label, value, caption, type) {
  return `
    <article class="metric-card ${type}">
      <span class="metric-label">${escapeHtml(label)}</span>
      <div class="metric-value"><strong>${escapeHtml(String(value))}</strong><small>/100</small></div>
      <div class="metric-track" aria-hidden="true"><i style="width:${Number(value)}%"></i></div>
      <p class="metric-caption">${escapeHtml(caption)}</p>
      <small class="metric-definition">${escapeHtml(metricDefinition(type))}</small>
    </article>
  `;
}

function metricCaption(incident, type) {
  if (type === "verification") {
    if (incident.scores.verification >= 75) return "Strong evidence support";
    if (incident.scores.verification >= 45) return "Partial evidence support";
    return "Limited evidence";
  }
  if (type === "urgency") return urgencyCaption(incident);
  return actionabilityCaption(incident);
}

function metricDefinition(type) {
  if (type === "verification") return "How well-supported is the report?";
  if (type === "urgency") return "If true, how dangerous or time-sensitive is it?";
  return "Do we have enough information to act safely?";
}

function renderIntelligenceClaimRow(claim) {
  const status = claimStatusLabels[claim.status] || normalizeLabel(claim.status);
  return `
    <article class="intelligence-claim-row">
      <span class="claim-id">${escapeHtml(claim.id)}</span>
      <p class="claim-copy">${escapeHtml(claim.text)}</p>
      <b class="claim-assessment ${claimStatusClass(claim.status)}">${escapeHtml(status)}</b>
    </article>
  `;
}

function renderRiskFlagChip(flag) {
  return `<span class="risk-chip ${riskFlagTone(flag)}">${escapeHtml(flag)}</span>`;
}

function riskFlagTone(flag) {
  const text = String(flag).toLowerCase();
  if (/medical|breath|respiratory|asthma|critical|emergency|severe/.test(text)) return "critical";
  if (/elderly|high-risk|haze|smoke|large|conflict|duplicate/.test(text)) return "warning";
  return "neutral";
}

function renderCompactProvenance() {
  const provenance = modeProvenance(state.mode);
  const lines = provenance.lines.join(" · ");
  return `
    <div class="compact-provenance">
      <h2 class="section-kicker">${escapeHtml(provenance.mode)} Trust Label</h2>
      <strong>${escapeHtml(provenance.title)}</strong>
      <p>${escapeHtml(lines)}</p>
      <button type="button" class="text-link" data-action="reset-browser-view">Reset browser view</button>
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
      <button class="text-action back-link" data-action="view" data-view="intelligence">← Back to Case Intelligence</button>
      <section class="screen-heading">
        <div>
          <span class="section-kicker">CASE ${escapeHtml(incident.label)}</span>
          <h1>Evidence & Model Review</h1>
          <p><strong>${escapeHtml(incident.title)}</strong> · Claim-evidence mapping and blind dual-model assessment</p>
        </div>
        <button class="primary-action" data-action="view" data-view="safety">Continue to Safety →</button>
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
    <main class="page-canvas safety-page safety-redesign">
      <button class="text-action back-link" data-action="view" data-view="evidence">← Back to Evidence</button>
      <section class="safety-workspace">
        <section class="safety-main-column">
          <section class="safety-top-grid">
            ${renderSafetyCaseHeader(incident)}
            <aside class="safety-principle-card">
              <p>"High urgency requires verification before any dispatch."</p>
              <strong>AI assists. Humans decide.</strong>
            </aside>
          </section>
          ${renderSafetySummary(incident)}
          <section class="safety-assessment-grid">
            ${renderDecisionPath(incident)}
            ${renderDispatchLessonCard(incident)}
          </section>
          ${renderSafetyGateTable(incident)}
          ${renderNextSafeActions(incident)}
        </section>
        <aside class="human-decision-panel safety-decision-sidebar">
          <div class="human-panel-heading">
            <span class="human-panel-icon" aria-hidden="true">${safetyIcon("human")}</span>
            <div>
              <h2>Human Decision</h2>
              <p>Review the safety assessment and select the next action. Only safe and allowed actions are available.</p>
            </div>
          </div>
          ${renderHumanDecisionButtons(incident)}
        </aside>
      </section>
    </main>
  `;
}

function renderSafetyCaseHeader(incident) {
  const pill = safetyHeaderPill(incident);
  return `
    <section class="safety-header">
      <span class="section-kicker">CASE ${escapeHtml(incident.label)}</span>
      <div class="safety-title-row">
        <h1>${escapeHtml(incident.title)}</h1>
        <span class="safety-urgency-pill ${escapeHtml(pill.tone)}">${safetyIcon(pill.icon)} ${escapeHtml(pill.label)}</span>
      </div>
      <p>${escapeHtml(incident.caseId)} · ${escapeHtml(incident.location || "Location unknown")} · ${scoreText(incident)}</p>
    </section>
  `;
}

function safetyHeaderPill(incident) {
  if (incident.operationalState === "DISPATCH_CANDIDATE") return { label: "Candidate", tone: "ready", icon: "check" };
  if (incident.operationalState === "NEEDS_HUMAN_REVIEW") return { label: "Review", tone: "review", icon: "alert" };
  if (incident.operationalState === "MERGE_OR_VERIFY") return { label: "Merge", tone: "review", icon: "info" };
  if (incident.operationalState === "QUEUED_ACTION") return { label: "Queued", tone: "neutral", icon: "flag" };
  return { label: "Urgent", tone: "urgent", icon: "alert" };
}

function renderSafetySummary(incident) {
  const dispatch = dispatchPresentation(incident);
  const stateLabel = statusLabels[incident.operationalState] || normalizeLabel(incident.operationalState);
  const blockers = safetyBlockers(incident);
  const blockerSummary = blockers.length ? blockers.slice(0, 2).join(" · ") : "None blocking";
  const dispatchLabel = dispatch.status === "passed"
    ? "AVAILABLE"
    : dispatch.status === "review"
      ? "REVIEW REQUIRED"
      : "LOCKED";
  const summaryCopy = dispatch.status === "passed"
    ? "System safety checks indicate this case may proceed to human approval."
    : "System safety checks prevent dispatch at this time.";
  const summaryDetail = dispatch.status === "passed"
    ? "The coordinator must still review details and explicitly record the decision."
    : "Key information is still missing. Review the details below and choose an allowed human action.";

  return `
    <section class="safety-summary-panel">
      <div class="safety-section-heading">
        <span class="safety-section-icon" aria-hidden="true">${safetyIcon("shield")}</span>
        <div>
          <h2>Safety Summary</h2>
          <strong>${escapeHtml(summaryCopy)}</strong>
          <p>${escapeHtml(summaryDetail)}</p>
        </div>
      </div>
      <div class="safety-summary-grid">
        ${renderSafetySummaryCard("Current State", stateLabel, safetyStateSummary(incident), "state")}
        ${renderSafetySummaryCard("Dispatch Status", dispatchLabel, dispatch.requirement, dispatch.status)}
        ${renderSafetySummaryCard("Key Blockers", blockerSummary, blockers.length ? "Resolve these before dispatch approval can be considered." : "All key safety prerequisites appear available.", blockers.length ? "blocked" : "passed")}
      </div>
    </section>
  `;
}

function renderSafetySummaryCard(label, value, detail, tone) {
  return `
    <article class="safety-summary-card ${escapeHtml(tone)}">
      <span aria-hidden="true">${safetyIcon(summaryIconType(label, tone))}</span>
      <div>
        <h3>${escapeHtml(label)}</h3>
        <strong>${escapeHtml(value)}</strong>
        <p>${escapeHtml(detail)}</p>
      </div>
    </article>
  `;
}

function summaryIconType(label, tone) {
  if (label === "Current State") return "people";
  if (label === "Key Blockers") return tone === "passed" ? "check" : "info";
  return tone === "locked" ? "lock" : tone === "review" ? "alert" : "check";
}

function renderDecisionPath(incident) {
  const medical = getGate(incident, "G_MEDICAL");
  const location = getGate(incident, "G_LOCATION");
  const contact = getGate(incident, "G_CONTACT");
  const dispatch = dispatchPresentation(incident);
  const steps = [
    { label: "Report Received", status: "passed", detail: "Report entered the safety workflow." },
    { label: "Medical Red Flag", sublabel: `Urgency: ${incident.scores.urgency}`, status: medical?.status || "passed", detail: medical?.detail || "" },
    { label: "Location", status: location?.status || "passed", detail: location?.detail || "" },
    { label: "Contact", status: contact?.status || "passed", detail: contact?.detail || "" },
    { label: "Dispatch", status: dispatch.status, detail: dispatch.requirement, stateText: `Dispatch ${dispatch.label}` }
  ];

  return `
    <section class="decision-path">
      <div class="safety-card-heading">
        <span aria-hidden="true">${safetyIcon("shield")}</span>
        <h2>Decision Path</h2>
      </div>
      <div class="path-steps">
        ${steps
          .map(
            step => `
              <div class="path-step ${step.status}">
                <span aria-hidden="true">${safetyIcon(pathIconType(step.status))}</span>
                <div>
                  <strong>${escapeHtml(step.label)}</strong>
                  ${step.sublabel ? `<small>${escapeHtml(step.sublabel)}</small>` : ""}
                </div>
                ${step.stateText ? `<span class="sr-only">${escapeHtml(step.stateText)}</span>` : ""}
                <p>${escapeHtml(pathDetail(step.status, step.detail))}</p>
              </div>
            `
          )
          .join("")}
      </div>
      <p class="path-footnote">${escapeHtml(dispatch.countText)} ${escapeHtml(dispatch.detail)}</p>
    </section>
  `;
}

function renderSafetyGateTable(incident) {
  const gateOrder = ["G_MEDICAL", "G_LOCATION", "G_CONTACT", "G_RESOURCE", "G_CONFLICT"];
  return `
    <section class="gate-table-section">
      <div class="safety-card-heading">
        <span aria-hidden="true">${safetyIcon("shield")}</span>
        <div>
          <h2>Safety Gate Checks</h2>
          <p>The following gates must be passed before volunteer dispatch can be considered.</p>
        </div>
      </div>
      <div class="gate-table">
        <div class="gate-table-row gate-table-head">
          <strong>Check</strong>
          <span>Status</span>
          <p>Details</p>
        </div>
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

function renderDispatchLessonCard(incident) {
  const dispatch = dispatchPresentation(incident);
  return `
    <aside class="dispatch-lesson-card ${escapeHtml(dispatch.status)}">
      <div class="dispatch-lesson-icon" aria-hidden="true">${safetyIcon("lungs")}</div>
      <h2>URGENT</h2>
      <strong>≠</strong>
      <h2>DISPATCHABLE</h2>
      <p>High urgency triggers immediate verification priority, not automatic dispatch.</p>
      <div class="dispatch-lesson-note">
        <span aria-hidden="true">${safetyIcon("info")}</span>
        <p>${escapeHtml(dispatchLessonCopy(incident, dispatch))}</p>
      </div>
    </aside>
  `;
}

function renderNextSafeActions(incident) {
  return `
    <section class="next-safe-actions-panel">
      <div class="safety-card-heading">
        <span aria-hidden="true">${safetyIcon("flag")}</span>
        <div>
          <h2>Next Safe Actions</h2>
          <p>Recommended actions based on current safety assessment.</p>
        </div>
      </div>
      <ol class="safe-actions">
        ${(incident.safeNextActions || []).map(action => `<li>${escapeHtml(action)}</li>`).join("")}
      </ol>
    </section>
  `;
}

function renderDispatchLockPanel(incident) {
  const dispatch = dispatchPresentation(incident);
  return `
    <section class="dispatch-lock-panel ${dispatch.status}">
      <h2>${escapeHtml(dispatch.panelTitle)}</h2>
      <p>${escapeHtml(dispatch.detail)}</p>
    </section>
  `;
}

function renderHumanDecisionButtons(incident) {
  const dispatch = dispatchPresentation(incident);
  const workflow = getDecisionWorkflow(incident);
  const form = workflow.form;
  const requirements = acknowledgementRequirements(incident, form.action);
  const actions = actionsForState(incident.operationalState);
  const busy = ["decision_loading", "brief_loading", "audit_loading"].includes(workflow.phase);
  const liveReady = state.mode !== DATA_MODES.live || liveReadiness(state.health).ready;
  const requiresReason = ["APPROVE_ACTION", "REJECT_ACTION"].includes(form.action) || conflictReviewRequiredForUi(incident);
  return `
    <form class="decision-form" aria-busy="${busy}">
      <section class="human-dispatch-card ${dispatch.status}" aria-label="Dispatch status">
        <span aria-hidden="true">${safetyIcon(dispatch.status === "passed" ? "check" : "lock")}</span>
        <div>
          <strong>${escapeHtml(dispatch.label)}</strong>
          <p class="dispatch-status-note ${dispatch.status}">
            <span class="sr-only">${escapeHtml(`${dispatch.label}. ${dispatch.detail}`)}</span>
            ${escapeHtml(humanDispatchCopy(incident, dispatch))}
          </p>
        </div>
      </section>
      <div class="decision-context">
        <span>Case ID <strong>${escapeHtml(incident.caseId)}</strong></span>
        <span>State <strong>${escapeHtml(incident.operationalState)}</strong></span>
        <span>Model Consensus <strong>${escapeHtml(incident.modelDebate?.consensus || "Not available")}</strong></span>
      </div>
      <section class="human-form-section">
        <div class="human-field-heading">
          <span aria-hidden="true">${safetyIcon("human")}</span>
          <div>
            <label for="human-action">Select Human Action</label>
            <p>Choose the most appropriate next step.</p>
          </div>
        </div>
        <select id="human-action" ${busy ? "disabled" : ""}>
          ${actions.map(action => `<option value="${escapeHtml(action)}" ${form.action === action ? "selected" : ""}>${escapeHtml(actionLabel(action))}</option>`).join("")}
        </select>
      </section>
      <section class="human-form-section">
        <div class="human-field-heading">
          <span aria-hidden="true">${safetyIcon("document")}</span>
          <div>
            <label for="human-reason">Reason ${requiresReason ? "(Required)" : "(Optional)"}</label>
            <p>Enter the operator's own reason.</p>
          </div>
        </div>
        <textarea id="human-reason" maxlength="500" placeholder="Exact location and verified contact are missing. Request verification before dispatch." ${busy ? "disabled" : ""}>${escapeHtml(form.reason)}</textarea>
        <small class="reason-count">${escapeHtml(String(form.reason.length))} / 500</small>
      </section>
      <fieldset class="acknowledgement-list">
        <legend>Human Acknowledgements</legend>
        ${acknowledgementControl("acknowledgeHumanDecision", "I confirm this is a human decision.", form, requirements, busy)}
        ${acknowledgementControl("acknowledgeNoAutomaticExecution", "I understand CrisisRoute AI does not execute real-world action.", form, requirements, busy)}
        ${requirements.acknowledgeReview || form.action === "APPROVE_ACTION"
          ? acknowledgementControl("acknowledgeReview", "I reviewed the model disagreement/conflict.", form, requirements, busy)
          : ""}
      </fieldset>
      <div class="gate-summary" aria-label="Safety Gate summary">
        ${renderGateStatusStrip(incident)}
      </div>
      ${!liveReady ? `<p class="form-error" role="alert">LIVE workflow unavailable: ${escapeHtml(liveReadiness(state.health).missing.join(", "))}</p>` : ""}
      ${form.errors?.length ? `<ul class="form-errors" role="alert">${form.errors.map(error => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
      ${workflow.error ? `<p class="form-error" role="alert">${escapeHtml(workflow.error)}</p>` : ""}
      <p class="workflow-status" aria-live="polite">
        Decision: ${escapeHtml(workflow.decisionStatus)} · Brief: ${escapeHtml(workflow.briefStatus)} · Audit: ${escapeHtml(workflow.auditStatus)}
      </p>
      ${workflow.decisionStatus === "RECORDED" ? `<p class="recorded-status">RECORDED — NOT EXECUTED</p>` : ""}
      <div class="decision-form-actions">
        <button type="button" class="primary-action" data-action="decision-submit" ${busy || !liveReady || workflow.decisionStatus === "RECORDED" ? "disabled" : ""}>${busy ? "Recording…" : "Submit Decision →"}</button>
        <button type="button" class="secondary-action" data-action="decision-reset" ${busy ? "disabled" : ""}>Cancel / Reset</button>
        ${workflow.canRetryBrief ? `<button type="button" class="secondary-action" data-action="retry-brief">Retry Brief — Decision remains recorded</button>` : ""}
      </div>
      <p class="human-principle-note">AI assists. Humans decide.</p>
      <p class="demo-auth-notice">Demo local operator — no production identity authentication.</p>
    </form>
  `;
}

function renderGateStatusStrip(incident) {
  return (incident.safetyGates || [])
    .filter(gate => ["G_LOCATION", "G_CONTACT", "G_RESOURCE", "G_CONFLICT"].includes(gate.id))
    .map(gate => {
      const status = gate.status || (gate.passed ? "passed" : "blocked");
      return `<span class="gate-strip ${escapeHtml(status)}">${escapeHtml(gate.id.replace("G_", ""))}: <strong>${escapeHtml(status)}</strong></span>`;
    })
    .join("");
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

function safetyBlockers(incident) {
  return (incident.safetyGates || [])
    .filter(gate => ["G_LOCATION", "G_CONTACT", "G_RESOURCE", "G_CONFLICT"].includes(gate.id))
    .filter(gate => ["blocked", "locked", "review"].includes(gate.status))
    .map(gate => {
      if (gate.id === "G_LOCATION") return "Exact location";
      if (gate.id === "G_CONTACT") return "Verified contact";
      if (gate.id === "G_CONFLICT") return "Model conflict";
      if (gate.id === "G_RESOURCE") return "Resource availability";
      return gate.label;
    });
}

function safetyStateSummary(incident) {
  if (incident.operationalState === "DISPATCH_CANDIDATE") return "Candidate for bounded action after human review.";
  if (incident.operationalState === "URGENT_VERIFICATION") return "High urgency, needs more information.";
  if (incident.operationalState === "NEEDS_HUMAN_REVIEW") return "Coordinator review required before action.";
  if (incident.operationalState === "MERGE_OR_VERIFY") return "Possible duplicate source requires review.";
  if (incident.operationalState === "QUEUED_ACTION") return "Can wait behind higher-risk cases.";
  return incident.recommendedAction || "Coordinator review required.";
}

function pathIconType(status) {
  if (status === "passed") return "check";
  if (status === "triggered") return "alert";
  if (status === "blocked") return "lock";
  if (status === "review") return "alert";
  return "lock";
}

function dispatchLessonCopy(incident, dispatch) {
  if (dispatch.status === "passed") {
    return "Safety checks support eligibility, but only a human coordinator can record the decision.";
  }
  if (dispatch.status === "review") {
    return "Model disagreement must be reviewed before this case can move forward.";
  }
  const blockers = safetyBlockers(incident);
  return blockers.length
    ? `Once ${blockers.slice(0, 2).join(" and ").toLowerCase()} are verified, the case can be reassessed for dispatch eligibility.`
    : "Once missing safety information is verified, this case can be reassessed for dispatch eligibility.";
}

function humanDispatchCopy(incident, dispatch) {
  if (dispatch.status === "passed") {
    return "Safety prerequisites appear available. A human decision is still required before any brief is generated.";
  }
  if (dispatch.status === "review") {
    return "Model conflict or review requirements remain. Dispatch approval is not automatic.";
  }
  const blockers = safetyBlockers(incident);
  if (blockers.length) {
    return `${blockers.slice(0, 2).join(" and ")} ${blockers.length === 1 ? "is" : "are"} still missing. Approval cannot be submitted yet.`;
  }
  return "Required gates or dispatch eligibility are not confirmed. Approval cannot be submitted yet.";
}

function safetyIcon(type) {
  const icons = {
    alert: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M12 3.8 21 19H3L12 3.8Z" /><path d="M12 9v4.5" /><path d="M12 17h.01" /></svg>',
    check: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="m5.5 12.5 4.1 4.1 8.9-9.2" /></svg>',
    document: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M7 3.5h7l3 3V20H7z" /><path d="M14 3.5V7h3" /><path d="M9.5 11h5" /><path d="M9.5 14.5h5" /></svg>',
    flag: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M6 4v16" /><path d="M6 5h11l-1.5 3L17 11H6" /></svg>',
    human: '<svg viewBox="0 0 24 24" role="img" focusable="false"><circle cx="12" cy="8" r="3.4" /><path d="M5.5 20c.9-4.1 3.3-6 6.5-6s5.6 1.9 6.5 6" /></svg>',
    info: '<svg viewBox="0 0 24 24" role="img" focusable="false"><circle cx="12" cy="12" r="8.5" /><path d="M12 10.8v5.2" /><path d="M12 8h.01" /></svg>',
    lock: '<svg viewBox="0 0 24 24" role="img" focusable="false"><rect x="5.5" y="10" width="13" height="9" rx="2" /><path d="M8.5 10V7.8a3.5 3.5 0 0 1 7 0V10" /></svg>',
    lungs: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M12 4v7" /><path d="M12 11c-2.4-.4-4.4-2.1-5.2-4.3C4.7 9 4.4 13.8 5.9 17.8c.5 1.3 2.2 1.6 3.1.5 1.6-2 2.6-4.4 3-7.3Z" /><path d="M12 11c2.4-.4 4.4-2.1 5.2-4.3 2.1 2.3 2.4 7.1.9 11.1-.5 1.3-2.2 1.6-3.1.5-1.6-2-2.6-4.4-3-7.3Z" /></svg>',
    people: '<svg viewBox="0 0 24 24" role="img" focusable="false"><circle cx="9" cy="8" r="3" /><path d="M3.8 18.5c.8-3.6 2.7-5.1 5.2-5.1s4.4 1.5 5.2 5.1" /><circle cx="16.5" cy="9.5" r="2.2" /><path d="M15 14.2c2.1.2 3.8 1.5 4.6 4.3" /></svg>',
    shield: '<svg viewBox="0 0 24 24" role="img" focusable="false"><path d="M12 3.5 19 6.6v5.1c0 4.4-2.9 7.3-7 8.8-4.1-1.5-7-4.4-7-8.8V6.6z" /></svg>'
  };
  return icons[type] || icons.info;
}

function renderActionBriefView(incident) {
  const workflow = getDecisionWorkflow(incident);
  const brief = workflow.brief || incident.operationalBrief;
  const proof = workflow.proofCapsule || incident.proofCapsule;
  if (!workflow.decision || !brief) return renderActionBriefLocked(incident, workflow);
  const rules = displayRules(workflow);
  const decision = workflow.decision;
  const nextSteps = actionNextSteps(incident, brief);
  const actionLabelText = titleCaseLabel(actionLabel(decision.action || brief.decisionAction));

  return `
    <main class="page-canvas action-page">
      <button class="text-action back-link" data-action="view" data-view="safety">← Back to Safety</button>
      <section class="action-page-heading">
        <div>
          <span class="section-kicker">Action Brief</span>
          <h1>Action Brief</h1>
          <p>Human-approved next steps and decision record.</p>
          <small>Generated from the recorded human decision and current safety state.</small>
        </div>
        <aside class="action-principle-card">
          <p>"From decision to action, with accountability."</p>
          <strong>AI assists. Humans decide.</strong>
        </aside>
      </section>
      ${renderActionCaseHeader(incident)}
      <section class="action-layout">
        <section class="action-main-column">
          <section class="decision-record-card">
            <span class="decision-record-icon" aria-hidden="true">${safetyIcon("check")}</span>
            <div class="decision-record-copy">
              <span class="section-kicker">Decision Recorded</span>
              <h2>${escapeHtml(actionLabelText)}</h2>
              <p>${escapeHtml(decisionOutcomeCopy(incident, brief, decision))}</p>
            </div>
            <div class="decision-record-meta">
              ${actionMetric("Priority", brief.priority || "Not available", priorityTone(brief.priority), "alert")}
              ${actionMetric("Execution", normalizeLabel(brief.executionStatus || decision.executionStatus || "NOT_EXECUTED").toUpperCase(), "neutral", "info")}
              ${actionMetric("Recorded", formatTime(decision.recordedAt || brief.generatedAt), "neutral", "document")}
            </div>
          </section>
          <section class="action-content-grid">
            ${renderDecisionSummaryCard(incident, brief, decision)}
            ${renderWhatHappensNext(nextSteps)}
          </section>
          ${renderExecutionNote(brief)}
        </section>
        <aside class="action-side-column">
          ${renderProofCapsulePanel(workflow, brief, proof, rules)}
          ${renderServerAudit(workflow.audit)}
          ${renderModeProvenanceCard()}
        </aside>
      </section>
    </main>
  `;
}

function renderActionBriefLocked(incident, workflow = getDecisionWorkflow(incident)) {
  const decisionRecorded = workflow?.decisionStatus === "RECORDED";
  return `
    <main class="page-canvas action-page">
      <button class="text-action back-link" data-action="view" data-view="safety">← Back to Safety</button>
      <section class="action-locked-state">
        <span class="section-kicker">Action Brief</span>
        <h1>Action Brief</h1>
        <p class="action-subtitle">${escapeHtml(incident.caseId)} · ${escapeHtml(incident.title)}</p>
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

function renderActionCaseHeader(incident) {
  const pill = safetyHeaderPill(incident);
  return `
    <section class="action-case-header">
      <div>
        <span class="section-kicker">Case ${escapeHtml(incident.label || "")}</span>
        <h2>${escapeHtml(incident.title)}</h2>
        <p>${escapeHtml(incident.caseId)} · ${escapeHtml(incident.location || "Location unavailable")} · ${escapeHtml(scoreText(incident))}</p>
      </div>
      <span class="safety-urgency-pill ${escapeHtml(pill.tone)}" aria-label="${escapeHtml(statusLabels[incident.operationalState] || normalizeLabel(incident.operationalState))}">
        ${safetyIcon(pill.icon)}
        ${escapeHtml(statusLabels[incident.operationalState] || normalizeLabel(incident.operationalState))}
      </span>
    </section>
  `;
}

function renderDecisionSummaryCard(incident, brief, decision) {
  return `
    <section class="action-info-card decision-summary-card">
      <div class="action-card-heading">
        <span aria-hidden="true">${safetyIcon("document")}</span>
        <h2>Decision Summary</h2>
      </div>
      <div class="decision-summary-list">
        ${summaryRow("Human Action", titleCaseLabel(actionLabel(decision.action || brief.decisionAction)))}
        ${summaryRow("Human Reason", decision.reason || brief.humanReason || "No additional reason supplied.")}
        ${summaryRow("Case State", incident.operationalState || brief.operationalState || "Not available")}
        ${summaryRow("Model Consensus", incident.modelDebate?.consensus || "Not available")}
        ${summaryRow("Why this action?", decisionRationale(incident, brief))}
      </div>
    </section>
  `;
}

function renderWhatHappensNext(nextSteps) {
  return `
    <section class="action-info-card next-actions-card">
      <div class="action-card-heading">
        <span aria-hidden="true">${safetyIcon("flag")}</span>
        <div>
          <h2>What Happens Next</h2>
          <p>Recommended safe next actions based on the current decision.</p>
        </div>
      </div>
      <ol class="action-step-list">
        ${nextSteps.map(step => `<li><span>${escapeHtml(step)}</span></li>`).join("")}
      </ol>
    </section>
  `;
}

function renderExecutionNote(brief) {
  const recordStatus = brief.recordStatus || "RECORDED";
  const executionStatus = brief.executionStatus || "NOT_EXECUTED";
  return `
    <section class="execution-note" aria-label="Execution status">
      <span aria-hidden="true">${safetyIcon("info")}</span>
      <div>
        <strong>${escapeHtml(normalizeLabel(recordStatus))}, ${escapeHtml(normalizeLabel(executionStatus).toLowerCase())}</strong>
        <p>CrisisRoute records the human decision and recommended next steps. Real-world execution remains outside the platform.</p>
      </div>
    </section>
  `;
}

function renderProofCapsulePanel(workflow, brief, proof, rules) {
  const liveProof = state.mode === DATA_MODES.live && proof;
  return `
    <section class="action-side-card proof-capsule-panel">
      <div class="proof-title-row">
        <div class="action-card-heading">
          <span aria-hidden="true">${safetyIcon("shield")}</span>
          <div>
            <h2>Proof Capsule</h2>
            <p>${liveProof ? "Server-issued local payload receipt." : "No server-issued capsule for this case."}</p>
          </div>
        </div>
        <span class="mode-proof-badge">${escapeHtml(proofModeBadge(workflow))}</span>
      </div>
      <div class="proof-actions">
        <button type="button" class="secondary-action" data-action="verify-proof" ${!rules.proofVerificationEnabled ? "disabled" : ""}>Verify Local Proof</button>
        <button type="button" class="secondary-action" data-action="export-receipt" ${!liveProof || !workflow.audit ? "disabled" : ""}>Export Receipt JSON</button>
      </div>
      ${liveProof ? renderLiveProofNotice(workflow) : renderDemoProofNotice()}
      <div class="proof-status-table">
        ${summaryRow("Status", rules.proofStatus || "UNAVAILABLE")}
        ${summaryRow("Type", proofTypeLabel(liveProof))}
        ${summaryRow("Verification", proofVerificationLabel(workflow, liveProof))}
        ${summaryRow("Server Capsule", liveProof ? "Issued" : "Not Issued")}
      </div>
      ${liveProof ? `
        <details class="proof-detail-panel">
          <summary>View Capsule Details →</summary>
          ${renderServerProof(brief, proof)}
        </details>
      ` : `<p class="proof-footnote">This view does not prove the report is true or that real-world action occurred.</p>`}
    </section>
  `;
}

function renderLiveProofNotice(workflow) {
  return `
    <article class="proof-receipt demo-proof live-proof-status">
      <strong>${escapeHtml(workflow.proofStatus || "UNVERIFIED")}</strong>
      <p>Live proof represents local payload integrity only. It is not evidence of real-world execution.</p>
    </article>
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
      <h3>Server Capsule</h3>
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
  const label = state.mode === DATA_MODES.replay ? "REPLAY ONLY" : "DEMO ONLY";
  const copy = state.mode === DATA_MODES.replay
    ? "Sanitized Replay data cannot be marked Proof Valid and does not imply a new live inference."
    : "Mock and Replay data cannot be marked Proof Valid and cannot use server Proof verification.";
  return `
    <article class="proof-receipt demo-proof">
      <strong>${escapeHtml(label)}</strong>
      <p>${escapeHtml(copy)}</p>
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
  if (!audit) {
    return `
      <section class="action-side-card audit-chain">
        <div class="action-card-heading">
          <span aria-hidden="true">${safetyIcon("document")}</span>
          <h2>Audit Trail</h2>
        </div>
        <p>Audit unavailable.</p>
      </section>
    `;
  }
  const entries = audit.entries || [];
  return `
    <section class="action-side-card audit-chain">
      <div class="audit-heading">
        <div class="action-card-heading">
          <span aria-hidden="true">${safetyIcon("document")}</span>
          <div>
            <h2>Audit Trail</h2>
            <p>${escapeHtml(`${audit.entryCount || entries.length} recorded ${Number(audit.entryCount || entries.length) === 1 ? "event" : "events"} in this session.`)}</p>
          </div>
        </div>
        <strong>Chain: ${escapeHtml(auditChainLabel(audit))}</strong>
      </div>
      <details class="audit-detail-panel">
        <summary>View Audit Details →</summary>
        <div class="audit-entry-list">
          ${entries.map(entry => `
            <article class="audit-entry">
              <span>Sequence ${escapeHtml(entry.sequence)}</span>
              <strong>${escapeHtml(actionLabel(entry.action))}</strong>
              <time>${escapeHtml(formatDateTime(entry.recordedAt))}</time>
              ${hashReceiptRow("Previous Hash", entry.previousHash === null ? "GENESIS: null" : entry.previousHash)}
              ${hashReceiptRow("Entry Hash", entry.entryHash)}
            </article>
          `).join("")}
        </div>
        <p>Persistence: ${escapeHtml(audit.persistence)} · External anchoring: ${escapeHtml(audit.externalAnchoring)}</p>
      </details>
    </section>
  `;
}

function renderModeProvenanceCard() {
  const provenance = modeProvenance(state.mode);
  const label = state.mode === DATA_MODES.live ? "Live Provenance" : state.mode === DATA_MODES.replay ? "Replay Provenance" : "Demo Provenance";
  return `
    <section class="action-side-card mode-provenance-card">
      <div class="action-card-heading">
        <span aria-hidden="true">${safetyIcon("info")}</span>
        <div>
          <h2>${escapeHtml(label)}</h2>
          <p>${escapeHtml(provenance.title)}</p>
        </div>
      </div>
      <p>This view records a decision handoff. It does not prove the report is true or that real-world action occurred.</p>
      <details class="provenance-detail-panel">
        <summary>View Details →</summary>
        <ul>${provenance.lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
        <p>Local payload integrity only. No blockchain or external anchoring is claimed unless a live backend explicitly provides it.</p>
      </details>
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

function actionMetric(label, value, tone, icon) {
  return `
    <article class="action-metric ${escapeHtml(tone || "neutral")}">
      <span aria-hidden="true">${safetyIcon(icon)}</span>
      <div>
        <small>${escapeHtml(label)}</small>
        <strong>${escapeHtml(value || "Not available")}</strong>
      </div>
    </article>
  `;
}

function summaryRow(label, value) {
  return `
    <div class="summary-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "Not available")}</strong>
    </div>
  `;
}

function actionNextSteps(incident, brief) {
  const briefSteps = Array.isArray(brief?.nextSteps) ? brief.nextSteps : [];
  const incidentSteps = Array.isArray(incident.safeNextActions) ? incident.safeNextActions : [];
  return (briefSteps.length ? briefSteps : incidentSteps).filter(Boolean).slice(0, 8);
}

function titleCaseLabel(value) {
  return String(value || "Not available")
    .toLowerCase()
    .replace(/\b[a-z]/g, char => char.toUpperCase());
}

function decisionOutcomeCopy(incident, brief, decision) {
  if (brief.summary) return brief.summary;
  if (decision.reason) return decision.reason;
  return incident.recommendedAction || "A human decision was recorded for this case.";
}

function decisionRationale(incident, brief) {
  if (brief.summary) return brief.summary;
  if (incident.recommendedAction) return incident.recommendedAction;
  return dispatchPresentation(incident).detail;
}

function priorityTone(priority) {
  return ["CRITICAL", "HIGH"].includes(String(priority || "").toUpperCase()) ? "critical" : "neutral";
}

function proofModeBadge(workflow) {
  if (state.mode === DATA_MODES.live && workflow.proofCapsule) return "LIVE CAPSULE";
  if (state.mode === DATA_MODES.live) return "LIVE";
  if (state.mode === DATA_MODES.replay) return "REPLAY ONLY";
  return "DEMO ONLY";
}

function proofTypeLabel(liveProof) {
  if (liveProof) return "Server-issued local payload integrity";
  if (state.mode === DATA_MODES.replay) return "Sanitized Replay";
  return "Local Snapshot (Demo)";
}

function proofVerificationLabel(workflow, liveProof) {
  if (!liveProof) return "Not Applicable";
  return normalizeLabel(workflow.proofStatus || "UNVERIFIED");
}

function auditChainLabel(audit) {
  if (audit.chainValid === true) return state.mode === DATA_MODES.live ? "LIVE" : "VALID";
  if (audit.demoOnly) return state.mode === DATA_MODES.replay ? "REPLAY ONLY" : "DEMO ONLY";
  return "INVALID";
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
  const dispatch = dispatchPresentation(incident);
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
    { label: "Safety", time: safetyTime, detail: dispatch.auditSafety },
    { label: "Human", time: humanTime, detail: incident.humanDecision?.decidedBy || "Pending" },
    { label: "Action", time: humanTime, detail: dispatch.auditAction }
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

function getStrictSelectedIncident() {
  return state.incidents.find(item => item.caseId === state.selectedCaseId) || null;
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
  return "DEMO SNAPSHOT";
}

function shortModeLabel(mode) {
  if (mode === DATA_MODES.replay) return "Replay";
  if (mode === DATA_MODES.live) return "Live";
  return "Demo";
}

function gonkaLabel() {
  if (state.mode === DATA_MODES.mock) return "DEMO DATA";
  if (state.mode === DATA_MODES.replay) return "RECORDED RESPONSE";
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

function compactProvenanceLabel() {
  if (state.mode === DATA_MODES.mock) return "Demo · Synthetic Data";
  if (state.mode === DATA_MODES.replay) return "Replay · Recorded Response";
  return isLiveConnected() ? "Live · Gonka Connected" : "Live · Backend Unavailable";
}

function progressStageCopy(stage) {
  if (!state.liveProgress || state.liveProgress.requestKind === "fixed") return stage;
  if (state.liveProgress.requestKind === "url") return stage.replace("five fixed reports", "public URL report");
  return stage.replace("five fixed reports", "pasted crisis report");
}

function listItems(items) {
  return items.map(item => `<li>${escapeHtml(item)}</li>`).join("");
}

function normalizeLabel(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, char => char.toUpperCase());
}

function sentenceCase(value) {
  const text = String(value || "").trim();
  if (!text) return "None";
  return text.charAt(0).toUpperCase() + text.slice(1);
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
