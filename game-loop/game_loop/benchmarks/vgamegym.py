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
from game_loop.utils import read_json

from .base import BenchmarkAdapter


class VGameGymAdapter(BenchmarkAdapter):
    adapter_id = "vgamegym"
    capabilities = {
        "score_topology": "continuous_multi_objective",
        "natural_terminal_condition": False,
        "evaluation_coupling": "pinned_code_image_video_evaluator",
        "behavior_evidence": True,
        "hidden_evaluator": False,
        "maker": "opengame_only",
        "requires_autonomous_demo": True,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="python_game_code",
        ignore_patterns=(
            "__pycache__/**", ".git/**", "task_overlay/**", "sandbox/**",
            "agent_trajectory.log", "result.json", "*.md", "*.pyc", ".qwen/**",
        ),
        component_patterns={
            "behavior_evidence": ("screenshots/**", "videos/**"),
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
            "python_available": shutil.which("python3") is not None,
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        status = str(value.get("status", "infrastructure_failure"))
        raw_score = value.get("primary_score")
        final = None if raw_score is None else float(raw_score)
        objectives = {
            str(key): float(score)
            for key, score in value.get("objectives", {}).items()
        }
        constraints = {
            str(key): bool(passed)
            for key, passed in value.get("constraints", {}).items()
        }
        errors = [str(item) for item in value.get("diagnostics", [])]
        judges_complete = all(
            constraints.get(f"{name}_judge_complete", False)
            for name in ("code", "screenshot", "video")
        )
        feasible = (
            status == "completed"
            and final is not None
            and constraints.get("game_runnable", False)
            and judges_complete
        )
        return EvaluationResult(
            primary_score=final,
            feasible=feasible,
            objectives=objectives,
            constraints=constraints,
            diagnostics=[] if feasible else errors[:5],
            evaluator=dict(value.get("evaluator", {})),
            terminal_success=feasible and final >= 1.0,
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
        requirement, public_metadata = _read_public_vgamegym_task(task_source)
        (task_dir / "requirement.md").write_text(requirement + "\n", encoding="utf-8")
        (task_dir / "public_task.json").write_text(
            json.dumps(
                {**public_metadata, "requirement": requirement},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        self.stage_artifact(parent_artifact, candidate_dir_ws)
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        directive_path = workspace / "evolution_directive.md"
        directive_path.write_text(
            (
                "# V-GameGym OpenGame Task\n\n"
                "Implement the public requirement as a runnable Pygame artifact. "
                "The game must autonomously demonstrate its core mechanics during a fixed "
                "recording horizon so code, screenshots, and video can all be evaluated. "
                "Do not consume reference code or evaluator outputs.\n"
                f"\n## Public requirement\n\n{requirement}\n"
                + (f"\n{rendered}\n" if rendered else "")
            ),
            encoding="utf-8",
        )
        output_manifest = candidate_dir / "vgamegym_execution.json"
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "task_root": str(task_dir.resolve()),
                "agent_workspace": str(candidate_dir_ws.resolve()),
                "agent_cwd": str(workspace.resolve()),
                "artifact_path": str(candidate_dir_ws.resolve()),
                "candidate_workspace": str(candidate_dir_ws.resolve()),
                "instruction_file": str(directive_path.resolve()),
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
                execution.error or "VGameGym execution manifest missing",
            )
        manifest = read_json(manifest_path)
        artifact_path = Path(str(manifest.get("artifact_dir", "")))
        result_json = Path(str(manifest.get("evaluation_path", "")))
        if str(manifest.get("status")) != "completed" or not result_json.is_file():
            return CandidateResult(
                None,
                None,
                "V-GameGym evaluator infrastructure did not complete normally",
                evaluator_queries=1,
            )
        if not artifact_path.is_dir():
            return CandidateResult(None, None, "V-GameGym game artifact is missing", evaluator_queries=1)
        collected = Path(prepared.metadata["candidate_dir"]) / "collected_artifact"
        self.stage_artifact(artifact_path, collected)
        evaluation = self.parse_evaluation(result_json)
        return CandidateResult(
            collected,
            evaluation,
            None,
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        errors: list[str] = []
        py_files = list(artifact.rglob("*.py"))
        if not py_files:
            errors.append("no Python game code files found")
        return merge_gates(
            common,
            GateResult(
                not errors,
                errors,
                [],
                {"python_file_count": len(py_files)},
            ),
        )


def _read_public_vgamegym_task(task_source: Path) -> tuple[str, dict[str, str]]:
    source = task_source.resolve()
    candidates = (
        [source / "task.json", source / "public_task.json"]
        if source.is_dir()
        else [source]
    )
    for candidate in candidates:
        if not candidate.is_file() or candidate.suffix.lower() not in {".json", ".jsonl"}:
            continue
        text = candidate.read_text(encoding="utf-8")
        try:
            value = json.loads(text if candidate.suffix.lower() == ".json" else text.splitlines()[0])
        except (json.JSONDecodeError, IndexError):
            continue
        if not isinstance(value, dict):
            continue
        requirement = str(
            value.get("requirement") or value.get("instruction") or value.get("prompt") or ""
        ).strip()
        if requirement:
            metadata = {
                key: str(value[key])
                for key in ("game_id", "task_id", "id")
                if value.get(key) is not None
            }
            return requirement, metadata
    if source.is_dir():
        for name in ("requirement.md", "task.md", "instruction.md"):
            candidate = source / name
            if candidate.is_file():
                requirement = candidate.read_text(encoding="utf-8").strip()
                if requirement:
                    return requirement, {"task_id": source.name}
    raise ValueError(f"V-GameGym public requirement is missing: {source}")
