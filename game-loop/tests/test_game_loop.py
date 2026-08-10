from __future__ import annotations

import json
import copy
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

from game_loop.artifacts import ArtifactStore
from game_loop.benchmarks.base import BenchmarkAdapter
from game_loop.benchmarks.gcbench import GameCraftBenchAdapter
from game_loop.benchmarks.gdbench import GameDevBenchAdapter
from game_loop.benchmarks.gcbench_bridge import (
    doctor as gcbench_bridge_doctor,
    run_bridge as run_gcbench_bridge,
)
from game_loop.benchmarks.gdbench_bridge import (
    doctor as gdbench_bridge_doctor,
    run_bridge as run_gdbench_bridge,
)
from game_loop.config import AppConfig, GateConfig
from game_loop.core.controller import LoopController
from game_loop.core.harness import (
    HarnessEpisodeOutcome,
    HarnessEvolutionEngine,
    HarnessOuterLoop,
    HarnessReplayCase,
    HarnessSemanticGradient,
)
from game_loop.core.models import (
    ArtifactDescriptor,
    BackendExecution,
    CandidateResult,
    EvaluationResult,
    GateResult,
    PreparedTask,
    ProbeResult,
    ProbeSuiteResult,
)
from game_loop.core.replay import CommandHarnessReplayRunner
from game_loop.core.attribution import (
    RuleBasedSemanticGradientProposer,
    TrajectoryAttributor,
)
from game_loop.probes import FixedCommandProbeRunner
from game_loop.runtime import (
    GameTask,
    InnerLoopPipeline,
    OpenGameRuntime,
    OpenGameRuntimeConfig,
    RunnerResult,
)


def write_config(
    root: Path,
    *,
    candidates: int,
    delta: float = 0.01,
    generations: int = 1,
    max_model_calls: int | None = None,
    max_evaluator_queries: int | None = None,
    level: str = "L0",
    probe_mode: str = "regression_anchor",
    max_probe_calls: int = 0,
    probe_ids: tuple[str, ...] = ("public_runtime_smoke",),
    max_selected_probes: int = 1,
    family_archive_capacity: int = 8,
    experiment_arm: str = "standard",
) -> AppConfig:
    path = root / "config.json"
    path.write_text(json.dumps({
        "benchmark": {"adapter": "gcbench", "options": {}},
        "backend": {"cwd": str(root), "command": ["fake"]},
        "method": {
            "level": level,
            "observation_contract": (
                "fixed_probes_plus_benchmark_evaluator_and_validity_gates"
                if level == "L1"
                else "active_frozen_probe_catalog_plus_benchmark_evaluator_and_validity_gates"
                if level == "L2"
                else "coevolving_probe_archive_plus_benchmark_evaluator_and_validity_gates"
                if level == "L3"
                else "two_timescale_agent_harness_evolution_plus_benchmark_evaluator_and_validity_gates"
                if level == "L4"
                else "benchmark_evaluator_and_validity_gates"
            ),
            "fixed_probes": ([{
                "id": probe_id,
                "cwd": str(root),
                "command": ["fake-probe", "{artifact_dir}"],
                "timeout_seconds": 10,
                "selection_mode": probe_mode,
                "parser": "exit_code",
                "tags": [probe_id],
            } for probe_id in probe_ids] if level in {"L1", "L2"} else []),
            "max_probe_calls": max_probe_calls,
            "active_selection": ({
                "max_selected_probes": max_selected_probes,
                "min_observations_per_probe": 1,
                "coverage_weight": 1.0,
                "regression_weight": 1.0,
                "uncertainty_weight": 0.75,
                "intent_affinity_weight": 0.5,
                "recency_weight": 0.25,
            } if level in {"L2", "L3", "L4"} else None),
            "probe_families": ([{
                "id": "runtime_horizon",
                "archive_capacity": family_archive_capacity,
                "gene": {
                    "name": "frames",
                    "initial": 10,
                    "minimum": 10,
                    "maximum": 100,
                    "step": 10,
                    "difficulty_direction": "increasing",
                },
                "probe": {
                    "cwd": str(root),
                    "command": ["fake-probe", "[[frames]]", "{artifact_dir}"],
                    "timeout_seconds": 10,
                    "selection_mode": "regression_anchor",
                    "parser": "exit_code",
                    "tags": ["ImproveObjective", "CoverUnverifiedRequirement"],
                },
            }] if level in {"L3", "L4"} else []),
            "harness_evolution": ({
                "seed_modules": [],
                "seed_tool_interfaces": [],
                "max_active_modules": 2,
                "max_active_tool_interfaces": 2,
                "mutation_width": 1,
                "replay_min_cases": 2,
                "promotion_delta_min": 0.01,
                "max_case_regression": 0.08,
                "tool_interfaces": [
                    {
                        "id": "fake_godot_mcp",
                        "kind": "mcp_server",
                        "description": "Inspect the candidate Godot project through a fake MCP server.",
                        "command": ["fake-mcp", "{candidate_workspace}"],
                        "safety_scope": "candidate_workspace_only",
                        "tags": ["engine_tooling", "godot_mcp", "functional_visuals"],
                    }
                ],
                "modules": [
                    {
                        "id": "evidence_first",
                        "instruction": "Inspect executable evidence before choosing a patch.",
                        "tags": ["ImproveObjective", "functional_visuals"],
                    },
                    {
                        "id": "diversity_escape",
                        "instruction": "Avoid repeating a recently rejected change family.",
                        "tags": ["ExploreAlternative", "exploration"],
                    },
                    {
                        "id": "regression_first",
                        "instruction": "Re-run preserved behavior before finishing.",
                        "tags": ["RepairConstraint", "feasibility"],
                    },
                ],
            } if level == "L4" else None),
        },
        "evolution": {
            "max_generations": generations,
            "candidates_per_generation": candidates,
            "delta_min": delta,
            "objective_regression_epsilon": 0.1,
            "stop_after_rejections": 5,
            "feedback_disclosure": "DIAGNOSTICS",
            "stop_on_terminal_success": True,
            "max_model_calls": max_model_calls,
            "max_evaluator_queries": max_evaluator_queries,
        },
        "experiment": {"arm": experiment_arm},
    }))
    return AppConfig.load(path)


class FakeAdapter(BenchmarkAdapter):
    adapter_id = "fake"
    artifact_descriptor = ArtifactDescriptor(kind="fake")

    def __init__(self, scores: list[float], *, terminal_at_one: bool = False):
        super().__init__({})
        self.scores = list(scores)
        self.terminal_at_one = terminal_at_one
        self.feedback = []
        self.capabilities = {
            "score_topology": "binary" if terminal_at_one else "continuous_multi_objective",
            "natural_terminal_condition": terminal_at_one,
            "max_evaluator_queries_per_candidate": 1,
        }

    def doctor(self):
        return {"adapter": "fake"}

    def parse_evaluation(self, path):
        raise NotImplementedError

    def prepare(self, *, task_source, parent_artifact, feedback, candidate_dir, context):
        self.feedback.append(feedback)
        artifact = candidate_dir / "working_artifact"
        self.stage_artifact(parent_artifact, artifact)
        return PreparedTask("fake", artifact, {}, {"artifact": str(artifact)})

    def collect(self, prepared, execution):
        score = self.scores.pop(0)
        artifact = Path(prepared.metadata["artifact"])
        (artifact / "score.txt").write_text(str(score))
        terminal = self.terminal_at_one and score >= 1.0
        return CandidateResult(
            artifact,
            EvaluationResult(
                score,
                True,
                objectives={"quality": score},
                diagnostics=[] if terminal else ["not done"],
                terminal_success=terminal,
            ),
            evaluator_queries=1,
        )

    def validate(self, artifact, common_config):
        return GateResult(True, stats={"files": 1})

class FakeBackend:
    def run(self, prepared, candidate_dir):
        log = candidate_dir / "fake.log"
        log.write_text("ok\n")
        return BackendExecution(0, log)


class FakeInfrastructureAdapter(FakeAdapter):
    def __init__(self):
        super().__init__([])

    def collect(self, prepared, execution):
        artifact = Path(prepared.metadata["artifact"])
        return CandidateResult(
            artifact,
            None,
            "multimodal evaluator timed out",
            evaluator_queries=1,
        )


class FakeProbeRunner:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def run_suite(self, probes, *, context, output_dir, phase):
        self.calls.append({
            "phase": phase,
            "probe_ids": [probe.probe_id for probe in probes],
            "commands": [probe.command for probe in probes],
            "artifact_dir": context["artifact_dir"],
        })
        passed, score, status = self.outcomes.pop(0)
        output_dir.mkdir(parents=True, exist_ok=True)
        result = ProbeResult(
            probe_id=probes[0].probe_id,
            status=status,
            passed=passed,
            score=score,
            return_code=0 if passed else 1,
            duration_seconds=0.01,
            log_path=str(output_dir / "fake.log"),
        )
        return ProbeSuiteResult(phase, [result], 1)


