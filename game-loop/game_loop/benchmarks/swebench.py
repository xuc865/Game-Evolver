from __future__ import annotations

import json
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
from game_loop.utils import atomic_write_json, read_json

from .base import BenchmarkAdapter


class SWEBenchAdapter(BenchmarkAdapter):
    adapter_id = "swebench"
    capabilities = {
        "score_topology": "binary",
        "natural_terminal_condition": True,
        "evaluation_coupling": "native_docker_eval_then_hidden_test",
        "behavior_evidence": False,
        "hidden_evaluator": True,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="git_repository",
        ignore_patterns=(
            ".git/**", "task_overlay/**", "sandbox/**",
            "agent_trajectory.log", "result.json", "*.md",
        ),
    )
    required_command_fields = frozenset({
        "repo_root", "instance_id", "test_patch", "output_manifest",
    })

    def doctor(self) -> dict[str, Any]:
        root = Path(str(self.options.get("root", ""))).expanduser().resolve()
        return {
            "adapter": self.adapter_id,
            "capabilities": self.capabilities,
            "root": str(root),
            "root_exists": root.is_dir(),
            "docker_available": shutil.which("docker") is not None,
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        resolved = bool(value.get("resolved", False))
        instance_id = str(value.get("instance_id", ""))
        errors = [str(item) for item in value.get("errors", []) if str(item).strip()]
        infra_markers = (
            "docker not available",
            "eval image not found",
            "timeout",
            "container error",
        )
        feasible = resolved or not any(
            marker in " ".join(errors).lower() for marker in infra_markers
        )
        return EvaluationResult(
            primary_score=1.0 if resolved else 0.0,
            feasible=feasible,
            objectives={"task_correctness": 1.0 if resolved else 0.0},
            constraints={
                "resolved": resolved,
                "hidden_test_pass": resolved,
                "docker_eval_complete": feasible,
            },
            diagnostics=[] if resolved else (errors[:5] or ["instance not resolved"]),
            evaluator={"name": "SWE-bench hidden test suite", "instance_id": instance_id},
            terminal_success=resolved,
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
        repo_dir = workspace / "repo"
        repo_dir.mkdir(parents=True, exist_ok=True)
        if task_source.is_dir():
            shutil.copytree(task_source, repo_dir, dirs_exist_ok=True)
        else:
            repo_dir.mkdir(parents=True, exist_ok=True)
        self.stage_artifact(parent_artifact, workspace / "candidate")
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        directive_path = workspace / "evolution_directive.md"
        directive_path.write_text(
            (
                "# Evolution Directive\n\n"
                "Improve the repository in place to resolve the target issue. "
                "Do not modify benchmark infrastructure or hidden test files.\n"
                + (f"\n{rendered}\n" if rendered else "")
            ),
            encoding="utf-8",
        )
        output_manifest = candidate_dir / "swebench_execution.json"
        instance_id = str(self.options.get("instance_id", ""))
        test_patch = str(self.options.get("test_patch", ""))
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "repo_root": str(repo_dir.resolve()),
                "instance_id": instance_id,
                "test_patch": test_patch,
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
                execution.error or "SWE-bench execution manifest missing",
            )
        manifest = read_json(manifest_path)
        result_dir = Path(str(manifest.get("result_dir", "")))
        result_json = result_dir / "result.json"
        if not result_dir.is_dir() or not result_json.is_file():
            return CandidateResult(
                None,
                None,
                "SWE-bench result artifact is missing",
                evaluator_queries=1,
            )
        collected = Path(prepared.metadata["candidate_dir"]) / "collected_artifact"
        self.stage_artifact(result_dir, collected)
        evaluation = self.parse_evaluation(result_json)
        return CandidateResult(
            collected,
            evaluation,
            (
                None
                if evaluation.feasible
                else "SWE-bench evaluator infrastructure did not complete normally"
            ),
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        errors: list[str] = []
        if not (artifact / ".git").is_dir():
            errors.append(".git directory is missing")
        if not (artifact / ".git" / "HEAD").is_file():
            errors.append(".git/HEAD is missing")
        return merge_gates(
            common,
            GateResult(not errors, errors, [], {"git_repo_intact": not errors}),
        )
