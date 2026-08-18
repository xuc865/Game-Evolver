#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


DIRECTOR_DIR = Path("game/mods/pxt_director")

CLASSIC_TARGETS = {
    "dialogue_lines": 48,
    "stage_commands": 30,
    "transitions": 18,
    "audio_cues": 6,
    "labels_plus_screens": 7,
}

LONGFORM_TARGETS = {
    "dialogue_lines": 150,
    "stage_commands": 75,
    "transitions": 60,
    "audio_cues": 18,
    "labels_plus_screens": 16,
    "labels": 12,
    "screens": 3,
    "menu_blocks": 2,
}


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def _all_rpy(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*.rpy") if path.is_file())


def _run_compile(project: Path, renpy_bin: str, timeout: int) -> dict[str, Any]:
    command = [renpy_bin, str(project), "compile"]
    env = os.environ.copy()
    env.setdefault("SDL_AUDIODRIVER", "dummy")
    try:
        completed = subprocess.run(
            command,
            cwd=project,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "complete": False,
            "returncode": None,
            "diagnostics": [f"Ren'Py compile timed out after {timeout}s"],
            "output_tail": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
        }
    output = completed.stdout or ""
    fatal_markers = ("Full traceback:", "Parsing the script failed", "Exception:")
    # KSRE starts a best-effort Discord Rich Presence thread during compile. On
    # machines without Discord it prints a thread traceback but still exits 0.
    discord_only = "DiscordNotFound" in output and completed.returncode == 0
    failed = completed.returncode != 0 or (
        any(marker in output for marker in fatal_markers) and not discord_only
    )
    return {
        "complete": not failed,
        "returncode": completed.returncode,
        "diagnostics": [] if not failed else ["Ren'Py compile failed"],
        "output_tail": output[-4000:],
    }


def _missing_mod_assets(project: Path, source: str) -> list[str]:
    assets: set[str] = set()
    for match in re.finditer(
        r"['\"](?P<asset>mods/[^'\"]+\.(?:png|jpg|jpeg|webp|ogg|wav|mp3))['\"]",
        source,
        flags=re.IGNORECASE,
    ):
        assets.add(match.group("asset"))
    return sorted(asset for asset in assets if not (project / "game" / asset).is_file())


def _score_ratio(value: int, target: int) -> float:
    return min(1.0, value / target) if target > 0 else 1.0


def _presentation(project: Path, profile: str = "classic") -> dict[str, Any]:
    director = project / DIRECTOR_DIR
    pxt = project / "game/mods/pxt"
    files = _all_rpy(director) if director.is_dir() else []
    source = "\n".join(_read(path) for path in files)
    lower = source.lower()
    root_sources = "\n".join(_read(project / rel) for rel in (
        "game/screens.rpy",
        "game/labels.rpy",
        "game/mods/pxt/definitions.rpy",
    ))

    dialogue_lines = len(
        re.findall(r"^\s*(?:[a-zA-Z_]\w*|\"[^\"]+\")\s+\"[^\"]+\"", source, re.MULTILINE)
    )
    stage_commands = len(re.findall(r"^\s*(?:scene|show|hide)\s+", source, re.MULTILINE))
    transitions = len(re.findall(r"\bwith\s+[a-zA-Z_]\w*|\bFade\(|\bDissolve\(", source))
    audio_cues = len(re.findall(r"^\s*(?:play|stop)\s+(?:music|sound|ambient)", source, re.MULTILINE))
    choices = len(re.findall(r"^\s*menu\s*:", source, re.MULTILINE))
    choice_options = len(re.findall(r"^\s*\"[^\"]+\"\s*:", source, re.MULTILINE))
    labels = len(re.findall(r"^\s*label\s+", source, re.MULTILINE))
    screens = len(re.findall(r"^\s*screen\s+", source, re.MULTILINE))

    menu_registered = bool(re.search(r"mods\s*\[\s*['\"]pxt_director['\"]\s*\]", source))
    has_own_menu = bool(re.search(r"screen\s+pxt_director\b", source))
    has_start_label = bool(re.search(r"label\s+pxt_director_start\b", source))
    has_program = any(token in lower for token in ("program", "director", "stage notes", "cue sheet"))
    has_toggle = any(token in lower for token in ("togglevariable", "commentary", "director_notes"))
    has_branch = choices > 0 or "jump expression" in lower or "if director" in lower
    has_payoff = any(token in lower for token in ("curtain call", "applause", "encore", "bow", "finale"))
    has_accessible_copy = any(token in lower for token in ("audio cue", "stage direction", "self-voicing", "accessibility"))
    uses_pxt_assets = "mods/pxt/" in source
    missing_assets = _missing_mod_assets(project, source)
    pxt_preserved = all(
        (pxt / name).is_file()
        for name in ("pxt.rpy", "definitions.rpy", "screens.rpy", "labels.rpy")
    )
    original_mod_menu_present = "screen mods" in root_sources and "mods.iteritems()" in root_sources

    checks = {
        "director_mod_directory": director.is_dir(),
        "pxt_original_preserved": pxt_preserved,
        "ksre_mod_menu_preserved": original_mod_menu_present,
        "director_registered": menu_registered,
        "director_has_menu": has_own_menu,
        "director_start_label": has_start_label,
        "no_missing_director_assets": not missing_assets,
        "uses_real_pxt_assets": uses_pxt_assets,
        "has_program_or_cue_sheet": has_program,
        "has_commentary_toggle": has_toggle,
        "has_player_choice_or_branch": has_branch,
        "has_curtain_call_payoff": has_payoff,
        "has_accessible_stage_copy": has_accessible_copy,
        "dialogue_volume": dialogue_lines >= 36,
        "stage_direction_volume": stage_commands >= 22,
        "transition_volume": transitions >= 12,
        "audio_cue_volume": audio_cues >= 4,
        "multi_label_structure": labels >= 3,
        "custom_screen_structure": screens >= 2,
    }
    if profile == "longform":
        checks.update(
            {
                "longform_dialogue_volume": dialogue_lines >= 120,
                "longform_stage_volume": stage_commands >= 55,
                "longform_multi_branching": choices >= 2 or choice_options >= 4,
                "longform_scene_structure": labels >= 10 and screens >= 3,
                "longform_audio_pacing": audio_cues >= 14 and transitions >= 40,
            }
        )
        components = {
            "menu_integration": sum(checks[name] for name in (
                "director_registered",
                "director_has_menu",
                "director_start_label",
                "ksre_mod_menu_preserved",
            )) / 4.0,
            "content_richness": (
                0.30 * _score_ratio(dialogue_lines, LONGFORM_TARGETS["dialogue_lines"])
                + 0.22 * _score_ratio(stage_commands, LONGFORM_TARGETS["stage_commands"])
                + 0.18 * _score_ratio(transitions, LONGFORM_TARGETS["transitions"])
                + 0.15 * _score_ratio(audio_cues, LONGFORM_TARGETS["audio_cues"])
                + 0.15 * _score_ratio(labels + screens, LONGFORM_TARGETS["labels_plus_screens"])
            ),
            "episode_depth": (
                0.28 * _score_ratio(dialogue_lines, LONGFORM_TARGETS["dialogue_lines"])
                + 0.20 * _score_ratio(labels, LONGFORM_TARGETS["labels"])
                + 0.18 * _score_ratio(max(choices, choice_options / 2), LONGFORM_TARGETS["menu_blocks"])
                + 0.17 * _score_ratio(transitions, LONGFORM_TARGETS["transitions"])
                + 0.17 * _score_ratio(audio_cues, LONGFORM_TARGETS["audio_cues"])
            ),
            "playable_polish": sum(checks[name] for name in (
                "has_program_or_cue_sheet",
                "has_commentary_toggle",
                "has_player_choice_or_branch",
                "has_curtain_call_payoff",
                "has_accessible_stage_copy",
                "longform_multi_branching",
                "longform_scene_structure",
            )) / 7.0,
            "asset_safety": sum(checks[name] for name in (
                "pxt_original_preserved",
                "no_missing_director_assets",
                "uses_real_pxt_assets",
            )) / 3.0,
        }
        score = (
            0.20 * components["menu_integration"]
            + 0.30 * components["content_richness"]
            + 0.25 * components["episode_depth"]
            + 0.15 * components["playable_polish"]
            + 0.10 * components["asset_safety"]
        )
    else:
        components = {
            "menu_integration": sum(checks[name] for name in (
                "director_registered",
                "director_has_menu",
                "director_start_label",
                "ksre_mod_menu_preserved",
            )) / 4.0,
            "content_richness": (
                0.30 * _score_ratio(dialogue_lines, CLASSIC_TARGETS["dialogue_lines"])
                + 0.22 * _score_ratio(stage_commands, CLASSIC_TARGETS["stage_commands"])
                + 0.18 * _score_ratio(transitions, CLASSIC_TARGETS["transitions"])
                + 0.15 * _score_ratio(audio_cues, CLASSIC_TARGETS["audio_cues"])
                + 0.15 * _score_ratio(labels + screens, CLASSIC_TARGETS["labels_plus_screens"])
            ),
            "playable_polish": sum(checks[name] for name in (
                "has_program_or_cue_sheet",
                "has_commentary_toggle",
                "has_player_choice_or_branch",
                "has_curtain_call_payoff",
                "has_accessible_stage_copy",
            )) / 5.0,
            "asset_safety": sum(checks[name] for name in (
                "pxt_original_preserved",
                "no_missing_director_assets",
                "uses_real_pxt_assets",
            )) / 3.0,
        }
        score = (
            0.30 * components["menu_integration"]
            + 0.30 * components["content_richness"]
            + 0.25 * components["playable_polish"]
            + 0.15 * components["asset_safety"]
        )
    return {
        "profile": profile,
        "score": round(score, 6),
        "components": {name: round(value, 6) for name, value in components.items()},
        "checks": checks,
        "counts": {
            "dialogue_lines": dialogue_lines,
            "stage_commands": stage_commands,
            "transitions": transitions,
            "audio_cues": audio_cues,
            "choices": choices,
            "choice_options": choice_options,
            "labels": labels,
            "screens": screens,
            "rpy_files": len(files),
        },
        "missing_assets": missing_assets[:20],
        "diagnostics": [f"presentation missing: {name}" for name, passed in checks.items() if not passed],
    }


def evaluate(project: Path, *, renpy_bin: str, timeout: int, profile: str = "classic") -> dict[str, Any]:
    project = project.resolve()
    required = (
        "game/config.rpy",
        "game/screens.rpy",
        "game/labels.rpy",
        "game/mods/pxt/definitions.rpy",
        "game/mods/pxt/screens.rpy",
        "game/mods/pxt/pxt.rpy",
    )
    missing = [item for item in required if not (project / item).is_file()]
    compile_result = _run_compile(project, renpy_bin, timeout)
    presentation = _presentation(project, profile=profile)
    compile_ok = bool(compile_result["complete"])
    primary = (
        0.20 * (1.0 if not missing else 0.0)
        + 0.25 * (1.0 if compile_ok else 0.0)
        + 0.55 * float(presentation["score"])
    )
    diagnostics = [f"missing required KSRE path: {item}" for item in missing]
    diagnostics.extend(compile_result["diagnostics"])
    diagnostics.extend(presentation["diagnostics"])
    if presentation["missing_assets"]:
        diagnostics.append("missing director assets: " + ", ".join(presentation["missing_assets"][:6]))
    return {
        "schema_version": f"ksre-pxt-director-evaluation-v1-{profile}",
        "status": "completed" if compile_ok and not missing else "infrastructure_failure",
        "primary_score": round(primary, 6) if compile_ok and not missing else None,
        "objectives": {
            "ksre_required_paths": 1.0 if not missing else 0.0,
            "renpy_compile": 1.0 if compile_ok else 0.0,
            "director_mod_visual_richness": presentation["score"],
            **{f"director_{name}": value for name, value in presentation["components"].items()},
        },
        "constraints": {
            "ksre_seed_paths_present": not missing,
            "renpy_compile_complete": compile_ok,
            "pxt_original_preserved": bool(presentation["checks"].get("pxt_original_preserved")),
            "no_missing_director_assets": bool(presentation["checks"].get("no_missing_director_assets")),
        },
        "diagnostics": diagnostics[:40],
        "details": {
            "compile": compile_result,
            "presentation": presentation,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate KSRE pXt Director's Cut mod evolution")
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--renpy-bin", default=os.environ.get("RENPY_BIN", "renpy"))
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument(
        "--profile",
        choices=("classic", "longform"),
        default=os.environ.get("KSRE_PXT_EVAL_PROFILE", "classic"),
    )
    args = parser.parse_args()
    args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
    renpy_bin = args.renpy_bin
    if Path(renpy_bin).is_file():
        renpy_bin = str(Path(renpy_bin).resolve())
    else:
        from shutil import which

        resolved = which(renpy_bin)
        if resolved is None:
            result = {
                "schema_version": f"ksre-pxt-director-evaluation-v1-{args.profile}",
                "status": "infrastructure_failure",
                "primary_score": None,
                "objectives": {},
                "constraints": {},
                "diagnostics": [f"Ren'Py binary is unavailable: {renpy_bin}"],
            }
            args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(json.dumps(result, sort_keys=True))
            return 2
        renpy_bin = resolved
    result = evaluate(args.artifact, renpy_bin=renpy_bin, timeout=args.timeout, profile=args.profile)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "completed" else 2


if __name__ == "__main__":
    sys.exit(main())
