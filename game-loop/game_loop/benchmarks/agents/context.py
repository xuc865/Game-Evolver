from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def load_harness_context(path: str | Path | None = None) -> str:
    selected = str(path or os.environ.get("GAME_LOOP_HARNESS_CONTEXT", "")).strip()
    if not selected:
        return ""
    source = Path(selected).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"game-making harness context is missing: {source}")
    return source.read_text(encoding="utf-8").strip()


def compose_benchmark_instruction(
    benchmark_instruction: str,
    *,
    harness_context: str = "",
    benchmark_name: str,
) -> str:
    harness = harness_context.strip()
    if not harness:
        harness = "Inspect evidence, make the smallest effective change, and verify before finishing."
    return (
        f"You are the repository's game-making agent operating through the {benchmark_name} "
        "tool protocol. The benchmark shell supplies tools and observations, but you are the "
        "only decision-making agent. Follow the task exactly; do not edit evaluator files.\n\n"
        f"<evolved_harness>\n{harness}\n</evolved_harness>\n\n"
        f"<benchmark_task>\n{benchmark_instruction.strip()}\n</benchmark_task>"
    )


def write_harness_context(feedback: dict[str, Any], path: Path) -> Path:
    harness = feedback.get("agent_harness")
    rendered = (
        str(harness.get("rendered_instruction", "")).strip()
        if isinstance(harness, dict)
        else ""
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(rendered + ("\n" if rendered else ""), encoding="utf-8")
    return path.resolve()
