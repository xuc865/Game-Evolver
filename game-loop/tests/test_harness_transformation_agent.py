from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from game_loop.core.agent_circuit import AgentCircuit, validate_workspace_lineage
from game_loop.core.agent_circuit_evolution import CircuitMutationEngine
from game_loop.core.agent_circuit_runtime import (
    AgentCircuitExecutor,
    CircuitArtifact,
    CircuitRoleRequest,
    CircuitRoleResult,
    FilesystemCircuitWorkspaceManager,
)
from game_loop.core.agentx_runtime import EvidenceDrivenCircuitProposer
from game_loop.core.attribution import AttributionReport
from game_loop.core.harness import HarnessEpochResult, HarnessProfile
from game_loop.core.harness_transformation_agent import (
    HarnessTransformationLibraryAgent,
)
from game_loop.core.harness_transformation_library import (
    HarnessTransformation,
    HarnessTransformationLibraryStore,
)
from game_loop.runtime.deepseek_circuit import DeepSeekCircuitRoleRunner
from game_loop.runtime.deepseek_harness import (
    DeepSeekHarnessRunnerResult,
    DeepSeekHarnessRuntimeConfig,
)


def result(*, accepted: bool = True) -> HarnessEpochResult:
    return HarnessEpochResult(
        epoch=3,
        parent_harness_id="parent",
        candidate_harness_id="candidate",
        accepted=accepted,
        paired_deltas=(0.1, 0.2),
        median_delta=0.15,
        reasons=("candidate rubric still below perfect",),
        excluded_pairs=(),
        parent_outcomes=(),
        candidate_outcomes=(),
        created_at="now",
        rubric_validation={
            "case_results": [
                {
                    "case_id": "case-a",
                    "candidate": {
                        "hard": {"playable": 1.0},
                        "soft": {"visual_quality": 0.8},
                    },
                }
            ]
        },
    )


def isolated_terminal_lineage_transformation(
    *,
    verifier_workspace_output: bool,
) -> HarnessTransformation:
    verifier_outputs = ["verification_report"]
    verifier_modes = {"verification_report": "inline"}
    terminal_artifacts = ["verification_report"]
    if verifier_workspace_output:
        verifier_outputs.append("verified_workspace")
        verifier_modes["verified_workspace"] = "workspace"
        terminal_artifacts.append("verified_workspace")
    return HarnessTransformation.from_dict({
        "id": "lineage_candidate",
        "name": "Lineage candidate",
        "description": "Build, verify, and publish using typed artifacts.",
        "trigger_signals": ["single_agent"],
        "supported_operations": ["split_role", "modify_policy"],
        "plan_template": {
            "shape": "declarative_circuit",
            "applicability": {"min_roles": 1, "max_roles": 1},
            "actions": [
                {
                    "action_id": "split_pipeline",
                    "operation": "split_role",
                    "rationale": "Separate implementation, verification, and publication.",
                    "payload": {
                        "source_role_id": "$primary",
                        "replacement_roles": [
                            {
                                "role_id": "builder",
                                "name": "Builder",
                                "kind": "operator",
                                "objective": "Implement the requested game.",
                                "system_prompt": "Build and publish the workspace.",
                                "workspace_access": "read_write",
                                "output_artifact_kinds": ["game_workspace"],
                                "output_artifact_modes": {"game_workspace": "workspace"},
                            },
                            {
                                "role_id": "verifier",
                                "name": "Verifier",
                                "kind": "auditor",
                                "objective": "Verify the exact implementation.",
                                "system_prompt": "Verify and publish typed results.",
                                "workspace_access": "read_only",
                                "output_artifact_kinds": verifier_outputs,
                                "output_artifact_modes": verifier_modes,
                            },
                            {
                                "role_id": "publisher",
                                "name": "Publisher",
                                "kind": "operator",
                                "objective": "Publish the verified game.",
                                "system_prompt": "Publish the supplied verified workspace.",
                                "workspace_access": "read_write",
                                "output_artifact_kinds": ["final_game"],
                                "output_artifact_modes": {"final_game": "workspace"},
                            },
                        ],
                        "replacement_edges": [
                            {
                                "edge_id": "build_to_verify",
                                "source": "builder",
                                "target": "verifier",
                                "kind": "workspace_handoff",
                                "protocol": "forward",
                                "instruction": "Verify this exact workspace.",
                                "artifact_kinds": ["game_workspace"],
                            },
                            {
                                "edge_id": "verify_to_publish",
                                "source": "verifier",
                                "target": "publisher",
                                "kind": "verified_handoff",
                                "protocol": "forward",
                                "instruction": "Publish the verified result.",
                                "artifact_kinds": terminal_artifacts,
                            },
                        ],
                        "entry_role_ids": ["builder"],
                        "terminal_role_ids": ["publisher"],
                    },
                },
                {
                    "action_id": "bound_pipeline",
                    "operation": "modify_policy",
                    "rationale": "Fund exactly one invocation per role.",
                    "depends_on": ["split_pipeline"],
                    "payload": {
                        "replacement": {
                            "inherit_current": True,
                            "max_parallel_roles": 1,
                            "max_total_model_calls": 3,
                            "max_total_cost_units": 3,
                            "workspace_mode": "isolated_then_merge",
                        }
                    },
                },
            ],
        },
        "cost_prior": 1.0,
    })


