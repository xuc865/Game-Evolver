from __future__ import annotations

import os
from pathlib import Path

from game_loop.config import GateConfig
from game_loop.core.models import GateResult


def common_gate(artifact: Path, config: GateConfig) -> GateResult:
    artifact = artifact.resolve()
    errors: list[str] = []
    warnings: list[str] = []
    file_count = 0
    total_bytes = 0
    suspicious: list[str] = []

    for root, _, files in os.walk(artifact):
        root_path = Path(root)
        for name in files:
            path = root_path / name
            if not path.is_file():
                continue
            file_count += 1
            try:
                total_bytes += path.stat().st_size
            except OSError as exc:
                errors.append(f"cannot stat {path.relative_to(artifact)}: {exc}")
                continue
            if config.fail_suspicious_references:
                relative = path.relative_to(artifact).as_posix()
                if ".." in relative.split("/"):
                    suspicious.append(relative)
                try:
                    if path.is_symlink():
                        target = os.readlink(path)
                        if target.startswith("/") or target.startswith(".."):
                            suspicious.append(relative)
                except OSError:
                    suspicious.append(relative)

    if file_count > config.max_files:
        errors.append(f"artifact exceeds max_files ({file_count} > {config.max_files})")
    if total_bytes > config.max_total_bytes:
        errors.append(
            f"artifact exceeds max_total_bytes ({total_bytes} > {config.max_total_bytes})"
        )
    if suspicious:
        errors.extend(f"suspicious reference: {item}" for item in sorted(set(suspicious)))

    return GateResult(
        passed=not errors,
        errors=errors,
        warnings=warnings,
        stats={"file_count": file_count, "total_bytes": total_bytes},
    )


def merge_gates(*gates: GateResult) -> GateResult:
    errors: list[str] = []
    warnings: list[str] = []
    stats: dict = {}
    passed = True
    for gate in gates:
        passed = passed and gate.passed
        errors.extend(gate.errors)
        warnings.extend(gate.warnings)
        stats.update(gate.stats)
    return GateResult(passed, errors, warnings, stats)
