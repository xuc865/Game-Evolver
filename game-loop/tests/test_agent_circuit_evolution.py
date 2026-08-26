from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from game_loop.config import HarnessEvolutionConfig
from game_loop.core.agent_circuit import (
    AgentCircuit,
    AgentRole,
    CircuitEdge,
    CircuitPolicy,
    RoleHarnessSpec,
)
from game_loop.core.agent_circuit_evolution import (
    CircuitCostModel,
    CircuitMutationAction,
    CircuitMutationEngine,
    CircuitMutationTransaction,
)
from game_loop.core.harness import HarnessEvolutionEngine, HarnessSemanticGradient


def role_payload(role_id: str, kind: str) -> dict:
    return AgentRole(
        role_id=role_id,
        name=role_id.title(),
        kind=kind,
        objective=f"Own {role_id} work.",
        system_prompt=f"Execute {role_id} work.",
    ).to_dict()


def studio_transaction(parent: AgentCircuit) -> CircuitMutationTransaction:
    return CircuitMutationTransaction(
        parent_circuit_id=parent.circuit_id,
        hypothesis=(
            "Repeated visual and gameplay rubric gaps require parallel specialists, "
            "an integrator, and an independent playtest gate."
        ),
        evidence_refs=("rubric://epoch-12/visual", "rubric://epoch-12/gameplay"),
        actions=(
            CircuitMutationAction(
                action_id="split_maker_into_studio",
                operation="split_role",
                rationale="Separate planning, mechanics, presentation, integration, and QA.",
                payload={
                    "source_role_id": "maker",
                    "replacement_roles": [
                        role_payload("director", "director"),
                        role_payload("gameplay", "specialist"),
                        role_payload("visuals", "specialist"),
                        role_payload("integrator", "integrator"),
                        role_payload("critic", "critic"),
                    ],
                    "replacement_edges": [
                        CircuitEdge("to_gameplay", "director", "gameplay", "delegation", "Implement mechanics.").to_dict(),
                        CircuitEdge("to_visuals", "director", "visuals", "delegation", "Implement presentation.").to_dict(),
                        CircuitEdge("gameplay_patch", "gameplay", "integrator", "artifact", "Merge mechanics.", ("patch",)).to_dict(),
                        CircuitEdge("visual_patch", "visuals", "integrator", "artifact", "Merge visuals.", ("patch",)).to_dict(),
                        CircuitEdge("review", "integrator", "critic", "review", "Deep-play build.", ("build",)).to_dict(),
                    ],
                    "entry_role_ids": ["director"],
                    "terminal_role_ids": ["critic"],
                },
            ),
            CircuitMutationAction(
                action_id="fund_studio",
                operation="modify_policy",
                rationale="Bound parallel execution and charge its full marginal cost.",
                payload={
                    "replacement": CircuitPolicy(
                        max_parallel_roles=2,
                        max_total_model_calls=5,
                        max_total_cost_units=5,
                    ).to_dict()
                },
            ),
        ),
    )