class GameLoopTests(unittest.TestCase):
    def test_infrastructure_failure_pauses_and_does_not_spend_scientific_query_budget(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                max_model_calls=1,
                max_evaluator_queries=1,
            )
            controller = LoopController.initialize(
                run_dir=root / "infra",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True),
                config=config,
                adapter=FakeInfrastructureAdapter(),
            )
            controller.backend = FakeBackend()
            state = controller.evolve()
            self.assertEqual(state.status, "paused_infrastructure")
            self.assertEqual(state.model_calls, 1)
            self.assertEqual(state.evaluator_attempts, 1)
            self.assertEqual(state.evaluator_queries, 0)
            self.assertEqual(state.infrastructure_failures, 1)
            self.assertEqual(state.attempts[0]["status"], "infra_failed")
            self.assertEqual((state.next_generation, state.next_candidate), (1, 1))
            resumed = controller.evolve()
            self.assertEqual(resumed.status, "paused_infrastructure")
            self.assertEqual(resumed.model_calls, 1)
            self.assertEqual(len(resumed.attempts), 1)

    def test_continuous_and_binary_evaluators_share_controller(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(root, candidates=2)
            adapter = FakeAdapter([0.6, 0.55])
            controller = LoopController.initialize(
                run_dir=root / "continuous",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
            )
            controller.backend = FakeBackend()
            state = controller.evolve()
            self.assertEqual(state.champion_result.primary_score, 0.6)
            self.assertTrue(state.attempts[0]["accepted"])
            self.assertFalse(state.attempts[1]["accepted"])
            self.assertEqual(state.attempts[0]["mutation_intent"]["kind"], "ImproveObjective")
            self.assertEqual(state.attempts[1]["mutation_intent"]["kind"], "ExploreAlternative")
            self.assertEqual(state.attempts[0]["parent_artifact_id"], state.attempts[1]["parent_artifact_id"])

            binary_config = write_config(root, candidates=1, delta=0.5)
            binary = FakeAdapter([1.0], terminal_at_one=True)
            binary_controller = LoopController.initialize(
                run_dir=root / "binary",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.0, True, {"task_correctness": 0.0}),
                config=binary_config,
                adapter=binary,
            )
            binary_controller.backend = FakeBackend()
            binary_state = binary_controller.evolve()
            self.assertEqual(binary_state.stop_reason, "benchmark terminal success reached")
            self.assertTrue(binary_state.champion_result.terminal_success)

    def test_l0_budget_stops_before_an_extra_model_call(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=1,
                max_evaluator_queries=3,
            )
            adapter = FakeAdapter([0.6])
            controller = LoopController.initialize(
                run_dir=root / "budgeted",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
            )
            controller.backend = FakeBackend()
            state = controller.evolve()
            self.assertEqual(state.model_calls, 1)
            self.assertEqual(state.evaluator_queries, 1)
            self.assertEqual(state.stop_reason, "L0 model call budget exhausted")
            self.assertEqual(len(state.attempts), 1)

    def test_l0_evaluator_budget_prevents_the_next_candidate(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=3,
                max_evaluator_queries=1,
            )
            adapter = FakeAdapter([0.6])
            controller = LoopController.initialize(
                run_dir=root / "evaluator-budgeted",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
            )
            controller.backend = FakeBackend()
            state = controller.evolve()
            self.assertEqual(state.model_calls, 1)
            self.assertEqual(state.evaluator_queries, 1)
            self.assertEqual(state.stop_reason, "L0 evaluator query budget exhausted")

    def test_l0_mutation_intents_depend_on_topology_not_adapter_name(self):
        from game_loop.core.mutation import L0MutationPolicy

        policy = L0MutationPolicy()
        continuous = policy.select(
            parent=EvaluationResult(0.5, True, {"quality_a": 0.7, "quality_b": 0.2}),
            history=[],
            generation=1,
            candidate_index=1,
            capabilities={"score_topology": "continuous_multi_objective"},
        )
        binary = policy.select(
            parent=EvaluationResult(0.0, True, {"task_correctness": 0.0}),
            history=[],
            generation=1,
            candidate_index=1,
            capabilities={"score_topology": "binary"},
        )
        exploration = policy.select(
            parent=EvaluationResult(0.5, True, {"quality": 0.5}),
            history=[],
            generation=1,
            candidate_index=2,
            capabilities={"score_topology": "continuous_multi_objective"},
        )
        self.assertEqual((continuous.kind, continuous.target), ("ImproveObjective", "quality_b"))
        self.assertEqual(binary.kind, "CoverUnverifiedRequirement")
        self.assertEqual(exploration.kind, "ExploreAlternative")

    def test_retry3_uses_the_same_seed_without_cross_attempt_feedback(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=3,
                max_model_calls=3,
                max_evaluator_queries=3,
                experiment_arm="retry3",
            )
            adapter = FakeAdapter([0.6, 0.8, 0.7])
            controller = LoopController.initialize(
                run_dir=root / "retry3",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
            )
            controller.backend = FakeBackend()
            state = controller.evolve()
            self.assertEqual(state.champion_result.primary_score, 0.8)
            self.assertEqual(
                {attempt["parent_artifact_id"] for attempt in state.attempts},
                {state.seed_artifact_id},
            )
            self.assertEqual([item["accepted"] for item in state.attempts], [True, True, False])
            for feedback in adapter.feedback:
                self.assertEqual(feedback["feedback_disclosure"], "NONE")
                self.assertEqual(feedback["facts"], {})
                self.assertEqual(feedback["recent_attempts"], [])
                self.assertNotIn("benchmark_evaluator", feedback["observation_sources"])
            manifest = json.loads((root / "retry3" / "manifest.json").read_text())
            self.assertEqual(manifest["experiment"]["arm"], "retry3")
            self.assertTrue(manifest["experiment"]["seed_parent_for_every_attempt"])

    def test_l4_agent_arm_evaluates_harness_without_artifact_lineage(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=3,
                max_evaluator_queries=3,
                level="L4",
                max_probe_calls=6,
                experiment_arm="L4_agent",
            )
            adapter = FakeAdapter([0.6, 0.7, 0.65])
            controller = LoopController.initialize(
                run_dir=root / "l4-agent",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            self.assertEqual(
                {attempt["parent_artifact_id"] for attempt in state.attempts},
                {state.seed_artifact_id},
            )
            self.assertEqual(state.champion_result.primary_score, 0.7)
            self.assertEqual(
                [len(item["recent_attempts"]) for item in adapter.feedback],
                [0, 1, 2],
            )
            manifest = json.loads((root / "l4-agent" / "manifest.json").read_text())
            self.assertTrue(manifest["artifact_parent_frozen_to_seed"])
            self.assertFalse(manifest["experiment"]["artifact_lineage_is_tested"])

    def test_gcbench_single_shot_is_the_shared_seed_without_an_extra_call(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=0,
                max_model_calls=0,
                max_evaluator_queries=0,
                experiment_arm="single_shot",
            )
            controller = LoopController.initialize(
                run_dir=root / "single-shot-seed",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([]),
            )
            controller.backend = FakeBackend()
            state = controller.evolve()
            self.assertEqual(state.model_calls, 0)
            self.assertEqual(state.evaluator_queries, 0)
            self.assertEqual(state.attempts, [])
            self.assertEqual(state.champion_artifact_id, state.seed_artifact_id)

    def test_parent_only_inherits_champion_but_discloses_no_evaluator_feedback(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=3,
                max_evaluator_queries=3,
                experiment_arm="parent_only",
            )
            adapter = FakeAdapter([0.6, 0.7, 0.8])
            controller = LoopController.initialize(
                run_dir=root / "parent-only",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
            )
            controller.backend = FakeBackend()
            state = controller.evolve()
            attempts = state.attempts
            self.assertEqual(attempts[0]["parent_artifact_id"], state.seed_artifact_id)
            self.assertEqual(attempts[1]["parent_artifact_id"], attempts[0]["artifact_id"])
            self.assertEqual(attempts[2]["parent_artifact_id"], attempts[1]["artifact_id"])
            self.assertTrue(all(item["accepted"] for item in attempts))
            self.assertTrue(all(item["facts"] == {} for item in adapter.feedback))
            self.assertTrue(all(item["recent_attempts"] == [] for item in adapter.feedback))

    def test_experiment_arm_compatibility_is_validated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaisesRegex(ValueError, "requires method.level=L2"):
                write_config(
                    root,
                    candidates=3,
                    max_model_calls=3,
                    experiment_arm="L2_uniform",
                )
            with self.assertRaisesRegex(ValueError, "candidates_per_generation=1"):
                write_config(
                    root,
                    candidates=3,
                    max_model_calls=3,
                    experiment_arm="parent_only",
                )

    def test_levels_above_l4_are_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / "config.json"
            path.write_text(json.dumps({
                "benchmark": {"adapter": "gcbench"},
                "backend": {"cwd": str(root), "command": ["fake"]},
                "method": {"level": "L5"},
            }))
            with self.assertRaisesRegex(ValueError, "implements L0-L4"):
                AppConfig.load(path)

    def test_l3_coevolves_bounded_probe_lineage_and_game_archive(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=3,
                max_evaluator_queries=3,
                level="L3",
                max_probe_calls=6,
                max_selected_probes=1,
            )
            controller = LoopController.initialize(
                run_dir=root / "l3-coevolution",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([0.6, 0.7, 0.8]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            selected = [
                attempt["probe_summary"]["selected_probe_ids"][0]
                for attempt in state.attempts
            ]
            self.assertEqual(selected, [
                "runtime_horizon__frames_10",
                "runtime_horizon__frames_20",
                "runtime_horizon__frames_30",
            ])
            coevolution = root / "l3-coevolution" / "coevolution"
            probes = json.loads((coevolution / "probe_archive.json").read_text())
            self.assertIn("runtime_horizon__frames_40", probes["specimens"])
            self.assertEqual(
                probes["specimens"]["runtime_horizon__frames_20"]["parent_probe_id"],
                "runtime_horizon__frames_10",
            )
            games = json.loads((coevolution / "game_archive.json").read_text())
            self.assertEqual(len(games["games"]), 4)
            matrix = json.loads((coevolution / "interaction_matrix.json").read_text())
            self.assertEqual(len(matrix["pair_events"]), 3)
            self.assertEqual(len(matrix["games"]), 4)

    def test_l4_freezes_one_harness_for_the_complete_game_episode(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=3,
                max_evaluator_queries=3,
                level="L4",
                max_probe_calls=6,
                max_selected_probes=1,
            )
            adapter = FakeAdapter([0.6, 0.59, 0.7])
            controller = LoopController.initialize(
                run_dir=root / "l4-episode",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            first, rejected, final = state.attempts
            self.assertTrue(first["accepted"])
            self.assertFalse(rejected["accepted"])
            self.assertTrue(final["accepted"])
            self.assertEqual(
                {item["harness_id"] for item in state.attempts},
                {state.seed_harness_id},
            )
            self.assertEqual(state.champion_harness_id, state.seed_harness_id)
            self.assertEqual(state.harness_mutations, 0)
            self.assertTrue(all(feedback.get("agent_harness") for feedback in adapter.feedback))
            self.assertTrue(all(
                feedback["agent_harness"]["harness_id"] == state.seed_harness_id
                for feedback in adapter.feedback
            ))
            manifest = json.loads((root / "l4-episode" / "manifest.json").read_text())
            self.assertFalse(manifest["frozen_agent"])
            self.assertTrue(manifest["frozen_evaluator"])
            self.assertTrue(manifest["harness_frozen_within_episode"])
            epochs = json.loads(
                (root / "l4-episode" / "harness_archive" / "epochs.json").read_text()
            )
            self.assertEqual(epochs["items"], [])

    def test_harness_outer_epoch_uses_paired_replay_and_promotes_only_robust_gain(self):
        class ReplayRunner:
            def __init__(self, scores):
                self.scores = scores
                self.calls = []

            def run_episode(self, case, harness, *, side, epoch):
                self.calls.append((case.case_id, harness.harness_id, side, epoch))
                return HarnessEpisodeOutcome(
                    case_id=case.case_id,
                    harness_id=harness.harness_id,
                    final_score=self.scores[(side, case.case_id)],
                    feasible=True,
                    model_calls=3,
                    evaluator_queries=3,
                    run_ref=f"{side}/{case.case_id}",
                )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = write_config(
                root,
                candidates=1,
                level="L4",
                max_probe_calls=2,
            )
            engine = HarnessEvolutionEngine(root / "outer", config.method.harness_evolution)
            seed = engine.initialize()
            runner = ReplayRunner({
                ("parent", "a"): 0.50,
                ("candidate", "a"): 0.55,
                ("parent", "b"): 0.60,
                ("candidate", "b"): 0.63,
            })
            outer = HarnessOuterLoop(engine, runner)
            result = outer.run_epoch(
                epoch=1,
                cases=[
                    HarnessReplayCase("a", "task-a", "parent-a"),
                    HarnessReplayCase("b", "task-b", "parent-b"),
                ],
                gradient=HarnessSemanticGradient(
                    "Repeated failures omit executable evidence.",
                    target_tags=("ImproveObjective",),
                    evidence_refs=("run-a", "run-b"),
                ),
            )
            self.assertTrue(result.accepted)
            self.assertEqual(len(runner.calls), 4)
            self.assertNotEqual(result.candidate_harness_id, seed.harness_id)
            self.assertEqual(engine.champion().harness_id, result.candidate_harness_id)
            self.assertAlmostEqual(result.median_delta, 0.04)

    def test_harness_outer_epoch_rejects_budget_mismatch_but_ignores_score_regression(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = write_config(
                root,
                candidates=1,
                level="L4",
                max_probe_calls=2,
            )
            engine = HarnessEvolutionEngine(root / "outer", config.method.harness_evolution)
            parent = engine.initialize()
            candidate = engine.propose(
                parent_id=parent.harness_id,
                gradient=HarnessSemanticGradient("candidate", ("ImproveObjective",)),
                epoch=1,
            )
            result = engine.assess_epoch(
                epoch=1,
                parent=parent,
                candidate=candidate,
                parent_outcomes=[
                    HarnessEpisodeOutcome("a", parent.harness_id, 0.5, True, 3, 3),
                    HarnessEpisodeOutcome("b", parent.harness_id, 0.7, True, 3, 3),
                ],
                candidate_outcomes=[
                    HarnessEpisodeOutcome("a", candidate.harness_id, 0.7, True, 4, 3),
                    HarnessEpisodeOutcome("b", candidate.harness_id, 0.5, True, 3, 3),
                ],
            )
            self.assertFalse(result.accepted)
            self.assertTrue(any("budgets differ" in reason for reason in result.reasons))
            self.assertFalse(any("regression limit" in reason for reason in result.reasons))

    def test_harness_epoch_can_promote_without_benchmark_score_gain(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = write_config(root, candidates=1, level="L4", max_probe_calls=2)
            engine = HarnessEvolutionEngine(root / "outer", config.method.harness_evolution)
            parent = engine.initialize()
            candidate = engine.propose(
                parent_id=parent.harness_id,
                gradient=HarnessSemanticGradient("candidate", ("ImproveObjective",)),
                epoch=1,
            )
            outcomes = [
                HarnessEpisodeOutcome("a", parent.harness_id, 1.0, True, 3, 3),
                HarnessEpisodeOutcome("b", parent.harness_id, 1.0, True, 3, 3),
            ]
            candidate_outcomes = [
                HarnessEpisodeOutcome("a", candidate.harness_id, 0.2, True, 3, 3),
                HarnessEpisodeOutcome("b", candidate.harness_id, 0.2, True, 3, 3),
            ]

            result = engine.assess_epoch(
                epoch=1,
                parent=parent,
                candidate=candidate,
                parent_outcomes=outcomes,
                candidate_outcomes=candidate_outcomes,
                rubric_validation={"accepted": True, "reasons": []},
            )

            self.assertTrue(result.accepted)
            self.assertEqual(result.median_delta, -0.8)

    def test_command_replay_runner_builds_isolated_matched_episode_commands(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "task"
            task.mkdir()
            artifact = root / "artifact"
            artifact.mkdir()
            config = write_config(
                root,
                candidates=1,
                level="L4",
                max_probe_calls=2,
            )
            engine = HarnessEvolutionEngine(root / "outer", config.method.harness_evolution)
            profile = engine.initialize()
            runner = CommandHarnessReplayRunner(
                runs_root=root / "replays",
                project_root=Path(__file__).resolve().parents[1],
            )
            case = HarnessReplayCase(
                "case-a",
                str(task),
                str(artifact),
                {"config_path": str(root / "config.json"), "seed_score": 0.5},
            )
            run_dir, init_argv, evolve_argv = runner.build_commands(
                case, profile, side="candidate", epoch=2
            )
            self.assertEqual(
                run_dir,
                (root / "replays" / "epoch_002" / "case-a" / "candidate").resolve(),
            )
            self.assertIn("--harness-profile", init_argv)
            self.assertIn(str((root / "config.json").resolve()), init_argv)
            self.assertEqual(
                evolve_argv[-2:],
                ["--config", str((root / "config.json").resolve())],
            )

    def test_trajectory_attribution_separates_infrastructure_from_harness_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_a = root / "run-a"
            run_b = root / "run-b"
            run_a.mkdir()
            run_b.mkdir()
            (run_a / "state.json").write_text(json.dumps({"attempts": [
                {"attempt_id": "a1", "status": "gate_failed", "reasons": ["import failed"]},
                {"attempt_id": "a2", "status": "infra_failed", "reasons": ["timeout"]},
            ]}))
            (run_b / "state.json").write_text(json.dumps({"attempts": [
                {"attempt_id": "b1", "status": "gate_failed", "reasons": ["import failed"]},
            ]}))
            report = TrajectoryAttributor().collect([run_a, run_b])
            gradient = RuleBasedSemanticGradientProposer().propose(report)
            self.assertEqual(report.infrastructure_events, 1)
            self.assertEqual(report.repeated_failures[0]["count"], 2)
            self.assertEqual(gradient.target_tags, ("gate_repair",))
            self.assertTrue(all("timeout" not in item["reason"] for item in report.repeated_failures))

    def test_l4_context_compiler_candidate_changes_runtime_feedback_selection(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed_artifact = root / "seed"
            seed_artifact.mkdir()
            (seed_artifact / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=4,
                max_model_calls=4,
                max_evaluator_queries=4,
                level="L4",
                max_probe_calls=8,
            )
            outer_engine = HarnessEvolutionEngine(
                root / "outer", config.method.harness_evolution
            )
            parent = outer_engine.initialize()
            candidate = outer_engine.propose(
                parent_id=parent.harness_id,
                gradient=HarnessSemanticGradient(
                    "Recent history contains distracting stale attempts.",
                    target_tags=("history_noise",),
                ),
                epoch=1,
            )
            self.assertEqual(candidate.context_compiler.history_window, 3)

            adapter = FakeAdapter([0.4, 0.4, 0.4, 0.4])
            controller = LoopController.initialize(
                run_dir=root / "context-episode",
                task_source=task,
                seed_artifact=seed_artifact,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
                initial_harness_profile=candidate,
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            controller.evolve()
            self.assertEqual(
                [len(item["recent_attempts"]) for item in adapter.feedback],
                [0, 1, 2, 3],
            )
            self.assertEqual(adapter.feedback[-1]["context_compiler"]["history_window"], 3)

    def test_l4_precommitted_recovery_policy_retries_infrastructure_with_real_budget(self):
        class FlakyAdapter(FakeAdapter):
            def __init__(self):
                super().__init__([0.7])
                self.failed_once = False

            def collect(self, prepared, execution):
                if not self.failed_once:
                    self.failed_once = True
                    return CandidateResult(
                        Path(prepared.metadata["artifact"]),
                        None,
                        "transient evaluator timeout",
                        evaluator_queries=1,
                    )
                return super().collect(prepared, execution)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed_artifact = root / "seed"
            seed_artifact.mkdir()
            (seed_artifact / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=1,
                max_model_calls=2,
                max_evaluator_queries=1,
                level="L4",
                max_probe_calls=2,
            )
            engine = HarnessEvolutionEngine(root / "outer", config.method.harness_evolution)
            parent = engine.initialize()
            candidate = engine.propose(
                parent_id=parent.harness_id,
                gradient=HarnessSemanticGradient(
                    "Transient infrastructure failures waste whole episodes.",
                    target_tags=("infra_recovery",),
                ),
                epoch=1,
            )
            self.assertEqual(candidate.recovery_policy.infrastructure_retries, 1)
            adapter = FlakyAdapter()
            controller = LoopController.initialize(
                run_dir=root / "recovery-episode",
                task_source=task,
                seed_artifact=seed_artifact,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
                initial_harness_profile=candidate,
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            self.assertEqual(state.model_calls, 2)
            self.assertEqual(state.evaluator_attempts, 2)
            self.assertEqual(state.evaluator_queries, 1)
            self.assertEqual(state.infrastructure_failures, 0)
            self.assertTrue(state.attempts[0]["accepted"])
            self.assertIn("runtime_recovery", adapter.feedback[1])
            recovery = json.loads(
                (root / "recovery-episode" / "generation_001" / "candidate_01" / "recovery.json").read_text()
            )
            self.assertFalse(recovery["final_infrastructure_failure"])

    def test_l4_validation_policy_repairs_a_gate_failure_before_selection(self):
        class GateFlakyAdapter(FakeAdapter):
            def __init__(self):
                super().__init__([0.7, 0.75])
                self.validation_calls = 0

            def validate(self, artifact, common_config):
                self.validation_calls += 1
                # Call 1 validates the seed; call 2 rejects the first candidate.
                if self.validation_calls == 2:
                    return GateResult(False, errors=["candidate import failed"])
                return GateResult(True, stats={"files": 1})

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed_artifact = root / "seed"
            seed_artifact.mkdir()
            (seed_artifact / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=1,
                max_model_calls=2,
                max_evaluator_queries=2,
                level="L4",
                max_probe_calls=2,
            )
            engine = HarnessEvolutionEngine(root / "outer", config.method.harness_evolution)
            parent = engine.initialize()
            candidate = engine.propose(
                parent_id=parent.harness_id,
                gradient=HarnessSemanticGradient(
                    "Candidates often fail deterministic import validation.",
                    target_tags=("gate_repair",),
                ),
                epoch=1,
            )
            self.assertEqual(candidate.validation_policy.repair_attempts, 1)
            adapter = GateFlakyAdapter()
            controller = LoopController.initialize(
                run_dir=root / "validation-episode",
                task_source=task,
                seed_artifact=seed_artifact,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
                initial_harness_profile=candidate,
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            self.assertEqual(state.model_calls, 2)
            self.assertEqual(state.evaluator_queries, 2)
            self.assertTrue(state.attempts[0]["accepted"])
            self.assertAlmostEqual(state.champion_result.primary_score, 0.75)
            self.assertIn("runtime_validation_repair", adapter.feedback[1])
            validation = json.loads(
                (root / "validation-episode" / "generation_001" / "candidate_01" / "validation_recovery.json").read_text()
            )
            self.assertIsNone(validation["remaining_failure"])

    def test_l3_preserves_a_regression_finding_probe_when_archive_prunes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=3,
                max_evaluator_queries=3,
                level="L3",
                max_probe_calls=6,
                max_selected_probes=1,
                family_archive_capacity=2,
            )
            controller = LoopController.initialize(
                run_dir=root / "l3-protected",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([0.6, 0.7, 0.8]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (False, 0.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            controller.evolve()
            archive = json.loads(
                (root / "l3-protected" / "coevolution" / "probe_archive.json")
                .read_text()
            )
            original = archive["specimens"]["runtime_horizon__frames_10"]
            self.assertTrue(original["protected"])
            self.assertTrue(original["active"])
            self.assertEqual(original["stats"]["regressions_found"], 1)
            active = [
                item for item in archive["specimens"].values() if item["active"]
            ]
            self.assertEqual(len(active), 2)
            self.assertTrue(any(not item["active"] for item in archive["specimens"].values()))

    def test_l3_no_evolve_keeps_the_initial_probe_population_frozen(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=3,
                max_evaluator_queries=3,
                level="L3",
                max_probe_calls=6,
                max_selected_probes=1,
                experiment_arm="L3_no_evolve",
            )
            controller = LoopController.initialize(
                run_dir=root / "l3-no-evolve",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([0.6, 0.7, 0.8]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            self.assertEqual(
                [item["probe_summary"]["selected_probe_ids"][0] for item in state.attempts],
                ["runtime_horizon__frames_10"] * 3,
            )
            archive = json.loads(
                (root / "l3-no-evolve" / "coevolution" / "probe_archive.json").read_text()
            )
            self.assertEqual(len(archive["specimens"]), 1)
            self.assertFalse(archive["policy_options"]["allow_offspring"])
            self.assertTrue(all(not event["offspring"] for event in archive["events"]))

    def test_l3_no_protect_disables_only_the_pruning_preference(self):
        from game_loop.core.coevolution import _prune_archive

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=3,
                max_evaluator_queries=3,
                level="L3",
                max_probe_calls=6,
                family_archive_capacity=2,
                experiment_arm="L3_no_protect",
            )
            family = config.method.probe_families[0]
            specimens = {
                "protected_low": {
                    "probe_id": "protected_low", "family_id": family.family_id,
                    "active": True, "protected": True, "fitness": 0.1,
                    "stats": {"trials": 3},
                },
                "plain_high": {
                    "probe_id": "plain_high", "family_id": family.family_id,
                    "active": True, "protected": False, "fitness": 0.9,
                    "stats": {"trials": 3},
                },
                "plain_mid": {
                    "probe_id": "plain_mid", "family_id": family.family_id,
                    "active": True, "protected": False, "fitness": 0.8,
                    "stats": {"trials": 3},
                },
            }
            protected_archive = {"specimens": copy.deepcopy(specimens)}
            no_protect_archive = {"specimens": copy.deepcopy(specimens)}
            _prune_archive(
                protected_archive,
                {family.family_id: family},
                protect_regressions=True,
            )
            _prune_archive(
                no_protect_archive,
                {family.family_id: family},
                protect_regressions=False,
            )
            self.assertTrue(protected_archive["specimens"]["protected_low"]["active"])
            self.assertFalse(no_protect_archive["specimens"]["protected_low"]["active"])

    def test_l2_active_selection_closes_coverage_then_revisits_regressions(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=4,
                max_model_calls=4,
                max_evaluator_queries=4,
                level="L2",
                max_probe_calls=8,
                probe_ids=("probe_a", "probe_b", "probe_c"),
                max_selected_probes=1,
            )
            controller = LoopController.initialize(
                run_dir=root / "l2-active",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([0.6, 0.7, 0.8, 0.9]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (False, 0.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            selected = [
                attempt["probe_summary"]["selected_probe_ids"][0]
                for attempt in state.attempts
            ]
            self.assertEqual(selected, ["probe_a", "probe_b", "probe_c", "probe_b"])
            self.assertEqual(state.probe_calls, 8)
            self.assertEqual(state.model_calls, 4)
            self.assertEqual(state.attempts[1]["status"], "probe_failed")
            decision = json.loads(
                (root / "l2-active" / "generation_004" / "candidate_01" /
                 "probe_selection.json").read_text()
            )
            self.assertEqual(decision["selected_probe_ids"], ["probe_b"])
            probe_b = next(
                item for item in decision["priorities"] if item["probe_id"] == "probe_b"
            )
            self.assertEqual(probe_b["regressions_found"], 1)
            first_feedback = json.loads(
                (root / "l2-active" / "generation_001" / "candidate_01" /
                 "feedback.json").read_text()
            )
            self.assertEqual(first_feedback["method_level"], "L2")
            self.assertIn("active_probe_observations", first_feedback["facts"])
            self.assertIsNotNone(first_feedback["priority"]["active_probe_selection"])

    def test_l2_uniform_round_robin_ignores_observed_regression_yield(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=3,
                max_model_calls=3,
                max_evaluator_queries=3,
                level="L2",
                max_probe_calls=6,
                probe_ids=("probe_a", "probe_b"),
                max_selected_probes=1,
                experiment_arm="L2_uniform",
            )
            controller = LoopController.initialize(
                run_dir=root / "l2-uniform",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([0.6, 0.7, 0.8]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"), (True, 1.0, "completed"),
                (True, 1.0, "completed"), (False, 0.0, "completed"),
                (True, 1.0, "completed"), (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            self.assertEqual(
                [item["probe_summary"]["selected_probe_ids"][0] for item in state.attempts],
                ["probe_a", "probe_b", "probe_a"],
            )
            self.assertTrue(all(
                item["probe_summary"]["selection_policy"] == "uniform-round-robin-v1"
                for item in state.attempts
            ))

    def test_l2_reserves_a_complete_active_pair_before_calling_model(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=2,
                max_model_calls=2,
                max_evaluator_queries=2,
                level="L2",
                max_probe_calls=2,
                probe_ids=("probe_a", "probe_b"),
                max_selected_probes=1,
            )
            controller = LoopController.initialize(
                run_dir=root / "l2-budget",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([0.6]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"),
                (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            self.assertEqual(state.model_calls, 1)
            self.assertEqual(state.evaluator_queries, 1)
            self.assertEqual(state.probe_calls, 2)
            self.assertEqual(state.stop_reason, "L2 probe pair budget exhausted")

    def test_l1_runs_the_exact_fixed_suite_as_a_paired_comparison(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(root, candidates=1, level="L1", max_probe_calls=2)
            adapter = FakeAdapter([0.7])
            controller = LoopController.initialize(
                run_dir=root / "l1-paired",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=adapter,
            )
            runner = FakeProbeRunner([
                (True, 1.0, "completed"),
                (True, 1.0, "completed"),
            ])
            controller.backend = FakeBackend()
            controller.probe_runner = runner
            state = controller.evolve()
            self.assertTrue(state.attempts[0]["accepted"])
            self.assertEqual(state.probe_calls, 2)
            self.assertEqual([call["phase"] for call in runner.calls], ["parent", "candidate"])
            self.assertEqual(runner.calls[0]["probe_ids"], runner.calls[1]["probe_ids"])
            self.assertEqual(runner.calls[0]["commands"], runner.calls[1]["commands"])
            self.assertNotEqual(runner.calls[0]["artifact_dir"], runner.calls[1]["artifact_dir"])
            feedback = json.loads(
                (root / "l1-paired" / "generation_001" / "candidate_01" / "feedback.json")
                .read_text()
            )
            self.assertEqual(feedback["method_level"], "L1")
            self.assertTrue(feedback["facts"]["fixed_probe_observations"][0]["passed"])

    def test_l1_rejects_a_benchmark_improvement_that_breaks_an_anchor(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(root, candidates=1, level="L1", max_probe_calls=2)
            controller = LoopController.initialize(
                run_dir=root / "l1-regression",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([0.9]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (True, 1.0, "completed"),
                (False, 0.0, "completed"),
            ])
            state = controller.evolve()
            attempt = state.attempts[0]
            self.assertFalse(attempt["accepted"])
            self.assertEqual(attempt["status"], "probe_failed")
            self.assertIn("regressed from pass to fail", " ".join(attempt["reasons"]))
            self.assertEqual(state.champion_result.primary_score, 0.5)

    def test_l1_required_probe_and_probe_budget_are_enforced(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                generations=2,
                max_model_calls=2,
                max_evaluator_queries=2,
                level="L1",
                probe_mode="required",
                max_probe_calls=2,
            )
            controller = LoopController.initialize(
                run_dir=root / "l1-required",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([0.8]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (False, 0.0, "completed"),
                (False, 0.0, "completed"),
            ])
            state = controller.evolve()
            self.assertEqual(state.attempts[0]["status"], "probe_failed")
            self.assertEqual(state.model_calls, 1)
            self.assertEqual(state.probe_calls, 2)
            self.assertEqual(state.stop_reason, "L1 fixed probe budget exhausted")

    def test_l1_required_probe_can_repair_a_failing_parent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(
                root,
                candidates=1,
                level="L1",
                probe_mode="required",
                max_probe_calls=2,
            )
            controller = LoopController.initialize(
                run_dir=root / "l1-repair",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([0.8]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([
                (False, 0.0, "completed"),
                (True, 1.0, "completed"),
            ])
            state = controller.evolve()
            self.assertTrue(state.attempts[0]["accepted"])
            self.assertEqual(state.champion_result.primary_score, 0.8)

    def test_l1_parent_probe_infrastructure_failure_does_not_call_model(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed"
            seed.mkdir()
            (seed / "score.txt").write_text("0.5")
            task = root / "task"
            task.mkdir()
            config = write_config(root, candidates=1, level="L1", max_probe_calls=2)
            controller = LoopController.initialize(
                run_dir=root / "l1-infra",
                task_source=task,
                seed_artifact=seed,
                seed_evaluation=EvaluationResult(0.5, True, {"quality": 0.5}),
                config=config,
                adapter=FakeAdapter([]),
            )
            controller.backend = FakeBackend()
            controller.probe_runner = FakeProbeRunner([(None, None, "timed_out")])
            state = controller.evolve()
            self.assertEqual(state.model_calls, 0)
            self.assertEqual(state.evaluator_queries, 0)
            self.assertEqual(state.probe_calls, 1)
            self.assertEqual(state.attempts[0]["status"], "infra_failed")

    def test_fixed_command_probe_runner_parses_structured_metrics(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / "config.json"
            path.write_text(json.dumps({
                "benchmark": {"adapter": "gcbench"},
                "backend": {"cwd": str(root), "command": ["fake"]},
                "method": {
                    "level": "L1",
                    "fixed_probes": [{
                        "id": "structured",
                        "cwd": str(root),
                        "command": [
                            "/usr/bin/env",
                            "python3",
                            "-c",
                            "import json; print(json.dumps({{'passed': True, 'score': 0.75, 'diagnostics': ['ok']}}))",
                        ],
                        "parser": "json_stdout",
                        "selection_mode": "regression_anchor",
                    }],
                    "max_probe_calls": 2,
                },
            }))
            config = AppConfig.load(path)
            suite = FixedCommandProbeRunner().run_suite(
                config.method.fixed_probes,
                context={"artifact_dir": str(root)},
                output_dir=root / "probe-output",
                phase="parent",
            )
            self.assertTrue(suite.infrastructure_ok)
            self.assertTrue(suite.results[0].passed)
            self.assertEqual(suite.results[0].score, 0.75)
            self.assertEqual(suite.results[0].diagnostics, ["ok"])

    def test_gcbench_components_and_breakdown_normalization(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            game = root / "game"
            (game / "demo_outputs").mkdir(parents=True)
            (game / "project.godot").write_text("[application]\n")
            (game / "main.gd").write_text("extends Node\n")
            (game / "demo_outputs" / "01.json").write_text(json.dumps({"duration_frames": 1, "events": []}))
            adapter = GameCraftBenchAdapter({})
            record = ArtifactStore(root / "store", adapter.artifact_descriptor).snapshot(game)
            self.assertIn("behavior_evidence", record.component_hashes)
            retained = root / "retained"
            adapter.stage_artifact(game, retained)
            self.assertTrue((retained / "demo_outputs" / "01.json").is_file())
            breakdown = root / "breakdown.json"
            breakdown.write_text(json.dumps({
                "reward": 0.7,
                "build_ok": True,
                "requirements": [
                    {"id": "M1", "aggregated": 0.8},
                    {"id": "D1", "aggregated": 0.6},
                ],
            }))
            evaluation = adapter.parse_evaluation(breakdown)
            self.assertEqual(evaluation.primary_score, 0.7)
            self.assertEqual(evaluation.objectives["mechanics"], 0.8)
            self.assertFalse(evaluation.terminal_success)

    def test_gcbench_judge_failure_is_infrastructure_not_a_zero_quality_game(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "breakdown.json"
            path.write_text(json.dumps({
                "reward": 0.0,
                "build_ok": True,
                "errors": ["judge failed on demo_01: request timed out"],
            }))
            evaluation = GameCraftBenchAdapter({}).parse_evaluation(path)
            self.assertFalse(evaluation.feasible)
            self.assertTrue(evaluation.constraints["build"])
            self.assertFalse(evaluation.constraints["judge_complete"])

    def test_gcbench_replay_failure_is_infrastructure_not_a_zero_quality_game(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "breakdown.json"
            path.write_text(json.dumps({
                "reward": 0.0,
                "build_ok": True,
                "errors": ["replay failed for demo_01: required tool not on PATH: Xvfb"],
            }))
            evaluation = GameCraftBenchAdapter({}).parse_evaluation(path)
            self.assertFalse(evaluation.feasible)
            self.assertTrue(evaluation.constraints["build"])
            self.assertFalse(evaluation.constraints["replay_complete"])
            self.assertTrue(evaluation.constraints["judge_complete"])

    def test_gcbench_build_failure_is_quality_failure_not_infrastructure(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            artifact = root / "artifact"
            artifact.mkdir()
            (artifact / "project.godot").write_text("[application]\n")
            breakdown = root / "breakdown.json"
            breakdown.write_text(json.dumps({
                "reward": 0.0,
                "build_ok": False,
                "errors": ["Godot project failed the build check"],
            }))
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({
                "artifact_path": str(artifact),
                "breakdown_path": str(breakdown),
            }))
            prepared = PreparedTask(
                "gcbench",
                root,
                {},
                {"output_manifest": str(manifest), "candidate_dir": str(root / "candidate")},
            )
            result = GameCraftBenchAdapter({}).collect(
                prepared,
                BackendExecution(0, root / "backend.log"),
            )
            self.assertIsNone(result.error)
            self.assertIsNotNone(result.artifact_dir)
            self.assertFalse(result.evaluation.feasible)

    def test_gcbench_renders_l4_harness_into_native_extra_instruction(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            gcbench = root / "gcbench"
            (gcbench / "tools").mkdir(parents=True)
            (gcbench / "tools" / "godot_command_line.md").write_text("# godot", encoding="utf-8")
            task = root / "task"
            task.mkdir()
            parent = root / "parent"
            parent.mkdir()
            (parent / "project.godot").write_text("[application]\n")
            candidate = root / "candidate"
            candidate.mkdir()
            from game_loop.core.models import AttemptContext
            with patch.dict(os.environ, {"GODOT_EXEC_PATH": sys.executable}, clear=False):
                prepared = GameCraftBenchAdapter({"root": str(gcbench)}).prepare(
                    task_source=task,
                    parent_artifact=parent,
                    feedback={
                        "agent_harness": {
                            "rendered_instruction": "Agent harness profile\n- verify changed path",
                        },
                    },
                    candidate_dir=candidate,
                    context=AttemptContext("run", 1, 1),
                )
            rendered = Path(prepared.command_context["extra_instruction"]).read_text()
            self.assertIn("Agent harness profile", rendered)
            self.assertIn("verify changed path", rendered)
            self.assertIn("rubric and shared assets are immutable", rendered)
            self.assertIn("Local runtime", rendered)
            self.assertTrue((candidate / "task_overlay" / "workspace" / "tools" / "godot").is_file())
            self.assertEqual(prepared.command_context["task_id"], "task")
            self.assertIn("breakdown_path", prepared.command_context)
            self.assertIn("gcbench_root", prepared.command_context)

    def test_gcbench_l4_backend_command_placeholders(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task = root / "puzzle-sokoban-dungeon"
            task.mkdir()
            (task / "instruction.md").write_text("Build sokoban.", encoding="utf-8")
            parent = root / "parent"
            parent.mkdir()
            (parent / "project.godot").write_text("[application]\n")
            (parent / "demo_outputs").mkdir()
            (parent / "demo_outputs" / "01.json").write_text("{}", encoding="utf-8")
            candidate = root / "candidate"
            candidate.mkdir()
            from game_loop.backends.command import CommandBackend
            from game_loop.config import BackendConfig
            from game_loop.core.models import AttemptContext

            gcbench = root / "gcbench"
            (gcbench / "tools").mkdir(parents=True)
            (gcbench / "tools" / "godot_command_line.md").write_text("# godot", encoding="utf-8")
            with patch.dict(os.environ, {"GODOT_EXEC_PATH": sys.executable}, clear=False):
                prepared = GameCraftBenchAdapter({"root": str(gcbench)}).prepare(
                    task_source=task,
                    parent_artifact=parent,
                    feedback={},
                    candidate_dir=candidate,
                    context=AttemptContext("run", 1, 1),
                )
            backend = CommandBackend(
                BackendConfig(
                    command=(
                        "bash",
                        "scripts/run_gcbench_l4_backend.sh",
                        "{candidate_workspace}",
                        "{instruction_file}",
                        "{artifact_path}",
                        "{output_manifest}",
                        "{task_id}",
                        "{gcbench_root}",
                        "{breakdown_path}",
                    ),
                    cwd=Path("."),
                    timeout_seconds=60,
                    env={},
                )
            )
            command = [
                part.format_map(prepared.command_context)
                for part in backend.config.command
            ]
            self.assertEqual(command[6], str(task.name))
            self.assertTrue(command[5].endswith("gcbench_execution.json"))

    def test_chat_agent_blocks_root_find(self):
        from game_loop.chat_agent import LocalChatAgent

        with patch.dict(
            os.environ,
            {
                "CODEX_API_BASE": "http://example.test/v1",
                "CODEX_MODEL": "test-model",
            },
            clear=False,
        ):
            agent = LocalChatAgent()
            self.assertIsNotNone(agent._blocked_command_reason("find / -name godot"))
            self.assertIsNone(agent._blocked_command_reason("tools/godot --version"))

    def test_chat_agent_continues_after_truncated_response(self):
        from game_loop.chat_agent import LocalChatAgent

        agent = LocalChatAgent.__new__(LocalChatAgent)
        agent.system_prompt = "test system"
        responses = iter([
            {
                "choices": [{
                    "message": {"role": "assistant", "content": "partial implementation"},
                    "finish_reason": "length",
                }]
            },
            {
                "choices": [{
                    "message": {"role": "assistant", "content": "done"},
                    "finish_reason": "stop",
                }]
            },
        ])
        agent._call_api = lambda messages, tools: next(responses)

        with tempfile.TemporaryDirectory() as raw:
            result = agent.run("build it", Path(raw), tools=[], max_turns=3)

        self.assertEqual(result["turns"], 2)
        self.assertEqual(result["final_text"], "done")
        continuation = [
            item for item in result["messages"]
            if item.get("role") == "user" and "truncated" in item.get("content", "")
        ]
        self.assertEqual(len(continuation), 1)

    def test_chat_agent_retries_socket_timeout(self):
        import socket
        from game_loop.chat_agent import LocalChatAgent

        agent = LocalChatAgent.__new__(LocalChatAgent)
        agent.api_base = "http://example.test/v1"
        agent.model = "test-model"
        agent.api_key = ""
        agent.thinking_mode = ""
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{"choices":[{"message":{"content":"ok"}}]}'

        with patch(
            "game_loop.chat_agent.urllib.request.urlopen",
            side_effect=[socket.timeout("slow upstream"), response],
        ) as urlopen, patch("game_loop.chat_agent.time.sleep"):
            payload = agent._call_api([{"role": "user", "content": "ping"}])

        self.assertEqual(urlopen.call_count, 2)
        self.assertEqual(payload["choices"][0]["message"]["content"], "ok")

    def test_qwen_and_glm_chat_agent_disable_hidden_thinking(self):
        from game_loop.chat_agent import LocalChatAgent

        for model in ("Qwen3.6-27B", "GLM-5.2-W4AFP8-node6"):
            with self.subTest(model=model):
                agent = LocalChatAgent.__new__(LocalChatAgent)
                agent.api_base = "http://example.test/v1"
                agent.model = model
                agent.api_key = ""
                agent.thinking_mode = ""
                response = Mock()
                response.__enter__ = Mock(return_value=response)
                response.__exit__ = Mock(return_value=False)
                response.read.return_value = b'{"choices":[{"message":{"content":"ok"}}]}'
                with patch(
                    "game_loop.chat_agent.urllib.request.urlopen",
                    return_value=response,
                ) as urlopen:
                    agent._call_api([{"role": "user", "content": "ping"}])
                request = urlopen.call_args.args[0]
                body = json.loads(request.data.decode("utf-8"))
                self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})

    def test_chat_agent_retry_budget_and_timeout_are_runtime_configurable(self):
        import urllib.error
        from game_loop.chat_agent import LocalChatAgent

        agent = LocalChatAgent.__new__(LocalChatAgent)
        agent.api_base = "http://example.test/v1"
        agent.model = "test-model"
        agent.api_key = ""
        agent.thinking_mode = ""
        error = urllib.error.HTTPError(
            "http://example.test/v1/chat/completions", 502, "bad gateway", {}, None
        )
        with patch.dict(
            os.environ,
            {
                "GAME_LOOP_CHAT_API_MAX_RETRIES": "2",
                "GAME_LOOP_CHAT_API_TIMEOUT_SECONDS": "42",
            },
            clear=False,
        ), patch(
            "game_loop.chat_agent.urllib.request.urlopen",
            side_effect=[error, error],
        ) as urlopen, patch("game_loop.chat_agent.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "API error 502"):
                agent._call_api([{"role": "user", "content": "ping"}])
        self.assertEqual(urlopen.call_count, 2)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 42)

    def test_chat_agent_normalizes_truncated_tool_arguments_before_replay(self):
        from game_loop.chat_agent import LocalChatAgent

        malformed = {
            "role": "assistant",
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {
                    "name": "write_file",
                    "arguments": '{"path":"game/Main.gd","content":"unterminated',
                },
            }],
        }
        normalized = LocalChatAgent._normalize_assistant_message(malformed)
        arguments = normalized["tool_calls"][0]["function"]["arguments"]
        parsed = json.loads(arguments)
        self.assertIn("_tool_argument_error", parsed)
        self.assertLessEqual(len(parsed["_raw_arguments_prefix"]), 500)

        agent = LocalChatAgent.__new__(LocalChatAgent)
        with tempfile.TemporaryDirectory() as raw:
            result = agent._execute_tool(normalized["tool_calls"][0], Path(raw), [])
        payload = json.loads(result["content"])
        self.assertFalse(payload["ok"])
        self.assertIn("Retry this tool call", payload["instruction"])

    def test_chat_agent_refuses_early_stop_until_gcbench_demos_exist(self):
        from game_loop.chat_agent import LocalChatAgent

        agent = LocalChatAgent.__new__(LocalChatAgent)
        agent.system_prompt = "test"
        calls = 0

        def fake_call(messages, tools):
            nonlocal calls
            calls += 1
            if calls == 1:
                return {"choices": [{
                    "message": {"role": "assistant", "content": "done"},
                    "finish_reason": "stop",
                }]}
            return {"choices": [{
                "message": {"role": "assistant", "content": "really done"},
                "finish_reason": "stop",
            }]}

        agent._call_api = fake_call
        with tempfile.TemporaryDirectory() as raw, patch.dict(
            os.environ, {"GAME_LOOP_REQUIRE_GCB_DEMOS": "1"}, clear=False
        ):
            workspace = Path(raw)
            demos = workspace / "game" / "demo_outputs"
            demos.mkdir(parents=True)

            original_gate = agent._demo_gate_message
            def gate_and_create(count):
                for index in range(3):
                    (demos / f"demo_{index}.json").write_text("{}", encoding="utf-8")
                return original_gate(count)
            agent._demo_gate_message = gate_and_create
            result = agent.run("build", workspace, tools=[], max_turns=3)

        self.assertEqual(calls, 2)
        self.assertEqual(result["turns"], 2)
        self.assertTrue(any(
            "deliverable gate" in item.get("content", "")
            for item in result["messages"] if item.get("role") == "user"
        ))

    def test_demo_gate_only_allows_demo_json_writes(self):
        from game_loop.chat_agent import LocalChatAgent

        blocked = {
            "id": "call-1",
            "function": {"name": "run_command", "arguments": '{"command":"true"}'},
        }
        wrong_write = {
            "id": "call-2",
            "function": {"name": "write_file", "arguments": '{"path":"game/Main.gd","content":"x"}'},
        }
        demo_write = {
            "id": "call-3",
            "function": {
                "name": "write_file",
                "arguments": '{"path":"game/demo_outputs/demo_02.json","content":"{}"}',
            },
        }
        self.assertFalse(LocalChatAgent._is_demo_write_tool_call(blocked))
        self.assertFalse(LocalChatAgent._is_demo_write_tool_call(wrong_write))
        self.assertTrue(LocalChatAgent._is_demo_write_tool_call(demo_write))
        error = LocalChatAgent._demo_gate_tool_error(blocked, 1)
        self.assertIn("temporarily blocked", json.loads(error["content"])["error"])

    def test_chat_agent_run_command_timeout_kills_child_process_group(self):
        from game_loop.chat_agent import LocalChatAgent

        agent = LocalChatAgent.__new__(LocalChatAgent)
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw)
            child_pid = workspace / "child.pid"
            command = (
                f"{sys.executable} -c "
                + json.dumps(
                    "import pathlib, subprocess, sys, time; "
                    "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); "
                    f"pathlib.Path({str(child_pid)!r}).write_text(str(p.pid)); "
                    "time.sleep(30)"
                )
            )

            result = agent._dispatch_tool(
                "run_command",
                {"command": command, "timeout": 1},
                workspace,
            )

            self.assertFalse(result["ok"])
            self.assertIn("timed out", result["error"])
            deadline = __import__("time").monotonic() + 5
            while not child_pid.exists() and __import__("time").monotonic() < deadline:
                __import__("time").sleep(0.05)
            self.assertTrue(child_pid.exists())
            pid = int(child_pid.read_text(encoding="utf-8"))
            for _ in range(20):
                try:
                    os.kill(pid, 0)
                except OSError:
                    break
                __import__("time").sleep(0.1)
            else:
                try:
                    os.kill(pid, 9)
                except OSError:
                    pass
                self.fail(f"child process {pid} survived command timeout")

    def test_chat_agent_compacts_large_write_file_arguments_in_history(self):
        from game_loop.chat_agent import LocalChatAgent

        agent = LocalChatAgent.__new__(LocalChatAgent)
        agent.system_prompt = "test"
        large_content = "x" * 2000
        seen_second_request: list[list[dict[str, object]]] = []

        def fake_call(messages, tools):
            if len(seen_second_request) == 0:
                seen_second_request.append(messages)
                return {"choices": [{
                    "message": {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "write_file",
                                "arguments": json.dumps({
                                    "path": "game/Main.gd",
                                    "content": large_content,
                                }),
                            },
                        }],
                    }
                }]}
            seen_second_request.append(messages)
            return {"choices": [{
                "message": {"role": "assistant", "content": "done"},
                "finish_reason": "stop",
            }]}

        agent._call_api = fake_call
        with tempfile.TemporaryDirectory() as raw, patch.dict(
            os.environ,
            {
                "GAME_LOOP_REQUIRE_GCB_DEMOS": "0",
                "GAME_LOOP_TOOL_CALL_HISTORY_CONTENT_CHARS": "64",
            },
            clear=False,
        ):
            workspace = Path(raw)
            result = agent.run("build", workspace, tools=[], max_turns=2)
            self.assertEqual((workspace / "game" / "Main.gd").read_text(encoding="utf-8"), large_content)

        self.assertEqual(result["turns"], 2)
        replayed = seen_second_request[-1][2]
        args = json.loads(replayed["tool_calls"][0]["function"]["arguments"])
        self.assertTrue(args["_content_history_compacted"])
        self.assertEqual(args["_content_chars"], len(large_content))
        self.assertLess(len(args["content"]), 256)
        self.assertNotEqual(args["content"], large_content)

    def test_chat_agent_bounded_history_drops_orphan_tool_prefix(self):
        from game_loop.chat_agent import LocalChatAgent

        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "task"},
            {"role": "assistant", "tool_calls": [{"id": "old", "type": "function", "function": {"name": "x", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "old", "content": "{}"},
            {"role": "assistant", "content": "older"},
            {"role": "tool", "tool_call_id": "orphan-if-trimmed", "content": "{}"},
            {"role": "assistant", "content": "recent"},
            {"role": "user", "content": "continue"},
        ]
        with patch.dict(os.environ, {"GAME_LOOP_CHAT_MAX_HISTORY_MESSAGES": "3"}, clear=False):
            bounded = LocalChatAgent._bounded_messages_for_api(messages)
        self.assertEqual(bounded[:2], messages[:2])
        self.assertNotEqual(bounded[2]["role"], "tool")
        self.assertEqual([m["role"] for m in bounded], ["system", "user", "assistant", "user"])

    def test_chat_agent_stops_after_required_demo_delivery(self):
        from game_loop.chat_agent import LocalChatAgent

        agent = LocalChatAgent.__new__(LocalChatAgent)
        agent.system_prompt = "test"

        def fake_call(_messages, _tools):
            return {"choices": [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "write_file",
                            "arguments": json.dumps({
                                "path": "game/demo_outputs/demo_3.json",
                                "content": "{}",
                            }),
                        },
                    }],
                }
            }]}

        agent._call_api = fake_call
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw)
            demo_dir = workspace / "game" / "demo_outputs"
            demo_dir.mkdir(parents=True)
            (demo_dir / "demo_1.json").write_text("{}", encoding="utf-8")
            (demo_dir / "demo_2.json").write_text("{}", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "GAME_LOOP_REQUIRE_GCB_DEMOS": "1",
                    "GAME_LOOP_STOP_AFTER_GCB_DEMOS_TURN": "1",
                },
                clear=False,
            ):
                result = agent.run("write demo_outputs", workspace, tools=[], max_turns=5)

        self.assertEqual(result["turns"], 1)
        self.assertTrue(result["final_text"])

    def test_command_backend_terminate_process_group_permission_error_is_best_effort(self):
        from game_loop.backends import command as command_backend

        process = Mock()
        process.pid = 12345
        with patch.object(command_backend.os, "killpg", side_effect=PermissionError), \
             patch.object(process, "terminate") as terminate:
            command_backend._terminate_process_group(process)
        terminate.assert_called_once()

    def test_gdbench_zip_sanitization_and_binary_normalization(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            archive = root / "task_0042.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("tasks/task_0042/project.godot", "[application]\n")
                bundle.writestr("tasks/task_0042/scripts/main.gd", "extends Node\n")
                bundle.writestr("tasks/task_0042/scripts/test.gd", "print('VALIDATION_PASSED')\n")
                bundle.writestr("tasks/task_0042/scenes/test.tscn", "[gd_scene format=3]\n")
                bundle.writestr("tasks/task_0042/task_config.json", json.dumps({"instruction": "Fix it"}))
                bundle.writestr("tasks/task_0042/validation.md", "secret\n")
            gdroot = root / "gdbench"
            (gdroot / "gamedevbench" / "src").mkdir(parents=True)
            (gdroot / "gamedevbench" / "src" / "benchmark_runner.py").write_text("")
            adapter = GameDevBenchAdapter({"root": str(gdroot)})
            staged = root / "staged"
            adapter.stage_artifact(archive, staged)
            self.assertTrue((staged / "project.godot").exists())
            self.assertFalse((staged / "scripts" / "test.gd").exists())
            self.assertFalse((staged / "task_config.json").exists())
            self.assertTrue(adapter.validate(staged, GateConfig()).passed)

            result = root / "result.json"
            result.write_text(json.dumps({
                "validation": {"success": False, "message": "Projectile did not advance"},
                "solver": {"cost_usd": 0.12},
            }))
            evaluation = adapter.parse_evaluation(result)
            self.assertEqual(evaluation.primary_score, 0.0)
            self.assertFalse(evaluation.terminal_success)
            self.assertIn("Projectile", evaluation.diagnostics[0])

            result.write_text(json.dumps({
                "validation": {"success": False, "message": "Validation timed out"}
            }))
            self.assertFalse(adapter.parse_evaluation(result).feasible)

    def test_gdbench_prepare_keeps_hidden_tests_out_of_agent_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "task_0002"
            (source / "scripts").mkdir(parents=True)
            (source / "scenes").mkdir()
            (source / "project.godot").write_text("[application]\n")
            (source / "scripts" / "test.gd").write_text("print('VALIDATION_PASSED')\n")
            (source / "scenes" / "test.tscn").write_text("[gd_scene format=3]\n")
            (source / "task_config.json").write_text(json.dumps({"instruction": "Fix projectile"}))
            parent = root / "parent"
            parent.mkdir()
            (parent / "project.godot").write_text("[application]\n")
            adapter = GameDevBenchAdapter({"root": str(root / "gdbench")})
            candidate = root / "candidate"
            candidate.mkdir()
            from game_loop.core.models import AttemptContext
            prepared = adapter.prepare(
                task_source=source,
                parent_artifact=parent,
                feedback={
                    "facts": {},
                    "priority": {"intent": {"kind": "RepairConstraint"}},
                    "recent_attempts": [],
                    "agent_harness": {
                        "rendered_instruction": "Agent harness profile\n- verify changed path",
                    },
                },
                candidate_dir=candidate,
                context=AttemptContext("run", 1, 1),
            )
            native_task = prepared.root_dir
            self.assertFalse((native_task / "scripts" / "test.gd").exists())
            self.assertFalse((native_task / "scenes" / "test.tscn").exists())
            self.assertFalse((native_task / "task_config.json").exists())
            instruction = Path(prepared.command_context["instruction_file"]).read_text()
            self.assertIn("existing attempted solution", instruction)
            self.assertIn("Agent harness profile", instruction)
            self.assertNotIn("Current mutation intent", instruction)
            cleaned = root / "cleaned"
            adapter.stage_artifact(native_task, cleaned)
            self.assertFalse((cleaned / "scripts" / "test.gd").exists())

    def test_gcbench_opengame_bridge_golden_smoke(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            workspace = root / "workspace"
            (workspace / "game").mkdir(parents=True)
            instruction = root / "instruction.txt"
            instruction.write_text("Build the public game")
            manifest = root / "execution.json"
            breakdown = root / "verifier" / "breakdown.json"
            class FakeRunner:
                def run(self, request, *, isolation, environment, timeout_seconds):
                    game = isolation.workspace / "game"
                    (game / "demo_outputs").mkdir(parents=True, exist_ok=True)
                    (game / "project.godot").write_text("[application]\n")
                    (game / "demo_outputs" / "01.json").write_text(
                        json.dumps({"duration_frames": 1, "events": []})
                    )
                    return RunnerResult(0)

            runtime = OpenGameRuntime(OpenGameRuntimeConfig(), runner=FakeRunner())
            evaluator = [
                sys.executable,
                "-c",
                (
                    "from pathlib import Path; import json,sys; "
                    "a=Path(sys.argv[1]); assert (a/'demo_outputs'/'01.json').is_file(); "
                    "p=Path(sys.argv[2]); p.parent.mkdir(parents=True,exist_ok=True); "
                    "p.write_text(json.dumps(dict(reward=0.75,build_ok=True,requirements=[])))"
                ),
                "{artifact}",
                "{breakdown_path}",
            ]
            report = gcbench_bridge_doctor(
                workspace=workspace,
                instruction=instruction,
                evaluator_command=evaluator,
            )
            self.assertTrue(report["ok"])
            rc = run_gcbench_bridge(
                runtime=runtime,
                workspace=workspace,
                instruction=instruction,
                output_manifest=manifest,
                breakdown=breakdown,
                evaluator_command=evaluator,
            )
            self.assertEqual(rc, 0)
            artifact = Path(json.loads(manifest.read_text())["artifact_path"])
            self.assertTrue((artifact / "demo_outputs" / "01.json").is_file())
            self.assertEqual(json.loads(breakdown.read_text())["reward"], 0.75)

    def test_gdbench_opengame_bridge_is_single_solver_and_hides_tests(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            gdroot = root / "gdbench"
            package = gdroot / "gamedevbench" / "src"
            package.mkdir(parents=True)
            (gdroot / "gamedevbench" / "__init__.py").write_text("")
            (package / "__init__.py").write_text("")
            (package / "benchmark_runner.py").write_text(
                "from pathlib import Path\n"
                "class GodotBenchmarkRunner:\n"
                "  def __init__(self, use_gt, agent=None, **kwargs):\n"
                "    assert agent is None, 'a native solver was launched'\n"
                "    self.tasks_dir=Path('.')\n"
                "    self.results_dir=Path('.')\n"
                "  def run_benchmark(self, name):\n"
                "    p=self.tasks_dir/name\n"
                "    ok=(p/'scripts/test.gd').is_file() and (p/'scenes/test.tscn').is_file()\n"
                "    return dict(task_name=name,success=ok,message='passed' if ok else 'missing tests')\n"
            )
            source = root / "task_0001"
            (source / "scripts").mkdir(parents=True)
            (source / "scenes").mkdir()
            (source / "project.godot").write_text("[application]\n")
            (source / "scripts" / "test.gd").write_text("hidden")
            (source / "scenes" / "test.tscn").write_text("hidden")
            (source / "task_config.json").write_text(json.dumps({"instruction": "Public fix"}))
            parent = root / "parent"
            parent.mkdir()
            adapter = GameDevBenchAdapter({"root": str(gdroot)})
            candidate = root / "candidate"
            candidate.mkdir()
            from game_loop.core.models import AttemptContext
            prepared = adapter.prepare(
                task_source=source,
                parent_artifact=parent,
                feedback={},
                candidate_dir=candidate,
                context=AttemptContext("run", 1, 1),
            )
            with patch.dict("os.environ", {"GODOT_EXEC_PATH": sys.executable}):
                report = gdbench_bridge_doctor(
                    gdbench_root=gdroot,
                    agent_workspace=Path(prepared.command_context["agent_workspace"]),
                    private_task_source=Path(prepared.command_context["private_task_source"]),
                    instruction_file=Path(prepared.command_context["instruction_file"]),
                )
            self.assertTrue(report["ok"])
            class FakeRunner:
                def run(self, request, *, isolation, environment, timeout_seconds):
                    workspace = isolation.workspace
                    assert not (workspace / "scripts" / "test.gd").exists()
                    assert not (workspace / "scenes" / "test.tscn").exists()
                    assert not (workspace / "task_config.json").exists()
                    (workspace / "scripts").mkdir(exist_ok=True)
                    (workspace / "scripts" / "main.gd").write_text("extends Node\n")
                    return RunnerResult(0)

            runtime = OpenGameRuntime(OpenGameRuntimeConfig(), runner=FakeRunner())
            manifest = Path(prepared.command_context["output_manifest"])
            try:
                rc = run_gdbench_bridge(
                    runtime=runtime,
                    gdbench_root=gdroot,
                    agent_workspace=Path(prepared.command_context["agent_workspace"]),
                    private_task_source=Path(prepared.command_context["private_task_source"]),
                    task_name=prepared.command_context["task_name"],
                    instruction_file=Path(prepared.command_context["instruction_file"]),
                    output_manifest=manifest,
                )
            finally:
                for name in list(sys.modules):
                    if name == "gamedevbench" or name.startswith("gamedevbench."):
                        sys.modules.pop(name, None)
            self.assertEqual(rc, 0)
            payload = json.loads(manifest.read_text())
            retained = Path(payload["result_dir"])
            self.assertTrue((retained / "scripts" / "main.gd").is_file())
            self.assertFalse((retained / "scripts" / "test.gd").exists())
            self.assertFalse((retained / "task_config.json").exists())

    def test_gcbench_unified_inner_loop_pipeline_golden(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task_source = root / "private_task"
            (task_source / "workspace" / "game").mkdir(parents=True)
            (task_source / "instruction.md").write_text("Build a public arcade game")
            (task_source / "tests").mkdir()
            (task_source / "tests" / "rubric.json").write_text("SECRET_RUBRIC")
            parent = root / "parent"
            parent.mkdir()

            class FakeMaker:
                def run(self, request, *, isolation, environment, timeout_seconds):
                    visible = "\n".join(
                        path.read_text(errors="ignore")
                        for path in isolation.workspace.rglob("*")
                        if path.is_file()
                    )
                    assert "SECRET_RUBRIC" not in visible
                    game = isolation.workspace / "game"
                    (game / "demo_outputs").mkdir()
                    (game / "project.godot").write_text("[application]\n")
                    (game / "demo_outputs" / "01.json").write_text("{}")
                    return RunnerResult(0)

            class FakeEvaluator:
                def evaluate(self, *, adapter, prepared, task, submission, output_dir):
                    artifact = Path(submission.artifact_ref)
                    assert (artifact / "demo_outputs" / "01.json").is_file()
                    output_dir.mkdir(parents=True)
                    result = output_dir / "breakdown.json"
                    result.write_text(json.dumps({
                        "reward": 0.8,
                        "build_ok": True,
                        "requirements": [],
                    }))
                    return result

            result = InnerLoopPipeline(
                adapter=GameCraftBenchAdapter({}),
                runtime_config=OpenGameRuntimeConfig(),
                maker_runner=FakeMaker(),
                evaluator_runner=FakeEvaluator(),
            ).run(
                GameTask(
                    task_id="gcb-golden",
                    benchmark_id="gamecraftbench",
                    prompt="fallback",
                    task_source_ref=str(task_source),
                    workspace_seed_ref=str(parent),
                ),
                run_dir=root / "run",
            )
            self.assertEqual(result.submission.status, "completed")
            self.assertAlmostEqual(result.evaluation.primary_score, 0.8)

    def test_gdbench_unified_inner_loop_pipeline_golden(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            task_source = root / "task_0001"
            (task_source / "scripts").mkdir(parents=True)
            (task_source / "scenes").mkdir()
            (task_source / "project.godot").write_text("[application]\n")
            (task_source / "task_config.json").write_text(json.dumps({"instruction": "Fix jump"}))
            (task_source / "scripts" / "test.gd").write_text("SECRET_TEST")
            (task_source / "scenes" / "test.tscn").write_text("SECRET_SCENE")
            parent = root / "parent"
            parent.mkdir()

            class FakeMaker:
                def run(self, request, *, isolation, environment, timeout_seconds):
                    assert not (isolation.workspace / "task_config.json").exists()
                    assert not (isolation.workspace / "scripts" / "test.gd").exists()
                    (isolation.workspace / "scripts").mkdir(exist_ok=True)
                    (isolation.workspace / "scripts" / "main.gd").write_text("extends Node\n")
                    return RunnerResult(0)

            class FakeEvaluator:
                def evaluate(self, *, adapter, prepared, task, submission, output_dir):
                    artifact = Path(submission.artifact_ref)
                    assert not (artifact / "task_config.json").exists()
                    assert not (artifact / "scripts" / "test.gd").exists()
                    assert (Path(task.task_source_ref) / "scripts" / "test.gd").is_file()
                    output_dir.mkdir(parents=True)
                    result = output_dir / "result.json"
                    result.write_text(json.dumps({"success": True, "message": "passed"}))
                    return result

            result = InnerLoopPipeline(
                adapter=GameDevBenchAdapter({"root": str(root / "gdbench")}),
                runtime_config=OpenGameRuntimeConfig(),
                maker_runner=FakeMaker(),
                evaluator_runner=FakeEvaluator(),
            ).run(
                GameTask(
                    task_id="gdb-golden",
                    benchmark_id="gamedevbench",
                    prompt="fallback",
                    task_source_ref=str(task_source),
                    workspace_seed_ref=str(parent),
                ),
                run_dir=root / "run",
            )
            self.assertEqual(result.submission.status, "completed")
            self.assertTrue(result.evaluation.feasible)
            self.assertEqual(result.evaluation.primary_score, 1.0)

    def test_fallback_harness_proposal_avoids_recent_element_when_possible(self):
        from game_loop.cli import _fallback_harness_proposal

        selected = _fallback_harness_proposal(
            [
                {"id": "aaa_recent", "category": "skill"},
                {"id": "bbb_fresh", "category": "skill"},
            ],
            [{"element_id": "aaa_recent"}],
        )

        self.assertEqual(selected["element_id"], "bbb_fresh")
        self.assertEqual(selected["category"], "skill")

    def test_admission_case_archives_config_mismatched_resume_dir(self):
        from game_loop.cli import _run_harness_admission_case

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = write_config(root, candidates=1, level="L4", max_probe_calls=2)
            source_config = root / "config.json"
            engine = HarnessEvolutionEngine(root / "outer", config.method.harness_evolution)
            harness = engine.initialize()
            case_dir = root / "case" / "parent"
            case_dir.mkdir(parents=True)
            (case_dir / "manifest.json").write_text(json.dumps({
                "config_fingerprint": "old-fingerprint",
                "harness_frozen_within_episode": True,
                "budgets": {},
            }))
            (case_dir / "state.json").write_text(json.dumps({
                "status": "running",
                "champion_harness_id": harness.harness_id,
            }))
            task = root / "task"; task.mkdir()
            seed = root / "seed"; seed.mkdir()

            def fake_init(args):
                (case_dir / "manifest.json").write_text(json.dumps({
                    "config_fingerprint": config.fingerprint,
                    "harness_frozen_within_episode": True,
                    "budgets": {},
                }))
                (case_dir / "state.json").write_text(json.dumps({
                    "status": "completed",
                    "champion_harness_id": harness.harness_id,
                    "champion_evaluation": {"primary_score": 0.25, "feasible": True},
                    "model_calls": 1,
                    "evaluator_queries": 1,
                }))

            with patch("game_loop.cli.cmd_init", side_effect=fake_init), \
                    patch("game_loop.cli.cmd_evolve", return_value=None):
                outcome = _run_harness_admission_case(
                    case_id="case-1",
                    case_dir=case_dir,
                    harness=harness,
                    runner=Mock(),
                    outer_dir=root / "outer",
                    config=config,
                    source_config=source_config,
                    task_source=task,
                    seed_artifact=seed,
                    seed_score=0.0,
                    epoch=1,
                    run_id_prefix="t",
                )

            self.assertTrue((case_dir.parent / "parent.config-retry-1").is_dir())
            self.assertTrue(outcome.infrastructure_ok)
            self.assertEqual(outcome.final_score, 0.25)

    def test_admission_case_does_not_evolve_after_incomplete_init(self):
        from game_loop.cli import _run_harness_admission_case

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = write_config(root, candidates=1, level="L4", max_probe_calls=2)
            source_config = root / "config.json"
            engine = HarnessEvolutionEngine(root / "outer", config.method.harness_evolution)
            harness = engine.initialize()
            case_dir = root / "case" / "parent"
            task = root / "task"; task.mkdir()
            seed = root / "seed"; seed.mkdir()

            def fake_init(args):
                args.run_dir.mkdir(parents=True, exist_ok=True)
                (args.run_dir / "state.json").write_text(json.dumps({
                    "status": "running",
                    "champion_harness_id": harness.harness_id,
                    "champion_evaluation": {"primary_score": 0.0, "feasible": False},
                }))
                return 0

            with patch("game_loop.cli.cmd_init", side_effect=fake_init), \
                    patch("game_loop.cli.cmd_evolve") as evolve:
                outcome = _run_harness_admission_case(
                    case_id="case-1",
                    case_dir=case_dir,
                    harness=harness,
                    runner=Mock(),
                    outer_dir=root / "outer",
                    config=config,
                    source_config=source_config,
                    task_source=task,
                    seed_artifact=seed,
                    seed_score=0.0,
                    epoch=1,
                    run_id_prefix="t",
                )

            evolve.assert_not_called()
            self.assertFalse(outcome.infrastructure_ok)
            self.assertTrue((case_dir.parent / "parent.incomplete-retry-1").is_dir())

    def test_admission_case_archives_init_file_exists_failure(self):
        from game_loop.cli import _run_harness_admission_case

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = write_config(root, candidates=1, level="L4", max_probe_calls=2)
            source_config = root / "config.json"
            engine = HarnessEvolutionEngine(root / "outer", config.method.harness_evolution)
            harness = engine.initialize()
            case_dir = root / "case" / "parent"
            case_dir.mkdir(parents=True)
            (case_dir / "state.json").write_text(json.dumps({"status": "running"}))
            task = root / "task"; task.mkdir()
            seed = root / "seed"; seed.mkdir()

            with patch("game_loop.cli.cmd_init", side_effect=FileExistsError("not empty")), \
                    patch("game_loop.cli.cmd_evolve") as evolve:
                outcome = _run_harness_admission_case(
                    case_id="case-1",
                    case_dir=case_dir,
                    harness=harness,
                    runner=Mock(),
                    outer_dir=root / "outer",
                    config=config,
                    source_config=source_config,
                    task_source=task,
                    seed_artifact=seed,
                    seed_score=0.0,
                    epoch=1,
                    run_id_prefix="t",
                )

            evolve.assert_not_called()
            self.assertFalse(outcome.infrastructure_ok)
            self.assertTrue((case_dir.parent / "parent.incomplete-retry-1").is_dir())


if __name__ == "__main__":
    unittest.main()
