#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


REQUIRED_ARCHITECTURE = (
    "project.godot",
    "source/common/main.gd",
    "source/common/network/wire_codec.gd",
    "source/client/network/instance_client.gd",
    "source/server/gateway",
    "source/server/master",
    "source/server/world",
)


def evaluate(project: Path, *, godot_bin: str, timeout_seconds: int = 180) -> dict[str, Any]:
    project = project.resolve()
    diagnostics: list[str] = []
    missing = [item for item in REQUIRED_ARCHITECTURE if not (project / item).exists()]
    architecture_integrity = 1.0 - len(missing) / len(REQUIRED_ARCHITECTURE)
    diagnostics.extend(f"missing architecture path: {item}" for item in missing)

    runtime = _run_godot_import(project, godot_bin, timeout_seconds)
    runtime_health = 1.0 if runtime["complete"] and not runtime["compile_errors"] else 0.0
    diagnostics.extend(runtime["diagnostics"])

    smoothing = _score_network_smoothing(project, godot_bin, timeout_seconds)
    diagnostics.extend(smoothing["diagnostics"])
    gameplay_quality = _score_gameplay_surface(project)
    maintainability = _score_maintainability(project, smoothing)

    objectives = {
        "architecture_integrity": round(architecture_integrity, 6),
        "runtime_health": round(runtime_health, 6),
        "network_smoothing": round(float(smoothing["score"]), 6),
        "gameplay_quality": round(gameplay_quality, 6),
        "maintainability": round(maintainability, 6),
    }
    primary = (
        0.20 * architecture_integrity
        + 0.20 * runtime_health
        + 0.40 * float(smoothing["score"])
        + 0.10 * gameplay_quality
        + 0.10 * maintainability
    )
    constraints = {
        "architecture_intact": not missing,
        "godot_validation_complete": bool(runtime["complete"]),
        "gdscript_compiles": not runtime["compile_errors"],
        "deterministic_smoothing_test_complete": bool(smoothing["test_complete"]),
    }
    return {
        "schema_version": "tinymmo-evaluation-v1",
        "status": "completed",
        "primary_score": round(primary, 6),
        "objectives": objectives,
        "constraints": constraints,
        "diagnostics": diagnostics[:20],
        "details": {
            "godot": runtime,
            "smoothing": smoothing,
            "gdscript_files": len(list(project.rglob("*.gd"))),
            "scene_files": len(list(project.rglob("*.tscn"))),
        },
    }


def _run_godot_import(project: Path, godot_bin: str, timeout_seconds: int) -> dict[str, Any]:
    command = [godot_bin, "--headless", "--editor", "--path", str(project), "--quit"]
    # A freshly copied Godot project can report resources as missing while its
    # first editor pass is still generating .godot imports. Warm the cache, then
    # judge an independent second pass so transient import ordering is not
    # misclassified as a candidate compile regression.
    for phase in ("import warm-up", "validation"):
        try:
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=timeout_seconds,
                check=False,
                env={**os.environ, "GODOT_SILENCE_ROOT_WARNING": "1"},
            )
        except subprocess.TimeoutExpired:
            return {
                "complete": False,
                "return_code": None,
                "compile_errors": True,
                "diagnostics": [
                    f"Godot {phase} timed out after {timeout_seconds}s"
                ],
            }
    output = completed.stdout
    compiler_lines = [
        line.strip()
        for line in output.splitlines()
        if "SCRIPT ERROR:" in line or "Parse Error:" in line or "Compile Error:" in line
    ]
    return {
        "complete": True,
        "return_code": completed.returncode,
        "compile_errors": bool(compiler_lines),
        "compiler_error_count": len(compiler_lines),
        "diagnostics": compiler_lines[:8],
    }


def _score_network_smoothing(project: Path, godot_bin: str, timeout_seconds: int) -> dict[str, Any]:
    smoother_path = project / "source/common/network/sync/net_motion_smoother.gd"
    if not smoother_path.is_file():
        return {
            "score": 0.0,
            "test_complete": True,
            "contract": {},
            "diagnostics": ["NetMotionSmoother implementation is missing"],
        }
    source = smoother_path.read_text(encoding="utf-8")
    state_sync = (project / "source/common/network/sync/state_synchronizer.gd").read_text(
        encoding="utf-8", errors="replace"
    )
    props_sync = (project / "source/common/network/sync/replicated_props.gd").read_text(
        encoding="utf-8", errors="replace"
    )
    contract = {
        "buffered_samples": "_positions" in source and "MAX_SAMPLES" in source,
        "interpolation": ".lerp(" in source,
        "teleport_snap": "snap_distance" in source and "reset_to" in source,
        "players_routed": "net_apply_position" in state_sync,
        "npcs_routed": "net_apply_position" in props_sync,
        "deterministic_ingest_api": "push_sample_at" in source,
        "deterministic_sampling_api": "sample_at" in source,
        "adaptive_delay": bool(re.search(r"jitter|effective_delay|adaptive", source, re.I)),
        "bounded_extrapolation": bool(re.search(r"extrapolat", source, re.I)),
        "telemetry": "get_metrics" in source or "network_metrics" in source,
    }
    weights = {
        "buffered_samples": 0.10,
        "interpolation": 0.10,
        "teleport_snap": 0.10,
        "players_routed": 0.10,
        "npcs_routed": 0.10,
        "deterministic_ingest_api": 0.10,
        "deterministic_sampling_api": 0.10,
        "adaptive_delay": 0.10,
        "bounded_extrapolation": 0.10,
        "telemetry": 0.10,
    }
    static_score = sum(weights[name] for name, passed in contract.items() if passed)
    behavior = _run_smoothing_contract(smoother_path, godot_bin, timeout_seconds)
    score = min(1.0, 0.75 * static_score + 0.25 * behavior["score"])
    return {
        "score": score,
        "static_score": static_score,
        "behavior_score": behavior["score"],
        "test_complete": behavior["complete"],
        "contract": contract,
        "behavior": behavior,
        "diagnostics": behavior["diagnostics"],
    }


