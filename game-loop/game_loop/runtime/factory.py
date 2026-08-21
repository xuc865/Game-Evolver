from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from game_loop.runtime.base import MakerRuntime
from game_loop.runtime.deepseek_harness import (
    DeepSeekHarnessRunner,
    DeepSeekHarnessRuntime,
    DeepSeekHarnessRuntimeConfig,
)
from game_loop.runtime.opengame import (
    OpenGameRunner,
    OpenGameRuntime,
    OpenGameRuntimeConfig,
)

RuntimeConfig = OpenGameRuntimeConfig | DeepSeekHarnessRuntimeConfig
RuntimeRunner = OpenGameRunner | DeepSeekHarnessRunner


def load_runtime_config(value: Mapping[str, Any]) -> RuntimeConfig:
    runtime_type = str(value.get("runtime_type", "")).strip().casefold()
    runtime_id = str(value.get("runtime_id", "")).strip().casefold()
    if runtime_type in {"deepseek-harness", "deepseek_harness", "dsh"} or runtime_id.startswith(
        "deepseek-harness"
    ):
        return DeepSeekHarnessRuntimeConfig.from_dict(value)
    if runtime_type not in {"", "opengame"}:
        raise ValueError(f"unsupported maker runtime type: {runtime_type}")
    return OpenGameRuntimeConfig.from_dict(value)


def build_runtime(
    config: RuntimeConfig,
    *,
    runner: RuntimeRunner | None = None,
) -> MakerRuntime:
    if isinstance(config, DeepSeekHarnessRuntimeConfig):
        return DeepSeekHarnessRuntime(config, runner=runner)  # type: ignore[arg-type]
    return OpenGameRuntime(config, runner=runner)  # type: ignore[arg-type]
