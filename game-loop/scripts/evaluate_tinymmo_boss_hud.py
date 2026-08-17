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


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def _integration(project: Path) -> dict[str, Any]:
    boss = _read(project / "source/common/gameplay/dungeon/boss_controller.gd")
    room = _read(project / "source/common/gameplay/dungeon/room_node.gd")
    dungeon = _read(project / "source/common/gameplay/maps/maps/dungeon/dungeon.tscn")
    hud_scene = _read(project / "source/client/ui/hud/hud.tscn")
    hud_script = _read(project / "source/client/ui/hud/hud.gd")
    topic = re.compile(r"boss\.state")
    client_files = list((project / "source/client").rglob("*.gd"))
    client_sources = "\n".join(_read(path) for path in client_files)
    boss_hud_files = [
        path for path in (project / "source/client").rglob("*")
        if path.is_file()
        and "boss" in path.name.lower()
        and path.suffix in {".gd", ".tscn"}
    ]
    boss_hud_sources = "\n".join(_read(path) for path in boss_hud_files)
    subscribed_sources = "\n".join(
        source for path in client_files
        if (source := _read(path)) and topic.search(source)
    )
    boss_lower = boss.lower()
    boss_hud_lower = boss_hud_sources.lower()
    subscribed_lower = subscribed_sources.lower()
    state_payload = bool(re.search(r"data_push[\s\S]{0,240}boss\.state", boss))
    heartbeat_name = r"(?:STATE_(?:PUSH_)?HEARTBEAT_MS|BOSS_STATE_(?:HEARTBEAT|INTERVAL)_MS|HEARTBEAT_INTERVAL_MS|STATE_INTERVAL_MS)"
    heartbeat_constant = re.search(
        heartbeat_name + r"\s*:\s*int\s*=\s*(\d+)",
        boss,
        re.IGNORECASE,
    )
    heartbeat_ms = int(heartbeat_constant.group(1)) if heartbeat_constant else None
    heartbeat_bounded = heartbeat_ms is not None and 1000 <= heartbeat_ms <= 2000
    heartbeat_clock = bool(re.search(r"last_(?:state_)?push_ms|next_(?:state_)?push_ms|heartbeat_at_ms", boss_lower))
    physics_match = re.search(r"func _physics_process\([^\n]*\)[\s\S]*?(?=\nfunc |\Z)", boss)
    physics_source = physics_match.group(0) if physics_match else ""
    direct_interval_guard = bool(
        re.search(
            r"(?:now_ms|Time\.get_ticks_msec\(\))[\s\S]*?" + heartbeat_name,
            physics_source,
            re.IGNORECASE,
        )
    )
    deadline_guard = bool(
        re.search(
            r"(?:now_ms|Time\.get_ticks_msec\(\))\s*>=\s*_(?:next_(?:state_)?(?:push|heartbeat)_ms|heartbeat_at_ms)",
            physics_source,
            re.IGNORECASE,
        )
    )
    deadline_schedule = bool(
        re.search(
            r"_(?:next_(?:state_)?(?:push|heartbeat)_ms|heartbeat_at_ms)\s*=\s*now_ms\s*\+\s*" + heartbeat_name,
            boss,
            re.IGNORECASE,
        )
    )
    heartbeat_guard = direct_interval_guard or (deadline_guard and deadline_schedule)
    heartbeat_push = "_push_boss_state(true)" in physics_source
    hud_scene_wired = any(path.as_posix().replace(project.as_posix() + "/", "res://") in hud_scene for path in boss_hud_files if path.suffix == ".tscn")
    hud_script_wired = "BossEncounterHUD.new()" in hud_script
    checks = {
        "real_final_room": "FinalRoom" in dungeon and "boss = true" in dungeon,
        "room_controller_path": "BossController" in room and "boss =" in room,
        "server_pushes_boss_state": state_payload,
        "stable_encounter_id": state_payload and any(key in boss_lower for key in ("encounter_id", "boss_id")),
        "authoritative_health": state_payload and '"health"' in boss_lower and any(key in boss_lower for key in ('"health_max"', '"max_health"')),
        "phase_payload": state_payload and '"phase"' in boss_lower,
        "cast_payload": state_payload and '"cast' in boss_lower and ("deadline" in boss_lower or "remaining" in boss_lower),
        "bounded_updates": state_payload and any(marker in boss_lower for marker in ("health_changed", "last_health", "state_dirty", "state_interval")),
        "late_subscriber_recovery": state_payload and heartbeat_bounded and heartbeat_clock and heartbeat_guard and heartbeat_push,
        "server_instance_resolution_preserved": "var map: Node = boss.container.get_parent()" in boss and "return map.get_parent() if map != null else null" in boss,
        "slam_combat_preserved": all(marker in boss for marker in ('replicate_visual(&"rp_cast_telegraph"', 'replicate_visual(&"rp_slam_impact"', "action_root_until_ms", "player.take_damage(slam_damage, boss)")),
        "enrage_combat_preserved": all(marker in boss for marker in ("boss.move_speed", "_announce_enrage()", "_summon_adds.call_deferred()")),
        "add_spawn_contract_preserved": all(marker in boss for marker in ("ReplicatedPropsContainer.SCENE_HOSTILE_NPC", "container.to_local(spot)", "RoomNode.make_dungeon_mob(add, false)")),
        "encounter_end_push": state_payload and any(marker in boss_lower for marker in ('"ended"', '"active": false', "push_boss_state(false")),
        "monotonic_revision": state_payload and any(marker in boss_lower for marker in ('"revision"', '"sequence"')) and any(marker in subscribed_lower for marker in ("last_revision", "last_sequence")),
        "clock_safe_cast_timing": state_payload and any(marker in boss_lower for marker in ('"cast_remaining_ms"', '"server_now_ms"', '"cast_duration_ms"')) and any(marker in subscribed_lower for marker in ("cast_remaining_ms", "server_now_ms", "cast_duration_ms")),
        "client_subscribes": bool(topic.search(subscribed_sources)) and "subscribe" in subscribed_sources,
        "hud_production_integration": bool(boss_hud_files) and (hud_scene_wired or hud_script_wired),
        "boss_name_visible": "name" in boss_hud_lower and "label" in boss_hud_lower,
        "health_bar_visible": "progressbar" in boss_hud_lower or "textureprogressbar" in boss_hud_lower,
        "numeric_health_visible": "health" in boss_hud_lower and any(marker in boss_hud_lower for marker in ("health_max", "max_health")),
        "phase_visible": "phase" in boss_hud_lower,
        "cast_visible": "cast" in boss_hud_lower and ("progress" in boss_hud_lower or "remaining" in boss_hud_lower),
        "stale_update_guard": any(marker in subscribed_lower for marker in ("encounter_id", 'payload.get("id"')) and any(marker in subscribed_lower for marker in ("last_revision", "last_sequence")),
        "cleanup_on_end": "hide" in subscribed_lower and ("ended" in subscribed_lower or "active" in subscribed_lower),
        "cleanup_on_instance_change": "instance_changed" in subscribed_sources and any(marker in subscribed_lower for marker in ("reset", "clear", "hide")),
        "cleanup_on_disconnect": any(marker in subscribed_lower for marker in ("disconnect", "gateway")) and any(marker in subscribed_lower for marker in ("reset", "clear", "hide")),
    }
    return {
        "score": sum(checks.values()) / len(checks),
        "checks": checks,
        "diagnostics": [f"boss HUD integration missing: {name}" for name, passed in checks.items() if not passed],
        "boss_hud_files": [str(path.relative_to(project)) for path in boss_hud_files],
        "state_heartbeat_ms": heartbeat_ms,
    }


