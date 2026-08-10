#!/usr/bin/env python3
"""Run or preflight four public benchmarks with a frozen epoch-0 harness."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.baselines.awesome_gamedev_skills import inspect_skills_source
from game_loop.benchmarks import load_adapter
from game_loop.config import AppConfig
from game_loop.core.harness import HarnessEvolutionEngine
from game_loop.utils import atomic_write_json
from scripts.gdbench_prepare_task import available_task_names


REPO_ROOT = ROOT.parent
GCBENCH = REPO_ROOT / "gcbench"
GDBENCH = ROOT / "third_party" / "gamedevbench"
SMOKE = ROOT / "experiments" / "smoke"
SEEDS = ROOT / "experiments" / "public_baseline_seeds"
DEFAULT_OUT = ROOT / ".smoke" / "public-baseline"


def _config_path(bench: str, model: str) -> Path:
    return ROOT / "experiments" / "configs-v4" / f"{bench}-L4_{model}.json"


def _task_and_seed(bench: str) -> tuple[Path, Path]:
    if bench == "gcbench":
        return (
            GCBENCH / "tasks" / "puzzle-sokoban-dungeon",
            ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold",
        )
    if bench == "gdbench":
        task_names = available_task_names(GDBENCH)
        if not task_names:
            raise FileNotFoundError("no GameDevBench task archives are installed")
        archive = GDBENCH / "tasks" / f"{task_names[0]}.zip"
        return archive, archive
    if bench == "vgamegym":
        return SMOKE / "vgamegym" / "public_task", SEEDS / "vgamegym"
    if bench == "verigame":
        return SMOKE / "verigame" / "public_task", SEEDS / "verigame"
    raise ValueError(f"unsupported benchmark: {bench}")


def _prepare_config(source: Path, destination: Path, *, awesome_skills: bool) -> AppConfig:
    value = json.loads(source.read_text(encoding="utf-8"))
    if awesome_skills:
        value.setdefault("backend", {}).setdefault("env", {})[
            "GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS"
        ] = "1"
    atomic_write_json(destination, value)
    return AppConfig.load(destination)


def _preflight_case(
    *,
    bench: str,
    model: str,
    output_root: Path,
    awesome_skills: bool,
) -> dict[str, object]:
    source_config = _config_path(bench, model)
    task_source, seed_artifact = _task_and_seed(bench)
    case_root = output_root / bench
    case_root.mkdir(parents=True, exist_ok=True)
    config = _prepare_config(
        source_config,
        case_root / "config.json",
        awesome_skills=awesome_skills,
    )
    if config.method.harness_evolution is None:
        raise ValueError(f"{source_config} has no L4 harness configuration")
    profile = HarnessEvolutionEngine(
        case_root / "outer", config.method.harness_evolution
    ).initialize()
    profile_path = case_root / "epoch_0_harness.json"
    atomic_write_json(profile_path, profile.to_dict())
    adapter = load_adapter(config.benchmark.adapter, config.benchmark.options)
    report = {
        "benchmark": bench,
        "config": str(source_config),
        "task_source": str(task_source),
        "seed_artifact": str(seed_artifact),
        "epoch": profile.generation,
        "harness_id": profile.harness_id,
        "adapter_doctor": adapter.doctor(),
        "task_source_exists": task_source.exists(),
        "seed_artifact_exists": seed_artifact.exists(),
        "awesome_skills": awesome_skills,
    }
    if awesome_skills:
        source = ROOT / "third_party" / "awesome-gamedev-agent-skills"
        report["awesome_skill_count"] = len(inspect_skills_source(source))
    return report


def run_smoke(*, model: str, output_root: Path, awesome_skills: bool, execute: bool) -> dict[str, object]:
    output_root = output_root.resolve()
    if output_root.exists():
        shutil.rmtree(output_root)
    cases: list[dict[str, object]] = []
    for bench in ("gcbench", "gdbench", "vgamegym", "verigame"):
        case = _preflight_case(
            bench=bench,
            model=model,
            output_root=output_root,
            awesome_skills=awesome_skills,
        )
        if execute:
            command = [
                sys.executable,
                "-m",
                "game_loop.cli",
                "harness-eval-public",
                "--config",
                str(output_root / bench / "config.json"),
                "--harness-profile",
                str(output_root / bench / "epoch_0_harness.json"),
                "--task-source",
                str(case["task_source"]),
                "--seed-artifact",
                str(case["seed_artifact"]),
                "--run-dir",
                str(output_root / bench / "episode"),
                "--run-id-prefix",
                "epoch0",
            ]
            completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
            case["execution_return_code"] = completed.returncode
            case["execution_stdout_tail"] = completed.stdout[-1000:]
            case["execution_stderr_tail"] = completed.stderr[-1000:]
        cases.append(case)
    payload = {
        "schema_version": "public-benchmark-epoch0-smoke-v1",
        "model": model,
        "awesome_skills": awesome_skills,
        "execute": execute,
        "cases": cases,
    }
    atomic_write_json(output_root / "report.json", payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="qwen3.6-27b")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--awesome-skills", action="store_true")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    payload = run_smoke(
        model=args.model,
        output_root=args.output_root,
        awesome_skills=args.awesome_skills,
        execute=args.execute,
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    complete = all(
        bool(case["task_source_exists"])
        and bool(case["seed_artifact_exists"])
        and bool(case["adapter_doctor"].get("root_exists", True))
        for case in payload["cases"]
    )
    if args.execute:
        complete = complete and all(case.get("execution_return_code") == 0 for case in payload["cases"])
    return 0 if complete else 1


if __name__ == "__main__":
    raise SystemExit(main())
