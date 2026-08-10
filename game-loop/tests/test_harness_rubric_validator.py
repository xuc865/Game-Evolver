from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from game_loop.config import DEFAULT_HARD_RUBRICS, DEFAULT_SOFT_RUBRICS, HarnessEvolutionConfig
from game_loop.core.harness import HarnessEpisodeOutcome
from game_loop.core.harness_evolution_memory import HarnessEvolutionMemory, build_rejection_experience
from game_loop.core.harness_rubric_validator import (
    HeuristicRubricJudge,
    HarnessRubricValidator,
    collect_deep_playtest_evidence,
    compare_rubric_pair,
    extract_json_object,
    sample_task_pool,
    TaskPoolEntry,
    LLMRubricJudge,
)
from game_loop.core.harness import HarnessEpochResult, HarnessProfile


def _write_godot_artifact(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "project.godot").write_text("[application]\nconfig/name=\"demo\"\n")
    scripts = root / "scripts"
    scripts.mkdir(exist_ok=True)
    (scripts / "main.gd").write_text("extends Node\nfunc _ready() -> void:\n\tpass\n")


class HarnessRubricValidatorTests(unittest.TestCase):
    @patch("game_loop.runtime.providers.BackboneProviderSpec.resolve")
    def test_llm_judge_outage_is_infrastructure_not_heuristic_score(self, resolve_mock):
        resolved = unittest.mock.Mock()
        resolved.doctor.return_value = {"ready": False}
        resolve_mock.return_value = resolved
        scores = LLMRubricJudge(provider_id="deepseek").score(
            evidence=_synthetic_evidence(passed=True),
            hard_rubrics=DEFAULT_HARD_RUBRICS,
            soft_rubrics=DEFAULT_SOFT_RUBRICS,
        )
        self.assertFalse(scores.infrastructure_ok)
        self.assertEqual(scores.hard, {})
        self.assertTrue(scores.errors)

    @patch("game_loop.runtime.providers.BackboneProviderSpec.resolve")
    @patch("urllib.request.urlopen")
    def test_llm_judge_retries_and_extracts_json_from_text(self, urlopen_mock, resolve_mock):
        resolved = unittest.mock.Mock()
        resolved.doctor.return_value = {"ready": True}
        resolved.model = "judge-model"
        resolved.base_url = "http://judge.local/v1"
        resolved.api_key = ""
        resolve_mock.return_value = resolved

        class _Response:
            def __init__(self, payload: dict[str, object]):
                self.payload = payload

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(self.payload).encode("utf-8")

        urlopen_mock.side_effect = [
            _Response({"choices": [{"message": {"content": ""}}]}),
            _Response({"choices": [{"message": {"content": "{\"hard\":0,\"soft\":0}"}}]}),
            _Response({"choices": [{"message": {"content": "```json\n{\"hard\":{\"launches_without_crash\":1},\"soft\":{\"gameplay_responsiveness\":0.75}}\n```"}}]}),
        ]
        scores = LLMRubricJudge(provider_id="deepseek").score(
            evidence=_synthetic_evidence(passed=True),
            hard_rubrics=DEFAULT_HARD_RUBRICS[:1],
            soft_rubrics=DEFAULT_SOFT_RUBRICS[:1],
        )
        self.assertTrue(scores.infrastructure_ok)
        self.assertEqual(scores.hard["launches_without_crash"], 1.0)
        self.assertEqual(scores.soft["gameplay_responsiveness"], 0.75)
        self.assertEqual(urlopen_mock.call_count, 3)

    @patch("game_loop.runtime.providers.BackboneProviderSpec.resolve")
    @patch("urllib.request.urlopen")
    def test_llm_judge_falls_back_to_heuristic_after_empty_responses(self, urlopen_mock, resolve_mock):
        resolved = unittest.mock.Mock()
        resolved.doctor.return_value = {"ready": True}
        resolved.model = "judge-model"
        resolved.base_url = "http://judge.local/v1"
        resolved.api_key = ""
        resolve_mock.return_value = resolved

        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({"choices": [{"message": {"content": ""}}]}).encode("utf-8")

        urlopen_mock.side_effect = [_Response(), _Response(), _Response()]
        scores = LLMRubricJudge(provider_id="deepseek").score(
            evidence=_synthetic_evidence(passed=True),
            hard_rubrics=DEFAULT_HARD_RUBRICS[:1],
            soft_rubrics=DEFAULT_SOFT_RUBRICS[:1],
        )
        self.assertTrue(scores.infrastructure_ok)
        self.assertIn("heuristic", scores.judge)
        self.assertEqual(scores.hard["launches_without_crash"], 1.0)
        self.assertTrue(scores.errors)

    def test_extract_json_object_skips_malformed_prefix_object(self):
        payload = extract_json_object(
            'draft: {"hard": {"launches_without_crash": 1} '
            'final: {"hard": {"launches_without_crash": 1}, '
            '"soft": {"gameplay_responsiveness": 0.8}}'
        )
        self.assertEqual(payload["hard"]["launches_without_crash"], 1)
        self.assertEqual(payload["soft"]["gameplay_responsiveness"], 0.8)

    def test_hard_and_soft_pair_comparison_enforces_monotonicity(self):
        parent = _score_artifact(passed=True)
        candidate = _score_artifact(passed=True, richer=True)
        comparison = compare_rubric_pair(
            case_id="a",
            parent=parent,
            candidate=candidate,
            hard_rubrics=DEFAULT_HARD_RUBRICS,
            soft_rubrics=DEFAULT_SOFT_RUBRICS,
        )
        self.assertTrue(comparison.passed)
        self.assertGreaterEqual(candidate.soft_total, parent.soft_total)

    def test_rejects_hard_regression(self):
        parent = _score_artifact(passed=True)
        candidate = _score_artifact(passed=False)
        comparison = compare_rubric_pair(
            case_id="a",
            parent=parent,
            candidate=candidate,
            hard_rubrics=DEFAULT_HARD_RUBRICS,
            soft_rubrics=DEFAULT_SOFT_RUBRICS,
        )
        self.assertFalse(comparison.passed)
        self.assertTrue(any("hard rubric" in reason for reason in comparison.reasons))

    @patch("game_loop.core.harness_rubric_validator.collect_deep_playtest_evidence")
    def test_validator_integrated_with_assess_epoch(self, collect_mock):
        def side_effect(*, case_id, run_dir):
            richer = "richer" in str(run_dir)
            return _synthetic_evidence(passed=True, richer=richer)

        collect_mock.side_effect = side_effect
        config = HarnessEvolutionConfig.from_dict({
            "modules": [
                {"id": "a", "instruction": "a", "tags": []},
                {"id": "b", "instruction": "b", "tags": []},
            ],
            "seed_modules": ["a"],
            "max_active_modules": 2,
            "max_active_tool_interfaces": 0,
            "mutation_width": 1,
            "replay_min_cases": 1,
            "rubric_validation_sample_size": 1,
            "require_rubric_validation": True,
        })
        validator = HarnessRubricValidator(config, judge=HeuristicRubricJudge())
        parent_outcome = HarnessEpisodeOutcome(
            "case-a", "parent", 0.5, True, 1, 1, run_ref="/tmp/parent"
        )
        candidate_outcome = HarnessEpisodeOutcome(
            "case-a",
            "candidate",
            0.6,
            True,
            1,
            1,
            run_ref="/tmp/candidate/richer",
        )
        rubric = validator.validate_paired_outcomes(
            parent_outcomes=[parent_outcome],
            candidate_outcomes=[candidate_outcome],
        )
        self.assertTrue(rubric.accepted)

    def test_task_pool_sampling_is_deterministic(self):
        pool = (
            TaskPoolEntry("t1", "s1"),
            TaskPoolEntry("t2", "s2"),
            TaskPoolEntry("t3", "s3"),
            TaskPoolEntry("t4", "s4"),
        )
        first = sample_task_pool(pool, sample_size=3, seed=7, prefix="inner")
        second = sample_task_pool(pool, sample_size=3, seed=7, prefix="inner")
        self.assertEqual(first, second)
        self.assertEqual(len(first), 3)

    def test_rejection_memory_is_reused_in_proposer_context(self):
        with tempfile.TemporaryDirectory() as td:
            memory = HarnessEvolutionMemory(Path(td))
            profile = HarnessProfile(
                harness_id="h1",
                parent_harness_id=None,
                active_modules=("a",),
                active_tool_interfaces=(),
                active_elements=(),
                context_compiler=__import__(
                    "game_loop.core.harness", fromlist=["ContextCompilerPolicy"]
                ).ContextCompilerPolicy(),
                recovery_policy=__import__(
                    "game_loop.core.harness", fromlist=["RecoveryPolicy"]
                ).RecoveryPolicy(),
                validation_policy=__import__(
                    "game_loop.core.harness", fromlist=["ValidationPolicy"]
                ).ValidationPolicy(),
                generation=1,
                rationale="test",
                created_at="now",
            )
            epoch_result = HarnessEpochResult(
                epoch=1,
                parent_harness_id="p",
                candidate_harness_id="c",
                accepted=False,
                paired_deltas=(-0.1,),
                median_delta=-0.1,
                reasons=("hard rubric regressed",),
                excluded_pairs=(),
                parent_outcomes=(),
                candidate_outcomes=(),
                created_at="now",
                rubric_validation={"accepted": False, "reasons": ["hard rubric regressed"]},
            )
            memory.append(
                build_rejection_experience(
                    epoch=1,
                    loop_role="inner",
                    parent=profile,
                    candidate=profile,
                    epoch_result=epoch_result,
                    rubric_validation=epoch_result.rubric_validation,
                )
            )
            rendered = memory.render_proposer_context(loop_role="inner")
            self.assertIn("hard rubric", rendered)


