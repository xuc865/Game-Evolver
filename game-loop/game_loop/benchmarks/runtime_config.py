from __future__ import annotations

import os
from pathlib import Path

from game_loop.runtime.profile import merge_runtime_profile
from game_loop.runtime.opengame import OpenGameRuntimeConfig
from game_loop.utils import read_json


ROOT = Path(__file__).resolve().parents[2]
OPENGAME_PROFILE = ROOT / "experiments" / "inner-agent" / "opengame-profile.local.json"
BACKBONES = ROOT / "experiments" / "inner-agent" / "backbones"
AWESOME_BASELINE = (
    ROOT / "experiments" / "baselines" / "awesome-gamedev-agent-skills.runtime.json"
)


def runtime_config_from_environment(
    *,
    provider: str | None = None,
    timeout_seconds: int | None = None,
) -> OpenGameRuntimeConfig:
    """Build the same pinned runtime profile used by comprehensive smoke."""

    provider_name = (
        provider
        or os.environ.get("GAME_LOOP_BACKBONE_PROVIDER")
        or "qwen"
    ).strip().lower()
    backbone = BACKBONES / f"{provider_name}.json"
    if not backbone.is_file():
        raise FileNotFoundError(f"unknown OpenGame backbone profile: {backbone}")
    baseline = (
        read_json(AWESOME_BASELINE)
        if os.environ.get("GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS", "").strip() == "1"
        else None
    )
    config = merge_runtime_profile(
        opengame_profile=read_json(OPENGAME_PROFILE),
        baseline_profile=baseline,
        backbone_profile=read_json(backbone),
    )
    if timeout_seconds is not None:
        config = OpenGameRuntimeConfig.from_dict(
            {**config.to_dict(), "timeout_seconds": int(timeout_seconds)}
        )
    max_turns = os.environ.get("GAME_LOOP_OPENGAME_MAX_SESSION_TURNS", "").strip()
    if max_turns:
        config = OpenGameRuntimeConfig.from_dict(
            {**config.to_dict(), "max_session_turns": int(max_turns)}
        )
    env_timeout = os.environ.get("GAME_LOOP_OPENGAME_TIMEOUT_SECONDS", "").strip()
    if env_timeout:
        config = OpenGameRuntimeConfig.from_dict(
            {**config.to_dict(), "timeout_seconds": int(env_timeout)}
        )
    permission_mode = os.environ.get("GAME_LOOP_OPENGAME_PERMISSION_MODE", "").strip()
    if permission_mode:
        config = OpenGameRuntimeConfig.from_dict(
            {**config.to_dict(), "permission_mode": permission_mode}
        )
    exclude_tools = os.environ.get("GAME_LOOP_OPENGAME_EXCLUDE_TOOLS")
    if exclude_tools is not None:
        tools = [item.strip() for item in exclude_tools.split(",") if item.strip()]
        config = OpenGameRuntimeConfig.from_dict(
            {**config.to_dict(), "exclude_tools": tools}
        )
    return config