class CircuitEvolutionTests(unittest.TestCase):
    def test_atomically_splits_single_agent_into_studio(self):
        parent = AgentCircuit.singleton()
        transaction = studio_transaction(parent)

        candidate = CircuitMutationEngine().apply(parent, transaction)

        self.assertEqual(len(parent.roles), 1)
        self.assertEqual(len(candidate.roles), 5)
        self.assertEqual(candidate.entry_role_ids, ("director",))
        self.assertEqual(candidate.terminal_role_ids, ("critic",))
        self.assertEqual(candidate.policy.max_parallel_roles, 2)
        self.assertNotEqual(candidate.circuit_id, parent.circuit_id)

    def test_invalid_transaction_is_atomic(self):
        parent = AgentCircuit.singleton()
        bad = CircuitMutationTransaction(
            parent_circuit_id=parent.circuit_id,
            hypothesis="Try an invalid dangling edge.",
            evidence_refs=("trace://one",),
            actions=(
                CircuitMutationAction(
                    "bad_edge",
                    "add_edge",
                    "Probe delegation.",
                    {
                        "edge": CircuitEdge(
                            "dangling", "maker", "missing", "delegation", "Delegate."
                        ).to_dict()
                    },
                ),
            ),
        )

        with self.assertRaisesRegex(ValueError, "unknown roles"):
            CircuitMutationEngine().apply(parent, bad)

        self.assertEqual(parent, AgentCircuit.singleton())

    def test_cost_model_rejects_quality_gain_below_studio_overhead(self):
        parent = AgentCircuit.singleton()
        candidate = CircuitMutationEngine().apply(parent, studio_transaction(parent))
        model = CircuitCostModel()

        rejected = model.decide(parent=parent, candidate=candidate, quality_delta=0.01)
        accepted = model.decide(parent=parent, candidate=candidate, quality_delta=0.30)

        self.assertFalse(rejected.accepted)
        self.assertGreater(rejected.cost_penalty, rejected.quality_delta)
        self.assertTrue(accepted.accepted)
        self.assertGreater(accepted.net_utility, 0)

    def test_cost_model_accepts_equal_quality_simplification(self):
        simpler = AgentCircuit.singleton()
        studio = CircuitMutationEngine().apply(
            simpler, studio_transaction(simpler)
        )

        decision = CircuitCostModel().decide(
            parent=studio,
            candidate=simpler,
            quality_delta=0.0,
        )

        self.assertTrue(decision.accepted)
        self.assertLess(decision.cost_penalty, 0)
        self.assertGreater(decision.net_utility, 0)

    def test_harness_engine_persists_circuit_transaction_and_candidate(self):
        config = HarnessEvolutionConfig.from_dict(
            {
                "modules": [
                    {"id": "base", "instruction": "Build and verify.", "tags": ["base"]}
                ],
                "seed_modules": ["base"],
                "max_active_modules": 1,
                "max_active_tool_interfaces": 0,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "promotion_delta_min": 0,
                "max_case_regression": 0,
                "require_rubric_validation": False,
            }
        )
        with tempfile.TemporaryDirectory() as td:
            engine = HarnessEvolutionEngine(Path(td) / "inner", config)
            parent = engine.initialize()
            transaction = studio_transaction(parent.effective_agent_circuit())

            candidate = engine.propose_circuit(
                parent_id=parent.harness_id,
                transaction=transaction,
                epoch=1,
            )

            self.assertIsNotNone(candidate.agent_circuit)
            self.assertEqual(len(candidate.agent_circuit.roles), 5)  # type: ignore[union-attr]
            self.assertTrue(
                (
                    engine.root
                    / "circuit_transactions"
                    / f"epoch_001_{candidate.harness_id}.json"
                ).is_file()
            )

    def test_circuit_transaction_can_activate_distinct_audited_role_harnesses(self):
        config = HarnessEvolutionConfig.from_dict(
            {
                "modules": [
                    {"id": "build", "instruction": "Build.", "tags": ["build"]},
                    {"id": "review", "instruction": "Review.", "tags": ["review"]},
                ],
                "element_catalog": [
                    {
                        "id": "build_flow",
                        "category": "workflow",
                        "description": "Implement then verify.",
                        "spec": {"steps": ["implement", "verify"]},
                    },
                    {
                        "id": "review_flow",
                        "category": "workflow",
                        "description": "Inspect then report.",
                        "spec": {"steps": ["inspect", "report"]},
                    },
                ],
                "seed_modules": ["build"],
                "seed_elements": {"workflow": ["build_flow"]},
                "max_active_modules": 1,
                "max_active_elements": {"workflow": 1},
                "max_active_tool_interfaces": 0,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
            }
        )
        with tempfile.TemporaryDirectory() as td:
            engine = HarnessEvolutionEngine(Path(td) / "inner", config)
            parent = engine.initialize()
            parent_circuit = parent.effective_agent_circuit()
            builder = AgentRole(
                role_id="builder",
                name="Builder",
                kind="specialist",
                objective="Build the game.",
                system_prompt="Implement and verify.",
                harness_spec=RoleHarnessSpec(
                    source_harness_id=parent.harness_id,
                    active_module_ids=("build",),
                    active_element_ids=("build_flow",),
                ),
            )
            reviewer = AgentRole(
                role_id="reviewer",
                name="Reviewer",
                kind="critic",
                objective="Review the game.",
                system_prompt="Inspect independently.",
                harness_spec=RoleHarnessSpec(
                    source_harness_id=parent.harness_id,
                    active_module_ids=("review",),
                    active_element_ids=("review_flow",),
                ),
            )
            transaction = CircuitMutationTransaction(
                parent_circuit_id=parent_circuit.circuit_id,
                hypothesis="Separate implementation from independent review.",
                evidence_refs=("trace://quality-gap",),
                actions=(
                    CircuitMutationAction(
                        "split",
                        "split_role",
                        "Use distinct evidence-backed role harnesses.",
                        {
                            "source_role_id": "maker",
                            "replacement_roles": [builder.to_dict(), reviewer.to_dict()],
                            "replacement_edges": [
                                CircuitEdge(
                                    "review_build",
                                    "builder",
                                    "reviewer",
                                    "review",
                                    "Review the completed build.",
                                    ("patch",),
                                ).to_dict()
                            ],
                            "entry_role_ids": ["builder"],
                            "terminal_role_ids": ["reviewer"],
                        },
                    ),
                    CircuitMutationAction(
                        "fund",
                        "modify_policy",
                        "Fund the two bounded role calls.",
                        {
                            "replacement": CircuitPolicy(
                                max_parallel_roles=1,
                                max_total_model_calls=2,
                                max_total_cost_units=2,
                            ).to_dict()
                        },
                    ),
                ),
            )

            candidate = engine.propose_circuit(
                parent_id=parent.harness_id,
                transaction=transaction,
                epoch=1,
            )

            self.assertEqual(set(candidate.active_modules), {"build", "review"})
            self.assertEqual(
                {item.element_id for item in candidate.active_elements},
                {"build_flow", "review_flow"},
            )
            self.assertGreater(len(candidate.active_modules), config.max_active_modules)

    def test_followup_component_evolution_is_assigned_to_evidence_matched_role(self):
        config = HarnessEvolutionConfig.from_dict(
            {
                "modules": [
                    {"id": "build", "instruction": "Build mechanics.", "tags": ["build"]},
                    {"id": "review", "instruction": "Review quality.", "tags": ["review"]},
                    {
                        "id": "review_visuals",
                        "instruction": "Review visual clarity independently.",
                        "tags": ["review", "visual"],
                    },
                ],
                "seed_modules": ["build"],
                "max_active_modules": 2,
                "max_active_tool_interfaces": 0,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
            }
        )
        with tempfile.TemporaryDirectory() as td:
            engine = HarnessEvolutionEngine(Path(td) / "inner", config)
            parent = engine.initialize()
            base = parent.effective_agent_circuit()
            builder = AgentRole(
                "builder", "Builder", "specialist", "Build mechanics.", "Implement.",
                harness_spec=RoleHarnessSpec(
                    source_harness_id=parent.harness_id,
                    active_module_ids=("build",),
                ),
            )
            reviewer = AgentRole(
                "reviewer", "Reviewer", "critic", "Review visual quality.", "Review.",
                harness_spec=RoleHarnessSpec(
                    source_harness_id=parent.harness_id,
                    active_module_ids=("review",),
                ),
            )
            split = CircuitMutationTransaction(
                parent_circuit_id=base.circuit_id,
                hypothesis="Separate building and review.",
                evidence_refs=("trace://review-gap",),
                actions=(
                    CircuitMutationAction(
                        "split", "split_role", "Create an independent reviewer.",
                        {
                            "source_role_id": "maker",
                            "replacement_roles": [builder.to_dict(), reviewer.to_dict()],
                            "replacement_edges": [
                                CircuitEdge(
                                    "review", "builder", "reviewer", "review",
                                    "Review the patch.", ("patch",),
                                ).to_dict()
                            ],
                            "entry_role_ids": ["builder"],
                            "terminal_role_ids": ["reviewer"],
                        },
                    ),
                    CircuitMutationAction(
                        "fund", "modify_policy", "Fund both roles.",
                        {"replacement": CircuitPolicy(
                            max_parallel_roles=1,
                            max_total_model_calls=2,
                            max_total_cost_units=2,
                        ).to_dict()},
                    ),
                ),
            )
            studio = engine.propose_circuit(
                parent_id=parent.harness_id,
                transaction=split,
                epoch=1,
            )

            evolved = engine.propose(
                parent_id=studio.harness_id,
                gradient=HarnessSemanticGradient(
                    "Visual review misses remain.",
                    target_tags=("review", "visual"),
                    evidence_refs=("trace://visual-gap",),
                ),
                epoch=2,
            )

            roles = {role.role_id: role for role in evolved.agent_circuit.roles}  # type: ignore[union-attr]
            self.assertNotIn(
                "review_visuals", roles["builder"].harness_spec.active_module_ids
            )
            self.assertIn(
                "review_visuals", roles["reviewer"].harness_spec.active_module_ids
            )


if __name__ == "__main__":
    unittest.main()
