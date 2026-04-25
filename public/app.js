const state = {
  mode: "structured",
  stage: "precall",
  assetId: null,
  bootstrap: null,
  recentCandidates: [],
  selectedCandidateId: null,
};

const elements = {
  bdaWhatsapp: document.querySelector("#bdaWhatsapp"),
  healthPanel: document.querySelector("#healthPanel"),
  alerts: document.querySelector("#alerts"),
  benchmarkButtons: document.querySelector("#benchmarkButtons"),
  leadName: document.querySelector("#leadName"),
  leadRole: document.querySelector("#leadRole"),
  leadExperience: document.querySelector("#leadExperience"),
  leadWhatsapp: document.querySelector("#leadWhatsapp"),
  leadIntent: document.querySelector("#leadIntent"),
  leadLinks: document.querySelector("#leadLinks"),
  leadNotes: document.querySelector("#leadNotes"),
  generatePrecall: document.querySelector("#generatePrecall"),
  precallOutput: document.querySelector("#precallOutput"),
  precallStatus: document.querySelector("#precallStatus"),
  candidateQueue: document.querySelector("#candidateQueue"),
  continueToPostcall: document.querySelector("#continueToPostcall"),
  stagePrecall: document.querySelector("#stagePrecall"),
  stagePostcall: document.querySelector("#stagePostcall"),
  precallStage: document.querySelector("#precallStage"),
  postcallStage: document.querySelector("#postcallStage"),
  candidateSelect: document.querySelector("#candidateSelect"),
  candidateSummary: document.querySelector("#candidateSummary"),
  postcallLeadWhatsapp: document.querySelector("#postcallLeadWhatsapp"),
  postcallBdaWhatsapp: document.querySelector("#postcallBdaWhatsapp"),
  transcript: document.querySelector("#transcript"),
  audioFile: document.querySelector("#audioFile"),
  generatePostcall: document.querySelector("#generatePostcall"),
  backToPrecall: document.querySelector("#backToPrecall"),
  insightsOutput: document.querySelector("#insightsOutput"),
  insightsStatus: document.querySelector("#insightsStatus"),
  approvalStatus: document.querySelector("#approvalStatus"),
  approvalMessage: document.querySelector("#approvalMessage"),
  approveSend: document.querySelector("#approveSend"),
  skipSend: document.querySelector("#skipSend"),
  pdfPreview: document.querySelector("#pdfPreview"),
  pdfLink: document.querySelector("#pdfLink"),
  modeButtons: [...document.querySelectorAll(".mode-btn")],
  structuredOnly: [...document.querySelectorAll(".structured-only")],
  audioOnly: [...document.querySelectorAll(".audio-only")],
};

boot();

async function boot() {
  state.recentCandidates = loadStoredCandidates();
  elements.bdaWhatsapp.value = localStorage.getItem("bdaWhatsapp") || "";
  elements.postcallBdaWhatsapp.value = elements.bdaWhatsapp.value;

  elements.bdaWhatsapp.addEventListener("change", () => {
    const value = elements.bdaWhatsapp.value.trim();
    localStorage.setItem("bdaWhatsapp", value);
    elements.postcallBdaWhatsapp.value = value;
  });

  elements.modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  elements.stagePrecall.addEventListener("click", () => setStage("precall"));
  elements.stagePostcall.addEventListener("click", () => {
    if (state.recentCandidates.length) setStage("postcall");
  });

  elements.generatePrecall.addEventListener("click", handleGeneratePrecall);
  elements.continueToPostcall.addEventListener("click", () => setStage("postcall"));
  elements.backToPrecall.addEventListener("click", () => setStage("precall"));
  elements.generatePostcall.addEventListener("click", handleGeneratePostcall);
  elements.approveSend.addEventListener("click", () => handleApproval("approve"));
  elements.skipSend.addEventListener("click", () => handleApproval("skip"));
  elements.candidateSelect.addEventListener("change", handleCandidateChange);

  await Promise.all([loadBootstrap(), loadHealth()]);
  renderCandidateQueue();
  renderCandidateOptions();
  setMode("structured");
  setStage(state.recentCandidates.length ? "precall" : "precall");
}

