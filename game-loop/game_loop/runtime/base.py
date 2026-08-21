from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from game_loop.runtime.protocol import GameSubmission, GameTask


class MakerRuntimeConfig(Protocol):
    runtime_id: str

    def to_dict(self, *, redact_environment: bool = False) -> dict[str, Any]: ...


class MakerRuntime(Protocol):
    config: MakerRuntimeConfig

    def run(self, task: GameTask, *, episode_dir: Path) -> GameSubmission: ...

    def doctor(self) -> Mapping[str, Any]: ...
