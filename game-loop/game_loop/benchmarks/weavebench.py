from __future__ import annotations

import json
import re
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


class WeaveBenchAdapter(BenchmarkAdapter):
    adapter_id = "weavebench"
    capabilities = {
        "score_topology": "binary",
        "natural_terminal_condition": True,
        "evaluation_coupling": "native_weave_eval_then_hidden_check",
        "behavior_evidence": False,
        "hidden_evaluator": True,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="weave_session",
        ignore_patterns=(
            "task_overlay/**", "sandbox/**",
            "agent_trajectory.log", "result.json", "*.pyc",
        ),
    )
    required_command_fields = frozenset({
        "tasks_root", "task_id", "output_manifest",
    })

    def doctor(self) -> dict[str, Any]:
        root = Path(str(self.options.get("root", ""))).expanduser().resolve()
        return {
            "adapter": self.adapter_id,
            "capabilities": self.capabilities,
            "root": str(root),
            "root_exists": root.is_dir(),
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        passed = bool(value.get("passed", False))
        task_id = str(value.get("task_id", ""))
        errors = [str(item) for item in value.get("errors", []) if str(item).strip()]
        infra_markers = (
            "weavebench not found",
            "evaluator error",
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
                "task_passed": passed,
                "weave_eval_complete": feasible,
            },
            diagnostics=[] if passed else (errors[:5] or ["task not passed"]),
            evaluator={"name": "WeaveBench hidden check", "task_id": task_id},
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
        tasks_dir = workspace / "tasks"
        tasks_dir.mkdir(parents=True, exist_ok=True)
        # Copy task .md file
        task_id = str(self.options.get("task_id", ""))
        if task_source.is_dir():
            shutil.copytree(task_source, tasks_dir, dirs_exist_ok=True)
        elif task_source.is_file():
            shutil.copy2(task_source, tasks_dir / task_source.name)
        self.stage_artifact(parent_artifact, workspace / "candidate")
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        # Inject directive into ## Prompt section of task .md
        task_md = tasks_dir / f"{task_id}.md"
        if not task_md.is_file():
            # Try to find any .md file
            md_files = list(tasks_dir.glob("*.md"))
            if md_files:
                task_md = md_files[0]
        if task_md.is_file():
            content = task_md.read_text(encoding="utf-8")
            directive = (
                "\n\n## Evolution Directive\n\n"
                "Complete the weaving task following the prompt above. "
                "Do not modify benchmark infrastructure or hidden test files.\n"
                + (f"\n{rendered}\n" if rendered else "")
            )
            # Insert after ## Prompt section
            prompt_match = re.search(r"(##\s*Prompt[^\n]*\n)", content)
            if prompt_match:
                insert_pos = prompt_match.end()
                content = content[:insert_pos] + directive + content[insert_pos:]
            else:
                content = content + directive
            task_md.write_text(content, encoding="utf-8")
        output_manifest = candidate_dir / "weavebench_execution.json"
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "tasks_root": str(tasks_dir.resolve()),
                "task_id": task_id,
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
                execution.error or "WeaveBench execution manifest missing",
            )
        manifest = read_json(manifest_path)
        result_dir = Path(str(manifest.get("result_dir", "")))
        result_json = result_dir / "result.json"
        if not result_dir.is_dir() or not result_json.is_file():
            return CandidateResult(
                None,
                None,
                "WeaveBench result artifact is missing",
                evaluator_queries=1,
            )
        collected = Path(prepared.metadata["candidate_dir"]) / "collected_artifact"
        if result_dir.is_dir():
            self.stage_artifact(result_dir, collected)
        else:
            collected = None
        evaluation = self.parse_evaluation(result_json)
        return CandidateResult(
            collected,
            evaluation,
            (
                None
                if evaluation.feasible
                else "WeaveBench evaluator infrastructure did not complete normally"
            ),
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        errors: list[str] = []
        md_files = list(artifact.glob("*.md"))
        if not md_files:
            errors.append("no task .md file found")
        return merge_gates(
            common,
            GateResult(not errors, errors, [], {"task_md_count": len(md_files)}),
        )
