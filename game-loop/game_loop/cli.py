from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from game_loop.benchmarks import load_adapter
from game_loop.core.attribution import AttributionReport, TrajectoryAttributor
from game_loop.core.agentx_runtime import AgentXRuntimeConfig, build_agentx_nested_evolution
from game_loop.config import HarnessEvolutionConfig
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
from game_loop.utils import atomic_write_json, read_json, utc_now


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
    self_evolve.add_argument("--cases", type=int, default=5)
    self_evolve.add_argument("--task-source", type=Path, required=True)
    self_evolve.add_argument("--seed-artifact", type=Path, required=True)
    self_evolve.add_argument("--seed-score", type=float, default=0.0)
    self_evolve.add_argument("--run-id-prefix", default="e")

    self_supervise = sub.add_parser("harness-self-supervise")
    self_supervise.add_argument("--outer-dir", type=Path, required=True)
    self_supervise.add_argument("--config", type=Path, required=True)
    self_supervise.add_argument("--task-source", type=Path, required=True)
    self_supervise.add_argument("--seed-artifact", type=Path, required=True)
    self_supervise.add_argument("--seed-score", type=float, default=0.0)
    self_supervise.add_argument("--run-id-prefix", default="e")
    self_supervise.add_argument("--start-epoch", type=int, default=1)
    self_supervise.add_argument("--max-epochs", type=int, default=200)
    self_supervise.add_argument("--cases", type=int, default=5)
    self_supervise.add_argument("--heartbeat-seconds", type=int, default=30)
    self_supervise.add_argument("--ui-port", type=int, default=8765)

    agentx_init = sub.add_parser("agentx-nested-init")
    agentx_init.add_argument("--run-dir", type=Path, required=True)
    agentx_init.add_argument("--config", type=Path, required=True)
    agentx_init.add_argument("--inner-config", type=Path)
    agentx_init.add_argument("--outer-config", type=Path)

    agentx_epoch = sub.add_parser("agentx-nested-epoch")
    agentx_epoch.add_argument("--run-dir", type=Path, required=True)
    agentx_epoch.add_argument("--config", type=Path, required=True)
    agentx_epoch.add_argument("--epoch", type=int, required=True)
    agentx_epoch.add_argument("--task-source", type=Path, required=True)
    agentx_epoch.add_argument("--seed-artifact", type=Path, required=True)
    agentx_epoch.add_argument("--seed-score", type=float, default=0.0)
    agentx_epoch.add_argument("--inner-cases", type=int, default=2)
    agentx_epoch.add_argument("--outer-cases", type=int, default=2)
    agentx_epoch.add_argument("--attribution-runs", type=Path, nargs="*")

    return parser


# ── init / evolve / outer-init / outer-epoch ──────────────────────────

