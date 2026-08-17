#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from evaluate_tinymmo import REQUIRED_ARCHITECTURE, _run_godot_import
from evaluate_tinymmo_boss_hud import _integration


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def _int_constant(source: str, name: str) -> int:
    match = re.search(rf"^\s*const\s+{re.escape(name)}(?:\s*:\s*int)?\s*=\s*(\d+)", source, re.MULTILINE)
    return int(match.group(1)) if match else 0


def _presentation(project: Path) -> dict[str, Any]:
    hud_path = project / "source/client/ui/hud/boss_encounter_hud.gd"
    hud = _read(hud_path)
    lower = hud.lower()
    other_client = "\n".join(
        _read(path)
        for path in (project / "source/client").rglob("*.gd")
        if path != hud_path
    )

    has_tween = "create_tween" in lower or "tween_property" in lower
    new_encounter_gate = bool(
        re.search(r"(?:id|encounter_id)\s*!=\s*_(?:encounter_id|current_encounter_id)", lower)
    )
    phase_change_gate = bool(
        re.search(r"phase\s*(?:>|!=)\s*_(?:last_)?phase", lower)
        or re.search(r"_(?:last_)?phase\s*(?:!=|<)\s*phase", lower)
    )
    victory_words = any(word in lower for word in ("victory", "defeated", "vanquished", "boss down"))
    danger_words = any(word in lower for word in ("move out", "dodge", "danger", "incoming", "slam"))
    intro_words = any(word in lower for word in ("boss reveal", "encounter", "approaches", "awaken", "intro"))
    phase_words = any(word in lower for word in ("enrage", "enraged", "phase 2"))
    delayed_end = victory_words and (
        "create_timer" in lower or "tween_interval" in lower or "await" in lower
    )
    immediate_abort = "aborted" in lower and any(
        marker in lower for marker in ("if aborted", "payload.get(\"aborted\"", "bool(payload.get(\"aborted\"")
    )
    cast_state = all(marker in lower for marker in ("cast_name", "cast_remaining_ms"))
    cast_visual_change = danger_words and has_tween and any(
        marker in lower for marker in ("font_color", "bg_color", "modulate", "self_modulate")
    )
    persistent_width = bool(
        re.search(r"custom_minimum_size\s*=\s*Vector2\((?:[4-9]\d\d|\d{4,})", hud)
        or re.search(r"offset_left\s*=\s*-(?:[2-9]\d\d)", hud)
    )
    stable_layout = "custom_minimum_size" in lower and (
        "anchor_left" in lower or "anchors_preset" in lower
    )
    frame_width = _int_constant(hud, "FRAME_WIDTH")
    hp_bar_width = _int_constant(hud, "HP_BAR_WIDTH")
    hp_bar_height = _int_constant(hud, "HP_BAR_HEIGHT")
    cast_action_match = re.search(
        r"_cast_action_label\s*=\s*Label\.new\(\)([\s\S]*?)(?=_cast_timer_label\s*=)",
        hud,
    )
    cast_action_block = cast_action_match.group(1) if cast_action_match else ""
    dominant_persistent_frame = persistent_width and stable_layout or frame_width >= 560
    demo_scale_health_bar = bool(
        re.search(r"custom_minimum_size\s*=\s*Vector2\((?:5[2-9]\d|[6-9]\d\d|\d{4,})\s*,\s*(?:2[4-9]|[3-9]\d)", hud)
        or (hp_bar_width >= 520 and hp_bar_height >= 24)
    )
    center_cast_banner = bool(
        danger_words
        and re.search(r"font_size[^\n]*(?:3[6-9]|[4-9]\d|\d{3,})", cast_action_block)
        and (
            re.search(r"offset_left\s*=\s*-(?:3[5-9]\d|[4-9]\d\d)", hud)
            or re.search(r"_cast_banner\.custom_minimum_size\s*=\s*Vector2\((?:5\d\d|[6-9]\d\d)", hud)
        )
    )
    persistent_phase_escalation = bool(
        phase_words
        and re.search(r"phase\s*>=\s*2", lower)
        and any(
            marker in lower
            for marker in ("_apply_phase", "phase_style", "enrage_badge", "enraged_badge", "phase_badge")
        )
    )
    centered_encounter_frame = all(
        marker in hud
        for marker in (
            "_frame.anchor_left = 0.5",
            "_frame.anchor_right = 0.5",
            "_frame.offset_left = -320.0",
            "_frame.offset_right = 320.0",
        )
    )
    centered_cast_banner = all(
        marker in hud
        for marker in (
            "_cast_banner.anchor_left = 0.5",
            "_cast_banner.anchor_right = 0.5",
            "_cast_banner.offset_left = -260.0",
            "_cast_banner.offset_right = 260.0",
        )
    )
    viewport_width_anchor_explicit = all(
        marker in hud
        for marker in (
            "anchor_left = 0.0",
            "anchor_right = 1.0",
            "anchor_top = 0.0",
            "anchor_bottom = 0.0",
            "offset_left = 0.0",
            "offset_right = 0.0",
        )
    )
    no_fake_payload = not any(
        marker in lower + other_client.lower()
        for marker in ("fake_boss", "mock_boss", "demo_payload", "preview_boss_state")
    )
    no_alt_scene = not any(
        "boss" in path.name.lower() and path.suffix == ".tscn"
        for path in project.rglob("*.tscn")
        if "tests" not in path.relative_to(project).parts
        if "source/common/gameplay/maps/maps/dungeon/dungeon.tscn" not in path.as_posix()
    )
    # Godot's editor import does not execute dynamically-created Controls. Keep
    # known-invalid runtime API spellings from receiving a visual-impact pass.
    runtime_safe_control_api = "add_theme_outline_size_override" not in lower

    checks = {
        "production_hud_present": bool(hud),
        "dominant_persistent_frame": dominant_persistent_frame,
        "demo_scale_health_bar": demo_scale_health_bar,
        "center_screen_cast_banner": center_cast_banner,
        "centered_encounter_frame": centered_encounter_frame,
        "centered_cast_banner": centered_cast_banner,
        "viewport_width_anchor_explicit": viewport_width_anchor_explicit,
        "persistent_phase_escalation": persistent_phase_escalation,
        "new_encounter_reveal_gate": new_encounter_gate and intro_words and has_tween,
        "cast_urgency_copy": cast_state and danger_words,
        "cast_urgency_visual": cast_state and cast_visual_change,
        "phase_transition_gate": phase_change_gate and phase_words and has_tween,
        "victory_feedback": delayed_end,
        "abort_cleanup_preserved": immediate_abort,
        "revision_gate_preserved": "revision <= _last_revision" in hud,
        "clock_safe_countdown_preserved": all(
            marker in lower for marker in ("cast_remaining_ms", "local_received_ms", "elapsed_since_push_ms")
        ),
        "instance_disconnect_cleanup_preserved": "instance_changed" in lower and "connection_changed" in lower,
        "no_fake_payload": no_fake_payload,
        "no_alternate_boss_scene": no_alt_scene,
        "runtime_safe_control_api": runtime_safe_control_api,
        "bounded_node_creation": "func _process" in lower and "new()" not in re.search(
            r"func _process[\s\S]*?(?=\nfunc |\Z)", hud
        ).group(0) if re.search(r"func _process[\s\S]*?(?=\nfunc |\Z)", hud) else True,
    }
    return {
        "score": sum(checks.values()) / len(checks),
        "checks": checks,
        "diagnostics": [f"boss demo presentation missing: {name}" for name, passed in checks.items() if not passed],
    }


