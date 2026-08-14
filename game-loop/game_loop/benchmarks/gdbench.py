from __future__ import annotations

import shutil
import tempfile
import zipfile
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


class GameDevBenchAdapter(BenchmarkAdapter):
    adapter_id = "gdbench"
    capabilities = {
        "score_topology": "binary",
        "natural_terminal_condition": True,
        "evaluation_coupling": "opengame_submission_then_hidden_validation",
        "behavior_evidence": False,
        "hidden_evaluator": True,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="godot_task_project",
        ignore_patterns=(
            ".godot", ".godot/**", "task_config.json", "agent_trajectory.log",
            "result.json", "scripts/test.gd", "scripts/test.gd.uid", "scenes/test.tscn",
            "test_result", "test_result/**", "*.md",
        ),
    )
    required_command_fields = frozenset({
        "gdbench_root", "agent_cwd", "agent_workspace", "artifact_path",
        "private_task_source", "task_name", "instruction_file", "output_manifest",
    })

    def stage_artifact(self, source: Path, target: Path) -> Path:
        source = source.resolve()
        if source.is_file() and source.suffix.lower() == ".zip":
            temporary = Path(tempfile.mkdtemp(prefix="game-loop-gdbench-seed-"))
            try:
                project = _materialize_task_source(source, temporary / "source")
                return super().stage_artifact(project, target)
            finally:
                shutil.rmtree(temporary, ignore_errors=True)
        return super().stage_artifact(source, target)

    def doctor(self) -> dict[str, Any]:
        root = Path(str(self.options.get("root", ""))).expanduser().resolve()
        return {
            "adapter": self.adapter_id,
            "capabilities": self.capabilities,
            "root": str(root),
            "root_exists": root.is_dir(),
            "runner_exists": (root / "gamedevbench" / "src" / "benchmark_runner.py").is_file(),
            "task_archives": len(list((root / "tasks").glob("task_*.zip"))) if root.is_dir() else 0,
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        validation = value.get("validation") if isinstance(value.get("validation"), dict) else value
        success = bool(validation.get("success", False))
        message = str(validation.get("message", value.get("message", ""))).strip()
        solver = value.get("solver", {}) if isinstance(value.get("solver"), dict) else {}
        infrastructure_error = bool(validation.get("infrastructure_error", False))
        infrastructure_markers = (
            "project.godot not found",
            "validation timed out",
            "error running validation",
            "godot backend unavailable",
            "no validation result found in output",
            "opengame failed",
        )
        solver_success = bool(solver.get("success", True))
        feasible = (
            success
            or (
                solver_success
                and not infrastructure_error
                and not any(marker in message.lower() for marker in infrastructure_markers)
            )
        )
        return EvaluationResult(
            primary_score=1.0 if success else 0.0,
            feasible=feasible,
            objectives={"task_correctness": 1.0 if success else 0.0},
            constraints={"project_loadable": feasible, "hidden_validation": success},
            diagnostics=[] if success or not message else [message],
            evaluator={
                "name": "GameDevBench hidden validation",
                "infrastructure_failure": infrastructure_error or not feasible,
            },
            cost={"agent_usd": float(solver.get("cost_usd", value.get("cost_usd", 0.0)) or 0.0)},
            terminal_success=success,
            raw_result_ref=str(path.resolve()),
        )

    def prepare(self, *, task_source: Path, parent_artifact: Path, feedback: dict[str, Any], candidate_dir: Path, context: AttemptContext) -> PreparedTask:
        source = _materialize_task_source(task_source.resolve(), candidate_dir / "benchmark_source")
        task_name = source.name
        task_root = candidate_dir / "gdbench_overlay" / "tasks"
        task_dir = task_root / task_name
        # Start from the official public project, filtered by the artifact
        # descriptor, then overlay the current parent without ever staging tests.
        self.stage_artifact(source, task_dir)
        staged_parent = candidate_dir / "parent_overlay"
        self.stage_artifact(parent_artifact, staged_parent)
        shutil.copytree(staged_parent, task_dir, dirs_exist_ok=True)
        original_config = read_json(source / "task_config.json")
        original_instruction = str(original_config.get("instruction", ""))
        harness = feedback.get("agent_harness")
        rendered_harness = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        original_config["instruction"] = (
            original_instruction
            + "\n\nAn existing attempted solution is already present. Improve it in place; do not rebuild unrelated systems."
            + "\nDo not search for hidden tests or validation markers. Verify the project normally before finishing."
            + ("\n\n" + rendered_harness if rendered_harness else "")
        )
        instruction_file = candidate_dir / "gdbench_instruction.txt"
        instruction_file.write_text(original_config["instruction"], encoding="utf-8")
        output_manifest = candidate_dir / "gdbench_execution.json"
        result_root = candidate_dir / "gdbench_overlay"
        return PreparedTask(self.adapter_id, task_dir, {
            "agent_cwd": str(task_dir.resolve()),
            "artifact_path": str(task_dir.resolve()),
            "gdbench_root": str(Path(str(self.options["root"])).expanduser().resolve()),
            "agent_workspace": str(task_dir.resolve()),
            "private_task_source": str(source.resolve()),
            "task_name": task_name,
            "instruction_file": str(instruction_file.resolve()),
            "output_manifest": str(output_manifest.resolve()),
            "results_dir": str(result_root.resolve()),
            "candidate_dir": str(candidate_dir.resolve()),
        }, {"output_manifest": str(output_manifest), "candidate_dir": str(candidate_dir)})

    def collect(self, prepared: PreparedTask, execution: BackendExecution) -> CandidateResult:
        manifest_path = Path(prepared.metadata["output_manifest"])
        if not manifest_path.is_file():
            return CandidateResult(None, None, execution.error or f"GDBench execution manifest missing; return code={execution.return_code}")
        manifest = read_json(manifest_path)
        result_dir = Path(str(manifest.get("result_dir", "")))
        result_json = result_dir / "result.json"
        if not result_dir.is_dir() or not result_json.is_file():
            return CandidateResult(
                None,
                None,
                "GDBench retained result artifact is missing",
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
                else "GDBench evaluator infrastructure did not complete normally"
            ),
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        errors = [] if (artifact / "project.godot").is_file() else ["project.godot is missing"]
        leaked = [relative for relative in ("scripts/test.gd", "scenes/test.tscn", "task_config.json") if (artifact / relative).exists()]
        errors.extend(f"benchmark-only file leaked into artifact: {relative}" for relative in leaked)
        return merge_gates(common, GateResult(not errors, errors, [], {"benchmark_only_files": len(leaked)}))

def _materialize_task_source(source: Path, destination: Path) -> Path:
    if source.is_dir():
        return source
    if not source.is_file() or source.suffix.lower() != ".zip":
        raise FileNotFoundError(f"GDBench task source must be an extracted task or zip: {source}")
    destination.mkdir(parents=True)
    with zipfile.ZipFile(source) as archive:
        root = destination.resolve()
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            try:
                target.relative_to(root)
            except ValueError as exc:
                raise ValueError(f"unsafe zip member: {member.filename}") from exc
        archive.extractall(destination)
    projects = sorted(destination.rglob("project.godot"))
    if len(projects) != 1:
        raise ValueError(f"expected one Godot project in {source}, found {len(projects)}")
    return projects[0].parent
