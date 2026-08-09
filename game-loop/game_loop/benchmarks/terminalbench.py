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


class TerminalBenchAdapter(BenchmarkAdapter):
    adapter_id = "terminalbench"
    capabilities = {
        "score_topology": "binary",
        "natural_terminal_condition": True,
        "evaluation_coupling": "native_container_eval_then_hidden_check",
        "behavior_evidence": False,
        "hidden_evaluator": True,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="terminal_session",
        ignore_patterns=(
            "task_overlay/**", "sandbox/**",
            "agent_trajectory.log", "result.json", "*.pyc",
        ),
    )
    required_command_fields = frozenset({
        "task_root", "container_image", "output_manifest",
    })

    def doctor(self) -> dict[str, Any]:
        root = Path(str(self.options.get("root", ""))).expanduser().resolve()
        return {
            "adapter": self.adapter_id,
            "capabilities": self.capabilities,
            "root": str(root),
            "root_exists": root.is_dir(),
            "tb_available": shutil.which("tb") is not None,
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        passed = bool(value.get("passed", False))
        task_id = str(value.get("task_id", ""))
        errors = [str(item) for item in value.get("errors", []) if str(item).strip()]
        infra_markers = (
            "container not found",
            "docker not available",
            "timeout",
            "tb not found",
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
                "container_eval_complete": feasible,
            },
            diagnostics=[] if passed else (errors[:5] or ["task not passed"]),
            evaluator={"name": "TerminalBench hidden check", "task_id": task_id},
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
        task_dir = workspace / "task"
        task_dir.mkdir(parents=True, exist_ok=True)
        if task_source.is_dir():
            shutil.copytree(task_source, task_dir, dirs_exist_ok=True)
        self.stage_artifact(parent_artifact, workspace / "candidate")
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        # Inject evolution directive into terminus.txt
        terminus_path = task_dir / "terminus.txt"
        original_terminus = ""
        if terminus_path.is_file():
            original_terminus = terminus_path.read_text(encoding="utf-8")
        directive = (
            "\n\n# Evolution Directive\n\n"
            "Complete the terminal task following the instructions above. "
            "Do not modify benchmark infrastructure or hidden test scripts.\n"
            + (f"\n{rendered}\n" if rendered else "")
        )
        terminus_path.write_text(original_terminus + directive, encoding="utf-8")
        output_manifest = candidate_dir / "terminalbench_execution.json"
        container_image = str(self.options.get("container_image", ""))
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "task_root": str(task_dir.resolve()),
                "container_image": container_image,
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
                execution.error or "TerminalBench execution manifest missing",
            )
        manifest = read_json(manifest_path)
        result_dir = Path(str(manifest.get("result_dir", "")))
        result_json = result_dir / "result.json"
        if not result_dir.is_dir() or not result_json.is_file():
            return CandidateResult(
                None,
                None,
                "TerminalBench result artifact is missing",
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
                else "TerminalBench evaluator infrastructure did not complete normally"
            ),
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        errors: list[str] = []
        if not (artifact / "instruction.md").is_file():
            errors.append("instruction.md is missing")
        return merge_gates(
            common,
            GateResult(not errors, errors, [], {"instruction_present": not errors}),
        )
