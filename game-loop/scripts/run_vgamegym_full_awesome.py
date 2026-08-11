#!/usr/bin/env python3
"""Resumable full-dataset V-GameGym evaluation for a model/skills arm.

Generation is performed once per task and the resulting artifact is retained
even when the OpenGame process times out. Evaluator retries reuse that artifact
and never call the generation model again.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from statistics import mean, stdev
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.benchmarks.vgamegym_eval import candidate_execution_failure, infrastructure_failure, normalize_official_result
from game_loop.benchmarks.runtime_config import runtime_config_from_environment
from game_loop.runtime import GameTask, OpenGameRuntime
from game_loop.utils import atomic_write_json, read_json, utc_now


DATASET = ROOT / "third_party" / "SKYLENAGE-GameCodeGym" / "gamegym_testset" / "pygame_seeds_2500_filtered.jsonl"
OFFICIAL_ROOT = ROOT / "third_party" / "SKYLENAGE-GameCodeGym"
OFFICIAL_PYTHON = OFFICIAL_ROOT / ".venv" / "bin" / "python"
DEFAULT_OUT = ROOT / "experiments" / "vgamegym-full-awesome"
MODELS = ("kimi", "qwen", "glm", "deepseek", "claude", "gpt55")
_ACTIVE_LOCKS: set[Path] = set()

# VGameGym generation is a single-artifact task. Keeping the tool surface
# narrow prevents compatible OpenGame backends from spending their only turn
# narrating a plan or invoking unrelated planning/asset tools.
VGAMEGYM_CORE_TOOLS = (
    "list_directory",
    "read_file",
    "grep_search",
    "glob",
    "edit",
    "write_file",
    "read_many_files",
    "run_shell_command",
)


def _cleanup_active_locks() -> None:
    for lock in list(_ACTIVE_LOCKS):
        shutil.rmtree(lock, ignore_errors=True)
    _ACTIVE_LOCKS.clear()


atexit.register(_cleanup_active_locks)


def _read_dataset(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        task_id = str(value.get("id", "")).strip()
        requirement = str(value.get("requirement", "")).strip()
        if not task_id or not requirement:
            raise ValueError(f"dataset line {line_no} lacks id or requirement")
        if task_id in seen:
            raise ValueError(f"duplicate dataset id: {task_id}")
        seen.add(task_id)
        rows.append({"id": task_id, "requirement": requirement})
    return rows


def _task_dir(root: Path, task_id: str) -> Path:
    return root / f"task_{task_id}"


def _acquire_task_lock(task_dir: Path) -> Path | None:
    """Acquire an atomic per-task lock and reclaim dead-worker locks."""
    lock = task_dir / ".worker.lock"
    try:
        lock.mkdir(parents=True)
    except FileExistsError:
        owner = lock / "owner.json"
        pid = None
        if owner.is_file():
            try:
                pid = int(read_json(owner).get("pid"))
            except (TypeError, ValueError, OSError):
                pass
        if pid:
            try:
                os.kill(pid, 0)
                return None
            except OSError:
                pass
        shutil.rmtree(lock, ignore_errors=True)
        try:
            lock.mkdir(parents=True)
        except FileExistsError:
            return None
    atomic_write_json(lock / "owner.json", {"pid": os.getpid(), "started_at": utc_now()})
    _ACTIVE_LOCKS.add(lock)
    return lock


def _release_task_lock(lock: Path | None) -> None:
    if lock is not None:
        _ACTIVE_LOCKS.discard(lock)
        shutil.rmtree(lock, ignore_errors=True)


def _write_public_task(task_dir: Path, row: dict[str, Any]) -> Path:
    public = task_dir / "public_task"
    public.mkdir(parents=True, exist_ok=True)
    (public / "requirement.md").write_text(str(row["requirement"]) + "\n", encoding="utf-8")
    atomic_write_json(public / "public_task.json", {"id": row["id"], "requirement": row["requirement"]})
    return public


def _find_artifact(episode_dir: Path) -> Path | None:
    preferred = episode_dir / "workspace" / "game.py"
    if preferred.is_file():
        return preferred
    workspace = episode_dir / "workspace"
    candidates = sorted(
        p for p in workspace.rglob("*.py")
        if not any(part.startswith(".") or part in {"__pycache__", "tests", "test"} for part in p.relative_to(workspace).parts)
    ) if workspace.is_dir() else []
    return candidates[0] if len(candidates) == 1 else None


def _provider_infrastructure_failure(submission: Any) -> bool:
    text = " ".join(
        str(value)
        for value in (
            getattr(submission, "result_text", ""),
            *(getattr(submission, "diagnostics", ()) or ()),
        )
    ).casefold()
    return any(marker in text for marker in (
        "[api error:",
        "insufficient balance",
        "connection error",
        "502 terminated",
        "503 service unavailable",
        "504 gateway",
        "empty response text",
    ))


def _write_provider_block(root: Path, model: str, task_id: str, submission: Any) -> None:
    text = " ".join(
        str(value)
        for value in (
            getattr(submission, "result_text", ""),
            *(getattr(submission, "diagnostics", ()) or ()),
        )
    )
    if "requires more credits" in text.casefold():
        # The primary deployment may still be healthy. Persist only the
        # exhausted OpenRouter route and keep later tasks on the primary.
        atomic_write_json(root / "fallback_unavailable.json", {
            "model": model,
            "provider": "openrouter",
            "task_id": task_id,
            "reason": text[-2000:],
            "created_at": utc_now(),
        })
        (root / "provider_failure_streak.json").unlink(missing_ok=True)
        return
    block = root / "provider_blocked.json"
    streak_file = root / "provider_failure_streak.json"
    previous = read_json(block) if block.is_file() else (
        read_json(streak_file) if streak_file.is_file() else {}
    )
    consecutive = int(previous.get("consecutive_failures", 0)) + 1
    # One empty stream or transient gateway failure should be retried by the
    # normal task budget. Pause only after repeated failures from both routes.
    if consecutive < 3:
        atomic_write_json(streak_file, {
            "model": model, "task_id": task_id,
            "consecutive_failures": consecutive, "reason": text[-2000:],
            "updated_at": utc_now(),
        })
        return
    atomic_write_json(block, {
        "model": model,
        "task_id": task_id,
        "reason": text[-2000:],
        "consecutive_failures": consecutive,
        "created_at": utc_now(),
    })
    streak_file.unlink(missing_ok=True)


def _score_artifact(*, task_dir: Path, artifact: Path, task_id: str, timeout: int) -> dict[str, Any]:
    eval_dir = task_dir / "evaluation"
    raw = eval_dir / "official_raw.json"
    normalized = eval_dir / "result.json"
    eval_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.setdefault("SDL_VIDEODRIVER", "dummy")
    env.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    env.setdefault("VGAMEGYM_VL_BASE_URL", "http://29.116.237.141:8080/v1")
    env.setdefault("VGAMEGYM_TEXT_BASE_URL", "http://29.116.237.135:8080/v1")
    env.setdefault("VGAMEGYM_VL_MODEL", "Qwen3.6-27B")
    env.setdefault("VGAMEGYM_TEXT_MODEL", "Kimi-K2.7-Code")
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    command = [
        str(OFFICIAL_PYTHON if OFFICIAL_PYTHON.is_file() else sys.executable),
        str(ROOT / "scripts" / "run_vgamegym_official_evaluator.py"),
        "--official-root", str(OFFICIAL_ROOT), "--task-root", str(task_dir / "public_task"),
        "--game-file", str(artifact), "--output-dir", str(eval_dir),
        "--raw-output", str(raw), "--game-id", str(task_id), "--model-name", "opengame",
    ]
    try:
        completed = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout, check=False)
        if completed.returncode != 0 or not raw.is_file():
            detail = f"official evaluator exited {completed.returncode}: {(completed.stderr or completed.stdout).strip()[-1000:]}"
            result = (
                candidate_execution_failure(detail, raw_result_ref=raw)
                if "official recorder exited" in detail
                else infrastructure_failure(detail, raw_result_ref=raw)
            )
        else:
            result = normalize_official_result(read_json(raw), raw_result_ref=raw)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        result = infrastructure_failure(str(exc), raw_result_ref=raw)
    atomic_write_json(normalized, result)
    return result


def _summary(root: Path, model: str, total: int) -> dict[str, Any]:
    records = []
    for path in sorted((root / model).glob("task_*/evaluation/result.json")):
        try:
            value = read_json(path)
        except Exception:
            continue
        if value.get("status") == "completed" and value.get("primary_score") is not None and all(
            value.get("constraints", {}).get(f"{m}_judge_complete", False) for m in ("code", "screenshot", "video")
        ) and value.get("constraints", {}).get("game_runnable", False):
            records.append(value)
    scores = {name: [float(item["objectives"][name]) * 100 for item in records] for name in ("code", "screenshot", "video")}
    finals = [mean([scores[name][i] for name in scores]) for i in range(len(records))]
    statuses: dict[str, int] = {}
    status_paths = sorted((root / model).glob("task_*/status.json"))
    for path in status_paths:
        try:
            status = str(read_json(path).get("status", "unknown"))
        except Exception:
            status = "unknown"
        statuses[status] = statuses.get(status, 0) + 1
    # Every task with a status file has been attempted. Failed attempts do not
    # receive a score and therefore contribute zero to the primary metrics.
    # This is the denominator required for the real experiment report.
    attempted = len(status_paths)
    attempted_scores = {
        name: round(sum(values) / attempted, 4) if attempted else 0.0
        for name, values in scores.items()
    }
    attempted_final = round(sum(finals) / attempted, 4) if attempted else 0.0
    def stat(values: list[float]) -> dict[str, Any]:
        return {"mean": round(mean(values), 4) if values else None, "stdev": round(stdev(values), 4) if len(values) > 1 else None}
    return {
        "schema_version": "vgamegym-full-awesome-v1", "model": model, "dataset_tasks": total,
        "attempted_tasks": attempted, "valid_scored_tasks": len(records),
        "status_counts": statuses,
        "coverage": round(attempted / total, 6) if total else 0,
        "Final Score": attempted_final, "Code": attempted_scores["code"],
        "Screenshot": attempted_scores["screenshot"], "Video": attempted_scores["video"],
        "conditional_valid_means": {
            "Final Score": stat(finals), "Code": stat(scores["code"]),
            "Screenshot": stat(scores["screenshot"]), "Video": stat(scores["video"]),
        },
        # Keep the old key as an alias for readers of intermediate summaries;
        # its value now uses attempted_tasks rather than the full dataset.
        "attempted_zero_filled": {
            "Final Score": attempted_final, "Code": attempted_scores["code"],
            "Screenshot": attempted_scores["screenshot"], "Video": attempted_scores["video"],
        },
        "scoring_note": (
            "Paper-compatible scales: Code 0-100, Screenshot/Image 0-25, Video 0-25, "
            "and Final Score is their arithmetic mean. Top-level metrics use "
            "attempted_tasks as denominator and assign zero to failed attempts; "
            "conditional_valid_means is restricted to valid completed scores."
        ),
        "updated_at": utc_now(),
    }


def run_model(*, model: str, output_root: Path, limit: int | None, evaluator_timeout: int, evaluator_retries: int, retry_generation: bool, generation_retries: int = 3, shard_index: int = 0, shard_count: int = 1, awesome_skills: bool = True) -> int:
    rows = _read_dataset(DATASET)
    model_root = (output_root / model).resolve()
    model_root.mkdir(parents=True, exist_ok=True)
    canonical_shards_path = output_root.resolve() / ".canonical_shard_count"
    if limit is None and canonical_shards_path.is_file():
        canonical_shards = int(canonical_shards_path.read_text(encoding="utf-8").strip())
        if shard_count != canonical_shards:
            print(
                f"refusing non-canonical full run: shard_count={shard_count}, "
                f"expected={canonical_shards}",
                flush=True,
            )
            return 76
    # A provider breaker is shared by all shards and supervisor passes. It is
    # checked in the worker too, so an older supervisor cannot keep spending
    # requests after a real provider outage has been detected.
    if (model_root / "provider_blocked.json").is_file():
        return 75
    if model in {"qwen", "glm"} and (model_root / "fallback_unavailable.json").is_file():
        # Provider resolution happens inside each runtime call from this
        # process environment. Removing the exhausted credential disables only
        # OpenRouter fallback; the local primary remains unchanged.
        os.environ.pop("OPENROUTER_API_KEY", None)
    # Keep primary and fallback attempts bounded independently. Qwen/GLM can
    # establish a stream and then stall after an early tool call; a 300-second
    # provider attempt leaves enough time for the OpenRouter fallback before
    # the supervisor's 750-second process-level guard intervenes.
    provider_timeout = 300
    if awesome_skills:
        os.environ["GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS"] = "1"
    else:
        os.environ.pop("GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS", None)
    config = runtime_config_from_environment(provider=model, timeout_seconds=provider_timeout)
    # This overlay is deliberately local to the formal VGameGym runner. The
    # shared OpenGame profile is also used by unrelated benchmark workflows.
    config = type(config).from_dict({
        **config.to_dict(),
        "core_tools": list(VGAMEGYM_CORE_TOOLS),
        "exclude_tools": ["todo_write", "task", "save_memory", "web_fetch", "classify_game_type", "generate_gdd", "generate_game_assets", "generate_tilemap"],
    })
    if model in {"qwen", "glm"}:
        # The shared OpenGame profile asks for 32768 output tokens. The
        # OpenRouter fallback currently rejects large reservations with HTTP
        # 402 even when the actual response would be much shorter. Keep this
        # budget local to the formal VGameGym runner and below the observed
        # available credit ceiling.
        settings = json.loads(json.dumps(config.settings))
        generation_config = settings.setdefault("model", {}).setdefault("generationConfig", {})
        sampling_params = generation_config.setdefault("samplingParams", {})
        sampling_params["max_tokens"] = min(int(sampling_params.get("max_tokens", 8000)), 8000)
        config = type(config).from_dict({**config.to_dict(), "settings": settings})
    runtime = OpenGameRuntime(config)
    atomic_write_json(model_root / "run_manifest.json", {
        "schema_version": "vgamegym-full-awesome-v1", "model": model,
        "dataset": str(DATASET.resolve()), "dataset_tasks": len(rows),
        "awesome_skills": awesome_skills, "runtime": config.to_dict(redact_environment=True), "started_at": utc_now(),
    })
    selected = rows if limit is None else rows[:max(0, limit)]
    if shard_count > 1:
        selected = selected[shard_index::shard_count]
    for index, row in enumerate(selected):
        # Stop an already-running shard promptly after another request detects
        # a provider outage. The supervisor will probe and resume later.
        if (model_root / "provider_blocked.json").is_file():
            return 75
        task_id = str(row["id"])
        task_dir = _task_dir(model_root, task_id)
        status_path = task_dir / "status.json"
        existing = read_json(status_path) if status_path.is_file() else {}
        raw_result = task_dir / "evaluation" / "official_raw.json"
        normalized_result = task_dir / "evaluation" / "result.json"
        if raw_result.is_file():
            try:
                refreshed = normalize_official_result(
                    read_json(raw_result), raw_result_ref=raw_result
                )
            except (OSError, ValueError, json.JSONDecodeError):
                refreshed = None
            if refreshed is not None:
                atomic_write_json(normalized_result, refreshed)
        if existing.get("status") in {"completed", "candidate_execution_failure"} and (
            task_dir / "evaluation" / "result.json"
        ).is_file():
            continue
        lock = _acquire_task_lock(task_dir)
        if lock is None:
            continue
        if "evaluator_attempts_total" in existing:
            evaluator_attempts_total = int(existing["evaluator_attempts_total"])
        elif existing.get("status") == "evaluator_infrastructure_failure":
            # Legacy terminal statuses were written only after the full retry
            # loop had failed, so their configured retry budget is exhausted.
            evaluator_attempts_total = max(1, evaluator_retries)
        else:
            evaluator_attempts_total = 0
        if (
            existing.get("status") == "evaluator_infrastructure_failure"
            and (task_dir / "evaluation" / "result.json").is_file()
            and evaluator_attempts_total < max(1, evaluator_retries)
        ):
            artifact = _find_artifact(task_dir / "generation")
            if artifact is not None:
                result = infrastructure_failure("evaluator retry was not attempted")
                remaining_evaluator_attempts = max(0, max(1, evaluator_retries) - evaluator_attempts_total)
                for attempt in range(remaining_evaluator_attempts):
                    evaluator_attempts_total += 1
                    result = _score_artifact(task_dir=task_dir, artifact=artifact, task_id=task_id, timeout=evaluator_timeout)
                    if result.get("status") in {"completed", "candidate_execution_failure"}:
                        break
                    if attempt + 1 < remaining_evaluator_attempts:
                        time.sleep(min(30, 2 ** attempt))
                terminal = result.get("status") if result.get("status") in {"completed", "candidate_execution_failure"} else "evaluator_infrastructure_failure"
                atomic_write_json(status_path, {
                    "task_id": task_id, "index": index, "status": terminal,
                    "generation_status": "generated", "artifact": str(artifact),
                    "evaluator_attempts_total": evaluator_attempts_total,
                    "updated_at": utc_now(),
                })
                if terminal in {"completed", "candidate_execution_failure"}:
                    _release_task_lock(lock)
                    continue
        task_dir.mkdir(parents=True, exist_ok=True)
        public_task = _write_public_task(task_dir, row)
        episode = task_dir / "generation"
        artifact = _find_artifact(episode)
        generation_status = str(existing.get("generation_status", "pending"))
        generation_failure_kind = str(existing.get("generation_failure_kind", ""))
        generation_error = read_json(task_dir / "generation_error.json") if (task_dir / "generation_error.json").is_file() else {}
        workspace_collision = "episode directory must be new or empty" in str(generation_error.get("error", "")).casefold()
        previous_submission = read_json(task_dir / "submission.json") if (task_dir / "submission.json").is_file() else {}
        previous_diagnostics = " ".join(str(item) for item in previous_submission.get("diagnostics", []))
        legacy_session_timeout = "opengame sdk timed out after 180s" in previous_diagnostics.casefold()
        # Older runs exhausted the per-pass retry loop but did not persist a
        # cumulative counter. Treat their terminal generation_failed status as
        # exhausted; otherwise every supervisor restart retries the same prefix
        # forever and the full dataset is never covered.
        if generation_failure_kind == "provider_infrastructure_failure":
            generation_attempts_total = 0
        elif "generation_attempts_total" in existing:
            generation_attempts_total = int(existing["generation_attempts_total"])
        elif existing.get("status") == "generation_failed":
            generation_attempts_total = max(1, generation_retries)
        elif existing.get("status") == "running":
            generation_attempts_total = int(existing.get("generation_attempt", 0))
        else:
            generation_attempts_total = 0
        # A concurrent legacy shard could leave a terminal failure after
        # calling runtime.run with a non-empty episode directory. Once that
        # shard is stopped, this is safe to retry from a clean episode; it is
        # distinct from a genuine model/provider failure and must not reset
        # the normal cumulative retry budget.
        if (workspace_collision or legacy_session_timeout) and retry_generation:
            generation_attempts_total = 0
        if artifact is None and episode.exists():
            shutil.rmtree(episode)
            episode = task_dir / "generation"
        should_generate = artifact is None and (
            generation_status != "generation_failed"
            or (retry_generation and generation_attempts_total < max(1, generation_retries))
        )
        if should_generate:
            prompt = (
                "Implement the public requirement as a runnable Pygame artifact. "
                "The game must autonomously demonstrate its core mechanics during a fixed "
                "recording horizon so code, screenshots, and video can all be evaluated. "
                "Do not consume reference code or evaluator outputs. "
                "Do not spend turns planning or maintaining a todo list. Your first action "
                "must be a write_file or edit tool call that creates the runnable .py artifact "
                "in the workspace; do not send a prose acknowledgement before that tool call. "
                "Then verify it and continue "
                "editing until it is complete.\n\n"
                "## Public requirement\n\n" + str(row["requirement"])
            )
            task = GameTask(task_id=f"vgg-{task_id}", benchmark_id="vgamegym", prompt=prompt,
                            task_source_ref=str(public_task), workspace_seed_ref=None, artifact_relpath=".",
                            constraints={"engine": "pygame", "evaluation_modalities": ["code", "screenshot", "video"]})
            remaining_attempts = max(0, max(1, generation_retries) - generation_attempts_total)
            for generation_attempt in range(remaining_attempts):
                if episode.exists():
                    shutil.rmtree(episode)
                generation_attempts_total += 1
                atomic_write_json(status_path, {
                    "task_id": task_id, "index": index, "status": "running",
                    "generation_status": "running",
                    "generation_attempt": generation_attempt + 1,
                    "generation_attempts_total": generation_attempts_total,
                    "started_at": utc_now(),
                })
                try:
                    submission = runtime.run(task, episode_dir=episode)
                    artifact = _find_artifact(episode)
                    generation_status = "generated" if artifact is not None else "generation_failed"
                    generation_failure_kind = (
                        "provider_infrastructure_failure"
                        if artifact is None and _provider_infrastructure_failure(submission)
                        else "model_generation_failure"
                    )
                    if generation_failure_kind == "provider_infrastructure_failure":
                        _write_provider_block(model_root, model, task_id, submission)
                    elif artifact is not None:
                        (task_dir / "generation_error.json").unlink(missing_ok=True)
                        (model_root / "provider_failure_streak.json").unlink(missing_ok=True)
                    atomic_write_json(task_dir / "submission.json", submission.to_dict())
                except Exception as exc:
                    generation_status = "generation_failed"
                    generation_failure_kind = (
                        "provider_infrastructure_failure"
                        if any(marker in repr(exc).casefold() for marker in (
                            "api error", "insufficient balance", "connection error", "502", "503", "504", "empty response text"
                        ))
                        else "model_generation_failure"
                    )
                    atomic_write_json(task_dir / "generation_error.json", {
                        "error": repr(exc), "attempt": generation_attempts_total,
                        "created_at": utc_now(),
                    })
                    artifact = _find_artifact(episode)
                if artifact is not None:
                    break
                if generation_attempt + 1 < remaining_attempts:
                    time.sleep(min(60, 5 * (2 ** generation_attempt)))
        if artifact is None:
            terminal_generation_status = (
                "provider_infrastructure_failure"
                if generation_failure_kind == "provider_infrastructure_failure"
                else "generation_failed"
            )
            atomic_write_json(status_path, {
                "task_id": task_id, "index": index,
                "status": terminal_generation_status,
                "generation_status": "generation_failed",
                "generation_failure_kind": generation_failure_kind or "model_generation_failure",
                "generation_attempts_total": generation_attempts_total,
                "updated_at": utc_now(),
            })
            _release_task_lock(lock)
            if terminal_generation_status == "provider_infrastructure_failure":
                return 75
            continue
        result = infrastructure_failure("evaluator was not attempted")
        remaining_evaluator_attempts = max(0, max(1, evaluator_retries) - evaluator_attempts_total)
        for attempt in range(remaining_evaluator_attempts):
            evaluator_attempts_total += 1
            result = _score_artifact(task_dir=task_dir, artifact=artifact, task_id=task_id, timeout=evaluator_timeout)
            if result.get("status") in {"completed", "candidate_execution_failure"}:
                break
            if attempt + 1 < remaining_evaluator_attempts:
                time.sleep(min(30, 2 ** attempt))
        terminal = result.get("status") if result.get("status") in {"completed", "candidate_execution_failure"} else "evaluator_infrastructure_failure"
        atomic_write_json(status_path, {
            "task_id": task_id, "index": index, "status": terminal,
            "generation_status": generation_status, "artifact": str(artifact),
            "evaluator_attempts_total": evaluator_attempts_total,
            "updated_at": utc_now(),
        })
        _release_task_lock(lock)
        if index % 10 == 0:
            atomic_write_json(model_root / "summary.json", _summary(output_root, model, len(rows)))
        print(json.dumps({"model": model, "index": index + 1, "total": len(selected), "task_id": task_id, "status": terminal}, ensure_ascii=False), flush=True)
    atomic_write_json(model_root / "summary.json", _summary(output_root, model, len(rows)))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=MODELS, required=True)
    parser.add_argument("--baseline", action="store_true", help="Disable awesome-gamedev skills for this run")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--limit", type=int, default=None, help="Development-only bounded run; omit for all 2218 tasks.")
    parser.add_argument("--evaluator-timeout", type=int, default=1800)
    parser.add_argument("--evaluator-retries", type=int, default=3)
    parser.add_argument("--retry-generation", action="store_true")
    parser.add_argument("--generation-retries", type=int, default=3)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    args = parser.parse_args(argv)
    if args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count:
        parser.error("--shard-index must be within --shard-count")
    return run_model(model=args.model, output_root=args.output_root, limit=args.limit, evaluator_timeout=args.evaluator_timeout, evaluator_retries=args.evaluator_retries, retry_generation=args.retry_generation, generation_retries=args.generation_retries, shard_index=args.shard_index, shard_count=args.shard_count, awesome_skills=not args.baseline)


if __name__ == "__main__":
    raise SystemExit(main())