def cmd_init(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    adapter = load_adapter(config.benchmark.adapter, config.benchmark.options)
    harness_profile = (
        HarnessProfile.from_dict(json.loads(args.harness_profile.read_text(encoding="utf-8")))
        if args.harness_profile is not None
        else None
    )
    seed_score = float(args.seed_score)
    LoopController.initialize(
        run_dir=args.run_dir,
        task_source=args.task_source,
        seed_artifact=args.seed_artifact,
        seed_evaluation=EvaluationResult(seed_score, True, {"quality": seed_score}),
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
    engine = HarnessEvolutionEngine(outer_dir, config.method.harness_evolution)
    runner = CommandHarnessReplayRunner(
        runs_root=outer_dir / "replays",
        project_root=Path(__file__).resolve().parents[1],
    )

    return run_harness_self_evolution(
        engine=engine,
        runner=runner,
        outer_dir=outer_dir,
        config=config,
        task_source=args.task_source,
        seed_artifact=args.seed_artifact,
        seed_score=float(args.seed_score),
        epoch=args.epoch,
        num_cases=args.cases,
        run_id_prefix=args.run_id_prefix,
    )


def run_harness_self_evolution(
    *,
    engine: HarnessEvolutionEngine,
    runner: CommandHarnessReplayRunner,
    outer_dir: Path,
    config: AppConfig,
    task_source: Path,
    seed_artifact: Path,
    seed_score: float,
    epoch: int,
    num_cases: int,
    run_id_prefix: str,
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

    # ── resume: reuse existing plan if available ──
    existing_plan = None
    existing_plan_path = outer_dir / f"harness_self_evolution_plan_{epoch:03d}.json"
    if existing_plan_path.is_file():
        existing_plan = read_json(existing_plan_path)

    # ── build gradient ──
    gradient = _build_dynamic_gradient(outer_dir, epoch, parent)

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

    for case_idx in range(num_cases):
        case_id = f"e{epoch:03d}_{case_idx + 1:02d}"
        case_dir = outer_dir / "admission_runs" / case_id

        # Run paired admission case (parent + candidate on same task)
        result = _run_paired_harness_admission_case(
            case_id=case_id,
            case_dir=case_dir,
            parent=parent,
            candidate=candidate,
            engine=engine,
            runner=runner,
            outer_dir=outer_dir,
            config=config,
            task_source=task_source,
            seed_artifact=seed_artifact,
            seed_score=seed_score,
            epoch=epoch,
            run_id_prefix=run_id_prefix,
        )

        if result is not None:
            parent_outcomes.append(result["parent"])
            candidate_outcomes.append(result["candidate"])

    # ── assess epoch ──
    result = engine.assess_epoch(
        epoch=epoch,
        parent=parent,
        candidate=candidate,
        parent_outcomes=parent_outcomes,
        candidate_outcomes=candidate_outcomes,
    )
    engine.record_epoch(result)

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
    task_source: Path,
    seed_artifact: Path,
    seed_score: float,
    epoch: int,
    run_id_prefix: str,
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
            print(f"[{case_id}] skip: paired_admission.json already exists")
            return None

    # ── run parent ──
    parent_run_dir = case_dir / "parent"
    parent_outcome = _run_harness_admission_case(
        case_id=f"{case_id}_parent",
        case_dir=parent_run_dir,
        harness=parent,
        runner=runner,
        outer_dir=outer_dir,
        config=config,
        task_source=task_source,
        seed_artifact=seed_artifact,
        seed_score=seed_score,
        epoch=epoch,
        run_id_prefix=run_id_prefix,
    )

    # ── run candidate ──
    candidate_run_dir = case_dir / "candidate"
    candidate_outcome = _run_harness_admission_case(
        case_id=f"{case_id}_candidate",
        case_dir=candidate_run_dir,
        harness=candidate,
        runner=runner,
        outer_dir=outer_dir,
        config=config,
        task_source=task_source,
        seed_artifact=seed_artifact,
        seed_score=seed_score,
        epoch=epoch,
        run_id_prefix=run_id_prefix,
    )

    # ── compute paired result ──
    parent_score = parent_outcome.final_score
    candidate_score = candidate_outcome.final_score
    delta = None
    passed = False
    reason = ""

    if parent_score is not None and candidate_score is not None:
        delta = candidate_score - parent_score
        passed = delta >= -engine.config.max_case_regression
        reason = f"cand={candidate_score:.4f} parent={parent_score:.4f} delta={delta:.4f}"
    elif parent_outcome.infrastructure_ok and candidate_outcome.infrastructure_ok:
        reason = "parent admission evidence missing"
    else:
        reason = "infrastructure failure in one or both sides"

    paired = {
        "case_id": case_id,
        "parent_harness_id": parent.harness_id,
        "candidate_harness_id": candidate.harness_id,
        "parent_score": parent_score,
        "candidate_score": candidate_score,
        "delta": delta,
        "passed": passed,
        "reason": reason,
        "created_at": utc_now(),
    }
    atomic_write_json(paired_path, paired)

    print(f"[{case_id}] paired: passed={passed} delta={delta} reason={reason}")

    return {"parent": parent_outcome, "candidate": candidate_outcome}


def _run_harness_admission_case(
    *,
    case_id: str,
    case_dir: Path,
    harness: HarnessProfile,
    runner: CommandHarnessReplayRunner,
    outer_dir: Path,
    config: AppConfig,
    task_source: Path,
    seed_artifact: Path,
    seed_score: float,
    epoch: int,
    run_id_prefix: str,
) -> HarnessEpisodeOutcome:
    """Run a single admission case for one harness (parent or candidate).

    Uses the game-loop init + evolve pipeline with the given harness profile
    frozen for the entire episode.
    """
    # ── resume: keep case dir if already completed ──
    if case_dir.exists() and any(case_dir.iterdir()):
        state_path = case_dir / "state.json"
        should_wipe = True
        if state_path.is_file():
            st = json.loads(state_path.read_text(encoding="utf-8"))
            if str(st.get("status") or "") in ("loop_ready_for_benchmark",):
                should_wipe = False
        if should_wipe:
            shutil.rmtree(case_dir)
            case_dir.mkdir(parents=True, exist_ok=True)

    # ── write harness profile ──
    profile_path = case_dir / "harness_profile.json"
    atomic_write_json(profile_path, harness.to_dict())

    # ── write a temporary config ──
    config_path = case_dir / "config.json"
    atomic_write_json(config_path, {
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
                    {"module_id": m.module_id, "tags": list(m.tags), "instruction": m.instruction}
                    for m in config.method.harness_evolution.modules
                ],
                "tool_interfaces": [
                    {
                        "interface_id": t.interface_id,
                        "kind": t.kind,
                        "description": t.description,
                        "command": list(t.command),
                        "cwd": str(t.cwd) if t.cwd else None,
                        "env": dict(t.env),
                        "safety_scope": t.safety_scope,
                        "tags": list(t.tags),
                    }
                    for t in config.method.harness_evolution.tool_interfaces
                ],
                "seed_modules": list(config.method.harness_evolution.seed_modules),
                "seed_tool_interfaces": list(config.method.harness_evolution.seed_tool_interfaces),
                "max_active_modules": config.method.harness_evolution.max_active_modules,
                "max_active_tool_interfaces": config.method.harness_evolution.max_active_tool_interfaces,
                "mutation_width": config.method.harness_evolution.mutation_width,
                "replay_min_cases": config.method.harness_evolution.replay_min_cases,
                "promotion_delta_min": config.method.harness_evolution.promotion_delta_min,
                "max_case_regression": config.method.harness_evolution.max_case_regression,
            },
        },
        "experiment": {"arm": "L4", "freezes_harness_outer_loop": True},
    })

    # ── init ──
    run_id = f"{run_id_prefix}{epoch:03d}_{case_id}"
    init_args = argparse.Namespace(
        run_dir=case_dir,
        task_source=task_source,
        seed_artifact=seed_artifact,
        config=config_path,
        run_id=run_id,
        seed_score=seed_score,
        cold_start=False,
        harness_profile=profile_path,
    )
    cmd_init(init_args)

    # ── evolve ──
    evolve_args = argparse.Namespace(
        run_dir=case_dir,
        config=config_path,
    )
    cmd_evolve(evolve_args)

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
) -> HarnessSemanticGradient:
    """Build a semantic gradient for the current epoch based on historical evidence.

    Analyzes past epoch results to determine which harness niches need attention.
    """
    epochs_path = outer_dir / "harness_archive" / "epochs.json"
    if not epochs_path.is_file():
        return HarnessSemanticGradient(
            diagnosis=f"initial epoch {epoch}: explore all niches",
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
        return HarnessSemanticGradient(
            diagnosis=f"epoch {epoch}: address rejected niches {target}",
            target_tags=tuple(target),
        )

    # Round-robin through niches
    niche_idx = (epoch - 1) % len(all_niches)
    return HarnessSemanticGradient(
        diagnosis=f"epoch {epoch}: explore {all_niches[niche_idx]}",
        target_tags=(all_niches[niche_idx],),
    )


def _build_dynamic_harness_admission_rubric(
    outer_dir: Path,
    epoch: int,
) -> dict[str, Any]:
    """Build the admission rubric for harness self-evolution cases.

    Returns a dict with rubric criteria used by the loop-owned playtest evaluator.
    """
    return {
        "rubric_version": "harness-self-evolve-v1",
        "epoch": epoch,
        "criteria": {
            "build_success": {"weight": 0.30, "description": "Game builds without errors"},
            "runtime_stability": {"weight": 0.20, "description": "Game runs without crashes"},
            "feature_completeness": {"weight": 0.25, "description": "Core gameplay features present"},
            "code_quality": {"weight": 0.15, "description": "Code structure and readability"},
            "playability": {"weight": 0.10, "description": "Game is actually playable"},
        },
        "pass_threshold": 0.50,
        "benchmark_evaluator_used": False,
        "evaluator": "harness_owned_loop_playtest_v1",
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
    runner = CommandHarnessReplayRunner(
        runs_root=outer_dir / "replays",
        project_root=Path(__file__).resolve().parents[1],
    )

    heartbeat_path = outer_dir / ".supervisor_heartbeat.json"
    pid_path = outer_dir / ".supervisor.pid"

    # Write PID
    atomic_write_json(pid_path, {"pid": os.getpid(), "started_at": utc_now()})

    current_epoch = args.start_epoch
    max_epochs = args.max_epochs

    print(f"[supervisor] PID={os.getpid()} start_epoch={current_epoch} max_epochs={max_epochs}")

    try:
        while current_epoch <= max_epochs:
            # ── heartbeat ──
            atomic_write_json(heartbeat_path, {
                "pid": os.getpid(),
                "current_epoch": current_epoch,
                "phase": "running",
                "updated_at": utc_now(),
            })

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
            atomic_write_json(heartbeat_path, {
                "pid": os.getpid(),
                "current_epoch": current_epoch,
                "phase": f"epoch_{current_epoch}",
                "updated_at": utc_now(),
            })

            try:
                result_code = run_harness_self_evolution(
                    engine=engine,
                    runner=runner,
                    outer_dir=outer_dir,
                    config=config,
                    task_source=args.task_source,
                    seed_artifact=args.seed_artifact,
                    seed_score=float(args.seed_score),
                    epoch=current_epoch,
                    num_cases=args.cases,
                    run_id_prefix=args.run_id_prefix,
                )
                print(f"[supervisor] epoch {current_epoch} completed with code {result_code}")
            except Exception as exc:
                print(f"[supervisor] epoch {current_epoch} failed: {exc}", file=sys.stderr)
                import traceback
                traceback.print_exc()

            current_epoch += 1

            # Brief pause between epochs
            time.sleep(2)

    except KeyboardInterrupt:
        print("[supervisor] received SIGINT, shutting down")
    finally:
        atomic_write_json(heartbeat_path, {
            "pid": os.getpid(),
            "current_epoch": current_epoch - 1,
            "phase": "stopped",
            "updated_at": utc_now(),
        })
        if pid_path.exists():
            pid_path.unlink()

    return 0


# ── agentx nested evolution ───────────────────────────────────────────

def cmd_agentx_nested_init(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    if config.method.harness_evolution is None:
        raise ValueError("agentx nested init requires L4 harness_evolution config")
    inner_cfg = (
        HarnessEvolutionConfig.from_dict(read_json(args.inner_config))
        if args.inner_config is not None
        else config.method.harness_evolution
    )
    outer_cfg = (
        HarnessEvolutionConfig.from_dict(read_json(args.outer_config))
        if args.outer_config is not None
        else config.method.harness_evolution
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
    )
    coordinator.initialize()
    return 0


def cmd_agentx_nested_epoch(args: argparse.Namespace) -> int:
    config = AppConfig.load(args.config)
    if config.method.harness_evolution is None:
        raise ValueError("agentx nested epoch requires L4 harness_evolution config")
    coordinator = build_agentx_nested_evolution(
        run_dir=args.run_dir.resolve(),
        runtime=AgentXRuntimeConfig(
            inner_harness=config.method.harness_evolution,
            outer_harness=config.method.harness_evolution,
            app_config=config,
            task_source=args.task_source.resolve(),
            seed_artifact=args.seed_artifact.resolve(),
            seed_score=float(args.seed_score),
        ),
        init_handler=cmd_init,
        evolve_handler=cmd_evolve,
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
    inner_cases = tuple(
        HarnessReplayCase(
            f"inner-{index + 1:02d}",
            str(args.task_source.resolve()),
            str(args.seed_artifact.resolve()),
            metadata={"seed_score": float(args.seed_score), "config_path": str(args.config.resolve())},
        )
        for index in range(max(1, int(args.inner_cases)))
    )
    outer_cases = tuple(
        HarnessReplayCase(
            f"outer-{index + 1:02d}",
            str(args.task_source.resolve()),
            str(args.seed_artifact.resolve()),
            metadata={"seed_score": float(args.seed_score), "config_path": str(args.config.resolve())},
        )
        for index in range(max(1, int(args.outer_cases)))
    )
    for case in (*inner_cases, *outer_cases):
        case.metadata.setdefault("config_path", str(args.config.resolve()))
    result = coordinator.run_epoch(
        epoch=int(args.epoch),
        report=report,
        inner_cases=inner_cases,
        outer_cases=outer_cases,
    )
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
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
