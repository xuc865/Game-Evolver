from __future__ import annotations

import argparse
from dataclasses import replace
import json
import os
import shutil
import signal
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from game_loop.benchmarks import load_adapter
from game_loop.core.attribution import AttributionReport, TrajectoryAttributor
from game_loop.core.agentx_runtime import (
    AgentXRuntimeConfig,
    build_agentx_nested_evolution,
    build_agentx_replay_cases,
)
from game_loop.config import AppConfig, HarnessEvolutionConfig
from game_loop.core.harness_evolution_memory import (
    HarnessEvolutionMemory,
    build_rejection_experience,
)
from game_loop.core.harness_rubric_validator import (
    HarnessRubricValidator,
    HeuristicRubricJudge,
    load_task_pool,
    fixed_task_pool_cases,
    sample_task_pool,
)
from game_loop.core.harness_evolution_loop import (
    HarnessBenchLoopRunner,
    load_loop_task_pool,
    run_public_bench_eval,
)
from game_loop.core.controller import LoopController
from game_loop.core.harness import (
    HarnessEpisodeOutcome,
    HarnessEvolutionEngine,
    HarnessOuterLoop,
    HarnessProfile,
    HarnessReplayCase,
    HarnessSemanticGradient,
    load_episode_outcome,
)
from game_loop.core.models import EvaluationResult
from game_loop.core.replay import CommandHarnessReplayRunner
from game_loop.supervisor_heartbeat import SupervisorHeartbeatWriter
from game_loop.utils import atomic_write_json, read_json, utc_now


def _maybe_clear_stale_run_lock(run_dir: Path) -> None:
    lock_dir = run_dir / ".loop.lock"
    owner_path = lock_dir / "owner.json"
    if not owner_path.is_file():
        return
    owner = read_json(owner_path)
    pid = owner.get("pid")
    if isinstance(pid, int) and pid > 0:
        try:
            os.kill(pid, 0)
            return
        except OSError:
            pass
    if owner_path.exists():
        owner_path.unlink()
    if lock_dir.exists():
        lock_dir.rmdir()


def _wait_for_active_run(run_dir: Path, *, poll_seconds: float = 5.0) -> None:
    """Block until no live owner holds the run lock and status is terminal."""
    state_path = run_dir / "state.json"
    while state_path.is_file():
        st = json.loads(state_path.read_text(encoding="utf-8"))
        status = str(st.get("status") or "")
        if status not in _ADMISSION_RESUMABLE_STATUSES:
            return
        owner_path = run_dir / ".loop.lock" / "owner.json"
        if owner_path.is_file():
            owner = read_json(owner_path)
            pid = owner.get("pid")
            if isinstance(pid, int) and pid > 0:
                try:
                    os.kill(pid, 0)
                    time.sleep(poll_seconds)
                    continue
                except OSError:
                    _maybe_clear_stale_run_lock(run_dir)
                    return
        time.sleep(poll_seconds)


_ADMISSION_RESUMABLE_STATUSES = frozenset({
    "loop_ready_for_benchmark",
    "running",
    "paused_infrastructure",
})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="game_loop")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    init.add_argument("--run-dir", type=Path, required=True)
    init.add_argument("--task-source", type=Path, required=True)
    init.add_argument("--seed-artifact", type=Path, required=True)
    init.add_argument("--config", type=Path, required=True)
    init.add_argument("--run-id", default=None)
    init.add_argument("--seed-score", type=float, default=0.0)
    init.add_argument("--evaluate-seed", action="store_true")
    init.add_argument("--cold-start", action="store_true")
    init.add_argument("--harness-profile", type=Path, default=None)

    evolve = sub.add_parser("evolve")
    evolve.add_argument("--run-dir", type=Path, required=True)
    evolve.add_argument("--config", type=Path, required=True)

    sub.add_parser("harness-attribute")

    outer_init = sub.add_parser("harness-outer-init")
    outer_init.add_argument("--outer-dir", type=Path, required=True)
    outer_init.add_argument("--config", type=Path, required=True)

    outer_epoch = sub.add_parser("harness-outer-epoch")
    outer_epoch.add_argument("--outer-dir", type=Path, required=True)
    outer_epoch.add_argument("--config", type=Path, required=True)
    outer_epoch.add_argument("--epoch", type=int, required=True)

    self_evolve = sub.add_parser("harness-self-evolve")
    self_evolve.add_argument("--outer-dir", type=Path, required=True)
    self_evolve.add_argument("--config", type=Path, required=True)
    self_evolve.add_argument("--epoch", type=int, required=True)
    self_evolve.add_argument("--cases", type=int, default=3)
    self_evolve.add_argument("--task-source", type=Path, required=True)
    self_evolve.add_argument("--seed-artifact", type=Path, required=True)
    self_evolve.add_argument("--task-pool", type=Path)
    self_evolve.add_argument("--fixed-admission-task-pool", type=Path)
    self_evolve.add_argument("--seed-score", type=float, default=0.0)
    self_evolve.add_argument("--evaluate-seed", action="store_true")
    self_evolve.add_argument("--run-id-prefix", default="e")
    self_evolve.add_argument("--skip-rubric-validation", action="store_true")

    self_supervise = sub.add_parser("harness-self-supervise")
    self_supervise.add_argument("--outer-dir", type=Path, required=True)
    self_supervise.add_argument("--config", type=Path, required=True)
    self_supervise.add_argument("--task-source", type=Path, required=True)
    self_supervise.add_argument("--seed-artifact", type=Path, required=True)
    self_supervise.add_argument("--seed-score", type=float, default=0.0)
    self_supervise.add_argument("--evaluate-seed", action="store_true")
    self_supervise.add_argument("--run-id-prefix", default="e")
    self_supervise.add_argument("--start-epoch", type=int, default=1)
    self_supervise.add_argument("--max-epochs", type=int, default=200)
    self_supervise.add_argument("--cases", type=int, default=3)
    self_supervise.add_argument("--task-pool", type=Path)
    self_supervise.add_argument("--fixed-admission-task-pool", type=Path)
    self_supervise.add_argument("--skip-rubric-validation", action="store_true")
    self_supervise.add_argument("--heartbeat-seconds", type=int, default=30)
    self_supervise.add_argument(
        "--max-epoch-retries",
        type=int,
        default=int(os.environ.get("GAME_LOOP_MAX_EPOCH_RETRIES", "3")),
        help="maximum infrastructure/proposal retries before recording FAILED_INFRA and advancing",
    )
    self_supervise.add_argument("--ui-port", type=int, default=8765)

    agentx_init = sub.add_parser("agentx-nested-init")
    agentx_init.add_argument("--run-dir", type=Path, required=True)
    agentx_init.add_argument("--config", type=Path, required=True)
    agentx_init.add_argument("--inner-config", type=Path)
    agentx_init.add_argument("--outer-config", type=Path)
    agentx_init.add_argument("--bench", default="gcbench")
    agentx_init.add_argument("--enable-outer-evolution", action="store_true")

    agentx_epoch = sub.add_parser("agentx-nested-epoch")
    agentx_epoch.add_argument("--run-dir", type=Path, required=True)
    agentx_epoch.add_argument("--config", type=Path, required=True)
    agentx_epoch.add_argument("--epoch", type=int, required=True)
    agentx_epoch.add_argument("--task-source", type=Path, required=True)
    agentx_epoch.add_argument("--seed-artifact", type=Path, required=True)
    agentx_epoch.add_argument("--task-pool", type=Path)
    agentx_epoch.add_argument("--inner-config", type=Path)
    agentx_epoch.add_argument("--outer-config", type=Path)
    agentx_epoch.add_argument("--seed-score", type=float, default=0.0)
    agentx_epoch.add_argument("--inner-cases", type=int)
    agentx_epoch.add_argument("--outer-cases", type=int)
    agentx_epoch.add_argument("--attribution-runs", type=Path, nargs="*")
    agentx_epoch.add_argument("--offline-rubric-judge", action="store_true")
    agentx_epoch.add_argument("--enable-outer-evolution", action="store_true")

    bench_loop_init = sub.add_parser("harness-bench-loop-init")
    bench_loop_init.add_argument("--loop-dir", type=Path, required=True)
    bench_loop_init.add_argument("--config", type=Path, required=True)
    bench_loop_init.add_argument("--harness-dir", type=Path, required=True)
    bench_loop_init.add_argument("--task-pool", type=Path, required=True)
    bench_loop_init.add_argument("--bench", default=None)

    bench_loop_step = sub.add_parser("harness-bench-loop-step")
    bench_loop_step.add_argument("--loop-dir", type=Path, required=True)
    bench_loop_step.add_argument("--config", type=Path, required=True)
    bench_loop_step.add_argument("--harness-dir", type=Path, required=True)
    bench_loop_step.add_argument("--task-pool", type=Path, required=True)
    bench_loop_step.add_argument("--bench", default=None)
    bench_loop_step.add_argument("--run-id-prefix", default="loop")

    bench_loop_run = sub.add_parser("harness-bench-loop-run")
    bench_loop_run.add_argument("--loop-dir", type=Path, required=True)
    bench_loop_run.add_argument("--config", type=Path, required=True)
    bench_loop_run.add_argument("--harness-dir", type=Path, required=True)
    bench_loop_run.add_argument("--task-pool", type=Path, required=True)
    bench_loop_run.add_argument("--steps", type=int, default=1)
    bench_loop_run.add_argument("--bench", default=None)
    bench_loop_run.add_argument("--run-id-prefix", default="loop")

    eval_public = sub.add_parser("harness-eval-public")
    eval_public.add_argument("--config", type=Path, required=True)
    eval_public.add_argument("--harness-profile", type=Path, required=True)
    eval_public.add_argument("--task-source", type=Path, required=True)
    eval_public.add_argument("--seed-artifact", type=Path, required=True)
    eval_public.add_argument("--run-dir", type=Path, required=True)
    eval_public.add_argument("--seed-score", type=float, default=0.0)
    eval_public.add_argument("--run-id-prefix", default="public")
    eval_public.add_argument("--baseline-only", action="store_true")

    return parser


