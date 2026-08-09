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


class GameCraftBenchAdapter(BenchmarkAdapter):
    adapter_id = "gcbench"
    capabilities = {
        "score_topology": "continuous_multi_objective",
        "natural_terminal_condition": False,
        "evaluation_coupling": "opengame_submission_then_native_replay_and_judge",
        "behavior_evidence": True,
        "hidden_evaluator": True,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="godot_playable_game",
        ignore_patterns=(
            ".godot", ".godot/**", "verifier/**", "runner_jobs/**",
            "task_overlay/**", "sandbox/**", "agent_trajectory.log", "result.json",
            "breakdown.json", "*.md",
        ),
        component_patterns={
            "behavior_evidence": ("demo_outputs/**",),
        },
    )
    required_command_fields = frozenset({
        "agent_cwd", "candidate_workspace", "artifact_path", "instruction_file",
        "output_manifest",
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
        reward = float(value.get("reward", 0.0) or 0.0)
        build_ok = bool(value.get("build_ok", False))
        errors = [str(item) for item in value.get("errors", []) if str(item).strip()]
        judge_failed = any("judge failed" in item.lower() for item in errors)
        replay_failed = any("replay failed" in item.lower() for item in errors)
        feasible = build_ok and not judge_failed and not replay_failed
        objectives: dict[str, float] = {}
        for item in value.get("requirements", []):
            if not isinstance(item, dict):
                continue
            req_id = str(item.get("id", ""))
            aggregated = item.get("aggregated")
            if aggregated is None:
                continue
            if req_id.startswith("M"):
                objectives["mechanics"] = float(aggregated)
            elif req_id.startswith("D"):
                objectives["dynamics"] = float(aggregated)
        terminal = bool(value.get("terminal_success", reward >= 1.0))
        return EvaluationResult(
            primary_score=reward,
            feasible=feasible,
            objectives=objectives,
            constraints={
                "build": build_ok,
                "judge_complete": build_ok and not judge_failed,
                "replay_complete": build_ok and not replay_failed,
            },
            diagnostics=[] if feasible else errors[:5],
            evaluator={
                "name": "GameCraftBench breakdown",
                "infrastructure_failure": judge_failed or replay_failed,
            },
            terminal_success=terminal,
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
        workspace = overlay / "workspace" / "game"
        workspace.mkdir(parents=True, exist_ok=True)
        # Never copy the task package wholesale: official task directories also
        # contain tests/rubric.json.  Only the public starter workspace is staged.
        public_seed = task_source / "workspace" if (task_source / "workspace").is_dir() else None
        if public_seed is not None:
            shutil.copytree(public_seed, overlay / "workspace", dirs_exist_ok=True)
            workspace.mkdir(parents=True, exist_ok=True)
        staged_parent = candidate_dir / "parent_overlay"
        self.stage_artifact(parent_artifact, staged_parent)
        shutil.copytree(staged_parent, workspace, dirs_exist_ok=True)
        extra_path = candidate_dir / "extra_instruction.txt"
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        public_instruction = (
            (task_source / "instruction.md").read_text(encoding="utf-8")
            if (task_source / "instruction.md").is_file()
            else ""
        )
        extra_path.write_text(
            public_instruction
            + ("\n\n" if public_instruction else "")
            + "Improve the candidate Godot project in place. "
            + "The hidden rubric and shared assets are immutable; do not edit benchmark infrastructure."
            + (f"\n\n{rendered}" if rendered else ""),
            encoding="utf-8",
        )
        output_manifest = candidate_dir / "gcbench_execution.json"
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "agent_cwd": str((overlay / "workspace").resolve()),
                "candidate_workspace": str((overlay / "workspace").resolve()),
                "artifact_path": str(workspace.resolve()),
                "instruction_file": str(extra_path.resolve()),
                "extra_instruction": str(extra_path.resolve()),
                "output_manifest": str(output_manifest.resolve()),
                "candidate_dir": str(candidate_dir.resolve()),
            },
            {"output_manifest": str(output_manifest), "candidate_dir": str(candidate_dir)},
        )

    def collect(self, prepared: PreparedTask, execution: BackendExecution) -> CandidateResult:
        manifest_path = Path(prepared.metadata["output_manifest"])
        if not manifest_path.is_file():
            return CandidateResult(
                None,
                None,
                execution.error or "GameCraftBench execution manifest missing",
            )
        manifest = read_json(manifest_path)
        breakdown_path = Path(str(manifest.get("breakdown_path", "")))
        artifact_path = Path(str(manifest.get("artifact_path", prepared.root_dir / "candidate")))
        if not breakdown_path.is_file():
            return CandidateResult(
                None,
                None,
                "GameCraftBench breakdown is missing",
                evaluator_queries=1,
            )
        collected = Path(prepared.metadata["candidate_dir"]) / "collected_artifact"
        self.stage_artifact(artifact_path, collected)
        evaluation = self.parse_evaluation(breakdown_path)
        infrastructure_failed = bool(
            evaluation.evaluator.get("infrastructure_failure", False)
        )
        return CandidateResult(
            collected,
            evaluation,
            (
                "GameCraftBench evaluator did not complete normally"
                if infrastructure_failed
                else None
            ),
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        errors = [] if (artifact / "project.godot").is_file() else ["project.godot is missing"]
        evidence_count = sum(
            1 for path in (artifact / "demo_outputs").rglob("*")
            if path.is_file()
        ) if (artifact / "demo_outputs").is_dir() else 0
        return merge_gates(
            common,
            GateResult(
                not errors,
                errors,
                [],
                {"behavior_evidence_count": evidence_count},
            ),
        )
