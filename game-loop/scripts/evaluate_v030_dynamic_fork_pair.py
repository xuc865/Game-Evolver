#!/usr/bin/env python3
"""Formally compare singleton DSH with an HPA-evolved dynamic fork target."""

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
from game_loop.core.harness import HarnessEpisodeOutcome, HarnessProfile
from game_loop.core.harness_rubric_validator import HarnessRubricValidator
from game_loop.runtime.deepseek_harness import (
    DeepSeekHarnessRuntime,
    DeepSeekHarnessRuntimeConfig,
)
from game_loop.runtime.protocol import GameSubmission, GameTask
from game_loop.runtime_profile_snapshot import (
    capture_runtime_profile,
    materialize_runtime_profile,
)
from game_loop.studio_server import StudioManager
from game_loop.utils import atomic_write_json, read_json


DEFAULT_HPA_PROOF = (
    ROOT
    / "experiments/complex-game-multiagent-v030"
    / "dynamic-fork-hpa-v7/proof.json"
)
DEFAULT_PARENT = (
    ROOT
    / "experiments/complex-game-multiagent-v030"
    / "auto-chess-transfer-v5-restart-controlled-formal/parent-runtime/submission.json"
)
DEFAULT_TASK = (
    ROOT
    / "experiments/complex-game-multiagent-v030"
    / "auto-chess-transfer-v5-restart-controlled-formal/task/instruction.md"
)
DEFAULT_SEED = (
    ROOT
    / "experiments/complex-game-multiagent-v030/auto-chess-seed-v1"
)
DEFAULT_PROFILE = ROOT / "experiments/inner-agent/deepseek-harness-profile.local.json"
DEFAULT_INNER = ROOT / "experiments/agentx/inner_harness_gcbench.json"


def _load_submission(path: Path) -> GameSubmission:
    submission = GameSubmission.from_dict(read_json(path))
    if submission.status != "completed" or submission.artifact_ref is None:
        raise RuntimeError(f"submission is not completed reusable evidence: {path}")
    if submission.metadata.get("infrastructure_ok", True) is not True:
        raise RuntimeError(f"submission infrastructure is unhealthy: {path}")
    return submission


def _evidence_run(
    *,
    destination: Path,
    submission: GameSubmission,
    task_source: Path,
    side: str,
) -> Path:
    if destination.exists():
        shutil.rmtree(destination)
    artifact_id = f"dynamic-fork-{side}-artifact"
    artifact = destination / "artifacts" / artifact_id / "artifact"
    artifact.parent.mkdir(parents=True)
    shutil.copytree(Path(str(submission.artifact_ref)), artifact, symlinks=True)
    atomic_write_json(destination / "manifest.json", {
        "benchmark_id": "studio-proof",
        "task_source": str(task_source.resolve()),
        "runtime_id": submission.runtime_id,
        "side": side,
    })
    atomic_write_json(destination / "state.json", {
        "status": "completed",
        "champion_artifact_id": artifact_id,
        "submission_id": submission.submission_id,
    })
    return destination


def _candidate_config(
    *,
    runtime_profile: Path,
    prototypes: list[dict],
    snapshot_root: Path,
    timeout_seconds: int,
) -> DeepSeekHarnessRuntimeConfig:
    profile, _, assets = capture_runtime_profile(runtime_profile)
    active_plugins = set(profile.get("active_cordis_plugins", []))
    active_plugins.add("fork_context_subagent")
    profile["active_cordis_plugins"] = sorted(active_plugins)
    profile["active_subagent_prototypes"] = prototypes
    snapshot_path, _ = materialize_runtime_profile(
        profile=profile,
        assets=assets,
        destination=snapshot_root,
    )
    value = read_json(snapshot_path)
    value["timeout_seconds"] = timeout_seconds
    return DeepSeekHarnessRuntimeConfig.from_dict(value)


