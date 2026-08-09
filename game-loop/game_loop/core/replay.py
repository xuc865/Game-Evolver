from __future__ import annotations

import json
import sys
from pathlib import Path

from game_loop.core.harness import HarnessProfile, HarnessReplayCase


class CommandHarnessReplayRunner:
    def __init__(self, *, runs_root: Path, project_root: Path):
        self.runs_root = runs_root.resolve()
        self.project_root = project_root.resolve()

    def build_commands(
        self,
        case: HarnessReplayCase,
        harness: HarnessProfile,
        *,
        side: str,
        epoch: int,
    ) -> tuple[Path, list[str], list[str]]:
        run_dir = (
            self.runs_root / f"epoch_{epoch:03d}" / case.case_id / side
        ).resolve()
        config_path = Path(str(case.metadata.get("config_path", ""))).resolve()
        harness_path = run_dir / "harness_profile.json"
        harness_path.parent.mkdir(parents=True, exist_ok=True)
        harness_path.write_text(
            json.dumps(harness.to_dict(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        python = sys.executable
        init_argv = [
            python,
            "-m",
            "game_loop",
            "init",
            "--run-dir",
            str(run_dir),
            "--task-source",
            str(Path(case.task_ref).resolve()),
            "--seed-artifact",
            str(Path(case.parent_artifact_ref).resolve()),
            "--config",
            str(config_path),
            "--harness-profile",
            str(harness_path),
        ]
        if "seed_score" in case.metadata:
            init_argv.extend(["--seed-score", str(case.metadata["seed_score"])])
        evolve_argv = [
            python,
            "-m",
            "game_loop",
            "evolve",
            "--run-dir",
            str(run_dir),
            "--config",
            str(config_path),
        ]
        return run_dir, init_argv, evolve_argv
