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
    DeepPlaytestEvidence,
    HeuristicRubricJudge,
    HarnessRubricValidator,
    collect_deep_playtest_evidence,
    compare_rubric_pair,
    extract_json_object,
    sample_task_pool,
    TaskPoolEntry,
    LLMRubricJudge,
    RubricCaseScores,
    _gcbench_gameplay_replay_probe,
)
from game_loop.core.harness import HarnessEpochResult, HarnessProfile


def _write_godot_artifact(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "project.godot").write_text("[application]\nconfig/name=\"demo\"\n")
    scripts = root / "scripts"
    scripts.mkdir(exist_ok=True)
    (scripts / "main.gd").write_text("extends Node\nfunc _ready() -> void:\n\tpass\n")


class HarnessRubricValidatorTests(unittest.TestCase):
    def test_gcbench_replay_probe_reads_champion_attempt_logs(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td) / "run"
            artifact = run_dir / "artifacts" / "champion" / "artifact"
            demo_dir = artifact / "demo_outputs"
            demo_dir.mkdir(parents=True)
            (demo_dir / "demo.json").write_text(
                json.dumps({"events": [{"type": "key_down", "key": "W"}]})
            )
            attempt_dir = run_dir / "generation_001" / "candidate_01"
            log_dir = attempt_dir / "gcbench_verifier" / "demos" / "demo" / "logs"
            log_dir.mkdir(parents=True)
            (log_dir / "godot.log").write_text("Godot Engine finished normally\n")
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / "state.json").write_text(json.dumps({
                "champion_artifact_id": "champion",
                "attempts": [{
                    "artifact_id": "champion",
                    "candidate_dir": str(attempt_dir),
                }],
            }))

            result = _gcbench_gameplay_replay_probe(
                artifact=artifact,
                run_dir=run_dir,
            )

            self.assertTrue(result["passed"])
            self.assertIn("replay_runtime_logs=1", result["diagnostics"])

    def test_gcbench_replay_probe_requires_each_actionable_trace(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            artifact = root / "artifact"
            demos = artifact / "demo_outputs"
            demos.mkdir(parents=True)
            for name in ("one", "two"):
                (demos / f"{name}.json").write_text(json.dumps({
                    "events": [{"frame": 1, "type": "key_press", "keycode": "A"}],
                }))
            logs = root / "gcbench_verifier" / "demos" / "one" / "logs"
            logs.mkdir(parents=True)
            (logs / "godot.log").write_text("runtime ok\n")

            result = _gcbench_gameplay_replay_probe(artifact=artifact, run_dir=root)

            self.assertFalse(result["passed"])
            self.assertIn("missing_replay_traces=['two']", result["diagnostics"])

    def test_dynamic_hard_rubrics_do_not_collapse_on_replay_failure(self):
        evidence = DeepPlaytestEvidence(
            case_id="a",
            run_ref="/tmp",
            artifact_path="/tmp/artifact",
            benchmark_id="gcbench",
            task_source="/tmp/task",
            probes=(
                {
                    "probe_id": "deep_probe_0",
                    "command": ["python", "-m", "game_loop.probe_tools", "godot-playtest"],
                    "result": {"passed": True, "score": 1.0},
                },
                {
                    "probe_id": "deep_probe_1",
                    "command": ["official_gcbench_demo_replay_evidence"],
                    "result": {"passed": False, "score": 0.0},
                },
            ),
            file_inventory=("project.godot", "scripts/main.gd"),
        )
        hard = tuple(
            HarnessEvolutionConfig.from_dict({
                "modules": [{"id": "a", "instruction": "a", "tags": []}],
                "seed_modules": ["a"],
                "max_active_modules": 1,
                "max_active_tool_interfaces": 0,
                "mutation_width": 1,
                "hard_rubrics": [
                    {"rubric_id": "deep_runtime_legal", "kind": "hard"},
                    {"rubric_id": "public_spec_integrity", "kind": "hard"},
                    {"rubric_id": "harness_safe_workspace", "kind": "hard"},
                    {"rubric_id": "skill_application_valid", "kind": "hard"},
                ],
            }).hard_rubrics
        )

        scores = HeuristicRubricJudge().score(
            evidence=evidence,
            hard_rubrics=hard,
            soft_rubrics=DEFAULT_SOFT_RUBRICS,
        )

        self.assertEqual(scores.hard["deep_runtime_legal"], 0.0)
        self.assertEqual(scores.hard["public_spec_integrity"], 1.0)
        self.assertEqual(scores.hard["harness_safe_workspace"], 1.0)
        self.assertEqual(scores.hard["skill_application_valid"], 0.0)

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
    def test_llm_judge_malformed_responses_are_infrastructure_failure(self, urlopen_mock, resolve_mock):
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
        self.assertFalse(scores.infrastructure_ok)
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

    @patch("game_loop.runtime.providers.BackboneProviderSpec.resolve")
    @patch("urllib.request.urlopen")
    def test_llm_judge_uses_valid_reasoning_when_content_is_tokenized(
        self, urlopen_mock, resolve_mock
    ):
        resolved = unittest.mock.Mock()
        resolved.doctor.return_value = {"ready": True}
        resolved.model = "Kimi-K2.7-Code"
        resolved.base_url = "http://judge.local/v1"
        resolved.api_key = ""
        resolve_mock.return_value = resolved

        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "choices": [{"message": {
                        "content": ' {"{"}hard{" :{"}launches_without_crash{" :1},'
                                   '"soft":{"gameplay_responsiveness":1.0}}',
                        "reasoning": '{"hard":{"launches_without_crash":1},'
                                     '"soft":{"gameplay_responsiveness":1.0}}',
                    }}]
                }).encode("utf-8")

        urlopen_mock.return_value = _Response()
        scores = LLMRubricJudge(provider_id="deepseek").score(
            evidence=_synthetic_evidence(passed=True),
            hard_rubrics=DEFAULT_HARD_RUBRICS[:1],
            soft_rubrics=DEFAULT_SOFT_RUBRICS[:1],
        )
        self.assertTrue(scores.infrastructure_ok)
        self.assertEqual(scores.hard["launches_without_crash"], 1.0)
        self.assertEqual(scores.soft["gameplay_responsiveness"], 1.0)

    @patch("urllib.request.urlopen")
    @patch("game_loop.runtime.providers.BackboneProviderSpec.resolve")
    def test_llm_judge_disables_kimi_thinking_for_structured_output(
        self, resolve_mock, urlopen_mock
    ):
        resolved = unittest.mock.Mock()
        resolved.doctor.return_value = {"ready": True}
        resolved.model = "Kimi-K2.7-Code"
        resolved.base_url = "http://judge.local/v1"
        resolved.api_key = ""
        resolve_mock.return_value = resolved

        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "choices": [{"message": {"content": json.dumps({
                        "hard": {"launches_without_crash": 1},
                        "soft": {"gameplay_responsiveness": 1.0},
                    })}}]
                }).encode("utf-8")

        urlopen_mock.return_value = _Response()
        scores = LLMRubricJudge(provider_id="kimi").score(
            evidence=_synthetic_evidence(passed=True),
            hard_rubrics=DEFAULT_HARD_RUBRICS[:1],
            soft_rubrics=DEFAULT_SOFT_RUBRICS[:1],
        )
        request = urlopen_mock.call_args.args[0]
        request_payload = json.loads(request.data)
        self.assertEqual(
            request_payload["chat_template_kwargs"], {"enable_thinking": False}
        )
        self.assertTrue(scores.infrastructure_ok)

    @patch("urllib.request.urlopen")
    @patch("game_loop.runtime.providers.BackboneProviderSpec.resolve")
    def test_llm_judge_disables_deepseek_reasoning_for_structured_output(
        self, resolve_mock, urlopen_mock
    ):
        resolved = unittest.mock.Mock()
        resolved.doctor.return_value = {"ready": True}
        resolved.model = "deepseek-v4-flash"
        resolved.base_url = "https://judge.local/v1"
        resolved.api_key = "key"
        resolve_mock.return_value = resolved

        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "choices": [{"message": {"content": json.dumps({
                        "hard": {"launches_without_crash": 1},
                        "soft": {"gameplay_responsiveness": 1.0},
                    })}}]
                }).encode("utf-8")

        urlopen_mock.return_value = _Response()
        scores = LLMRubricJudge(provider_id="deepseek").score(
            evidence=_synthetic_evidence(passed=True),
            hard_rubrics=DEFAULT_HARD_RUBRICS[:1],
            soft_rubrics=DEFAULT_SOFT_RUBRICS[:1],
        )
        request_payload = json.loads(urlopen_mock.call_args.args[0].data)
        self.assertEqual(request_payload["reasoning_effort"], "none")
        self.assertTrue(scores.infrastructure_ok)

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

    def test_infrastructure_failure_stops_pair_comparison(self):
        parent = _score_artifact(passed=True)
        candidate = RubricCaseScores(
            case_id=parent.case_id,
            hard={},
            soft={},
            soft_total=0.0,
            judge="llm_deep_playtest_v1+heuristic_deep_playtest_v1",
            evidence_ref="/tmp/candidate",
            infrastructure_ok=False,
            errors=("judge failed",),
        )
        comparison = compare_rubric_pair(
            case_id="a",
            parent=parent,
            candidate=candidate,
            hard_rubrics=DEFAULT_HARD_RUBRICS,
            soft_rubrics=DEFAULT_SOFT_RUBRICS,
        )
        self.assertEqual(len(comparison.reasons), 1)
        self.assertIn("infrastructure failure", comparison.reasons[0])

    def test_missing_or_infrastructure_case_marks_validation_as_infrastructure(self):
        validator = HarnessRubricValidator(
            HarnessEvolutionConfig(
                modules=(),
                require_rubric_validation=True,
                rubric_validation_sample_size=1,
            ),
            judge=unittest.mock.Mock(),
        )
        parent = HarnessEpisodeOutcome(
            "case-1", "parent", None, False, 0, 0,
            infrastructure_ok=False,
            run_ref="",
        )
        candidate = HarnessEpisodeOutcome(
            "case-1", "candidate", None, False, 0, 0,
            infrastructure_ok=False,
            run_ref="",
        )

        result = validator.validate_paired_outcomes(
            parent_outcomes=[parent],
            candidate_outcomes=[candidate],
        )

        self.assertFalse(result.accepted)
        self.assertFalse(result.infrastructure_ok)
        self.assertIn("missing run_ref", " ".join(result.reasons))

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

    def test_epoch_anchor_covers_each_pool_task_once(self):
        pool = tuple(TaskPoolEntry(f"t{index}", f"s{index}") for index in range(5))
        anchors = [
            sample_task_pool(
                pool,
                sample_size=3,
                seed=epoch,
                prefix=f"e{epoch:03d}",
                anchor_index=epoch - 1,
            )[0].task_ref
            for epoch in range(1, len(pool) + 1)
        ]
        self.assertEqual(anchors, [item.task_ref for item in pool])

    @patch("game_loop.runtime.providers.BackboneProviderSpec.resolve")
    @patch("urllib.request.urlopen")
    def test_llm_judge_rejects_missing_rubric_keys(self, urlopen_mock, resolve_mock):
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
                return json.dumps({
                    "choices": [{"message": {"content": json.dumps({
                        "hard": {},
                        "soft": {},
                    })}}]
                }).encode("utf-8")

        urlopen_mock.side_effect = [_Response(), _Response(), _Response()]
        scores = LLMRubricJudge(provider_id="deepseek").score(
            evidence=_synthetic_evidence(passed=True),
            hard_rubrics=DEFAULT_HARD_RUBRICS[:1],
            soft_rubrics=DEFAULT_SOFT_RUBRICS[:1],
        )
        self.assertFalse(scores.infrastructure_ok)
        self.assertIn("keys mismatch", scores.errors[0])

    def test_gcbench_deep_probe_requires_input_replay_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            artifact = root / "artifact"
            artifact.mkdir()
            demo_dir = artifact / "demo_outputs"
            demo_dir.mkdir()
            (demo_dir / "gameplay.json").write_text(
                json.dumps({"duration_frames": 120, "events": [{"frame": 10, "type": "key_press"}]}),
                encoding="utf-8",
            )
            logs = root / "gcbench_verifier" / "demos" / "gameplay" / "logs"
            logs.mkdir(parents=True)
            (logs / "godot.log").write_text("game started\nstate=playing\n", encoding="utf-8")
            result = _gcbench_gameplay_replay_probe(artifact=artifact, run_dir=root)
            self.assertTrue(result["passed"])
            self.assertIn("input_events=1", result["diagnostics"])

            (logs / "fatal.log").write_text("SCRIPT ERROR: fatal\n", encoding="utf-8")
            failed = _gcbench_gameplay_replay_probe(artifact=artifact, run_dir=root)
            self.assertFalse(failed["passed"])

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
