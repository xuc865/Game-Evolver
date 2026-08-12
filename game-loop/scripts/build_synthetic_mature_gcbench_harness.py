#!/usr/bin/env python3
"""Build the fixed synthetic mature inner harness used by GCbench experiments."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.config import AppConfig
from game_loop.core.harness import HarnessEvolutionEngine
from game_loop.harness_element_catalog import INNER_ELEMENT_CATALOG
from game_loop.utils import atomic_write_json


MATURE_MODULES = [
    {
        "id": "mature_feature_contract",
        "instruction": (
            "Turn the public task into a short observable feature checklist before editing. "
            "Prioritize the player-controlled core loop, progression, and a reachable win or "
            "loss state; a named feature is incomplete until it is executable in the game."
        ),
        "tags": ["ImproveObjective", "gameplay", "completion"],
    },
    {
        "id": "mature_playable_first",
        "instruction": (
            "Establish a runnable end-to-end vertical slice early, then deepen it in coherent "
            "increments. Do not spend the main budget on architecture, inventories, or cosmetic "
            "polish while the core interaction and state transitions remain unplayable."
        ),
        "tags": ["ImproveObjective", "playability", "budget"],
    },
    {
        "id": "mature_runtime_iteration",
        "instruction": (
            "After each meaningful gameplay increment, launch Godot and exercise it with real "
            "input. Use screenshots, runtime logs, and observed state changes to choose the next "
            "edit; source inspection alone is not evidence that the game works."
        ),
        "tags": ["engine_tooling", "godot", "runtime"],
    },
    {
        "id": "mature_player_experience",
        "instruction": (
            "Reserve time for readable controls, immediate feedback, balanced challenge, visual "
            "hierarchy, progression, and an understandable end state. Prefer a smaller complete "
            "game with mechanical depth over many shallow or decorative features."
        ),
        "tags": ["ImproveObjective", "game_quality", "feedback"],
    },
    {
        "id": "mature_demo_and_regression",
        "instruction": (
            "Finish by replaying deterministic demos that cover normal play, a meaningful "
            "mid-game transition, and a terminal outcome when the task supports them. Fix runtime "
            "errors and broken input paths before final polish, and leave only demos actually run."
        ),
        "tags": ["RepairConstraint", "demo", "regression"],
    },
]

MATURE_ELEMENTS = {
    "skill": [
        "skill_runtime_smoke",
        "skill_visual_snapshot",
        "skill_demo_replay_audit",
        "skill_godot_headless_playtest",
    ],
    "mcp": ["mcp_godot_screenshot", "mcp_godot_scene_tree"],
    "tool": [
        "tool_entrypoint_discover",
        "tool_godot_import_check",
        "tool_artifact_inventory",
    ],
    "context": ["ctx_task_spec_anchor", "ctx_probe_digest", "ctx_recent_failures"],
    "protocol": ["proto_workspace_boundary", "proto_probe_before_accept"],
    "workflow": ["wf_plan_patch_verify", "wf_checkpoint_rollback", "wf_diagnose_then_patch"],
}


def build_effective_config(source: Path, destination: Path) -> AppConfig:
    value = json.loads(source.read_text(encoding="utf-8"))
    harness = value["method"]["harness_evolution"]
    selected_ids = {element_id for ids in MATURE_ELEMENTS.values() for element_id in ids}
    catalog = {item["id"]: item for item in harness.get("element_catalog", [])}
    catalog.update(
        {
            item["id"]: item
            for item in INNER_ELEMENT_CATALOG
            if item["id"] in selected_ids and item["id"] not in catalog
        }
    )
    missing = sorted(selected_ids - set(catalog))
    if missing:
        raise ValueError(f"mature harness elements missing from catalog: {missing}")
    harness["element_catalog"] = list(catalog.values())
    harness["modules"] = MATURE_MODULES
    harness["seed_modules"] = [item["id"] for item in MATURE_MODULES]
    harness["max_active_modules"] = len(MATURE_MODULES)
    harness["seed_elements"] = MATURE_ELEMENTS
    harness["max_active_elements"] = {
        "skill": 4,
        "mcp": 2,
        "tool": 3,
        "context": 3,
        "protocol": 2,
        "workflow": 3,
    }
    harness["enable_usage_driven_mutation"] = False
    harness["enable_tool_interface_mutation"] = False
    harness["enable_executable_policy_mutation"] = False
    value["evolution"]["max_generations"] = 1
    value["evolution"]["candidates_per_generation"] = 1
    value["experiment"]["arm"] = "L4_agent"
    atomic_write_json(destination, value)
    return AppConfig.load(destination)


def build_profile(*, config: AppConfig, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    engine = HarnessEvolutionEngine(output_dir, config.method.harness_evolution)
    profile = engine.initialize()
    profile_path = output_dir / "synthetic_mature_gcbench_v1.json"
    atomic_write_json(profile_path, profile.to_dict())
    return profile_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    config = build_effective_config(args.config, args.output_dir / "config.json")
    profile_path = build_profile(config=config, output_dir=args.output_dir)
    print(profile_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
