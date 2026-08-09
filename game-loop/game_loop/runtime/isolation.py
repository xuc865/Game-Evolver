from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Any

from game_loop.utils import atomic_write_json


@dataclass(frozen=True)
class EpisodeIsolation:
    """Fresh HOME, config, session, cache, and Skill roots for one episode."""

    root: Path
    workspace: Path
    home: Path
    config_home: Path
    cache_home: Path
    data_home: Path

    @classmethod
    def create(
        cls,
        root: Path,
        *,
        workspace_seed: Path | None = None,
        skills_source: Path | None = None,
        settings: Mapping[str, Any] | None = None,
        system_prompt: str | None = None,
    ) -> "EpisodeIsolation":
        root = root.resolve()
        if root.exists() and any(root.iterdir()):
            raise ValueError(f"episode directory must be new or empty: {root}")
        root.mkdir(parents=True, exist_ok=True)
        workspace = root / "workspace"
        if workspace_seed is None:
            workspace.mkdir()
        else:
            source = workspace_seed.resolve()
            if not source.exists():
                raise FileNotFoundError(f"workspace seed does not exist: {source}")
            if source.is_dir():
                shutil.copytree(source, workspace)
            else:
                workspace.mkdir()
                shutil.copy2(source, workspace / source.name)

        # Never inherit project-local OpenGame state from a benchmark artifact.
        project_config = workspace / ".qwen"
        if project_config.exists():
            if project_config.is_dir():
                shutil.rmtree(project_config)
            else:
                project_config.unlink()
        project_config.mkdir(parents=True)

        home = root / "home"
        config_home = root / "xdg-config"
        cache_home = root / "xdg-cache"
        data_home = root / "xdg-data"
        for path in (home / ".qwen" / "projects", config_home, cache_home, data_home):
            path.mkdir(parents=True, exist_ok=True)

        atomic_write_json(project_config / "settings.json", dict(settings or {}))
        atomic_write_json(home / ".qwen" / "settings.json", {})
        (home / ".qwen" / "skills").mkdir(parents=True, exist_ok=True)
        skill_target = project_config / "skills"
        if skills_source is not None:
            source = skills_source.resolve()
            if not source.is_dir():
                raise ValueError(f"skills_source must be a directory: {source}")
            shutil.copytree(source, skill_target)
        else:
            skill_target.mkdir()
        if system_prompt is not None:
            (project_config / "system.md").write_text(system_prompt, encoding="utf-8")

        isolation = cls(root, workspace, home, config_home, cache_home, data_home)
        atomic_write_json(root / "isolation_manifest.json", isolation.to_dict())
        return isolation

    def environment(self, base: Mapping[str, str] | None = None) -> dict[str, str]:
        env = dict(os.environ)
        env.update(base or {})
        env.update({
            "HOME": str(self.home),
            "USERPROFILE": str(self.home),
            "XDG_CONFIG_HOME": str(self.config_home),
            "XDG_CACHE_HOME": str(self.cache_home),
            "XDG_DATA_HOME": str(self.data_home),
        })
        return env

    def to_dict(self) -> dict[str, str]:
        return {
            "root": str(self.root),
            "workspace": str(self.workspace),
            "home": str(self.home),
            "project_config": str(self.workspace / ".qwen"),
            "session_root": str(self.home / ".qwen" / "projects"),
            "personal_skills": str(self.home / ".qwen" / "skills"),
            "project_skills": str(self.workspace / ".qwen" / "skills"),
            "config_home": str(self.config_home),
            "cache_home": str(self.cache_home),
            "data_home": str(self.data_home),
        }
