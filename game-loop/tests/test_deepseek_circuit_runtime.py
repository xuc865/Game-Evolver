from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from game_loop.core.agent_circuit import AgentBudget, AgentRole, RoleHarnessSpec
from game_loop.core.agent_circuit_runtime import CircuitArtifact, CircuitRoleRequest
from game_loop.runtime.deepseek_circuit import DeepSeekCircuitRoleRunner
from game_loop.runtime.deepseek_harness import (
    DeepSeekHarnessRunnerResult,
    DeepSeekHarnessRuntimeConfig,
)


class FakeRunner:
    def __init__(
        self,
        response: str = "Reviewed.\nCIRCUIT_STATUS: REVISE",
        finish_reason: str = "completed",
    ):
        self.response = response
        self.finish_reason = finish_reason
        self.calls = []

    def run(self, prompt, **kwargs):
        self.calls.append((prompt, kwargs))
        return DeepSeekHarnessRunnerResult(
            finish_reason=self.finish_reason,
            final_response=self.response,
            events=(
                {"data": {"turn": 1, "step": 1, "usage": {"inputTokens": 7, "outputTokens": 3}}},
            ),
        )


class DeepSeekCircuitRoleRunnerTests(unittest.TestCase):
    def test_read_only_role_receives_an_explicit_enforced_boundary(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeRunner("Published inline evidence.")
            role = AgentRole(
                role_id="inspector",
                name="Inspector",
                kind="auditor",
                objective="Inspect without editing.",
                system_prompt="Report concrete findings.",
                workspace_access="read_only",
                output_artifact_kinds=("evidence",),
            )

            DeepSeekCircuitRoleRunner(
                DeepSeekHarnessRuntimeConfig(backbone_provider=None),
                runner=fake,
            ).run_role(CircuitRoleRequest("Inspect.", role, Path(td), attempt=1))

            prompt = fake.calls[0][0]
            self.assertIn("## Enforced read-only boundary", prompt)
            self.assertIn("Do not apply patches", prompt)
            self.assertIn("temporary copy outside the assigned workspace", prompt)
            self.assertIn("runtime will reject this role", prompt)

    def test_custom_workspace_artifact_contract_materializes_role_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            role = AgentRole(
                role_id="publisher",
                name="Publisher",
                kind="verified_release_materializer",
                objective="Publish a verified game.",
                system_prompt="Verify the workspace and publish it.",
                output_artifact_kinds=("verified_artifact",),
                output_artifact_modes={"verified_artifact": "workspace"},
            )
            result = DeepSeekCircuitRoleRunner(
                DeepSeekHarnessRuntimeConfig(
                    backbone_provider=None,
                    cordis=None,
                    runtime_cwd=str(Path(td)),
                ),
                runner=FakeRunner("Published."),
            ).run_role(
                CircuitRoleRequest("Publish.", role, Path(td), attempt=1)
            )

            self.assertEqual(result.artifacts[0].kind, "verified_artifact")
            self.assertEqual(result.artifacts[0].path, ".")
            self.assertTrue(result.artifacts[0].metadata["workspace_snapshot"])

    def test_role_runtime_honors_remaining_circuit_deadline(self):
        with tempfile.TemporaryDirectory() as td:
            role = AgentRole(
                role_id="worker",
                name="Worker",
                kind="worker",
                objective="Work within the remaining deadline.",
                system_prompt="Finish promptly.",
                budget=AgentBudget(timeout_seconds=1200),
            )
            fake = FakeRunner("Done.")
            DeepSeekCircuitRoleRunner(
                DeepSeekHarnessRuntimeConfig(
                    backbone_provider=None,
                    timeout_seconds=1200,
                ),
                runner=fake,
            ).run_role(CircuitRoleRequest(
                "Work.",
                role,
                Path(td),
                attempt=1,
                runtime_timeout_seconds=17,
            ))

            self.assertEqual(fake.calls[0][1]["config"].timeout_seconds, 17)

    def test_compiles_isolated_role_context_and_critic_verdict(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            upstream = workspace / "handoffs" / "game.zip"
            upstream.parent.mkdir()
            upstream.write_text("game", encoding="utf-8")
            role = AgentRole(
                role_id="critic",
                name="Playtester",
                kind="critic",
                objective="Deep-play the build.",
                system_prompt="Inspect real gameplay evidence.",
                budget=AgentBudget(max_tokens=1000, timeout_seconds=90),
            )
            request = CircuitRoleRequest(
                task="Build a platformer.",
                role=role,
                workspace=workspace,
                attempt=1,
                edge_instructions=("Review the integrated build.",),
                upstream_summaries={"integrator": "Build completed."},
                artifacts=(CircuitArtifact("build", "integrator", path="handoffs/game.zip"),),
                may_request_feedback=True,
            )
            fake = FakeRunner()
            runner = DeepSeekCircuitRoleRunner(
                DeepSeekHarnessRuntimeConfig(
                    backbone_provider=None,
                    max_tokens=2000,
                    timeout_seconds=120,
                ),
                runner=fake,
            )

            result = runner.run_role(request)

            self.assertEqual(result.status, "completed")
            self.assertTrue(result.feedback_requested)
            self.assertEqual(result.tokens, 10)
            self.assertEqual(result.artifacts[0].kind, "review")
            prompt, kwargs = fake.calls[0]
            self.assertIn("Role: Playtester", prompt)
            self.assertIn("handoffs/game.zip", prompt)
            self.assertIn("CIRCUIT_STATUS: PASS", prompt)
            self.assertEqual(kwargs["config"].max_tokens, 1000)
            self.assertEqual(kwargs["config"].timeout_seconds, 90)
            self.assertEqual(kwargs["cwd"], workspace)
            self.assertTrue(kwargs["session_root"].is_relative_to(workspace))

    def test_specialist_publishes_workspace_patch(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            role = AgentRole(
                role_id="visuals",
                name="Visual Designer",
                kind="specialist",
                objective="Improve presentation.",
                system_prompt="Edit visual assets.",
            )
            runner = DeepSeekCircuitRoleRunner(
                DeepSeekHarnessRuntimeConfig(backbone_provider=None),
                runner=FakeRunner("Visual pass complete."),
            )

            result = runner.run_role(
                CircuitRoleRequest("Build.", role, workspace, attempt=1)
            )

            self.assertEqual(result.artifacts[0].kind, "patch")
            self.assertEqual(result.artifacts[0].path, ".")

    def test_hpa_declared_output_contract_publishes_custom_typed_artifact(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            role = AgentRole(
                role_id="cue_researcher",
                name="Cue Researcher",
                kind="specialist",
                objective="Design a cue sheet.",
                system_prompt="Describe timing, source, and intensity.",
                output_artifact_kinds=("cue_sheet",),
            )
            fake = FakeRunner("Cue sheet: jump=bright; damage=low pulse")
            runner = DeepSeekCircuitRoleRunner(
                DeepSeekHarnessRuntimeConfig(backbone_provider=None),
                runner=fake,
            )

            result = runner.run_role(
                CircuitRoleRequest("Improve audio.", role, workspace, attempt=1)
            )

            self.assertEqual(len(result.artifacts), 1)
            self.assertEqual(result.artifacts[0].kind, "cue_sheet")
            self.assertIn("jump=bright", result.artifacts[0].content or "")
            self.assertIn("cue_sheet", fake.calls[0][0])

    def test_sibling_roles_materialize_distinct_inherited_cordis_harnesses(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            seed = root / "seed.cordis.yml"
            seed.write_text("- id: seed\n  name: '@deepseek-ai/dsh-seed'\n")
            config = DeepSeekHarnessRuntimeConfig(
                backbone_provider=None,
                cordis=str(seed),
                cordis_seed=str(seed),
                cordis_plugin_catalog={
                    "llm_retry": [{"id": "evolved-retry", "name": "@deepseek-ai/dsh-retry"}],
                    "context_efficiency_guards": [{"id": "evolved-context", "name": "@deepseek-ai/dsh-context"}],
                },
                active_cordis_plugins=("llm_retry", "context_efficiency_guards"),
            )
            builder = AgentRole(
                role_id="builder",
                name="Builder",
                kind="specialist",
                objective="Build.",
                system_prompt="Publish a patch.",
                harness_spec=RoleHarnessSpec(
                    source_harness_id="parent-dsh",
                    active_cordis_plugins=("llm_retry", "context_efficiency_guards"),
                ),
            )
            reviewer = AgentRole(
                role_id="reviewer",
                name="Reviewer",
                kind="critic",
                objective="Review.",
                system_prompt="Publish a review.",
                harness_spec=RoleHarnessSpec(
                    source_harness_id="parent-dsh",
                    active_cordis_plugins=("context_efficiency_guards",),
                ),
            )
            runner = DeepSeekCircuitRoleRunner(config, runner=FakeRunner("Done."))

            builder_result = runner.run_role(
                CircuitRoleRequest("Build.", builder, root / "builder", attempt=1)
            )
            reviewer_result = runner.run_role(
                CircuitRoleRequest("Review.", reviewer, root / "reviewer", attempt=1)
            )

            self.assertNotEqual(
                builder_result.effective_cordis_hash,
                reviewer_result.effective_cordis_hash,
            )
            builder_cordis = next((root / "builder" / ".circuit_config").glob("*.yml")).read_text()
            reviewer_cordis = next((root / "reviewer" / ".circuit_config").glob("*.yml")).read_text()
            self.assertIn("evolved-retry", builder_cordis)
            self.assertIn("evolved-context", builder_cordis)
            self.assertNotIn("evolved-retry", reviewer_cordis)
            self.assertIn("evolved-context", reviewer_cordis)
            self.assertTrue(
                (builder_result.effective_harness_hash or "").startswith(
                    "effective-role-harness-"
                )
            )
            self.assertNotEqual(
                builder_result.effective_harness_hash,
                reviewer_result.effective_harness_hash,
            )

    def test_role_local_modules_elements_and_interfaces_are_executable_prompt_state(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = FakeRunner("Done.")
            config = DeepSeekHarnessRuntimeConfig(
                backbone_provider=None,
                harness_module_catalog={
                    "evidence_first": {
                        "id": "evidence_first",
                        "category": "workflow",
                        "instruction": "Inspect runtime evidence before editing.",
                    }
                },
                harness_element_catalog={
                    "visual_probe": {
                        "element_id": "visual_probe",
                        "category": "skill",
                        "description": "Capture one bounded gameplay frame.",
                        "spec": {"frames": 1},
                    }
                },
                harness_tool_interface_catalog={
                    "scene_tree": {
                        "interface_id": "scene_tree",
                        "kind": "mcp",
                        "description": "Inspect the live scene tree.",
                    }
                },
            )
            role = AgentRole(
                role_id="inspector",
                name="Inspector",
                kind="specialist",
                objective="Inspect the game.",
                system_prompt="Publish evidence.",
                tool_interface_ids=("scene_tree",),
                harness_spec=RoleHarnessSpec(
                    source_harness_id="parent-dsh",
                    active_module_ids=("evidence_first",),
                    active_element_ids=("visual_probe",),
                ),
            )

            result = DeepSeekCircuitRoleRunner(config, runner=fake).run_role(
                CircuitRoleRequest("Inspect.", role, root, attempt=1)
            )

            prompt = fake.calls[0][0]
            self.assertIn("Inspect runtime evidence before editing.", prompt)
            self.assertIn("Capture one bounded gameplay frame.", prompt)
            self.assertIn('policy={"frames":1}', prompt)
            self.assertIn("Inspect the live scene tree.", prompt)
            self.assertNotEqual(result.effective_harness_hash, role.effective_harness_hash)

            changed = replace(
                config,
                harness_module_catalog={
                    "evidence_first": {
                        "id": "evidence_first",
                        "category": "workflow",
                        "instruction": "Inspect two independent traces before editing.",
                    }
                },
            )
            changed_result = DeepSeekCircuitRoleRunner(
                changed, runner=FakeRunner("Done.")
            ).run_role(CircuitRoleRequest("Inspect.", role, root / "changed", attempt=1))
            self.assertNotEqual(
                result.effective_harness_hash,
                changed_result.effective_harness_hash,
            )

    def test_unresolved_role_harness_component_fails_before_model_call(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeRunner("should not run")
            role = AgentRole(
                role_id="maker",
                name="Maker",
                kind="operator",
                objective="Build.",
                system_prompt="Build.",
                harness_spec=RoleHarnessSpec(active_module_ids=("missing",)),
            )
            with self.assertRaisesRegex(ValueError, "unresolved modules"):
                DeepSeekCircuitRoleRunner(
                    DeepSeekHarnessRuntimeConfig(backbone_provider=None),
                    runner=fake,
                ).run_role(CircuitRoleRequest("Build.", role, Path(td), attempt=1))
            self.assertEqual(fake.calls, [])

    def test_incomplete_sdk_session_is_infrastructure_failure(self):
        with tempfile.TemporaryDirectory() as td:
            role = AgentRole(
                role_id="maker",
                name="Maker",
                kind="operator",
                objective="Build the game.",
                system_prompt="Implement and verify.",
            )
            runner = DeepSeekCircuitRoleRunner(
                DeepSeekHarnessRuntimeConfig(backbone_provider=None),
                runner=FakeRunner("Partial work.", finish_reason="timeout"),
            )

            result = runner.run_role(
                CircuitRoleRequest("Build.", role, Path(td), attempt=1)
            )

            self.assertEqual(result.status, "failed")
            self.assertFalse(result.infrastructure_ok)
            self.assertIn("timeout", result.error or "")


if __name__ == "__main__":
    unittest.main()
