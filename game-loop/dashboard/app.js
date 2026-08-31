const state = {
  presets: [],
  models: [],
  active: null,
  latest: null,
};

const els = {
  benchSelect: document.getElementById("benchSelect"),
  modelSelect: document.getElementById("modelSelect"),
  hoursInput: document.getElementById("hoursInput"),
  epochsInput: document.getElementById("epochsInput"),
  casesInput: document.getElementById("casesInput"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  configPath: document.getElementById("configPath"),
  taskSource: document.getElementById("taskSource"),
  seedArtifact: document.getElementById("seedArtifact"),
  runStatus: document.getElementById("runStatus"),
  stageRail: document.getElementById("stageRail"),
  conversationList: document.getElementById("conversationList"),
  timeMeter: document.getElementById("timeMeter"),
  phaseValue: document.getElementById("phaseValue"),
  epochValue: document.getElementById("epochValue"),
  elapsedValue: document.getElementById("elapsedValue"),
  progressValue: document.getElementById("progressValue"),
  proposalView: document.getElementById("proposalView"),
  verificationView: document.getElementById("verificationView"),
  hgaSummary: document.getElementById("hgaSummary"),
  hgaView: document.getElementById("hgaView"),
  validationSummary: document.getElementById("validationSummary"),
  hardRubrics: document.getElementById("hardRubrics"),
  softRubrics: document.getElementById("softRubrics"),
  caseReview: document.getElementById("caseReview"),
  logTail: document.getElementById("logTail"),
};

function byBench(bench) {
  return state.presets.find((item) => item.bench === bench) || null;
}

function modelOptions() {
  return state.models.length ? state.models : ["kimi", "qwen3.6-27b", "glm5.2", "claude", "gpt55", "deepseek_v4"];
}

function currentBench() {
  return els.benchSelect.value || "gcbench";
}

function currentModel() {
  return els.modelSelect.value || "kimi";
}

function currentPresetPath(kind) {
  const preset = byBench(currentBench());
  if (!preset) return "-";
  if (kind === "config") {
    return preset.config.replace(/\/[^/]+$/, `/${currentBench()}-L4_${currentModel()}.json`);
  }
  return preset[kind] || "-";
}

function setStatus(text, kind = "running") {
  els.runStatus.textContent = text;
  els.runStatus.className = `status-pill ${kind}`;
}

function fmtHours(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return `${Number(value).toFixed(2)} h`;
}

function fmtProgress(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return `${Number(value).toFixed(1)}%`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderLaunchDetails() {
  els.configPath.textContent = currentPresetPath("config");
  els.taskSource.textContent = currentPresetPath("task_source");
  els.seedArtifact.textContent = currentPresetPath("seed_artifact");
}

function renderSelects() {
  const selectedBench = els.benchSelect.value || "gcbench";
  const selectedModel = els.modelSelect.value || "kimi";
  els.benchSelect.replaceChildren();
  for (const item of state.presets) {
    const opt = document.createElement("option");
    opt.value = item.bench;
    opt.textContent = item.bench;
    els.benchSelect.appendChild(opt);
  }
  if (state.presets.some((item) => item.bench === selectedBench)) {
    els.benchSelect.value = selectedBench;
  } else if (state.presets.length) {
    els.benchSelect.value = state.presets[0].bench;
  }

  els.modelSelect.replaceChildren();
  for (const model of modelOptions()) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    els.modelSelect.appendChild(opt);
  }
  if (modelOptions().includes(selectedModel)) {
    els.modelSelect.value = selectedModel;
  } else {
    els.modelSelect.value = modelOptions()[0] || "kimi";
  }
  renderLaunchDetails();
}

function stageStatus(kind, active) {
  if (!state.active) return "idle";
  if (active) return "active";
  if (kind === "next" && state.latest && state.latest.heartbeat) return "done";
  if (kind === "verification" && state.latest && state.latest.verification && state.latest.verification.summary) {
    return state.latest.verification.summary.accepted ? "done" : "warn";
  }
  return "done";
}

function renderStages() {
  const latest = state.latest || {};
  const heartbeat = latest.heartbeat || {};
  const plan = latest.plan || {};
  const validation = latest.verification ? latest.verification.raw : null;
  const currentPhase = (latest.status || heartbeat.phase || "idle").toString();
  const activeEpoch = heartbeat.current_epoch || latest.latest_epoch || "-";
  const list = [
    {
      icon: "1",
      title: "GOA 启动",
      text: state.active ? `bench=${state.active.bench} model=${state.active.model}` : "等待启动",
      status: state.active ? "active" : "idle",
    },
    {
      icon: "2",
      title: "Task Run",
      text: currentPhase.startsWith("epoch_") ? `epoch ${activeEpoch} 在跑` : "等待进入任务",
      status: currentPhase.startsWith("epoch_") ? "active" : (state.active ? "done" : "idle"),
    },
    {
      icon: "3",
      title: "Verification",
      text: validation ? `cases=${latest.verification.summary.case_count}` : "等待 rubric",
      status: validation ? (latest.verification.summary.accepted ? "done" : "warn") : (state.active ? "active" : "idle"),
    },
    {
      icon: "4",
      title: "Harness Proposal",
      text: plan ? (plan.gradient?.diagnosis || "proposal ready") : "等待 proposal",
      status: plan ? "active" : (state.active ? "done" : "idle"),
    },
    {
      icon: "5",
      title: "Next Task",
      text: latest.latest_epoch != null ? `准备 epoch ${Number(latest.latest_epoch) + 1}` : "等待下一轮",
      status: state.active ? "done" : "idle",
    },
  ];
  els.stageRail.replaceChildren();
  for (const item of list) {
    const row = document.createElement("div");
    row.className = `stage-item ${item.status}`;
    row.innerHTML = `
      <div class="stage-dot"></div>
      <div class="stage-card">
        <h3>${esc(item.icon)}. ${esc(item.title)}</h3>
        <p>${esc(item.text)}</p>
      </div>
    `;
    els.stageRail.appendChild(row);
  }
}

function renderConversation() {
  const events = (state.latest && state.latest.conversation) || [];
  els.conversationList.replaceChildren();
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "conversation-empty";
    empty.innerHTML = `<strong>等待 GOA 对话事件</strong><p>启动后，这里会流式显示 GOA 的轮次、工具调用、工具结果和恢复事件。</p>`;
    els.conversationList.appendChild(empty);
    return;
  }
  for (const item of events) {
    const row = document.createElement("article");
    row.className = `conversation-item ${esc(item.role || "system")}`;
    const caseText = item.case ? ` · ${item.case}` : "";
    row.innerHTML = `
      <div class="conversation-head">
        <span class="conversation-role">${esc(item.title || "Event")}</span>
        <span class="conversation-case">${esc(caseText)}</span>
      </div>
      <p></p>
    `;
    row.querySelector("p").textContent = item.text || "";
    els.conversationList.appendChild(row);
  }
  const last = els.conversationList.lastElementChild;
  if (last) last.scrollIntoView({ block: "nearest" });
}

