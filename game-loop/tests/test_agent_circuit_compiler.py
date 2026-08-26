from __future__ import annotations

import unittest

from game_loop.core.agent_circuit import AgentCircuit, RoleHarnessSpec
from game_loop.core.agent_circuit_compiler import (
    HarnessTransformationCompiler,
    TransformationNotApplicable,
)
from game_loop.core.agent_circuit_evolution import CircuitMutationEngine
from game_loop.core.harness_transformation_library import (
    HarnessTransformation,
    default_transformations,
)


class HarnessTransformationCompilerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.compiler = HarnessTransformationCompiler()
        self.catalog = {
            item.transformation_id: item for item in default_transformations()
        }

    def compile(self, transformation_id: str, circuit: AgentCircuit):
        transaction = self.compiler.compile(
            self.catalog[transformation_id],
            circuit=circuit,
            evidence_refs=("rubric://epoch-1/quality",),
        )
        return transaction, CircuitMutationEngine().apply(circuit, transaction)

    def test_compiles_singleton_into_executable_studio(self):
        transaction, studio = self.compile("single_to_studio", AgentCircuit.singleton())

        self.assertEqual(transaction.transformation_ids, ("single_to_studio",))
        self.assertEqual(len(studio.roles), 5)
        self.assertEqual(studio.entry_role_ids, ("director",))
        self.assertEqual(studio.terminal_role_ids, ("integrator", "playtester"))
        self.assertTrue(any(edge.kind == "feedback" for edge in studio.edges))

    def test_all_default_shapes_compile_when_applicable(self):
        singleton = AgentCircuit.singleton()
        _, critic = self.compile("add_critic_feedback", singleton)
        _, parallel = self.compile("parallelize_specialists", singleton)
        _, studio = self.compile("single_to_studio", singleton)
        _, merged = self.compile("merge_redundant_roles", studio)
        _, typed = self.compile("tighten_artifact_handoff", studio)

        self.assertEqual(len(critic.roles), 2)
        self.assertEqual(len(parallel.roles), 3)
        self.assertEqual(len(merged.roles), 4)
        self.assertTrue(
            any(role.context.mode == "selected_artifacts" for role in typed.roles)
        )

    def test_valid_but_inapplicable_transformation_is_distinct(self):
        _, studio = self.compile("single_to_studio", AgentCircuit.singleton())

        with self.assertRaises(TransformationNotApplicable):
            self.compiler.compile(
                self.catalog["single_to_studio"],
                circuit=studio,
                evidence_refs=("rubric://epoch-2",),
            )

    def test_composes_two_valid_shapes_into_one_atomic_transaction(self):
        composite = HarnessTransformation(
            "studio_with_typed_handoffs",
            "Studio with typed handoffs",
            "Create a studio and immediately constrain one broad handoff.",
            ("single_agent", "context_bloat"),
            ("split_role", "modify_policy", "modify_edge", "modify_role"),
            {
                "shape": "composite",
                "steps": [
                    {
                        "shape": "director_parallel_specialists_integrator_critic"
                    },
                    {"shape": "typed_artifact_mailbox"},
                ],
            },
        )

        transaction = self.compiler.compile(
            composite,
            circuit=AgentCircuit.singleton(),
            evidence_refs=("rubric://epoch-4/context",),
            max_actions=4,
        )
        candidate = CircuitMutationEngine().apply(
            AgentCircuit.singleton(), transaction
        )

        self.assertEqual(len(transaction.actions), 4)
        self.assertTrue(transaction.actions[2].depends_on)
        self.assertEqual(len(candidate.roles), 5)
        self.assertTrue(
            any(role.context.mode == "selected_artifacts" for role in candidate.roles)
        )

    def test_rejects_library_element_without_runtime_compiler(self):
        unknown = HarnessTransformation(
            "invent_uncompiled_shape",
            "Invent uncompiled shape",
            "This must not enter the executable HPA catalog.",
            ("quality_gap",),
            ("add_role",),
            {"shape": "wishful_thinking"},
        )

        with self.assertRaisesRegex(ValueError, "no executable compiler"):
            self.compiler.validate_template(unknown)

    def test_compiles_hpa_declared_roles_and_handoffs_not_known_to_source(self):
        transformation = HarnessTransformation(
            "evolve_cartography_cell",
            "Evolve cartography cell",
            "Fork spatial research and systems construction, then synthesize their artifacts.",
            ("world_coherence_gap", "mechanics_gap"),
            ("split_role", "modify_policy"),
            {
                "shape": "declarative_circuit",
                "applicability": {"max_roles": 1},
                "actions": [
                    {
                        "action_id": "fork_cartography_cell",
                        "operation": "split_role",
                        "rationale": "Independent evidence streams need separate contexts.",
                        "payload": {
                            "source_role_id": "$primary",
                            "replacement_roles": [
                                {
                                    "role_id": "world_scout",
                                    "name": "World Scout",
                                    "kind": "specialist",
                                    "objective": "Map spatial affordances and traversal risks.",
                                    "system_prompt": "Publish a concise world map artifact.",
                                    "output_artifact_kinds": ["world_map"],
                                    "context": {"mode": "task_only"},
                                },
                                {
                                    "role_id": "systems_builder",
                                    "name": "Systems Builder",
                                    "kind": "specialist",
                                    "objective": "Construct mechanics against the spatial evidence.",
                                    "system_prompt": "Publish a mechanics patch artifact.",
                                    "output_artifact_kinds": ["patch"],
                                    "context": {"mode": "task_only"},
                                },
                                {
                                    "role_id": "release_editor",
                                    "name": "Release Editor",
                                    "kind": "integrator",
                                    "objective": "Reconcile map and mechanics into a verified release.",
                                    "system_prompt": "Integrate only compatible typed artifacts.",
                                    "output_artifact_kinds": ["build"],
                                    "context": {
                                        "mode": "selected_artifacts",
                                        "include_artifact_kinds": ["world_map", "patch"],
                                    },
                                },
                            ],
                            "replacement_edges": [
                                {
                                    "edge_id": "map_to_release",
                                    "source": "world_scout",
                                    "target": "release_editor",
                                    "kind": "artifact",
                                    "instruction": "Deliver the world map.",
                                    "artifact_kinds": ["world_map"],
                                },
                                {
                                    "edge_id": "systems_to_release",
                                    "source": "systems_builder",
                                    "target": "release_editor",
                                    "kind": "artifact",
                                    "instruction": "Deliver the mechanics patch.",
                                    "artifact_kinds": ["patch"],
                                },
                            ],
                            "entry_role_ids": ["world_scout", "systems_builder"],
                            "terminal_role_ids": ["release_editor"],
                        },
                    },
                    {
                        "action_id": "fund_cartography_cell",
                        "operation": "modify_policy",
                        "rationale": "Charge exactly three bounded model calls.",
                        "depends_on": ["fork_cartography_cell"],
                        "payload": {
                            "replacement": {
                                "inherit_current": True,
                                "max_parallel_roles": 2,
                                "max_total_model_calls": 3,
                                "max_total_cost_units": 3,
                                "workspace_mode": "isolated_then_merge",
                            }
                        },
                    },
                ],
            },
            cost_prior=2.2,
        )

        transaction = self.compiler.compile(
            transformation,
            circuit=AgentCircuit.singleton(),
            evidence_refs=("rubric://epoch-9/world-coherence",),
            max_actions=4,
        )
        candidate = CircuitMutationEngine().apply(
            AgentCircuit.singleton(), transaction
        )

        self.assertEqual(
            {role.role_id for role in candidate.roles},
            {"world_scout", "systems_builder", "release_editor"},
        )
        self.assertEqual(candidate.entry_role_ids, ("systems_builder", "world_scout"))
        self.assertEqual(candidate.terminal_role_ids, ("release_editor",))
        self.assertEqual({edge.kind for edge in candidate.edges}, {"artifact"})
        self.assertEqual(candidate.policy.max_parallel_roles, 2)

    def test_declarative_admission_rejects_invalid_graph_atomically(self):
        invalid = HarnessTransformation(
            "cyclic_custom_team",
            "Cyclic custom team",
            "An invalid ordinary-edge cycle must never enter the library.",
            ("coordination_gap",),
            ("split_role", "modify_policy"),
            {
                "shape": "declarative_circuit",
                "actions": [
                    {
                        "action_id": "bad_split",
                        "operation": "split_role",
                        "rationale": "Deliberately invalid test graph.",
                        "payload": {
                            "source_role_id": "$primary",
                            "replacement_roles": [
                                {"inherit_from": "$primary", "role_id": "alpha"},
                                {"inherit_from": "$primary", "role_id": "beta"},
                            ],
                            "replacement_edges": [
                                {"edge_id": "alpha_beta", "source": "alpha", "target": "beta", "kind": "control", "instruction": "A to B"},
                                {"edge_id": "beta_alpha", "source": "beta", "target": "alpha", "kind": "control", "instruction": "B to A"},
                            ],
                            "entry_role_ids": ["alpha"],
                            "terminal_role_ids": ["beta"],
                        },
                    },
                    {
                        "action_id": "fund_bad_split",
                        "operation": "modify_policy",
                        "rationale": "Fund invalid graph for validation.",
                        "depends_on": ["bad_split"],
                        "payload": {"replacement": {"inherit_current": True, "max_parallel_roles": 1, "max_total_model_calls": 2, "max_total_cost_units": 2}},
                    },
                ],
            },
        )

        with self.assertRaisesRegex(ValueError, "must form a DAG"):
            self.compiler.compile(
                invalid,
                circuit=AgentCircuit.singleton(),
                evidence_refs=("rubric://invalid",),
            )

    def test_split_roles_inherit_then_specialize_parent_dsh_harness(self):
        parent = AgentCircuit.singleton(
            harness_spec=RoleHarnessSpec(
                source_harness_id="harness-parent-dsh",
                active_module_ids=("evidence_first",),
                active_element_ids=("plugin_retry", "plugin_context"),
                active_cordis_plugins=("llm_retry", "context_efficiency_guards"),
            )
        )
        transformation = HarnessTransformation(
            "specialize_parent_dsh",
            "Specialize parent DSH",
            "Fork two children from the accepted parent harness and specialize one plugin set.",
            ("specialization_gap",),
            ("split_role", "modify_policy"),
            {
                "shape": "declarative_circuit",
                "actions": [
                    {
                        "action_id": "fork_children",
                        "operation": "split_role",
                        "rationale": "Separate implementation and review contexts.",
                        "payload": {
                            "source_role_id": "$primary",
                            "replacement_roles": [
                                {
                                    "role_id": "builder_child",
                                    "name": "Builder Child",
                                    "kind": "specialist",
                                    "objective": "Implement the candidate.",
                                    "system_prompt": "Build and publish a patch.",
                                },
                                {
                                    "role_id": "review_child",
                                    "name": "Review Child",
                                    "kind": "critic",
                                    "objective": "Review the candidate independently.",
                                    "system_prompt": "Publish an evidence-backed review.",
                                    "harness_spec": {
                                        "active_element_ids": ["plugin_context"],
                                        "active_cordis_plugins": ["context_efficiency_guards"],
                                    },
                                },
                            ],
                            "replacement_edges": [
                                {"edge_id": "build_review", "source": "builder_child", "target": "review_child", "kind": "review", "instruction": "Review the patch.", "artifact_kinds": ["patch"]}
                            ],
                            "entry_role_ids": ["builder_child"],
                            "terminal_role_ids": ["review_child"],
                        },
                    },
                    {
                        "action_id": "fund_children",
                        "operation": "modify_policy",
                        "rationale": "Bound both children to one call each.",
                        "depends_on": ["fork_children"],
                        "payload": {"replacement": {"inherit_current": True, "max_parallel_roles": 1, "max_total_model_calls": 2, "max_total_cost_units": 2}},
                    },
                ],
            },
        )

        transaction = self.compiler.compile(
            transformation,
            circuit=parent,
            evidence_refs=("rubric://specialization",),
        )
        candidate = CircuitMutationEngine().apply(parent, transaction)
        roles = {role.role_id: role for role in candidate.roles}

        self.assertEqual(
            roles["builder_child"].harness_spec.active_cordis_plugins,
            ("context_efficiency_guards", "llm_retry"),
        )
        self.assertEqual(
            roles["review_child"].harness_spec.active_cordis_plugins,
            ("context_efficiency_guards",),
        )
        self.assertEqual(
            roles["review_child"].harness_spec.source_harness_id,
            "harness-parent-dsh",
        )
        self.assertNotEqual(
            roles["builder_child"].effective_harness_hash,
            roles["review_child"].effective_harness_hash,
        )


if __name__ == "__main__":
    unittest.main()