class HarnessTransformationLibraryAgentTests(unittest.TestCase):
    def test_terminal_publisher_rejects_inline_only_workspace_lineage(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize(())
            transformation = isolated_terminal_lineage_transformation(
                verifier_workspace_output=False
            )
            transaction = EvidenceDrivenCircuitProposer(store).compiler.compile(
                transformation,
                circuit=AgentCircuit.singleton(),
                evidence_refs=("inner://epoch/4/result",),
            )
            candidate = CircuitMutationEngine().apply(
                AgentCircuit.singleton(), transaction
            )

            with self.assertRaisesRegex(
                ValueError,
                "no required workspace handoff path to a terminal publisher",
            ):
                validate_workspace_lineage(candidate)

    def test_terminal_publisher_accepts_republished_verified_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize(())
            transformation = isolated_terminal_lineage_transformation(
                verifier_workspace_output=True
            )
            transaction = EvidenceDrivenCircuitProposer(store).compiler.compile(
                transformation,
                circuit=AgentCircuit.singleton(),
                evidence_refs=("inner://epoch/4/result",),
            )
            candidate = CircuitMutationEngine().apply(
                AgentCircuit.singleton(), transaction
            )

            validate_workspace_lineage(candidate)

    def test_goa_skips_and_audits_invalid_catalog_workspace_lineage(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            transformation = isolated_terminal_lineage_transformation(
                verifier_workspace_output=False
            )
            store.initialize((transformation,))
            profile = HarnessProfile.from_dict({"harness_id": "dsh-champion"})

            transaction = EvidenceDrivenCircuitProposer(store).propose_circuit(
                AttributionReport(
                    run_refs=("inner://epoch/4/result",),
                    outcome_counts={"probe_failed": 1},
                    repeated_failures=(),
                    infrastructure_events=0,
                ),
                proposer_harness=profile,
                target_harness=profile,
            )

            self.assertIsNone(transaction)
            issues = store.quarantine_issues(
                circuit_id=profile.effective_agent_circuit().circuit_id
            )
            self.assertEqual(len(issues), 1)
            self.assertEqual(issues[0]["transformation_id"], "lineage_candidate")
            self.assertIn("workspace handoff path", issues[0]["reason"])

    def test_invalid_catalog_entry_is_not_a_structural_expansion(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize((
                isolated_terminal_lineage_transformation(
                    verifier_workspace_output=False
                ),
            ))
            agent = HarnessTransformationLibraryAgent(
                store,
                lambda stage, payload: {},
            )

            self.assertFalse(
                agent._library_has_structural_expansion(
                    current_circuit=AgentCircuit.singleton(),
                    evidence_refs=("inner://epoch/4/result",),
                )
            )

    def test_deepseek_role_runtime_contract_rejects_fake_extra_work_budget(self):
        contract = {
            "runtime_contract": {
                "model_calls_per_role_invocation": 1,
                "cost_units_per_role_invocation": 1.0,
            }
        }
        HarnessTransformationLibraryAgent._validate_role_runtime_contract(
            AgentCircuit.singleton(), contract
        )
        with self.assertRaisesRegex(
            ValueError, "repeated invocations require explicit bounded feedback edges"
        ):
            HarnessTransformationLibraryAgent._validate_role_runtime_contract(
                AgentCircuit.singleton(max_model_calls=5), contract
            )

    def test_empty_library_bootstrap_reaches_executable_workspace_handoff(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            store = HarnessTransformationLibraryStore(root / "library")
            store.initialize(())
            profile = HarnessProfile.from_dict({"harness_id": "dsh-champion"})

            def request(stage, payload):
                self.assertEqual(stage, "bootstrap_circuit")
                return {
                    "id": "evidence_build_verify",
                    "name": "Evidence build verify",
                    "description": "Inspect evidence, build in isolation, then verify the exact build.",
                    "rationale": "The soft rubric gap needs separated evidence and verification contexts.",
                    "evidence_refs": [
                        "rubric://epoch/3/case/case-a/soft/visual_quality"
                    ],
                    "trigger_signals": ["single_agent"],
                    "roles": [
                        {
                            "role_id": "evidence_reader",
                            "name": "Evidence Reader",
                            "kind": "evidence_cartographer",
                            "objective": "Publish bounded evidence without editing.",
                            "system_prompt": "Inspect only and publish evidence.",
                            "workspace_access": "read_only",
                            "output_artifacts": [
                                {"kind": "evidence_digest", "mode": "inline"}
                            ],
                        },
                        {
                            "role_id": "game_builder",
                            "name": "Game Builder",
                            "kind": "artifact_composer",
                            "objective": "Implement the evidence-backed change.",
                            "system_prompt": "Consume evidence and publish a workspace.",
                            "workspace_access": "read_write",
                            "output_artifacts": [
                                {"kind": "candidate_workspace", "mode": "workspace"}
                            ],
                        },
                        {
                            "role_id": "game_verifier",
                            "name": "Game Verifier",
                            "kind": "runtime_auditor",
                            "objective": "Verify the exact candidate workspace.",
                            "system_prompt": "Verify the supplied workspace and publish it.",
                            "workspace_access": "read_write",
                            "output_artifacts": [
                                {"kind": "verified_workspace", "mode": "workspace"}
                            ],
                        },
                    ],
                    "edges": [
                        {
                            "edge_id": "evidence_to_build",
                            "source": "evidence_reader",
                            "target": "game_builder",
                            "kind": "evidence_handoff",
                            "protocol": "forward",
                            "instruction": "Implement the disclosed evidence.",
                            "artifact_kinds": ["evidence_digest"],
                        },
                        {
                            "edge_id": "build_to_verify",
                            "source": "game_builder",
                            "target": "game_verifier",
                            "kind": "workspace_handoff",
                            "protocol": "forward",
                            "instruction": "Verify this exact candidate workspace.",
                            "artifact_kinds": ["candidate_workspace"],
                        },
                    ],
                    "entry_role_ids": ["evidence_reader"],
                    "terminal_role_ids": ["game_verifier"],
                    "policy": {
                        "max_parallel_roles": 1,
                        "wall_timeout_seconds": 1200,
                        "max_total_model_calls": 3,
                        "max_total_cost_units": 3,
                        "failure_mode": "fail_fast",
                        "workspace_mode": "isolated_then_merge",
                    },
                    "tags": ["open_topology", "typed_handoff"],
                    "cost_prior": 1.0,
                }

            compiler = EvidenceDrivenCircuitProposer(store).compiler
            update = HarnessTransformationLibraryAgent(
                store,
                request,
                compiler=compiler,
                max_structural_actions=1,
                max_additions=1,
                max_circuit_actions=4,
            ).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=profile.effective_agent_circuit(),
            )
            self.assertTrue(update.applied, update.error)
            self.assertEqual(store.revision(), 1)

            transaction = EvidenceDrivenCircuitProposer(
                store,
                max_actions=4,
                bundle_width=1,
                compiler=compiler,
            ).propose_circuit(
                AttributionReport(
                    run_refs=("inner://epoch/3/result",),
                    outcome_counts={"probe_failed": 1},
                    repeated_failures=(),
                    infrastructure_events=0,
                ),
                proposer_harness=profile,
                target_harness=profile,
            )
            self.assertIsNotNone(transaction)
            candidate = CircuitMutationEngine().apply(
                profile.effective_agent_circuit(), transaction
            )
            self.assertEqual(
                [role.role_id for role in candidate.roles],
                ["evidence_reader", "game_builder", "game_verifier"],
            )
            self.assertEqual(
                {role.harness_spec.source_harness_id for role in candidate.roles},
                {"dsh-champion"},
            )

            class StartupRunner:
                def run(self, prompt, **kwargs):
                    return DeepSeekHarnessRunnerResult(
                        finish_reason="completed",
                        final_response="Role started and published its contract.",
                        events=(),
                    )

            seed_cordis = root / "seed.cordis.yml"
            seed_cordis.write_text(
                "- id: seed\n  name: '@deepseek-ai/dsh-seed'\n",
                encoding="utf-8",
            )
            startup_config = DeepSeekHarnessRuntimeConfig(
                backbone_provider=None,
                cordis=str(seed_cordis),
                cordis_seed=str(seed_cordis),
                cordis_plugin_catalog={
                    "audited_plugin": [
                        {
                            "id": "audited-plugin",
                            "name": "@deepseek-ai/dsh-audited",
                        }
                    ]
                },
            )
            startup_hashes = set()
            for role in candidate.roles:
                workspace = root / "startup" / role.role_id
                workspace.mkdir(parents=True)
                started = DeepSeekCircuitRoleRunner(
                    startup_config,
                    runner=StartupRunner(),
                ).run_role(
                    CircuitRoleRequest("Build the game.", role, workspace, attempt=1)
                )
                self.assertEqual(started.status, "completed")
                self.assertEqual(
                    len(list((workspace / ".circuit_config").glob("*.yml"))),
                    1,
                )
                startup_hashes.add(started.effective_harness_hash)
            self.assertEqual(len(startup_hashes), 3)

            test_case = self

            class HandoffRunner:
                def run_role(self, role_request: CircuitRoleRequest) -> CircuitRoleResult:
                    role_id = role_request.role.role_id
                    if role_id == "evidence_reader":
                        test_case.assertEqual(
                            role_request.role.workspace_access, "read_only"
                        )
                        artifacts = (
                            CircuitArtifact(
                                "evidence_digest",
                                role_id,
                                content="center the title",
                            ),
                        )
                    elif role_id == "game_builder":
                        test_case.assertEqual(
                            [artifact.kind for artifact in role_request.artifacts],
                            ["evidence_digest"],
                        )
                        (role_request.workspace / "built.txt").write_text(
                            "candidate-v1", encoding="utf-8"
                        )
                        artifacts = (
                            CircuitArtifact(
                                "candidate_workspace",
                                role_id,
                                path=".",
                                metadata={"workspace_snapshot": True},
                            ),
                        )
                    else:
                        test_case.assertEqual(
                            (role_request.workspace / "built.txt").read_text(
                                encoding="utf-8"
                            ),
                            "candidate-v1",
                        )
                        (role_request.workspace / "verified.txt").write_text(
                            "passed", encoding="utf-8"
                        )
                        artifacts = (
                            CircuitArtifact(
                                "verified_workspace",
                                role_id,
                                path=".",
                                metadata={"workspace_snapshot": True},
                            ),
                        )
                    return CircuitRoleResult(
                        role_id=role_id,
                        status="completed",
                        summary=f"{role_id} complete",
                        artifacts=artifacts,
                        model_calls=1,
                        cost_units=1,
                    )

            source = root / "source"
            source.mkdir()
            (source / "project.godot").write_text(
                "[application]", encoding="utf-8"
            )
            execution = AgentCircuitExecutor(
                runner=HandoffRunner(),
                workspace_manager=FilesystemCircuitWorkspaceManager(
                    source_workspace=source,
                    run_root=root / "run",
                ),
            ).run(candidate, task="Build the game.")

            self.assertEqual(execution.status, "completed")
            self.assertTrue(execution.infrastructure_ok)
            self.assertEqual(execution.model_calls, 3)
            terminal = Path(execution.role_workspaces["game_verifier"])
            self.assertEqual((terminal / "built.txt").read_text(), "candidate-v1")
            self.assertEqual((terminal / "verified.txt").read_text(), "passed")

    def test_empty_production_library_requires_a_real_singleton_expansion(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize(())

            def request(stage, payload):
                evidence = "rubric://epoch/3/case/case-a/soft/visual_quality"
                return {
                    "id": "open_workshop",
                    "name": "Open workshop",
                    "description": "Split evidence synthesis from implementation.",
                    "rationale": "Imperfect quality justifies testing role separation.",
                    "evidence_refs": [evidence],
                    "trigger_signals": ["single_agent"],
                    "roles": [
                        {
                            "role_id": "evidence_synthesizer",
                            "name": "Evidence Synthesizer",
                            "kind": "runtime_gap_cartographer",
                            "objective": "Publish a bounded repair brief.",
                            "system_prompt": "Probe failures and publish only a repair brief.",
                            "workspace_access": "read_only",
                            "output_artifacts": [
                                {"kind": "repair_brief", "mode": "inline"}
                            ],
                        },
                        {
                            "role_id": "artifact_builder",
                            "name": "Artifact Builder",
                            "kind": "verified_artifact_composer",
                            "objective": "Implement and verify the brief.",
                            "system_prompt": "Build from the supplied evidence and verify it.",
                            "workspace_access": "read_write",
                            "output_artifacts": [
                                {"kind": "verified_game", "mode": "workspace"}
                            ],
                        },
                    ],
                    "edges": [{
                        "edge_id": "brief_handoff",
                        "source": "evidence_synthesizer",
                        "target": "artifact_builder",
                        "kind": "evidence_to_build",
                        "protocol": "forward",
                        "instruction": "Implement the bounded brief.",
                        "artifact_kinds": ["repair_brief"],
                    }],
                    "entry_role_ids": ["evidence_synthesizer"],
                    "terminal_role_ids": ["artifact_builder"],
                    "policy": {
                        "max_parallel_roles": 1,
                        "wall_timeout_seconds": 1200,
                        "max_total_model_calls": 2,
                        "max_total_cost_units": 2,
                        "failure_mode": "fail_fast",
                        "workspace_mode": "isolated_then_merge",
                    },
                    "tags": ["open_topology"],
                    "cost_prior": 1.0,
                }

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=AgentCircuit.singleton(),
            )

            self.assertTrue(update.applied)
            transformation = store.catalog()["open_workshop"]
            transaction = HarnessTransformationLibraryAgent(
                store, request
            ).compiler.compile(
                transformation,
                circuit=AgentCircuit.singleton(),
                evidence_refs=(
                    "rubric://epoch/3/case/case-a/soft/visual_quality",
                ),
            )
            candidate = CircuitMutationEngine().apply(
                AgentCircuit.singleton(), transaction
            )
            self.assertEqual(
                {role.kind for role in candidate.roles},
                {"runtime_gap_cartographer", "verified_artifact_composer"},
            )

    def test_empty_library_accepts_standard_hpa_library_transaction(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize(())
            evidence = "rubric://epoch/3/case/case-a/soft/visual_quality"

            def request(stage, payload):
                self.assertEqual(stage, "bootstrap_circuit")
                return {
                    "library_actions": [{
                        "action_id": "add_evidence_workshop",
                        "library_operation": "add",
                        "rationale": "The quality gap warrants a typed evidence handoff.",
                        "evidence_refs": [evidence],
                        "payload": {"transformation": {
                            "id": "evidence_workshop",
                            "name": "Evidence workshop",
                            "description": "Split evidence synthesis from verified implementation.",
                            "trigger_signals": ["single_agent"],
                            "supported_operations": ["split_role", "modify_policy"],
                            "plan_template": {
                                "shape": "declarative_circuit",
                                "applicability": {"min_roles": 1, "max_roles": 1},
                                "actions": [
                                    {
                                        "action_id": "split_evidence_workshop",
                                        "operation": "split_role",
                                        "rationale": "Give evidence and implementation isolated contexts.",
                                        "payload": {
                                            "source_role_id": "$primary",
                                            "replacement_roles": [
                                                {
                                                    "role_id": "evidence_reader",
                                                    "name": "Evidence Reader",
                                                    "kind": "evidence_cartographer",
                                                    "objective": "Publish a bounded evidence brief.",
                                                    "system_prompt": "Inspect evidence and publish only the brief.",
                                                    "workspace_access": "read_only",
                                                    "output_artifact_kinds": ["evidence_brief"],
                                                    "output_artifact_modes": {"evidence_brief": "inline"},
                                                },
                                                {
                                                    "role_id": "artifact_builder",
                                                    "name": "Artifact Builder",
                                                    "kind": "verified_composer",
                                                    "objective": "Implement and verify the brief.",
                                                    "system_prompt": "Build from the brief and publish the workspace.",
                                                    "workspace_access": "read_write",
                                                    "output_artifact_kinds": ["verified_game"],
                                                    "output_artifact_modes": {"verified_game": "workspace"},
                                                },
                                            ],
                                            "replacement_edges": [{
                                                "edge_id": "brief_to_builder",
                                                "source": "evidence_reader",
                                                "target": "artifact_builder",
                                                "kind": "evidence_handoff",
                                                "instruction": "Implement the bounded evidence brief.",
                                                "artifact_kinds": ["evidence_brief"],
                                            }],
                                            "entry_role_ids": ["evidence_reader"],
                                            "terminal_role_ids": ["artifact_builder"],
                                        },
                                    },
                                    {
                                        "action_id": "bound_evidence_workshop",
                                        "operation": "modify_policy",
                                        "rationale": "Bound the experiment to two calls.",
                                        "depends_on": ["split_evidence_workshop"],
                                        "payload": {"replacement": {
                                            "inherit_current": True,
                                            "max_parallel_roles": 1,
                                            "max_total_model_calls": 2,
                                            "max_total_cost_units": 2,
                                        }},
                                    },
                                ],
                            },
                            "tags": ["open_topology", "typed_handoff"],
                            "cost_prior": 1.0,
                        }},
                    }],
                }

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=AgentCircuit.singleton(),
            )

            self.assertTrue(update.applied, update.error)
            self.assertIn("evidence_workshop", store.catalog())
            self.assertEqual(store.revision(), 1)

    def test_empty_production_library_cannot_silently_skip_required_exploration(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize(())

            def request(stage, payload):
                return {}

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=AgentCircuit.singleton(),
            )

            self.assertFalse(update.applied)
            self.assertIn("bootstrap circuit", update.error or "")

    def test_discloses_role_harness_catalog_and_rejects_invented_component_ids(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize()

            def request(stage, payload):
                if stage == "shortlist":
                    return {"shortlist": [], "addition_needed": True}
                if stage == "plan":
                    self.assertEqual(
                        payload["audited_role_harness_catalog"]["modules"][0]["id"],
                        "approved_module",
                    )
                else:
                    self.assertEqual(
                        payload["allowed_role_harness_ids"]["modules"][0],
                        "approved_module",
                    )
                action = {
                    "action_id": "invent_role_harness",
                    "operation": "add",
                    "rationale": "Try a role-local specialization.",
                    "evidence_refs": ["inner://epoch/3/result"],
                    "payload": {"transformation": {
                        "id": "invented_role_harness",
                        "name": "Invented role harness",
                        "description": "Must not admit unaudited component references.",
                        "trigger_signals": ["single_agent"],
                        "supported_operations": ["modify_role"],
                        "plan_template": {
                            "shape": "declarative_circuit",
                            "actions": [{
                                "action_id": "specialize",
                                "operation": "modify_role",
                                "rationale": "Specialize the current role.",
                                "payload": {
                                    "role_id": "$primary",
                                    "replacement": {
                                        "inherit_from": "$primary",
                                        "harness_spec": {
                                            "active_module_ids": ["invented_module"]
                                        },
                                    },
                                },
                            }],
                        },
                    }},
                }
                return {"actions": [action]}

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=AgentCircuit.singleton(),
                harness_catalog={
                    "modules": [{"id": "approved_module"}],
                    "elements": [],
                    "tool_interfaces": [],
                    "cordis_plugins": [],
                },
            )

            self.assertFalse(update.applied)
            self.assertIn("unaudited active_module_ids", update.error or "")
            self.assertNotIn("invented_role_harness", store.catalog())

    def test_repairs_one_semantically_invalid_plan_without_relaxing_limits(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize()
            stages = []

            def request(stage, payload):
                stages.append(stage)
                if stage == "shortlist":
                    return {"shortlist": ["single_to_studio", "add_critic_feedback"]}
                if stage == "plan":
                    return {
                        "actions": [{
                            "action_id": "bad_merge",
                            "operation": "merge",
                            "rationale": "Try to consolidate one item.",
                            "evidence_refs": ["inner://epoch/3/result"],
                            "payload": {"source_ids": ["single_to_studio"]},
                        }]
                    }
                self.assertEqual(stage, "plan_repair")
                self.assertIn("at least two known transformations", payload["validation_error"])
                self.assertEqual(
                    payload["outer_action_contract"]["action_required"],
                    [
                        "action_id",
                        "library_operation",
                        "rationale",
                        "evidence_refs",
                        "payload",
                    ],
                )
                self.assertEqual(
                    payload["outer_action_contract"]["library_operations"]["modify"]
                    ["payload_required"],
                    ["transformation_id", "replacement"],
                )
                self.assertEqual(
                    payload["disclosed_transformation_ids"],
                    ["single_to_studio", "add_critic_feedback"],
                )
                self.assertIn("actions", payload["declarative_circuit_schema"])
                self.assertIn(
                    "inner://epoch/3/result", payload["evidence_refs"]
                )
                return {
                    "library_actions": [{
                        "action_id": "drop_unneeded_feedback",
                        "library_operation": "delete",
                        "rationale": "The accepted studio already contains a critic feedback edge.",
                        "evidence_refs": ["inner://epoch/3/result"],
                        "payload": {"transformation_id": "add_critic_feedback"},
                    }]
                }

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=AgentCircuit.singleton(),
            )

            self.assertEqual(stages, ["shortlist", "plan", "plan_repair"])
            self.assertTrue(update.applied)
            self.assertEqual(store.revision(), 1)
            self.assertNotIn("add_critic_feedback", store.catalog())

    def test_disclosed_no_change_requires_an_auditable_rationale(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            store = HarnessTransformationLibraryStore(root)
            store.initialize()
            stages = []

            def request(stage, payload):
                stages.append(stage)
                if stage == "shortlist":
                    return {"shortlist": ["single_to_studio"]}
                if stage == "plan":
                    return {"library_actions": []}
                self.assertEqual(stage, "plan_repair")
                self.assertIn("no_change_rationale", payload["validation_error"])
                return {
                    "library_actions": [],
                    "no_change_rationale": (
                        "The disclosed entry has no attributed use yet, so changing it "
                        "would not be evidence-backed."
                    ),
                }

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=AgentCircuit.singleton(),
            )

            self.assertEqual(stages, ["shortlist", "plan", "plan_repair"])
            self.assertEqual(update.status, "unchanged")
            record = json.loads((root / "epochs/epoch_003.json").read_text())
            self.assertIn("no attributed use", record["plan"]["no_change_rationale"])

    def test_applies_evidence_bound_executable_addition(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize()

            def request(stage, payload):
                if stage == "shortlist":
                    return {
                        "shortlist": ["single_to_studio"],
                        "addition_needed": True,
                        "rationale": "visual score remains imperfect",
                    }
                evidence_ref = (
                    "rubric://epoch/3/case/case-a/soft/visual_quality"
                )
                self.assertIn(evidence_ref, payload["evidence_refs"])
                return {
                    "actions": [
                        {
                            "action_id": "add_visual_specialization",
                            "operation": "add",
                            "rationale": "Repeated visual gaps justify role specialization.",
                            "evidence_refs": [evidence_ref],
                            "payload": {
                                "transformation": {
                                    "id": "visual_review_specialization",
                                    "name": "Visual review specialization",
                                    "description": "Specialize the evidence-selected role for visual review.",
                                    "trigger_signals": ["presentation_gap"],
                                    "supported_operations": ["modify_role"],
                                    "plan_template": {
                                        "shape": "declarative_circuit",
                                        "actions": [{
                                            "action_id": "specialize_visual_review",
                                            "operation": "modify_role",
                                            "rationale": "Target the disclosed presentation gap.",
                                            "payload": {
                                                "role_id": "$primary",
                                                "replacement": {
                                                    "inherit_from": "$primary",
                                                    "system_prompt": "Inspect visual clarity before publishing the build.",
                                                    "capabilities": ["visual_review"]
                                                }
                                            }
                                        }]
                                    },
                                    "tags": ["parallel", "visual"],
                                    "cost_prior": 2.0,
                                }
                            },
                        }
                    ]
                }

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=AgentCircuit.singleton(),
            )

            self.assertTrue(update.applied)
            self.assertEqual(store.revision(), 1)
            self.assertIn("visual_review_specialization", store.catalog())

    def test_rejects_invented_evidence_without_mutating_library(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize()

            def request(stage, _payload):
                if stage == "shortlist":
                    return {"shortlist": ["single_to_studio"]}
                return {
                    "actions": [
                        {
                            "action_id": "delete_studio",
                            "operation": "delete",
                            "rationale": "Invented claim.",
                            "evidence_refs": ["rubric://private/never-disclosed"],
                            "payload": {"transformation_id": "single_to_studio"},
                        }
                    ]
                }

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(accepted=False),
                current_circuit=AgentCircuit.singleton(),
            )

            self.assertFalse(update.applied)
            self.assertIn("undisclosed evidence", update.error or "")
            self.assertEqual(store.revision(), 0)
            self.assertIn("single_to_studio", store.catalog())

    def test_rejects_uncompiled_shape_atomically(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize()

            def request(stage, _payload):
                if stage == "shortlist":
                    return {"shortlist": []}
                return {
                    "actions": [
                        {
                            "action_id": "add_magic",
                            "operation": "add",
                            "rationale": "Try an unsupported executable shape.",
                            "evidence_refs": ["inner://epoch/3/result"],
                            "payload": {
                                "transformation": {
                                    "id": "magic_shape",
                                    "name": "Magic shape",
                                    "description": "Must fail compiler admission.",
                                    "trigger_signals": ["gap"],
                                    "supported_operations": ["add_role"],
                                    "plan_template": {"shape": "not_implemented"},
                                }
                            },
                        }
                    ]
                }

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=AgentCircuit.singleton(),
            )

            self.assertFalse(update.applied)
            self.assertIn("must use declarative_circuit", update.error or "")
            self.assertEqual(store.revision(), 0)
            self.assertNotIn("magic_shape", store.catalog())

    def test_hpa_adds_and_executes_a_novel_declarative_agent_circuit(self):
        with tempfile.TemporaryDirectory() as td:
            store = HarnessTransformationLibraryStore(Path(td))
            store.initialize()

            def request(stage, payload):
                if stage == "shortlist":
                    return {"shortlist": [], "addition_needed": True}
                self.assertEqual(
                    payload["declarative_circuit_schema"]["preferred_shape"],
                    "declarative_circuit",
                )
                return {
                    "actions": [{
                        "action_id": "add_sound_lab",
                        "operation": "add",
                        "rationale": "Imperfect presentation evidence justifies isolated audio ideation and integration.",
                        "evidence_refs": ["rubric://epoch/3/case/case-a/soft/visual_quality"],
                        "payload": {"transformation": {
                            "id": "spawn_sound_lab",
                            "name": "Spawn sound lab",
                            "description": "Create an audio researcher and implementation lead with a typed cue-sheet handoff.",
                            "trigger_signals": ["presentation_gap"],
                            "supported_operations": ["split_role", "modify_policy"],
                            "plan_template": {
                                "shape": "declarative_circuit",
                                "applicability": {"max_roles": 1},
                                "actions": [
                                    {
                                        "action_id": "fork_sound_lab",
                                        "operation": "split_role",
                                        "rationale": "Separate cue research from implementation.",
                                        "payload": {
                                            "source_role_id": "$primary",
                                            "replacement_roles": [
                                                {"role_id": "cue_researcher", "name": "Cue Researcher", "kind": "specialist", "objective": "Design an evidence-linked cue sheet.", "system_prompt": "Publish only a typed cue sheet.", "workspace_access": "read_only", "output_artifact_kinds": ["cue_sheet"], "context": {"mode": "task_only"}},
                                                {"role_id": "audio_implementer", "name": "Audio Implementer", "kind": "integrator", "objective": "Implement and verify the cue sheet.", "system_prompt": "Consume the cue sheet and publish a verified build.", "workspace_access": "read_write", "output_artifact_kinds": ["build"], "context": {"mode": "selected_artifacts", "include_artifact_kinds": ["cue_sheet"]}},
                                            ],
                                            "replacement_edges": [{"edge_id": "cue_sheet_handoff", "source": "cue_researcher", "target": "audio_implementer", "kind": "artifact", "instruction": "Materialize the cue sheet.", "artifact_kinds": ["cue_sheet"]}],
                                            "entry_role_ids": ["cue_researcher"],
                                            "terminal_role_ids": ["audio_implementer"],
                                        },
                                    },
                                    {
                                        "action_id": "fund_sound_lab",
                                        "operation": "modify_policy",
                                        "rationale": "Bound the lab to two calls.",
                                        "depends_on": ["fork_sound_lab"],
                                        "payload": {"replacement": {"inherit_current": True, "max_parallel_roles": 1, "max_total_model_calls": 2, "max_total_cost_units": 2}},
                                    },
                                ],
                            },
                            "tags": ["audio", "novel_topology"],
                            "cost_prior": 1.5,
                        }},
                    }]
                }

            update = HarnessTransformationLibraryAgent(store, request).evolve(
                epoch=3,
                inner_history=[],
                latest_inner_result=result(),
                current_circuit=AgentCircuit.singleton(),
            )

            self.assertTrue(update.applied)
            transformation = store.catalog()["spawn_sound_lab"]
            compiler = HarnessTransformationLibraryAgent(store, request).compiler
            transaction = compiler.compile(
                transformation,
                circuit=AgentCircuit.singleton(),
                evidence_refs=("rubric://epoch/3/case/case-a/soft/visual_quality",),
            )
            candidate = CircuitMutationEngine().apply(
                AgentCircuit.singleton(), transaction
            )
            self.assertEqual(
                {role.role_id for role in candidate.roles},
                {"cue_researcher", "audio_implementer"},
            )
            self.assertEqual(candidate.edges[0].artifact_kinds, ("cue_sheet",))


if __name__ == "__main__":
    unittest.main()