function renderTopState() {
  const latest = state.latest || {};
  const heartbeat = latest.heartbeat || {};
  const progress = latest.loop_progress || {};
  els.phaseValue.textContent = latest.status || heartbeat.phase || (state.active ? "running" : "idle");
  els.epochValue.textContent = heartbeat.current_epoch || latest.latest_epoch || "-";
  els.elapsedValue.textContent = fmtHours(progress.elapsed_hours);
  els.progressValue.textContent = fmtProgress(progress.percent);
  els.timeMeter.style.width = `${progress.percent || 0}%`;
  if (!state.active) {
    setStatus("未连接", "warn");
    els.stopBtn.disabled = true;
    return;
  }
  const alive = latest.process && latest.process.alive;
  setStatus(alive ? "运行中" : "已停止", alive ? "running" : "stop");
  els.stopBtn.disabled = !alive;
}

function renderProposal() {
  const plan = state.latest && state.latest.plan;
  if (!plan) {
    els.proposalView.innerHTML = `<div class="trace-meta">等待 harness proposal agent 产出计划。</div>`;
    return;
  }
  const attempts = plan.stage_attempts || {};
  const errors = plan.stage_errors || {};
  const selected = plan.selected || {};
  const shortlist = Array.isArray(plan.shortlist) ? plan.shortlist : [];
  const elements = Array.isArray(plan.disclosed_elements) ? plan.disclosed_elements : [];
  els.proposalView.innerHTML = `
    <div><strong>${esc((plan.gradient && plan.gradient.diagnosis) || "proposal ready")}</strong></div>
    <div class="trace-meta">shortlist ${shortlist.length} · disclosed ${elements.length}</div>
    <div class="trace-meta">shortlist attempts ${attempts.shortlist || 0} · selection attempts ${attempts.selection || 0}</div>
    <div class="trace-meta">selected ${esc(selected.element_id || "n/a")} ${selected.category ? `(${esc(selected.category)})` : ""}</div>
    <div class="trace-meta">${Object.keys(errors).length ? "有重试记录" : "无显著错误"}</div>
  `;
}

