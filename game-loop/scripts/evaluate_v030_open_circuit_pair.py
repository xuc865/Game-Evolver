#!/usr/bin/env python3
"""Run and formally score a singleton DSH against an HPA-generated circuit."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.config import HarnessEvolutionConfig
from game_loop.core.agent_circuit import AgentCircuit
from game_loop.core.agent_circuit_evolution import CircuitCostModel
from game_loop.core.harness import HarnessEpisodeOutcome, HarnessProfile
from game_loop.core.harness_rubric_validator import HarnessRubricValidator
from game_loop.runtime.circuit import DeepSeekCircuitRuntime
from game_loop.runtime.deepseek_harness import (
    DeepSeekHarnessRuntime,
    DeepSeekHarnessRuntimeConfig,
)
from game_loop.runtime.protocol import GameSubmission, GameTask
from game_loop.studio_server import StudioManager
from game_loop.utils import atomic_write_json, read_json


DEFAULT_PROOF = (
    ROOT
    / "experiments/studio-projects/v030-real-hpa-open-circuit-v9/proof.json"
)
DEFAULT_CANDIDATE = (
    ROOT
    / "experiments/studio-projects/v030-real-hpa-open-circuit-v9/runtime-verification"
    / "episode/submission.json"
)
DEFAULT_PROFILE = ROOT / "experiments/inner-agent/deepseek-harness-profile.local.json"
DEFAULT_INNER = (
    ROOT / "game_loop/product_assets/experiments/agentx/inner_harness_gcbench.json"
)
DEFAULT_SEED = ROOT / "experiments/seed_artifacts/puzzle-sokoban-scaffold"
DEFAULT_TASK = (
    "Inspect the supplied Godot game, make one small evidence-backed usability "
    "improvement, verify it launches, and publish the complete workspace."
)


def _runtime_config(
    *,
    circuit: AgentCircuit | None,
    runtime_profile: Path,
    inner_config: Path,
    wall_timeout_seconds: int,
) -> DeepSeekHarnessRuntimeConfig:
    value = read_json(runtime_profile)
    inner = HarnessEvolutionConfig.from_dict(read_json(inner_config))
    value.update(
        timeout_seconds=wall_timeout_seconds,
        agent_circuit=None if circuit is None else circuit.to_dict(),
        harness_module_catalog={
            module.module_id: {
                "id": module.module_id,
                "category": module.category,
                "instruction": module.instruction,
                "tags": list(module.tags),
            }
            for module in inner.modules
        },
        harness_element_catalog={
            element.element_id: {
                "element_id": element.element_id,
                "category": element.category,
                "description": element.description,
                "spec": dict(element.spec),
                "tags": list(element.tags),
            }
            for element in inner.element_catalog
        },
        harness_tool_interface_catalog={
            interface.interface_id: {
                "interface_id": interface.interface_id,
                "kind": interface.kind,
                "description": interface.description,
                "command": list(interface.command),
                "cwd": None if interface.cwd is None else str(interface.cwd),
                "safety_scope": interface.safety_scope,
                "tags": list(interface.tags),
            }
            for interface in inner.tool_interfaces
        },
    )
    return DeepSeekHarnessRuntimeConfig.from_dict(value)


def _load_submission(path: Path) -> GameSubmission:
    value = read_json(path)
    submission = GameSubmission.from_dict(value)
    if submission.status != "completed" or submission.artifact_ref is None:
        raise RuntimeError(f"submission is not reusable completed evidence: {path}")
    if not Path(submission.artifact_ref).is_dir():
        raise RuntimeError(f"submission artifact is missing: {submission.artifact_ref}")
    if submission.metadata.get("infrastructure_ok", True) is not True:
        raise RuntimeError(f"submission infrastructure is not healthy: {path}")
    return submission


def _materialize_evidence_run(
    *,
    destination: Path,
    submission: GameSubmission,
    task_source: Path,
    side: str,
) -> Path:
    if destination.exists():
        shutil.rmtree(destination)
    artifact_id = f"v030-{side}-artifact"
    artifact = destination / "artifacts" / artifact_id / "artifact"
    artifact.parent.mkdir(parents=True)
    shutil.copytree(Path(str(submission.artifact_ref)), artifact, symlinks=True)
    atomic_write_json(
        destination / "manifest.json",
        {
            "benchmark_id": "studio-proof",
            "task_source": str(task_source.resolve()),
            "runtime_id": submission.runtime_id,
            "side": side,
        },
    )
    atomic_write_json(
        destination / "state.json",
        {
            "status": "completed",
            "champion_artifact_id": artifact_id,
            "submission_id": submission.submission_id,
        },
    )
    return destination


def run(args: argparse.Namespace) -> dict[str, object]:
    os.environ.update(StudioManager._runtime_environment())
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    proof = read_json(args.proof)
    parent_circuit = AgentCircuit.from_dict(dict(proof["parent_circuit"]))
    candidate_circuit = AgentCircuit.from_dict(dict(proof["candidate_circuit"]))

    task_source = output / "task"
    task_source.mkdir(exist_ok=True)
    (task_source / "instruction.md").write_text(args.task + "\n", encoding="utf-8")
    task = GameTask(
        task_id="v030-open-circuit-paired-proof",
        benchmark_id="studio-proof",
        prompt=args.task,
        task_source_ref=str(task_source),
        workspace_seed_ref=str(args.seed.resolve()),
        artifact_relpath=".",
    )

    parent_submission_path = output / "parent-runtime" / "submission.json"
    if parent_submission_path.is_file() and not args.force_parent:
        parent_submission = _load_submission(parent_submission_path)
    else:
        parent_config = _runtime_config(
            circuit=None,
            runtime_profile=args.runtime_profile,
            inner_config=args.inner_config,
            wall_timeout_seconds=args.wall_timeout_seconds,
        )
        parent_runtime = DeepSeekHarnessRuntime(parent_config)
        doctor = parent_runtime.doctor()
        atomic_write_json(output / "parent-doctor.json", doctor)
        if doctor.get("ok") is not True:
            raise RuntimeError("singleton parent doctor failed")
        parent_submission = parent_runtime.run(
            task,
            episode_dir=output / "parent-runtime",
        )
        if parent_submission.status != "completed":
            raise RuntimeError(
                "singleton parent failed: " + "; ".join(parent_submission.diagnostics)
            )

    if args.force_candidate:
        candidate_config = _runtime_config(
            circuit=candidate_circuit,
            runtime_profile=args.runtime_profile,
            inner_config=args.inner_config,
            wall_timeout_seconds=args.wall_timeout_seconds,
        )
        candidate_runtime = DeepSeekCircuitRuntime(candidate_config)
        candidate_doctor = candidate_runtime.doctor()
        atomic_write_json(output / "candidate-doctor.json", candidate_doctor)
        if candidate_doctor.get("ok") is not True:
            raise RuntimeError("circuit candidate doctor failed")
        candidate_submission = candidate_runtime.run(
            task,
            episode_dir=output / "candidate-runtime",
        )
        if candidate_submission.status != "completed":
            raise RuntimeError(
                "circuit candidate failed: "
                + "; ".join(candidate_submission.diagnostics)
            )
    else:
        candidate_submission = _load_submission(args.candidate_submission)

    evidence_root = output / "evidence-runs"
    parent_run = _materialize_evidence_run(
        destination=evidence_root / "parent",
        submission=parent_submission,
        task_source=task_source,
        side="parent",
    )
    candidate_run = _materialize_evidence_run(
        destination=evidence_root / "candidate",
        submission=candidate_submission,
        task_source=task_source,
        side="candidate",
    )
    parent_profile = HarnessProfile.from_dict(
        {
            "harness_id": "v030-singleton-parent",
            "agent_circuit": None,
        }
    )
    candidate_profile = HarnessProfile.from_dict(
        {
            "harness_id": "v030-open-circuit-candidate",
            "parent_harness_id": parent_profile.harness_id,
            "agent_circuit": candidate_circuit.to_dict(),
        }
    )
    config = replace(
        HarnessEvolutionConfig.from_dict(read_json(args.inner_config)),
        rubric_validation_sample_size=1,
    )
    parent_outcome = HarnessEpisodeOutcome(
        case_id="v030-pair-01",
        harness_id=parent_profile.harness_id,
        final_score=0.0,
        feasible=True,
        model_calls=int(parent_submission.usage.get("modelCalls", 1)),
        evaluator_queries=1,
        infrastructure_ok=True,
        run_ref=str(parent_run),
    )
    candidate_outcome = HarnessEpisodeOutcome(
        case_id="v030-pair-01",
        harness_id=candidate_profile.harness_id,
        final_score=0.0,
        feasible=True,
        model_calls=int(candidate_submission.usage.get("modelCalls", 1)),
        evaluator_queries=1,
        infrastructure_ok=True,
        run_ref=str(candidate_run),
    )
    validation = HarnessRubricValidator(config).validate_paired_outcomes(
        parent_outcomes=(parent_outcome,),
        candidate_outcomes=(candidate_outcome,),
        parent_profile=parent_profile,
        candidate_profile=candidate_profile,
        case_task_refs={"v030-pair-01": task_source},
    )
    parent_soft = sum(item.parent.soft_total for item in validation.case_results)
    candidate_soft = sum(
        item.candidate.soft_total for item in validation.case_results
    )
    utility = CircuitCostModel(
        minimum_net_utility=config.circuit_min_net_utility
    ).decide(
        parent=parent_circuit,
        candidate=candidate_circuit,
        quality_delta=candidate_soft - parent_soft,
    )
    accepted = validation.accepted and utility.accepted
    payload: dict[str, object] = {
        "schema": "v030-open-circuit-paired-proof.v1",
        "accepted": accepted,
        "infrastructure_ok": validation.infrastructure_ok,
        "parent": {
            "circuit_id": parent_circuit.circuit_id,
            "roles": [role.role_id for role in parent_circuit.roles],
            "submission": parent_submission.to_dict(),
        },
        "candidate": {
            "circuit_id": candidate_circuit.circuit_id,
            "roles": [role.role_id for role in candidate_circuit.roles],
            "submission": candidate_submission.to_dict(),
        },
        "rubric_validation": validation.to_dict(),
        "circuit_utility": {
            "accepted": utility.accepted,
            "quality_delta": utility.quality_delta,
            "cost_penalty": utility.cost_penalty,
            "net_utility": utility.net_utility,
            "reasons": list(utility.reasons),
        },
    }
    atomic_write_json(output / "paired-proof.json", payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proof", type=Path, default=DEFAULT_PROOF)
    parser.add_argument("--candidate-submission", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--runtime-profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--inner-config", type=Path, default=DEFAULT_INNER)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--task", default=DEFAULT_TASK)
    parser.add_argument("--wall-timeout-seconds", type=int, default=600)
    parser.add_argument("--force-parent", action="store_true")
    parser.add_argument("--force-candidate", action="store_true")
    args = parser.parse_args()
    payload = run(args)
    print(
        f"accepted={payload['accepted']} "
        f"infrastructure_ok={payload['infrastructure_ok']} "
        f"proof={args.output_dir.resolve() / 'paired-proof.json'}"
    )
    return 0 if payload["infrastructure_ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
