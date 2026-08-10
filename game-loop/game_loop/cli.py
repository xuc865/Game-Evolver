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
    self_supervise.add_argument("--skip-rubric-validation", action="store_true")
    self_supervise.add_argument("--heartbeat-seconds", type=int, default=30)
    self_supervise.add_argument("--ui-port", type=int, default=8765)

    agentx_init = sub.add_parser("agentx-nested-init")
    agentx_init.add_argument("--run-dir", type=Path, required=True)
    agentx_init.add_argument("--config", type=Path, required=True)
    agentx_init.add_argument("--inner-config", type=Path)
    agentx_init.add_argument("--outer-config", type=Path)
    agentx_init.add_argument("--bench", default="gcbench")

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
    engine = HarnessEvolutionEngine(outer_dir, harness_cfg)
    runner = CommandHarnessReplayRunner(
        runs_root=outer_dir / "replays",
        project_root=Path(__file__).resolve().parents[1],
    )
    task_pool = _task_pool_from_args(
        task_pool_path=args.task_pool,
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
    sampled_cases = sample_task_pool(
        task_pool,
        sample_size=sample_size,
        seed=epoch,
        prefix=f"e{epoch:03d}",
    )

    # ── resume: reuse existing plan if available ──
    existing_plan = None
    existing_plan_path = outer_dir / f"harness_self_evolution_plan_{epoch:03d}.json"
    if existing_plan_path.is_file():
        existing_plan = read_json(existing_plan_path)

    # ── build gradient ──
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

    # ── propose or reuse candidate ──
    if (existing_plan
            and existing_plan.get("parent_harness_id") == parent.harness_id
            and existing_plan.get("candidate_harness_id")):
        candidate = engine.get(existing_plan["candidate_harness_id"])
        print(f"[resume] reusing candidate {candidate.harness_id} from existing plan")
    else:
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
            "gradient": gradient.to_dict(),
            "num_cases": num_cases,
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
    if not rubric_validation.get("infrastructure_ok", True):
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
    if not result.accepted:
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
    case_dir.mkdir(parents=True, exist_ok=True)

    # ── resume: skip if paired_admission.json already exists ──
    paired_path = case_dir / "paired_admission.json"
    if paired_path.is_file():
        existing = json.loads(paired_path.read_text(encoding="utf-8"))
        if isinstance(existing, dict) and existing.get("candidate_harness_id") == candidate.harness_id:
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
            if manifest.get("config_fingerprint") != config.fingerprint:
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
            if status == "completed":
                return load_episode_outcome(
                    case_id=case_id,
                    harness_id=harness.harness_id,
                    run_dir=case_dir,
                )
            if status in _ADMISSION_RESUMABLE_STATUSES:
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
    items = epochs_data.get("items", [])

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
    prior_proposals: list[dict[str, Any]] = []
    existing_proposal_dir = outer_dir / "harness_proposals"
    if existing_proposal_dir.is_dir():
        for path in sorted(existing_proposal_dir.glob("epoch_*.json"))[-6:]:
            value = read_json(path)
            if isinstance(value.get("selected"), dict):
                prior_proposals.append(dict(value["selected"]))
    compatible = []
    for spec in engine.elements.values():
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
        if active_counts.get(spec.category, 0) >= engine.config.max_active_elements.get(spec.category, 1):
            continue
        compatible.append({
            "id": spec.element_id,
            "category": spec.category,
            "description": spec.description,
            "tags": list(spec.tags),
        })
    if not compatible:
        raise RuntimeError("no benchmark-compatible harness elements available")

    memory = HarnessEvolutionMemory(outer_dir / "harness_archive")
    memory_hint = memory.render_proposer_context(loop_role=engine.config.loop_role)
    epochs_path = outer_dir / "harness_archive" / "epochs.json"
    recent_epochs = []
    if epochs_path.is_file():
        recent_epochs = list(read_json(epochs_path).get("items", []))[-4:]
    prompt = {
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
        "compatible_catalog": compatible,
        "recent_epoch_results": recent_epochs,
        "recent_proposals": prior_proposals,
        "reusable_rejection_memory": memory_hint,
        "task": (
            "Choose exactly one concrete catalog element whose activation is most likely "
            "to improve game quality on this benchmark. Avoid repeating a recently "
            "rejected proposal unless new evidence justifies it. "
            "Do not choose an element for another engine or any visual/image/video tool "
            "when text_only is true. Return JSON only with diagnosis, category, element_id."
        ),
        "schema": {
            "diagnosis": "short evidence-grounded reason",
            "category": "skill|mcp|tool|context|protocol|workflow",
            "element_id": "one id from compatible_catalog",
        },
    }
    model_name = model.casefold()
    proposer_max_tokens = 256 if "qwen" in model_name else 1200
    proposer_timeout = int(os.environ.get("GAME_LOOP_HARNESS_PROPOSER_TIMEOUT_SECONDS", "120"))
    proposer_attempts = int(os.environ.get("GAME_LOOP_HARNESS_PROPOSER_ATTEMPTS", "4"))
    payload_body: dict[str, Any] = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are the harness-improvement agent. Make one cautious AgentX-style "
                    "local mutation. Output a single JSON object and no prose."
                ),
            },
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ],
        "temperature": 0.2,
        "max_tokens": proposer_max_tokens,
        "stream": False,
    }
    if "qwen" in model_name or "glm" in model_name:
        # Qwen/GLM reasoning can consume the entire structured-output budget
        # before emitting content.  This vLLM-compatible flag is verified by
        # the production endpoints and keeps the proposer response auditable.
        payload_body["chat_template_kwargs"] = {"enable_thinking": False}
    payload = json.dumps(payload_body).encode("utf-8")
    proposal_dir = outer_dir / "harness_proposals"
    proposal_dir.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    selected: dict[str, Any] | None = None
    proposal_path = proposal_dir / f"epoch_{epoch:03d}.json"
    record: dict[str, Any] = {
        "schema_version": "llm-harness-proposal.v1",
        "epoch": epoch,
        "benchmark": config.benchmark.adapter,
        "model": model,
        "parent_harness_id": parent.harness_id,
        "status": "requesting",
        "attempt": 0,
        "max_attempts": proposer_attempts,
        "max_tokens": proposer_max_tokens,
        "selected": None,
        "errors": [],
        "created_at": utc_now(),
    }
    atomic_write_json(proposal_path, record)
    for attempt in range(1, proposer_attempts + 1):
        record.update(status="requesting", attempt=attempt, errors=list(errors))
        atomic_write_json(proposal_path, record)
        request = urllib.request.Request(
            base_url + "/chat/completions",
            data=payload,
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
            candidate = _extract_model_json(str(content))
            element_id = str(candidate.get("element_id", "")).strip()
            category = str(candidate.get("category", "")).strip().casefold()
            match = next(
                (item for item in compatible if item["id"] == element_id),
                None,
            )
            if match is None or match["category"] != category:
                raise ValueError("proposer selected an incompatible or category-mismatched element")
            if element_id in active_ids:
                raise ValueError("proposer selected an already-active element")
            selected = {
                "diagnosis": str(candidate.get("diagnosis", "")).strip()
                or f"activate {element_id}",
                "category": category,
                "element_id": element_id,
            }
            record.update(status="completed", selected=selected, errors=list(errors))
            atomic_write_json(proposal_path, record)
            break
        except (OSError, TimeoutError, KeyError, IndexError, json.JSONDecodeError, ValueError) as exc:
            errors.append(f"attempt {attempt}: {type(exc).__name__}: {exc}")
            record.update(status="retrying", errors=list(errors))
            atomic_write_json(proposal_path, record)
            if attempt < proposer_attempts:
                time.sleep(min(8, attempt * 2))
    if selected is None:
        selected = _fallback_harness_proposal(compatible, prior_proposals)
        errors.append(
            "using deterministic compatible-catalog fallback after structured proposer failure"
        )
        record.update(status="fallback_completed", selected=selected, errors=list(errors))
        atomic_write_json(proposal_path, record)
    tags = [selected["category"], "usage_driven", "element_add", f"element_id:{selected['element_id']}"]
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
    engine = HarnessEvolutionEngine(outer_dir, config.method.harness_evolution)
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
                task_pool = _task_pool_from_args(
                    task_pool_path=args.task_pool,
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