# ── init / evolve / outer-init / outer-epoch ──────────────────────────

def _resolve_inner_outer_harness_configs(
    config,
    *,
    inner_config: Path | None,
    outer_config: Path | None,
    bench: str = "gcbench",
) -> tuple[HarnessEvolutionConfig, HarnessEvolutionConfig]:
    if inner_config is not None:
        inner_cfg = HarnessEvolutionConfig.from_dict(read_json(inner_config))
    else:
        inner_cfg = HarnessEvolutionConfig.from_dict(build_inner_harness_evolution(bench))
    if outer_config is not None:
        outer_cfg = HarnessEvolutionConfig.from_dict(read_json(outer_config))
    else:
        outer_cfg = HarnessEvolutionConfig.from_dict(build_outer_harness_evolution())
    return inner_cfg, outer_cfg


def _task_pool_from_args(
    *,
    task_pool_path: Path | None,
    task_source: Path,
    seed_artifact: Path,
    seed_score: float,
):
    if task_pool_path is not None:
        return load_task_pool(task_pool_path.resolve())
    from game_loop.core.harness_rubric_validator import TaskPoolEntry

    return (
        TaskPoolEntry(
            task_ref=str(task_source.resolve()),
            seed_artifact_ref=str(seed_artifact.resolve()),
            seed_score=seed_score,
        ),
    )


def _resolve_seed_evaluation(
    *,
    args: argparse.Namespace,
    adapter,
    config: AppConfig,
) -> EvaluationResult:
    if getattr(args, "evaluate_seed", False):
        if adapter.adapter_id != "gcbench":
            raise ValueError("--evaluate-seed is only supported for the gcbench adapter")
        from game_loop.gcbench_verifier import evaluate_seed_artifact

        gcbench_root = Path(str(config.benchmark.options.get("root", ""))).expanduser().resolve()
        if not gcbench_root.is_dir():
            raise ValueError(f"gcbench root does not exist: {gcbench_root}")
        return evaluate_seed_artifact(
            seed_artifact=args.seed_artifact,
            task_source=args.task_source,
            gcbench_root=gcbench_root,
            output_dir=args.run_dir.parent / f"{args.run_dir.name}.seed_verifier",
        )
    seed_score = float(args.seed_score)
    return EvaluationResult(seed_score, True, {"quality": seed_score})


