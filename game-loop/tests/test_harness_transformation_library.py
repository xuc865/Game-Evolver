from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from game_loop.core.harness_transformation_library import (
    HarnessTransformation,
    HarnessTransformationLibraryStore,
    TransformationStats,
    TransformationLibraryAction,
)
from game_loop.utils import atomic_write_json


class HarnessTransformationLibraryTests(unittest.TestCase):
    def test_default_library_shortlists_deep_studio_transformation(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize()

            shortlist = store.shortlist(
                ("single_agent", "gameplay_gap", "presentation_gap"), limit=2
            )

            self.assertEqual(shortlist[0], "single_to_studio")
            self.assertEqual(store.revision(), 0)

    def test_records_use_success_quality_cost_and_net_utility(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize()

            store.record_use(
                transformation_ids=("single_to_studio",),
                epoch=4,
                success=True,
                quality_delta=0.30,
                cost_penalty=0.08,
            )

            stats = store.stats()["single_to_studio"]
            self.assertEqual(stats.uses, 1)
            self.assertEqual(stats.successes, 1)
            self.assertAlmostEqual(stats.mean_quality_delta, 0.30)
            self.assertAlmostEqual(stats.mean_net_utility, 0.22)
            with self.assertRaisesRegex(ValueError, "already attributed"):
                store.record_use(
                    transformation_ids=("single_to_studio",),
                    epoch=4,
                    success=True,
                    quality_delta=0.30,
                    cost_penalty=0.08,
                )

    def test_applies_evidence_backed_add_modify_delete_transaction(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize()
            addition = HarnessTransformation(
                "add_audio_specialist",
                "Add audio specialist",
                "Add a bounded audio role after repeated feedback gaps.",
                ("audio_gap",),
                ("add_role", "add_edge"),
                {"shape": "audio_specialist"},
                ("audio", "specialist"),
            )

            record = store.apply_actions(
                epoch=7,
                actions=(
                    TransformationLibraryAction(
                        "add_audio",
                        "add",
                        "Three valid epochs lacked actionable audio feedback.",
                        ("rubric://5/audio", "rubric://6/audio"),
                        {"transformation": addition.to_dict()},
                    ),
                ),
            )

            self.assertEqual(record["revision_after"], 1)
            self.assertIn("add_audio_specialist", store.catalog())

    def test_rejects_unknown_transformation_operations(self):
        with self.assertRaisesRegex(ValueError, "unsupported operations"):
            HarnessTransformation(
                "bad",
                "Bad",
                "Invalid operation.",
                ("signal",),
                ("invent_magic",),
                {"shape": "bad"},
            )

    def test_recovers_catalog_and_stats_from_pending_transaction(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            store = HarnessTransformationLibraryStore(root)
            store.initialize()
            catalog = store.catalog()
            added = HarnessTransformation(
                "parallel_audio",
                "Parallel audio",
                "Explore independent audio treatments and integrate one result.",
                ("audio_gap",),
                ("split_role", "modify_policy"),
                {"shape": "parallel_fanout_fanin", "branches": 2},
            )
            catalog[added.transformation_id] = added
            stats = store.stats()
            stats[added.transformation_id] = TransformationStats()
            atomic_write_json(
                store.pending_path,
                {
                    "schema_version": "harness-transformation-pending.v1",
                    "epoch": 9,
                    "revision_before": 0,
                    "revision_after": 1,
                    "catalog": [item.to_dict() for item in catalog.values()],
                    "stats": {key: value.to_dict() for key, value in stats.items()},
                },
            )

            HarnessTransformationLibraryStore(root).initialize()

            recovered = HarnessTransformationLibraryStore(root)
            self.assertEqual(recovered.revision(), 1)
            self.assertIn("parallel_audio", recovered.catalog())
            self.assertIn("parallel_audio", recovered.stats())
            self.assertFalse(recovered.pending_path.exists())


if __name__ == "__main__":
    unittest.main()
