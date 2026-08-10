from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from game_loop.utils import read_json, utc_now


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        # Sandboxed macOS sessions may deny process inspection for a live
        # process. Permission denied is not evidence that the PID is stale.
        return True
    except (ProcessLookupError, OSError):
        return False


def clear_stale_loop_locks(root: Path) -> list[dict[str, Any]]:
    """Remove .loop.lock directories whose owner PID is no longer running."""
    cleared: list[dict[str, Any]] = []
    if not root.is_dir():
        return cleared
    for owner_path in root.rglob(".loop.lock/owner.json"):
        lock_dir = owner_path.parent
        run_dir = lock_dir.parent
        owner: dict[str, Any] = {}
        if owner_path.is_file():
            try:
                owner = read_json(owner_path)
            except (json.JSONDecodeError, OSError):
                owner = {}
        pid = owner.get("pid")
        alive = isinstance(pid, int) and _pid_alive(pid)
        if alive:
            continue
        if owner_path.exists():
            owner_path.unlink()
        if lock_dir.exists():
            lock_dir.rmdir()
        cleared.append(
            {
                "run_dir": str(run_dir.resolve()),
                "owner": owner,
                "reason": "owner pid not running",
            }
        )
    return cleared


def _read_pid_file(path: Path) -> int | None:
    if not path.is_file():
        return None
    raw = path.read_text(encoding="utf-8").strip()
    if not raw.isdigit():
        return None
    return int(raw)


def _read_json_pid_file(path: Path) -> int | None:
    if not path.is_file():
        return None
    try:
        payload = read_json(path)
    except (json.JSONDecodeError, OSError):
        return None
    pid = payload.get("pid") if isinstance(payload, dict) else None
    return pid if isinstance(pid, int) and pid > 0 else None


