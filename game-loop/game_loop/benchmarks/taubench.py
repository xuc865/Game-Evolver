from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from game_loop.config import GateConfig
from game_loop.core.models import (ArtifactDescriptor, AttemptContext,
    BackendExecution, CandidateResult, EvaluationResult, GateResult, PreparedTask)
from game_loop.gates import common_gate, merge_gates
from game_loop.utils import read_json
from .base import BenchmarkAdapter
from .agents.context import write_harness_context


class TauBenchAdapter(BenchmarkAdapter):
    """Adapter for the official tau2-bench text-mode evaluator."""
    adapter_id = "taubench"
    capabilities = {
        "score_topology": "continuous",
        "natural_terminal_condition": False,
        "evaluation_coupling": "official_tau2_simulation_evaluator",
        "behavior_evidence": False,
        "hidden_evaluator": False,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(kind="tau2_agent_workspace")
    required_command_fields = frozenset({
        "agent_cwd", "artifact_path", "instruction_file", "output_manifest",
        "harness_context",
    })

    def doctor(self) -> dict[str, Any]:
        root = Path(str(self.options.get("tau_root", ""))).expanduser().resolve()
        return {"adapter": self.adapter_id, "tau_root": str(root),
                "tau_root_exists": root.is_dir(), "uv_available": shutil.which("uv") is not None}

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        score = value.get("reward", value.get("score", value.get("primary_score")))
        primary = None if score is None else float(score)
        infra = [str(x) for x in value.get("infrastructure_errors", []) if str(x).strip()]
        diagnostics = [str(x) for x in value.get("diagnostics", []) if str(x).strip()]
        completed = value.get("status") not in {"infrastructure_failure", "error"}
        feasible = completed and primary is not None and not infra
        return EvaluationResult(
            primary_score=primary, feasible=feasible,
            objectives={"task_reward": primary or 0.0},
            constraints={"tau2_complete": feasible},
            diagnostics=[] if feasible else (infra + diagnostics)[:5],
            evaluator={"name": "tau2-bench official evaluator", "domain": value.get("domain", "")},
            terminal_success=feasible and (primary or 0.0) >= 1.0,
            raw_result_ref=str(path.resolve()),
        )

    def prepare(self, *, task_source: Path, parent_artifact: Path,
                feedback: dict[str, Any], candidate_dir: Path,
                context: AttemptContext) -> PreparedTask:
        del context
        workspace = candidate_dir / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        self.stage_artifact(parent_artifact, workspace / "candidate")
        instruction = candidate_dir / "instruction.md"
        source = task_source.read_text(encoding="utf-8") if task_source.is_file() else str(task_source)
        harness = feedback.get("agent_harness", {})
        rendered = harness.get("rendered_instruction", "") if isinstance(harness, dict) else ""
        instruction.write_text(source + "\n\n" + str(rendered), encoding="utf-8")
        manifest = candidate_dir / "taubench_execution.json"
        harness_context = write_harness_context(feedback, candidate_dir / "harness_context.md")
        return PreparedTask(self.adapter_id, workspace, {
            "agent_cwd": str(workspace.resolve()),
            "candidate_workspace": str(workspace.resolve()),
            "artifact_path": str((workspace / "candidate").resolve()),
            "instruction_file": str(instruction.resolve()),
            "output_manifest": str(manifest.resolve()),
            "harness_context": str(harness_context),
            "candidate_dir": str(candidate_dir.resolve()),
        }, {"output_manifest": str(manifest), "candidate_dir": str(candidate_dir)})

    def collect(self, prepared: PreparedTask, execution: BackendExecution) -> CandidateResult:
        manifest = Path(prepared.metadata["output_manifest"])
        if not manifest.is_file():
            return CandidateResult(None, None, execution.error or "tau2 manifest missing")
        value = read_json(manifest)
        result = Path(str(value.get("result_path", "")))
        if not result.is_file():
            return CandidateResult(None, None, "tau2 result is missing", evaluator_queries=1)
        evaluation = self.parse_evaluation(result)
        return CandidateResult(prepared.root_dir / "candidate", evaluation,
                               None if evaluation.feasible else "tau2 evaluator did not complete",
                               evaluator_queries=1)

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        return merge_gates(common_gate(artifact, common_config), GateResult(True))