def evaluate(project: Path, *, godot_bin: str, timeout_seconds: int = 180) -> dict[str, Any]:
    project = project.resolve()
    missing = [item for item in REQUIRED_ARCHITECTURE if not (project / item).exists()]
    architecture = 1.0 - len(missing) / len(REQUIRED_ARCHITECTURE)
    runtime = _run_godot_import(project, godot_bin, timeout_seconds)
    runtime_health = 1.0 if runtime["complete"] and not runtime["compile_errors"] else 0.0
    integration = _integration(project)
    diagnostics = [f"missing architecture path: {item}" for item in missing]
    diagnostics.extend(runtime["diagnostics"])
    diagnostics.extend(integration["diagnostics"])
    production_path = 1.0 if integration["checks"]["real_final_room"] and integration["checks"]["room_controller_path"] else 0.0
    combat_path_checks = (
        "server_instance_resolution_preserved",
        "slam_combat_preserved",
        "enrage_combat_preserved",
        "add_spawn_contract_preserved",
    )
    combat_path_preserved = all(integration["checks"][name] for name in combat_path_checks)
    maintainability_checks = (
        any(project.rglob("*boss*hud*.gd")),
        any(project.rglob("*boss*test*.gd")),
        "##" in _read(project / "source/common/gameplay/dungeon/boss_controller.gd"),
    )
    maintainability = sum(maintainability_checks) / len(maintainability_checks)
    objectives = {
        "architecture_integrity": round(architecture, 6),
        "runtime_health": round(runtime_health, 6),
        "boss_hud_production_integration": round(float(integration["score"]), 6),
        "real_scene_coverage": round(production_path, 6),
        "maintainability": round(maintainability, 6),
    }
    primary = (
        0.15 * architecture + 0.15 * runtime_health
        + 0.60 * float(integration["score"]) + 0.05 * production_path + 0.05 * maintainability
    )
    return {
        "schema_version": "tinymmo-boss-hud-evaluation-v1",
        "status": "completed",
        "primary_score": round(primary, 6),
        "objectives": objectives,
        "constraints": {
            "architecture_intact": not missing,
            "godot_validation_complete": bool(runtime["complete"]),
            "gdscript_compiles": not runtime["compile_errors"],
            "real_dungeon_path_preserved": bool(production_path),
            "boss_combat_path_preserved": combat_path_preserved,
        },
        "diagnostics": diagnostics[:30],
        "details": {"godot": runtime, "boss_hud_integration": integration},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate Tiny MMO production boss HUD")
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--godot-bin", default=os.environ.get("GODOT_BIN", "/Applications/Godot.app/Contents/MacOS/Godot"))
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
    if not Path(args.godot_bin).is_file() and shutil.which(args.godot_bin) is None:
        result = {
            "schema_version": "tinymmo-boss-hud-evaluation-v1",
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
