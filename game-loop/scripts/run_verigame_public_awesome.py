#!/usr/bin/env python3
"""Run the awesome-skills arm against the official GameGen-Verifier harness.

This is a generation benchmark, never an evolution job.  The selected model
generates one game from each public specification, while a fixed Codex backend
distills shared keypoints and executes the released GGV-Harness evaluator.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.benchmarks.runtime_config import runtime_config_from_environment
from game_loop.runtime import GameTask, OpenGameRuntime, OpenGameRuntimeConfig


OFFICIAL = ROOT / "third_party" / "GameGen-Verifier"
TASKS = OFFICIAL / "spec"
SEED = ROOT / "experiments" / "public_baseline_seeds" / "verigame"
OFFICIAL_WRAPPER = ROOT / "scripts" / "run_gamegen_verifier_official.py"
PROVIDERS = {
    "kimi": "Kimi-K2.7-Code",
    "qwen": "Qwen3.6-27B",
    "glm": "GLM-5.2-W4AFP8",
    "deepseek": "deepseek-v4-flash",
}
REQUIRED_ARTIFACTS = ("package.json", "src", "data.md", "state_injection_api.md")
MAX_GENERATION_SESSION_TURNS = 120
MAX_GENERATION_SECONDS = 1800
PROGRESS_NOTICE_PATH = Path("/Users/wangxucong/Desktop/workspace/progress.txt")
DEFAULT_KEYPOINT_SAMPLE_SIZE = 10
KEYPOINT_HEADING = re.compile(r"^## Keypoint\s+([^:]+):", re.MULTILINE)


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def append_progress_notice(
    item: dict,
    *,
    attempted_count: int,
    completed_count: int,
    progress_path: Path = PROGRESS_NOTICE_PATH,
) -> bool:
    """Append one concurrency-safe, idempotent notice for a finished task attempt."""

    attempt_root = Path(str(item.get("attempt_root", "")))
    if not attempt_root.is_dir() or attempted_count <= 0:
        return False
    marker = attempt_root / "progress_notice.done"
    marker.parent.mkdir(parents=True, exist_ok=True)
    with marker.open("a+", encoding="utf-8") as marker_file:
        fcntl.flock(marker_file.fileno(), fcntl.LOCK_EX)
        marker_file.seek(0)
        if marker_file.read().strip():
            return False
        accuracy = completed_count / attempted_count
        line = (
            f"{item.get('finished_at') or time.strftime('%Y-%m-%dT%H:%M:%S%z')} "
            "bench=gamegen-verifier-public arm=awesome-skill "
            f"task={item.get('task')} model={item.get('model')} status={item.get('status')} "
            f"cumulative_accuracy={completed_count}/{attempted_count} ({accuracy:.2%})\n"
        )
        progress_path.parent.mkdir(parents=True, exist_ok=True)
        with progress_path.open("a", encoding="utf-8") as progress_file:
            fcntl.flock(progress_file.fileno(), fcntl.LOCK_EX)
            progress_file.write(line)
            progress_file.flush()
            os.fsync(progress_file.fileno())
        marker_file.write(line)
        marker_file.flush()
        return True


def task_files() -> list[Path]:
    return sorted(TASKS.glob("*.md"))


def select_keypoints(keypoints: Path, task_name: str, sample_size: int) -> str:
    """Select a stable per-task subset so every provider is judged identically."""

    if sample_size <= 0:
        return ""
    identifiers = KEYPOINT_HEADING.findall(keypoints.read_text(encoding="utf-8"))
    if len(identifiers) <= sample_size:
        return ",".join(identifiers)
    seed = int.from_bytes(hashlib.sha256(task_name.encode("utf-8")).digest()[:8], "big")
    selected = set(random.Random(seed).sample(identifiers, sample_size))
    return ",".join(identifier for identifier in identifiers if identifier in selected)


def generation_prompt(specification: str) -> str:
    return (
        "# GameGen-Verifier public generation test\n\n"
        "Implement the supplied game specification as a runnable Vite/TypeScript web game. "
        "Use the available awesome game-development skills when relevant. This artifact will "
        "be tested by the released GameGen-Verifier harness.\n\n"
        "Hard output contract (all items are required):\n"
        "- Keep the complete game at the workspace root.\n"
        "- Provide package.json and a src/ directory.\n"
        "- Provide data.md documenting the complete serializable game-state schema.\n"
        "- Expose window.getGameState() and window.injectGameState(state).\n"
        "- Provide state_injection_api.md with exact TypeScript types, signatures, required "
        "fields, and minimal/complete examples.\n"
        "- State injection must deterministically update both internal state and rendered UI.\n"
        "- Do not create keypoints.md and do not write tests for the evaluator.\n"
        "- Finish only after npm build succeeds.\n\n"
        "Efficiency and early-stop contract (mandatory):\n"
        "- Work directly toward the required artifact; do not repeatedly reread the same "
        "documentation, inspect unrelated templates, or narrate progress.\n"
        "- Target no more than 45 tool calls. Implement the smallest complete game that "
        "faithfully satisfies the specification and state-injection contract.\n"
        "- Do one implementation pass. Do not repeatedly rewrite working files, restart the "
        "plan, or defer required files to a later phase. Create all required inputs early.\n"
        "- Run npm build once after implementation, then only rerun it when fixing a concrete "
        "build error. Do not add optional tests, polish, or assets after the build passes.\n"
        "- As soon as all four required artifact inputs exist and npm build passes, stop "
        "immediately and return the final response.\n\n"
        "## Public specification\n\n" + specification
    )


def generate(provider: str, task: Path, attempt_root: Path, timeout: int) -> tuple[Path | None, dict]:
    episode = attempt_root / "generation_episode"
    config = runtime_config_from_environment(
        provider=provider, timeout_seconds=min(timeout, MAX_GENERATION_SECONDS)
    )
    # The benchmark workspace is disposable and all four providers must receive
    # the same non-interactive tool policy.  The per-backbone auto-edit setting
    # otherwise rejects ordinary shell scaffolding commands.
    config_value = config.to_dict()
    config_value["permission_mode"] = "yolo"
    config_value["max_session_turns"] = MAX_GENERATION_SESSION_TURNS
    config_value["fallback_on_timeout"] = False
    config_value["exclude_tools"] = [
        name for name in config_value.get("exclude_tools", []) if name != "todo_write"
    ]
    config = OpenGameRuntimeConfig.from_dict(config_value)
    runtime = OpenGameRuntime(config)
    game_task = GameTask(
        task_id=f"verigame-{task.stem}",
        benchmark_id="gamegen-verifier-public",
        prompt=generation_prompt(task.read_text(encoding="utf-8")),
        task_source_ref=str(task.resolve()),
        workspace_seed_ref=str(SEED.resolve()),
        artifact_relpath=".",
        constraints={
            "experiment_type": "public_test",
            "evolution_enabled": False,
            "awesome_skills": True,
            "official_gamegen_verifier_inputs_required": True,
        },
    )
    submission = runtime.run(game_task, episode_dir=episode)
    artifact = Path(submission.artifact_ref) if submission.artifact_ref else None
    missing = [] if artifact is None else [name for name in REQUIRED_ARTIFACTS if not (artifact / name).exists()]
    status = "completed" if submission.status == "completed" and artifact is not None and not missing else "failed"
    result = {
        "status": status,
        "submission_status": submission.status,
        "artifact_dir": None if artifact is None else str(artifact.resolve()),
        "missing_official_inputs": missing,
        "diagnostics": list(submission.diagnostics),
        "usage": submission.usage,
        "metadata": submission.metadata,
    }
    write_json(attempt_root / "generation_result.json", result)
    return (artifact if status == "completed" else None), result


def _symlink(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(source.resolve(), target_is_directory=True)


def _keypoints_pass_official_lint(path: Path, log_path: Path) -> bool:
    if not path.is_file():
        return False
    with log_path.open("ab") as log:
        completed = subprocess.run(
            [
                str(OFFICIAL / ".venv" / "bin" / "python"),
                str(OFFICIAL / "scripts" / "prepare" / "lint_keypoints.py"),
                "--keypoints-file", str(path),
            ],
            cwd=ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=180,
            check=False,
        )
    return completed.returncode == 0


def ensure_shared_keypoints(task: Path, shared_root: Path, timeout: int) -> Path:
    """Distill one official-format keypoint set per spec and share it across models."""
    task = task.resolve()
    shared_root = shared_root.resolve()
    task_root = shared_root / task.stem
    keypoints = task_root / "keypoints.md"
    task_root.mkdir(parents=True, exist_ok=True)
    with (task_root / ".lock").open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if keypoints.is_file():
            return keypoints

        workspace = task_root / "distill_workspace"
        produced = workspace / "games" / task.stem / "keypoints.md"
        lint_log = task_root / "lint.log"
        # Codex can finish the file and then hit quota while emitting its final
        # response.  The released lint gate is authoritative for the artifact.
        if _keypoints_pass_official_lint(produced, lint_log):
            shutil.copy2(produced, keypoints)
            return keypoints
        if workspace.exists():
            shutil.rmtree(workspace)
        (workspace / "games" / task.stem).mkdir(parents=True)
        (workspace / "descriptions_example").mkdir(parents=True)
        shutil.copy2(task, workspace / "descriptions_example" / task.name)
        shutil.copytree(OFFICIAL / "scripts", workspace / "scripts")
        _symlink(OFFICIAL / "harness", workspace / "harness")
        _symlink(OFFICIAL / "skills", workspace / "skills")
        _symlink(OFFICIAL / "skills", workspace / ".codex" / "skills")

        command = [
            str(OFFICIAL / ".venv" / "bin" / "python"),
            str(workspace / "scripts" / "prepare" / "distill_keypoints.py"),
            "--games", task.stem,
            "--backend", "codex",
            "--parallel", "1",
            "--timeout", str(timeout),
            "--max-attempts", "2",
        ]
        environment = dict(os.environ)
        environment["PATH"] = f"{OFFICIAL / '.venv' / 'bin'}:{environment.get('PATH', '')}"
        log_path = task_root / "distill.log"
        with log_path.open("wb") as log:
            completed = subprocess.run(
                command, cwd=workspace, env=environment, stdout=log,
                stderr=subprocess.STDOUT, timeout=timeout * 3, check=False,
            )
        if not _keypoints_pass_official_lint(produced, lint_log):
            raise RuntimeError(f"official keypoint distillation failed; see {log_path}")
        shutil.copy2(produced, keypoints)
        return keypoints


def evaluate_official(
    *, artifact: Path, task: Path, keypoints: Path, attempt_root: Path,
    only_keypoints: str, timeout: int,
) -> dict:
    output_dir = attempt_root / "official_evaluation"
    result_path = output_dir / "result.json"
    command = [
        str(OFFICIAL / ".venv" / "bin" / "python"), str(OFFICIAL_WRAPPER),
        "--official-root", str(OFFICIAL), "--artifact-dir", str(artifact),
        "--specification", str(task), "--keypoints-md", str(keypoints),
        "--output-dir", str(output_dir), "--output-json", str(result_path),
        "--game-name", task.stem, "--run-id", "official_normal",
        "--backend", "codex", "--min-keypoints", "30", "--timeout", str(timeout),
    ]
    if only_keypoints:
        command.extend(["--only-keypoints", only_keypoints])
    log_path = attempt_root / "official_wrapper.log"
    with log_path.open("wb") as log:
        completed = subprocess.run(
            command, cwd=ROOT, env=dict(os.environ), stdout=log,
            stderr=subprocess.STDOUT, timeout=timeout + 120, check=False,
        )
    result = read_json(result_path)
    if not result:
        result = {
            "schema_version": "gamegen-verifier-official-v1",
            "implementation": "official-github-reference-implementation",
            "status": "infrastructure_failure",
            "primary_score": None,
            "keypoint_results": [],
            "error": f"official wrapper exited {completed.returncode}; see {log_path}",
        }
        write_json(result_path, result)
    return result


def run_case(
    provider: str, task: Path, case_dir: Path, shared_root: Path,
    generation_timeout: int, evaluation_timeout: int, only_keypoints: str,
    keypoint_sample_size: int,
) -> dict:
    attempt_root = case_dir / f"attempt-{int(time.time())}"
    attempt_root.mkdir(parents=True, exist_ok=False)
    started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    selected_keypoints = ""
    try:
        artifact = None
        generation = {}
        for previous in sorted(case_dir.glob("attempt-*"), reverse=True):
            if previous == attempt_root:
                continue
            candidate = read_json(previous / "generation_result.json")
            candidate_artifact = Path(str(candidate.get("artifact_dir", "")))
            if (
                candidate.get("status") == "completed"
                and candidate_artifact.is_dir()
                and all((candidate_artifact / name).exists() for name in REQUIRED_ARTIFACTS)
            ):
                artifact = candidate_artifact
                generation = {**candidate, "reused_from": str(previous)}
                write_json(attempt_root / "generation_result.json", generation)
                break
        if artifact is None:
            artifact, generation = generate(provider, task, attempt_root, generation_timeout)
        if artifact is None:
            raise RuntimeError("generation did not produce all official evaluator inputs")
        keypoints = ensure_shared_keypoints(task, shared_root, evaluation_timeout)
        selected_keypoints = only_keypoints or select_keypoints(
            keypoints, task.stem, keypoint_sample_size
        )
        evaluation = evaluate_official(
            artifact=artifact, task=task, keypoints=keypoints, attempt_root=attempt_root,
            only_keypoints=selected_keypoints, timeout=evaluation_timeout,
        )
        status = "completed" if evaluation.get("status") == "completed" else "failed"
        error = None
    except Exception as exc:
        generation = read_json(attempt_root / "generation_result.json")
        evaluation = {}
        status = "failed"
        error = str(exc)
        write_json(attempt_root / "case_error.json", {"error": error})
    return {
        "run_id": f"verigame_official_public_awesome_{provider}_{task.stem}",
        "experiment_type": "public_test",
        "evolution_enabled": False,
        "provider": provider,
        "model": PROVIDERS[provider],
        "task": task.stem,
        "status": status,
        "started_at": started,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "generation_status": generation.get("status"),
        "official_evaluation_status": evaluation.get("status"),
        "primary_score": evaluation.get("primary_score"),
        "keypoint_results": evaluation.get("keypoint_results", []),
        "selected_keypoints": selected_keypoints,
        "keypoint_sample_size": keypoint_sample_size,
        "implementation": evaluation.get("implementation"),
        "error": error,
        "attempt_root": str(attempt_root),
    }


def run_provider(args: argparse.Namespace, provider: str) -> None:
    tasks = task_files()[:1] if args.smoke else task_files()
    provider_root = args.output_root.resolve() / provider
    provider_root.mkdir(parents=True, exist_ok=True)
    summary_path = provider_root / "summary.json"
    summary = read_json(summary_path)
    summary.update({
        "schema_version": "verigame-official-public-awesome-v1",
        "experiment_type": "public_test",
        "evolution_enabled": False,
        "awesome_skills": True,
        "evaluator_implementation": "official-github-reference-implementation",
        "provider": provider,
        "model": PROVIDERS[provider],
        "planned_count": len(tasks),
        "keypoint_sample_size": args.keypoint_sample_size,
    })
    by_task = {str(item.get("task")): item for item in summary.get("cases", [])}
    for index, task in enumerate(tasks, 1):
        if by_task.get(task.stem, {}).get("status") == "completed":
            continue
        summary["current_case"] = {"task": task.stem, "index": index, "started_at": time.time()}
        write_json(summary_path, summary)
        print(f"[{provider}] {index}/{len(tasks)} {task.stem}", flush=True)
        item = run_case(
            provider, task, provider_root / task.stem, args.output_root.resolve() / "_shared_keypoints",
            args.generation_timeout, args.evaluation_timeout, args.only_keypoints,
            args.keypoint_sample_size,
        )
        by_task[task.stem] = item
        summary["cases"] = [by_task[name] for name in sorted(by_task)]
        summary["current_case"] = None
        summary["attempted_count"] = len(by_task)
        summary["officially_completed_count"] = sum(x["status"] == "completed" for x in by_task.values())
        summary["infrastructure_failed_count"] = len(by_task) - summary["officially_completed_count"]
        write_json(summary_path, summary)
        try:
            append_progress_notice(
                item,
                attempted_count=summary["attempted_count"],
                completed_count=summary["officially_completed_count"],
            )
        except OSError as exc:
            print(f"[{provider}] progress notice failed: {exc}", file=sys.stderr, flush=True)
    summary["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    write_json(summary_path, summary)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", action="append", choices=sorted(PROVIDERS))
    parser.add_argument("--output-root", type=Path, default=ROOT / ".baseline-agent-runs" / "verigame-official-public-awesome-v1")
    parser.add_argument("--generation-timeout", type=int, default=MAX_GENERATION_SECONDS)
    parser.add_argument("--evaluation-timeout", type=int, default=14400)
    parser.add_argument("--only-keypoints", default="")
    parser.add_argument("--keypoint-sample-size", type=int, default=DEFAULT_KEYPOINT_SAMPLE_SIZE)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    if not all((OFFICIAL.is_dir(), TASKS.is_dir(), SEED.is_dir(), OFFICIAL_WRAPPER.is_file())):
        raise SystemExit("official VeriGame public-test prerequisites are missing")
    os.environ["GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS"] = "1"
    for provider in args.provider or PROVIDERS:
        run_provider(args, provider)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
