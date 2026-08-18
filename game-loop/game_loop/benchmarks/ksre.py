from __future__ import annotations

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


class KSREAdapter(BenchmarkAdapter):
    """Ren'Py adapter for evolving a real KSRE visual-novel mod scene."""

    adapter_id = "ksre"
    capabilities = {
        "score_topology": "continuous_multi_objective",
        "natural_terminal_condition": False,
        "evaluation_coupling": "renpy_compile_and_mod_presentation_contract",
        "behavior_evidence": True,
        "hidden_evaluator": False,
        "official_implementation_bundled": False,
        "max_evaluator_queries_per_candidate": 1,
    }
    artifact_descriptor = ArtifactDescriptor(
        kind="renpy_visual_novel_repository",
        ignore_patterns=(
            ".git/**",
            "game/cache/**",
            "game/saves/**",
            "logs/**",
            "*.log",
            "*.rpyc",
            "*.rpymc",
        ),
        component_patterns={
            "renpy_core": ("game/*.rpy",),
            "pxt_original_mod": ("game/mods/pxt/**",),
            "pxt_director_mod": ("game/mods/pxt_director/**",),
            "ui_assets": ("game/gui/**", "game/font/**"),
        },
    )
    required_command_fields = frozenset(
        {
            "candidate_workspace",
            "agent_cwd",
            "artifact_path",
            "instruction_file",
            "output_manifest",
            "evaluation_path",
            "task_id",
        }
    )

    def doctor(self) -> dict[str, Any]:
        renpy_bin = self._renpy_binary()
        return {
            "adapter": self.adapter_id,
            "capabilities": self.capabilities,
            "renpy_available": renpy_bin is not None,
            "renpy_binary": renpy_bin,
        }

    def parse_evaluation(self, path: Path) -> EvaluationResult:
        value = read_json(path)
        status = str(value.get("status", "infrastructure_failure"))
        score = value.get("primary_score")
        objectives = {
            str(name): float(metric)
            for name, metric in value.get("objectives", {}).items()
        }
        constraints = {
            str(name): bool(passed)
            for name, passed in value.get("constraints", {}).items()
        }
        feasible = (
            status == "completed"
            and score is not None
            and bool(constraints)
            and all(constraints.values())
        )
        return EvaluationResult(
            primary_score=None if score is None else float(score),
            feasible=feasible,
            objectives=objectives,
            constraints=constraints,
            diagnostics=[str(item) for item in value.get("diagnostics", [])][:10],
            evaluator={
                "name": "KSRE pXt Director's Cut deterministic evaluator",
                "implementation": "game-loop/ksre-pxt-director-v1",
                "upstream": "fleetingheart/ksre@2b5f92c",
            },
            terminal_success=False,
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
        workspace = candidate_dir / "workspace"
        project = workspace / "project"
        project.mkdir(parents=True, exist_ok=True)
        self.stage_artifact(parent_artifact, project)
        self._install_renpy_wrapper(project)

        task_text = task_source.resolve().read_text(encoding="utf-8").strip()
        harness = feedback.get("agent_harness")
        rendered = (
            str(harness.get("rendered_instruction", "")).strip()
            if isinstance(harness, dict)
            else ""
        )
        instruction = workspace / "instruction.md"
        instruction.write_text(
            "# KSRE Visual-Novel Improvement Task\n\n"
            + task_text
            + "\n\n## Harness Guidance\n\n"
            + (rendered or "Make a bounded, playable visual-novel improvement and verify Ren'Py compile.")
            + "\n\n## Boundaries\n\n"
            "Work only inside this KSRE project. Preserve the existing pXt mod and the global Mods menu. "
            "Prefer adding a new game/mods/pxt_director mod that can be started from the real Mods menu. "
            "Do not edit evaluator or task infrastructure. Use existing bundled pXt assets; do not fetch external assets.\n",
            encoding="utf-8",
        )
        output_manifest = candidate_dir / "ksre_execution.json"
        evaluation_path = candidate_dir / "ksre_evaluation.json"
        return PreparedTask(
            self.adapter_id,
            workspace,
            {
                "candidate_workspace": str(project.resolve()),
                "agent_cwd": str(project.resolve()),
                "artifact_path": str(project.resolve()),
                "instruction_file": str(instruction.resolve()),
                "output_manifest": str(output_manifest.resolve()),
                "evaluation_path": str(evaluation_path.resolve()),
                "task_id": context.run_id,
            },
            {
                "candidate_dir": str(candidate_dir.resolve()),
                "output_manifest": str(output_manifest.resolve()),
            },
        )

    def collect(self, prepared: PreparedTask, execution: BackendExecution) -> CandidateResult:
        manifest_path = Path(prepared.metadata["output_manifest"])
        if not manifest_path.is_file():
            return CandidateResult(None, None, execution.error or "KSRE execution manifest is missing")
        manifest = read_json(manifest_path)
        artifact = Path(str(manifest.get("artifact_path", "")))
        evaluation_path = Path(str(manifest.get("evaluation_path", "")))
        if str(manifest.get("status")) != "completed" or not evaluation_path.is_file():
            return CandidateResult(
                None,
                None,
                str(manifest.get("error", "KSRE evaluator did not complete")),
                evaluator_queries=1,
            )
        if not artifact.is_dir():
            return CandidateResult(None, None, "KSRE candidate artifact is missing", evaluator_queries=1)
        evaluation = self.parse_evaluation(evaluation_path)
        collected = Path(prepared.metadata["candidate_dir"]) / "collected_artifact"
        self.stage_artifact(artifact, collected)
        return CandidateResult(
            collected,
            evaluation,
            None if evaluation.primary_score is not None else "KSRE score is missing",
            evaluator_queries=1,
        )

    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult:
        common = common_gate(artifact, common_config)
        required = (
            "game/config.rpy",
            "game/screens.rpy",
            "game/labels.rpy",
            "game/mods/pxt/definitions.rpy",
            "game/mods/pxt/screens.rpy",
            "game/mods/pxt/pxt.rpy",
        )
        missing = [relative for relative in required if not (artifact / relative).exists()]
        return merge_gates(
            common,
            GateResult(
                not missing,
                [f"required KSRE path is missing: {item}" for item in missing],
                [],
                {"ksre_required_paths": len(required) - len(missing)},
            ),
        )

    def _renpy_binary(self) -> str | None:
        configured = self.options.get("renpy_bin")
        if configured and Path(str(configured)).expanduser().is_file():
            return str(Path(str(configured)).expanduser().resolve())
        bundled = Path(__file__).resolve().parents[2] / "third_party/renpy-8.5.3-sdk/renpy.sh"
        if bundled.is_file():
            return str(bundled)
        import shutil

        return shutil.which("renpy")

    def _install_renpy_wrapper(self, project: Path) -> None:
        renpy_bin = self._renpy_binary()
        if renpy_bin is None:
            return
        wrapper = project / "tools/renpy"
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        wrapper.write_text(
            "#!/usr/bin/env bash\nexec " + repr(renpy_bin) + " \"$@\"\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
