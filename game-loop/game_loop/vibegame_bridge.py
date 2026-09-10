"""Bridge accepted VibeGame projects into the Game-Evolver continuation loop."""

from __future__ import annotations

import json
import hashlib
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
    evolution_seed: bool = True
    acceptance_mode: str = "human"
    unattended_evidence: dict[str, Any] | None = None


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
    unattended_evidence: Path | None = None,
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
    experiment_evidence: dict[str, Any] | None = None
    acceptance_mode = "human"
    if unattended_evidence is not None:
        if force:
            raise ValueError("--force and --unattended-evidence are mutually exclusive")
        evidence_path = unattended_evidence.resolve()
        if not evidence_path.is_file():
            raise FileNotFoundError(evidence_path)
        experiment_evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        valid_experiment_gate = (
            experiment_evidence.get("schema_version") == 1
            and experiment_evidence.get("gate") == "unattended-experiment"
            and experiment_evidence.get("human_approval_pending") is True
            and experiment_evidence.get("automated_playtest", {}).get("passed") is True
            and bool(experiment_evidence.get("requested_by"))
        )
        if human_accepted:
            raise RuntimeError(
                "unattended experiment evidence requires human approval to remain pending"
            )
        if not (reviewer_accepted and valid_experiment_gate):
            raise RuntimeError(
                "unattended experiment promotion requires reviewer acceptance and valid "
                "automated-playtest evidence with human_approval_pending=true"
            )
        acceptance_mode = "unattended-experiment"
        experiment_evidence = {
            "path": str(evidence_path),
            "sha256": hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
            "gate": experiment_evidence["gate"],
            "requested_by": experiment_evidence["requested_by"],
            "human_approval_pending": True,
        }
    elif not force and not (reviewer_accepted and human_accepted):
        raise RuntimeError(
            "reviewer verdict and human approval are both required; record them in "
            ".vibegame/review/acceptance.json after Play review, or use --force for an "
            "explicit manual override"
        )
    elif force:
        acceptance_mode = "manual-force"
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
        acceptance_mode=acceptance_mode,
        unattended_evidence=experiment_evidence,
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
