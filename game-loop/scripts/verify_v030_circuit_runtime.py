#!/usr/bin/env python3
"""Validate and optionally execute an admitted v0.3 open Agent Circuit."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.config import HarnessEvolutionConfig
from game_loop.core.agent_circuit import AgentCircuit
from game_loop.runtime.circuit import DeepSeekCircuitRuntime
from game_loop.runtime.deepseek_harness import DeepSeekHarnessRuntimeConfig
from game_loop.runtime.protocol import GameTask
from game_loop.studio_server import StudioManager
from game_loop.utils import atomic_write_json, read_json


DEFAULT_INNER_CONFIG = (
    ROOT / "game_loop/product_assets/experiments/agentx/inner_harness_gcbench.json"
)
DEFAULT_RUNTIME_PROFILE = ROOT / "experiments/inner-agent/deepseek-harness-profile.local.json"
DEFAULT_SEED = ROOT / "experiments/seed_artifacts/puzzle-sokoban-scaffold"


def runtime_config(
    *,
    circuit: AgentCircuit,
    inner_config_path: Path,
    runtime_profile_path: Path,
) -> DeepSeekHarnessRuntimeConfig:
    inner = HarnessEvolutionConfig.from_dict(read_json(inner_config_path))
    value = read_json(runtime_profile_path)
    value.update(
        agent_circuit=circuit.to_dict(),
        harness_module_catalog={
            module.module_id: {
                "id": module.module_id,
                "category": module.category,
                "instruction": module.instruction,
                "tags": list(module.tags),
            }
            for module in inner.modules
        },
        harness_element_catalog={
            element.element_id: {
                "element_id": element.element_id,
                "category": element.category,
                "description": element.description,
                "spec": dict(element.spec),
                "tags": list(element.tags),
            }
            for element in inner.element_catalog
        },
        harness_tool_interface_catalog={
            interface.interface_id: {
                "interface_id": interface.interface_id,
                "kind": interface.kind,
                "description": interface.description,
                "command": list(interface.command),
                "cwd": None if interface.cwd is None else str(interface.cwd),
                "safety_scope": interface.safety_scope,
                "tags": list(interface.tags),
            }
            for interface in inner.tool_interfaces
        },
    )
    return DeepSeekHarnessRuntimeConfig.from_dict(value)


def run(args: argparse.Namespace) -> dict[str, object]:
    os.environ.update(StudioManager._runtime_environment())
    proof = read_json(args.proof)
    candidate = proof.get("candidate_circuit")
    if not isinstance(candidate, dict):
        raise ValueError("proof has no candidate_circuit")
    circuit = AgentCircuit.from_dict(candidate)
    config = runtime_config(
        circuit=circuit,
        inner_config_path=args.inner_config,
        runtime_profile_path=args.runtime_profile,
    )
    runtime = DeepSeekCircuitRuntime(config)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    doctor = runtime.doctor()
    payload: dict[str, object] = {
        "circuit_id": circuit.circuit_id,
        "roles": [role.role_id for role in circuit.roles],
        "doctor": doctor,
    }
    atomic_write_json(args.output_dir / "doctor.json", payload)
    if args.execute and doctor.get("ok") is True:
        task = GameTask(
            task_id="v030-open-circuit-proof",
            benchmark_id="studio-proof",
            prompt=args.task,
            task_source_ref="proof://v0.3.0/open-circuit",
            workspace_seed_ref=str(args.seed.resolve()),
            artifact_relpath=".",
        )
        submission = runtime.run(task, episode_dir=args.output_dir / "episode")
        payload["submission"] = submission.to_dict()
        atomic_write_json(args.output_dir / "runtime-proof.json", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proof", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--inner-config", type=Path, default=DEFAULT_INNER_CONFIG)
    parser.add_argument("--runtime-profile", type=Path, default=DEFAULT_RUNTIME_PROFILE)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument(
        "--task",
        default=(
            "Inspect the supplied Godot game, make one small evidence-backed usability "
            "improvement, verify it launches, and publish the complete workspace."
        ),
    )
    args = parser.parse_args()
    payload = run(args)
    doctor_ok = dict(payload["doctor"]).get("ok") is True
    submission = payload.get("submission")
    execute_ok = not args.execute or (
        isinstance(submission, dict) and submission.get("status") == "completed"
    )
    return 0 if doctor_ok and execute_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