function renderVerification() {
  const verification = state.latest && state.latest.verification;
  if (!verification || !verification.summary) {
    els.verificationView.innerHTML = `<div class="trace-meta">等待 rubric 验证结果。</div>`;
    els.validationSummary.replaceChildren();
    els.hardRubrics.innerHTML = `<div class="trace-meta">暂无</div>`;
    els.softRubrics.innerHTML = `<div class="trace-meta">暂无</div>`;
    els.caseReview.innerHTML = `<div class="trace-meta">暂无 case</div>`;
    return;
  }
  const summary = verification.summary;
  const chips = [
    [summary.accepted === true ? "ok" : summary.accepted === false ? "bad" : "neutral", summary.accepted === true ? "Accepted" : summary.accepted === false ? "Rejected" : "Pending"],
    [summary.hard_ok === true ? "ok" : summary.hard_ok === false ? "bad" : "neutral", summary.hard_ok === true ? "Hard OK" : summary.hard_ok === false ? "Hard Fail" : "Hard n/a"],
    [summary.soft_ok === true ? "ok" : summary.soft_ok === false ? "bad" : "neutral", summary.soft_ok === true ? "Soft OK" : summary.soft_ok === false ? "Soft Fail" : "Soft n/a"],
    ["neutral", `${summary.case_count || 0} cases`],
  ];
  els.validationSummary.replaceChildren(...chips.map(([cls, text]) => {
    const chip = document.createElement("span");
    chip.className = `chip ${cls}`;
    chip.textContent = text;
    return chip;
  }));
  els.verificationView.innerHTML = `
    <div><strong>${summary.accepted === true ? "验证通过" : summary.accepted === false ? "验证未通过" : "验证中"}</strong></div>
    <div class="trace-meta">soft parent ${Number(summary.parent_soft || 0).toFixed(3)} · candidate ${Number(summary.candidate_soft || 0).toFixed(3)}</div>
    <div class="trace-meta">${esc((summary.reasons || []).slice(0, 2).join("；") || "暂无原因")}</div>
  `;

  const rows = verification.rows || [];
  const first = rows[0] || null;
  const hardBox = [];
  const softBox = [];
  if (first) {
    const hardKeys = Object.keys(first.parent_hard || {});
    const softKeys = Object.keys(first.parent_soft || {});
    for (const key of hardKeys) {
      hardBox.push(renderMetricRow(key, first.parent_hard[key], first.candidate_hard[key], true));
    }
    for (const key of softKeys) {
      softBox.push(renderMetricRow(key, first.parent_soft[key], first.candidate_soft[key], false));
    }
  }
  els.hardRubrics.innerHTML = hardBox.join("") || `<div class="trace-meta">没有 hard rubric 数据。</div>`;
  els.softRubrics.innerHTML = softBox.join("") || `<div class="trace-meta">没有 soft rubric 数据。</div>`;
  els.caseReview.innerHTML = rows.map((row) => {
    const verdict = row.passed === true ? "PASS" : "FAIL";
    const tags = [
      `<span class="tag">parent ${Number(row.parent_soft_total || 0).toFixed(3)}</span>`,
      `<span class="tag">candidate ${Number(row.candidate_soft_total || 0).toFixed(3)}</span>`,
    ].join("");
    return `
      <div class="rubric-row">
        <h4>${esc(row.case_id || "case")} · ${verdict}</h4>
        <div class="scoreline">${tags}</div>
        <p>${esc((row.reasons || []).join("；") || "no reason")}</p>
      </div>
    `;
  }).join("") || `<div class="trace-meta">没有 case 详情。</div>`;
}

