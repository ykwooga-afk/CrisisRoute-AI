import {
  DATA_MODES,
  analyzeIncidents,
  generateActionBrief,
  getGonkaHealth,
  loadHazeScenario,
  submitHumanDecision
} from "./services/crisisRouteClient.js";

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
  toast: null
};

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
      await withLoading(() => loadDemoScenario());
      return;
    }

    if (action === "verify-input") {
      await handleVerifyInput();
      return;
    }

    if (action === "mode") {
      state.mode = button.dataset.mode;
      await withLoading(() => loadModeScenario(state.mode));
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
      await handleDecision(button.dataset.decision);
    }
  });

  app.addEventListener("input", event => {
    if (event.target.matches("#verify-input")) {
      state.intakeValue = event.target.value;
    }
  });
}

async function loadDemoScenario() {
  state.error = null;
  const result = await loadHazeScenario(DATA_MODES.mock);
  state.incidents = result.incidents || [];
  state.resources = result.resources || [];
  selectIncident(findCaseByLabel("03")?.caseId || state.incidents[0]?.caseId || null);
  state.currentView = VIEWS.command;
  showToast("Malaysia haze demo loaded. CASE 03 selected.");
}

async function loadModeScenario(mode) {
  state.error = null;
  try {
    if (mode === DATA_MODES.live) {
      await refreshHealth();
      if (!isLiveConnected()) {
        state.error = "Live backend unavailable: Gonka backend routes are not connected yet.";
        showToast("Live backend unavailable. No fake Gonka result was created.");
        return;
      }
    }

    const result = await loadHazeScenario(mode);
    state.incidents = result.incidents || [];
    state.resources = result.resources || state.resources;
    selectIncident(findCaseByLabel("03")?.caseId || state.incidents[0]?.caseId || null);
    showToast(mode === DATA_MODES.replay ? "Recorded replay loaded." : "Live scenario loaded.");
  } catch (error) {
    state.error = `Live backend unavailable: ${error.message}`;
    showToast("Live backend unavailable. Demo data was not converted into live data.");
  }
  await refreshHealth();
}

async function handleVerifyInput() {
  const messages = state.intakeValue
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  if (!messages.length) {
    showToast("Paste a crisis report or source URL first.");
    return;
  }

  state.error = null;
  await withLoading(async () => {
    try {
      if (state.mode === DATA_MODES.live) {
        await refreshHealth();
        if (!isLiveConnected()) {
          throw new Error("Gonka backend routes are not connected yet.");
        }
      }

      const result = await analyzeIncidents(messages, state.mode);
      state.incidents = result.incidents || [];
      state.resources = result.resources || state.resources;
      selectIncident(state.incidents[0]?.caseId || null);
      state.currentView = VIEWS.intelligence;
      showToast(state.mode === DATA_MODES.live ? "Live analysis returned." : "Demo analysis generated by local adapter.");
    } catch (error) {
      state.error = `Verification unavailable: ${error.message}`;
      showToast("Live verification unavailable. No fake Gonka result was created.");
    }
  });
}

async function handleDecision(decision) {
  const incident = getSelectedIncident();
  if (!incident) return;

  if (decision === "APPROVED" && isDispatchBlocked(incident)) {
    showToast("Approve Dispatch is locked until required Safety Gates pass.");
    return;
  }

  await withLoading(async () => {
    const actionBrief = decision === "APPROVED" ? await generateActionBrief(incident, state.mode) : incident.actionBrief;
    const updated = await submitHumanDecision({ ...incident, actionBrief }, decision, state.mode);
    state.incidents = state.incidents.map(item => (item.caseId === incident.caseId ? updated : item));
    selectIncident(updated.caseId);

    if (decision === "APPROVED") {
      state.currentView = VIEWS.action;
      showToast("Human approval saved. Action Brief unlocked.");
    } else {
      showToast(`Human decision saved: ${decision.replaceAll("_", " ")}`);
    }
  });
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
      ${renderCurrentView(incident)}
      ${state.toast ? `<div class="toast" role="status">${escapeHtml(state.toast)}</div>` : ""}
      ${state.loading ? `<div class="loading-indicator" aria-live="polite">Processing</div>` : ""}
    </div>
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
        <button class="primary-action" data-action="decision" data-decision="URGENT_VERIFICATION">Urgent Verify</button>
        <button class="secondary-action" data-action="decision" data-decision="NEEDS_MORE_INFO">Request More Info</button>
        <button class="secondary-action" data-action="decision" data-decision="APPROVED" ${dispatchBlocked ? "disabled" : ""}>
          ${dispatchBlocked ? "Approve Dispatch Locked" : "Approve Dispatch"}
        </button>
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
  return `
    <section class="verify-panel">
      <h2 class="section-kicker">Verify a Crisis Report</h2>
      <p>Paste a crisis report or source URL. CrisisRoute AI will extract claims, evaluate evidence, and flag safety constraints.</p>
      <textarea id="verify-input" placeholder="Paste a Telegram message, WhatsApp report, emergency text, or source URL...">${escapeHtml(state.intakeValue)}</textarea>
      <div class="verify-actions">
        <button class="primary-action" data-action="verify-input">Verify with Gonka</button>
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
  return `
    <article class="model-card ${role}">
      <h3>${escapeHtml(title)}</h3>
      <p class="trace-line">${escapeHtml(trace.model)} · ${escapeHtml(trace.responseId)} · ${escapeHtml(trace.promptVersion)} · ${escapeHtml(String(trace.latencyMs))}ms</p>
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
  const blocked = isDispatchBlocked(incident);
  return `
    <button class="primary-action" data-action="decision" data-decision="URGENT_VERIFICATION">Urgent Verify</button>
    <button class="secondary-action" data-action="decision" data-decision="NEEDS_MORE_INFO">Request More Info</button>
    <button class="secondary-action" data-action="decision" data-decision="APPROVED" ${blocked ? "disabled" : ""}>${blocked ? "Approve Dispatch Locked" : "Approve Dispatch"}</button>
    <button class="text-action" data-action="decision" data-decision="MERGE_OR_REJECT">Merge / Reject</button>
  `;
}

