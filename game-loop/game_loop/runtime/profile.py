from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping

from game_loop.runtime.opengame import OpenGameRuntimeConfig
from game_loop.utils import read_json


def load_opengame_profile(path: Path) -> dict[str, Any]:
    return read_json(path.resolve())


def load_backbone_profile(path: Path) -> dict[str, Any]:
    return read_json(path.resolve())


def merge_runtime_profile(
    *,
    opengame_profile: Mapping[str, Any],
    backbone_profile: Mapping[str, Any] | None = None,
) -> OpenGameRuntimeConfig:
    """Merge a pinned OpenGame SDK profile with an optional backbone provider."""

    merged = deepcopy(dict(opengame_profile))
    if backbone_profile:
        provider = backbone_profile.get("backbone_provider")
        if provider:
            merged["backbone_provider"] = str(provider)
        for key in ("runtime_id", "permission_mode", "max_session_turns", "timeout_seconds"):
            if key in backbone_profile and backbone_profile[key] is not None:
                merged[key] = backbone_profile[key]
        merged.setdefault("environment", {})
        merged["environment"] = {
            **dict(merged.get("environment", {})),
            **dict(backbone_profile.get("environment", {})),
        }
    return OpenGameRuntimeConfig.from_dict(merged)


def write_runtime_profile(path: Path, config: OpenGameRuntimeConfig) -> Path:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def resolve_runtime_profile(
    *,
    opengame_profile: Path,
    backbone_profile: Path | None = None,
) -> OpenGameRuntimeConfig:
    return merge_runtime_profile(
        opengame_profile=load_opengame_profile(opengame_profile),
        backbone_profile=None if backbone_profile is None else load_backbone_profile(backbone_profile),
    )
