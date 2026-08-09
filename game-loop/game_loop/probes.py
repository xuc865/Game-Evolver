from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Protocol, Sequence

from game_loop.config import FixedProbeConfig
from game_loop.core.models import ProbeResult, ProbeSuiteResult
from game_loop.utils import atomic_write_json


class ProbeRunner(Protocol):
    def run_suite(
        self,
        probes: Sequence[FixedProbeConfig],
        *,
        context: dict[str, str],
        output_dir: Path,
        phase: str,
    ) -> ProbeSuiteResult: ...


class FixedCommandProbeRunner:
    def run_suite(
        self,
        probes: Sequence[FixedProbeConfig],
        *,
        context: dict[str, str],
        output_dir: Path,
        phase: str,
    ) -> ProbeSuiteResult:
        output_dir.mkdir(parents=True, exist_ok=True)
        results: list[ProbeResult] = []
        calls = 0
        for probe in probes:
            probe_dir = output_dir / probe.probe_id
            probe_dir.mkdir(parents=True, exist_ok=True)
            log_path = probe_dir / "probe.log"
            command = [_render(part, context) for part in probe.command]
            started = time.monotonic()
            status = "completed"
            passed: bool | None = None
            score: float | None = None
            return_code: int | None = None
            diagnostics: list[str] = []
            try:
                completed = subprocess.run(
                    command,
                    cwd=probe.cwd,
                    env={**os.environ, **probe.env},
                    capture_output=True,
                    text=True,
                    timeout=probe.timeout_seconds,
                    check=False,
                )
                calls += 1
                return_code = completed.returncode
                log_path.write_text(
                    (completed.stdout or "") + (completed.stderr or ""),
                    encoding="utf-8",
                )
                if probe.parser == "json_stdout":
                    payload = json.loads(completed.stdout or "{}")
                    passed = bool(payload.get("passed", False))
                    raw_score = payload.get("score")
                    score = None if raw_score is None else float(raw_score)
                    diagnostics = [str(item) for item in payload.get("diagnostics", [])]
                else:
                    passed = completed.returncode == 0
                    score = 1.0 if passed else 0.0
            except subprocess.TimeoutExpired:
                status = "timed_out"
                diagnostics = [f"probe timed out after {probe.timeout_seconds}s"]
            except Exception as exc:
                status = "failed"
                diagnostics = [str(exc)]
            results.append(
                ProbeResult(
                    probe_id=probe.probe_id,
                    status=status,
                    passed=passed,
                    score=score,
                    return_code=return_code,
                    duration_seconds=time.monotonic() - started,
                    log_path=str(log_path),
                    diagnostics=diagnostics,
                )
            )
        suite = ProbeSuiteResult(phase=phase, results=results, calls=calls)
        atomic_write_json(output_dir / "suite.json", suite.to_dict())
        return suite


def _render(template: str, context: dict[str, str]) -> str:
    rendered = template
    for key, value in context.items():
        rendered = rendered.replace(f"{{{key}}}", value)
    return rendered.replace("{{", "{").replace("}}", "}")
