from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from game_loop.config import GateConfig
from game_loop.core.models import (
    ArtifactDescriptor,
    AttemptContext,
    BackendExecution,
    CandidateResult,
    EvaluationResult,
    GateResult,
    PreparedTask,
)
from game_loop.gates import common_gate, merge_gates
from game_loop.utils import read_json

from .base import BenchmarkAdapter


class TinyMMOAdapter(BenchmarkAdapter):
    """Large-project adapter for improving the Godot Tiny MMO codebase."""

    adapter_id = "tinymmo"
    capabilities = {
        "score_topology": "continuous_multi_objective",
        "natural_terminal_condition": False,
        "evaluation_coupling": "project_regression_and_deterministic_quality_contract",
        "behavior_evidence": True,
        "hidden_evaluator": False,
        "official_implementation_bundled": False,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="godot_mmo_repository",
        ignore_patterns=(
            ".git/**",
            ".godot/**",
            "data/local/**",
            "exports/**",
            "*.db",
            "*.log",
            "addons/godot-sqlite/bin/**",
            "tools/**",
        ),
        component_patterns={
            "client": ("source/client/**",),
            "shared_gameplay": ("source/common/gameplay/**",),
            "networking": ("source/common/network/**",),
            "servers": ("source/server/**",),
        },
    )
    required_command_fields = frozenset(
        {
            "candidate_workspace",
            "agent_cwd",
            "artifact_path",
            "instruction_file",
            "output_manifest",
            "evaluation_path",
            "task_id",
        }
    )

    def doctor(self) -> dict[str, Any]:
        dependency = self._dependency_root()
        return {
            "adapter": self.adapter_id,
            "capabilities": self.capabilities,
            "godot_available": self._godot_binary() is not None,
            "godot_binary": self._godot_binary(),
            "runtime_dependency_root": str(dependency),
            "runtime_dependency_ready": (
                dependency / "addons/godot-sqlite/gdsqlite.gdextension"
            ).is_file(),
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        status = str(value.get("status", "infrastructure_failure"))
        score = value.get("primary_score")
        objectives = {
            str(name): float(metric)
            for name, metric in value.get("objectives", {}).items()
        }
        constraints = {
            str(name): bool(passed)
            for name, passed in value.get("constraints", {}).items()
        }
        feasible = (
            status == "completed"
            and score is not None
            and bool(constraints)
            and all(constraints.values())
        )
        return EvaluationResult(
            primary_score=None if score is None else float(score),
            feasible=feasible,
            objectives=objectives,
            constraints=constraints,
            diagnostics=[str(item) for item in value.get("diagnostics", [])][:10],
            evaluator={
                "name": "Tiny MMO deterministic project-quality evaluator",
                "implementation": "game-loop/tinymmo-v1",
                "upstream": "SlayHorizon/godot-tiny-mmo@f4ed04f",
            },
            terminal_success=False,
            raw_result_ref=str(path.resolve()),
        )

    def prepare(
        self,
        *,
        task_source: Path,
        parent_artifact: Path,
        feedback: dict[str, Any],
        candidate_dir: Path,
        context: AttemptContext,
    ) -> PreparedTask:
        workspace = candidate_dir / "workspace"
        project = workspace / "project"
        project.mkdir(parents=True, exist_ok=True)
        self.stage_artifact(parent_artifact, project)
        self._install_runtime_dependency(project)
        self._install_godot_wrapper(project)

        task_text = task_source.resolve().read_text(encoding="utf-8").strip()
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        instruction = workspace / "instruction.md"
        instruction.write_text(
            "# Tiny MMO Improvement Task\n\n"
            + task_text
            + "\n\n## Harness Guidance\n\n"
            + (rendered or "Inspect evidence, make a bounded improvement, and verify regressions.")
            + "\n\n## Boundaries\n\n"
            "Work only inside the project. Preserve the client/gateway/master/world-server architecture, "
            "the byte-packed protocol, and existing gameplay. Do not edit evaluator or task infrastructure. "
            "Run Godot checks and add deterministic project-local tests for the behavior you change.\n",
            encoding="utf-8",
        )
        output_manifest = candidate_dir / "tinymmo_execution.json"
        evaluation_path = candidate_dir / "tinymmo_evaluation.json"
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "candidate_workspace": str(project.resolve()),
                "agent_cwd": str(project.resolve()),
                "artifact_path": str(project.resolve()),
                "instruction_file": str(instruction.resolve()),
                "output_manifest": str(output_manifest.resolve()),
                "evaluation_path": str(evaluation_path.resolve()),
                "task_id": context.run_id,
            },
            {
                "candidate_dir": str(candidate_dir.resolve()),
                "output_manifest": str(output_manifest.resolve()),
            },
        )

    def collect(self, prepared: PreparedTask, execution: BackendExecution) -> CandidateResult:
        manifest_path = Path(prepared.metadata["output_manifest"])
        if not manifest_path.is_file():
            return CandidateResult(
                None,
                None,
                execution.error or "Tiny MMO execution manifest is missing",
            )
        manifest = read_json(manifest_path)
        artifact = Path(str(manifest.get("artifact_path", "")))
        evaluation_path = Path(str(manifest.get("evaluation_path", "")))
        if str(manifest.get("status")) != "completed" or not evaluation_path.is_file():
            return CandidateResult(
                None,
                None,
                str(manifest.get("error", "Tiny MMO evaluator did not complete")),
                evaluator_queries=1,
            )
        if not artifact.is_dir():
            return CandidateResult(
                None, None, "Tiny MMO candidate artifact is missing", evaluator_queries=1
            )
        evaluation = self.parse_evaluation(evaluation_path)
        collected = Path(prepared.metadata["candidate_dir"]) / "collected_artifact"
        self.stage_artifact(artifact, collected)
        return CandidateResult(
            collected,
            evaluation,
            None if evaluation.primary_score is not None else "Tiny MMO score is missing",
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        required = (
            "project.godot",
            "source/common/main.tscn",
            "source/client/client_main.tscn",
            "source/client/network/instance_client.gd",
            "source/server/gateway",
            "source/server/master",
            "source/server/world",
            "source/common/network/wire_codec.gd",
        )
        missing = [relative for relative in required if not (artifact / relative).exists()]
        return merge_gates(
            common,
            GateResult(
                not missing,
                [f"required Tiny MMO path is missing: {item}" for item in missing],
                [],
                {"tinymmo_required_paths": len(required) - len(missing)},
            ),
        )

    def _dependency_root(self) -> Path:
        configured = self.options.get("runtime_dependency_root")
        if configured:
            return Path(str(configured)).expanduser().resolve()
        return (
            Path(__file__).resolve().parents[2] / "third_party/godot-sqlite-v4.8-macos"
        )

    def _install_runtime_dependency(self, project: Path) -> None:
        source = self._dependency_root() / "addons/godot-sqlite"
        if not source.is_dir():
            raise FileNotFoundError(f"Tiny MMO SQLite runtime dependency is missing: {source}")
        shutil.copytree(source, project / "addons/godot-sqlite", dirs_exist_ok=True)

    def _install_godot_wrapper(self, project: Path) -> None:
        godot = self._godot_binary()
        if godot is None:
            return
        wrapper = project / "tools/godot"
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        wrapper.write_text(
            "#!/usr/bin/env bash\nexec " + repr(godot) + " \"$@\"\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o755)

    def _godot_binary(self) -> str | None:
        configured = self.options.get("godot_bin")
        if configured and Path(str(configured)).expanduser().is_file():
            return str(Path(str(configured)).expanduser().resolve())
        return shutil.which("godot") or shutil.which("godot4")
