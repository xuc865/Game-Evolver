from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from game_loop.core.agent_circuit import (
    AgentCircuit,
    AgentRole,
    CircuitEdge,
    CircuitPolicy,
    RoleHarnessSpec,
)
from game_loop.runtime.circuit import DeepSeekCircuitRuntime
from game_loop.runtime.deepseek_harness import (
    DeepSeekHarnessRunnerResult,
    DeepSeekHarnessRuntimeConfig,
)
from game_loop.runtime.factory import build_runtime, load_runtime_config
from game_loop.runtime.protocol import GameTask


def role(role_id: str, kind: str) -> AgentRole:
    return AgentRole(
        role_id=role_id,
        name=role_id.title(),
        kind=kind,
        objective=f"Own {role_id} work.",
        system_prompt=f"Execute {role_id} work.",
    )


class StudioRunner:
    def run(self, prompt, *, cwd, **_kwargs):
        if "(integrator," in prompt:
            game = cwd / "game"
            game.mkdir(exist_ok=True)
            (game / "project.godot").write_text("[application]\n", encoding="utf-8")
            response = "Integrated a runnable game."
        elif "(critic," in prompt:
            response = "Deep playtest passed.\nCIRCUIT_STATUS: PASS"
        else:
            response = "Prepared implementation brief."
        return DeepSeekHarnessRunnerResult("completed", response)


class DoctorRunner(StudioRunner):
    def __init__(self):
        self.doctor_configs = []

    def doctor(self, config, _environment):
        self.doctor_configs.append(config)
        return {"sdk_importable": True, "sdk_startup": True}


class CircuitMakerRuntimeTests(unittest.TestCase):
    def test_doctor_runs_sdk_startup_for_every_resolved_role_harness(self):
        circuit = AgentCircuit(
            roles=(
                AgentRole(
                    "builder", "Builder", "specialist", "Build.", "Build.",
                    harness_spec=RoleHarnessSpec(active_module_ids=("build",)),
                ),
                AgentRole(
                    "reviewer", "Reviewer", "critic", "Review.", "Review.",
                    workspace_access="read_only",
                    harness_spec=RoleHarnessSpec(active_module_ids=("review",)),
                ),
            ),
            edges=(CircuitEdge(
                "review", "builder", "reviewer", "review", "Review.", ("patch",)
            ),),
            entry_role_ids=("builder",),
            terminal_role_ids=("builder", "reviewer"),
            policy=CircuitPolicy(max_total_model_calls=2, max_total_cost_units=2),
        )
        runner = DoctorRunner()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cordis = root / "cordis.yml"
            cordis.write_text("- id: seed\n  name: '@deepseek-ai/dsh-seed'\n")
            runtime = DeepSeekCircuitRuntime(
                DeepSeekHarnessRuntimeConfig(
                    backbone_provider=None,
                    agent_circuit=circuit,
                    cordis=str(cordis),
                    runtime_cwd=str(root),
                    harness_module_catalog={
                        "build": {"id": "build", "instruction": "Build and verify."},
                        "review": {"id": "review", "instruction": "Review independently."},
                    },
                ),
                runner=runner,
            )

            report = runtime.doctor()

        role_reports = report["agent_circuit"]["role_harnesses"]
        self.assertTrue(report["ok"])
        self.assertTrue(report["checks"]["role_builder_sdk_startup"])
        self.assertTrue(report["checks"]["role_reviewer_sdk_startup"])
        self.assertNotEqual(
            role_reports["builder"]["effective_harness_hash"],
            role_reports["reviewer"]["effective_harness_hash"],
        )
        self.assertEqual(len(runner.doctor_configs), 3)

    def test_factory_runs_explicit_circuit_and_publishes_integrated_game(self):
        circuit = AgentCircuit(
            roles=(
                AgentRole(
                    "director",
                    "Director",
                    "director",
                    "Own director work.",
                    "Execute director work.",
                    workspace_access="read_only",
                ),
                role("integrator", "integrator"),
                AgentRole(
                    "critic",
                    "Critic",
                    "critic",
                    "Own critic work.",
                    "Execute critic work.",
                    workspace_access="read_only",
                ),
            ),
            edges=(
                CircuitEdge("brief", "director", "integrator", "delegation", "Implement the brief."),
                CircuitEdge("review", "integrator", "critic", "artifact", "Playtest the game.", ("build",)),
            ),
            entry_role_ids=("director",),
            terminal_role_ids=("integrator", "critic"),
            policy=CircuitPolicy(max_total_model_calls=3, max_total_cost_units=3),
        )
        config = DeepSeekHarnessRuntimeConfig(
            backbone_provider=None,
            agent_circuit=circuit,
        )
        restored = load_runtime_config(config.to_dict())
        runtime = build_runtime(restored, runner=StudioRunner())
        self.assertIsInstance(runtime, DeepSeekCircuitRuntime)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            task = GameTask(
                task_id="studio",
                benchmark_id="gcbench",
                prompt="Build a platformer.",
                task_source_ref="task",
                workspace_seed_ref=str(seed),
                artifact_relpath="game",
            )

            submission = runtime.run(task, episode_dir=root / "episode")

            self.assertEqual(submission.status, "completed")
            self.assertEqual(submission.usage["modelCalls"], 3)
            self.assertEqual(submission.metadata["agent_circuit_id"], circuit.circuit_id)
            artifact = Path(submission.artifact_ref or "")
            self.assertTrue((artifact / "project.godot").is_file())
            self.assertTrue((root / "episode" / "circuit_run.json").is_file())


if __name__ == "__main__":
    unittest.main()
