from __future__ import annotations

import unittest

from game_loop.core.agent_circuit import (
    AgentBudget,
    AgentCircuit,
    AgentRole,
    CircuitEdge,
    CircuitPolicy,
)


def role(role_id: str, kind: str = "specialist") -> AgentRole:
    return AgentRole(
        role_id=role_id,
        name=role_id.replace("_", " ").title(),
        kind=kind,
        objective=f"Own {role_id} work.",
        system_prompt=f"Complete and verify the {role_id} assignment.",
    )


class AgentCircuitTests(unittest.TestCase):
    def test_singleton_round_trip_is_content_addressed(self):
        circuit = AgentCircuit.singleton(capabilities=("godot", "verify"))

        restored = AgentCircuit.from_dict(circuit.to_dict())

        self.assertEqual(restored, circuit)
        self.assertEqual(restored.circuit_id, circuit.circuit_id)
        self.assertTrue(circuit.circuit_id.startswith("circuit-"))

    def test_studio_dag_supports_parallel_specialists_and_integrator(self):
        circuit = AgentCircuit(
            roles=(
                role("director", "director"),
                role("gameplay"),
                role("visuals"),
                role("integrator", "integrator"),
                role("playtester", "critic"),
            ),
            edges=(
                CircuitEdge("brief_gameplay", "director", "gameplay", "delegation", "Implement mechanics."),
                CircuitEdge("brief_visuals", "director", "visuals", "delegation", "Implement presentation."),
                CircuitEdge("gameplay_patch", "gameplay", "integrator", "artifact", "Merge gameplay patch.", ("patch",)),
                CircuitEdge("visual_patch", "visuals", "integrator", "artifact", "Merge visual patch.", ("patch",)),
                CircuitEdge("build_review", "integrator", "playtester", "review", "Deep-play the merged build.", ("game",)),
                CircuitEdge("review_fix", "playtester", "integrator", "feedback", "Apply evidence-backed fixes.", ("review",), max_traversals=2),
            ),
            entry_role_ids=("director",),
            terminal_role_ids=("playtester",),
            policy=CircuitPolicy(
                max_parallel_roles=2,
                max_total_model_calls=8,
                max_total_cost_units=8,
            ),
        )

        self.assertEqual(len(circuit.roles), 5)
        self.assertEqual(circuit.policy.max_parallel_roles, 2)
        self.assertEqual(AgentCircuit.from_dict(circuit.to_dict()), circuit)

    def test_rejects_unbounded_or_non_ancestral_feedback(self):
        with self.assertRaisesRegex(ValueError, "within 1..3"):
            CircuitEdge(
                "feedback", "critic", "maker", "feedback", "Retry.", max_traversals=4
            )

        with self.assertRaisesRegex(ValueError, "ancestor"):
            AgentCircuit(
                roles=(role("director"), role("maker"), role("critic")),
                edges=(
                    CircuitEdge("make", "director", "maker", "delegation", "Build."),
                    CircuitEdge("review", "maker", "critic", "review", "Review."),
                    CircuitEdge("bad_feedback", "maker", "critic", "feedback", "Wrong direction."),
                ),
                entry_role_ids=("director",),
                terminal_role_ids=("critic",),
                policy=CircuitPolicy(max_total_model_calls=3, max_total_cost_units=3),
            )

    def test_rejects_cycles_outside_bounded_feedback_edges(self):
        with self.assertRaisesRegex(ValueError, "must form a DAG"):
            AgentCircuit(
                roles=(role("left"), role("right")),
                edges=(
                    CircuitEdge("left_right", "left", "right", "control", "Go right."),
                    CircuitEdge("right_left", "right", "left", "control", "Go left."),
                ),
                entry_role_ids=("left",),
                terminal_role_ids=("right",),
                policy=CircuitPolicy(max_total_model_calls=2, max_total_cost_units=2),
            )

    def test_rejects_role_budgets_above_circuit_total(self):
        expensive = AgentRole(
            role_id="maker",
            name="Maker",
            kind="operator",
            objective="Build.",
            system_prompt="Build and verify.",
            budget=AgentBudget(max_model_calls=3, cost_units=4),
        )
        with self.assertRaisesRegex(ValueError, "model-call budgets exceed"):
            AgentCircuit(
                roles=(expensive,),
                edges=(),
                entry_role_ids=("maker",),
                terminal_role_ids=("maker",),
                policy=CircuitPolicy(max_total_model_calls=2, max_total_cost_units=5),
            )

    def test_rejects_unimplemented_failure_strategy(self):
        with self.assertRaisesRegex(ValueError, "unsupported circuit failure mode"):
            CircuitPolicy(failure_mode="degrade_to_single_agent")

    def test_hash_rejects_tampering(self):
        payload = AgentCircuit.singleton().to_dict()
        payload["roles"][0]["objective"] = "Tampered objective"

        with self.assertRaisesRegex(ValueError, "content hash mismatch"):
            AgentCircuit.from_dict(payload)

    def test_role_and_edge_semantics_are_open_but_feedback_protocol_is_bounded(self):
        scout = role("scout", "novelty_scout")
        maker = role("maker", "mechanic_composer")
        verifier = role("verifier", "embodied_play_judge")
        circuit = AgentCircuit(
            roles=(scout, maker, verifier),
            edges=(
                CircuitEdge(
                    "ideas",
                    "scout",
                    "maker",
                    "design_seed",
                    "Turn evidence into one mechanic hypothesis.",
                ),
                CircuitEdge(
                    "trial",
                    "maker",
                    "verifier",
                    "playable_trial",
                    "Exercise the built mechanic.",
                ),
                CircuitEdge(
                    "repair",
                    "verifier",
                    "maker",
                    "evidence_backpropagation",
                    "Repair only observed failures.",
                    protocol="feedback",
                    max_traversals=2,
                ),
            ),
            entry_role_ids=("scout",),
            terminal_role_ids=("verifier",),
            policy=CircuitPolicy(
                max_total_model_calls=5,
                max_total_cost_units=5,
            ),
        )

        restored = AgentCircuit.from_dict(circuit.to_dict())

        self.assertEqual(restored, circuit)
        self.assertTrue(next(edge for edge in circuit.edges if edge.edge_id == "repair").is_feedback)
        self.assertEqual(verifier.effective_output_artifact_kinds, ("artifact",))

    def test_open_artifact_kind_can_publish_a_workspace_without_reserved_name(self):
        role = AgentRole(
            role_id="publisher",
            name="Publisher",
            kind="release_materializer",
            objective="Publish the verified artifact.",
            system_prompt="Verify and publish the workspace.",
            output_artifact_kinds=("verified_artifact",),
            output_artifact_modes={"verified_artifact": "workspace"},
        )

        restored = AgentRole.from_dict(role.to_dict())

        self.assertEqual(restored, role)
        self.assertEqual(role.output_artifact_mode("verified_artifact"), "workspace")


if __name__ == "__main__":
    unittest.main()