function setStage(stage) {
  state.stage = stage;
  const isPrecall = stage === "precall";
  elements.precallStage.classList.toggle("is-hidden", !isPrecall);
  elements.postcallStage.classList.toggle("is-hidden", isPrecall);
  elements.stagePrecall.classList.toggle("is-active", isPrecall);
  elements.stagePostcall.classList.toggle("is-active", !isPrecall);
}

function setMode(mode) {
  state.mode = mode;
  elements.modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  elements.structuredOnly.forEach((node) => node.classList.toggle("is-hidden", mode !== "structured"));
  elements.audioOnly.forEach((node) => node.classList.toggle("is-hidden", mode !== "audio"));
}

async function loadBootstrap() {
  const response = await fetch("/api/bootstrap");
  const payload = await response.json();
  state.bootstrap = payload;

  elements.benchmarkButtons.innerHTML = payload.benchmarkPersonas
    .map(
      (persona) =>
        `<button class="shortcut-btn" data-persona-id="${persona.id}">${persona.name}</button>`
    )
    .join("");

  [...elements.benchmarkButtons.querySelectorAll(".shortcut-btn")].forEach((button) => {
    button.addEventListener("click", () => {
      const persona = payload.benchmarkPersonas.find((item) => item.id === button.dataset.personaId);
      if (persona) fillBenchmark(persona);
    });
  });
}

async function loadHealth() {
  const response = await fetch("/api/health");
  const payload = await response.json();

  const cards = [
    {
      label: "OpenRouter",
      value: payload.openrouterConfigured ? "Configured" : "Fallback mode",
    },
    {
      label: "Deepgram",
      value: payload.deepgramConfigured ? "Configured" : "Fallback mode",
    },
    {
      label: "Twilio",
      value: payload.twilioConfigured ? "Live send ready" : "Simulation mode",
    },
    {
      label: "PDF media URL",
      value: payload.publicBaseUrlConfigured ? "Public URL ready" : "Local-only preview",
    },
  ];

  elements.healthPanel.innerHTML = cards
    .map(
      (card) => `
        <div class="status-card">
          <span>${card.label}</span>
          <strong>${card.value}</strong>
        </div>
      `
    )
    .join("");
}

function fillBenchmark(persona) {
  elements.leadName.value = persona.name;
  elements.leadRole.value = persona.role;
  elements.leadExperience.value = persona.experience;
  elements.leadIntent.value = persona.intent;
  elements.leadLinks.value = persona.links;
  elements.leadNotes.value = persona.notes;
  elements.leadWhatsapp.value = elements.leadWhatsapp.value || "";
  pushAlert(`Loaded benchmark persona: ${persona.name}`, "info");
}

function collectLeadProfile() {
  return {
    name: elements.leadName.value.trim(),
    role: elements.leadRole.value.trim(),
    experience: elements.leadExperience.value.trim(),
    intent: elements.leadIntent.value.trim(),
    links: elements.leadLinks.value.trim(),
    notes: elements.leadNotes.value.trim(),
  };
}

