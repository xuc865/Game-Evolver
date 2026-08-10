#!/usr/bin/env python3
"""Run the released V-GameGym recorder and three-modality evaluator on one artifact."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


def _add_recording_shutdown_hook(code: str, record_duration: int) -> str:
    """Close generated Pygame games after the official capture window."""

    hook = f'''\n\n# game-loop evaluator shutdown hook\nimport threading as _gl_threading\nimport time as _gl_time\nimport pygame as _gl_pygame\n\ndef _gl_post_quit():\n    _gl_time.sleep({int(record_duration) + 1})\n    try:\n        _gl_pygame.event.post(_gl_pygame.event.Event(_gl_pygame.QUIT))\n    except Exception:\n        pass\n\n_gl_threading.Thread(target=_gl_post_quit, daemon=True).start()\n'''
    # The released recorder prepends its own capture program before this
    # source, so future imports can no longer legally appear at file start.
    # They are syntax-only for this evaluator and can be removed from the
    # temporary execution copy.
    code = re.sub(r"^from __future__ import .*?$\n?", "", code, flags=re.MULTILINE)
    return hook + "\n" + code


def _inline_video_media(value: Any) -> Any:
    """Convert official evaluator file URLs to API-compatible data URLs."""

    if isinstance(value, dict):
        return {key: _inline_video_media(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_inline_video_media(item) for item in value]
    if isinstance(value, str) and value.startswith("file://"):
        path = Path(value[7:])
        if path.is_file() and path.suffix.casefold() == ".mp4":
            encoded = base64.b64encode(path.read_bytes()).decode("ascii")
            return f"data:video/mp4;base64,{encoded}"
    return value


class _MediaSafeCompletions:
    def __init__(self, completions: Any):
        self._completions = completions

    def create(self, *args: Any, **kwargs: Any) -> Any:
        if "messages" in kwargs:
            kwargs["messages"] = _inline_video_media(kwargs["messages"])
        extra = kwargs.get("extra_body")
        if isinstance(extra, dict):
            processor = extra.get("mm_processor_kwargs")
            if isinstance(processor, dict) and processor.get("fps") == [2.0]:
                # The deployed Qwen-VL endpoint expects a scalar fps, while
                # the released evaluator sends a one-item list.
                kwargs["extra_body"] = {
                    **extra,
                    "mm_processor_kwargs": {**processor, "fps": 2.0},
                }
        return self._completions.create(*args, **kwargs)


class _MediaSafeChat:
    def __init__(self, chat: Any):
        self._chat = chat
        self.completions = _MediaSafeCompletions(chat.completions)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._chat, name)


class _MediaSafeClient:
    def __init__(self, client: Any):
        self._client = client
        self.chat = _MediaSafeChat(client.chat)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


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
    code = _add_recording_shutdown_hook(
        game_file.resolve().read_text(encoding="utf-8"), record_duration
    )
    base = output_dir.resolve()
    recording_root = base / "recording_results" / model_name
    recorder_item = {
        "game_id": game_id,
        "requirement": requirement,
        "generated_code": code,
        "reference_code": "",
        "test_model": model_name,
        "record_duration": record_duration,
    }
    recorder_input = base / "recorder_item.json"
    recorder_input.parent.mkdir(parents=True, exist_ok=True)
    recorder_input.write_text(json.dumps(recorder_item, ensure_ascii=False), encoding="utf-8")
    recorder_command = [
        sys.executable,
        str(Path(__file__).resolve().with_name("run_vgamegym_record_local.py")),
        "--game-file", str(game_file.resolve()),
        "--output-dir", str(recording_root), "--game-id", str(game_id),
        "--duration", str(record_duration),
    ]
    recorder_env = os.environ.copy()
    recorder_env["PYTHONPATH"] = str(official_root) + os.pathsep + recorder_env.get("PYTHONPATH", "")
    try:
        recorder_process = subprocess.run(
            recorder_command, cwd=official_root, env=recorder_env,
            capture_output=True, text=True, timeout=record_duration + 120, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"official recorder timed out: {exc}") from exc
    if recorder_process.returncode != 0:
        detail = (recorder_process.stderr or recorder_process.stdout).strip()[-2000:]
        raise RuntimeError(f"official recorder exited {recorder_process.returncode}: {detail}")
    try:
        record = json.loads(recorder_process.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        raise RuntimeError("official recorder returned no JSON result") from exc
    execution = record.get("execution_result", {}) if isinstance(record, dict) else {}
    recording_ok = bool(record.get("success")) if isinstance(record, dict) else False
    if isinstance(execution, dict):
        recording_ok = recording_ok or bool(execution.get("success"))
    if not recording_ok:
        detail = (
            record.get("stderr")
            or execution.get("stderr", "official recorder failed")
            if isinstance(record, dict) and isinstance(execution, dict)
            else "official recorder failed"
        )
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
    evaluator.vl_client = _MediaSafeClient(evaluator.vl_client)
    text_model = os.environ.get("VGAMEGYM_TEXT_MODEL", "").strip()
    # The bundled official evaluator hard-codes a model path that is not
    # deployed on the configured VL endpoint. Pin the locally available model
    # unless the operator explicitly overrides it.
    vl_model = os.environ.get("VGAMEGYM_VL_MODEL", "Qwen3.6-27B").strip()
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
    # VGameGym artifacts commonly include helper scripts and tests. The
    # benchmark entrypoint is conventionally the root-level game.py; choosing
    # it explicitly avoids treating support files as competing games.
    preferred = root / "game.py"
    if preferred.is_file():
        return preferred
    candidates = sorted(
        path for path in root.rglob("*.py")
        if not any(
            part.startswith(".") or part in {"__pycache__", "tests", "test"}
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
