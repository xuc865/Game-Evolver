#!/usr/bin/env python3
"""Run the released V-GameGym recorder and three-modality evaluator on one artifact."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


def _requirement(task_root: Path) -> str:
    for name in ("public_task.json", "task.json"):
        path = task_root / name
        if path.is_file():
            value = json.loads(path.read_text(encoding="utf-8"))
            text = str(value.get("requirement", "")).strip()
            if text:
                return text
    for name in ("requirement.md", "task.md", "instruction.md"):
        path = task_root / name
        if path.is_file() and (text := path.read_text(encoding="utf-8").strip()):
            return text
    raise FileNotFoundError("public V-GameGym requirement is missing")


def run(
    *,
    official_root: Path,
    task_root: Path,
    game_file: Path,
    output_dir: Path,
    raw_output: Path,
    game_id: str,
    model_name: str,
    record_duration: int,
) -> dict[str, object]:
    official_root = official_root.resolve()
    sys.path.insert(0, str(official_root))
    from game_evaluator import EvaluationConfig, GameEvaluator  # type: ignore
    from screenshot_recorder import task_worker  # type: ignore

    vl_url = os.environ.get("VGAMEGYM_VL_BASE_URL", "").strip()
    text_url = os.environ.get("VGAMEGYM_TEXT_BASE_URL", "").strip()
    if not vl_url or not text_url:
        raise RuntimeError(
            "VGAMEGYM_VL_BASE_URL and VGAMEGYM_TEXT_BASE_URL must name real "
            "OpenAI-compatible evaluator endpoints"
        )
    os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    requirement = _requirement(task_root.resolve())
    code = game_file.resolve().read_text(encoding="utf-8")
    base = output_dir.resolve()
    recording_root = base / "recording_results" / model_name
    record = task_worker(
        {
            "dataset_item": {
                "game_id": game_id,
                "requirement": requirement,
                "generated_code": code,
                "reference_code": "",
                "test_model": model_name,
            },
            "output_dir": str(recording_root),
            "record_duration": record_duration,
            "video_fps": 3,
            "screenshot_format": "jpg",
            "async_io": True,
        }
    )
    execution = record.get("execution_result", {}) if isinstance(record, dict) else {}
    if not isinstance(execution, dict) or not execution.get("success"):
        detail = execution.get("stderr", "official recorder failed") if isinstance(execution, dict) else "official recorder failed"
        raise RuntimeError(str(detail))

    config = EvaluationConfig(
        model_name=model_name,
        vl_base_url=vl_url,
        text_base_url=text_url,
        num_processes=1,
        base_path=str(base),
        max_retry_attempts=2,
    )
    evaluator = GameEvaluator(config)
    text_model = os.environ.get("VGAMEGYM_TEXT_MODEL", "").strip()
    vl_model = os.environ.get("VGAMEGYM_VL_MODEL", "").strip()
    if text_model:
        evaluator.text_client = _override_openai_model(evaluator.text_client, text_model)
    if vl_model:
        evaluator.vl_client = _override_openai_model(evaluator.vl_client, vl_model)
    result = evaluator.evaluate_single_game(
        int(game_id), {"requirement": requirement, "generated_code": code}
    )
    if result is None:
        cached_result = config.output_path / f"game_{int(game_id)}_evaluation.json"
        if cached_result.is_file():
            result = json.loads(cached_result.read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise RuntimeError("official V-GameGym evaluator did not return a result")
    result["run_ok"] = True
    result["official_repository"] = "https://github.com/alibaba/SKYLENAGE-GameCodeGym"
    raw_output.resolve().parent.mkdir(parents=True, exist_ok=True)
    raw_output.resolve().write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result


class _ModelOverrideCompletions:
    def __init__(self, completions: Any, model: str):
        self._completions = completions
        self._model = model

    def create(self, *args: Any, **kwargs: Any) -> Any:
        kwargs["model"] = self._model
        return self._completions.create(*args, **kwargs)


class _ModelOverrideChat:
    def __init__(self, chat: Any, model: str):
        self._chat = chat
        self.completions = _ModelOverrideCompletions(chat.completions, model)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._chat, name)


class _ModelOverrideClient:
    def __init__(self, client: Any, model: str):
        self._client = client
        self.chat = _ModelOverrideChat(client.chat, model)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


def _override_openai_model(client: Any, model: str) -> Any:
    return _ModelOverrideClient(client, model)


def _resolve_game_file(game_file: Path | None, artifact_dir: Path | None) -> Path:
    if game_file is not None:
        return game_file.resolve()
    assert artifact_dir is not None
    root = artifact_dir.resolve()
    candidates = sorted(
        path for path in root.rglob("*.py")
        if not any(
            part.startswith(".") or part == "__pycache__"
            for part in path.relative_to(root).parts
        )
    )
    if len(candidates) != 1:
        raise ValueError(
            f"official V-GameGym smoke requires exactly one Python entrypoint; found {len(candidates)}"
        )
    return candidates[0]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-root", type=Path, required=True)
    parser.add_argument("--task-root", type=Path, required=True)
    artifact = parser.add_mutually_exclusive_group(required=True)
    artifact.add_argument("--game-file", type=Path)
    artifact.add_argument("--artifact-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--raw-output", type=Path, required=True)
    parser.add_argument("--game-id", default="0")
    parser.add_argument("--model-name", default="opengame")
    parser.add_argument("--record-duration", type=int, default=10)
    args = parser.parse_args(argv)
    run(
        official_root=args.official_root,
        task_root=args.task_root,
        game_file=_resolve_game_file(args.game_file, args.artifact_dir),
        output_dir=args.output_dir or args.raw_output.resolve().parent,
        raw_output=args.raw_output,
        game_id=args.game_id,
        model_name=args.model_name,
        record_duration=args.record_duration,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
