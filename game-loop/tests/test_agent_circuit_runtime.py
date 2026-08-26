from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path

from game_loop.core.agent_circuit import AgentCircuit, AgentRole, CircuitEdge, CircuitPolicy
from game_loop.core.agent_circuit_runtime import (
    AgentCircuitExecutor,
    CircuitArtifact,
    CircuitRoleRequest,
    CircuitRoleResult,
    FilesystemCircuitWorkspaceManager,
)


def role(role_id: str, kind: str) -> AgentRole:
    return AgentRole(
        role_id=role_id,
        name=role_id.title(),
        kind=kind,
        objective=f"Own {role_id}.",
        system_prompt=f"Run {role_id}.",
    )


def studio_circuit(*, feedback_traversals: int = 1) -> AgentCircuit:
    return AgentCircuit(
        roles=(
            role("director", "director"),
            role("gameplay", "specialist"),
            role("visuals", "specialist"),
            role("integrator", "integrator"),
            role("critic", "critic"),
        ),
        edges=(
            CircuitEdge("to_gameplay", "director", "gameplay", "delegation", "Build mechanics."),
            CircuitEdge("to_visuals", "director", "visuals", "delegation", "Build visuals."),
            CircuitEdge("gameplay_patch", "gameplay", "integrator", "artifact", "Merge mechanics.", ("patch",)),
            CircuitEdge("visual_patch", "visuals", "integrator", "artifact", "Merge visuals.", ("patch",)),
            CircuitEdge("review", "integrator", "critic", "review", "Review build.", ("build",)),
            CircuitEdge("fix", "critic", "integrator", "feedback", "Fix review findings.", ("review",), max_traversals=feedback_traversals),
        ),
        entry_role_ids=("director",),
        terminal_role_ids=("critic",),
        policy=CircuitPolicy(
            max_parallel_roles=2,
            max_total_model_calls=9,
            max_total_cost_units=9,
        ),
    )


class RecordingRunner:
    def __init__(self):
        self.requests: list[CircuitRoleRequest] = []
        self.lock = threading.Lock()

    def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
        with self.lock:
            self.requests.append(request)
        if request.role.role_id in {"gameplay", "visuals"}:
            time.sleep(0.03)
            patch = request.workspace / f"{request.role.role_id}.patch"
            patch.write_text(request.role.role_id, encoding="utf-8")
            artifacts = (CircuitArtifact("patch", request.role.role_id, path=patch.name),)
        elif request.role.role_id == "integrator":
            build = request.workspace / "game.zip"
            build.write_text("merged", encoding="utf-8")
            artifacts = (CircuitArtifact("build", "integrator", path=build.name),)
        elif request.role.role_id == "critic":
            artifacts = (
                CircuitArtifact("review", "critic", content="fix collision feedback"),
            )
        else:
            artifacts = ()
        critic_attempts = sum(
            item.role.role_id == "critic" for item in self.requests
        )
        return CircuitRoleResult(
            role_id=request.role.role_id,
            status="completed",
            summary=f"{request.role.role_id} complete",
            artifacts=artifacts,
            model_calls=1,
            cost_units=1,
            feedback_requested=(request.role.role_id == "critic" and critic_attempts == 1),
        )


