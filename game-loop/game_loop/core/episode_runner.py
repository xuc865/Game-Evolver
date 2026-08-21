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
    run_evolve: bool = True,
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

    profile_path = case_dir.parent / f"{case_dir.name}.harness_profile.json"
    atomic_write_json(profile_path, harness.to_dict())
    config_path = case_dir.parent / f"{case_dir.name}.config.json"
    episode_config = _episode_config_dict(config, harness=harness)
    runtime_profile = episode_config["backend"].pop("runtime_profile_value", None)
    if runtime_profile is not None:
        runtime_profile_path = case_dir.parent / f"{case_dir.name}.runtime_profile.json"
        atomic_write_json(runtime_profile_path, runtime_profile)
        episode_config["backend"]["runtime_profile"] = str(runtime_profile_path)
    atomic_write_json(config_path, episode_config)

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
    if run_evolve:
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


def _episode_config_dict(
    config: AppConfig,
    *,
    harness: HarnessProfile | None = None,
) -> dict:
    active_profile = harness
    harness_config = config.method.harness_evolution
    if harness_config is None:
        raise ValueError("episode runner requires L4 harness_evolution config")
    backend = {
        "command": list(config.backend.command),
        "cwd": str(config.backend.cwd),
        "timeout_seconds": config.backend.timeout_seconds,
        "env": dict(config.backend.env),
    }
    if config.backend.inactivity_timeout_seconds is not None:
        backend["inactivity_timeout_seconds"] = config.backend.inactivity_timeout_seconds
    if config.backend.runtime_profile_value is not None:
        runtime_profile = dict(config.backend.runtime_profile_value)
        if active_profile is not None:
            runtime_profile["active_cordis_plugins"] = sorted({
                str(element.spec.get("plugin_id", element.element_id))
                for element in active_profile.active_elements
                if element.category == "dsh_plugin"
            })
        backend["runtime_profile_value"] = runtime_profile
    element_catalog = [
        {
            "id": element.element_id,
            "category": element.category,
            "description": element.description,
            "spec": dict(element.spec),
            "tags": list(element.tags),
        }
        for element in harness_config.element_catalog
    ]
    known_element_ids = {item["id"] for item in element_catalog}
    if active_profile is not None:
        for element in active_profile.active_elements:
            if element.element_id in known_element_ids:
                continue
            element_catalog.append({
                "id": element.element_id,
                "category": element.category,
                "description": element.description,
                "spec": dict(element.spec),
                "tags": [],
            })
            known_element_ids.add(element.element_id)
    result = {
        "benchmark": {"adapter": config.benchmark.adapter, "options": config.benchmark.options},
        "backend": backend,
        "method": {
            "level": "L4",
            "observation_contract": config.method.observation_contract,
            "fixed_probes": [
                _fixed_probe_dict(probe) for probe in config.method.fixed_probes
            ],
            "max_probe_calls": config.method.max_probe_calls,
            "active_selection": (
                None
                if config.method.active_selection is None
                else {
                    "max_selected_probes": config.method.active_selection.max_selected_probes,
                    "min_observations_per_probe": (
                        config.method.active_selection.min_observations_per_probe
                    ),
                    "coverage_weight": config.method.active_selection.coverage_weight,
                    "regression_weight": config.method.active_selection.regression_weight,
                    "uncertainty_weight": config.method.active_selection.uncertainty_weight,
                    "intent_affinity_weight": config.method.active_selection.intent_affinity_weight,
                    "recency_weight": config.method.active_selection.recency_weight,
                }
            ),
            "probe_families": [
                {
                    "id": family.family_id,
                    "gene": {
                        "name": family.gene.name,
                        "initial": family.gene.initial,
                        "minimum": family.gene.minimum,
                        "maximum": family.gene.maximum,
                        "step": family.gene.step,
                        "difficulty_direction": family.gene.difficulty_direction,
                    },
                    "probe": _fixed_probe_dict(family.template, include_id=False),
                    "archive_capacity": family.archive_capacity,
                }
                for family in config.method.probe_families
            ],
            "harness_evolution": {
                "modules": [
                    {
                        "id": module.module_id,
                        "tags": list(module.tags),
                        "instruction": module.instruction,
                        "category": module.category,
                    }
                    for module in harness_config.modules
                ],
                "tool_interfaces": [
                    {
                        "id": tool.interface_id,
                        "kind": tool.kind,
                        "description": tool.description,
                        "command": list(tool.command),
                        "cwd": str(tool.cwd) if tool.cwd else None,
                        "env": dict(tool.env),
                        "safety_scope": tool.safety_scope,
                        "tags": list(tool.tags),
                    }
                    for tool in harness_config.tool_interfaces
                ],
                "element_catalog": element_catalog,
                "seed_modules": list(harness_config.seed_modules),
                "seed_tool_interfaces": list(harness_config.seed_tool_interfaces),
                "seed_elements": {
                    category: list(element_ids)
                    for category, element_ids in harness_config.seed_elements.items()
                },
                "max_active_modules": harness_config.max_active_modules,
                "max_active_tool_interfaces": harness_config.max_active_tool_interfaces,
                "max_active_elements": dict(harness_config.max_active_elements),
                "mutation_width": harness_config.mutation_width,
                "replay_min_cases": harness_config.replay_min_cases,
                "promotion_delta_min": harness_config.promotion_delta_min,
                "max_case_regression": harness_config.max_case_regression,
                "allowed_niches": list(harness_config.allowed_niches),
                "loop_role": harness_config.loop_role,
                "rubric_validation_sample_size": harness_config.rubric_validation_sample_size,
                "rubric_judge_timeout_seconds": harness_config.rubric_judge_timeout_seconds,
                "require_rubric_validation": harness_config.require_rubric_validation,
                "dynamic_rubric_generation": harness_config.dynamic_rubric_generation,
                "enable_usage_driven_mutation": harness_config.enable_usage_driven_mutation,
                "element_mutation_policy": dict(harness_config.element_mutation_policy),
                "rubric_provider": harness_config.rubric_provider,
                "hard_rubrics": [
                    criterion.to_dict() for criterion in harness_config.hard_rubrics
                ],
                "soft_rubrics": [
                    criterion.to_dict() for criterion in harness_config.soft_rubrics
                ],
            },
        },
        "evolution": {
            "max_generations": config.evolution.max_generations,
            "candidates_per_generation": config.evolution.candidates_per_generation,
            "delta_min": config.evolution.delta_min,
            "objective_regression_epsilon": config.evolution.objective_regression_epsilon,
            "stop_after_rejections": config.evolution.stop_after_rejections,
            "feedback_disclosure": config.evolution.feedback_disclosure,
            "stop_on_terminal_success": config.evolution.stop_on_terminal_success,
            "max_model_calls": config.evolution.max_model_calls,
            "max_evaluator_queries": config.evolution.max_evaluator_queries,
        },
        "reliability": {
            "pause_on_infrastructure_failure": (
                config.reliability.pause_on_infrastructure_failure
            ),
            "count_infrastructure_attempts_in_evaluator_budget": (
                config.reliability.count_infrastructure_attempts_in_evaluator_budget
            ),
        },
        "gates": {
            "max_files": config.gates.max_files,
            "max_total_bytes": config.gates.max_total_bytes,
            "fail_suspicious_references": config.gates.fail_suspicious_references,
        },
        "experiment": {
            "arm": "L4_agent",
            "freezes_harness_outer_loop": True,
        },
    }
    return result


def _fixed_probe_dict(probe, *, include_id: bool = True) -> dict:
    value = {
        "command": list(probe.command),
        "cwd": str(probe.cwd),
        "timeout_seconds": probe.timeout_seconds,
        "env": dict(probe.env),
        "selection_mode": probe.selection_mode,
        "parser": probe.parser,
        "regression_epsilon": probe.regression_epsilon,
        "tags": list(probe.tags),
    }
    if include_id:
        value["id"] = probe.probe_id
    return value
