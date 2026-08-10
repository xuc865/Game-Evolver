from __future__ import annotations

import os
import re
import signal
import subprocess
from pathlib import Path

from game_loop.config import BackendConfig
from game_loop.core.models import BackendExecution, PreparedTask
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
        atomic_write_json(candidate_dir / "backend_manifest.json", {
            "command": [_redact(part) for part in command],
            "cwd": str(self.config.cwd),
            "timeout_seconds": self.config.timeout_seconds,
            "adapter": prepared.adapter_id,
        })
        error = None
        return_code = -1
        with log_path.open("wb") as log:
            env = {**os.environ, **self.config.env}
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
                return_code = process.wait(timeout=self.config.timeout_seconds)
            except subprocess.TimeoutExpired:
                error = f"backend timed out after {self.config.timeout_seconds}s"
                _terminate_process_group(process)
                return_code = process.returncode if process.returncode is not None else -9
            except BaseException:
                _terminate_process_group(process)
                raise
        return BackendExecution(return_code, log_path, error)


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
