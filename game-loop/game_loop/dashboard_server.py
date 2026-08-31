from __future__ import annotations

import argparse
import html
import json
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from game_loop.config import AppConfig
from game_loop.utils import atomic_write_json, read_json, utc_now


ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_DIR = ROOT / "dashboard"
RUNS_ROOT = ROOT / "experiments" / "dashboard-runs"
ACTIVE_META = RUNS_ROOT / "active_run.json"

MODELS = ("kimi", "qwen3.6-27b", "glm5.2", "claude", "gpt55", "deepseek_v4")

PRESETS: dict[str, dict[str, Path]] = {
    "gcbench": {
        "config": ROOT / "experiments" / "configs-v4" / "gcbench-L4_kimi.json",
        "task_source": ROOT.parent / "gcbench" / "tasks",
        "seed_artifact": ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold",
    },
    "gdbench": {
        "config": ROOT / "experiments" / "configs-v4" / "gdbench-L4_kimi.json",
        "task_source": ROOT / "third_party" / "gamedevbench" / "tasks",
        "seed_artifact": ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold",
    },
    "verigame": {
        "config": ROOT / "experiments" / "configs-v4" / "verigame-L4_kimi.json",
        "task_source": ROOT / "third_party" / "GameGen-Verifier" / "spec",
        "seed_artifact": ROOT / "experiments" / "public_baseline_seeds" / "verigame",
    },
    "terminalbench": {
        "config": ROOT / "experiments" / "configs-v4" / "terminalbench-L4_kimi.json",
        "task_source": ROOT / "third_party" / "terminal-bench-2",
        "seed_artifact": ROOT / "experiments" / "general-baseline" / "seed_terminalbench",
    },
    "taubench": {
        "config": ROOT / "experiments" / "configs-v4" / "taubench-L4_kimi.json",
        "task_source": ROOT / "experiments" / "general-baseline" / "taubench-instruction.md",
        "seed_artifact": ROOT / "experiments" / "general-baseline" / "seed_taubench",
    },
    "nl2repo": {
        "config": ROOT / "experiments" / "configs-v4" / "nl2repo-L4_kimi.json",
        "task_source": ROOT / "third_party" / "NL2RepoBench" / "NL2RepoBench_src" / "test_files",
        "seed_artifact": ROOT / "experiments" / "general-baseline" / "seed_nl2repo",
    },
}


def _json_response(data: dict[str, Any], status: int = 200) -> tuple[int, bytes]:
    return status, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _tail_lines(path: Path, limit: int = 120) -> list[str]:
    if not path.is_file():
        return []
    try:
        data = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return []
    return data[-limit:]


def _format_tool_result(tool: str, raw_content: Any) -> str:
    raw = str(raw_content or "")
    value: Any = raw
    if raw.startswith(("{", "[")):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            value = raw
    if not isinstance(value, dict):
        return f"{tool}\n{raw[:1400]}"
    ok = value.get("ok")
    if tool == "read_file" and "content" in value:
        content = str(value.get("content") or "")
        return f"{tool} · {'读取成功' if ok is not False else '读取失败'}\n{content[:1400]}"
    if tool == "run_command":
        stdout = str(value.get("stdout") or "").strip()
        stderr = str(value.get("stderr") or "").strip()
        parts = [f"{tool} · exit={value.get('returncode', value.get('exit_code', '-'))}"]
        if stdout:
            parts.append(f"stdout\n{stdout[:900]}")
        if stderr:
            parts.append(f"stderr\n{stderr[:500]}")
        if value.get("error"):
            parts.append(f"error\n{value['error']}")
        return "\n".join(parts)
    if tool in {"list_dir", "list_files"} and isinstance(value.get("entries"), list):
        names = [
            str(item.get("name", item)) if isinstance(item, dict) else str(item)
            for item in value["entries"]
        ]
        return f"{tool} · {'成功' if ok is not False else '失败'}\n" + "\n".join(names[:80])
    if tool in {"write_file", "replace_in_file"}:
        path = value.get("path") or value.get("file") or "file"
        size = value.get("bytes") or value.get("size")
        suffix = f" · {size} bytes" if size is not None else ""
        return f"{tool} · {'成功' if ok is not False else '失败'}\n{path}{suffix}"
    summary_keys = ("path", "bytes", "returncode", "exit_code", "error", "message")
    summary = [f"{key}={value[key]}" for key in summary_keys if key in value]
    if "content" in value:
        summary.append(str(value.get("content") or "")[:1100])
    return f"{tool} · {'成功' if ok is not False else '失败'}\n" + "\n".join(summary or [raw[:1200]])


