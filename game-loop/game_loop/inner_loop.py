from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from game_loop.benchmarks import load_adapter
from game_loop.runtime import (
    CommandEvaluatorProfile,
    CommandEvaluatorRunner,
    GameTask,
    InnerLoopPipeline,
    OpenGameRuntime,
    OpenGameRuntimeConfig,
    doctor_all_providers,
    load_provider,
    smoke_provider,
)
from game_loop.utils import read_json, sha256_json


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m game_loop.inner_loop",
        description="Run one isolated game-making episode with OpenGame.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run")
    run.add_argument("--benchmark", required=True)
    run.add_argument("--task-source", type=Path, required=True)
    run.add_argument("--seed-artifact", type=Path)
    run.add_argument("--run-dir", type=Path, required=True)
    run.add_argument("--profile", type=Path, required=True)
    run.add_argument("--task-id")
    prompts = run.add_mutually_exclusive_group()
    prompts.add_argument("--prompt")
    prompts.add_argument("--prompt-file", type=Path)
    run.add_argument("--artifact-relpath", default=".")
    run.add_argument("--benchmark-options", type=Path)
    run.add_argument("--evaluator-profile", type=Path)
    doctor = subparsers.add_parser("doctor")
    doctor.add_argument("--profile", type=Path, required=True)
    providers = subparsers.add_parser("doctor-providers")
    providers.add_argument("--provider", choices=("deepseek", "kimi", "glm", "qwen"))
    smoke = subparsers.add_parser("smoke-provider")
    smoke.add_argument("--provider", required=True, choices=("deepseek", "kimi", "glm", "qwen"))
    smoke.add_argument("--timeout", type=int, default=60)
    return parser


def _prompt(args: argparse.Namespace) -> str:
    if args.prompt is not None:
        return str(args.prompt)
    if args.prompt_file is not None:
        return args.prompt_file.resolve().read_text(encoding="utf-8")
    task_source = args.task_source.resolve()
    if task_source.is_file():
        return task_source.read_text(encoding="utf-8")
    raise ValueError("directory task sources require --prompt or --prompt-file")


def run_command(args: argparse.Namespace) -> Path:
    task_source = args.task_source.resolve()
    if not task_source.exists():
        raise FileNotFoundError(f"task source does not exist: {task_source}")
    seed = None if args.seed_artifact is None else args.seed_artifact.resolve()
    if seed is not None and not seed.exists():
        raise FileNotFoundError(f"seed artifact does not exist: {seed}")
    prompt = _prompt(args)
    task_id = args.task_id or (
        f"{args.benchmark}-"
        + sha256_json({"task_source": str(task_source), "prompt": prompt})[:12]
    )
    task = GameTask(
        task_id=task_id,
        benchmark_id=str(args.benchmark),
        prompt=prompt,
        task_source_ref=str(task_source),
        workspace_seed_ref=None if seed is None else str(seed),
        artifact_relpath=str(args.artifact_relpath),
    )
    profile = OpenGameRuntimeConfig.from_dict(read_json(args.profile.resolve()))
    episode_dir = args.run_dir.resolve()
    if args.evaluator_profile is None:
        OpenGameRuntime(profile).run(task, episode_dir=episode_dir)
        return episode_dir / "submission.json"
    adapter_options = (
        {} if args.benchmark_options is None else read_json(args.benchmark_options.resolve())
    )
    evaluator = CommandEvaluatorRunner(
        CommandEvaluatorProfile.from_dict(read_json(args.evaluator_profile.resolve()))
    )
    pipeline = InnerLoopPipeline(
        adapter=load_adapter(str(args.benchmark), adapter_options),
        runtime_config=profile,
        evaluator_runner=evaluator,
    )
    pipeline.run(task, run_dir=episode_dir)
    return episode_dir / "maker" / "submission.json"


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "run":
        submission = run_command(args)
        print(json.dumps({"submission": str(submission)}, ensure_ascii=False))
        # A manifest path only means the episode was recorded.  Propagate the
        # maker outcome so CI/smoke tests cannot mistake a failed OpenGame run
        # for a successful game submission.
        recorded = read_json(submission)
        return 0 if recorded.get("status") == "completed" else 1
    if args.command == "doctor":
        profile = OpenGameRuntimeConfig.from_dict(read_json(args.profile.resolve()))
        report = OpenGameRuntime(profile).doctor()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report.get("sdk_importable") else 1
    if args.command == "doctor-providers":
        reports = (
            [load_provider(args.provider).resolve().doctor()]
            if args.provider
            else doctor_all_providers()
        )
        print(json.dumps({"providers": reports}, ensure_ascii=False, indent=2))
        return 0 if all(item["ready"] for item in reports) else 1
    if args.command == "smoke-provider":
        report = smoke_provider(args.provider, timeout_seconds=args.timeout)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report["ok"] else 1
    raise AssertionError(f"unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