async function handleGeneratePrecall() {
  clearAlerts();
  try {
    setLoading(elements.generatePrecall, true, "Sending...");
    const leadProfile = collectLeadProfile();
    const response = await fetch("/api/generate-precall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadProfile,
        bda_whatsapp: elements.bdaWhatsapp.value.trim(),
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Failed to generate pre-call nudge.");

    elements.precallOutput.textContent = payload.precall.message;
    elements.precallStatus.textContent = humanizeSendStatus(payload.sendResult.status);

    const candidate = {
      id: makeCandidateId(payload.leadProfile),
      ...payload.leadProfile,
      leadWhatsapp: elements.leadWhatsapp.value.trim(),
      createdAt: new Date().toISOString(),
      precallMessage: payload.precall.message,
    };

    upsertCandidate(candidate);
    state.selectedCandidateId = candidate.id;
    renderCandidateQueue();
    renderCandidateOptions();
    syncSelectedCandidate();
    elements.continueToPostcall.disabled = false;

    pushAlert(`Pre-call nudge processed: ${payload.sendResult.status}`, "info");
    setStage("postcall");
  } catch (error) {
    pushAlert(error.message, "error");
  } finally {
    setLoading(elements.generatePrecall, false, "Send pre-call nudge");
  }
}

async function handleGeneratePostcall() {
  clearAlerts();
  try {
    const candidate = getSelectedCandidate();
    if (!candidate) {
      throw new Error("Select a candidate before generating the post-call follow-up.");
    }

    setLoading(elements.generatePostcall, true, "Generating...");

    const formData = new FormData();
    formData.append(
      "leadProfile",
      JSON.stringify({
        name: candidate.name,
        role: candidate.role,
        experience: candidate.experience,
        intent: candidate.intent,
        links: candidate.links,
        notes: candidate.notes,
      })
    );
    formData.append("bda_whatsapp", elements.postcallBdaWhatsapp.value.trim());
    formData.append("lead_whatsapp", elements.postcallLeadWhatsapp.value.trim());

    if (state.mode === "structured") {
      formData.append("transcript", elements.transcript.value.trim());
    } else if (elements.audioFile.files[0]) {
      formData.append("audio", elements.audioFile.files[0]);
    }

    const response = await fetch("/api/generate-postcall", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Failed to generate post-call asset.");

    state.assetId = payload.assetId;
    elements.insightsStatus.textContent =
      payload.transcriptionMeta.mode === "audio" ? "Transcribed" : "Ready";
    elements.approvalStatus.textContent = "Awaiting approval";
    elements.approvalMessage.value = payload.coverMessage;
    elements.approveSend.disabled = false;
    elements.skipSend.disabled = false;

    // Use Base64 if available to avoid 404s on Vercel
    if (payload.pdfBytesBase64) {
      const binary = atob(payload.pdfBytesBase64);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
      const blob = new Blob([array], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      elements.pdfLink.href = url;
      elements.pdfLink.target = "_blank";
    } else {
      elements.pdfLink.href = payload.pdfUrl;
    }
    
    elements.pdfLink.style.display = "inline-flex";
    elements.pdfPreview.innerHTML = payload.pdfPreviewHtml;

    renderInsights(payload.insights, payload.evidence);
    pushAlert(
      payload.transcriptionMeta.warning ||
        "Post-call asset generated. Review, edit if needed, then approve or skip.",
      "info"
    );
  } catch (error) {
    pushAlert(error.message, "error");
  } finally {
    setLoading(elements.generatePostcall, false, "Generate post-call PDF");
  }
}

async function handleApproval(action) {
  if (!state.assetId) return;

  try {
    setLoading(elements.approveSend, true, "Sending...");
    setLoading(elements.skipSend, true, "Working...");

    const response = await fetch("/api/approve-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetId: state.assetId,
        action,
        editedMessage: elements.approvalMessage.value.trim(),
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Approval flow failed.");

    elements.approvalStatus.textContent =
      action === "skip" ? "Skipped" : humanizeSendStatus(payload.sendResult?.status || payload.status);
    pushAlert(
      action === "skip"
        ? "Lead-facing send skipped."
        : `Lead-facing send processed: ${payload.sendResult?.status || payload.status}`,
      "info"
    );
  } catch (error) {
    pushAlert(error.message, "error");
  } finally {
    setLoading(elements.approveSend, false, "Approve & send to lead");
    setLoading(elements.skipSend, false, "Skip");
  }
}

function renderCandidateQueue() {
  if (!state.recentCandidates.length) {
    elements.candidateQueue.innerHTML =
      '<p class="empty-state">No candidates ready for post-call follow-up yet.</p>';
    elements.continueToPostcall.disabled = true;
    return;
  }

  elements.candidateQueue.innerHTML = state.recentCandidates
    .map(
      (candidate) => `
        <article class="queue-card ${candidate.id === state.selectedCandidateId ? "is-selected" : ""}">
          <div>
            <strong>${escapeHtml(candidate.name)}</strong>
            <p>${escapeHtml(candidate.role || "Lead profile pending")} • ${escapeHtml(
              candidate.intent || "Intent pending"
            )}</p>
          </div>
          <button class="queue-select" data-candidate-id="${candidate.id}">Use in post-call</button>
        </article>
      `
    )
    .join("");

  [...elements.candidateQueue.querySelectorAll(".queue-select")].forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCandidateId = button.dataset.candidateId;
      renderCandidateQueue();
      renderCandidateOptions();
      syncSelectedCandidate();
      setStage("postcall");
    });
  });

  elements.continueToPostcall.disabled = false;
}

