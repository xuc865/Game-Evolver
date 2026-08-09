from __future__ import annotations

import shutil
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from game_loop.artifacts import copy_artifact
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


class BenchmarkAdapter(ABC):
    adapter_id: str = ""
    capabilities: dict[str, Any] = {}
    artifact_descriptor: ArtifactDescriptor = ArtifactDescriptor(kind="generic")
    required_command_fields: frozenset[str] = frozenset()

    def __init__(self, options: dict[str, Any]):
        self.options = dict(options)

    def validate_capabilities(self) -> None:
        return None

    def stage_artifact(self, source: Path, target: Path) -> Path:
        return copy_artifact(source.resolve(), target.resolve(), self.artifact_descriptor)

    def probe_context(self, *, task_source: Path) -> dict[str, str]:
        return {"task_source": str(task_source.resolve())}

    @abstractmethod
    def doctor(self) -> dict[str, Any]: ...

    @abstractmethod
    def parse_evaluation(self, path: Path) -> EvaluationResult: ...

    @abstractmethod
    def prepare(
        self,
        *,
        task_source: Path,
        parent_artifact: Path,
        feedback: dict[str, Any],
        candidate_dir: Path,
        context: AttemptContext,
    ) -> PreparedTask: ...

    @abstractmethod
    def collect(self, prepared: PreparedTask, execution: BackendExecution) -> CandidateResult: ...

    @abstractmethod
    def validate(self, artifact: Path, common_config: GateConfig) -> GateResult: ...
