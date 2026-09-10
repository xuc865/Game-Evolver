from pathlib import Path
from unittest.mock import Mock, patch
import json

import pytest

from game_loop.vibegame_bridge import is_accepted_vibegame_baseline, promote_vibegame_baseline


def test_promotion_requires_human_acceptance(tmp_path: Path) -> None:
    (tmp_path / ".vibegame").mkdir()
    (tmp_path / ".vibegame" / "seed-request.json").write_text('{"prompt":"boss"}')
    with patch("game_loop.vibegame_bridge.validate_vibegame_project", return_value={"ok": True}):
        with pytest.raises(RuntimeError, match="acceptance"):
            promote_vibegame_baseline(tmp_path, accepted_by="reviewer")


def test_accepted_project_becomes_evolution_seed(tmp_path: Path) -> None:
    (tmp_path / ".vibegame" / "review").mkdir(parents=True)
    (tmp_path / ".vibegame" / "seed-request.json").write_text('{"prompt":"boss"}')
    (tmp_path / ".vibegame" / "review" / "acceptance.json").write_text(
        '{"reviewer":{"verdict":"accepted"},"human":{"approved":true}}'
    )
    with patch("game_loop.vibegame_bridge.validate_vibegame_project", return_value={"ok": True}):
        manifest = promote_vibegame_baseline(tmp_path, accepted_by="human")
    assert manifest.status == "accepted"
    assert is_accepted_vibegame_baseline(tmp_path)


def test_reviewer_alone_cannot_promote(tmp_path: Path) -> None:
    (tmp_path / ".vibegame" / "review").mkdir(parents=True)
    (tmp_path / ".vibegame" / "seed-request.json").write_text('{"prompt":"boss"}')
    (tmp_path / ".vibegame" / "review" / "acceptance.json").write_text(
        '{"reviewer":{"verdict":"accepted"},"human":{"approved":false}}'
    )
    with patch("game_loop.vibegame_bridge.validate_vibegame_project", return_value={"ok": True}):
        with pytest.raises(RuntimeError, match="human approval"):
            promote_vibegame_baseline(tmp_path, accepted_by="reviewer")


def test_unattended_experiment_gate_keeps_human_pending(tmp_path: Path) -> None:
    (tmp_path / ".vibegame" / "review").mkdir(parents=True)
    (tmp_path / ".vibegame" / "seed-request.json").write_text('{"prompt":"boss"}')
    (tmp_path / ".vibegame" / "review" / "play.png").write_bytes(b"evidence")
    (tmp_path / ".vibegame" / "review" / "acceptance.json").write_text(
        json.dumps({
            "reviewer": {"verdict": "accepted"},
            "human": {"approved": None},
            "automated_experiment_gate": {
                "mode": "unattended-experiment",
                "verdict": "accepted",
                "checks": {"runtime": True, "playability": True, "assets": True},
                "evidence": [".vibegame/review/play.png"],
            },
        })
    )
    with patch("game_loop.vibegame_bridge.validate_vibegame_project", return_value={"ok": True}):
        manifest = promote_vibegame_baseline(
            tmp_path, accepted_by="automated-reviewer", unattended_experiment=True
        )
    assert manifest.approval_mode == "unattended-experiment"
    assert manifest.human_approval == "pending"