function renderCandidateOptions() {
  if (!state.recentCandidates.length) {
    elements.candidateSelect.innerHTML = '<option value="">No candidates available yet</option>';
    elements.stagePostcall.disabled = true;
    return;
  }

  elements.stagePostcall.disabled = false;
  if (!state.selectedCandidateId) {
    state.selectedCandidateId = state.recentCandidates[0].id;
  }

  elements.candidateSelect.innerHTML = state.recentCandidates
    .map(
      (candidate) => `
        <option value="${candidate.id}" ${candidate.id === state.selectedCandidateId ? "selected" : ""}>
          ${escapeHtml(candidate.name)}${candidate.role ? ` — ${escapeHtml(candidate.role)}` : ""}
        </option>
      `
    )
    .join("");
}

function handleCandidateChange() {
  state.selectedCandidateId = elements.candidateSelect.value;
  syncSelectedCandidate();
  renderCandidateQueue();
}

function syncSelectedCandidate() {
  const candidate = getSelectedCandidate();
  if (!candidate) {
    elements.candidateSummary.innerHTML = '<p class="empty-state">Select a candidate to continue.</p>';
    elements.postcallLeadWhatsapp.value = "";
    return;
  }

  elements.postcallLeadWhatsapp.value = candidate.leadWhatsapp || "";
  elements.postcallBdaWhatsapp.value = elements.bdaWhatsapp.value.trim();
  elements.candidateSummary.innerHTML = `
    <div class="summary-grid">
      <article>
        <h3>${escapeHtml(candidate.name)}</h3>
        <p>${escapeHtml(candidate.role || "Role not provided")}</p>
      </article>
      <article>
        <h4>Experience</h4>
        <p>${escapeHtml(candidate.experience || "Not provided")}</p>
      </article>
      <article>
        <h4>Intent</h4>
        <p>${escapeHtml(candidate.intent || "Not provided")}</p>
      </article>
      <article>
        <h4>Links / notes</h4>
        <p>${escapeHtml(candidate.links || candidate.notes || "Not provided")}</p>
      </article>
    </div>
  `;
}

function renderInsights(insights, evidence) {
  const sections = [
    ["Explicit questions", insights.explicit_questions],
    ["Implicit questions", insights.implicit_questions],
    ["Purchase barriers", insights.purchase_barriers],
    ["Emotional signals", insights.emotional_signals],
    ["Goals", insights.goals],
    ["Recommended proof", insights.recommended_proof],
    ["Evidence gaps", insights.evidence_gaps],
  ];

  sections.push([
    "Grounded source pack",
    evidence.map((item) => `${item.claim} (${item.sourceUrl})`),
  ]);

  elements.insightsOutput.innerHTML = sections
    .map(
      ([label, items]) => `
        <article class="insight-card">
          <h4>${label}</h4>
          <ul>
            ${(items || ["None"]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </article>
      `
    )
    .join("");
}

function humanizeSendStatus(status) {
  return (
    {
      simulated: "Simulated",
      sent: "Sent",
      pending_public_url: "Needs public URL",
      skipped: "Skipped",
      error: "Error",
    }[status] || "Ready"
  );
}

function setLoading(button, isLoading, text) {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.textContent;
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function pushAlert(message, type) {
  const el = document.createElement("div");
  el.className = `alert ${type}`;
  el.textContent = message;
  elements.alerts.prepend(el);
}

function clearAlerts() {
  elements.alerts.innerHTML = "";
}

function loadStoredCandidates() {
  try {
    const raw = localStorage.getItem("recentCandidates");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function storeCandidates() {
  localStorage.setItem("recentCandidates", JSON.stringify(state.recentCandidates.slice(0, 6)));
}

function upsertCandidate(candidate) {
  state.recentCandidates = [
    candidate,
    ...state.recentCandidates.filter((item) => item.id !== candidate.id),
  ].slice(0, 6);
  storeCandidates();
}

function getSelectedCandidate() {
  return state.recentCandidates.find((candidate) => candidate.id === state.selectedCandidateId) || null;
}

function makeCandidateId(leadProfile) {
  return `${leadProfile.name}-${leadProfile.role}-${leadProfile.intent}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