def _pgrep(pattern: str) -> list[int]:
    try:
        completed = subprocess.run(
            ["pgrep", "-f", pattern],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return []
    if completed.returncode != 0:
        return []
    pids: list[int] = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    return pids


def _process_belongs_to_run(pid: int | None, run_dir: Path, *markers: str) -> bool:
    """Require a live PID to actually be the current run's process."""
    if pid is None or not _pid_alive(pid):
        return False
    command = " ".join(_proc_args(pid))
    return str(run_dir) in command and all(marker in command for marker in markers)


@dataclass(frozen=True)
class ExperimentHealth:
    supervisor_pid: int | None
    supervisor_alive: bool
    launcher_pid: int | None
    launcher_alive: bool
    harness_supervise_pids: tuple[int, ...]
    worker_pids: tuple[int, ...]
    heartbeat_age_seconds: float | None
    heartbeat: dict[str, Any]

    @property
    def workers_active(self) -> bool:
        return bool(self.worker_pids)

    @property
    def orchestrator_active(self) -> bool:
        return (
            self.supervisor_alive
            or self.launcher_alive
            or bool(self.harness_supervise_pids)
        )

    @property
    def experiment_active(self) -> bool:
        return self.orchestrator_active or self.workers_active


def probe_experiment_health(run_dir: Path) -> ExperimentHealth:
    run_dir = run_dir.resolve()
    # The JSON pidfile belongs to the Python supervisor. The numeric pidfile
    # belongs to the retrying shell launcher and may outlive that process.
    launcher_pid = _read_pid_file(run_dir / "supervisor.pid")
    heartbeat: dict[str, Any] = {}
    heartbeat_path = run_dir / ".supervisor_heartbeat.json"
    heartbeat_age: float | None = None
    if heartbeat_path.is_file():
        try:
            heartbeat = read_json(heartbeat_path)
            updated = heartbeat.get("updated_at")
            if isinstance(updated, str):
                ts = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                heartbeat_age = (
                    datetime.now(timezone.utc) - ts.astimezone(timezone.utc)
                ).total_seconds()
        except (json.JSONDecodeError, ValueError, OSError):
            heartbeat_age = None

    heartbeat_pid = heartbeat.get("pid") if isinstance(heartbeat, dict) else None
    supervisor_pid = (
        heartbeat_pid
        if isinstance(heartbeat_pid, int) and heartbeat_pid > 0
        else _read_json_pid_file(run_dir / ".supervisor.pid")
    )

    run_token = str(run_dir)
    harness_supervise = tuple(
        pid
        for pid in _pgrep("game_loop.cli harness-self-supervise")
        if run_token in " ".join(_proc_args(pid))
    )
    worker_pids = tuple(
        pid
        for pid in (
            _pgrep("run_gcbench_l4_backend.sh")
            + _pgrep("game_loop.chat_agent")
            + _pgrep("gamecraft_bench.verifier")
        )
        if run_token in " ".join(_proc_args(pid))
    )
    return ExperimentHealth(
        supervisor_pid=supervisor_pid,
        supervisor_alive=_process_belongs_to_run(
            supervisor_pid, run_dir, "game_loop.cli", "harness-self-supervise"
        ),
        launcher_pid=launcher_pid,
        launcher_alive=_process_belongs_to_run(
            launcher_pid, run_dir, "start_supervisor.sh"
        ),
        harness_supervise_pids=harness_supervise,
        worker_pids=worker_pids,
        heartbeat_age_seconds=heartbeat_age,
        heartbeat=heartbeat,
    )


def _proc_args(pid: int) -> list[str]:
    try:
        completed = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return []
    if completed.returncode != 0:
        return []
    return completed.stdout.strip().split()


def _health_summary(health: ExperimentHealth) -> dict[str, Any]:
    return {
        "supervisor_alive": health.supervisor_alive,
        "supervisor_pid": health.supervisor_pid,
        "launcher_alive": health.launcher_alive,
        "launcher_pid": health.launcher_pid,
        "harness_supervise_pids": list(health.harness_supervise_pids),
        "worker_pids": list(health.worker_pids),
        "heartbeat_age_seconds": health.heartbeat_age_seconds,
        "heartbeat": health.heartbeat,
        "experiment_active": health.experiment_active,
    }


def ensure_supervisor(
    *,
    run_dir: Path,
    start_script: Path,
    stale_heartbeat_seconds: float = 180.0,
) -> dict[str, Any]:
    """Restart the experiment supervisor when orchestration appears stalled."""
    health = probe_experiment_health(run_dir)
    orchestrator_ok = health.orchestrator_active
    action = "none"

    if orchestrator_ok:
        stale = (
            not health.workers_active
            and health.heartbeat_age_seconds is not None
            and health.heartbeat_age_seconds > stale_heartbeat_seconds
            and not health.launcher_alive
            and not health.harness_supervise_pids
        )
        if not stale:
            return {
                "action": action,
                "health": _health_summary(health),
                "reason": "orchestrator active",
            }
        action = "restart_stale_heartbeat"
    else:
        action = "start_supervisor"

    if action == "none":
        return {"action": action, "health": _health_summary(health), "reason": "no action needed"}

    if not start_script.is_file():
        raise FileNotFoundError(f"start script not found: {start_script}")

    completed = subprocess.run(
        ["bash", str(start_script.resolve())],
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        "action": action,
        "health": _health_summary(health),
        "start_script": str(start_script.resolve()),
        "start_stdout": completed.stdout.strip()[-1000:],
        "start_stderr": completed.stderr.strip()[-1000:],
        "start_rc": completed.returncode,
    }


def run_watchdog_tick(
    *,
    run_dir: Path,
    start_script: Path | None = None,
    admission_root: Path | None = None,
    stale_heartbeat_seconds: float = 180.0,
) -> dict[str, Any]:
    run_dir = run_dir.resolve()
    admission_root = (admission_root or run_dir / "admission_runs").resolve()
    if start_script is None:
        start_script = run_dir / "start_supervisor.sh"

    cleared = clear_stale_loop_locks(admission_root)
    health = probe_experiment_health(run_dir)
    supervisor_action = ensure_supervisor(
        run_dir=run_dir,
        start_script=start_script,
        stale_heartbeat_seconds=stale_heartbeat_seconds,
    )
    health_after = probe_experiment_health(run_dir)
    return {
        "at": utc_now(),
        "run_dir": str(run_dir),
        "cleared_locks": cleared,
        "health_before": _health_summary(health),
        "supervisor_action": supervisor_action,
        "health_after": _health_summary(health_after),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Game-loop experiment watchdog tick")
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--start-script", type=Path)
    parser.add_argument("--admission-root", type=Path)
    parser.add_argument("--stale-heartbeat-seconds", type=float, default=180.0)
    parser.add_argument("--status-json", type=Path)
    args = parser.parse_args(argv)

    report = run_watchdog_tick(
        run_dir=args.run_dir,
        start_script=args.start_script,
        admission_root=args.admission_root,
        stale_heartbeat_seconds=args.stale_heartbeat_seconds,
    )
    if args.status_json is not None:
        args.status_json.parent.mkdir(parents=True, exist_ok=True)
        args.status_json.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