function hgaStatusClass(status) {
  if (["applied", "unchanged"].includes(status)) return "ok";
  if (status === "failed_infrastructure_or_validation") return "bad";
  if (["shortlisting", "planning", "applying"].includes(status)) return "warn";
  return "neutral";
}

function hgaStatusLabel(status) {
  return ({
    shortlisting: "Shortlisting",
    planning: "Planning",
    applying: "Applying",
    applied: "Applied",
    unchanged: "Unchanged",
    failed_infrastructure_or_validation: "Failed",
    idle: "Idle",
  })[status] || status || "Idle";
}

function renderHga() {
  const hga = state.latest && state.latest.hga;
  if (!hga || !hga.present) {
    els.hgaSummary.replaceChildren();
    els.hgaView.innerHTML = `
      <div class="hga-empty">
        <strong>HGA 尚未产生外环记录</strong>
        <p>内环运行后，HGA 会读取本轮证据，逐步 shortlist、规划并更新 outer element library。</p>
      </div>
    `;
    return;
  }

  const status = hga.status || "idle";
  const summaryItems = [
    [hgaStatusClass(status), hgaStatusLabel(status)],
    ["neutral", `epoch ${hga.epoch ?? "-"}`],
    ["neutral", `revision ${hga.revision ?? "-"}`],
    ["neutral", `${hga.catalog_size || 0} elements`],
  ];
  els.hgaSummary.replaceChildren(...summaryItems.map(([cls, text]) => {
    const chip = document.createElement("span");
    chip.className = `chip ${cls}`;
    chip.textContent = text;
    return chip;
  }));

  const plan = hga.plan || {};
  const operations = Array.isArray(hga.operations) ? hga.operations : [];
  const additions = Array.isArray(hga.additions) ? hga.additions : [];
  const shortlist = Array.isArray(hga.shortlist) ? hga.shortlist : [];
  const disclosed = Array.isArray(hga.disclosed_elements) ? hga.disclosed_elements : [];
  const operationRows = operations.length
    ? operations.map((item) => `
        <div class="hga-action">
          <span class="action-kind">${esc(item.operation || "operation")}</span>
          <strong>${esc(item.element_id || item.id || "unknown")}</strong>
          <p>${esc(item.reason || item.correction_hypothesis || "no rationale")}</p>
        </div>
      `).join("")
    : `<div class="trace-meta">本轮没有结构性 operation。</div>`;
  const statRows = (hga.exposure_rows || []).map((row) => {
    const usage = row.usage || {};
    const accuracy = usage.accuracy == null ? "-" : `${(Number(usage.accuracy) * 100).toFixed(0)}%`;
    return `
      <div class="hga-stat-row">
        <div>
          <strong>${esc(row.id || "unknown")}</strong>
          <span>${esc(row.category || "uncategorized")}</span>
        </div>
        <span>${usage.usage_count ?? 0} uses</span>
        <span>${accuracy} success</span>
      </div>
    `;
  }).join("") || `<div class="trace-meta">暂无 element 使用统计。</div>`;

  els.hgaView.innerHTML = `
    <div class="hga-column hga-overview">
      <div class="hga-state">
        <span class="state-orb ${hgaStatusClass(status)}"></span>
        <div>
          <strong>${esc(hga.message || hgaStatusLabel(status))}</strong>
          <p>revision ${hga.revision_before ?? "-"} → ${hga.revision_after ?? hga.revision ?? "-"}</p>
        </div>
      </div>
      <div class="hga-facts">
        <div><span>Shortlist</span><strong>${shortlist.length}</strong></div>
        <div><span>Disclosed</span><strong>${disclosed.length}</strong></div>
        <div><span>Operations</span><strong>${operations.length}</strong></div>
        <div><span>Additions</span><strong>${additions.length}</strong></div>
      </div>
      <div class="hga-note">${esc(hga.error || plan.rationale || plan.diagnosis || "HGA 正在根据内环 evidence 管理外环 element library。")}</div>
    </div>
    <div class="hga-column">
      <div class="hga-section-title">本轮决策</div>
      <div class="hga-actions">${operationRows}</div>
      ${additions.length ? `<div class="trace-meta hga-additions">新增候选：${esc(additions.map((item) => item.element_id || item.id || item.category || "element").join("、"))}</div>` : ""}
      <div class="trace-meta">shortlist：${esc(shortlist.join("、") || "暂无")}</div>
    </div>
    <div class="hga-column">
      <div class="hga-section-title">Element 使用与成功率</div>
      <div class="hga-stats">${statRows}</div>
    </div>
  `;
}

