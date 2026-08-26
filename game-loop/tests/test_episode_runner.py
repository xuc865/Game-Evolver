import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from game_loop.core.episode_runner import run_frozen_harness_episode
from game_loop.core.harness import HarnessProfile


class EpisodeRunnerResumeTests(unittest.TestCase):
    def test_reuses_matching_completed_frozen_episode(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            case_dir = root / "inner_parent" / "inner-01"
            case_dir.mkdir(parents=True)
            harness = HarnessProfile.from_dict({"harness_id": "harness-parent"})
            (case_dir.parent / "inner-01.harness_profile.json").write_text(
                json.dumps(harness.to_dict()), encoding="utf-8"
            )
            (case_dir / "state.json").write_text(json.dumps({
                "status": "completed",
                "champion_harness_id": harness.harness_id,
                "champion_evaluation": {
                    "primary_score": 0.5,
                    "feasible": True,
                    "evaluator": {},
                },
                "model_calls": 1,
                "evaluator_queries": 1,
            }), encoding="utf-8")
            (case_dir / "manifest.json").write_text(json.dumps({
                "harness_frozen_within_episode": True,
                "budgets": {"model_calls": 3, "evaluator_queries": 3},
            }), encoding="utf-8")

            with mock.patch(
                "game_loop.core.episode_runner._episode_config_dict",
                side_effect=AssertionError("completed episode should be reused"),
            ):
                outcome = run_frozen_harness_episode(
                    case_id="inner-01",
                    case_dir=case_dir,
                    harness=harness,
                    config=mock.Mock(),
                    task_source=root / "task",
                    seed_artifact=root / "seed",
                    seed_score=0.0,
                    epoch=5,
                    run_id_prefix="ax-p-",
                    init_handler=mock.Mock(),
                    evolve_handler=mock.Mock(),
                )

            self.assertTrue(outcome.infrastructure_ok)
            self.assertEqual(outcome.final_score, 0.5)
            self.assertEqual(outcome.harness_id, harness.harness_id)


if __name__ == "__main__":
    unittest.main()
