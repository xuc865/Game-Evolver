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
from .agents.context import write_harness_context


class TerminalBenchAdapter(BenchmarkAdapter):
    adapter_id = "terminalbench"
    capabilities = {
        "score_topology": "continuous",
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
        "task_root", "agent_workspace", "container_image", "output_manifest", "agent_cwd",
        "artifact_path", "instruction_file",
        "harness_context",
    })

    def doctor(self) -> dict[str, Any]:
        root = Path(str(self.options.get("root", ""))).expanduser().resolve()
        return {
            "adapter": self.adapter_id,
            "capabilities": self.capabilities,
            "root": str(root),
            "root_exists": root.is_dir(),
            "tb_available": shutil.which("tb") is not None,
            "harbor_project_available": (
                (Path(__file__).resolve().parents[2] / "third_party" / "harbor").is_dir()
            ),
            "public_dataset": str(self.options.get("dataset", "terminal-bench@2.0")),
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        passed = bool(value.get("passed", False))
        reward_value = value.get("reward")
        reward = (1.0 if passed else 0.0) if reward_value is None else float(reward_value)
        task_id = str(value.get("task_id", ""))
        errors = [str(item) for item in value.get("errors", []) if str(item).strip()]
        infra_markers = (
            "container not found",
            "docker not available",
            "timeout",
            "tb not found",
        )
        feasible = not bool(value.get("infrastructure_error", False)) and (passed or not any(
            marker in " ".join(errors).lower() for marker in infra_markers
        ))
        return EvaluationResult(
            primary_score=reward,
            feasible=feasible,
            objectives={"task_correctness": reward},
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
        task_dir = candidate_dir / "private_task"
        task_dir.mkdir(parents=True, exist_ok=True)
        if task_source.is_dir():
            shutil.copytree(task_source, task_dir, dirs_exist_ok=True)
        workspace.mkdir(parents=True, exist_ok=True)
        self.stage_artifact(parent_artifact, workspace)
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        instruction_file = workspace / "instruction.md"
        public_instruction = (task_source / "instruction.md").read_text(encoding="utf-8")
        instruction_file.write_text(
            public_instruction + "\n\n# Evolution Directive\n\n"
            "Complete the terminal task and verify the result. Do not access hidden evaluator files.\n"
            + (f"\n{rendered}\n" if rendered else ""), encoding="utf-8"
        )
        output_manifest = candidate_dir / "terminalbench_execution.json"
        harness_context = write_harness_context(feedback, candidate_dir / "harness_context.md")
        container_image = str(self.options.get("container_image", ""))
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "task_root": str(task_dir.resolve()),
                "agent_workspace": str(workspace.resolve()),
                "container_image": container_image,
                "output_manifest": str(output_manifest.resolve()),
                "candidate_dir": str(candidate_dir.resolve()),
                "candidate_workspace": str(workspace.resolve()),
                "agent_cwd": str(workspace.resolve()),
                "artifact_path": str(workspace.resolve()),
                "instruction_file": str(instruction_file.resolve()),
                "harness_context": str(harness_context),
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
        # The Harbor-backed bridge emits its normalized evaluation directly
        # in output_manifest. Older bridges returned result_dir/result.json.
        if not manifest.get("result_dir") and (
            "passed" in manifest or "reward" in manifest
        ):
            collected = Path(prepared.metadata["candidate_dir"]) / "collected_artifact"
            self.stage_artifact(prepared.root_dir, collected)
            evaluation = self.parse_evaluation(manifest_path)
            return CandidateResult(
                collected,
                evaluation,
                None if evaluation.feasible else "TerminalBench evaluator infrastructure did not complete normally",
                evaluator_queries=1,
            )
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
