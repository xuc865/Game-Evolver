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


class VerigameAdapter(BenchmarkAdapter):
    adapter_id = "verigame"
    capabilities = {
        "score_topology": "continuous_multi_objective",
        "natural_terminal_condition": False,
        "evaluation_coupling": "paper_compatible_keypoint_state_injection_chain",
        "behavior_evidence": True,
        "hidden_evaluator": False,
        "official_implementation_bundled": False,
        "runtime_state_injection_required": True,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="web_game_project",
        ignore_patterns=(
            "node_modules/**", ".git/**", "task_overlay/**", "sandbox/**",
            "agent_trajectory.log", "result.json", ".qwen/**",
        ),
        component_patterns={
            "behavior_evidence": ("dist/**",),
        },
    )
    required_command_fields = frozenset({
        "task_root", "agent_workspace", "agent_cwd", "artifact_path",
        "instruction_file", "output_manifest",
    })

    def doctor(self) -> dict[str, Any]:
        root = Path(str(self.options.get("root", ""))).expanduser().resolve()
        return {
            "adapter": self.adapter_id,
            "capabilities": self.capabilities,
            "root": str(root),
            "root_exists": root.is_dir(),
            "node_available": shutil.which("node") is not None,
            "npx_available": shutil.which("npx") is not None,
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        status = str(value.get("status", "infrastructure_failure"))
        raw_score = value.get("primary_score")
        primary = None if raw_score is None else float(raw_score)
        objectives = {
            str(key): float(score)
            for key, score in value.get("objectives", {}).items()
        }
        constraints = {
            str(key): bool(passed)
            for key, passed in value.get("constraints", {}).items()
        }
        diagnostics = [str(item) for item in value.get("diagnostics", [])]
        feasible = status == "completed" and all(constraints.values()) and primary is not None
        return EvaluationResult(
            primary_score=primary,
            feasible=feasible,
            objectives=objectives,
            constraints=constraints,
            diagnostics=[] if feasible else diagnostics[:5],
            evaluator={
                "name": "GameGen-Verifier paper-compatible plugin chain",
                "implementation": str(value.get("implementation", "unknown")),
                "official_implementation": False,
            },
            terminal_success=feasible and primary >= 1.0,
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
        del context
        overlay = candidate_dir / "task_overlay"
        workspace = overlay / "workspace"
        task_dir = workspace / "task"
        candidate_dir_ws = workspace / "candidate"
        task_dir.mkdir(parents=True, exist_ok=True)
        candidate_dir_ws.mkdir(parents=True, exist_ok=True)
        specification = _read_public_verigame_specification(task_source)
        (task_dir / "specification.md").write_text(
            specification + "\n", encoding="utf-8"
        )
        self.stage_artifact(parent_artifact, candidate_dir_ws)
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        instruction_path = workspace / "instruction.md"
        instruction_path.write_text(
            (
                "# Evolution Directive\n\n"
                "Implement the public VeriGame specification as a web game. "
                "Keep runtime state inspectable and patchable: entities must be creatable/removable "
                "and gameplay values, phases, and flags must be programmatically readable and settable. "
                "Do not edit benchmark infrastructure or consume evaluator outputs.\n"
                f"\n## Public specification\n\n{specification}\n"
                + (f"\n{rendered}\n" if rendered else "")
            ),
            encoding="utf-8",
        )
        output_manifest = candidate_dir / "verigame_execution.json"
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "task_root": str(task_dir.resolve()),
                "agent_workspace": str(candidate_dir_ws.resolve()),
                "agent_cwd": str(workspace.resolve()),
                "artifact_path": str(candidate_dir_ws.resolve()),
                "candidate_workspace": str(candidate_dir_ws.resolve()),
                "instruction_file": str(instruction_path.resolve()),
                "output_manifest": str(output_manifest.resolve()),
                "candidate_dir": str(candidate_dir.resolve()),
            },
            {
                "output_manifest": str(output_manifest),
                "candidate_dir": str(candidate_dir),
            },
        )

    def collect(self, prepared: PreparedTask, execution: BackendExecution) -> CandidateResult:
        manifest_path = Path(prepared.metadata["output_manifest"])
        if not manifest_path.is_file():
            return CandidateResult(
                None,
                None,
                execution.error or "Verigame execution manifest missing",
            )
        manifest = read_json(manifest_path)
        artifact_path = Path(str(manifest.get("artifact_dir", "")))
        result_json = Path(str(manifest.get("evaluation_path", "")))
        if str(manifest.get("status")) != "completed" or not result_json.is_file():
            return CandidateResult(
                None,
                None,
                "GameGen-Verifier evaluator infrastructure did not complete normally",
                evaluator_queries=1,
            )
        if not artifact_path.is_dir():
            return CandidateResult(None, None, "VeriGame game artifact is missing", evaluator_queries=1)
        collected = Path(prepared.metadata["candidate_dir"]) / "collected_artifact"
        self.stage_artifact(artifact_path, collected)
        evaluation = self.parse_evaluation(result_json)
        if not evaluation.feasible:
            return CandidateResult(
                None,
                None,
                "GameGen-Verifier evaluator returned an invalid or incomplete result",
                evaluator_queries=1,
            )
        return CandidateResult(
            collected,
            evaluation,
            None,
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        errors: list[str] = []
        package = artifact / "package.json"
        html_files = list(artifact.glob("*.html")) + list((artifact / "dist").glob("*.html"))
        if not package.is_file() and not html_files:
            errors.append("web artifact requires package.json or an HTML entrypoint")
        return merge_gates(
            common,
            GateResult(
                not errors,
                errors,
                [],
                {
                    "package_present": package.is_file(),
                    "html_entrypoints": len(html_files),
                },
            ),
        )


def _read_public_verigame_specification(task_source: Path) -> str:
    source = task_source.resolve()
    candidates = (
        [source / name for name in ("specification.md", "task.md", "instruction.md")]
        if source.is_dir()
        else [source]
    )
    for candidate in candidates:
        if candidate.is_file():
            specification = candidate.read_text(encoding="utf-8").strip()
            if specification:
                return specification
    raise ValueError(f"VeriGame public specification is missing: {source}")
