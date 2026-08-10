from __future__ import annotations

import unittest

from game_loop.core.agentx_runtime import (
    AttributionDrivenInnerGradientProposer,
    InnerOutcomeOuterGradientProposer,
)
from game_loop.core.attribution import AttributionReport
from game_loop.core.harness import HarnessEpochResult, HarnessProfile


def _profile(prefix: str) -> HarnessProfile:
    return HarnessProfile.from_dict({"harness_id": f"{prefix}-seed"})


class AgentXRuntimeTests(unittest.TestCase):
    def test_inner_gradient_targets_probe_failures(self):
        proposer = AttributionDrivenInnerGradientProposer()
        gradient = proposer.propose_inner(
            AttributionReport(("trace://one",), {"probe_failed": 3}, (), 0),
            proposer_harness=_profile("outer"),
            target_harness=_profile("inner"),
        )
        self.assertIn("skill", gradient.target_tags)
        self.assertIn("usage_driven", gradient.target_tags)

    def test_outer_gradient_reacts_to_rejected_inner_epoch(self):
        proposer = InnerOutcomeOuterGradientProposer()
        gradient = proposer.propose_outer(
            AttributionReport(("trace://one",), {}, (), 0),
            latest_inner_result=HarnessEpochResult(
                epoch=1,
                parent_harness_id="p",
                candidate_harness_id="c",
                accepted=False,
                paired_deltas=(-0.1,),
                median_delta=-0.1,
                reasons=("replay_rejected",),
                excluded_pairs=(),
                parent_outcomes=(),
                candidate_outcomes=(),
                created_at="2026-01-01T00:00:00Z",
            ),
            proposer_harness=_profile("outer"),
        )
        self.assertIn("context", gradient.target_tags)
        self.assertIn("usage_driven", gradient.target_tags)


if __name__ == "__main__":
    unittest.main()
