from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from game_loop.core.agent_circuit import AgentCircuit
from game_loop.core.agent_circuit_attribution import CircuitAblationQueue
from game_loop.core.agent_circuit_evolution import (
    CircuitMutationAction,
    CircuitMutationTransaction,
)
from game_loop.utils import read_json


def transaction() -> CircuitMutationTransaction:
    parent = AgentCircuit.singleton()
    return CircuitMutationTransaction(
        parent_circuit_id=parent.circuit_id,
        hypothesis="Test a coupled topology bundle.",
        evidence_refs=("trace://one",),
        transformation_ids=("single_to_studio",),
        actions=(
            CircuitMutationAction(
                "structural_change",
                "modify_policy",
                "Change the execution shape.",
                {"replacement": parent.policy.to_dict()},
            ),
            CircuitMutationAction(
                "dependent_budget",
                "modify_policy",
                "Fund the changed shape.",
                {"replacement": parent.policy.to_dict()},
                depends_on=("structural_change",),
            ),
        ),
    )


class CircuitAblationQueueTests(unittest.TestCase):
    def test_infrastructure_failure_does_not_advance_queue(self):
        with tempfile.TemporaryDirectory() as td:
            queue = CircuitAblationQueue(Path(td) / "queue.json")
            queue.schedule(
                epoch=1,
                source_parent_harness_id="base",
                accepted_harness_id="full",
                transaction=transaction(),
            )
            trial = queue.next_trial(champion_harness_id="full")
            self.assertIsNotNone(trial)
            queue.record_trial(
                epoch=2,
                trial=trial,  # type: ignore[arg-type]
                infrastructure_ok=False,
                accepted=False,
                candidate_harness_id="base",
                quality_delta=None,
                cost_penalty=None,
                net_utility=None,
                reasons=("runtime failed",),
            )

            repeated = queue.next_trial(champion_harness_id="full")
            self.assertEqual(repeated.action_id, "structural_change")  # type: ignore[union-attr]
            self.assertEqual(queue.pending_count(), 2)

    def test_accepted_dependency_root_removes_its_closure(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "queue.json"
            queue = CircuitAblationQueue(path)
            queue.schedule(
                epoch=1,
                source_parent_harness_id="base",
                accepted_harness_id="full",
                transaction=transaction(),
            )
            trial = queue.next_trial(champion_harness_id="full")
            self.assertEqual(trial.retained_action_ids, ())  # type: ignore[union-attr]
            self.assertIsNone(trial.candidate_transaction)  # type: ignore[union-attr]
            queue.record_trial(
                epoch=2,
                trial=trial,  # type: ignore[arg-type]
                infrastructure_ok=True,
                accepted=True,
                candidate_harness_id="base",
                quality_delta=0.0,
                cost_penalty=-0.1,
                net_utility=0.1,
                reasons=(),
            )

            self.assertEqual(queue.pending_count(), 0)
            state = read_json(path)
            decisions = state["completed"][0]["decisions"]
            self.assertEqual(len(decisions), 2)
            self.assertEqual(
                decisions[1]["removed_by_dependency"], "structural_change"
            )

    def test_rejected_ablation_advances_to_next_action_without_champion_drift(self):
        with tempfile.TemporaryDirectory() as td:
            queue = CircuitAblationQueue(Path(td) / "queue.json")
            queue.schedule(
                epoch=1,
                source_parent_harness_id="base",
                accepted_harness_id="full",
                transaction=transaction(),
            )
            first = queue.next_trial(champion_harness_id="full")
            queue.record_trial(
                epoch=2,
                trial=first,  # type: ignore[arg-type]
                infrastructure_ok=True,
                accepted=False,
                candidate_harness_id="base",
                quality_delta=-0.2,
                cost_penalty=-0.1,
                net_utility=-0.1,
                reasons=("quality regressed",),
            )

            second = queue.next_trial(champion_harness_id="full")
            self.assertEqual(second.action_id, "dependent_budget")  # type: ignore[union-attr]
            self.assertEqual(
                second.retained_action_ids, ("structural_change",)
            )  # type: ignore[union-attr]


if __name__ == "__main__":
    unittest.main()