class AgentCircuitExecutorTests(unittest.TestCase):
    def _executor(self, root: Path, runner) -> AgentCircuitExecutor:
        source = root / "source"
        source.mkdir()
        (source / "project.godot").write_text("[application]", encoding="utf-8")
        return AgentCircuitExecutor(
            runner=runner,
            workspace_manager=FilesystemCircuitWorkspaceManager(
                source_workspace=source,
                run_root=root / "run",
            ),
        )

    def test_runs_parallel_specialists_typed_handoffs_and_feedback(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            runner = RecordingRunner()
            started = time.monotonic()

            result = self._executor(root, runner).run(
                studio_circuit(), task="Build a polished platformer."
            )

            self.assertEqual(result.status, "completed")
            self.assertTrue(result.infrastructure_ok)
            self.assertEqual(result.role_attempts["integrator"], 2)
            self.assertEqual(result.role_attempts["critic"], 2)
            self.assertEqual(result.model_calls, 7)
            self.assertLess(time.monotonic() - started, 0.058)
            first_integrator = next(
                item for item in runner.requests if item.role.role_id == "integrator"
            )
            self.assertEqual(
                {item.producer_role_id for item in first_integrator.artifacts},
                {"gameplay", "visuals"},
            )
            feedback_integrator = [
                item for item in runner.requests if item.role.role_id == "integrator"
            ][1]
            self.assertEqual(feedback_integrator.feedback_from, "critic")
            self.assertIn("critic", feedback_integrator.upstream_summaries)

    def test_blocks_required_handoff_after_runner_failure(self):
        class FailingRunner(RecordingRunner):
            def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
                if request.role.role_id == "visuals":
                    return CircuitRoleResult(
                        role_id="visuals",
                        status="failed",
                        summary="",
                        error="runner exception: visual service unavailable",
                    )
                return super().run_role(request)

        with tempfile.TemporaryDirectory() as td:
            result = self._executor(Path(td), FailingRunner()).run(
                studio_circuit(), task="Build game."
            )

            self.assertEqual(result.status, "failed")
            self.assertFalse(result.infrastructure_ok)
            self.assertTrue(any("visuals" in reason for reason in result.reasons))

    def test_rejects_artifact_path_outside_isolated_workspace(self):
        class EscapingRunner(RecordingRunner):
            def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
                return CircuitRoleResult(
                    role_id=request.role.role_id,
                    status="completed",
                    summary="bad",
                    artifacts=(CircuitArtifact("patch", request.role.role_id, path="../../escape"),),
                    model_calls=1,
                    cost_units=1,
                )

        with tempfile.TemporaryDirectory() as td:
            circuit = AgentCircuit.singleton()
            result = self._executor(Path(td), EscapingRunner()).run(circuit, task="Build.")

            self.assertEqual(result.status, "failed")
            self.assertFalse(result.infrastructure_ok)
            self.assertIn("escapes", result.reasons[0])

    def test_budget_exhaustion_is_not_formal_circuit_evidence(self):
        class OverBudgetRunner(RecordingRunner):
            def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
                return CircuitRoleResult(
                    role_id=request.role.role_id,
                    status="completed",
                    summary="used too many calls",
                    model_calls=request.role.budget.max_model_calls + 1,
                    cost_units=request.role.budget.cost_units,
                )

        with tempfile.TemporaryDirectory() as td:
            result = self._executor(Path(td), OverBudgetRunner()).run(
                AgentCircuit.singleton(), task="Build."
            )

            self.assertEqual(result.status, "failed")
            self.assertFalse(result.infrastructure_ok)
            self.assertIn("model-call budget", result.reasons[0])

    def test_feedback_permission_comes_from_edge_protocol_not_role_kind(self):
        class ProtocolRunner(RecordingRunner):
            def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
                return CircuitRoleResult(
                    role_id=request.role.role_id,
                    status="completed",
                    summary="done",
                    model_calls=1,
                    cost_units=1,
                    feedback_requested=(
                        request.may_request_feedback and request.attempt == 1
                    ),
                )

        with tempfile.TemporaryDirectory() as td:
            roles = (
                role("builder", "synthesis_node"),
                role("judge", "embodied_quality_gate"),
            )
            circuit = AgentCircuit(
                roles=roles,
                edges=(
                    CircuitEdge("inspect", "builder", "judge", "trial", "Inspect."),
                    CircuitEdge(
                        "retry",
                        "judge",
                        "builder",
                        "repair_signal",
                        "Repair.",
                        protocol="feedback",
                    ),
                ),
                entry_role_ids=("builder",),
                terminal_role_ids=("judge",),
                policy=CircuitPolicy(
                    max_total_model_calls=4,
                    max_total_cost_units=4,
                ),
            )
            runner = ProtocolRunner()

            result = self._executor(Path(td), runner).run(circuit, task="Build.")

            judge_requests = [
                item for item in runner.requests if item.role.role_id == "judge"
            ]
            # ProtocolRunner overrides request recording, so inspect the run history
            # through role attempts and verify the bounded loop executed.
            self.assertEqual(result.role_attempts, {"builder": 2, "judge": 2})

    def test_feedback_defers_downstream_release_until_verification_passes(self):
        class RevisionRunner:
            def __init__(self):
                self.requests: list[CircuitRoleRequest] = []
                self.packager_inputs: list[str] = []

            def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
                self.requests.append(request)
                if request.role.role_id == "builder":
                    marker = f"revision-{request.attempt}"
                    (request.workspace / "revision.txt").write_text(
                        marker, encoding="utf-8"
                    )
                    artifacts = (
                        CircuitArtifact(
                            "workspace_snapshot",
                            "builder",
                            path=".",
                            metadata={"workspace_snapshot": True},
                        ),
                    )
                    feedback_requested = False
                elif request.role.role_id == "verifier":
                    marker = (request.workspace / "revision.txt").read_text(
                        encoding="utf-8"
                    )
                    artifacts = (
                        CircuitArtifact("report", "verifier", content=marker),
                        CircuitArtifact(
                            "verified_workspace",
                            "verifier",
                            path=".",
                            metadata={"workspace_snapshot": True},
                        ),
                        CircuitArtifact(
                            "failure_digest",
                            "verifier",
                            content="revise" if request.attempt == 1 else "passed",
                        ),
                    )
                    feedback_requested = request.attempt == 1
                else:
                    marker = (request.workspace / "revision.txt").read_text(
                        encoding="utf-8"
                    )
                    self.packager_inputs.append(marker)
                    artifacts = (
                        CircuitArtifact(
                            "artifact_bundle",
                            "packager",
                            path=".",
                            metadata={"workspace_snapshot": True},
                        ),
                    )
                    feedback_requested = False
                return CircuitRoleResult(
                    role_id=request.role.role_id,
                    status="completed",
                    summary=f"{request.role.role_id} complete",
                    artifacts=artifacts,
                    model_calls=1,
                    cost_units=1,
                    feedback_requested=feedback_requested,
                )

        with tempfile.TemporaryDirectory() as td:
            builder = AgentRole(
                role_id="builder",
                name="Builder",
                kind="maker_node",
                objective="Build.",
                system_prompt="Build and publish.",
                output_artifact_kinds=("workspace_snapshot",),
                output_artifact_modes={"workspace_snapshot": "workspace"},
            )
            verifier = AgentRole(
                role_id="verifier",
                name="Verifier",
                kind="quality_gate",
                objective="Verify.",
                system_prompt="Verify and request bounded feedback.",
                output_artifact_kinds=(
                    "failure_digest",
                    "report",
                    "verified_workspace",
                ),
                output_artifact_modes={"verified_workspace": "workspace"},
            )
            packager = AgentRole(
                role_id="packager",
                name="Packager",
                kind="release_node",
                objective="Package.",
                system_prompt="Package only verified work.",
                output_artifact_kinds=("artifact_bundle",),
                output_artifact_modes={"artifact_bundle": "workspace"},
            )
            circuit = AgentCircuit(
                roles=(builder, verifier, packager),
                edges=(
                    CircuitEdge(
                        "build_to_verify",
                        "builder",
                        "verifier",
                        "forward",
                        "Verify build.",
                        ("workspace_snapshot",),
                    ),
                    CircuitEdge(
                        "verify_to_package",
                        "verifier",
                        "packager",
                        "forward",
                        "Package verified build.",
                        ("report", "verified_workspace"),
                    ),
                    CircuitEdge(
                        "verify_feedback",
                        "verifier",
                        "builder",
                        "feedback",
                        "Repair findings.",
                        ("failure_digest",),
                        max_traversals=1,
                    ),
                ),
                entry_role_ids=("builder",),
                terminal_role_ids=("packager",),
                policy=CircuitPolicy(
                    max_total_model_calls=5,
                    max_total_cost_units=5,
                    workspace_mode="isolated_then_merge",
                ),
            )
            runner = RevisionRunner()

            result = self._executor(Path(td), runner).run(circuit, task="Build.")

            self.assertEqual(result.status, "completed")
            self.assertEqual(
                result.role_attempts,
                {"builder": 2, "verifier": 2, "packager": 1},
            )
            self.assertEqual(runner.packager_inputs, ["revision-2"])
            self.assertEqual(
                [item.role.role_id for item in runner.requests],
                ["builder", "verifier", "builder", "verifier", "packager"],
            )

    def test_exhausted_feedback_never_publishes_stale_terminal(self):
        class AlwaysReviseRunner:
            def __init__(self):
                self.packager_calls = 0

            def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
                if request.role.role_id == "packager":
                    self.packager_calls += 1
                return CircuitRoleResult(
                    role_id=request.role.role_id,
                    status="completed",
                    summary="revise",
                    model_calls=1,
                    cost_units=1,
                    feedback_requested=request.role.role_id == "verifier",
                )

        with tempfile.TemporaryDirectory() as td:
            roles = (
                role("builder", "maker_node"),
                role("verifier", "quality_gate"),
                role("packager", "release_node"),
            )
            circuit = AgentCircuit(
                roles=roles,
                edges=(
                    CircuitEdge(
                        "build_to_verify", "builder", "verifier", "forward", "Verify."
                    ),
                    CircuitEdge(
                        "verify_to_package",
                        "verifier",
                        "packager",
                        "forward",
                        "Package.",
                    ),
                    CircuitEdge(
                        "retry",
                        "verifier",
                        "builder",
                        "feedback",
                        "Repair.",
                        max_traversals=1,
                    ),
                ),
                entry_role_ids=("builder",),
                terminal_role_ids=("packager",),
                policy=CircuitPolicy(
                    max_total_model_calls=4,
                    max_total_cost_units=4,
                ),
            )
            runner = AlwaysReviseRunner()

            result = self._executor(Path(td), runner).run(circuit, task="Build.")

            self.assertEqual(result.status, "failed")
            self.assertTrue(result.infrastructure_ok)
            self.assertEqual(runner.packager_calls, 0)
            self.assertEqual(result.artifacts, ())
            self.assertIn(
                "feedback traversal budget exhausted on edge retry",
                result.reasons,
            )

    def test_linear_workspace_handoff_continues_from_producer_snapshot(self):
        class WorkspaceRunner:
            def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
                if request.role.role_id == "producer":
                    (request.workspace / "producer-change.txt").write_text(
                        "preserved", encoding="utf-8"
                    )
                    for runtime_root in (
                        ".circuit_config",
                        ".circuit_home",
                        ".circuit_sessions",
                        ".godot",
                        "handoffs",
                    ):
                        marker = request.workspace / runtime_root / "private-state.json"
                        marker.parent.mkdir(parents=True, exist_ok=True)
                        marker.write_text("{}", encoding="utf-8")
                else:
                    if not (request.workspace / "producer-change.txt").is_file():
                        return CircuitRoleResult(
                            role_id="consumer",
                            status="failed",
                            summary="",
                            error="producer workspace was not merged",
                        )
                    (request.workspace / "consumer-check.txt").write_text(
                        "verified", encoding="utf-8"
                    )
                return CircuitRoleResult(
                    role_id=request.role.role_id,
                    status="completed",
                    summary="done",
                    artifacts=(CircuitArtifact(
                        "working_tree",
                        request.role.role_id,
                        path=".",
                        metadata={"workspace_snapshot": True},
                    ),),
                    model_calls=1,
                    cost_units=1,
                )

        with tempfile.TemporaryDirectory() as td:
            producer = AgentRole(
                role_id="producer",
                name="Producer",
                kind="artifact_composer",
                objective="Compose the artifact.",
                system_prompt="Compose and publish.",
                output_artifact_kinds=("working_tree",),
                output_artifact_modes={"working_tree": "workspace"},
            )
            consumer = AgentRole(
                role_id="consumer",
                name="Consumer",
                kind="artifact_verifier",
                objective="Verify the artifact.",
                system_prompt="Verify and publish.",
                output_artifact_kinds=("working_tree",),
                output_artifact_modes={"working_tree": "workspace"},
            )
            circuit = AgentCircuit(
                roles=(producer, consumer),
                edges=(CircuitEdge(
                    "workspace_handoff",
                    "producer",
                    "consumer",
                    "verification_input",
                    "Verify this working tree.",
                    ("working_tree",),
                ),),
                entry_role_ids=("producer",),
                terminal_role_ids=("consumer",),
                policy=CircuitPolicy(
                    max_total_model_calls=2,
                    max_total_cost_units=2,
                    workspace_mode="isolated_then_merge",
                ),
            )

            result = self._executor(Path(td), WorkspaceRunner()).run(
                circuit, task="Build and verify."
            )

            self.assertEqual(result.status, "completed")
            consumer_workspace = Path(result.role_workspaces["consumer"])
            self.assertEqual(
                (consumer_workspace / "producer-change.txt").read_text(
                    encoding="utf-8"
                ),
                "preserved",
            )
            for runtime_root in (
                ".circuit_config",
                ".circuit_home",
                ".circuit_sessions",
                ".godot",
                "handoffs",
            ):
                self.assertFalse(
                    (consumer_workspace / runtime_root / "private-state.json").exists(),
                    runtime_root,
                )

    def test_read_only_role_cannot_modify_workspace_sources(self):
        class MutatingReader:
            def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
                (request.workspace / "unauthorized.txt").write_text(
                    "changed", encoding="utf-8"
                )
                return CircuitRoleResult(
                    role_id=request.role.role_id,
                    status="completed",
                    summary="changed it",
                    model_calls=1,
                    cost_units=1,
                )

        with tempfile.TemporaryDirectory() as td:
            reader = AgentRole(
                role_id="reader",
                name="Reader",
                kind="evidence_reader",
                objective="Inspect without editing.",
                system_prompt="Read only.",
                workspace_access="read_only",
            )
            circuit = AgentCircuit(
                roles=(reader,),
                edges=(),
                entry_role_ids=("reader",),
                terminal_role_ids=("reader",),
                policy=CircuitPolicy(
                    max_total_model_calls=1,
                    max_total_cost_units=1,
                ),
            )

            result = self._executor(Path(td), MutatingReader()).run(
                circuit, task="Inspect."
            )

            self.assertEqual(result.status, "failed")
            self.assertTrue(result.infrastructure_ok)
            self.assertIn("read-only", result.reasons[0])

    def test_read_only_role_ignores_runtime_owned_state(self):
        class RuntimeStateReader:
            def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
                for directory in (
                    ".circuit_config",
                    ".circuit_sessions",
                    ".circuit_home",
                    ".godot",
                    "handoffs",
                ):
                    state = request.workspace / directory / "state.json"
                    state.parent.mkdir(parents=True, exist_ok=True)
                    state.write_text("{}", encoding="utf-8")
                return CircuitRoleResult(
                    role_id=request.role.role_id,
                    status="completed",
                    summary="inspected without changing project sources",
                    model_calls=1,
                    cost_units=1,
                )

        with tempfile.TemporaryDirectory() as td:
            reader = AgentRole(
                role_id="reader",
                name="Reader",
                kind="evidence_reader",
                objective="Inspect without editing.",
                system_prompt="Read only.",
                workspace_access="read_only",
            )
            circuit = AgentCircuit(
                roles=(reader,),
                edges=(),
                entry_role_ids=("reader",),
                terminal_role_ids=("reader",),
                policy=CircuitPolicy(
                    max_total_model_calls=1,
                    max_total_cost_units=1,
                ),
            )

            result = self._executor(Path(td), RuntimeStateReader()).run(
                circuit, task="Inspect."
            )

            self.assertEqual(result.status, "completed")


if __name__ == "__main__":
    unittest.main()
