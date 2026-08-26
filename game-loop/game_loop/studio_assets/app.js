const state = { projects: [], active: null, runtime: "deepseek-harness", poller: null, snapshotKind: "goa" };
const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(["newProject","projectList","projectTitle","projectStage","saveState","playGame","emptyState","messageList","composer","promptInput","runtimePicker","sendButton","previewStage","buildStatus","versionLabel","memoryLabel","evolutionMap","nodeTooltip","projectDialog","projectForm","projectName","snapshotDialog","snapshotForm","snapshotTitle","snapshotName","snapshotList","toast","mobileProjects","mobileCircuits"].map(id => [id, $(id)]));

async function api(path, options = {}) {
  const response = await fetch(path, { headers: {"Content-Type":"application/json"}, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(text) {
  els.toast.textContent = text; els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 2800);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
}

function initials(title) { return title.split(/\s+/).slice(0,2).map(x => x[0]).join("").toUpperCase(); }

function renderProjects() {
  els.projectList.innerHTML = state.projects.map(project => `
    <button class="project-item ${state.active?.id === project.id ? "active" : ""}" data-id="${project.id}">
      <span class="project-thumb">${escapeHtml(initials(project.title))}</span>
      <span><strong>${escapeHtml(project.title)}</strong><small>${project.status === "running" ? "Creating..." : `${project.turn_count || 0} versions`}</small></span>
    </button>`).join("") || `<p class="rail-empty">Your games live here.</p>`;
}

function renderActive() {
  const p = state.active;
  els.projectTitle.textContent = p?.title || "A new game";
  els.projectStage.textContent = p?.stage || "Describe a world you want to play.";
  const messages = p?.messages || [];
  els.emptyState.hidden = messages.length > 0;
  els.messageList.innerHTML = messages.map(item => `
    <article class="message ${item.role}">
      <span>${item.role === "user" ? "You" : "Game Evolver"}</span>
      <p>${escapeHtml(item.content)}</p>
      ${item.role === "assistant" ? `<small>Version ${item.turn} · creative memory updated</small>` : ""}
    </article>`).join("");
  if (messages.length) els.messageList.lastElementChild?.scrollIntoView({block:"nearest"});
  const running = Boolean(p?.running || p?.status === "running");
  els.buildStatus.className = `build-status ${running ? "running" : p?.status === "error" ? "error" : "idle"}`;
  els.buildStatus.innerHTML = `<i></i> ${running ? "Creating" : p?.status === "error" ? "Paused" : p?.current_artifact ? "Playable" : "Ready"}`;
  els.saveState.textContent = running ? "Saving progress" : "Saved locally";
  els.promptInput.disabled = running;
  els.playGame.disabled = !p?.current_artifact && !running;
  els.playGame.innerHTML = running ? `<span>■</span> Stop` : `<span>▶</span> Play`;
  els.versionLabel.textContent = p?.turn_count ? `Version ${p.turn_count}` : "No build yet";
  els.memoryLabel.textContent = p?.engine?.maker || "Ready";
  renderEvolutionMap(p?.evolution_graph);
  if (p?.web_preview_url) {
    els.previewStage.innerHTML = `<iframe src="${p.web_preview_url}?v=${encodeURIComponent(p.updated_at)}" title="Playable game preview" allow="autoplay; fullscreen" sandbox="allow-scripts allow-same-origin allow-pointer-lock" tabindex="0"></iframe><div class="preview-shade"><button id="previewPlay">↗ Open in Godot</button></div>`;
    $("previewPlay")?.addEventListener("click", play);
  } else if (p?.preview_url) {
    els.previewStage.innerHTML = `<img src="${p.preview_url}&v=${encodeURIComponent(p.updated_at)}" alt="Current game preview"><div class="preview-shade"><button id="previewPlay">▶ Play in Godot</button></div>`;
    $("previewPlay")?.addEventListener("click", play);
  } else {
    els.previewStage.innerHTML = running
      ? `<div class="build-animation"><div class="build-orbit"><span></span><span></span><span></span></div><strong>${escapeHtml(p.stage)}</strong><p>The maker is editing, testing, and comparing playable versions.</p></div>`
      : p?.status === "error"
        ? `<div class="preview-empty error-build"><span>!</span><strong>Build interrupted</strong><p>${escapeHtml(p.error || "The creative engine stopped before producing a formal version.")}</p><button id="retryBuild">↻ Retry this build</button></div>`
        : `<div class="preview-empty"><span>▶</span><strong>${p?.current_artifact ? "Playable build is ready" : "Your game will appear here"}</strong><p>${p?.current_artifact ? "Open it in Godot to play the current version." : "Every accepted version becomes the starting point for your next request."}</p></div>`;
    $("retryBuild")?.addEventListener("click", retryBuild);
  }
  updateSend();
}

function graphDetail(node, side, extra = {}) { return encodeURIComponent(JSON.stringify({...node, side, ...extra})); }
function graphHash(value) { return [...String(value)].reduce((hash, char) => ((hash * 33) ^ char.charCodeAt(0)) >>> 0, 5381); }

function scatterLayout(nodes) {
  const bounds = {left: 27, right: 333, top: 25, bottom: 185};
  const candidates = [];
  for (let row = 0; row < 11; row += 1) {
    for (let column = 0; column < 19; column += 1) {
      const x = bounds.left + column * ((bounds.right - bounds.left) / 18);
      const y = bounds.top + row * ((bounds.bottom - bounds.top) / 10);
      if (x > 286 && y < 54) continue;
      candidates.push({x, y});
    }
  }
  const ordered = [...nodes].sort((a, b) =>
    `${a.category}:${a.id}`.localeCompare(`${b.category}:${b.id}`)
  );
  const placed = [];
  const positions = new Map();
  ordered.forEach((node, index) => {
    const radius = 6 + Math.min(4, Math.sqrt(node.uses || 0) * 1.5);
    const evidence = node.accuracy == null ? Math.min(1, (node.uses || 0) / 5) : node.accuracy;
    const preferredY = bounds.bottom - evidence * (bounds.bottom - bounds.top);
    let best = null;
    candidates.forEach((candidate, candidateIndex) => {
      const edgeClearance = Math.min(
        candidate.x - bounds.left,
        bounds.right - candidate.x,
        candidate.y - bounds.top,
        bounds.bottom - candidate.y,
      ) - radius;
      const pointClearance = placed.length
        ? Math.min(...placed.map(point => Math.hypot(candidate.x - point.x, candidate.y - point.y) - radius - point.radius))
        : Math.min(bounds.right - bounds.left, bounds.bottom - bounds.top) / 2;
      const evidenceAffinity = 8 * (1 - Math.min(1, Math.abs(candidate.y - preferredY) / (bounds.bottom - bounds.top)));
      const tieBreak = ((graphHash(`${node.id}:${candidateIndex}`) % 1000) / 1000) * .01;
      const score = Math.min(edgeClearance * 1.6, pointClearance) + evidenceAffinity + tieBreak;
      if (!best || score > best.score) best = {...candidate, score};
    });
    const point = {x: best?.x ?? 180, y: best?.y ?? 105, radius};
    placed.push(point);
    positions.set(node.id, point);
  });
  return positions;
}

function scatterPlot(nodes) {
  const layout = scatterLayout(nodes);
  const points = nodes.map(node => {
    const {x, y, radius} = layout.get(node.id) || {x: 180, y: 105, radius: 4};
    return `<g class="plot-mark ${escapeHtml(node.category)} ${node.active ? "active" : "dormant"}" role="button" tabindex="0" data-node="${graphDetail(node,"HPA library")}"><circle class="point-halo" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(radius + 5).toFixed(1)}"/><circle class="scatter-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}"/></g>`;
  }).join("");
  return `<svg viewBox="0 0 360 210" role="img" aria-label="HPA experience library scatter plot"><path class="plot-grid" d="M18 44H342M18 84H342M18 124H342M18 164H342M72 18V192M144 18V192M216 18V192M288 18V192"/>${points}</svg>`;
}

function flowPlot(nodes, suppliedEdges = []) {
  const edgeSpecs = suppliedEdges.length ? suppliedEdges : nodes.slice(1).map((node, index) => ({
    id: `${nodes[index].id}-${node.id}`, source: nodes[index].id, target: node.id,
    kind: "capability handoff", description: `The active GOA passes work from ${nodes[index].label} into ${node.label}.`,
  }));
  const depth = new Map(nodes.map(node => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    edgeSpecs.filter(edge => (edge.protocol || (edge.kind === "feedback" ? "feedback" : "forward")) !== "feedback").forEach(edge => {
      depth.set(edge.target, Math.max(depth.get(edge.target) || 0, (depth.get(edge.source) || 0) + 1));
    });
  }
  const maxDepth = Math.max(0, ...depth.values());
  const columns = new Map();
  nodes.forEach(node => { const d = depth.get(node.id) || 0; columns.set(d, [...(columns.get(d) || []), node]); });
  const positioned = [];
  [...columns.entries()].sort((a, b) => a[0] - b[0]).forEach(([d, column]) => {
    column.sort((a, b) => a.id.localeCompare(b.id)).forEach((node, index) => positioned.push({
      ...node,
      x: maxDepth ? 30 + d * (300 / maxDepth) : 180,
      y: column.length < 2 ? 105 : 36 + index * (138 / (column.length - 1)),
    }));
  });
  const byId = new Map(positioned.map(node => [node.id, node]));
  const edges = edgeSpecs.map(edge => {
    const prior = byId.get(edge.source), node = byId.get(edge.target);
    if (!prior || !node) return "";
    const middle = (prior.x + node.x) / 2;
    const detail = graphDetail({
      id: edge.id, label: `${prior.label} → ${node.label}`,
      category: edge.kind || "capability handoff", description: edge.description || "Typed circuit handoff.",
      active: prior.active && node.active, uses: Math.min(prior.uses, node.uses), accuracy: null, score_mean: null,
    }, "GOA flow", {edge: true, ...edge});
    const feedback = (edge.protocol || (edge.kind === "feedback" ? "feedback" : "forward")) === "feedback";
    const controlY = feedback ? Math.min(prior.y, node.y) - 24 : null;
    const path = feedback
      ? `M${prior.x.toFixed(1)} ${prior.y.toFixed(1)} C${prior.x.toFixed(1)} ${controlY.toFixed(1)},${node.x.toFixed(1)} ${controlY.toFixed(1)},${node.x.toFixed(1)} ${node.y.toFixed(1)}`
      : `M${prior.x.toFixed(1)} ${prior.y.toFixed(1)} C${middle.toFixed(1)} ${prior.y.toFixed(1)},${middle.toFixed(1)} ${node.y.toFixed(1)},${node.x.toFixed(1)} ${node.y.toFixed(1)}`;
    return `<path class="flow-edge ${feedback ? "feedback" : ""} ${prior.active && node.active ? "active" : "dormant"}" role="button" tabindex="0" d="${path}" marker-end="url(#flowArrow)" data-node="${detail}"/>`;
  }).join("");
  const marks = positioned.map(node => {
    const radius = 6 + Math.min(5, Math.sqrt(node.uses || 0) * 1.7);
    return `<g class="plot-mark flow-mark ${escapeHtml(node.category)} ${node.active ? "active" : "dormant"}" role="button" tabindex="0" data-node="${graphDetail(node,"GOA harness")}" transform="translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})"><circle class="point-halo" r="${(radius + 6).toFixed(1)}"/><rect class="flow-point" x="${(-radius).toFixed(1)}" y="${(-radius).toFixed(1)}" width="${(radius * 2).toFixed(1)}" height="${(radius * 2).toFixed(1)}" transform="rotate(45)"/></g>`;
  }).join("");
  return `<svg viewBox="0 0 360 210" role="img" aria-label="GOA harness capability flow graph"><defs><marker id="flowArrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7Z"/></marker></defs>${edges}${marks}</svg>`;
}

function renderEvolutionMap(graph) {
  if (!graph) { els.evolutionMap.innerHTML = ""; return; }
  els.evolutionMap.innerHTML = `
    <section class="agent-plot hpa-plot" aria-label="HPA evolution library scatter plot"><span class="plot-id"><b>HPA</b><small>LIBRARY</small></span><div class="snapshot-tools"><button data-snapshot-save="hpa" title="Save HPA snapshot" aria-label="Save HPA snapshot">▣</button><button data-snapshot-open="hpa" title="Load HPA snapshot" aria-label="Load HPA snapshot">↥</button></div>${scatterPlot(graph.hpa || [])}</section>
    <div class="circuit-transfer" aria-hidden="true"><i></i><i></i><i></i></div>
    <section class="agent-plot goa-plot" aria-label="GOA agent circuit flow graph"><span class="plot-id"><b>GOA</b><small>CIRCUIT</small></span><div class="snapshot-tools"><button data-snapshot-save="goa" title="Save GOA snapshot" aria-label="Save GOA snapshot">▣</button><button data-snapshot-open="goa" title="Load GOA snapshot" aria-label="Load GOA snapshot">↥</button></div>${flowPlot(graph.goa || [], graph.goa_edges || [])}</section>`;
}

function openSnapshots(kind, focusName = false) {
  if (!state.active) return;
  state.snapshotKind = kind;
  els.snapshotTitle.textContent = `${kind.toUpperCase()} memory snapshots`;
  const snapshots = (state.active.snapshots || []).filter(item => item.kind === kind);
  els.snapshotList.innerHTML = snapshots.map(item => `<button type="button" data-snapshot-load="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.name)}</strong><small>V.${item.source_turn} · ${new Date(item.created_at).toLocaleDateString()}${item.automatic ? " · AUTO" : ""}</small></span><b title="Load this snapshot">↧</b></button>`).join("") || `<p>No saved ${kind.toUpperCase()} memories yet.</p>`;
  els.snapshotName.placeholder = `${kind.toUpperCase()} snapshot name`;
  els.snapshotName.value = "";
  if (!els.snapshotDialog.open) els.snapshotDialog.showModal();
  if (focusName) els.snapshotName.focus();
}

async function saveSnapshot(event) {
  event.preventDefault();
  if (!state.active) return;
  try {
    await api(`/api/projects/${state.active.id}/snapshots`, {method:"POST", body:JSON.stringify({kind:state.snapshotKind, name:els.snapshotName.value})});
    await openProject(state.active.id); openSnapshots(state.snapshotKind); toast(`${state.snapshotKind.toUpperCase()} snapshot saved`);
  } catch (error) { toast(error.message); }
}

async function loadSnapshot(id) {
  if (!state.active) return;
  try {
    state.active = await api(`/api/projects/${state.active.id}/snapshots/${id}/load`, {method:"POST", body:"{}"});
    els.snapshotDialog.close(); renderActive(); toast(`${state.snapshotKind.toUpperCase()} memory restored`);
  } catch (error) { toast(error.message); }
}

function showGraphTooltip(event) {
  const node = event.target.closest("[data-node]"); if (!node) return;
  const data = JSON.parse(decodeURIComponent(node.dataset.node));
  const success = data.accuracy == null ? "Gathering evidence" : `${Math.round(data.accuracy * 100)}% success across ${data.uses} uses`;
  const rows = [];
  const addRow = (label, value) => {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) return;
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    rows.push(`<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd>`);
  };
  if (data.edge) {
    addRow("handoff", `${data.source} → ${data.target}`);
    addRow("artifacts", data.artifact_kinds);
    addRow("traversals", data.max_traversals);
  } else if (String(data.side).startsWith("GOA")) {
    const harness = data.harness || {};
    addRow("runtime", [data.provider, data.model].filter(Boolean).join(" / "));
    addRow("outputs", data.outputs);
    addRow("context", data.context?.mode);
    addRow("modules", harness.active_module_ids);
    addRow("elements", harness.active_element_ids);
    addRow("cordis", harness.active_cordis_plugins);
    addRow("interfaces", data.tools);
    addRow("capabilities", data.capabilities);
    addRow("budget", data.budget ? `${data.budget.max_model_calls || 1} calls · ${data.budget.cost_units || 1} cost · ${data.budget.timeout_seconds || 1200}s` : null);
    addRow("behavior", data.role_behavior_hash);
    addRow("effective", data.effective_harness_hash);
    addRow("cordis hash", data.effective_cordis_hash);
    addRow("health", data.infrastructure_ok == null ? data.runtime_status : (data.infrastructure_ok ? "infrastructure ok" : "infrastructure failed"));
  } else {
    addRow("operations", data.operations);
    addRow("signals", data.signals);
    addRow("cost prior", data.cost_prior);
  }
  els.nodeTooltip.innerHTML = `<span>${escapeHtml(data.side)} · ${escapeHtml(data.category)}</span><strong>${escapeHtml(data.label)}</strong><p>${escapeHtml(data.description)}</p>${rows.length ? `<dl>${rows.join("")}</dl>` : ""}<small>${escapeHtml(success)}${data.score_mean == null ? "" : ` · mean score ${Number(data.score_mean).toFixed(2)}`}</small>`;
  els.nodeTooltip.hidden = false;
}
els.evolutionMap.addEventListener("pointerover", showGraphTooltip);
els.evolutionMap.addEventListener("focusin", showGraphTooltip);
els.evolutionMap.addEventListener("pointerout", event => { if (event.target.closest("[data-node]")) els.nodeTooltip.hidden = true; });
els.evolutionMap.addEventListener("focusout", event => { if (event.target.closest("[data-node]")) els.nodeTooltip.hidden = true; });
els.evolutionMap.addEventListener("click", event => {
  const save = event.target.closest("[data-snapshot-save]");
  const open = event.target.closest("[data-snapshot-open]");
  if (save) openSnapshots(save.dataset.snapshotSave, true);
  else if (open) openSnapshots(open.dataset.snapshotOpen);
});

async function loadProjects(selectFirst = true) {
  const data = await api("/api/projects"); state.projects = data.projects;
  if (selectFirst && !state.active && state.projects.length) await openProject(state.projects[0].id);
  renderProjects(); renderActive();
}

async function openProject(id) {
  state.active = await api(`/api/projects/${id}`);
  state.runtime = state.active.runtime || "deepseek-harness";
  setRuntime(state.runtime); renderProjects(); renderActive();
  if (state.active.running || state.active.status === "running") startPolling();
  document.body.classList.remove("rail-open");
}

function setRuntime(runtime) {
  state.runtime = runtime;
  els.runtimePicker.querySelectorAll("button").forEach(button => button.classList.toggle("selected", button.dataset.runtime === runtime));
}

function updateSend() { els.sendButton.disabled = !els.promptInput.value.trim() || Boolean(state.active?.running || state.active?.status === "running"); }

async function ensureProject() {
  if (state.active) return state.active;
  const title = els.promptInput.value.trim().split(/[.!?\n]/)[0].slice(0, 48) || "Untitled game";
  state.active = await api("/api/projects", {method:"POST", body:JSON.stringify({title, runtime:state.runtime})});
  await loadProjects(false); return state.active;
}

async function send(event) {
  event.preventDefault(); const content = els.promptInput.value.trim(); if (!content) return;
  try {
    await ensureProject(); els.promptInput.value = ""; resizeComposer();
    state.active = await api(`/api/projects/${state.active.id}/messages`, {method:"POST", body:JSON.stringify({content})});
    renderActive(); startPolling();
  } catch (error) { toast(error.message); }
}

function startPolling() {
  clearInterval(state.poller);
  state.poller = setInterval(async () => {
    if (!state.active) return;
    try {
      const prior = state.active.status; await openProject(state.active.id);
      if (state.active.status !== "running") {
        clearInterval(state.poller);
        if (prior === "running") toast(state.active.status === "ready" ? "A new playable version is ready" : state.active.error || "Build paused");
        await loadProjects(false);
      }
    } catch (_) {}
  }, 2500);
}

async function play() {
  if (!state.active) return;
  try {
    if (state.active.running || state.active.status === "running") {
      state.active = await api(`/api/projects/${state.active.id}/stop`, {method:"POST", body:"{}"});
      renderActive(); toast("Build stopped safely"); return;
    }
    await api(`/api/projects/${state.active.id}/play`, {method:"POST", body:"{}"}); toast("Opening in Godot");
  }
  catch (error) { toast(error.message); }
}

async function retryBuild() {
  if (!state.active) return;
  try {
    state.active = await api(`/api/projects/${state.active.id}/retry`, {method:"POST", body:"{}"});
    renderActive(); startPolling();
  } catch (error) { toast(error.message); }
}

function resizeComposer() { els.promptInput.style.height = "auto"; els.promptInput.style.height = `${Math.min(160, els.promptInput.scrollHeight)}px`; updateSend(); }

els.newProject.addEventListener("click", () => els.projectDialog.showModal());
els.projectForm.addEventListener("submit", async event => {
  event.preventDefault();
  try { state.active = await api("/api/projects", {method:"POST", body:JSON.stringify({title:els.projectName.value, runtime:state.runtime})}); els.projectDialog.close(); els.projectName.value=""; await loadProjects(false); renderActive(); }
  catch (error) { toast(error.message); }
});
els.projectList.addEventListener("click", event => { const button = event.target.closest("[data-id]"); if (button) openProject(button.dataset.id); });
els.snapshotForm.addEventListener("submit", saveSnapshot);
els.snapshotList.addEventListener("click", event => { const button = event.target.closest("[data-snapshot-load]"); if (button) loadSnapshot(button.dataset.snapshotLoad); });
els.runtimePicker.addEventListener("click", async event => {
  const button=event.target.closest("[data-runtime]"); if (!button) return;
  try {
    setRuntime(button.dataset.runtime);
    if (state.active && !state.active.turn_count) state.active = await api(`/api/projects/${state.active.id}/runtime`, {method:"POST", body:JSON.stringify({runtime:state.runtime})});
    renderActive();
  } catch (error) { toast(error.message); setRuntime(state.active?.runtime || "deepseek-harness"); }
});
els.composer.addEventListener("submit", send); els.promptInput.addEventListener("input", resizeComposer);
els.promptInput.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); els.composer.requestSubmit(); } });
els.playGame.addEventListener("click", play); els.mobileProjects.addEventListener("click", () => document.body.classList.toggle("rail-open"));
els.mobileCircuits.addEventListener("click", () => {
  const active = document.body.classList.toggle("circuit-open");
  els.mobileCircuits.setAttribute("aria-pressed", String(active));
  els.mobileCircuits.setAttribute("aria-label", active ? "Conversation" : "Agent circuits");
  els.mobileCircuits.title = active ? "Conversation" : "Agent circuits";
  els.mobileCircuits.textContent = active ? "↩" : "⌘";
});
document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => { els.promptInput.value=button.dataset.prompt; resizeComposer(); els.promptInput.focus(); }));

loadProjects().catch(error => toast(error.message));