def _score_artifact(*, passed: bool, richer: bool = False):
    return HeuristicRubricJudge().score(
        evidence=_synthetic_evidence(passed=passed, richer=richer),
        hard_rubrics=DEFAULT_HARD_RUBRICS,
        soft_rubrics=DEFAULT_SOFT_RUBRICS,
    )


def _synthetic_evidence(*, passed: bool, richer: bool = False):
    from game_loop.core.harness_rubric_validator import DeepPlaytestEvidence

    inventory = tuple(f"scripts/extra_{index}.gd" for index in range(8 if richer else 2))
    probes = (
        {
            "probe_id": "deep_probe_0",
            "result": {"passed": passed, "score": 1.0 if passed else 0.0},
        },
    )
    return DeepPlaytestEvidence(
        case_id="a",
        run_ref="/tmp/run",
        artifact_path="/tmp/artifact",
        benchmark_id="gdbench",
        task_source="/tmp/task",
        probes=probes,
        file_inventory=inventory if passed else (),
        instruction_excerpt="make a game",
    )


def _make_run_dir_with_artifact(*, passed: bool, richer: bool = False) -> Path:
    td = tempfile.mkdtemp()
    root = Path(td)
    artifact = root / "artifacts" / "seed" / "artifact"
    _write_godot_artifact(artifact)
    if richer:
        for index in range(8):
            (artifact / "scripts" / f"extra_{index}.gd").write_text("extends Node\n")
    (root / "state.json").write_text(
        json.dumps({"champion_artifact_id": "seed", "status": "loop_ready_for_benchmark"})
    )
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "benchmark_id": "gdbench",
                "task_source": str(root / "task"),
            }
        )
    )
    if not passed:
        (artifact / "project.godot").unlink()
    return root


if __name__ == "__main__":
    unittest.main()