def _run_smoothing_contract(source: Path, godot_bin: str, timeout_seconds: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="tinymmo-smoothing-") as temp_dir:
        root = Path(temp_dir)
        shutil.copy2(source, root / "net_motion_smoother.gd")
        (root / "project.godot").write_text(
            '[application]\nconfig/name="TinyMMO smoothing contract"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
            encoding="utf-8",
        )
        (root / "contract_test.gd").write_text(_GODOT_CONTRACT_TEST, encoding="utf-8")
        try:
            completed = subprocess.run(
                [godot_bin, "--headless", "--path", str(root), "--script", "contract_test.gd"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=min(timeout_seconds, 60),
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {"complete": False, "score": 0.0, "diagnostics": ["smoothing contract timed out"]}
        match = re.search(r"TINYMMO_CONTRACT:(\{.*\})", completed.stdout)
        if not match:
            compiler = [
                line.strip()
                for line in completed.stdout.splitlines()
                if "ERROR" in line or "Parse Error" in line
            ]
            return {
                "complete": False,
                "score": 0.0,
                "diagnostics": compiler[:5] or ["smoothing contract emitted no result"],
            }
        result = json.loads(match.group(1))
        checks = result.get("checks", {})
        return {
            "complete": True,
            "score": sum(1 for value in checks.values() if value) / max(1, len(checks)),
            "checks": checks,
            "metrics": result.get("metrics", {}),
            "diagnostics": [
                f"smoothing contract failed: {name}" for name, passed in checks.items() if not passed
            ],
        }


def _score_gameplay_surface(project: Path) -> float:
    checks = (
        len(list(project.rglob("*.gd"))) >= 400,
        len(list(project.rglob("*.tscn"))) >= 180,
        (project / "source/common/gameplay/combat").is_dir(),
        (project / "source/common/gameplay/quests").is_dir(),
        any(project.rglob("*guild*.gd")),
        any(project.rglob("*dungeon*.gd")),
    )
    return sum(checks) / len(checks)


def _score_maintainability(project: Path, smoothing: dict[str, Any]) -> float:
    smoother = project / "source/common/network/sync/net_motion_smoother.gd"
    source = smoother.read_text(encoding="utf-8", errors="replace") if smoother.is_file() else ""
    checks = (
        len(source.splitlines()) <= 360,
        "##" in source,
        any((project / name).exists() for name in ("tests", "test", "qa")),
        any(project.rglob("*net*test*.gd")),
        bool(smoothing.get("contract", {}).get("telemetry")),
    )
    return sum(checks) / len(checks)


_GODOT_CONTRACT_TEST = r'''extends SceneTree

func _initialize() -> void:
	var script := load("res://net_motion_smoother.gd")
	var target := Node2D.new()
	root.add_child(target)
	var smoother: Node = script.new()
	target.add_child(smoother)
	var methods: Array[StringName] = []
	for item: Dictionary in smoother.get_method_list():
		methods.append(item.name)
	var has_ingest := &"push_sample_at" in methods
	var has_sample := &"sample_at" in methods
	var has_metrics := &"get_metrics" in methods
	var checks := {
		"deterministic_api": has_ingest and has_sample,
		"midpoint_interpolation": false,
		"bounded_extrapolation": false,
		"telemetry": false,
	}
	var metrics := {}
	if has_ingest and has_sample:
		smoother.call("push_sample_at", Vector2(0, 0), 1000)
		smoother.call("push_sample_at", Vector2(10, 0), 1050)
		var midpoint: Variant = smoother.call("sample_at", 1025)
		checks.midpoint_interpolation = midpoint is Vector2 and absf(midpoint.x - 5.0) <= 0.75
		var future: Variant = smoother.call("sample_at", 1125)
		checks.bounded_extrapolation = future is Vector2 and future.x >= 10.0 and future.x <= 35.0
	if has_metrics:
		var raw: Variant = smoother.call("get_metrics")
		if raw is Dictionary:
			metrics = raw
			checks.telemetry = raw.has("sample_count") and raw.has("jitter_ms") and raw.has("effective_delay_ms")
	print("TINYMMO_CONTRACT:" + JSON.stringify({"checks": checks, "metrics": metrics}))
	quit()
'''


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate a Tiny MMO project candidate")
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--godot-bin", default=os.environ.get("GODOT_BIN", "/Applications/Godot.app/Contents/MacOS/Godot"))
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    args.output.resolve().parent.mkdir(parents=True, exist_ok=True)
    if not Path(args.godot_bin).is_file() and shutil.which(args.godot_bin) is None:
        result = {
            "schema_version": "tinymmo-evaluation-v1",
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