def _proposal_conversation(run_dir: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    proposal_paths = list((run_dir / "harness_proposals").glob("epoch_*.json"))
    proposal_paths.extend(run_dir.glob("harness_self_evolution_plan_*.json"))
    for path in sorted(proposal_paths):
        record = _safe_read_json(path)
        if not record:
            continue
        epoch = record.get("epoch", "?")
        prefix = f"hpa:{path}:{path.stat().st_mtime_ns}"
        status = str(record.get("status") or "working")
        events.append({
            "id": f"{prefix}:status",
            "role": "hpa",
            "kind": "hpa_status",
            "title": "HPA",
            "text": f"epoch {epoch} · {status}",
            "case": "",
            "source": str(path.relative_to(run_dir)),
        })
        gradient = record.get("gradient") or {}
        if isinstance(gradient, dict) and gradient.get("diagnosis"):
            events.append({
                "id": f"{prefix}:diagnosis",
                "role": "hpa",
                "kind": "hpa_diagnosis",
                "title": "HPA · Diagnosis",
                "text": str(gradient["diagnosis"]),
                "case": "",
                "source": str(path.relative_to(run_dir)),
            })
        shortlist = record.get("shortlist") or []
        if shortlist:
            events.append({
                "id": f"{prefix}:shortlist",
                "role": "hpa",
                "kind": "hpa_shortlist",
                "title": "HPA · Shortlist",
                "text": "候选元素：" + "、".join(str(item) for item in shortlist),
                "case": "",
                "source": str(path.relative_to(run_dir)),
            })
        disclosed = record.get("disclosed_elements") or []
        if disclosed:
            ids = [
                str(item.get("id") or item.get("element_id"))
                for item in disclosed
                if isinstance(item, dict)
            ]
            events.append({
                "id": f"{prefix}:disclosed",
                "role": "hpa",
                "kind": "hpa_disclosure",
                "title": "HPA · Inspect",
                "text": "已展开：" + "、".join(ids),
                "case": "",
                "source": str(path.relative_to(run_dir)),
            })
        selected = record.get("selected") or {}
        if isinstance(selected, dict) and selected:
            events.append({
                "id": f"{prefix}:selected",
                "role": "hpa",
                "kind": "hpa_selection",
                "title": "HPA · Selection",
                "text": f"选择 {selected.get('element_id', selected.get('id', 'unknown'))} · "
                f"{selected.get('category', 'element')}",
                "case": "",
                "source": str(path.relative_to(run_dir)),
            })
        errors = record.get("stage_errors") or {}
        for stage, values in errors.items():
            for index, error in enumerate(values or []):
                events.append({
                    "id": f"{prefix}:error:{stage}:{index}",
                    "role": "hpa",
                    "kind": "hpa_error",
                    "title": f"HPA · {stage} retry",
                    "text": str(error),
                    "case": "",
                    "source": str(path.relative_to(run_dir)),
                })
    return events


def _build_conversation(run_dir: Path, limit: int = 180) -> list[dict[str, Any]]:
    """Convert persisted supervisor/backend activity into chat-like audit events."""
    paths = [run_dir / "supervisor.log"]
    paths.extend(sorted(run_dir.glob("**/backend.log")))
    events: list[dict[str, Any]] = []
    for path in paths:
        if not path.is_file():
            continue
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        source = "supervisor" if path.name == "supervisor.log" else "GOA"
        case_ref = path.parent.relative_to(run_dir).as_posix() if path.parent != run_dir else ""
        for index, line in enumerate(lines):
            text = line.strip()
            if not text:
                continue
            role = "system"
            kind = "event"
            title = source
            body = text
            if "[chat_agent] turn " in text:
                role = "agent"
                kind = "turn"
                title = "GOA"
                body = text.split("[chat_agent] ", 1)[1]
            elif "[chat_agent] assistant_message: " in text:
                role = "agent"
                kind = "assistant_message"
                title = "GOA"
                body = text.split("[chat_agent] assistant_message: ", 1)[1]
                try:
                    body = json.loads(body)
                except json.JSONDecodeError:
                    pass
            elif "[chat_agent] tool_call: " in text:
                role = "tool"
                kind = "tool_call"
                title = "GOA → Tool"
                body = text.split("[chat_agent] tool_call: ", 1)[1]
            elif "[chat_agent] tool_result: " in text:
                role = "tool_result"
                kind = "tool_result"
                title = "Tool result"
                body = text.split("[chat_agent] tool_result: ", 1)[1]
                try:
                    value = json.loads(body)
                    body = _format_tool_result(
                        str(value.get("tool", "tool")),
                        value.get("content", ""),
                    )
                except json.JSONDecodeError:
                    pass
            elif "[chat_agent] " in text:
                role = "agent"
                kind = "agent_event"
                title = "GOA"
                body = text.split("[chat_agent] ", 1)[1]
            elif text.startswith("[gcbench_l4_backend]"):
                role = "backend"
                kind = "backend"
                title = "Backend"
                body = text.split("] ", 1)[1] if "] " in text else text
            elif text.startswith("[epoch ") or text.startswith("[supervisor]"):
                role = "supervisor"
                kind = "supervisor"
                title = "Supervisor"
                body = text
            else:
                continue
            events.append({
                "id": f"{path}:{index}",
                "role": role,
                "kind": kind,
                "title": title,
                "text": body,
                "case": case_ref,
                "source": str(path.relative_to(run_dir)),
            })
    events.extend(_proposal_conversation(run_dir))
    return events[-limit:]


def _safe_read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = read_json(path)
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _latest_file(paths: list[Path]) -> Path | None:
    existing = [path for path in paths if path.is_file()]
    if not existing:
        return None
    return max(existing, key=lambda item: item.stat().st_mtime)


def _epoch_from_name(path: Path) -> int | None:
    stem = path.stem
    for token in stem.split("_"):
        if token.isdigit():
            return int(token)
    return None


def _discover_latest_epoch(run_dir: Path) -> int | None:
    plan_epochs = [_epoch_from_name(path) for path in run_dir.glob("harness_self_evolution_plan_*.json")]
    validation_epochs = [_epoch_from_name(path) for path in run_dir.glob("harness_rubric_validation_*.json")]
    archive = _safe_read_json(run_dir / "harness_archive" / "epochs.json")
    archive_epochs = []
    if archive:
        for item in archive.get("items", []):
            try:
                archive_epochs.append(int(item.get("epoch")))
            except Exception:
                pass
    epochs = [item for item in (*plan_epochs, *validation_epochs, *archive_epochs) if item is not None]
    return max(epochs) if epochs else None


def _phase_label(heartbeat: dict[str, Any] | None, plan: dict[str, Any] | None, validation: dict[str, Any] | None) -> str:
    if heartbeat:
        phase = str(heartbeat.get("phase") or "")
        if phase.startswith("epoch_"):
            return "GOA running"
        if phase.startswith("stopped"):
            return "idle"
        return phase or "running"
    if validation:
        return "verification"
    if plan:
        return "proposal"
    return "idle"


def _score_summary(validation: dict[str, Any] | None) -> dict[str, Any]:
    if not validation:
        return {"accepted": None, "reasons": [], "case_count": 0, "hard_ok": None, "soft_ok": None}
    case_results = validation.get("case_results") or []
    hard_ok = validation.get("infrastructure_ok")
    accepted = validation.get("accepted")
    reasons = list(validation.get("reasons", []))
    parent_soft = sum(
        float((item.get("parent", {}) or {}).get("soft_total", 0.0))
        for item in case_results
        if isinstance(item, dict)
    )
    candidate_soft = sum(
        float((item.get("candidate", {}) or {}).get("soft_total", 0.0))
        for item in case_results
        if isinstance(item, dict)
    )
    return {
        "accepted": accepted,
        "reasons": reasons,
        "case_count": len(case_results),
        "hard_ok": hard_ok,
        "soft_ok": candidate_soft + 1e-9 >= parent_soft if case_results else None,
        "parent_soft": parent_soft,
        "candidate_soft": candidate_soft,
    }


def _build_trace(run_dir: Path, latest_epoch: int | None, heartbeat: dict[str, Any] | None, plan: dict[str, Any] | None, validation: dict[str, Any] | None) -> list[dict[str, str]]:
    trace: list[dict[str, str]] = []
    if heartbeat:
        trace.append({
            "stage": "GOA",
            "title": f"Epoch {heartbeat.get('current_epoch', latest_epoch or '-')}",
            "text": f"phase={heartbeat.get('phase', 'running')} case={heartbeat.get('case_id') or 'n/a'}",
        })
    if plan:
        gradient = plan.get("gradient") or {}
        trace.append({
            "stage": "Harness proposal",
            "title": f"Candidate {plan.get('candidate_harness_id', '')[:12]}",
            "text": str(gradient.get("diagnosis") or "proposal in progress"),
        })
        shortlist = plan.get("disclosed_elements") or []
        if shortlist:
            names = ", ".join(
                str(item.get("id", "")) for item in shortlist[:5] if isinstance(item, dict)
            )
            trace.append({
                "stage": "Proposal shortlist",
                "title": "Visible elements",
                "text": names or "shortlist pending",
            })
    if validation:
        summary = _score_summary(validation)
        trace.append({
            "stage": "Verification",
            "title": "Rubric check",
            "text": f"accepted={summary['accepted']} cases={summary['case_count']} reasons={'; '.join(summary['reasons'][:2]) or 'none'}",
        })
    if latest_epoch is not None:
        trace.append({
            "stage": "Next task",
            "title": "Loop advance",
            "text": f"ready for epoch {latest_epoch + 1}",
        })
    return trace


def _build_hga_state(run_dir: Path) -> dict[str, Any]:
    library_dir = run_dir / "outer_element_library"
    if not library_dir.is_dir():
        return {
            "present": False,
            "status": "idle",
            "message": "outer element library not initialized yet",
        }

    epochs_dir = library_dir / "epochs"
    epoch_files = sorted(epochs_dir.glob("epoch_*.json")) if epochs_dir.is_dir() else []
    latest_epoch_file = _latest_file(epoch_files)
    latest_record = _safe_read_json(latest_epoch_file) if latest_epoch_file else None
    catalog = _safe_read_json(library_dir / "catalog.json") or {}
    stats = _safe_read_json(library_dir / "element_stats.json") or {}
    exposure_rows: list[dict[str, Any]] = []
    stats_items = stats.get("items", {}) if isinstance(stats, dict) else {}
    if catalog:
        items = catalog.get("items", []) or []
        for item in items[:6]:
            if not isinstance(item, dict):
                continue
            element_id = str(item.get("element_id") or item.get("id") or "")
            category = str(item.get("category") or "")
            stat = (
                stats_items.get(f"{category}:{element_id}")
                or stats_items.get(element_id)
                or {}
            )
            exposure_rows.append({
                "id": element_id,
                "category": category,
                "tags": item.get("tags", []),
                "usage": stat,
            })
    latest_update = (latest_record or {}).get("update") or {}
    plan = (latest_record or {}).get("plan") or {}
    operations = plan.get("operations") if isinstance(plan, dict) else []
    additions = plan.get("additions") if isinstance(plan, dict) else []
    status = str((latest_record or {}).get("status") or "idle")
    return {
        "present": True,
        "status": status,
        "epoch": (latest_record or {}).get("epoch"),
        "revision_before": (latest_record or {}).get("revision_before"),
        "revision_after": (latest_record or {}).get("revision_after")
        or (latest_update.get("revision_after") if isinstance(latest_update, dict) else None),
        "revision": (latest_record or {}).get("revision_after") or (catalog.get("revision") if isinstance(catalog, dict) else None),
        "catalog_size": len(catalog.get("items", [])) if isinstance(catalog, dict) else 0,
        "shortlist": (latest_record or {}).get("shortlist") or [],
        "disclosed_elements": (latest_record or {}).get("disclosed_elements") or [],
        "plan": plan,
        "operations": operations if isinstance(operations, list) else [],
        "additions": additions if isinstance(additions, list) else [],
        "update": latest_update,
        "current_inner_element_ids": (latest_record or {}).get("current_inner_element_ids") or [],
        "exposure_rows": exposure_rows,
        "error": (latest_record or {}).get("error")
        or (latest_update.get("error") if isinstance(latest_update, dict) else None),
        "message": (
            latest_update.get("status")
            or (latest_record or {}).get("status")
            or "outer library idle"
        ),
        "latest_record": latest_record,
    }


def _build_rubric_rows(validation: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not validation:
        return []
    rows: list[dict[str, Any]] = []
    for case in validation.get("case_results", []):
        if not isinstance(case, dict):
            continue
        parent = case.get("parent", {}) or {}
        candidate = case.get("candidate", {}) or {}
        hard_parent = parent.get("hard", {}) or {}
        hard_candidate = candidate.get("hard", {}) or {}
        soft_parent = parent.get("soft", {}) or {}
        soft_candidate = candidate.get("soft", {}) or {}
        rows.append({
            "case_id": case.get("case_id", ""),
            "passed": case.get("passed"),
            "parent_hard": hard_parent,
            "candidate_hard": hard_candidate,
            "parent_soft": soft_parent,
            "candidate_soft": soft_candidate,
            "parent_soft_total": parent.get("soft_total"),
            "candidate_soft_total": candidate.get("soft_total"),
            "reasons": case.get("reasons", []),
        })
    return rows


def _build_plan_view(run_dir: Path, latest_epoch: int | None) -> dict[str, Any] | None:
    if latest_epoch is None:
        return None
    plan = _safe_read_json(run_dir / f"harness_self_evolution_plan_{latest_epoch:03d}.json")
    if not plan:
        return None
    validation = _safe_read_json(run_dir / f"harness_rubric_validation_{latest_epoch:03d}.json")
    return {
        "epoch": latest_epoch,
        "candidate_harness_id": plan.get("candidate_harness_id"),
        "parent_harness_id": plan.get("parent_harness_id"),
        "gradient": plan.get("gradient") or {},
        "shortlist": plan.get("shortlist") or plan.get("disclosed_elements") or [],
        "disclosed_elements": plan.get("disclosed_elements") or [],
        "stage_attempts": plan.get("stage_attempts") or {},
        "stage_errors": plan.get("stage_errors") or {},
        "selected": plan.get("selected"),
        "validation": validation,
    }


def _build_run_state(meta: dict[str, Any]) -> dict[str, Any]:
    run_dir = Path(str(meta["run_dir"]))
    heartbeat = _safe_read_json(run_dir / ".supervisor_heartbeat.json")
    pid_payload = _safe_read_json(run_dir / ".supervisor.pid")
    process_alive = _process_alive(int(meta.get("pid", 0) or 0))
    latest_epoch = _discover_latest_epoch(run_dir)
    plan_view = _build_plan_view(run_dir, latest_epoch)
    validation = plan_view.get("validation") if plan_view else None
    status = str(meta.get("status", "starting"))
    if pid_payload and heartbeat:
        status = str(heartbeat.get("phase") or status)
    if not process_alive and status == "running":
        status = "failed" if _tail_lines(run_dir / "supervisor.log", 8) else "stopped"
    trace = _build_trace(run_dir, latest_epoch, heartbeat, plan_view, validation)
    rubric_rows = _build_rubric_rows(validation)
    log_path = run_dir / "supervisor.log"
    state = {
        "active": True,
        "run": meta,
        "process": {
            "pid": meta.get("pid"),
            "alive": process_alive,
            "started_at": meta.get("started_at"),
            "ended_at": meta.get("ended_at"),
        },
        "heartbeat": heartbeat,
        "status": status,
        "latest_epoch": latest_epoch,
        "loop_progress": _loop_progress(meta),
        "trace": trace,
        "plan": plan_view,
        "hga": _build_hga_state(run_dir),
        "verification": {
            "summary": _score_summary(validation),
            "rows": rubric_rows,
            "raw": validation,
        },
        "log_tail": _tail_lines(log_path, 160),
        "conversation": _build_conversation(run_dir),
        "archive": _safe_read_json(run_dir / "harness_archive" / "epochs.json"),
        "failures": _safe_read_json(run_dir / "epoch_failures.json"),
        "retry_state": _safe_read_json(run_dir / "epoch_retry_state.json"),
        "updated_at": utc_now(),
    }
    return state


def _loop_progress(meta: dict[str, Any]) -> dict[str, Any]:
    started_at = meta.get("started_at")
    duration_hours = float(meta.get("duration_hours", 24))
    deadline_at = meta.get("deadline_at")
    elapsed_seconds = 0.0
    percent = 0.0
    if started_at:
        try:
            started = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
            elapsed_seconds = max(0.0, (datetime.now(timezone.utc) - started).total_seconds())
            percent = min(100.0, elapsed_seconds / max(1.0, duration_hours * 3600.0) * 100.0)
        except Exception:
            pass
    return {
        "duration_hours": duration_hours,
        "elapsed_hours": round(elapsed_seconds / 3600.0, 2),
        "percent": round(percent, 1),
        "deadline_at": deadline_at,
    }


def _process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        result = subprocess.run(
            ["ps", "-o", "stat=", "-p", str(pid)],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        state = result.stdout.strip()
        return bool(state) and not state.startswith("Z")
    except (OSError, subprocess.SubprocessError):
        return True


def _dashboard_config(source: Path, run_dir: Path) -> Path:
    """Select a compatible config without mutating repository presets."""
    produced = source.with_name(f"{source.stem}_produce{source.suffix}")
    selected = produced if produced.is_file() else source
    payload = read_json(selected)
    arm = str((payload.get("experiment") or {}).get("arm", ""))
    evolution = payload.get("evolution") or {}
    if arm in {"L4_agent", "L4_agent_no_harness_evolve"} and int(
        evolution.get("max_generations", 1)
    ) != 1:
        payload.setdefault("evolution", {})["max_generations"] = 1
        selected = run_dir / "dashboard_config.json"
        atomic_write_json(selected, payload)
    return selected


@dataclass
class LaunchResult:
    ok: bool
    message: str
    run_dir: Path | None = None


class DashboardManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None

    def active_meta(self) -> dict[str, Any] | None:
        return _safe_read_json(ACTIVE_META)

    def _mark_active(self, meta: dict[str, Any]) -> None:
        RUNS_ROOT.mkdir(parents=True, exist_ok=True)
        atomic_write_json(ACTIVE_META, meta)

    def _clear_active(self) -> None:
        if ACTIVE_META.is_file():
            ACTIVE_META.unlink()

    def start(self, *, bench: str, model: str, max_epochs: int, duration_hours: float, cases: int) -> LaunchResult:
        with self._lock:
            active = self.active_meta()
            if active and _process_alive(int(active.get("pid", 0) or 0)):
                return LaunchResult(False, "an experiment is already running")
            preset = PRESETS.get(bench)
            if preset is None:
                return LaunchResult(False, f"unknown bench: {bench}")
            task_source = preset["task_source"]
            if not task_source.exists():
                return LaunchResult(False, f"missing task source: {task_source}")
            seed_artifact = preset["seed_artifact"]
            if not seed_artifact.exists():
                return LaunchResult(False, f"missing seed artifact: {seed_artifact}")

            run_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            run_dir = RUNS_ROOT / f"{run_stamp}-{bench}-{model}"
            run_dir.mkdir(parents=True, exist_ok=True)
            source_config = preset["config"].with_name(f"{bench}-L4_{model}.json")
            if not source_config.is_file():
                return LaunchResult(False, f"missing config: {source_config}")
            try:
                config = _dashboard_config(source_config, run_dir)
                AppConfig.load(config)
            except Exception as exc:
                return LaunchResult(False, f"invalid config {source_config.name}: {exc}")
            log_path = run_dir / "supervisor.log"
            cmd = [
                sys.executable,
                "-u",
                "-m",
                "game_loop",
                "harness-self-supervise",
                "--outer-dir",
                str(run_dir),
                "--config",
                str(config),
                "--task-source",
                str(task_source),
                "--seed-artifact",
                str(seed_artifact),
                "--max-epochs",
                str(max_epochs),
                "--cases",
                str(cases),
                "--heartbeat-seconds",
                "10",
                "--run-id-prefix",
                "goa",
            ]
            env = dict(os.environ)
            env["PYTHONPATH"] = str(ROOT)
            env["PYTHONUNBUFFERED"] = "1"
            meta = {
                "bench": bench,
                "model": model,
                "status": "starting",
                "started_at": utc_now(),
                "duration_hours": duration_hours,
                "deadline_at": _deadline_iso(duration_hours),
                "max_epochs": max_epochs,
                "cases": cases,
                "run_dir": str(run_dir),
                "config": str(config),
                "source_config": str(source_config),
                "task_source": str(task_source),
                "seed_artifact": str(seed_artifact),
                "command": cmd,
            }
            atomic_write_json(run_dir / "dashboard_meta.json", meta)
            self._mark_active(meta)
            with open(log_path, "a", encoding="utf-8", buffering=1) as log_handle:
                proc = subprocess.Popen(
                    cmd,
                    cwd=ROOT,
                    env=env,
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    text=True,
                )
            meta["pid"] = proc.pid
            meta["status"] = "running"
            atomic_write_json(run_dir / "dashboard_meta.json", meta)
            self._mark_active(meta)
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(duration_hours * 3600.0, self._stop_due_to_deadline)
            self._timer.daemon = True
            self._timer.start()
            return LaunchResult(True, "experiment started", run_dir)

    def _stop_due_to_deadline(self) -> None:
        active = self.active_meta()
        if not active:
            return
        self.stop(run_dir=Path(str(active["run_dir"])), reason="deadline")

    def stop(self, *, run_dir: Path | None = None, reason: str = "user") -> LaunchResult:
        with self._lock:
            meta = self.active_meta()
            if not meta:
                return LaunchResult(False, "no active experiment")
            active_run_dir = Path(str(meta["run_dir"]))
            if run_dir is not None and active_run_dir.resolve() != run_dir.resolve():
                return LaunchResult(False, "the requested run is not active")
            pid = int(meta.get("pid", 0) or 0)
            if pid > 0:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGTERM)
                except ProcessLookupError:
                    pass
                except Exception:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except Exception:
                        pass
            meta["status"] = f"stopped:{reason}"
            meta["ended_at"] = utc_now()
            atomic_write_json(active_run_dir / "dashboard_meta.json", meta)
            self._clear_active()
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            return LaunchResult(True, "experiment stop requested", active_run_dir)

    def build_state(self) -> dict[str, Any]:
        active = self.active_meta()
        if not active:
            return {
                "active": False,
                "presets": _presets_payload(),
                "models": MODELS,
                "updated_at": utc_now(),
            }
        run_dir = Path(str(active["run_dir"]))
        if not run_dir.exists():
            return {
                "active": False,
                "presets": _presets_payload(),
                "models": MODELS,
                "updated_at": utc_now(),
                "error": "active run directory is missing",
            }
        payload = _build_run_state(active)
        payload["presets"] = _presets_payload()
        payload["models"] = MODELS
        payload["bench_config"] = _preset_descriptor(str(active.get("bench", "")), str(active.get("model", "")))
        return payload


def _deadline_iso(duration_hours: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=duration_hours)).isoformat().replace("+00:00", "Z")


def _presets_payload() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for bench, preset in PRESETS.items():
        rows.append({
            "bench": bench,
            "config": str(preset["config"]),
            "task_source": str(preset["task_source"]),
            "seed_artifact": str(preset["seed_artifact"]),
        })
    return rows


def _preset_descriptor(bench: str, model: str) -> dict[str, str]:
    preset = PRESETS.get(bench)
    if not preset:
        return {}
    config = preset["config"].with_name(f"{bench}-L4_{model}.json")
    return {
        "config": str(config),
        "task_source": str(preset["task_source"]),
        "seed_artifact": str(preset["seed_artifact"]),
    }


def _read_request_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    size = int(handler.headers.get("Content-Length", "0") or 0)
    if size <= 0:
        return {}
    raw = handler.rfile.read(size)
    if not raw:
        return {}
    payload = json.loads(raw.decode("utf-8"))
    return payload if isinstance(payload, dict) else {}


def _serve_file(handler: BaseHTTPRequestHandler, path: Path) -> None:
    if not path.is_file():
        handler.send_error(HTTPStatus.NOT_FOUND)
        return
    content_type = "text/plain; charset=utf-8"
    if path.suffix == ".html":
        content_type = "text/html; charset=utf-8"
    elif path.suffix == ".css":
        content_type = "text/css; charset=utf-8"
    elif path.suffix == ".js":
        content_type = "application/javascript; charset=utf-8"
    elif path.suffix == ".svg":
        content_type = "image/svg+xml"
    elif path.suffix == ".json":
        content_type = "application/json; charset=utf-8"
    handler.send_response(HTTPStatus.OK)
    handler.send_header("Content-Type", content_type)
    handler.end_headers()
    handler.wfile.write(path.read_bytes())


class DashboardRequestHandler(BaseHTTPRequestHandler):
    manager = DashboardManager()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in {"/", "/index.html"}:
            _serve_file(self, DASHBOARD_DIR / "index.html")
            return
        if parsed.path == "/styles.css":
            _serve_file(self, DASHBOARD_DIR / "styles.css")
            return
        if parsed.path == "/app.js":
            _serve_file(self, DASHBOARD_DIR / "app.js")
            return
        if parsed.path == "/api/state":
            status, payload = _json_response(self.manager.build_state())
            self._send_json(status, payload)
            return
        if parsed.path == "/api/presets":
            status, payload = _json_response({
                "models": MODELS,
                "presets": _presets_payload(),
            })
            self._send_json(status, payload)
            return
        if parsed.path == "/api/health":
            status, payload = _json_response({"status": "ok"})
            self._send_json(status, payload)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/start":
            payload = _read_request_json(self)
            bench = str(payload.get("bench", "gcbench"))
            model = str(payload.get("model", "kimi"))
            max_epochs = int(payload.get("max_epochs", 200))
            duration_hours = float(payload.get("duration_hours", 24))
            cases = int(payload.get("cases", 3))
            result = self.manager.start(
                bench=bench,
                model=model,
                max_epochs=max_epochs,
                duration_hours=duration_hours,
                cases=cases,
            )
            self._send_json(*_json_response({
                "ok": result.ok,
                "message": result.message,
                "run_dir": None if result.run_dir is None else str(result.run_dir),
            }, 200 if result.ok else 400))
            return
        if parsed.path == "/api/stop":
            result = self.manager.stop()
            self._send_json(*_json_response({
                "ok": result.ok,
                "message": result.message,
                "run_dir": None if result.run_dir is None else str(result.run_dir),
            }, 200 if result.ok else 400))
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def _send_json(self, status: int, payload: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        pass


def run_server(*, host: str = "127.0.0.1", port: int = 8765) -> None:
    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((host, port), DashboardRequestHandler)
    print(f"[dashboard] serving on http://{host}:{port}")
    print(f"[dashboard] workspace={ROOT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[dashboard] shutting down")
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="game_loop dashboard-server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    run_server(host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