def evaluate(project: Path, *, godot_bin: str, timeout_seconds: int = 180) -> dict[str, Any]:
    project = project.resolve()
    missing = [item for item in REQUIRED_ARCHITECTURE if not (project / item).exists()]
    runtime = _run_godot_import(project, godot_bin, timeout_seconds)
    runtime_health = 1.0 if runtime["complete"] and not runtime["compile_errors"] else 0.0
    integration = _integration(project)
    presentation = _presentation(project)
    preserved_checks = integration["checks"]
    production_preserved = all(
        preserved_checks[name]
        for name in (
            "real_final_room",
            "room_controller_path",
            "server_pushes_boss_state",
            "late_subscriber_recovery",
            "slam_combat_preserved",
            "enrage_combat_preserved",
            "add_spawn_contract_preserved",
            "client_subscribes",
            "hud_production_integration",
        )
    )
    runtime_safe_control_api = bool(
        presentation["checks"].get("runtime_safe_control_api", False)
    )
    diagnostics = [f"missing architecture path: {item}" for item in missing]
    diagnostics.extend(runtime["diagnostics"])
    diagnostics.extend(integration["diagnostics"])
    diagnostics.extend(presentation["diagnostics"])
    objectives = {
        "architecture_integrity": round(1.0 - len(missing) / len(REQUIRED_ARCHITECTURE), 6),
        "runtime_health": round(runtime_health, 6),
        "production_path_preservation": 1.0 if production_preserved else 0.0,
        "boss_demo_visual_impact": round(float(presentation["score"]), 6),
    }
    primary = (
        0.10 * objectives["architecture_integrity"]
        + 0.15 * runtime_health
        + 0.20 * objectives["production_path_preservation"]
        + 0.55 * float(presentation["score"])
    )
    return {
        "schema_version": "tinymmo-boss-demo-evaluation-v1",
        "status": "completed",
        "primary_score": round(primary, 6),
        "objectives": objectives,
        "constraints": {
            "architecture_intact": not missing,
            "godot_validation_complete": bool(runtime["complete"]),
            "gdscript_compiles": not runtime["compile_errors"],
            "hud_runtime_api_safe": runtime_safe_control_api,
            "real_boss_path_preserved": production_preserved,
            "authoritative_state_preserved": all(
                preserved_checks[name]
                for name in ("monotonic_revision", "clock_safe_cast_timing", "late_subscriber_recovery")
            ),
        },
        "diagnostics": diagnostics[:40],
        "details": {
            "godot": runtime,
            "boss_hud_integration": integration,
            "boss_demo_presentation": presentation,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate Tiny MMO high-impact Boss presentation")
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--godot-bin", default=os.environ.get("GODOT_BIN", "/Applications/Godot.app/Contents/MacOS/Godot"))
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
    if not Path(args.godot_bin).is_file() and shutil.which(args.godot_bin) is None:
        result = {
            "schema_version": "tinymmo-boss-demo-evaluation-v1",
            "status": "infrastructure_failure",
            "primary_score": None,
            "objectives": {},
            "constraints": {},
            "diagnostics": [f"Godot binary is unavailable: {args.godot_bin}"],
        }
        code = 2
    else:
        result = evaluate(args.artifact, godot_bin=args.godot_bin, timeout_seconds=args.timeout)
        code = 0
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
