"""Local runtime staging for GameCraftBench task overlays."""
from __future__ import annotations

import os
import re
import shutil
import stat
from pathlib import Path

from game_loop.probe_tools import resolve_godot_executable


def text_only_mode() -> bool:
    """Return whether the game-making backbone must not receive visual tools."""

    return os.environ.get("GAME_LOOP_TEXT_ONLY", "0").strip().casefold() in {
        "1", "true", "yes", "on",
    }


def stage_local_runtime_overlay(
    *,
    overlay_workspace: Path,
    gcbench_root: Path,
    godot_bin: str | None = None,
) -> dict[str, str]:
    """Stage Harbor-style ``/workspace`` helpers for a local gcbench run.

    Copies ``gcbench_root/tools`` into the overlay, writes a ``godot`` wrapper,
    and returns resolved paths for agent instructions.
    """
    overlay_workspace = overlay_workspace.resolve()
    gcbench_root = gcbench_root.resolve()
    godot = (godot_bin or resolve_godot_executable() or "").strip()
    if not godot:
        raise RuntimeError(
            "Godot executable not found; run scripts/setup_godot.sh or set GODOT_EXEC_PATH"
        )

    tools_src = gcbench_root / "tools"
    tools_dst = overlay_workspace / "tools"
    if tools_src.is_dir():
        shutil.copytree(tools_src, tools_dst, dirs_exist_ok=True)
    else:
        tools_dst.mkdir(parents=True, exist_ok=True)

    # Text-only is a capability boundary, not merely a prompt preference.  Do
    # not stage an executable that can capture pixels for a text-only model.
    if text_only_mode():
        screenshot = tools_dst / "screenshot.sh"
        if screenshot.exists():
            screenshot.unlink()

    wrapper = tools_dst / "godot"
    wrapper.write_text(
        "#!/usr/bin/env bash\n"
        f'exec "{godot}" "$@"\n',
        encoding="utf-8",
    )
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    bestiary_overlay = overlay_workspace / "game" / "scripts" / "BestiaryOverlay.gd"
    bestiary_panel = overlay_workspace / "game" / "scripts" / "BestiaryPanel.gd"
    if bestiary_overlay.is_file() and not bestiary_panel.exists():
        bestiary_panel.write_text(
            'extends "res://scripts/BestiaryOverlay.gd"\n',
            encoding="utf-8",
        )

    runtime_note = overlay_workspace / "RUNTIME_PATHS.md"
    visual_note = (
        "- Visual capture is disabled for this text-only backbone. Use bounded "
        "headless runtime logs and deterministic demo traces.\n"
        if text_only_mode()
        else "- Screenshot helper: `tools/screenshot.sh --path game ...`\n"
    )
    runtime_note.write_text(
        "# Local runtime paths\n\n"
        "These paths are preconfigured for this run. **Do not search the filesystem for Godot.**\n\n"
        "- Writable workspace root: the process current working directory (`pwd`)\n"
        f"- Godot binary: `{godot}`\n"
        "- Godot command: `tools/godot` (wrapper in this workspace)\n"
        "- Game project: `game/` (same as `/workspace/game/` in the task spec)\n"
        "- Use relative paths under `pwd`; a staging path from an earlier phase is not writable output.\n"
        "- CLI reference: `tools/godot_command_line.md`\n"
        + visual_note,
        encoding="utf-8",
    )

    return {
        "godot_bin": godot,
        "game_dir": "game",
        "tools_dir": "tools",
        "runtime_note": str(runtime_note),
    }


def render_runtime_instruction_block(runtime: dict[str, str]) -> str:
    """Short instruction block appended to the agent prompt."""
    godot = runtime["godot_bin"]
    tools_line = (
        "- Tools: `tools/godot_command_line.md`, `RUNTIME_PATHS.md`\n"
        "- Visual capture is disabled. Validate with headless Godot logs and "
        "deterministic input traces.\n"
        if text_only_mode()
        else "- Tools: `tools/godot_command_line.md`, `tools/screenshot.sh`, `RUNTIME_PATHS.md`\n"
    )
    return (
        "## Local runtime (preconfigured)\n\n"
        "- Writable workspace root: the process current working directory (`pwd`).\n"
        "- Treat `pwd` as `/workspace`; use its `game/` project only.\n"
        "- Use relative paths. Do not reuse an absolute staging or repository path from the task text.\n"
        f"- Godot: `{godot}` — run via `tools/godot` from the workspace root\n"
        "- Project: `game/`\n"
        + tools_line
        +
        "- Do **not** run `find /` or otherwise search the host filesystem for Godot.\n"
    )


def sanitize_public_instruction(instruction: str) -> str:
    """Remove visual-tool directions while preserving gameplay requirements.

    GameCraftBench task prose may advertise ``screenshot.sh``.  Keeping that
    paragraph would make the model chase a capability which the text-only
    harness intentionally does not expose.  We remove only helper/command
    paragraphs; visual quality requirements remain part of the task.
    """

    if not text_only_mode() or not instruction:
        return instruction
    def _drop_visual_fence(match: re.Match[str]) -> str:
        block = match.group(0)
        return "" if "screenshot" in block.casefold() else block

    without_fences = re.sub(
        r"```[^\n]*\n.*?```",
        _drop_visual_fence,
        instruction,
        flags=re.DOTALL,
    )
    paragraphs = re.split(r"\n\s*\n", without_fences)
    kept = [
        paragraph
        for paragraph in paragraphs
        if "screenshot" not in paragraph.casefold()
    ]
    return "\n\n".join(part for part in kept if part.strip()).rstrip() + "\n"


def ensure_godot_env() -> str:
    """Resolve Godot and export standard env vars. Returns the binary path."""
    godot = (
        os.environ.get("GODOT_EXEC_PATH", "").strip()
        or os.environ.get("GODOT_BIN", "").strip()
        or resolve_godot_executable()
        or ""
    )
    if not godot:
        raise RuntimeError(
            "Godot executable not found; run scripts/setup_godot.sh or set GODOT_EXEC_PATH"
        )
    os.environ["GODOT_EXEC_PATH"] = godot
    os.environ["GODOT_BIN"] = godot
    return godot
