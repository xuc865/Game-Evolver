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


class NL2RepoAdapter(BenchmarkAdapter):
    adapter_id = "nl2repo"
    capabilities = {
        "score_topology": "binary",
        "natural_terminal_condition": True,
        "evaluation_coupling": "native_pytest_then_hidden_validation",
        "behavior_evidence": False,
        "hidden_evaluator": True,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="code_repository",
        ignore_patterns=(
            ".git/**", "task_overlay/**", "sandbox/**",
            "agent_trajectory.log", "result.json", "*.md",
            "__pycache__/**", ".pytest_cache/**",
        ),
    )
    required_command_fields = frozenset({
        "repo_root", "task_file", "output_manifest",
    })

    def doctor(self) -> dict[str, Any]:
        root = Path(str(self.options.get("root", ""))).expanduser().resolve()
        return {
            "adapter": self.adapter_id,
            "capabilities": self.capabilities,
            "root": str(root),
            "root_exists": root.is_dir(),
            "pytest_available": shutil.which("pytest") is not None,
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        passed = bool(value.get("passed", False))
        total = int(value.get("total", 0))
        failures = int(value.get("failures", 0))
        errors = [str(item) for item in value.get("errors", []) if str(item).strip()]
        infra_markers = (
            "pytest not found",
            "import error",
            "collection error",
            "timeout",
        )
        feasible = passed or not any(
            marker in " ".join(errors).lower() for marker in infra_markers
        )
        return EvaluationResult(
            primary_score=1.0 if passed else 0.0,
            feasible=feasible,
            objectives={"task_correctness": 1.0 if passed else 0.0},
            constraints={
                "all_tests_passed": passed,
                "pytest_complete": feasible,
            },
            diagnostics=[] if passed else (errors[:5] or [f"{failures}/{total} tests failed"]),
            evaluator={"name": "NL2RepoBench pytest suite"},
            terminal_success=passed,
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
        self.stage_artifact(parent_artifact, repo_dir)
        task_file_src = Path(str(self.options.get("task_file", "")))
        if task_file_src.is_file():
            shutil.copy2(task_file_src, workspace / "task_file.md")
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        start_md = repo_dir / "start.md"
        task_content = task_file_src.read_text(encoding="utf-8") if task_file_src.is_file() else ""
        start_md.write_text(
            (
                "# Requirements\n\n"
                f"{task_content}\n\n"
                "# Evolution Directive\n\n"
                "Improve the repository in place to satisfy all requirements. "
                "Do not modify benchmark infrastructure or hidden test files.\n"
                + (f"\n{rendered}\n" if rendered else "")
            ),
            encoding="utf-8",
        )
        output_manifest = candidate_dir / "nl2repo_execution.json"
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "repo_root": str(repo_dir.resolve()),
                "task_file": str((workspace / "task_file.md").resolve()),
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
                execution.error or "NL2RepoBench execution manifest missing",
            )
        manifest = read_json(manifest_path)
        result_dir = Path(str(manifest.get("result_dir", "")))
        result_json = result_dir / "result.json"
        if not result_dir.is_dir() or not result_json.is_file():
            return CandidateResult(
                None,
                None,
                "NL2RepoBench result artifact is missing",
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
                else "NL2RepoBench evaluator infrastructure did not complete normally"
            ),
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        errors: list[str] = []
        if not (artifact / "start.md").is_file():
            errors.append("start.md is missing")
        has_code = any(artifact.glob("*.py")) or (artifact / "src").is_dir()
        if not has_code:
            errors.append("no Python source files found")
        return merge_gates(
            common,
            GateResult(not errors, errors, [], {"repo_has_code": has_code}),
        )