function renderActionBriefView(incident) {
  const approved = incident.humanDecision?.decision === "APPROVED";

  if (!approved) {
    return renderActionBriefLocked(incident);
  }

  const actionPlan = incident.actionPlan || {};
  const proof = incident.proofCapsule;
  const language = state.selectedLanguage;
  const actionCopy = incident.actionBrief?.[language] || actionPlan.languages?.[language] || actionPlan.instructions || incident.recommendedAction;

  return `
    <main class="page-canvas action-page">
      <section class="approval-strip">APPROVED · ${escapeHtml(incident.caseId)} · ${escapeHtml(incident.humanDecision.decidedBy)} · ${formatDateTime(incident.humanDecision.decidedAt)}</section>
      <section class="action-layout">
        <section class="action-brief-main">
          <h1>Action Brief</h1>
          <p class="action-subtitle">${escapeHtml(incident.caseId)} · ${escapeHtml(incident.title)}</p>
          <div class="brief-meta-grid">
            ${briefMeta("Destination", actionPlan.destination || incident.location)}
            ${briefMeta("Priority", actionPlan.priority || "HIGH", "red")}
            ${briefMeta("Approved", formatTime(incident.humanDecision.decidedAt))}
          </div>
          <div class="brief-section">
            <h2 class="section-kicker">Resources</h2>
            ${(actionPlan.resources || []).map(resource => `<p><span>${escapeHtml(resource.label)}</span><b>${escapeHtml(resource.status)}</b></p>`).join("")}
          </div>
          <div class="brief-section instructions">
            <h2 class="section-kicker">Instructions</h2>
            <p>${escapeHtml(actionCopy)}</p>
          </div>
          <div class="language-tabs">
            ${languageButton("en", "English")}
            ${languageButton("zh", "中文")}
            ${languageButton("ms", "Bahasa Melayu")}
          </div>
          <div class="brief-section">
            <h2 class="section-kicker">Safety Gates</h2>
            <div class="brief-gates">
              ${briefGate("Location Verified", gatePassed(incident, "G_LOCATION"))}
              ${briefGate("Contact Verified", gatePassed(incident, "G_CONTACT"))}
              ${briefGate("Resources Available", gatePassed(incident, "G_RESOURCE"))}
              ${briefGate("No Critical Model Conflict", gatePassed(incident, "G_CONFLICT"))}
            </div>
          </div>
        </section>
        <aside class="proof-column">
          <div class="proof-heading">
            <div>
              <h2 class="section-kicker">Proof Capsule</h2>
              <p>Tamper-Evident Decision Receipt</p>
            </div>
            <button class="secondary-action">Export Receipt ↓</button>
          </div>
          ${renderProofReceipt(incident, proof)}
        </aside>
      </section>
      ${renderAuditTimeline(incident)}
    </main>
  `;
}

function renderActionBriefLocked(incident) {
  const blocked = isDispatchBlocked(incident);
  return `
    <main class="page-canvas action-page">
      <section class="action-locked-state">
        <span class="section-kicker">Action Brief</span>
        <h1>${escapeHtml(incident.title)}</h1>
        <p>${escapeHtml(
          blocked
            ? "This incident cannot produce an approved volunteer dispatch brief because Safety Gates are still blocked."
            : "This incident is ready for human review. Approve Dispatch to unlock the Action Brief."
        )}</p>
        <div class="locked-actions">
          <button class="primary-action" data-action="view" data-view="safety">Open Safety Decision</button>
          <button class="secondary-action" data-action="decision" data-decision="APPROVED" ${blocked ? "disabled" : ""}>Approve Dispatch</button>
        </div>
      </section>
    </main>
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
  if (state.mode === DATA_MODES.mock) {
    return "Demo mode uses local snapshot data. It does not pretend to be live Gonka verification.";
  }
  if (state.mode === DATA_MODES.replay) {
    return "Replay mode uses recorded-style responses for demo rehearsal.";
  }
  return isLiveConnected()
    ? "Live mode uses confirmed backend Gonka routes."
    : "Live backend is unavailable until teammate integration is complete.";
}

function isLiveConnected() {
  return state.mode === DATA_MODES.live && state.health?.ok === true && state.health?.liveRoutesReady === true;
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
  return String(value).replace(/^(sha256:[a-z0-9]{4})[a-z0-9]+([a-z0-9]{4})$/i, "$1...$2");
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
