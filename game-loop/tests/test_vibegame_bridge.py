from pathlib import Path
from unittest.mock import Mock, patch

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


def test_unattended_experiment_gate_keeps_human_approval_pending(tmp_path: Path) -> None:
    (tmp_path / ".vibegame" / "review").mkdir(parents=True)
    (tmp_path / ".vibegame" / "seed-request.json").write_text('{"prompt":"fighter"}')
    (tmp_path / ".vibegame" / "review" / "acceptance.json").write_text(
        '{"reviewer":{"verdict":"accepted"},"human":{"approved":false}}'
    )
    evidence = tmp_path / "unattended-gate.json"
    evidence.write_text(
        '{"schema_version":1,"gate":"unattended-experiment",'
        '"requested_by":"user delegation",'
        '"human_approval_pending":true,"automated_playtest":{"passed":true}}'
    )
    with patch("game_loop.vibegame_bridge.validate_vibegame_project", return_value={"ok": True}):
        manifest = promote_vibegame_baseline(
            tmp_path,
            accepted_by="automated-reviewer",
            unattended_evidence=evidence,
        )
    assert manifest.acceptance_mode == "unattended-experiment"
    assert manifest.unattended_evidence["human_approval_pending"] is True
    assert manifest.unattended_evidence["sha256"]


def test_unattended_gate_rejects_failed_playtest(tmp_path: Path) -> None:
    (tmp_path / ".vibegame" / "review").mkdir(parents=True)
    (tmp_path / ".vibegame" / "seed-request.json").write_text('{"prompt":"fighter"}')
    (tmp_path / ".vibegame" / "review" / "acceptance.json").write_text(
        '{"reviewer":{"verdict":"accepted"},"human":{"approved":false}}'
    )
    evidence = tmp_path / "unattended-gate.json"
    evidence.write_text(
        '{"schema_version":1,"gate":"unattended-experiment",'
        '"requested_by":"user delegation",'
        '"human_approval_pending":true,"automated_playtest":{"passed":false}}'
    )
    with patch("game_loop.vibegame_bridge.validate_vibegame_project", return_value={"ok": True}):
        with pytest.raises(RuntimeError, match="automated-playtest evidence"):
            promote_vibegame_baseline(
                tmp_path,
                accepted_by="automated-reviewer",
                unattended_evidence=evidence,
            )
