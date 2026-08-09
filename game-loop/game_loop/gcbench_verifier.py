from __future__ import annotations

import os
import subprocess
from pathlib import Path

from game_loop.core.models import EvaluationResult


def build_verifier_env(*, gcbench_root: Path, project_root: Path | None = None) -> dict[str, str]:
    """Environment for GameCraftBench local/docker verifier subprocesses."""
    project_root = project_root or Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.setdefault("GAMECRAFT_USE_LOCAL_VERIFIER", "1")
    env.setdefault("GAMECRAFT_ROOT", str(gcbench_root.resolve()))

    godot = (
        env.get("GAMECRAFT_BENCH_GODOT_BIN")
        or env.get("GODOT_EXEC_PATH")
        or env.get("GODOT_BIN")
    )
    setup_script = project_root / "scripts" / "setup_godot.sh"
    if not godot and setup_script.is_file():
        completed = subprocess.run(
            ["bash", str(setup_script)],
            capture_output=True,
            text=True,
            check=False,
        )
        godot = (completed.stdout or "").strip().splitlines()[-1] if completed.returncode == 0 else ""
    if godot:
        env["GAMECRAFT_BENCH_GODOT_BIN"] = godot
        env["GODOT_BIN"] = godot
        env["GODOT_EXEC_PATH"] = godot
        env["PATH"] = str(Path(godot).parent) + os.pathsep + env.get("PATH", "")

    env.setdefault("GAMECRAFT_BENCH_JUDGE", "openai")
    if env.get("DEEPSEEK_API_KEY") and not env.get("OPENAI_API_KEY"):
        env["OPENAI_API_KEY"] = env["DEEPSEEK_API_KEY"]
    if env.get("DEEPSEEK_API_BASE") and not env.get("OPENAI_BASE_URL"):
        env["OPENAI_BASE_URL"] = env["DEEPSEEK_API_BASE"]
    env.setdefault(
        "GAMECRAFT_BENCH_JUDGE_MODEL",
        env.get("DEEPSEEK_JUDGE_MODEL") or env.get("DEEPSEEK_MODEL") or "deepseek-v4-flash",
    )
    return env


def evaluate_seed_artifact(
    *,
    seed_artifact: Path,
    task_source: Path,
    gcbench_root: Path,
    output_dir: Path,
    project_root: Path | None = None,
) -> EvaluationResult:
    """Run the official local GameCraftBench verifier on a seed artifact."""
    from game_loop.benchmarks.gcbench import GameCraftBenchAdapter

    project_root = project_root or Path(__file__).resolve().parents[1]
    verifier_script = project_root / "scripts" / "gcbench_e2e" / "run_local_verifier.sh"
    task_id = task_source.resolve().name
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    env = build_verifier_env(gcbench_root=gcbench_root, project_root=project_root)

    completed = subprocess.run(
        [
            "bash",
            str(verifier_script),
            "--task",
            task_id,
            "--artifact",
            str(seed_artifact.resolve()),
            "--output",
            str(output_dir),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    breakdown_path = output_dir / "breakdown.json"
    adapter = GameCraftBenchAdapter({"root": str(gcbench_root.resolve())})
    if breakdown_path.is_file():
        return adapter.parse_evaluation(breakdown_path)

    tail = (completed.stderr or completed.stdout or "").strip()[-2000:]
    raise RuntimeError(
        "seed verifier did not produce breakdown.json "
        f"(rc={completed.returncode}): {tail or 'no output'}"
    )