function renderMetricRow(label, parentVal, candidateVal, binary) {
  const p = parentVal == null ? "-" : Number(parentVal);
  const c = candidateVal == null ? "-" : Number(candidateVal);
  const delta = p === "-" || c === "-" ? "" : `Δ ${(c - p).toFixed(3)}`;
  return `
    <div class="rubric-row">
      <h4>${esc(label)}</h4>
      <div class="scoreline">
        <span class="tag">parent ${p === "-" ? "-" : p.toFixed(binary ? 0 : 3)}</span>
        <span class="tag">candidate ${c === "-" ? "-" : c.toFixed(binary ? 0 : 3)}</span>
        ${delta ? `<span class="tag">${delta}</span>` : ""}
      </div>
    </div>
  `;
}

function renderLogTail() {
  const lines = (state.latest && state.latest.log_tail) || [];
  els.logTail.textContent = lines.length ? lines.join("\n") : "暂无日志";
}

function renderAll() {
  renderLaunchDetails();
  renderStages();
  renderConversation();
  renderTopState();
  renderProposal();
  renderVerification();
  renderHga();
  renderLogTail();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json();
}

async function refresh() {
  try {
    const data = await fetchJson("/api/state");
    state.latest = data;
    state.presets = data.presets || state.presets;
    state.models = data.models || state.models;
    if (data.active) {
      state.active = data.run || null;
    } else {
      state.active = null;
    }
    renderSelects();
    renderAll();
  } catch (error) {
    setStatus("连接失败", "warn");
    els.conversationList.innerHTML = `<div class="conversation-empty"><strong>Dashboard backend unavailable</strong><p>${error.message}</p></div>`;
  }
}

async function startRun() {
  const payload = {
    bench: currentBench(),
    model: currentModel(),
    duration_hours: Number(els.hoursInput.value || 24),
    max_epochs: Number(els.epochsInput.value || 200),
    cases: Number(els.casesInput.value || 3),
  };
  els.startBtn.disabled = true;
  try {
    const result = await fetchJson("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setStatus(result.ok ? "运行中" : "启动失败", result.ok ? "running" : "warn");
    await refresh();
  } catch (error) {
    setStatus("启动失败", "stop");
    alert(error.message);
  } finally {
    els.startBtn.disabled = false;
  }
}

async function stopRun() {
  els.stopBtn.disabled = true;
  try {
    await fetchJson("/api/stop", { method: "POST" });
    await refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    els.stopBtn.disabled = false;
  }
}

els.benchSelect.addEventListener("change", renderLaunchDetails);
els.modelSelect.addEventListener("change", renderLaunchDetails);
els.startBtn.addEventListener("click", startRun);
els.stopBtn.addEventListener("click", stopRun);

await refresh();
setInterval(refresh, 2500);
