from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Any

from game_loop.utils import atomic_write_json


@dataclass(frozen=True)
class EpisodeIsolation:
    """Fresh HOME, config, session, cache, and skill roots for one episode."""

    root: Path
    workspace: Path
    home: Path
    config_home: Path
    cache_home: Path
    data_home: Path
    runtime_layout: str = "opengame"

    @classmethod
    def create(
        cls,
        root: Path,
        *,
        workspace_seed: Path | None = None,
        skills_source: Path | None = None,
        settings: Mapping[str, Any] | None = None,
        system_prompt: str | None = None,
        runtime_layout: str = "opengame",
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

        home = root / "home"
        config_home = root / "xdg-config"
        cache_home = root / "xdg-cache"
        data_home = root / "xdg-data"
        if runtime_layout not in {"opengame", "deepseek-harness"}:
            raise ValueError(f"unsupported episode runtime layout: {runtime_layout}")
        for path in (home, config_home, cache_home, data_home):
            path.mkdir(parents=True, exist_ok=True)
        if runtime_layout == "opengame":
            # Never inherit project-local OpenGame state from a benchmark artifact.
            project_config = workspace / ".qwen"
            if project_config.exists():
                if project_config.is_dir():
                    shutil.rmtree(project_config)
                else:
                    project_config.unlink()
            project_config.mkdir(parents=True)
            (home / ".qwen" / "projects").mkdir(parents=True)
            atomic_write_json(project_config / "settings.json", dict(settings or {}))
            atomic_write_json(home / ".qwen" / "settings.json", {})
            (home / ".qwen" / "skills").mkdir(parents=True, exist_ok=True)
            skill_target = project_config / "skills"
            if skills_source is not None:
                source = skills_source.resolve()
                if not source.is_dir():
                    raise ValueError(f"skills_source must be a directory: {source}")
                _copy_skills_source(source, skill_target)
            else:
                skill_target.mkdir()
            if system_prompt is not None:
                (project_config / "system.md").write_text(system_prompt, encoding="utf-8")
        else:
            # A benchmark seed is data, not launcher configuration.  In
            # particular, never let a previous episode's skill roster leak
            # into this episode or collide with an explicitly installed one.
            inherited_skills = workspace / ".agents" / "skills"
            if inherited_skills.exists():
                if inherited_skills.is_dir():
                    shutil.rmtree(inherited_skills)
                else:
                    inherited_skills.unlink()

        isolation = cls(
            root,
            workspace,
            home,
            config_home,
            cache_home,
            data_home,
            runtime_layout,
        )
        atomic_write_json(root / "isolation_manifest.json", isolation.to_dict())
        return isolation

    def environment(
        self,
        base: Mapping[str, str] | None = None,
        *,
        inherit_process: bool = True,
    ) -> dict[str, str]:
        env = dict(os.environ) if inherit_process else {}
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
        value = {
            "root": str(self.root),
            "workspace": str(self.workspace),
            "home": str(self.home),
            "config_home": str(self.config_home),
            "cache_home": str(self.cache_home),
            "data_home": str(self.data_home),
            "runtime_layout": self.runtime_layout,
        }
        if self.runtime_layout == "opengame":
            value.update({
                "project_config": str(self.workspace / ".qwen"),
                "session_root": str(self.home / ".qwen" / "projects"),
                "personal_skills": str(self.home / ".qwen" / "skills"),
                "project_skills": str(self.workspace / ".qwen" / "skills"),
            })
        else:
            value.update({
                "project_config": str(self.home / ".dsh"),
                "session_root": str(self.root / "sessions"),
                "personal_skills": str(self.home / ".dsh" / "skills"),
                "project_skills": str(self.workspace / ".agents" / "skills"),
            })
        return value


def _copy_skills_source(source: Path, destination: Path) -> None:
    """Materialize named upstream bundles without nesting their category tree."""

    if (source / "router" / "SKILL.md").is_file() and (source / "skills").is_dir():
        from game_loop.baselines.awesome_gamedev_skills import materialize_skills_source

        materialize_skills_source(source, destination)
        return
    shutil.copytree(source, destination)
