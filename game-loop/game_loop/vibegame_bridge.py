"""Bridge accepted VibeGame projects into the Game-Evolver continuation loop."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


VIBEGAME_ROOT = Path(__file__).resolve().parents[1] / "vibegame"
VIBEGAME_SRC = VIBEGAME_ROOT / "src"
BASELINE_FILENAME = "game-evolver-baseline.json"


@dataclass(frozen=True)
class BaselineManifest:
    schema_version: int
    status: str
    engine: str
    project_dir: str
    prompt: str
    concept_image: str | None
    accepted_by: str
    accepted_at: str
    validation: dict[str, Any]
    approval_mode: str = "human"
    human_approval: str = "approved"
    automated_gate: dict[str, Any] | None = None
    evolution_seed: bool = True


def _vibegame_command(*args: str) -> list[str]:
    return [str(vibegame_python()), "-m", "cli.main", *args]


def vibegame_python() -> Path:
    """Select VibeGame's Python >=3.12 runtime without changing Game-Evolver's env."""
    configured = os.environ.get("VIBEGAME_PYTHON")
    candidates = [
        Path(configured).expanduser() if configured else None,
        VIBEGAME_ROOT.parent / ".venvs" / "vibegame" / "bin" / "python",
        Path(sys.executable),
    ]
    for candidate in candidates:
        if not candidate or not candidate.is_file():
            continue
        completed = subprocess.run(
            [str(candidate), "-c", "import sys; raise SystemExit(sys.version_info < (3, 12))"],
            capture_output=True,
            check=False,
        )
        if completed.returncode == 0:
            # Keep a venv launcher as a venv launcher. Resolving its symlink to
            # the base interpreter loses the environment's installed packages.
            return candidate.absolute()
    raise RuntimeError(
        "VibeGame requires Python 3.12+. Set VIBEGAME_PYTHON or create "
        ".venvs/vibegame with `uv venv --python 3.12`."
    )


def _environment() -> dict[str, str]:
    env = dict(os.environ)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(VIBEGAME_SRC) + (os.pathsep + existing if existing else "")
    return env


def initialize_vibegame_project(
    project_dir: Path,
    *,
    prompt: str,
    concept_image: Path | None = None,
    language: str = "en",
) -> dict[str, Any]:
    project_dir = project_dir.resolve()
    project_dir.mkdir(parents=True, exist_ok=True)
    command = _vibegame_command(
        "init", str(project_dir), "--lang", language, "--choice", "skip", "--no-commit"
    )
    completed = subprocess.run(
        command,
        cwd=VIBEGAME_ROOT,
        env=_environment(),
        capture_output=True,
        text=True,
        timeout=180,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())

    concept_rel: str | None = None
    if concept_image is not None:
        source = concept_image.resolve()
        if not source.is_file():
            raise FileNotFoundError(source)
        destination = project_dir / "assets" / "concepts" / "concept.png"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        concept_rel = destination.relative_to(project_dir).as_posix()

    goal = project_dir / ".vibegame" / "goal.md"
    goal.write_text(
        "# Current game goal\n\n" + prompt.strip() + "\n\n"
        "## Human-in-the-loop gates\n\n"
        "1. Confirm GDD and core loop.\n"
        "2. Confirm concept art and visual direction.\n"
        "3. Play the reviewer build before accepting it as an evolution seed.\n",
        encoding="utf-8",
    )
    seed_request = {
        "schema_version": 1,
        "prompt": prompt,
        "concept_image": concept_rel,
        "required_tabs": ["chat", "design", "assets", "objects", "scenes", "play", "review", "evolution", "settings"],
        "acceptance_required": True,
    }
    request_path = project_dir / ".vibegame" / "seed-request.json"
    request_path.write_text(json.dumps(seed_request, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "project_dir": str(project_dir),
        "prompt": prompt,
        "concept_image": concept_rel,
        "stdout": completed.stdout,
    }


def validate_vibegame_project(project_dir: Path) -> dict[str, Any]:
    completed = subprocess.run(
        _vibegame_command("check", str(project_dir.resolve())),
        cwd=VIBEGAME_ROOT,
        env=_environment(),
        capture_output=True,
        text=True,
        timeout=180,
    )
    return {
        "ok": completed.returncode == 0,
        "returncode": completed.returncode,
        "stdout": completed.stdout[-12000:],
        "stderr": completed.stderr[-4000:],
    }


def promote_vibegame_baseline(
    project_dir: Path,
    *,
    accepted_by: str,
    force: bool = False,
    unattended_experiment: bool = False,
) -> BaselineManifest:
    project_dir = project_dir.resolve()
    seed_request_path = project_dir / ".vibegame" / "seed-request.json"
    if not seed_request_path.is_file():
        raise ValueError("project has no .vibegame/seed-request.json")
    request = json.loads(seed_request_path.read_text(encoding="utf-8"))
    validation = validate_vibegame_project(project_dir)
    if not validation["ok"]:
        raise RuntimeError("VibeGame validation failed; baseline cannot be promoted")

    review_path = project_dir / ".vibegame" / "review" / "acceptance.json"
    review = json.loads(review_path.read_text(encoding="utf-8")) if review_path.is_file() else {}
    reviewer_accepted = review.get("reviewer", {}).get("verdict") == "accepted"
    human_accepted = review.get("human", {}).get("approved") is True
    automated_gate = review.get("automated_experiment_gate", {})
    automated_checks = automated_gate.get("checks", {})
    evidence_paths = automated_gate.get("evidence", [])
    evidence_valid = bool(evidence_paths) and all(
        isinstance(value, str)
        and value
        and (project_dir / value).resolve().is_relative_to(project_dir)
        and (project_dir / value).is_file()
        for value in evidence_paths
    )
    unattended_accepted = (
        unattended_experiment
        and reviewer_accepted
        and automated_gate.get("mode") == "unattended-experiment"
        and automated_gate.get("verdict") == "accepted"
        and all(automated_checks.get(name) is True for name in ("runtime", "playability", "assets"))
        and evidence_valid
        and review.get("human", {}).get("approved") is None
    )
    if not force and not (reviewer_accepted and human_accepted) and not unattended_accepted:
        raise RuntimeError(
            "reviewer verdict and human approval are both required; record them in "
            ".vibegame/review/acceptance.json after Play review. Unattended experiments "
            "may instead use --unattended-experiment with a passing automated_experiment_gate "
            "and human.approved left null; --force remains an explicit manual override"
        )
    approval_mode = "unattended-experiment" if unattended_accepted else "human"
    if force and not (reviewer_accepted and human_accepted) and not unattended_accepted:
        approval_mode = "manual-force"
    manifest = BaselineManifest(
        schema_version=1,
        status="accepted",
        engine="vibegame-phaser",
        project_dir=str(project_dir),
        prompt=str(request.get("prompt") or ""),
        concept_image=request.get("concept_image"),
        accepted_by=accepted_by,
        accepted_at=datetime.now(timezone.utc).isoformat(),
        validation=validation,
        approval_mode=approval_mode,
        human_approval="pending" if unattended_accepted else ("approved" if human_accepted else "overridden"),
        automated_gate=automated_gate if unattended_accepted else None,
    )
    (project_dir / BASELINE_FILENAME).write_text(
        json.dumps(asdict(manifest), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def is_accepted_vibegame_baseline(project_dir: Path) -> bool:
    path = project_dir / BASELINE_FILENAME
    if not path.is_file():
        return False
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return value.get("status") == "accepted" and value.get("evolution_seed") is True
