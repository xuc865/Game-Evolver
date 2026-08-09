from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

from game_loop.experiment_watchdog import (
    clear_stale_loop_locks,
    probe_experiment_health,
    run_watchdog_tick,
)


def test_clear_stale_loop_locks_removes_dead_owner(tmp_path: Path):
    run_dir = tmp_path / "admission_runs/e001-01/parent"
    lock_dir = run_dir / ".loop.lock"
    lock_dir.mkdir(parents=True)
    owner = lock_dir / "owner.json"
    owner.write_text(json.dumps({"pid": 99999999, "at": "test"}) + "\n", encoding="utf-8")

    cleared = clear_stale_loop_locks(tmp_path / "admission_runs")
    assert len(cleared) == 1
    assert not lock_dir.exists()


def test_clear_stale_loop_locks_keeps_live_owner(tmp_path: Path):
    run_dir = tmp_path / "admission_runs/e001-01/parent"
    lock_dir = run_dir / ".loop.lock"
    lock_dir.mkdir(parents=True)
    owner = lock_dir / "owner.json"
    owner.write_text(json.dumps({"pid": os.getpid(), "at": "test"}) + "\n", encoding="utf-8")

    cleared = clear_stale_loop_locks(tmp_path / "admission_runs")
    assert cleared == []
    assert lock_dir.is_dir()


def test_watchdog_tick_writes_status(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "start_supervisor.sh").write_text("#!/bin/bash\nexit 0\n", encoding="utf-8")
    (run_dir / "start_supervisor.sh").chmod(0o755)
    status_path = run_dir / ".watchdog_status.json"
    report = run_watchdog_tick(run_dir=run_dir, start_script=run_dir / "start_supervisor.sh")
    assert "health_before" in report
    assert report["health_before"]["experiment_active"] is False


def test_probe_prefers_business_supervisor_pid_and_keeps_launcher_state(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / ".supervisor.pid").write_text(
        json.dumps({"pid": os.getpid()}) + "\n",
        encoding="utf-8",
    )
    (run_dir / "supervisor.pid").write_text("99999999\n", encoding="utf-8")

    health = probe_experiment_health(run_dir)

    assert health.supervisor_pid == os.getpid()
    assert health.supervisor_alive is True
    assert health.launcher_pid == 99999999
    assert health.launcher_alive is False
    assert health.orchestrator_active is True


def test_probe_uses_current_heartbeat_pid(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / ".supervisor.pid").write_text(
        json.dumps({"pid": 99999999}) + "\n",
        encoding="utf-8",
    )
    (run_dir / ".supervisor_heartbeat.json").write_text(
        json.dumps({"pid": os.getpid(), "updated_at": "2026-08-09T18:00:00+00:00"}) + "\n",
        encoding="utf-8",
    )

    health = probe_experiment_health(run_dir)

    assert health.supervisor_pid == os.getpid()
    assert health.supervisor_alive is True


def test_permission_denied_pid_probe_is_not_treated_as_dead(tmp_path: Path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / ".supervisor.pid").write_text(
        json.dumps({"pid": 1234}) + "\n",
        encoding="utf-8",
    )
    with patch("game_loop.experiment_watchdog.os.kill", side_effect=PermissionError):
        health = probe_experiment_health(run_dir)

    assert health.supervisor_alive is True
