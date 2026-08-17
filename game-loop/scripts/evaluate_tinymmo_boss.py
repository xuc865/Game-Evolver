#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from evaluate_tinymmo import REQUIRED_ARCHITECTURE, _run_godot_import


TIMELINE_CANDIDATES = (
    "source/common/gameplay/dungeon/boss_attack_timeline.gd",
    "source/common/gameplay/combat/boss_attack_timeline.gd",
    "source/common/gameplay/dungeon/boss_cast_resolver.gd",
    "source/common/gameplay/combat/boss_cast_resolver.gd",
)


def _text(project: Path, relative: str) -> str:
    path = project / relative
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def _find_timeline(project: Path) -> Path | None:
    for relative in TIMELINE_CANDIDATES:
        path = project / relative
        if path.is_file():
            return path
    return None


def _run_timeline_contract(source: Path | None, godot_bin: str, timeout: int) -> dict[str, Any]:
    if source is None:
        return {
            "complete": True,
            "score": 0.0,
            "checks": {},
            "diagnostics": ["deterministic boss attack timeline is missing"],
        }
    with tempfile.TemporaryDirectory(prefix="tinymmo-boss-contract-") as temp_dir:
        root = Path(temp_dir)
        shutil.copy2(source, root / "boss_attack_timeline.gd")
        (root / "project.godot").write_text(
            '[application]\nconfig/name="TinyMMO boss contract"\n'
            '[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
            encoding="utf-8",
        )
        source_text = source.read_text(encoding="utf-8", errors="replace")
        contract_source = (
            _BOSS_RESOLVER_CONTRACT
            if "CastSnapshot" in source_text and "state_at" in source_text and "should_hit" in source_text
            else _BOSS_TIMELINE_CONTRACT
        )
        (root / "contract_test.gd").write_text(contract_source, encoding="utf-8")
        try:
            completed = subprocess.run(
                [godot_bin, "--headless", "--path", str(root), "--script", "contract_test.gd"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=min(timeout, 60),
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {"complete": False, "score": 0.0, "checks": {}, "diagnostics": ["boss contract timed out"]}
        match = re.search(r"TINYMMO_BOSS_CONTRACT:(\{.*\})", completed.stdout)
        if not match:
            errors = [
                line.strip() for line in completed.stdout.splitlines()
                if "ERROR" in line or "Parse Error" in line or "SCRIPT ERROR" in line
            ]
            return {
                "complete": False,
                "score": 0.0,
                "checks": {},
                "diagnostics": errors[:8] or ["boss contract emitted no result"],
            }
        result = json.loads(match.group(1))
        checks = {str(k): bool(v) for k, v in result.get("checks", {}).items()}
        return {
            "complete": True,
            "score": sum(checks.values()) / max(1, len(checks)),
            "checks": checks,
            "diagnostics": [f"boss contract failed: {name}" for name, passed in checks.items() if not passed],
        }


def _score_production_integration(project: Path) -> dict[str, Any]:
    boss = _text(project, "source/common/gameplay/dungeon/boss_controller.gd")
    hostile = _text(project, "source/common/gameplay/characters/npc/hostile_npc.gd")
    room = _text(project, "source/common/gameplay/dungeon/room_node.gd")
    dungeon = _text(project, "source/common/gameplay/maps/maps/dungeon/dungeon.tscn")
    client = _text(project, "source/client/network/instance_client.gd")
    hud_scene = _text(project, "source/client/ui/hud/hud.tscn")
    hud_scripts = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in (project / "source/client/ui").rglob("*.gd")
    ) if (project / "source/client/ui").is_dir() else ""
    all_client = client + "\n" + hud_scene + "\n" + hud_scripts
    checks = {
        "real_final_room_path": "FinalRoom" in dungeon and "boss = true" in dungeon,
        "room_attaches_controller": "BossController" in room and "boss =" in room,
        "timeline_used_by_controller": any(
            marker in boss
            for marker in ("BossAttackTimeline", "boss_attack_timeline", "BossCastResolver", "boss_cast_resolver")
        ),
        "positive_melee_windup": bool(re.search(r"melee[_ ]windup|windup[_ ]ms|windup[_ ]s", boss, re.I)),
        "locked_melee_geometry": bool(re.search(r"locked|strike_center|attack_center|cast_center", boss, re.I)),
        "boss_state_replicated": bool(re.search(r"boss\.(state|status|encounter)", boss)),
        "authoritative_health_in_state": "health" in boss.lower() and "max" in boss.lower(),
        "cast_state_replicated": "cast" in boss.lower() and "windup" in boss.lower(),
        "client_subscribes_boss_state": bool(re.search(r"boss\.(state|status|encounter)", all_client)),
        "production_boss_hud": "boss" in hud_scene.lower() and "health" in all_client.lower(),
        "phase_visible": "phase" in all_client.lower() or "enrage" in all_client.lower(),
        "cleanup_paths": sum(word in all_client.lower() for word in ("disconnect", "instance_changed", "death", "hide")) >= 2,
        "instant_nonboss_path_preserved": "MeleeAttack" in hostile or "attacks" in hostile,
        "impact_visual": "impact" in boss.lower() and "replicate_visual" in boss,
    }
    return {
        "score": sum(checks.values()) / len(checks),
        "checks": checks,
        "diagnostics": [f"production integration missing: {name}" for name, passed in checks.items() if not passed],
    }


def _score_maintainability(project: Path, timeline: Path | None) -> float:
    source = timeline.read_text(encoding="utf-8", errors="replace") if timeline else ""
    checks = (
        bool(source),
        len(source.splitlines()) <= 260,
        "##" in source,
        any(project.rglob("*boss*test*.gd")),
        "Time.get_ticks" not in source,
    )
    return sum(checks) / len(checks)


def evaluate(project: Path, *, godot_bin: str, timeout_seconds: int = 180) -> dict[str, Any]:
    project = project.resolve()
    diagnostics: list[str] = []
    missing = [item for item in REQUIRED_ARCHITECTURE if not (project / item).exists()]
    architecture = 1.0 - len(missing) / len(REQUIRED_ARCHITECTURE)
    diagnostics.extend(f"missing architecture path: {item}" for item in missing)
    runtime = _run_godot_import(project, godot_bin, timeout_seconds)
    runtime_health = 1.0 if runtime["complete"] and not runtime["compile_errors"] else 0.0
    diagnostics.extend(runtime["diagnostics"])
    timeline_path = _find_timeline(project)
    contract = _run_timeline_contract(timeline_path, godot_bin, timeout_seconds)
    integration = _score_production_integration(project)
    diagnostics.extend(contract["diagnostics"])
    diagnostics.extend(integration["diagnostics"])
    maintainability = _score_maintainability(project, timeline_path)
    real_scene = 1.0 if integration["checks"]["real_final_room_path"] and integration["checks"]["room_attaches_controller"] else 0.0
    objectives = {
        "architecture_integrity": round(architecture, 6),
        "runtime_health": round(runtime_health, 6),
        "boss_timing_contract": round(float(contract["score"]), 6),
        "production_encounter_integration": round(float(integration["score"]), 6),
        "real_scene_coverage": round(real_scene, 6),
        "maintainability": round(maintainability, 6),
    }
    primary = (
        0.15 * architecture + 0.15 * runtime_health + 0.30 * float(contract["score"])
        + 0.25 * float(integration["score"]) + 0.10 * real_scene + 0.05 * maintainability
    )
    return {
        "schema_version": "tinymmo-boss-evaluation-v1",
        "status": "completed",
        "primary_score": round(primary, 6),
        "objectives": objectives,
        "constraints": {
            "architecture_intact": not missing,
            "godot_validation_complete": bool(runtime["complete"]),
            "gdscript_compiles": not runtime["compile_errors"],
            "real_dungeon_path_preserved": bool(real_scene),
        },
        "diagnostics": diagnostics[:30],
        "details": {
            "godot": runtime,
            "boss_contract": contract,
            "production_integration": integration,
            "timeline_path": str(timeline_path.relative_to(project)) if timeline_path else None,
        },
    }


_BOSS_TIMELINE_CONTRACT = r'''extends SceneTree

func _initialize() -> void:
	var script := load("res://boss_attack_timeline.gd")
	var timeline: Object = script.new()
	var methods: Array[StringName] = []
	for item: Dictionary in timeline.get_method_list():
		methods.append(item.name)
	var api := [&"begin_at", &"is_due", &"contains", &"cancel", &"snapshot", &"token_is_current"]
	var has_api := true
	for method: StringName in api:
		has_api = has_api and method in methods
	var checks := {
		"deterministic_api": has_api,
		"warning_before_damage": false,
		"exact_deadline": false,
		"locked_geometry": false,
		"boundary_inclusive": false,
		"cancellation": false,
		"stale_token_rejected": false,
	}
	if has_api:
		var token1: int = int(timeline.call("begin_at", Vector2(10, 20), 30.0, 500, 1000, &"Crushing Swing"))
		var before: bool = bool(timeline.call("is_due", 1499, token1))
		var at_deadline: bool = bool(timeline.call("is_due", 1500, token1))
		var snap: Dictionary = timeline.call("snapshot")
		checks.warning_before_damage = not before
		checks.exact_deadline = at_deadline
		checks.locked_geometry = snap.get("center") == Vector2(10, 20) and absf(float(snap.get("radius", 0.0)) - 30.0) < 0.01
		checks.boundary_inclusive = bool(timeline.call("contains", Vector2(40, 20))) and not bool(timeline.call("contains", Vector2(40.1, 20)))
		timeline.call("cancel", token1)
		checks.cancellation = not bool(timeline.call("is_due", 1600, token1))
		var token2: int = int(timeline.call("begin_at", Vector2.ZERO, 20.0, 300, 2000, &"Crushing Swing"))
		checks.stale_token_rejected = not bool(timeline.call("token_is_current", token1)) and bool(timeline.call("token_is_current", token2))
	print("TINYMMO_BOSS_CONTRACT:" + JSON.stringify({"checks": checks}))
	quit()
'''


_BOSS_RESOLVER_CONTRACT = r'''extends SceneTree

const Resolver = preload("res://boss_attack_timeline.gd")

func _initialize() -> void:
	var snap = Resolver.CastSnapshot.new(7, Vector2(10, 20), 30.0, 1000, 1500)
	var before: Dictionary = Resolver.state_at(snap, 1499)
	var at_deadline: Dictionary = Resolver.state_at(snap, 1500)
	var cancelled = Resolver.cancel(snap)
	var cancelled_state: Dictionary = Resolver.state_at(cancelled, 1600)
	var newer = Resolver.CastSnapshot.new(8, Vector2.ZERO, 20.0, 2000, 2300)
	var checks := {
		"deterministic_api": true,
		"warning_before_damage": bool(before.get("is_warning", false)) and not bool(before.get("is_damage_due", true)),
		"exact_deadline": bool(at_deadline.get("is_damage_due", false)),
		"locked_geometry": snap.center == Vector2(10, 20) and absf(float(snap.radius) - 30.0) < 0.01,
		"boundary_inclusive": Resolver.should_hit(snap, Vector2(40, 20)) and not Resolver.should_hit(snap, Vector2(40.1, 20)),
		"cancellation": not bool(cancelled_state.get("is_damage_due", true)) and not Resolver.should_hit(cancelled, Vector2(10, 20)),
		"stale_token_rejected": snap.token != newer.token and cancelled.cancelled_token == snap.token,
	}
	print("TINYMMO_BOSS_CONTRACT:" + JSON.stringify({"checks": checks}))
	quit()
'''


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate Tiny MMO production boss readability")
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--godot-bin", default=os.environ.get("GODOT_BIN", "/Applications/Godot.app/Contents/MacOS/Godot"))
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
    if not Path(args.godot_bin).is_file() and shutil.which(args.godot_bin) is None:
        result = {
            "schema_version": "tinymmo-boss-evaluation-v1",
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
