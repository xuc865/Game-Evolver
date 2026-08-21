from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from game_loop.runtime import GameTask, MakerRuntime, build_runtime, load_runtime_config
from game_loop.utils import atomic_write_json

from .ggv_contract import CommandGGVWorker, GGVWorker, run_paper_compatible_ggv
from .runtime_config import runtime_config_from_environment


def run_bridge(
    *,
    runtime: MakerRuntime,
    agent_workspace: Path,
    instruction_file: Path,
    public_task_root: Path,
    output_manifest: Path,
    worker: GGVWorker | None,
) -> int:
    """Run the sole maker runtime, then evaluate outside its episode."""
    output_manifest = output_manifest.resolve()
    bridge_root = output_manifest.parent / "verigame_bridge"
    task = GameTask(
        task_id=public_task_root.resolve().name or "verigame-task",
        benchmark_id="verigame",
        prompt=instruction_file.resolve().read_text(encoding="utf-8"),
        task_source_ref=str(public_task_root.resolve()),
        workspace_seed_ref=str(agent_workspace.resolve()),
        artifact_relpath=".",
        constraints={
            "engine": "web",
            "runtime_state_injection_required": True,
            "bounded_interaction_evidence_required": True,
            "official_gamegen_verifier_implementation": False,
        },
    )
    submission = runtime.run(task, episode_dir=bridge_root / "maker_episode")
    artifact = Path(submission.artifact_ref) if submission.artifact_ref else None
    salvage_note = None
    if artifact is None and submission.status != "completed":
        artifact = _salvage_workspace_artifact(submission)
        if artifact is not None:
            salvage_note = "artifact_salvaged_after_runtime_failure"
    evaluation_dir = bridge_root / "evaluation"
    evaluation_path = evaluation_dir / "result.json"

    specification_path = public_task_root.resolve() / "specification.md"
    if artifact is None:
        evaluation = _infrastructure_failure("maker runtime did not produce a VeriGame artifact")
    elif worker is None:
        evaluation = _infrastructure_failure(
            "GameGen-Verifier worker is not configured; no positive fallback is permitted"
        )
    elif not specification_path.is_file():
        evaluation = _infrastructure_failure("public specification.md is missing")
    else:
        evaluation = run_paper_compatible_ggv(
            specification_path=specification_path,
            artifact_dir=artifact,
            work_dir=evaluation_dir / "units",
            worker=worker,
        )
    atomic_write_json(evaluation_path, evaluation)
    status = str(evaluation["status"])
    atomic_write_json(
        output_manifest,
        {
            "schema_version": "benchmark-execution-v1",
            "benchmark": "verigame",
            "evaluator_implementation": "paper-compatible-plugin-contract-not-official-code",
            "status": status,
            "artifact_dir": "" if artifact is None else str(artifact.resolve()),
            "evaluation_path": str(evaluation_path),
            "submission": submission.to_dict(),
            "diagnostics": [] if salvage_note is None else [salvage_note],
        },
    )
    return 0 if status == "completed" else 2


def _salvage_workspace_artifact(submission) -> Path | None:
    """Use a real workspace artifact when the SDK timed out after writing files."""
    metadata = getattr(submission, "metadata", {})
    if not isinstance(metadata, dict):
        return None
    episode_root = metadata.get("episode_root")
    if not isinstance(episode_root, str) or not episode_root.strip():
        return None
    workspace = (Path(episode_root) / "workspace").resolve()
    if not workspace.is_dir() or not _has_verigame_artifact(workspace):
        return None
    return workspace


def _has_verigame_artifact(workspace: Path) -> bool:
    if (workspace / "index.html").is_file() or (workspace / "game.html").is_file():
        return True
    if (workspace / "package.json").is_file() and any(
        path.is_file() for path in (workspace / "src").rglob("*")
    ):
        return True
    return False


def _infrastructure_failure(error: str) -> dict[str, object]:
    return {
        "schema_version": "benchmark-evaluation-v1",
        "benchmark": "verigame",
        "implementation": "paper-compatible-plugin-contract-not-official-code",
        "status": "infrastructure_failure",
        "primary_score": None,
        "objectives": {},
        "constraints": {
            "keypoints_complete": False,
            "state_injection_complete": False,
            "bounded_interactions_complete": False,
            "evidence_complete": False,
            "judge_complete": False,
        },
        "error": error,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one maker runtime, then apply a paper-compatible VeriGame evaluator"
    )
    parser.add_argument("--agent-workspace", type=Path, required=True)
    parser.add_argument("--instruction-file", type=Path, required=True)
    parser.add_argument("--task-root", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--runtime-config-json")
    parser.add_argument("--backbone-provider")
    parser.add_argument(
        "--worker-command-json",
        default=os.environ.get("GAMEGEN_VERIFIER_WORKER_COMMAND_JSON", ""),
    )
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--worker-timeout", type=int, default=1800)
    args = parser.parse_args(argv)

    config = runtime_config_from_environment(
        provider=args.backbone_provider,
        timeout_seconds=args.timeout,
    )
    if args.runtime_config_json:
        config = load_runtime_config(json.loads(args.runtime_config_json))
        config = load_runtime_config(
            {**config.to_dict(), "timeout_seconds": args.timeout}
        )
    worker: GGVWorker | None = None
    if args.worker_command_json:
        command = json.loads(args.worker_command_json)
        if not isinstance(command, list) or not all(isinstance(item, str) for item in command):
            raise ValueError("worker command must be a JSON string list")
        worker = CommandGGVWorker(
            tuple(command), cwd=args.output_manifest.resolve().parent, timeout_seconds=args.worker_timeout
        )
    return run_bridge(
        runtime=build_runtime(config),
        agent_workspace=args.agent_workspace,
        instruction_file=args.instruction_file,
        public_task_root=args.task_root,
        output_manifest=args.output_manifest,
        worker=worker,
    )


if __name__ == "__main__":
    raise SystemExit(main())
