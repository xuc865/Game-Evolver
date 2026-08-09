from __future__ import annotations

import json
import os
import subprocess
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Any

from game_loop.core.harness import HarnessEvolutionEngine, HarnessProfile
from game_loop.utils import atomic_write_json, read_json, utc_now

# ── HTML template ─────────────────────────────────────────────────────

UI_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Harness Self-Evolution Monitor</title>
<style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           background:#0d0b1a; color:#e0d8f0; min-height:100vh; }
    header { background:#120f24; border-bottom:2px solid #574181; padding:12px 18px;
             display:flex; align-items:center; justify-content:space-between; }
    header h1 { font-size:18px; color:#c4b5fd; }
    .statusBar { display:flex; gap:16px; font-size:13px; }
    .statusBar .badge { padding:4px 10px; border-radius:6px; font-weight:600; }
    .badge.ok { background:#1a3a1a; color:#6ee7b7; }
    .badge.warn { background:#3a2a1a; color:#fbbf24; }
    .badge.err { background:#3a1a1a; color:#fca5a5; }
    main { padding:18px; display:grid; grid-template-columns: 300px minmax(0,1fr) minmax(0,1fr); gap:14px; min-height: calc(100vh - 76px); max-width:1920px; margin:0 auto; }
    .panel { background:#120f24; border:1px solid #2d2550; border-radius:8px; padding:14px; }
    .panel h2 { font-size:15px; color:#a78bfa; margin-bottom:10px; border-bottom:1px solid #2d2550; padding-bottom:6px; }
    .tree { max-height:44vh; overflow:auto; font-size:12px; line-height:1.55; color:#f8f1d8; }
    .tree .epoch { margin-bottom:12px; padding:8px; background:#0b0912; border-radius:6px; border:1px solid #2d2550; }
    .tree .epoch h3 { font-size:13px; color:#a78bfa; margin-bottom:4px; }
    .tree .epoch .meta { font-size:11px; color:#7c6fa0; margin-bottom:6px; }
    .tree .epoch .cases { font-size:11px; }
    .tree .epoch .case { padding:2px 0; }
    .tree .epoch .case.pass { color:#6ee7b7; }
    .tree .epoch .case.fail { color:#fca5a5; }
    .tree .epoch .case.running { color:#fbbf24; }
    .wide { grid-column: span 2; }
    .candidateList { max-height:320px; overflow:auto; display:flex; flex-direction:column; gap:8px; margin-top:8px; }
    .candidateCard { background:#0b0912; border:1px solid #2d2550; border-radius:6px; padding:10px; cursor:pointer; transition:border-color 0.2s; }
    .candidateCard:hover { border-color:#a78bfa; }
    .candidateCard.active { border-color:#6ee7b7; border-width:2px; }
    .candidateCard h3 { font-size:13px; margin-bottom:4px; }
    .candidateCard .id { font-family:monospace; font-size:11px; color:#7c6fa0; }
    .candidateCard .stats { font-size:12px; color:#c4b5fd; margin-top:4px; }
    .candidateCard .stats .pass { color:#6ee7b7; }
    .candidateCard .stats .fail { color:#fca5a5; }
    .candidateCard .stats .delta { color:#fbbf24; }
    .detail { background:#0b0912; border:1px solid #2d2550; border-radius:6px; padding:12px; }
    .detail h3 { font-size:14px; color:#a78bfa; margin-bottom:8px; }
    .detail .info { font-size:12px; color:#c4b5fd; margin-bottom:6px; }
    .detail .info span { color:#7c6fa0; }
    .viewer { min-height:280px; border:2px dashed #574181; display:flex; align-items:center; justify-content:center; background:#090711; overflow:hidden; }
    .viewer img { max-width:100%; max-height:520px; image-rendering:pixelated; }
    .viewer .placeholder { color:#574181; font-size:14px; }
    .jsonbox { max-height:280px; overflow:auto; background:#0b0912; border:1px solid #574181; padding:8px; font-size:11px; white-space:pre-wrap; }
    pre { white-space:pre-wrap; word-break:break-word; margin:0; max-height:38vh; overflow:auto; color:#d7f9ff; font-size:12px; line-height:1.45; }
    .timeline { max-height:44vh; overflow:auto; display:flex; flex-direction:column; gap:8px; }
    .timeline .entry { font-size:12px; padding:6px 8px; background:#0b0912; border-radius:4px; border-left:3px solid #574181; }
    .timeline .entry.accept { border-left-color:#6ee7b7; }
    .timeline .entry.reject { border-left-color:#fca5a5; }
    .timeline .entry .time { color:#7c6fa0; font-size:10px; }
    .btn { padding:6px 12px; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600; }
    .btn.primary { background:#574181; color:#e0d8f0; }
    .btn.primary:hover { background:#6b52a0; }
    .btn.danger { background:#7f1d1d; color:#fca5a5; }
    .btn.danger:hover { background:#991b1b; }
    .actions { display:flex; gap:8px; margin-top:10px; }
    .supervisor { font-size:12px; color:#7c6fa0; margin-top:8px; padding:8px; background:#0b0912; border-radius:4px; }
    @media(max-width:1100px){ main{ grid-template-columns:1fr; } .wide{grid-column:auto;} }
</style>
</head>
<body>
<header>
    <h1>Harness Self-Evolution</h1>
    <div class="statusBar" id="statusBar"></div>
</header>
<main>
    <div class="panel" id="leftPanel">
        <h2>Candidates</h2>
        <div class="candidateList" id="candidateList"></div>
    </div>
    <div class="panel" id="detailPanel">
        <h2>Candidate Detail</h2>
        <div class="detail" id="detail"></div>
    </div>
    <div class="panel" id="viewerPanel">
        <h2>Game Preview</h2>
        <div class="viewer" id="viewer">
            <span class="placeholder">Select a case to preview</span>
        </div>
        <div class="actions" id="viewerActions"></div>
    </div>
    <div class="panel wide" id="timelinePanel">
        <h2>Evolution Timeline</h2>
        <div class="timeline" id="timeline"></div>
    </div>
</main>
<script>
const API = '/api/state';
let state = null;
let selectedCandidate = null;
let selectedCase = null;

async function refresh() {
    try {
        const r = await fetch(API);
        state = await r.json();
        render();
    } catch(e) {
        console.error('refresh failed', e);
    }
}

function render() {
    renderStatusBar();
    renderCandidates();
    renderTimeline();
    if (selectedCandidate) renderDetail();
}

function renderStatusBar() {
    const hp = state.harness_panel || {};
    const sup = hp.supervisor || {};
    const lp = state.loop_panel || {};
    const prog = lp.progress || {};
    const html = [
        `<span class="badge ${sup.pid ? 'ok' : 'warn'}">Supervisor: ${sup.pid ? 'PID '+sup.pid : 'OFF'}</span>`,
        `<span class="badge ok">Epoch: ${sup.current_epoch || '-'} / ${sup.latest_completed_epoch || '-'}</span>`,
        `<span class="badge ${prog.phase === 'running' ? 'ok' : 'warn'}">Loop: ${prog.phase || 'idle'}</span>`,
    ];
    document.getElementById('statusBar').innerHTML = html.join('');
}

function renderCandidates() {
    const hp = state.harness_panel || {};
    const candidates = hp.candidates || [];
    const list = document.getElementById('candidateList');
    if (!candidates.length) {
        list.innerHTML = '<div style="color:#7c6fa0;font-size:12px;">No candidates yet</div>';
        return;
    }
    list.innerHTML = candidates.map(c => {
        const rawCases = Array.isArray(c.case_rubric_results) ? c.case_rubric_results : [];
        const regressionLimit = Number(c.max_case_regression || 0);
        const backendUsable = Number(c.usable_internal_cases || 0);
        const backendFailed = Number(c.failed_internal_cases || 0);
        const running = Number(c.running_internal_cases || 0);
        const hasBackend = backendUsable > 0 || backendFailed > 0 || running > 0;
        const casePasses = hasBackend
            ? backendUsable
            : (rawCases.length
                ? rawCases.filter(x => x && x.passed === true && Number(x.delta || 0) >= -regressionLimit).length
                : 0);
        const caseFails = hasBackend
            ? backendFailed
            : (rawCases.length
                ? rawCases.filter(x => x && !(x.passed === true && Number(x.delta || 0) >= -regressionLimit)).length
                : 0);
        const executed = hasBackend
            ? (backendUsable + backendFailed + running)
            : Number(c.executed_internal_cases || (casePasses + caseFails + running));
        const total = Number(c.required_internal_cases || 0);
        const active = selectedCandidate && selectedCandidate.candidate_harness_id === c.candidate_harness_id;
        const statusClass = c.accepted ? 'pass' : (c.status === 'REJECTED' ? 'fail' : 'running');
        return `<div class="candidateCard ${active ? 'active' : ''}" onclick="selectCandidate('${c.candidate_harness_id}')">
            <h3>Epoch ${c.epoch} · ${c.status || 'PENDING'}</h3>
            <div class="id">${(c.parent_harness_id || '').substring(0,16)} → ${(c.candidate_harness_id || '').substring(0,16)}</div>
            <div class="stats">
                cases ${executed}/${total}
                <span class="pass">pass ${casePasses}</span>
                <span class="fail">failed ${caseFails}</span>
                ${c.median_delta != null ? `<span class="delta">Δ ${Number(c.median_delta).toFixed(4)}</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

function selectCandidate(id) {
    selectedCandidate = state.harness_panel.candidates.find(c => c.candidate_harness_id === id) || null;
    selectedCase = null;
    renderCandidates();
    renderDetail();
}

function renderDetail() {
    const panel = document.getElementById('detail');
    const viewer = document.getElementById('viewer');
    const viewerActions = document.getElementById('viewerActions');
    if (!selectedCandidate) {
        panel.innerHTML = '<div style="color:#7c6fa0;font-size:12px;">Select a candidate</div>';
        viewer.innerHTML = '<span class="placeholder">Select a case to preview</span>';
        viewerActions.innerHTML = '';
        return;
    }
    const c = selectedCandidate;
    const rawCases = Array.isArray(c.case_rubric_results) ? c.case_rubric_results : [];
    const regressionLimit = Number(c.max_case_regression || 0);
    const backendUsable = Number(c.usable_internal_cases || 0);
    const backendFailed = Number(c.failed_internal_cases || 0);
    const running = Number(c.running_internal_cases || 0);
    const hasBackend = backendUsable > 0 || backendFailed > 0 || running > 0;
    const casePasses = hasBackend
        ? backendUsable
        : (rawCases.length
            ? rawCases.filter(x => x && x.passed === true && Number(x.delta || 0) >= -regressionLimit).length
            : 0);
    const caseFails = hasBackend
        ? backendFailed
        : (rawCases.length
            ? rawCases.filter(x => x && !(x.passed === true && Number(x.delta || 0) >= -regressionLimit)).length
            : 0);
    const executed = hasBackend
        ? (backendUsable + backendFailed + running)
        : Number(c.executed_internal_cases || (casePasses + caseFails + running));
    const total = Number(c.required_internal_cases || 0);
    const pct = total > 0 ? Math.round(executed / total * 100) : 0;

    panel.innerHTML = `<h3>Epoch ${c.epoch} — ${c.status || 'PENDING'}</h3>
        <div class="info"><span>Parent:</span> ${c.parent_harness_id || '-'}</div>
        <div class="info"><span>Candidate:</span> ${c.candidate_harness_id || '-'}</div>
        <div class="info"><span>Cases:</span> ${executed}/${total} (${pct}%)</div>
        <div class="info"><span>Pass:</span> <span class="pass">${casePasses}</span> <span>Failed:</span> <span class="fail">${caseFails}</span></div>
        ${c.median_delta != null ? `<div class="info"><span>Median Δ:</span> ${Number(c.median_delta).toFixed(4)}</div>` : ''}
        ${c.reasons && c.reasons.length ? `<div class="info"><span>Reasons:</span> ${c.reasons.join('; ')}</div>` : ''}
        <h3 style="margin-top:12px;">Cases</h3>
        <div style="max-height:200px;overflow:auto;font-size:11px;">
            ${rawCases.map((rc, i) => {
                const passed = rc.passed === true;
                const cls = passed ? 'pass' : 'fail';
                return `<div class="case ${cls}" style="cursor:pointer;padding:3px 0;" onclick="selectCase(${i})">
                    Case ${i+1}: ${rc.case_id || '?'} — ${passed ? 'PASS' : 'FAIL'}
                    ${rc.candidate_score != null ? ` score=${Number(rc.candidate_score).toFixed(4)}` : ''}
                    ${rc.delta != null ? ` Δ=${Number(rc.delta).toFixed(4)}` : ''}
                </div>`;
            }).join('')}
        </div>`;

    // Viewer
    if (selectedCase != null && rawCases[selectedCase]) {
        viewer.innerHTML = '<span class="placeholder">No preview available</span>';
        viewerActions.innerHTML = '';
    } else {
        viewer.innerHTML = '<span class="placeholder">Select a case to preview</span>';
        viewerActions.innerHTML = '';
    }
}

function selectCase(idx) {
    selectedCase = idx;
    renderDetail();
}

function renderTimeline() {
    const hp = state.harness_panel || {};
    const candidates = hp.candidates || [];
    const timeline = document.getElementById('timeline');
    if (!candidates.length) {
        timeline.innerHTML = '<div style="color:#7c6fa0;font-size:12px;">No evolution history</div>';
        return;
    }
    timeline.innerHTML = candidates.slice().reverse().map(c => {
        const cls = c.accepted ? 'accept' : (c.status === 'REJECTED' ? 'reject' : '');
        return `<div class="entry ${cls}">
            <div class="time">Epoch ${c.epoch} · ${c.created_at || ''}</div>
            <div>${c.status || 'PENDING'} — ${c.parent_harness_id ? c.parent_harness_id.substring(0,12) : '?'} → ${c.candidate_harness_id ? c.candidate_harness_id.substring(0,12) : '?'}</div>
            ${c.median_delta != null ? `<div>Δ ${Number(c.median_delta).toFixed(4)}</div>` : ''}
        </div>`;
    }).join('');
}

setInterval(refresh, 5000);
refresh();
</script>
</body>
</html>"""


# ── API handlers ──────────────────────────────────────────────────────

def _harness_candidate_item(
    result: dict[str, Any],
    outer_dir: Path,
) -> dict[str, Any]:
    """Build a single candidate item for the harness panel API."""
    epoch = result.get("epoch", 0)
    candidate_id = result.get("candidate_harness_id", "")
    parent_id = result.get("parent_harness_id", "")

    # Collect case rubric results from admission_runs
    case_rubric_results = []
    admission_dir = outer_dir / "admission_runs"
    if admission_dir.is_dir():
        for case_dir in sorted(admission_dir.iterdir()):
            if not case_dir.is_dir():
                continue
            paired_path = case_dir / "paired_admission.json"
            if paired_path.is_file():
                try:
                    paired = json.loads(paired_path.read_text(encoding="utf-8"))
                    if paired.get("candidate_harness_id") == candidate_id:
                        case_rubric_results.append({
                            "case_id": paired.get("case_id", case_dir.name),
                            "passed": paired.get("passed", False),
                            "candidate_score": paired.get("candidate_score"),
                            "parent_score": paired.get("parent_score"),
                            "delta": paired.get("delta"),
                            "reason": paired.get("reason", ""),
                        })
                except Exception:
                    pass

    # Count usable/failed/running cases
    usable = sum(1 for r in case_rubric_results if r.get("passed"))
    failed = sum(1 for r in case_rubric_results if not r.get("passed"))
    running = 0
    for case_dir in admission_dir.iterdir() if admission_dir.is_dir() else []:
        if not case_dir.is_dir():
            continue
        state_path = case_dir / "candidate" / "state.json"
        if state_path.is_file():
            try:
                st = json.loads(state_path.read_text(encoding="utf-8"))
                status = str(st.get("status", ""))
                if status == "loop_running":
                    running += 1
            except Exception:
                pass

    return {
        "epoch": epoch,
        "parent_harness_id": parent_id,
        "candidate_harness_id": candidate_id,
        "status": "ACCEPTED" if result.get("accepted") else "REJECTED",
        "accepted": result.get("accepted", False),
        "median_delta": result.get("median_delta"),
        "reasons": result.get("reasons", []),
        "paired_deltas": result.get("paired_deltas", []),
        "executed_internal_cases": len(case_rubric_results),
        "required_internal_cases": len(case_rubric_results) + 1,  # at least one more expected
        "usable_internal_cases": usable,
        "failed_internal_cases": failed,
        "running_internal_cases": running,
        "case_rubric_results": case_rubric_results,
        "max_case_regression": 0.1,
        "created_at": result.get("created_at", ""),
        "excluded_pairs": result.get("excluded_pairs", []),
    }


def _harness_panel(outer_dir: Path) -> dict[str, Any]:
    """Build the harness panel data for the UI."""
    archive = outer_dir / "harness_archive"
    epochs_path = archive / "epochs.json"

    candidates = []
    if epochs_path.is_file():
        try:
            epochs_data = read_json(epochs_path)
            for item in epochs_data.get("items", []):
                candidates.append(_harness_candidate_item(item, outer_dir))
        except Exception:
            pass

    # Supervisor info
    supervisor = {}
    heartbeat_path = outer_dir / ".supervisor_heartbeat.json"
    if heartbeat_path.is_file():
        try:
            supervisor = read_json(heartbeat_path)
        except Exception:
            pass

    # External running status
    external_running = False
    pid_path = outer_dir / ".supervisor.pid"
    if pid_path.is_file():
        try:
            pid_data = read_json(pid_path)
            pid = pid_data.get("pid")
            if pid:
                os.kill(pid, 0)
                external_running = True
        except (OSError, Exception):
            pass

    return {
        "candidates": candidates,
        "supervisor": supervisor,
        "external_running": external_running,
    }


def _loop_panel(run_dir: Path | None = None) -> dict[str, Any]:
    """Build the loop panel data for the UI."""
    if run_dir is None or not run_dir.is_dir():
        return {"progress": {"phase": "idle", "percent": 0}}

    state_path = run_dir / "state.json"
    if not state_path.is_file():
        return {"progress": {"phase": "idle", "percent": 0}}

    try:
        st = read_json(state_path)
        status = str(st.get("status", "idle"))
        model_calls = int(st.get("model_calls", 0))
        evaluator_queries = int(st.get("evaluator_queries", 0))
        generation = int(st.get("generation", 0))

        manifest_path = run_dir / "manifest.json"
        max_model = 0
        max_eval = 0
        if manifest_path.is_file():
            mf = read_json(manifest_path)
            budgets = mf.get("budgets", {})
            max_model = int(budgets.get("model_calls", 0))
            max_eval = int(budgets.get("evaluator_queries", 0))

        pct = 0
        if max_model > 0:
            pct = min(100, round(model_calls / max_model * 100))

        return {
            "progress": {
                "phase": status,
                "percent": pct,
                "model_calls": model_calls,
                "max_model_calls": max_model,
                "evaluator_queries": evaluator_queries,
                "max_evaluator_queries": max_eval,
                "generation": generation,
            }
        }
    except Exception:
        return {"progress": {"phase": "error", "percent": 0}}


def _build_state(outer_dir: Path) -> dict[str, Any]:
    """Build the full UI state."""
    return {
        "harness_panel": _harness_panel(outer_dir),
        "loop_panel": _loop_panel(),
        "updated_at": utc_now(),
    }


# ── HTTP server ───────────────────────────────────────────────────────

class UIHandler(SimpleHTTPRequestHandler):
    """Custom handler that serves the UI HTML and API endpoints."""

    outer_dir: Path = Path(".")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self._serve_html()
        elif self.path == "/api/state":
            self._serve_api_state()
        elif self.path == "/api/health":
            self._serve_json({"status": "ok"})
        elif self.path.startswith("/api/case/"):
            self._serve_case_detail()
        elif self.path.startswith("/preview/"):
            self._serve_preview()
        else:
            self._serve_static()

    def do_POST(self):
        if self.path == "/api/restart-supervisor":
            self._restart_supervisor()
        elif self.path == "/api/run-bench":
            self._run_bench()
        else:
            self.send_error(404)

    def _serve_html(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(UI_HTML.encode("utf-8"))

    def _serve_json(self, data: dict[str, Any]):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))

    def _serve_api_state(self):
        try:
            state = _build_state(self.outer_dir)
            self._serve_json(state)
        except Exception as e:
            self.send_error(500, str(e))

    def _serve_case_detail(self):
        case_id = self.path.replace("/api/case/", "").strip("/")
        case_dir = self.outer_dir / "admission_runs" / case_id
        if not case_dir.is_dir():
            self.send_error(404, f"Case {case_id} not found")
            return

        detail = {"case_id": case_id}

        # Paired admission
        paired_path = case_dir / "paired_admission.json"
        if paired_path.is_file():
            try:
                detail["paired_admission"] = json.loads(paired_path.read_text(encoding="utf-8"))
            except Exception:
                pass

        # Parent state
        parent_state_path = case_dir / "parent" / "state.json"
        if parent_state_path.is_file():
            try:
                detail["parent_state"] = json.loads(parent_state_path.read_text(encoding="utf-8"))
            except Exception:
                pass

        # Candidate state
        cand_state_path = case_dir / "candidate" / "state.json"
        if cand_state_path.is_file():
            try:
                detail["candidate_state"] = json.loads(cand_state_path.read_text(encoding="utf-8"))
            except Exception:
                pass

        self._serve_json(detail)

    def _serve_preview(self):
        preview_path = self.path.replace("/preview/", "").strip("/")
        full_path = self.outer_dir / "admission_runs" / preview_path
        if not full_path.is_file():
            self.send_error(404)
            return

        content_type = "application/octet-stream"
        if preview_path.endswith(".png"):
            content_type = "image/png"
        elif preview_path.endswith(".html"):
            content_type = "text/html; charset=utf-8"
        elif preview_path.endswith(".json"):
            content_type = "application/json"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        self.wfile.write(full_path.read_bytes())

    def _serve_static(self):
        self.send_error(404)

    def _restart_supervisor(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length else b"{}"
            params = json.loads(body)

            # Kill existing supervisor
            pid_path = self.outer_dir / ".supervisor.pid"
            if pid_path.is_file():
                try:
                    pid_data = json.loads(pid_path.read_text(encoding="utf-8"))
                    pid = pid_data.get("pid")
                    if pid:
                        os.kill(pid, 9)
                except Exception:
                    pass

            self._serve_json({"status": "ok", "message": "Supervisor restart initiated"})
        except Exception as e:
            self.send_error(500, str(e))

    def _run_bench(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length) if content_length else b"{}"
            params = json.loads(body)

            self._serve_json({"status": "ok", "message": "Bench run initiated"})
        except Exception as e:
            self.send_error(500, str(e))

    def log_message(self, format, *args):
        """Suppress default logging."""
        pass


def run_ui_server(
    *,
    outer_dir: Path,
    host: str = "0.0.0.0",
    port: int = 8765,
) -> None:
    """Start the harness self-evolution UI server."""
    UIHandler.outer_dir = outer_dir.resolve()

    server = HTTPServer((host, port), UIHandler)
    print(f"[ui] serving on http://{host}:{port}")
    print(f"[ui] outer_dir={outer_dir}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[ui] shutting down")
        server.server_close()


# ── CLI entry ─────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="game_loop ui")
    parser.add_argument("--outer-dir", type=Path, required=True)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)

    args = parser.parse_args(argv)

    run_ui_server(
        outer_dir=args.outer_dir,
        host=args.host,
        port=args.port,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
