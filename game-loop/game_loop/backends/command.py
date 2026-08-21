from __future__ import annotations

import os
import re
import signal
import subprocess
import time
from pathlib import Path

from game_loop.config import BackendConfig
from game_loop.core.models import BackendExecution, PreparedTask
from game_loop.runtime_profile_snapshot import materialize_runtime_profile
from game_loop.utils import atomic_write_json

SECRET_ASSIGNMENT = re.compile(r"(?i)([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=(.+)")


class CommandBackend:
    """Provider-neutral frozen agent command runner."""

    def __init__(self, config: BackendConfig):
        self.config = config

    def run(self, prepared: PreparedTask, candidate_dir: Path) -> BackendExecution:
        try:
            command = [part.format_map(prepared.command_context) for part in self.config.command]
        except KeyError as exc:
            raise ValueError(f"unknown command placeholder: {exc}") from exc
        log_path = candidate_dir / "backend.log"
        effective_profile: Path | None = None
        effective_profile_hash: str | None = None
        if self.config.runtime_profile_value is not None:
            effective_profile, effective_profile_hash = materialize_runtime_profile(
                profile=self.config.runtime_profile_value,
                assets=self.config.runtime_profile_assets,
                destination=(
                    candidate_dir
                    / "runtime_profile_snapshots"
                    / str(self.config.runtime_profile_hash)
                ),
            )
        atomic_write_json(candidate_dir / "backend_manifest.json", {
            "command": [_redact(part) for part in command],
            "cwd": str(self.config.cwd),
            "timeout_seconds": self.config.timeout_seconds,
            "inactivity_timeout_seconds": self.config.inactivity_timeout_seconds,
            "adapter": prepared.adapter_id,
            "runtime_profile": (
                None
                if self.config.runtime_profile is None
                else str(self.config.runtime_profile)
            ),
            "runtime_profile_hash": self.config.runtime_profile_hash,
            "runtime_profile_snapshot": (
                None if effective_profile is None else str(effective_profile)
            ),
            "runtime_profile_snapshot_hash": effective_profile_hash,
            "runtime_profile_assets": self.config.runtime_profile_assets,
        })
        error = None
        return_code = -1
        with log_path.open("wb") as log:
            env = {**os.environ, **self.config.env}
            if effective_profile is not None:
                env["GAME_LOOP_MAKER_RUNTIME_PROFILE"] = str(effective_profile)
                env["GAME_LOOP_MAKER_RUNTIME_PROFILE_HASH"] = str(
                    effective_profile_hash
                )
            for key in self.config.env:
                if SECRET_ASSIGNMENT.fullmatch(f"{key}=x") and key in os.environ:
                    env[key] = os.environ[key]
            process = subprocess.Popen(
                command,
                cwd=self.config.cwd,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            try:
                return_code, error = _wait_for_process(
                    process,
                    log_path=log_path,
                    timeout_seconds=self.config.timeout_seconds,
                    inactivity_timeout_seconds=self.config.inactivity_timeout_seconds,
                )
            except BaseException:
                _terminate_process_group(process)
                raise
        return BackendExecution(return_code, log_path, error)


def _wait_for_process(
    process: subprocess.Popen,
    *,
    log_path: Path,
    timeout_seconds: int,
    inactivity_timeout_seconds: int | None,
) -> tuple[int, str | None]:
    started = time.monotonic()
    last_progress = started
    last_size = -1
    while True:
        now = time.monotonic()
        try:
            size = log_path.stat().st_size
        except OSError:
            size = last_size
        if size != last_size:
            last_size = size
            last_progress = now

        if now - started >= timeout_seconds:
            error = f"backend timed out after {timeout_seconds}s"
            _terminate_process_group(process)
            return process.returncode if process.returncode is not None else -9, error
        if (
            inactivity_timeout_seconds is not None
            and now - last_progress >= inactivity_timeout_seconds
        ):
            error = (
                "backend produced no log progress for "
                f"{inactivity_timeout_seconds}s"
            )
            _terminate_process_group(process)
            return process.returncode if process.returncode is not None else -9, error
        try:
            return process.wait(timeout=1), None
        except subprocess.TimeoutExpired:
            pass


def _terminate_process_group(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except PermissionError:
        # The process may already have escaped/reparented or be owned by a
        # different session during operator-triggered restarts.  Treat cleanup
        # best-effort rather than turning a deliberate stop into an admission
        # infrastructure failure.
        try:
            process.terminate()
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired, PermissionError):
            pass
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            process.wait(timeout=5)
        except (subprocess.TimeoutExpired, PermissionError):
            pass


def _redact(value: str) -> str:
    match = SECRET_ASSIGNMENT.fullmatch(value)
    return f"{match.group(1)}=<redacted>" if match else value