def run(args: argparse.Namespace) -> dict[str, object]:
    os.environ.update(StudioManager._runtime_environment())
    output = args.output_dir.resolve()
    if output.exists() and args.force:
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)

    hpa_proof = read_json(args.hpa_proof)
    prototypes = list(hpa_proof.get("subagent_prototypes", []))
    if not prototypes:
        raise ValueError("HPA proof contains no executable subagent prototypes")
    task_text = args.task_file.read_text(encoding="utf-8")
    task_source = output / "task"
    task_source.mkdir()
    (task_source / "instruction.md").write_text(task_text, encoding="utf-8")
    task = GameTask(
        task_id="strategy-auto-chess",
        benchmark_id="studio-proof",
        prompt=task_text,
        task_source_ref=str(task_source),
        workspace_seed_ref=str(args.seed.resolve()),
        artifact_relpath=".",
    )

    parent_submission = _load_submission(args.parent_submission)
    config = _candidate_config(
        runtime_profile=args.runtime_profile,
        prototypes=prototypes,
        snapshot_root=output / "candidate-profile-snapshot",
        timeout_seconds=args.wall_timeout_seconds,
    )
    runtime = DeepSeekHarnessRuntime(config)
    doctor = runtime.doctor()
    atomic_write_json(output / "candidate-doctor.json", doctor)
    if doctor.get("ok") is not True:
        raise RuntimeError("dynamic-fork candidate doctor failed")
    candidate_submission = runtime.run(
        task,
        episode_dir=output / "candidate-runtime",
    )
    if candidate_submission.status != "completed":
        payload = {
            "schema": "v030-dynamic-fork-paired-proof.v1",
            "accepted": False,
            "infrastructure_ok": False,
            "reason": "candidate did not complete",
            "candidate": candidate_submission.to_dict(),
        }
        atomic_write_json(output / "paired-proof.json", payload)
        return payload

    evidence_root = output / "evidence-runs"
    parent_run = _evidence_run(
        destination=evidence_root / "parent",
        submission=parent_submission,
        task_source=task_source,
        side="parent",
    )
    candidate_run = _evidence_run(
        destination=evidence_root / "candidate",
        submission=candidate_submission,
        task_source=task_source,
        side="candidate",
    )
    parent_profile = HarnessProfile.from_dict({
        "harness_id": "v030-singleton-parent",
    })
    candidate_profile = HarnessProfile.from_dict({
        "harness_id": "v030-dynamic-fork-candidate",
        "parent_harness_id": parent_profile.harness_id,
        "active_elements": [
            {
                "element_id": prototype["id"],
                "category": "subagent",
                "description": prototype["description"],
                "spec": {
                    key: value
                    for key, value in prototype.items()
                    if key not in {"id", "description"}
                },
            }
            for prototype in prototypes
        ],
    })
    harness_config = replace(
        HarnessEvolutionConfig.from_dict(read_json(args.inner_config)),
        rubric_validation_sample_size=1,
    )
    case_id = "dynamic-fork-auto-chess"
    parent_outcome = HarnessEpisodeOutcome(
        case_id=case_id,
        harness_id=parent_profile.harness_id,
        final_score=0.0,
        feasible=True,
        model_calls=int(parent_submission.usage.get("modelCalls", 1)),
        evaluator_queries=1,
        infrastructure_ok=True,
        run_ref=str(parent_run),
    )
    candidate_outcome = HarnessEpisodeOutcome(
        case_id=case_id,
        harness_id=candidate_profile.harness_id,
        final_score=0.0,
        feasible=True,
        model_calls=int(candidate_submission.usage.get("modelCalls", 1)),
        evaluator_queries=1,
        infrastructure_ok=True,
        run_ref=str(candidate_run),
    )
    validation = HarnessRubricValidator(harness_config).validate_paired_outcomes(
        parent_outcomes=(parent_outcome,),
        candidate_outcomes=(candidate_outcome,),
        parent_profile=parent_profile,
        candidate_profile=candidate_profile,
        case_task_refs={case_id: task_source},
    )
    parent_soft = sum(item.parent.soft_total for item in validation.case_results)
    candidate_soft = sum(item.candidate.soft_total for item in validation.case_results)
    quality_delta = candidate_soft - parent_soft
    parent_calls = int(parent_submission.usage.get("modelCalls", 1))
    candidate_calls = int(candidate_submission.usage.get("modelCalls", 1))
    cost_penalty = max(0, candidate_calls - parent_calls) * 0.02
    net_utility = quality_delta - cost_penalty
    accepted = validation.accepted and net_utility >= 0 and (
        quality_delta > 0 or candidate_calls < parent_calls
    )
    payload = {
        "schema": "v030-dynamic-fork-paired-proof.v1",
        "accepted": accepted,
        "infrastructure_ok": validation.infrastructure_ok,
        "source_hpa_proof": str(args.hpa_proof.resolve()),
        "prototypes": prototypes,
        "parent": parent_submission.to_dict(),
        "candidate": candidate_submission.to_dict(),
        "rubric_validation": validation.to_dict(),
        "utility": {
            "quality_delta": quality_delta,
            "model_call_delta": candidate_calls - parent_calls,
            "cost_penalty": cost_penalty,
            "net_utility": net_utility,
        },
    }
    atomic_write_json(output / "paired-proof.json", payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hpa-proof", type=Path, default=DEFAULT_HPA_PROOF)
    parser.add_argument("--parent-submission", type=Path, default=DEFAULT_PARENT)
    parser.add_argument("--task-file", type=Path, default=DEFAULT_TASK)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--runtime-profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--inner-config", type=Path, default=DEFAULT_INNER)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--wall-timeout-seconds", type=int, default=600)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    payload = run(args)
    print(
        f"accepted={payload['accepted']} infrastructure_ok={payload['infrastructure_ok']} "
        f"proof={args.output_dir.resolve() / 'paired-proof.json'}"
    )
    return 0 if payload["infrastructure_ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
