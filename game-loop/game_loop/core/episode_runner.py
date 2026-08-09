from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from game_loop.config import AppConfig
from game_loop.core.harness import HarnessEpisodeOutcome, HarnessProfile, load_episode_outcome
from game_loop.utils import atomic_write_json


def run_frozen_harness_episode(
    *,
    case_id: str,
    case_dir: Path,
    harness: HarnessProfile,
    config: AppConfig,
    task_source: Path,
    seed_artifact: Path,
    seed_score: float,
    epoch: int,
    run_id_prefix: str,
    init_handler,
    evolve_handler,
) -> HarnessEpisodeOutcome:
    """Run one init+evolve episode with a frozen harness profile."""

    case_dir = case_dir.resolve()
    if case_dir.exists() and any(case_dir.iterdir()):
        state_path = case_dir / "state.json"
        should_wipe = True
        if state_path.is_file():
            status = str(json.loads(state_path.read_text(encoding="utf-8")).get("status", ""))
            if status in {"loop_ready_for_benchmark", "running", "completed", "paused_infrastructure"}:
                should_wipe = False
        if should_wipe:
            shutil.rmtree(case_dir)
    case_dir.mkdir(parents=True, exist_ok=True)

    profile_path = case_dir / "harness_profile.json"
    atomic_write_json(profile_path, harness.to_dict())
    config_path = case_dir / "config.json"
    atomic_write_json(config_path, _episode_config_dict(config))

    run_id = f"{run_id_prefix}{epoch:03d}_{case_id}"
    init_handler(
        argparse.Namespace(
            run_dir=case_dir,
            task_source=task_source.resolve(),
            seed_artifact=seed_artifact.resolve(),
            config=config_path,
            run_id=run_id,
            seed_score=seed_score,
            cold_start=False,
            harness_profile=profile_path,
        )
    )
    evolve_handler(
        argparse.Namespace(
            run_dir=case_dir,
            config=config_path,
        )
    )
    return load_episode_outcome(
        case_id=case_id,
        harness_id=harness.harness_id,
        run_dir=case_dir,
    )


def _episode_config_dict(config: AppConfig) -> dict:
    harness = config.method.harness_evolution
    if harness is None:
        raise ValueError("episode runner requires L4 harness_evolution config")
    return {
        "benchmark": {"adapter": config.benchmark.adapter, "options": config.benchmark.options},
        "backend": {
            "command": list(config.backend.command),
            "cwd": str(config.backend.cwd),
            "timeout_seconds": config.backend.timeout_seconds,
            "env": dict(config.backend.env),
        },
        "method": {
            "level": "L4",
            "harness_evolution": {
                "modules": [
                    {
                        "module_id": module.module_id,
                        "tags": list(module.tags),
                        "instruction": module.instruction,
                    }
                    for module in harness.modules
                ],
                "tool_interfaces": [
                    {
                        "interface_id": tool.interface_id,
                        "kind": tool.kind,
                        "description": tool.description,
                        "command": list(tool.command),
                        "cwd": str(tool.cwd) if tool.cwd else None,
                        "env": dict(tool.env),
                        "safety_scope": tool.safety_scope,
                        "tags": list(tool.tags),
                    }
                    for tool in harness.tool_interfaces
                ],
                "seed_modules": list(harness.seed_modules),
                "seed_tool_interfaces": list(harness.seed_tool_interfaces),
                "max_active_modules": harness.max_active_modules,
                "max_active_tool_interfaces": harness.max_active_tool_interfaces,
                "mutation_width": harness.mutation_width,
                "replay_min_cases": harness.replay_min_cases,
                "promotion_delta_min": harness.promotion_delta_min,
                "max_case_regression": harness.max_case_regression,
                "loop_role": harness.loop_role,
                "rubric_validation_sample_size": harness.rubric_validation_sample_size,
                "require_rubric_validation": harness.require_rubric_validation,
                "rubric_provider": harness.rubric_provider,
            },
        },
        "experiment": {"arm": "L4", "freezes_harness_outer_loop": True},
    }
