from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from game_loop.cli import _paired_admission_payload, _run_paired_harness_admission_case
from game_loop.config import HarnessEvolutionConfig
from game_loop.core.harness import (
    HarnessEpisodeOutcome,
    HarnessEvolutionEngine,
    load_episode_outcome,
)


class AdmissionInfrastructureGateTests(unittest.TestCase):
    def test_zero_scores_from_infrastructure_failure_are_not_a_paired_pass(self):
        parent = SimpleNamespace(harness_id="parent")
        candidate = SimpleNamespace(harness_id="candidate")
        paired = _paired_admission_payload(
            case_id="case-1",
            parent=parent,
            candidate=candidate,
            parent_outcome=HarnessEpisodeOutcome(
                "case-1", "parent", 0.0, False, 1, 1, infrastructure_ok=False
            ),
            candidate_outcome=HarnessEpisodeOutcome(
                "case-1", "candidate", 0.0, False, 1, 1, infrastructure_ok=False
            ),
            max_case_regression=0.08,
            created_at="fixed",
        )

        self.assertFalse(paired["infrastructure_ok"])
        self.assertFalse(paired["parent_infrastructure_ok"])
        self.assertFalse(paired["candidate_infrastructure_ok"])
        self.assertFalse(paired["passed"])
        self.assertIsNone(paired["delta"])
        self.assertIn("excluded from promotion", paired["reason"])

    def test_real_zero_scores_can_still_be_compared_when_infrastructure_is_healthy(self):
        parent = SimpleNamespace(harness_id="parent")
        candidate = SimpleNamespace(harness_id="candidate")
        paired = _paired_admission_payload(
            case_id="case-1",
            parent=parent,
            candidate=candidate,
            parent_outcome=HarnessEpisodeOutcome("case-1", "parent", 0.0, True, 1, 1),
            candidate_outcome=HarnessEpisodeOutcome(
                "case-1", "candidate", 0.0, True, 1, 1
            ),
            max_case_regression=0.08,
            created_at="fixed",
        )

        self.assertTrue(paired["infrastructure_ok"])
        self.assertTrue(paired["passed"])
        self.assertEqual(paired["delta"], 0.0)

    def test_score_regression_is_diagnostic_not_admission_failure(self):
        parent = SimpleNamespace(harness_id="parent")
        candidate = SimpleNamespace(harness_id="candidate")
        paired = _paired_admission_payload(
            case_id="case-1",
            parent=parent,
            candidate=candidate,
            parent_outcome=HarnessEpisodeOutcome("case-1", "parent", 1.0, True, 1, 1),
            candidate_outcome=HarnessEpisodeOutcome("case-1", "candidate", 0.2, True, 1, 1),
            max_case_regression=0.08,
            created_at="fixed",
        )

        self.assertTrue(paired["passed"])
        self.assertEqual(paired["delta"], -0.8)

    def test_persisted_evaluator_failure_marks_loaded_outcome_as_infrastructure(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            (run_dir / "state.json").write_text(
                json.dumps(
                    {
                        "status": "completed",
                        "champion_harness_id": "harness-a",
                        "champion_evaluation": {
                            "primary_score": 0.0,
                            "feasible": False,
                            "evaluator": {"infrastructure_failure": True},
                        },
                    }
                )
            )
            (run_dir / "manifest.json").write_text(
                json.dumps({"harness_frozen_within_episode": True, "budgets": {}})
            )

            outcome = load_episode_outcome(
                case_id="case-1", harness_id="harness-a", run_dir=run_dir
            )

            self.assertFalse(outcome.infrastructure_ok)
            self.assertEqual(outcome.final_score, 0.0)

    def test_latest_incomplete_maker_attempt_cannot_hide_behind_seed_champion(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td)
            (run_dir / "state.json").write_text(
                json.dumps(
                    {
                        "status": "completed",
                        "champion_harness_id": "harness-a",
                        "champion_evaluation": {
                            "primary_score": 0.4,
                            "feasible": True,
                            "evaluator": {"infrastructure_failure": False},
                        },
                        "attempts": [
                            {
                                "status": "infra_failed",
                                "reasons": ["agent circuit role timed out"],
                            }
                        ],
                    }
                )
            )
            (run_dir / "manifest.json").write_text(
                json.dumps({"harness_frozen_within_episode": True, "budgets": {}})
            )

            outcome = load_episode_outcome(
                case_id="case-1", harness_id="harness-a", run_dir=run_dir
            )

            self.assertFalse(outcome.infrastructure_ok)
            self.assertEqual(outcome.final_score, 0.4)

    def test_infrastructure_pair_is_excluded_and_cannot_promote(self):
        with tempfile.TemporaryDirectory() as td:
            engine = HarnessEvolutionEngine(
                Path(td),
                HarnessEvolutionConfig(modules=(), replay_min_cases=1),
            )
            parent = SimpleNamespace(harness_id="parent")
            candidate = SimpleNamespace(harness_id="candidate")
            result = engine.assess_epoch(
                epoch=1,
                parent=parent,
                candidate=candidate,
                parent_outcomes=[
                    HarnessEpisodeOutcome(
                        "case-1", "parent", 0.0, False, 1, 1,
                        infrastructure_ok=False,
                    )
                ],
                candidate_outcomes=[
                    HarnessEpisodeOutcome(
                        "case-1", "candidate", 0.0, False, 1, 1,
                        infrastructure_ok=False,
                    )
                ],
            )

            self.assertFalse(result.accepted)
            self.assertEqual(result.paired_deltas, ())
            self.assertEqual(len(result.excluded_pairs), 1)
            self.assertIn("infrastructure failure", result.excluded_pairs[0])
            self.assertTrue(any("usable replay pairs 0" in x for x in result.reasons))

    def test_parent_infrastructure_failure_skips_candidate_replay(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            engine = HarnessEvolutionEngine(
                root / "outer",
                HarnessEvolutionConfig(modules=(), replay_min_cases=1),
            )
            parent = SimpleNamespace(harness_id="parent")
            candidate = SimpleNamespace(harness_id="candidate")
            calls: list[Path] = []

            def fake_run_case(**kwargs):
                calls.append(kwargs["case_dir"])
                return HarnessEpisodeOutcome(
                    "case-1",
                    "parent",
                    None,
                    False,
                    1,
                    0,
                    infrastructure_ok=False,
                    run_ref=str(kwargs["case_dir"]),
                )

            case_dir = root / "case-1"
            with patch("game_loop.cli._run_harness_admission_case", side_effect=fake_run_case):
                result = _run_paired_harness_admission_case(
                    case_id="case-1",
                    case_dir=case_dir,
                    parent=parent,
                    candidate=candidate,
                    engine=engine,
                    runner=SimpleNamespace(),
                    outer_dir=root / "outer",
                    config=SimpleNamespace(fingerprint="fp"),
                    source_config=root / "config.json",
                    task_source=root / "task",
                    seed_artifact=root / "seed",
                    seed_score=0.0,
                    epoch=1,
                    run_id_prefix="t",
                )

            self.assertEqual(calls, [case_dir / "parent"])
            self.assertFalse(result["parent"].infrastructure_ok)
            self.assertFalse(result["candidate"].infrastructure_ok)
            paired = json.loads((case_dir / "paired_admission.json").read_text())
            self.assertFalse(paired["infrastructure_ok"])
            self.assertIsNone(paired["delta"])
            self.assertFalse(paired["passed"])
            self.assertEqual(paired["candidate_harness_id"], "candidate")

    def test_incomplete_existing_pair_is_archived_and_replayed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            engine = HarnessEvolutionEngine(
                root / "outer",
                HarnessEvolutionConfig(modules=(), replay_min_cases=1),
            )
            parent = SimpleNamespace(harness_id="parent")
            candidate = SimpleNamespace(harness_id="candidate")
            case_dir = root / "case-1"
            (case_dir / "parent").mkdir(parents=True)
            (case_dir / "paired_admission.json").write_text(json.dumps({
                "case_id": "case-1",
                "parent_harness_id": "parent",
                "candidate_harness_id": "candidate",
                "infrastructure_ok": False,
            }))
            calls: list[Path] = []

            def fake_run_case(**kwargs):
                calls.append(kwargs["case_dir"])
                return HarnessEpisodeOutcome(
                    "case-1",
                    kwargs["harness"].harness_id,
                    0.5,
                    True,
                    1,
                    1,
                    infrastructure_ok=True,
                    run_ref=str(kwargs["case_dir"]),
                )

            with patch("game_loop.cli._run_harness_admission_case", side_effect=fake_run_case):
                result = _run_paired_harness_admission_case(
                    case_id="case-1",
                    case_dir=case_dir,
                    parent=parent,
                    candidate=candidate,
                    engine=engine,
                    runner=SimpleNamespace(),
                    outer_dir=root / "outer",
                    config=SimpleNamespace(fingerprint="fp"),
                    source_config=root / "config.json",
                    task_source=root / "task",
                    seed_artifact=root / "seed",
                    seed_score=0.0,
                    epoch=1,
                    run_id_prefix="t",
                )

            self.assertTrue((root / "case-1.pair-retry-1").is_dir())
            self.assertEqual(calls, [case_dir / "parent", case_dir / "candidate"])
            self.assertTrue(result["parent"].infrastructure_ok)
            self.assertTrue(result["candidate"].infrastructure_ok)
            paired = json.loads((case_dir / "paired_admission.json").read_text())
            self.assertTrue(paired["infrastructure_ok"])


if __name__ == "__main__":
    unittest.main()