def cmd_init(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    adapter = load_adapter(config.benchmark.adapter, config.benchmark.options)
    harness_profile = (
        HarnessProfile.from_dict(json.loads(args.harness_profile.read_text(encoding="utf-8")))
        if args.harness_profile is not None
        else None
    )
    seed_evaluation = _resolve_seed_evaluation(args=args, adapter=adapter, config=config)
    LoopController.initialize(
        run_dir=args.run_dir,
        task_source=args.task_source,
        seed_artifact=args.seed_artifact,
        seed_evaluation=seed_evaluation,
        config=config,
        adapter=adapter,
        run_id=args.run_id,
        initial_harness_profile=harness_profile,
    )
    return 0


def cmd_evolve(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    adapter = load_adapter(config.benchmark.adapter, config.benchmark.options)
    controller = LoopController(
        run_dir=args.run_dir,
        config=config,
        adapter=adapter,
    )
    controller.evolve()
    return 0


def cmd_harness_outer_init(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    if config.method.harness_evolution is None:
        raise ValueError("harness outer init requires L4 harness_evolution config")
    HarnessEvolutionEngine(args.outer_dir, config.method.harness_evolution).initialize()
    return 0


def cmd_harness_outer_epoch(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    if config.method.harness_evolution is None:
        raise ValueError("harness outer epoch requires L4 harness_evolution config")
    engine = HarnessEvolutionEngine(args.outer_dir, config.method.harness_evolution)
    runner = CommandHarnessReplayRunner(
        runs_root=args.outer_dir / "replays",
        project_root=Path(__file__).resolve().parents[1],
    )
    outer = HarnessOuterLoop(engine, runner)
    outer.run_epoch(
        epoch=args.epoch,
        cases=[HarnessReplayCase("bootstrap", str(args.config.parent), str(args.config))],
        gradient=HarnessSemanticGradient("bootstrap epoch"),
    )
    return 0


# ── harness-self-evolve ───────────────────────────────────────────────

def cmd_harness_self_evolve(args: argparse.Namespace) -> int:
    """Run a single harness self-evolution epoch (one-shot, no supervisor)."""
    config = AppConfig.load(args.config)
    if config.method.harness_evolution is None:
        raise ValueError("harness self evolve requires L4 harness_evolution config")

    outer_dir = args.outer_dir.resolve()
    harness_cfg = config.method.harness_evolution
    if args.skip_rubric_validation:
        harness_cfg = replace(harness_cfg, require_rubric_validation=False)
    engine = HarnessEvolutionEngine(
        outer_dir,
        harness_cfg,
        allow_mutation=not config.experiment.freezes_harness_outer_loop,
    )
    runner = CommandHarnessReplayRunner(
        runs_root=outer_dir / "replays",
        project_root=Path(__file__).resolve().parents[1],
    )
    fixed_pool_path = args.fixed_admission_task_pool
    task_pool = _task_pool_from_args(
        task_pool_path=fixed_pool_path or args.task_pool,
        task_source=args.task_source,
        seed_artifact=args.seed_artifact,
        seed_score=float(args.seed_score),
    )

    return run_harness_self_evolution(
        engine=engine,
        runner=runner,
        outer_dir=outer_dir,
        config=config,
        source_config=args.config.resolve(),
        task_pool=task_pool,
        seed_score=float(args.seed_score),
        epoch=args.epoch,
        num_cases=args.cases,
        run_id_prefix=args.run_id_prefix,
        fixed_admission_cases=fixed_pool_path is not None,
        offline_rubric_judge=args.skip_rubric_validation,
        evaluate_seed=bool(args.evaluate_seed),
    )


def run_harness_self_evolution(
    *,
    engine: HarnessEvolutionEngine,
    runner: CommandHarnessReplayRunner,
    outer_dir: Path,
    config: AppConfig,
    source_config: Path,
    task_pool,
    seed_score: float,
    epoch: int,
    num_cases: int,
    run_id_prefix: str,
    fixed_admission_cases: bool = False,
    offline_rubric_judge: bool = False,
    evaluate_seed: bool = False,
    heartbeat: SupervisorHeartbeatWriter | None = None,
) -> int:
    """Execute one epoch of harness self-evolution.

    For each admission case:
    1. Run the parent (champion) harness on a task → get parent outcome
    2. Run the candidate harness on the same task → get candidate outcome
    3. Compare outcomes via paired rubric → decide accept/reject

    Supports resume: if a plan file already exists for this epoch, reuse the
    candidate instead of creating a new one.
    """
    parent = engine.champion()
    memory = HarnessEvolutionMemory(outer_dir / "harness_archive")
    rubric_validator = HarnessRubricValidator(
        engine.config,
        judge=HeuristicRubricJudge() if offline_rubric_judge else None,
    )
    sample_size = max(num_cases, engine.config.rubric_validation_sample_size)
    if fixed_admission_cases:
        sampled_cases = fixed_task_pool_cases(
            task_pool,
            sample_size=sample_size,
            prefix=f"e{epoch:03d}",
        )
    else:
        sampled_cases = sample_task_pool(
            task_pool,
            sample_size=sample_size,
            seed=epoch,
            prefix=f"e{epoch:03d}",
            anchor_index=epoch - 1,
        )

    # ── resume: reuse existing plan if available ──
    existing_plan = None
    existing_plan_path = outer_dir / f"harness_self_evolution_plan_{epoch:03d}.json"
    if existing_plan_path.is_file():
        existing_plan = read_json(existing_plan_path)

    valid_existing_plan = bool(
        existing_plan
            and existing_plan.get("parent_harness_id") == parent.harness_id
            and existing_plan.get("config_fingerprint") == config.fingerprint
            and existing_plan.get("candidate_harness_id")
            and isinstance(existing_plan.get("gradient"), dict)
    )

    # A resumed epoch must reuse both its candidate and its proposal. Calling
    # the proposer again can overwrite the audit record without changing the
    # candidate that is actually evaluated.
    if valid_existing_plan:
        gradient = _gradient_from_plan(existing_plan)
        candidate = engine.get(existing_plan["candidate_harness_id"])
        print(f"[resume] reusing candidate {candidate.harness_id} from existing plan")
        existing_plan.update({
            "num_cases": num_cases,
            "admission_case_selection": "fixed" if fixed_admission_cases else "epoch_sampled",
            "admission_tasks": [case.task_ref for case in sampled_cases],
        })
        atomic_write_json(existing_plan_path, existing_plan)
    else:
        if os.environ.get("GAME_LOOP_LLM_HARNESS_PROPOSER", "0").strip().casefold() in {
            "1", "true", "yes", "on",
        }:
            gradient = _build_llm_dynamic_gradient(
                outer_dir=outer_dir,
                epoch=epoch,
                parent=parent,
                engine=engine,
                config=config,
            )
        else:
            gradient = _build_dynamic_gradient(
                outer_dir,
                epoch,
                parent,
                engine.config,
                benchmark_id=config.benchmark.adapter,
            )
        candidate = engine.propose(
            parent_id=parent.harness_id,
            gradient=gradient,
            epoch=epoch,
        )
        # persist plan
        atomic_write_json(existing_plan_path, {
            "epoch": epoch,
            "parent_harness_id": parent.harness_id,
            "candidate_harness_id": candidate.harness_id,
            "config_fingerprint": config.fingerprint,
            "gradient": gradient.to_dict(),
            "num_cases": num_cases,
            "admission_case_selection": "fixed" if fixed_admission_cases else "epoch_sampled",
            "admission_tasks": [case.task_ref for case in sampled_cases],
            "created_at": utc_now(),
        })

    print(f"[epoch {epoch:03d}] parent={parent.harness_id} → candidate={candidate.harness_id}")
    print(f"[epoch {epoch:03d}] gradient: {gradient.diagnosis} tags={list(gradient.target_tags)}")

    # ── run admission cases ──
    parent_outcomes: list[HarnessEpisodeOutcome] = []
    candidate_outcomes: list[HarnessEpisodeOutcome] = []

    for case in sampled_cases:
        case_id = case.case_id
        case_dir = outer_dir / "admission_runs" / case_id
        case_seed_score = float(case.metadata.get("seed_score", seed_score))
        if heartbeat is not None:
            heartbeat.update(
                current_epoch=epoch,
                phase=f"epoch_{epoch}",
                case_id=case_id,
            )
            heartbeat.write_now()

        result = _run_paired_harness_admission_case(
            case_id=case_id,
            case_dir=case_dir,
            parent=parent,
            candidate=candidate,
            engine=engine,
            runner=runner,
            outer_dir=outer_dir,
            config=config,
            source_config=source_config,
            task_source=Path(case.task_ref),
            seed_artifact=Path(case.parent_artifact_ref),
            seed_score=case_seed_score,
            epoch=epoch,
            run_id_prefix=run_id_prefix,
            evaluate_seed=evaluate_seed,
        )

        if result is not None:
            parent_outcomes.append(result["parent"])
            candidate_outcomes.append(result["candidate"])

    infrastructure_failures = [
        item
        for item in (*parent_outcomes, *candidate_outcomes)
        if not item.infrastructure_ok
    ]
    if infrastructure_failures:
        atomic_write_json(
            outer_dir / f"epoch_infrastructure_failure_{epoch:03d}.json",
            {
                "epoch": epoch,
                "case_ids": sorted({item.case_id for item in infrastructure_failures}),
                "run_refs": [item.run_ref for item in infrastructure_failures],
                "created_at": utc_now(),
            },
        )
        raise RuntimeError(
            f"epoch {epoch} has evaluator infrastructure failures; retrying without recording quality"
        )

    rubric_validation = rubric_validator.validate_paired_outcomes(
        parent_outcomes=parent_outcomes,
        candidate_outcomes=candidate_outcomes,
        parent_profile=parent,
        candidate_profile=candidate,
        case_task_refs={
            case.case_id: Path(case.task_ref) for case in sampled_cases
        },
        module_categories=engine.module_categories,
    ).to_dict()
    atomic_write_json(
        outer_dir / f"harness_rubric_validation_{epoch:03d}.json",
        rubric_validation,
    )
    if rubric_validation.get("infrastructure_ok") is not True:
        # Keep the failed attempt auditable, but make its retry state explicit
        # so monitoring and resume logic never mistake it for a quality result.
        atomic_write_json(
            outer_dir / f"harness_rubric_validation_{epoch:03d}.retry.json",
            {
                "epoch": epoch,
                "status": "retryable_infrastructure_failure",
                "validation": rubric_validation,
                "created_at": utc_now(),
            },
        )
        raise RuntimeError(
            f"epoch {epoch} rubric judge infrastructure failed; retrying without promotion"
        )

    result = engine.assess_epoch(
        epoch=epoch,
        parent=parent,
        candidate=candidate,
        parent_outcomes=parent_outcomes,
        candidate_outcomes=candidate_outcomes,
        rubric_validation=rubric_validation,
    )
    engine.record_epoch(result)
    if not result.accepted and engine.config.enable_long_term_memory:
        memory.append(
            build_rejection_experience(
                epoch=epoch,
                loop_role=engine.config.loop_role,
                parent=parent,
                candidate=candidate,
                epoch_result=result,
                rubric_validation=rubric_validation,
            )
        )

    status = "ACCEPTED" if result.accepted else "REJECTED"
    print(f"[epoch {epoch:03d}] {status} median_delta={result.median_delta} "
          f"pairs={len(result.paired_deltas)} reasons={list(result.reasons)}")

    return 0 if result.accepted else 1


def _gradient_from_plan(plan: dict[str, Any]) -> HarnessSemanticGradient:
    payload = plan.get("gradient")
    if not isinstance(payload, dict):
        raise ValueError("existing harness evolution plan is missing gradient")
    return HarnessSemanticGradient(
        diagnosis=str(payload.get("diagnosis", "")),
        target_tags=tuple(str(item) for item in payload.get("target_tags", ())),
        evidence_refs=tuple(str(item) for item in payload.get("evidence_refs", ())),
    )


def _run_paired_harness_admission_case(
    *,
    case_id: str,
    case_dir: Path,
    parent: HarnessProfile,
    candidate: HarnessProfile,
    engine: HarnessEvolutionEngine,
    runner: CommandHarnessReplayRunner,
    outer_dir: Path,
    config: AppConfig,
    source_config: Path,
    task_source: Path,
    seed_artifact: Path,
    seed_score: float,
    epoch: int,
    run_id_prefix: str,
    evaluate_seed: bool = False,
) -> dict[str, Any] | None:
    """Run a single paired admission case.

    Returns a dict with 'parent' and 'candidate' outcomes, or None if the case
    was skipped (already completed in a previous run).
    """
    config_fingerprint = str(getattr(config, "fingerprint", ""))
    if not config_fingerprint:
        raise ValueError("paired admission requires a non-empty config fingerprint")
    case_dir.mkdir(parents=True, exist_ok=True)

    # ── resume: skip if paired_admission.json already exists ──
    paired_path = case_dir / "paired_admission.json"
    if paired_path.is_file():
        existing = json.loads(paired_path.read_text(encoding="utf-8"))
        matches_current_pair = (
            isinstance(existing, dict)
            and existing.get("parent_harness_id") == parent.harness_id
            and existing.get("candidate_harness_id") == candidate.harness_id
            and existing.get("config_fingerprint") == config_fingerprint
        )
        if not matches_current_pair:
            retry_index = 1
            while (case_dir.parent / f"{case_dir.name}.pair-retry-{retry_index}").exists():
                retry_index += 1
            archived = case_dir.parent / f"{case_dir.name}.pair-retry-{retry_index}"
            case_dir.rename(archived)
            case_dir.mkdir(parents=True, exist_ok=True)
            print(
                f"[{case_id}] archived mismatched paired admission to "
                f"{archived.name}; replaying"
            )
        else:
            parent_run_dir = case_dir / "parent"
            candidate_run_dir = case_dir / "candidate"
            if parent_run_dir.is_dir() and candidate_run_dir.is_dir():
                parent_outcome = load_episode_outcome(
                    case_id=case_id,
                    harness_id=parent.harness_id,
                    run_dir=parent_run_dir,
                )
                candidate_outcome = load_episode_outcome(
                    case_id=case_id,
                    harness_id=candidate.harness_id,
                    run_dir=candidate_run_dir,
                )
                # Re-normalize persisted admission metadata on resume.  Older
                # runs could record a judge outage as a valid 0-vs-0 pass.
                normalized = _paired_admission_payload(
                    case_id=case_id,
                    parent=parent,
                    candidate=candidate,
                    parent_outcome=parent_outcome,
                    candidate_outcome=candidate_outcome,
                    config_fingerprint=config_fingerprint,
                    created_at=str(existing.get("created_at") or utc_now()),
                )
                if existing != normalized:
                    atomic_write_json(paired_path, normalized)
                    print(f"[{case_id}] normalized existing paired_admission.json")
                else:
                    print(f"[{case_id}] skip: paired_admission.json already exists")
                if not normalized["infrastructure_ok"]:
                    retry_index = 1
                    while (case_dir.parent / f"{case_dir.name}.infra-retry-{retry_index}").exists():
                        retry_index += 1
                    archived = case_dir.parent / f"{case_dir.name}.infra-retry-{retry_index}"
                    case_dir.rename(archived)
                    case_dir.mkdir(parents=True, exist_ok=True)
                    print(f"[{case_id}] archived infrastructure-failed pair to {archived.name}; replaying")
                else:
                    return {
                        "parent": parent_outcome,
                        "candidate": candidate_outcome,
                    }
            else:
                retry_index = 1
                while (case_dir.parent / f"{case_dir.name}.incomplete-retry-{retry_index}").exists():
                    retry_index += 1
                archived = case_dir.parent / f"{case_dir.name}.incomplete-retry-{retry_index}"
                case_dir.rename(archived)
                case_dir.mkdir(parents=True, exist_ok=True)
                print(
                    f"[{case_id}] archived incomplete paired admission to "
                    f"{archived.name}; replaying"
                )

    # ── run parent ──
    parent_run_dir = case_dir / "parent"
    parent_outcome = _run_harness_admission_case(
        case_id=case_id,
        case_dir=parent_run_dir,
        harness=parent,
        runner=runner,
        outer_dir=outer_dir,
        config=config,
        source_config=source_config,
        task_source=task_source,
        seed_artifact=seed_artifact,
        seed_score=seed_score,
        epoch=epoch,
        run_id_prefix=run_id_prefix,
        evaluate_seed=evaluate_seed,
    )
    if not parent_outcome.infrastructure_ok:
        candidate_outcome = HarnessEpisodeOutcome(
            case_id=case_id,
            harness_id=candidate.harness_id,
            final_score=None,
            feasible=False,
            model_calls=0,
            evaluator_queries=0,
            infrastructure_ok=False,
            run_ref=str(case_dir / "candidate"),
        )
        paired = _paired_admission_payload(
            case_id=case_id,
            parent=parent,
            candidate=candidate,
            parent_outcome=parent_outcome,
            candidate_outcome=candidate_outcome,
            config_fingerprint=config_fingerprint,
        )
        atomic_write_json(paired_path, paired)
        print(
            f"[{case_id}] paired: skipped candidate after parent infrastructure failure"
        )
        return {"parent": parent_outcome, "candidate": candidate_outcome}

    # ── run candidate ──
    candidate_run_dir = case_dir / "candidate"
    candidate_outcome = _run_harness_admission_case(
        case_id=case_id,
        case_dir=candidate_run_dir,
        harness=candidate,
        runner=runner,
        outer_dir=outer_dir,
        config=config,
        source_config=source_config,
        task_source=task_source,
        seed_artifact=seed_artifact,
        seed_score=seed_score,
        epoch=epoch,
        run_id_prefix=run_id_prefix,
        evaluate_seed=evaluate_seed,
    )

    # ── compute paired result ──
    paired = _paired_admission_payload(
        case_id=case_id,
        parent=parent,
        candidate=candidate,
        parent_outcome=parent_outcome,
        candidate_outcome=candidate_outcome,
        config_fingerprint=config_fingerprint,
    )
    atomic_write_json(paired_path, paired)

    print(
        f"[{case_id}] paired: passed={paired['passed']} delta={paired['delta']} "
        f"reason={paired['reason']}"
    )

    return {"parent": parent_outcome, "candidate": candidate_outcome}


def _paired_admission_payload(
    *,
    case_id: str,
    parent: HarnessProfile,
    candidate: HarnessProfile,
    parent_outcome: HarnessEpisodeOutcome,
    candidate_outcome: HarnessEpisodeOutcome,
    max_case_regression: float | None = None,
    config_fingerprint: str | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Build paired evidence; rubric validation owns promotion decisions."""

    del max_case_regression  # Compatibility with older callers and snapshots.
    parent_score = parent_outcome.final_score
    candidate_score = candidate_outcome.final_score
    infrastructure_ok = (
        parent_outcome.infrastructure_ok and candidate_outcome.infrastructure_ok
    )
    delta: float | None = None
    passed = False
    if not infrastructure_ok:
        reason = "infrastructure failure in one or both sides; pair excluded from promotion"
    elif parent_score is None or candidate_score is None:
        reason = "paired admission score missing"
    else:
        delta = candidate_score - parent_score
        # Benchmark score deltas remain diagnostic only. Hard/soft rubric
        # monotonicity is evaluated by HarnessRubricValidator.
        passed = True
        reason = (
            f"cand={candidate_score:.4f} parent={parent_score:.4f} "
            f"delta={delta:.4f}"
        )

    return {
        "case_id": case_id,
        "parent_harness_id": parent.harness_id,
        "candidate_harness_id": candidate.harness_id,
        "config_fingerprint": config_fingerprint,
        "parent_score": parent_score,
        "candidate_score": candidate_score,
        "parent_infrastructure_ok": parent_outcome.infrastructure_ok,
        "candidate_infrastructure_ok": candidate_outcome.infrastructure_ok,
        "infrastructure_ok": infrastructure_ok,
        "delta": delta,
        "passed": passed,
        "reason": reason,
        "created_at": created_at or utc_now(),
    }


def _run_harness_admission_case(
    *,
    case_id: str,
    case_dir: Path,
    harness: HarnessProfile,
    runner: CommandHarnessReplayRunner,
    outer_dir: Path,
    config: AppConfig,
    source_config: Path,
    task_source: Path,
    seed_artifact: Path,
    seed_score: float,
    epoch: int,
    run_id_prefix: str,
    evaluate_seed: bool = False,
) -> HarnessEpisodeOutcome:
    """Run a single admission case for one harness (parent or candidate).

    Uses the game-loop init + evolve pipeline with the given harness profile
    frozen for the entire episode.
    """
    def archive_incomplete_case_dir() -> None:
        # A seed-infrastructure retry recreates an empty case directory before
        # falling through to init; there is no incomplete episode to archive.
        if not case_dir.exists() or not any(case_dir.iterdir()):
            return
        retry_index = 1
        while (case_dir.parent / f"{case_dir.name}.incomplete-retry-{retry_index}").exists():
            retry_index += 1
        archived = case_dir.parent / f"{case_dir.name}.incomplete-retry-{retry_index}"
        case_dir.rename(archived)
        print(
            f"[{case_id}] archived incomplete episode to "
            f"{archived.name}; replaying"
        )

    def infrastructure_failure_outcome() -> HarnessEpisodeOutcome:
        return HarnessEpisodeOutcome(
            case_id=case_id,
            harness_id=harness.harness_id,
            final_score=None,
            feasible=False,
            model_calls=0,
            evaluator_queries=0,
            infrastructure_ok=False,
            run_ref=str(case_dir.resolve()),
        )

    def seed_evaluation_needs_retry() -> bool:
        """Detect a persisted seed-judge outage that must be re-evaluated.

        A seed verifier runs during init, before the episode controller starts.
        Resuming only cmd_evolve would otherwise preserve the old 402/timeout
        forever even after the judge service becomes healthy.
        """
        if not evaluate_seed:
            return False
        if not state_path.is_file():
            return False
        try:
            state = read_json(state_path)
        except (OSError, ValueError, TypeError):
            return False
        evaluation = state.get("champion_evaluation", {})
        constraints = evaluation.get("constraints", {})
        evaluator = evaluation.get("evaluator", {})
        return (
            constraints.get("infrastructure_ok") is False
            or bool(evaluator.get("infrastructure_failure", False))
        )

    if case_dir.exists() and any(case_dir.iterdir()):
        state_path = case_dir / "state.json"
        manifest_path = case_dir / "manifest.json"
        coevolution_paths = (
            case_dir / "coevolution" / "game_archive.json",
            case_dir / "coevolution" / "interaction_matrix.json",
            case_dir / "coevolution" / "probe_archive.json",
        )
        resumable_files_present = (
            state_path.is_file()
            and manifest_path.is_file()
            and all(path.is_file() for path in coevolution_paths)
        )
        if manifest_path.is_file():
            manifest = read_json(manifest_path)
            state_harness_id = None
            if state_path.is_file():
                state_harness_id = read_json(state_path).get("champion_harness_id")
            profile_harness_id = None
            profile_path = case_dir / "harness_profile.json"
            if profile_path.is_file():
                profile_harness_id = read_json(profile_path).get("harness_id")
            resume_mismatch = (
                manifest.get("config_fingerprint") != config.fingerprint
                or state_harness_id not in {None, harness.harness_id}
                or profile_harness_id not in {None, harness.harness_id}
            )
            if resume_mismatch:
                retry_index = 1
                while (case_dir.parent / f"{case_dir.name}.config-retry-{retry_index}").exists():
                    retry_index += 1
                archived = case_dir.parent / f"{case_dir.name}.config-retry-{retry_index}"
                case_dir.rename(archived)
                print(
                    f"[{case_id}] archived config-mismatched episode to "
                    f"{archived.name}; replaying"
                )
                case_dir.mkdir(parents=True, exist_ok=True)
                state_path = case_dir / "state.json"
                manifest_path = case_dir / "manifest.json"
                resumable_files_present = False
        if resumable_files_present:
            st = json.loads(state_path.read_text(encoding="utf-8"))
            status = str(st.get("status") or "")
            if seed_evaluation_needs_retry():
                retry_index = 1
                while (case_dir.parent / f"{case_dir.name}.seed-infra-retry-{retry_index}").exists():
                    retry_index += 1
                archived = case_dir.parent / f"{case_dir.name}.seed-infra-retry-{retry_index}"
                case_dir.rename(archived)
                print(
                    f"[{case_id}] archived stale seed infrastructure episode to "
                    f"{archived.name}; re-running seed verifier"
                )
                case_dir.mkdir(parents=True, exist_ok=True)
                resumable_files_present = False
            if not resumable_files_present:
                pass
            elif status == "completed":
                return load_episode_outcome(
                    case_id=case_id,
                    harness_id=harness.harness_id,
                    run_dir=case_dir,
                )
            elif status == "paused_infrastructure":
                # LoopController intentionally preserves a paused run for
                # evaluator-only recovery and cmd_evolve returns it unchanged.
                # An admission replay must make progress, so start a fresh
                # attempt after preserving the failed evidence instead of
                # repeatedly loading the same permanently paused state.
                retry_index = 1
                while (case_dir.parent / f"{case_dir.name}.infra-retry-{retry_index}").exists():
                    retry_index += 1
                archived = case_dir.parent / f"{case_dir.name}.infra-retry-{retry_index}"
                case_dir.rename(archived)
                case_dir.mkdir(parents=True, exist_ok=True)
                print(
                    f"[{case_id}] archived paused infrastructure episode to "
                    f"{archived.name}; restarting clean admission attempt"
                )
                resumable_files_present = False
            elif status in _ADMISSION_RESUMABLE_STATUSES:
                _maybe_clear_stale_run_lock(case_dir)
                owner_path = case_dir / ".loop.lock" / "owner.json"
                if owner_path.is_file():
                    owner = read_json(owner_path)
                    pid = owner.get("pid")
                    if isinstance(pid, int) and pid > 0:
                        try:
                            os.kill(pid, 0)
                            _wait_for_active_run(case_dir)
                            return load_episode_outcome(
                                case_id=case_id,
                                harness_id=harness.harness_id,
                                run_dir=case_dir,
                            )
                        except OSError:
                            _maybe_clear_stale_run_lock(case_dir)
                if not manifest_path.is_file():
                    archive_incomplete_case_dir()
                    return infrastructure_failure_outcome()
                evolve_args = argparse.Namespace(run_dir=case_dir, config=source_config.resolve())
                try:
                    evolve_rc = cmd_evolve(evolve_args)
                except (FileNotFoundError, FileExistsError, ValueError):
                    if case_dir.exists() and any(case_dir.iterdir()):
                        archive_incomplete_case_dir()
                    return infrastructure_failure_outcome()
                if evolve_rc not in (None, 0):
                    return infrastructure_failure_outcome()
                return load_episode_outcome(
                    case_id=case_id,
                    harness_id=harness.harness_id,
                    run_dir=case_dir,
                )
        archive_incomplete_case_dir()

    case_dir.mkdir(parents=True, exist_ok=True)
    profile_staging = outer_dir / "harness_profiles" / f"{case_id}.json"
    profile_staging.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(profile_staging, harness.to_dict())

    config_path = source_config.resolve()

    # ── init ──
    run_id = f"{run_id_prefix}{epoch:03d}_{case_id}"
    init_args = argparse.Namespace(
        run_dir=case_dir,
        task_source=task_source,
        seed_artifact=seed_artifact,
        config=config_path,
        run_id=run_id,
        seed_score=seed_score,
        evaluate_seed=evaluate_seed,
        cold_start=False,
        harness_profile=profile_staging,
    )
    try:
        init_rc = cmd_init(init_args)
    except (FileNotFoundError, FileExistsError, ValueError):
        if case_dir.exists() and any(case_dir.iterdir()):
            archive_incomplete_case_dir()
        return infrastructure_failure_outcome()
    if init_rc not in (None, 0) or not (case_dir / "manifest.json").is_file():
        if case_dir.exists() and any(case_dir.iterdir()):
            archive_incomplete_case_dir()
        return infrastructure_failure_outcome()
    atomic_write_json(case_dir / "harness_profile.json", harness.to_dict())
    shutil.copy2(config_path, case_dir / "config.snapshot.json")

    # ── evolve ──
    evolve_args = argparse.Namespace(
        run_dir=case_dir,
        config=config_path,
    )
    try:
        evolve_rc = cmd_evolve(evolve_args)
    except (FileNotFoundError, FileExistsError, ValueError):
        if case_dir.exists() and any(case_dir.iterdir()):
            archive_incomplete_case_dir()
        return infrastructure_failure_outcome()
    if evolve_rc not in (None, 0):
        return infrastructure_failure_outcome()

    # ── load outcome ──
    return load_episode_outcome(
        case_id=case_id,
        harness_id=harness.harness_id,
        run_dir=case_dir,
    )


def _build_dynamic_gradient(
    outer_dir: Path,
    epoch: int,
    parent: HarnessProfile,
    harness_config: HarnessEvolutionConfig | None = None,
    benchmark_id: str | None = None,
) -> HarnessSemanticGradient:
    """Build a semantic gradient for the current epoch based on historical evidence."""
    memory_hint = ""
    if harness_config is None or harness_config.enable_long_term_memory:
        memory = HarnessEvolutionMemory(outer_dir / "harness_archive")
        memory_hint = memory.render_proposer_context(loop_role="outer")
    element_categories = (
        "skill",
        "mcp",
        "tool",
        "context",
        "protocol",
        "workflow",
    )
    if harness_config is not None and harness_config.allowed_element_categories:
        element_categories = tuple(harness_config.allowed_element_categories)
    use_element_evolution = bool(parent.active_elements) or (
        harness_config is not None
        and harness_config.element_catalog
        and harness_config.enable_usage_driven_mutation
    )
    if use_element_evolution:
        category = element_categories[(epoch - 1) % len(element_categories)]
        tags: list[str] = [category, "usage_driven"]
        benchmark_tag = {
            "gcbench": "godot",
            "gdbench": "godot",
            "vgamegym": "pygame",
            "verigame": "web",
        }.get((benchmark_id or "").casefold())
        if benchmark_tag:
            tags.append(benchmark_tag)
        if os.environ.get("GAME_LOOP_TEXT_ONLY", "0").strip().casefold() in {
            "1", "true", "yes", "on",
        }:
            tags.append("text_only")
        if epoch % 3 == 0:
            tags.append("element_merge")
        diagnosis = f"epoch {epoch}: evolve {category} catalog elements"
        if memory_hint:
            diagnosis = f"{diagnosis}; {memory_hint}"
        return HarnessSemanticGradient(
            diagnosis=diagnosis,
            target_tags=tuple(tags),
        )

    epochs_path = outer_dir / "harness_archive" / "epochs.json"
    if not epochs_path.is_file():
        diagnosis = f"initial epoch {epoch}: explore all niches"
        if memory_hint:
            diagnosis = f"{diagnosis}; {memory_hint}"
        return HarnessSemanticGradient(
            diagnosis=diagnosis,
            target_tags=("context_compiler", "module_strategy", "skill_governance",
                         "tool_interface", "validation", "recovery"),
        )

    epochs_data = read_json(epochs_path)
    items = (
        epochs_data.get("items", [])
        if harness_config is None or harness_config.enable_long_term_memory
        else []
    )

    # Default: rotate through niches
    all_niches = [
        "context_compiler", "module_strategy", "skill_governance",
        "tool_interface", "validation", "recovery",
    ]

    # Check recent rejections to guide gradient
    recent = items[-5:] if len(items) > 5 else items
    rejected_niches: set[str] = set()
    for item in recent:
        if not item.get("accepted", False):
            reasons = item.get("reasons", [])
            for reason in reasons:
                for niche in all_niches:
                    if niche in reason.lower():
                        rejected_niches.add(niche)

    if rejected_niches:
        target = list(rejected_niches)[:3]
        diagnosis = f"epoch {epoch}: address rejected niches {target}"
        if memory_hint:
            diagnosis = f"{diagnosis}; {memory_hint}"
        return HarnessSemanticGradient(
            diagnosis=diagnosis,
            target_tags=tuple(target),
        )

    niche_idx = (epoch - 1) % len(all_niches)
    diagnosis = f"epoch {epoch}: explore {all_niches[niche_idx]}"
    if memory_hint:
        diagnosis = f"{diagnosis}; {memory_hint}"
    return HarnessSemanticGradient(
        diagnosis=diagnosis,
        target_tags=(all_niches[niche_idx],),
    )


def _benchmark_harness_tag(benchmark_id: str) -> str | None:
    return {
        "gcbench": "godot",
        "gdbench": "godot",
        "vgamegym": "pygame",
        "verigame": "web",
    }.get(benchmark_id.casefold())


def _extract_model_json(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        text = text.rsplit("```", 1)[0]
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("harness proposer returned no JSON object")
        value = json.loads(text[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("harness proposer response must be a JSON object")
    return value


def _fallback_harness_proposal(
    compatible: list[dict[str, Any]],
    prior_proposals: list[dict[str, Any]],
) -> dict[str, Any]:
    """Choose a safe catalog element when the real proposer returns bad JSON.

    The backbone is still the primary proposer.  This deterministic fallback
    exists only to keep long-running production experiments from classifying a
    transient structured-output failure as evaluator infrastructure and
    spinning forever.  It avoids recently proposed elements when possible.
    """
    if not compatible:
        raise RuntimeError("no benchmark-compatible harness elements available")
    recent_ids = {
        str(item.get("element_id", "")).strip()
        for item in prior_proposals[-6:]
        if isinstance(item, dict)
    }
    ordered = sorted(
        compatible,
        key=lambda item: (
            str(item.get("id", "")) in recent_ids,
            str(item.get("category", "")),
            str(item.get("id", "")),
        ),
    )
    selected = ordered[0]
    element_id = str(selected["id"])
    return {
        "diagnosis": (
            f"structured proposer output was unavailable; activate {element_id} "
            "as a conservative benchmark-compatible harness element"
        ),
        "category": str(selected["category"]),
        "element_id": element_id,
    }


def _fallback_harness_shortlist(
    compatible: list[dict[str, Any]],
    prior_proposals: list[dict[str, Any]],
    *,
    limit: int = 3,
) -> list[str]:
    """Build a deterministic diverse shortlist when index selection is unavailable."""
    recent_ids = {
        str(item.get("element_id", "")).strip()
        for item in prior_proposals[-6:]
        if isinstance(item, dict)
    }
    ordered = sorted(
        compatible,
        key=lambda item: (
            str(item.get("id", "")) in recent_ids,
            str(item.get("category", "")),
            str(item.get("id", "")),
        ),
    )
    selected: list[str] = []
    used_categories: set[str] = set()
    for item in ordered:
        category = str(item.get("category", ""))
        if category in used_categories:
            continue
        selected.append(str(item["id"]))
        used_categories.add(category)
        if len(selected) >= limit:
            return selected
    for item in ordered:
        element_id = str(item["id"])
        if element_id not in selected:
            selected.append(element_id)
        if len(selected) >= limit:
            break
    return selected


def _build_llm_dynamic_gradient(
    *,
    outer_dir: Path,
    epoch: int,
    parent: HarnessProfile,
    engine: HarnessEvolutionEngine,
    config: AppConfig,
) -> HarnessSemanticGradient:
    """Ask the run's real backbone for one bounded, benchmark-valid mutation."""

    base_url = os.environ.get(
        "CODEX_API_BASE",
        config.backend.env.get("CODEX_API_BASE", ""),
    ).rstrip("/")
    model = os.environ.get(
        "CODEX_MODEL",
        config.backend.env.get("CODEX_MODEL", ""),
    ).strip()
    if not base_url or not model:
        raise RuntimeError("LLM harness proposer requires CODEX_API_BASE and CODEX_MODEL")

    benchmark_tag = _benchmark_harness_tag(config.benchmark.adapter)
    text_only = os.environ.get("GAME_LOOP_TEXT_ONLY", "0").strip().casefold() in {
        "1", "true", "yes", "on",
    }
    active_ids = {item.element_id for item in parent.active_elements}
    active_counts: dict[str, int] = {}
    for item in parent.active_elements:
        active_counts[item.category] = active_counts.get(item.category, 0) + 1
    restricted_ablation = bool(engine.config.allowed_element_categories)
    prior_proposals: list[dict[str, Any]] = []
    existing_proposal_dir = outer_dir / "harness_proposals"
    if engine.config.enable_long_term_memory and existing_proposal_dir.is_dir():
        for path in sorted(existing_proposal_dir.glob("epoch_*.json"))[-6:]:
            value = read_json(path)
            if isinstance(value.get("selected"), dict):
                prior_proposals.append(dict(value["selected"]))
    compatible = []
    for spec in engine.elements.values():
        if not engine.category_is_mutable(spec.category):
            continue
        tags = {tag.casefold() for tag in spec.tags}
        searchable = " ".join(
            (spec.element_id, spec.description, *spec.tags)
        ).casefold()
        if text_only and any(token in searchable for token in ("visual", "screenshot", "image", "video")):
            continue
        incompatible = {"godot", "pygame", "web"} - ({benchmark_tag} if benchmark_tag else set())
        if tags & incompatible:
            continue
        if spec.element_id in active_ids:
            continue
        category_full = (
            active_counts.get(spec.category, 0)
            >= engine.config.max_active_elements.get(spec.category, 1)
        )
        compatible.append({
            "id": spec.element_id,
            "category": spec.category,
            "mutation_mode": "replace" if category_full else "add",
            "description": spec.description,
            "tags": list(spec.tags),
            "spec": dict(spec.spec),
        })
    if not compatible:
        raise RuntimeError("no benchmark-compatible harness elements available")

    memory_hint = ""
    if engine.config.enable_long_term_memory:
        memory = HarnessEvolutionMemory(outer_dir / "harness_archive")
        memory_hint = memory.render_proposer_context(loop_role=engine.config.loop_role)
    epochs_path = outer_dir / "harness_archive" / "epochs.json"
    recent_epochs = []
    if engine.config.enable_long_term_memory and epochs_path.is_file():
        recent_epochs = list(read_json(epochs_path).get("items", []))[-4:]
    allowed_categories = (
        list(engine.config.allowed_element_categories)
        or ["skill", "mcp", "tool", "context", "protocol", "workflow"]
    )
    executable_mutation = any(
        category in {"skill", "mcp", "tool", "workflow"}
        for category in allowed_categories
    )
    task = (
        "Choose exactly one concrete catalog element whose activation is most likely "
        "to improve game quality on this benchmark. Avoid repeating a recently "
        "rejected proposal unless new evidence justifies it. "
        "Do not choose an element for another engine or any visual/image/video tool "
        "when text_only is true. The selected element must be executable and behavior-changing: "
        "it must alter the agent's edit/verify workflow, require observable runtime or gameplay "
        "evidence, and name the concrete artifact/log/state evidence it will produce. Never select "
        "a cosmetic rename, metadata-only change, duplicate description, or empty wrapper. "
        "For gcbench specifically, require real demo input replay, gameplay state progression, "
        "and verifier runtime logs before accepting a candidate. Return JSON only with diagnosis, "
        "category, element_id."
    )
    system_content = (
        "You are the harness-improvement agent. Make one cautious AgentX-style "
        "local mutation. The mutation must change executable harness behavior and "
        "must be verifiable through deep gameplay evidence, not only profile metadata. "
        "Output a single JSON object and no prose."
    )
    if restricted_ablation:
        task = (
            "Choose exactly one concrete catalog element whose activation is most likely "
            "to improve game quality on this benchmark. Avoid repeating a recently "
            "rejected proposal unless new evidence justifies it. "
            "Do not choose an element for another engine or any visual/image/video tool "
            "when text_only is true. The selected element must be behavior-changing. "
            + (
                "It must alter the agent's edit/verify workflow, require observable runtime or gameplay "
                "evidence, and name the concrete artifact/log/state evidence it will produce. "
                if executable_mutation
                else "It must improve textual context compilation or protocol instructions without "
                "adding executable tools, probes, recovery, or validation behavior. "
            )
            + "Never select a cosmetic rename, metadata-only change, duplicate description, "
            "or empty wrapper. For gcbench specifically, require real demo input replay, "
            "gameplay state progression, and verifier runtime logs before accepting a candidate. "
            "Return JSON only with diagnosis, category, element_id."
        )
        system_content = (
            "You are the harness-improvement agent. Make one cautious AgentX-style "
            "local mutation. The mutation must change harness behavior and respect the "
            "allowed catalog categories in the request. Output a single JSON object and no prose."
        )
    common_prompt = {
        "role": "You improve the harness used by a game-making agent.",
        "benchmark": config.benchmark.adapter,
        "backbone": model,
        "text_only": text_only,
        "epoch": epoch,
        "current_harness": {
            "id": parent.harness_id,
            "active_modules": list(parent.active_modules),
            "active_elements": sorted(active_ids),
        },
        "recent_epoch_results": recent_epochs,
        "recent_proposals": prior_proposals,
        "reusable_rejection_memory": memory_hint,
    }
    if restricted_ablation:
        common_prompt["long_term_memory_enabled"] = engine.config.enable_long_term_memory
    catalog_index = [
        {
            "id": item["id"],
            "category": item["category"],
            "tags": item["tags"],
        }
        for item in compatible
    ]
    model_name = model.casefold()
    proposer_max_tokens = 256 if "qwen" in model_name else 1200
    proposer_timeout = int(os.environ.get("GAME_LOOP_HARNESS_PROPOSER_TIMEOUT_SECONDS", "120"))
    proposer_attempts = int(os.environ.get("GAME_LOOP_HARNESS_PROPOSER_ATTEMPTS", "4"))
    proposal_dir = outer_dir / "harness_proposals"
    proposal_dir.mkdir(parents=True, exist_ok=True)
    proposal_path = proposal_dir / f"epoch_{epoch:03d}.json"
    record: dict[str, Any] = {
        "schema_version": "llm-harness-proposal.v2",
        "disclosure_policy": "progressive_index_then_details",
        "epoch": epoch,
        "benchmark": config.benchmark.adapter,
        "model": model,
        "parent_harness_id": parent.harness_id,
        "status": "shortlisting",
        "catalog_size": len(catalog_index),
        "catalog_index": catalog_index,
        "shortlist": [],
        "disclosed_elements": [],
        "stage_attempts": {"shortlist": 0, "selection": 0},
        "stage_errors": {"shortlist": [], "selection": []},
        "max_attempts": proposer_attempts,
        "max_tokens": proposer_max_tokens,
        "selected": None,
        "created_at": utc_now(),
    }
    atomic_write_json(proposal_path, record)

    def request_stage(stage: str, prompt: dict[str, Any], max_tokens: int) -> dict[str, Any] | None:
        errors = record["stage_errors"][stage]
        for attempt in range(1, proposer_attempts + 1):
            record["stage_attempts"][stage] = attempt
            atomic_write_json(proposal_path, record)
            payload_body: dict[str, Any] = {
                "model": model,
                "messages": [
                    {"role": "system", "content": system_content},
                    {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
                ],
                "temperature": 0.2,
                "max_tokens": max_tokens,
                "stream": False,
            }
            if any(name in model_name for name in ("qwen", "glm", "kimi")):
                payload_body["chat_template_kwargs"] = {"enable_thinking": False}
            request = urllib.request.Request(
                base_url + "/chat/completions",
                data=json.dumps(payload_body).encode("utf-8"),
                method="POST",
                headers={
                    "Authorization": f"Bearer {os.environ.get('CODEX_API_KEY') or 'EMPTY'}",
                    "Content-Type": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=proposer_timeout) as response:
                    value = json.loads(response.read().decode("utf-8"))
                message = value["choices"][0]["message"]
                content = message.get("content") or message.get("reasoning_content") or ""
                return _extract_model_json(str(content))
            except (OSError, TimeoutError, KeyError, IndexError, json.JSONDecodeError, ValueError) as exc:
                errors.append(f"attempt {attempt}: {type(exc).__name__}: {exc}")
                atomic_write_json(proposal_path, record)
                if attempt < proposer_attempts:
                    time.sleep(min(8, attempt * 2))
        return None

    shortlist_prompt = dict(common_prompt)
    shortlist_prompt.update({
        "catalog_index": catalog_index,
        "task": (
            "Shortlist at most three catalog IDs for deeper inspection. Prefer category "
            "diversity and avoid recent rejected proposals. No descriptions or implementation "
            "specifications are available at this stage. Return JSON only."
        ),
        "schema": {"element_ids": ["one to three ids from catalog_index"]},
    })
    shortlist_value = request_stage("shortlist", shortlist_prompt, 256)
    valid_ids = {item["id"] for item in compatible}
    shortlist: list[str] = []
    if shortlist_value is not None:
        raw_ids = shortlist_value.get("element_ids", [])
        if isinstance(raw_ids, list):
            for value in raw_ids:
                element_id = str(value).strip()
                if element_id in valid_ids and element_id not in shortlist:
                    shortlist.append(element_id)
                if len(shortlist) == 3:
                    break
        if not shortlist:
            record["stage_errors"]["shortlist"].append(
                "response contained no compatible catalog IDs"
            )
    if not shortlist:
        shortlist = _fallback_harness_shortlist(compatible, prior_proposals)
        record["stage_errors"]["shortlist"].append("using deterministic diverse shortlist")
    disclosed = [item for item in compatible if item["id"] in shortlist]
    disclosed.sort(key=lambda item: shortlist.index(item["id"]))
    record.update(status="selecting", shortlist=shortlist, disclosed_elements=disclosed)
    atomic_write_json(proposal_path, record)

    selection_prompt = dict(common_prompt)
    selection_prompt.update({
        "disclosed_catalog": disclosed,
        "task": task,
        "schema": {
            "diagnosis": "short evidence-grounded reason",
            "category": "|".join(allowed_categories),
            "element_id": "exactly one id from disclosed_catalog",
        },
    })
    selection_value = request_stage("selection", selection_prompt, proposer_max_tokens)
    selected: dict[str, Any] | None = None
    if selection_value is not None:
        element_id = str(selection_value.get("element_id", "")).strip()
        category = str(selection_value.get("category", "")).strip().casefold()
        match = next((item for item in disclosed if item["id"] == element_id), None)
        if match is not None and match["category"] == category:
            selected = {
                "diagnosis": str(selection_value.get("diagnosis", "")).strip()
                or f"activate {element_id}",
                "category": category,
                "element_id": element_id,
            }
        else:
            record["stage_errors"]["selection"].append(
                "response selected an undisclosed or category-mismatched element"
            )
    if selected is None:
        selected = _fallback_harness_proposal(disclosed, prior_proposals)
        record["stage_errors"]["selection"].append(
            "using deterministic fallback restricted to disclosed catalog"
        )
        status = "fallback_completed"
    else:
        status = "completed"
    record.update(status=status, selected=selected)
    atomic_write_json(proposal_path, record)
    selected_catalog = next(
        item for item in compatible if item["id"] == selected["element_id"]
    )
    mutation_mode = str(selected_catalog.get("mutation_mode", "add"))
    selected["mutation_mode"] = mutation_mode
    record.update(selected=selected)
    atomic_write_json(proposal_path, record)
    operation_tag = "element_replace" if mutation_mode == "replace" else "element_add"
    tags = [
        selected["category"],
        "usage_driven",
        operation_tag,
        f"element_id:{selected['element_id']}",
    ]
    if benchmark_tag:
        tags.append(benchmark_tag)
    if text_only:
        tags.append("text_only")
    return HarnessSemanticGradient(
        diagnosis=selected["diagnosis"],
        target_tags=tuple(tags),
        evidence_refs=(str(proposal_path),),
    )


def _build_dynamic_harness_admission_rubric(
    outer_dir: Path,
    epoch: int,
    harness_config: HarnessEvolutionConfig | None = None,
) -> dict[str, Any]:
    """Build the admission rubric for harness self-evolution cases."""
    cfg = harness_config
    if cfg is None:
        return {
            "rubric_version": "harness-self-evolve-v2",
            "epoch": epoch,
            "benchmark_evaluator_used": True,
            "evaluator": "harness_rubric_validator_v1",
        }
    return {
        "rubric_version": "harness-self-evolve-v2",
        "epoch": epoch,
        "hard_rubrics": [item.to_dict() for item in cfg.hard_rubrics],
        "soft_rubrics": [item.to_dict() for item in cfg.soft_rubrics],
        "sample_size": cfg.rubric_validation_sample_size,
        "benchmark_evaluator_used": True,
        "evaluator": "harness_rubric_validator_v1",
    }


# ── harness-self-supervise ────────────────────────────────────────────

def cmd_harness_self_supervise(args: argparse.Namespace) -> int:
    """Long-running supervisor that orchestrates multiple harness self-evolution epochs.

    Features:
    - Heartbeat-based health monitoring
    - Resume support (skips already-completed epochs)
    - Automatic restart of failed epochs
    """
    config = AppConfig.load(args.config)
    if config.method.harness_evolution is None:
        raise ValueError("harness self supervise requires L4 harness_evolution config")

    outer_dir = args.outer_dir.resolve()
    engine = HarnessEvolutionEngine(
        outer_dir,
        config.method.harness_evolution,
        allow_mutation=not config.experiment.freezes_harness_outer_loop,
    )
    if not (outer_dir / "harness_archive" / "champion.json").is_file():
        engine.initialize()
        print(f"[supervisor] initialized seed harness at {outer_dir / 'harness_archive'}")
    runner = CommandHarnessReplayRunner(
        runs_root=outer_dir / "replays",
        project_root=Path(__file__).resolve().parents[1],
    )

    heartbeat_path = outer_dir / ".supervisor_heartbeat.json"
    pid_path = outer_dir / ".supervisor.pid"
    heartbeat = SupervisorHeartbeatWriter(
        heartbeat_path,
        interval_seconds=float(args.heartbeat_seconds),
    )
    shutdown_reason = "completed"

    def _handle_signal(signum: int, _frame: Any) -> None:
        nonlocal shutdown_reason
        shutdown_reason = f"signal_{signum}"
        print(
            f"[supervisor] received signal {signum}, shutting down",
            file=sys.stderr,
        )
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGHUP, _handle_signal)

    # Write PID
    atomic_write_json(pid_path, {"pid": os.getpid(), "started_at": utc_now()})

    current_epoch = args.start_epoch
    max_epochs = args.max_epochs
    max_epoch_retries = int(args.max_epoch_retries)
    if max_epoch_retries < 1:
        raise ValueError("--max-epoch-retries must be >= 1")
    retry_state_path = outer_dir / "epoch_retry_state.json"
    failures_path = outer_dir / "epoch_failures.json"

    def _read_retry_state() -> dict[str, Any]:
        if not retry_state_path.is_file():
            return {"epochs": {}}
        try:
            value = read_json(retry_state_path)
        except (OSError, ValueError, TypeError):
            return {"epochs": {}}
        return value if isinstance(value, dict) and isinstance(value.get("epochs"), dict) else {"epochs": {}}

    def _failed_epoch_numbers() -> set[int]:
        if not failures_path.is_file():
            return set()
        try:
            value = read_json(failures_path)
        except (OSError, ValueError, TypeError):
            return set()
        return {
            int(item["epoch"])
            for item in value.get("items", [])
            if isinstance(item, dict) and str(item.get("epoch", "")).isdigit()
        }

    def _record_failure(exc: Exception) -> bool:
        state = _read_retry_state()
        key = str(current_epoch)
        previous = state["epochs"].get(key, {})
        attempts = int(previous.get("attempts", 0)) + 1
        state["epochs"][key] = {
            "attempts": attempts,
            "last_error": str(exc),
            "updated_at": utc_now(),
        }
        atomic_write_json(retry_state_path, state)
        if attempts < max_epoch_retries:
            print(
                f"[supervisor] epoch {current_epoch} retry {attempts}/{max_epoch_retries}",
                file=sys.stderr,
            )
            return False
        try:
            failures = read_json(failures_path) if failures_path.is_file() else {"items": []}
        except (OSError, ValueError, TypeError):
            failures = {"items": []}
        items = [item for item in failures.get("items", []) if item.get("epoch") != current_epoch]
        items.append({
            "epoch": current_epoch,
            "status": "FAILED_INFRA",
            "attempts": attempts,
            "error": str(exc),
            "created_at": utc_now(),
        })
        atomic_write_json(failures_path, {"items": sorted(items, key=lambda item: int(item["epoch"]))})
        state["epochs"].pop(key, None)
        atomic_write_json(retry_state_path, state)
        print(
            f"[supervisor] epoch {current_epoch} marked FAILED_INFRA after {attempts} attempts; advancing",
            file=sys.stderr,
        )
        return True

    print(f"[supervisor] PID={os.getpid()} start_epoch={current_epoch} max_epochs={max_epochs}")
    heartbeat.update(
        current_epoch=current_epoch,
        phase="running",
    )
    heartbeat.start()

    try:
        while current_epoch <= max_epochs:
            heartbeat.update(
                current_epoch=current_epoch,
                phase="running",
                case_id=None,
            )
            heartbeat.write_now()

            # ── check if epoch already completed ──
            epochs_path = outer_dir / "harness_archive" / "epochs.json"
            if epochs_path.is_file():
                epochs_data = read_json(epochs_path)
                items = epochs_data.get("items", [])
                completed_epochs = {
                    item["epoch"] for item in items
                    if item.get("epoch") is not None
                }
                if current_epoch in completed_epochs:
                    print(f"[supervisor] epoch {current_epoch} already completed, skipping")
                    current_epoch += 1
                    continue
            if current_epoch in _failed_epoch_numbers():
                print(f"[supervisor] epoch {current_epoch} previously FAILED_INFRA, skipping")
                current_epoch += 1
                continue

            # ── run epoch ──
            print(f"[supervisor] starting epoch {current_epoch}")
            heartbeat.update(
                current_epoch=current_epoch,
                phase=f"epoch_{current_epoch}",
                case_id=None,
            )
            heartbeat.write_now()

            epoch_completed = False
            try:
                fixed_pool_path = args.fixed_admission_task_pool
                task_pool = _task_pool_from_args(
                    task_pool_path=fixed_pool_path or args.task_pool,
                    task_source=args.task_source,
                    seed_artifact=args.seed_artifact,
                    seed_score=float(args.seed_score),
                )
                result_code = run_harness_self_evolution(
                    engine=engine,
                    runner=runner,
                    outer_dir=outer_dir,
                    config=config,
                    source_config=args.config.resolve(),
                    task_pool=task_pool,
                    seed_score=float(args.seed_score),
                    epoch=current_epoch,
                    num_cases=args.cases,
                    run_id_prefix=args.run_id_prefix,
                    fixed_admission_cases=fixed_pool_path is not None,
                    offline_rubric_judge=args.skip_rubric_validation,
                    evaluate_seed=bool(args.evaluate_seed),
                    heartbeat=heartbeat,
                )
                print(f"[supervisor] epoch {current_epoch} completed with code {result_code}")
                epoch_completed = result_code in {0, 1}
            except Exception as exc:
                print(f"[supervisor] epoch {current_epoch} failed: {exc}", file=sys.stderr)
                import traceback
                traceback.print_exc()
                epoch_completed = _record_failure(exc)

            if epoch_completed:
                current_epoch += 1
            else:
                print(f"[supervisor] epoch {current_epoch} will be retried after infrastructure/proposal failure")

            # Brief pause between epochs
            time.sleep(2 if epoch_completed else 10)

    except KeyboardInterrupt:
        if shutdown_reason == "completed":
            shutdown_reason = "sigint"
        print(f"[supervisor] shutting down reason={shutdown_reason}")
    finally:
        heartbeat.stop(phase=f"stopped:{shutdown_reason}")
        if pid_path.exists():
            pid_path.unlink()

    return 0


# ── agentx nested evolution ───────────────────────────────────────────

def cmd_agentx_nested_init(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    if config.method.harness_evolution is None:
        raise ValueError("agentx nested init requires L4 harness_evolution config")
    inner_cfg, outer_cfg = _resolve_inner_outer_harness_configs(
        config,
        inner_config=args.inner_config,
        outer_config=args.outer_config,
        bench=config.benchmark.adapter,
    )
    coordinator = build_agentx_nested_evolution(
        run_dir=args.run_dir.resolve(),
        runtime=AgentXRuntimeConfig(
            inner_harness=inner_cfg,
            outer_harness=outer_cfg,
            app_config=config,
            task_source=args.config.parent,
            seed_artifact=args.config,
        ),
        init_handler=cmd_init,
        evolve_handler=cmd_evolve,
        offline_rubric_judge=False,
        outer_enabled=bool(args.enable_outer_evolution),
    )
    coordinator.initialize()
    return 0


def cmd_agentx_nested_epoch(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    if config.method.harness_evolution is None:
        raise ValueError("agentx nested epoch requires L4 harness_evolution config")
    inner_cfg, outer_cfg = _resolve_inner_outer_harness_configs(
        config,
        inner_config=args.inner_config,
        outer_config=args.outer_config,
        bench=config.benchmark.adapter,
    )
    task_pool = _task_pool_from_args(
        task_pool_path=args.task_pool,
        task_source=args.task_source,
        seed_artifact=args.seed_artifact,
        seed_score=float(args.seed_score),
    )
    runtime = AgentXRuntimeConfig(
        inner_harness=inner_cfg,
        outer_harness=outer_cfg,
        app_config=config,
        task_source=args.task_source.resolve(),
        seed_artifact=args.seed_artifact.resolve(),
        seed_score=float(args.seed_score),
        task_pool=task_pool,
    )
    coordinator = build_agentx_nested_evolution(
        run_dir=args.run_dir.resolve(),
        runtime=runtime,
        init_handler=cmd_init,
        evolve_handler=cmd_evolve,
        offline_rubric_judge=bool(args.offline_rubric_judge),
        outer_enabled=bool(args.enable_outer_evolution),
    )
    if args.attribution_runs:
        report = TrajectoryAttributor().collect([path.resolve() for path in args.attribution_runs])
    else:
        report = AttributionReport(
            run_refs=tuple(str(args.run_dir.resolve() / "replays"),),
            outcome_counts={"probe_failed": 1},
            repeated_failures=(),
            infrastructure_events=0,
        )
    inner_cases = build_agentx_replay_cases(
        runtime,
        loop_role="inner",
        epoch=int(args.epoch),
        config_path=args.config.resolve(),
    )
    outer_cases = build_agentx_replay_cases(
        runtime,
        loop_role="outer",
        epoch=int(args.epoch) + 1000,
        config_path=args.config.resolve(),
    )
    if args.inner_cases is not None:
        inner_cases = inner_cases[: max(1, int(args.inner_cases))]
    if args.outer_cases is not None:
        outer_cases = outer_cases[: max(1, int(args.outer_cases))]
    result = coordinator.run_epoch(
        epoch=int(args.epoch),
        report=report,
        inner_cases=inner_cases,
        outer_cases=outer_cases,
    )
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0


# ── harness bench loop / public eval ──────────────────────────────────

def _bench_loop_runner(args: argparse.Namespace) -> HarnessBenchLoopRunner:
    config = AppConfig.load(args.config)
    if config.method.harness_evolution is None:
        raise ValueError("harness bench loop requires L4 harness_evolution config")
    bench = args.bench or config.benchmark.adapter
    engine = HarnessEvolutionEngine(args.harness_dir.resolve(), config.method.harness_evolution)
    return HarnessBenchLoopRunner(
        loop_dir=args.loop_dir.resolve(),
        config=config,
        task_pool=load_loop_task_pool(args.task_pool.resolve()),
        harness_engine=engine,
        init_handler=cmd_init,
        evolve_handler=cmd_evolve,
        bench=bench,
    )


def cmd_harness_bench_loop_init(args: argparse.Namespace) -> int:
    runner = _bench_loop_runner(args)
    if not (args.harness_dir / "harness_archive" / "champion.json").is_file():
        runner.harness_engine.initialize()
    state = runner.initialize()
    print(json.dumps(state.to_dict(), ensure_ascii=False, indent=2))
    return 0


def cmd_harness_bench_loop_step(args: argparse.Namespace) -> int:
    runner = _bench_loop_runner(args)
    result = runner.run_step(run_id_prefix=args.run_id_prefix)
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0


def cmd_harness_bench_loop_run(args: argparse.Namespace) -> int:
    runner = _bench_loop_runner(args)
    if not runner.state_path.is_file():
        if not (args.harness_dir / "harness_archive" / "champion.json").is_file():
            runner.harness_engine.initialize()
        runner.initialize()
    results = runner.run_until(steps=args.steps, run_id_prefix=args.run_id_prefix)
    print(json.dumps([item.to_dict() for item in results], ensure_ascii=False, indent=2))
    return 0


def cmd_harness_eval_public(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    profile = HarnessProfile.from_dict(
        json.loads(args.harness_profile.read_text(encoding="utf-8"))
    )
    payload = run_public_bench_eval(
        config=config,
        harness_profile=profile,
        task_source=args.task_source,
        seed_artifact=args.seed_artifact,
        seed_score=float(args.seed_score),
        run_dir=args.run_dir,
        init_handler=cmd_init,
        evolve_handler=cmd_evolve,
        run_id_prefix=args.run_id_prefix,
        run_evolve=not bool(args.baseline_only),
    )
    atomic_write_json(args.run_dir / "public_eval.json", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


# ── main ──────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {
        "init": cmd_init,
        "evolve": cmd_evolve,
        "harness-attribute": lambda _args: 0,
        "harness-outer-init": cmd_harness_outer_init,
        "harness-outer-epoch": cmd_harness_outer_epoch,
        "harness-self-evolve": cmd_harness_self_evolve,
        "harness-self-supervise": cmd_harness_self_supervise,
        "harness-bench-loop-init": cmd_harness_bench_loop_init,
        "harness-bench-loop-step": cmd_harness_bench_loop_step,
        "harness-bench-loop-run": cmd_harness_bench_loop_run,
        "harness-eval-public": cmd_harness_eval_public,
        "agentx-nested-init": cmd_agentx_nested_init,
        "agentx-nested-epoch": cmd_agentx_nested_epoch,
    }
    try:
        return handlers[args.command](args)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
