from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from web.server import build_game_evolver_payload, build_review_payload, build_workspace_payload


def test_settings_payload_never_exposes_secrets(tmp_path: Path) -> None:
    with patch.dict("os.environ", {"OPENAI_API_KEY": "top-secret"}, clear=False):
        payload = build_workspace_payload(tmp_path, "settings")
    encoded = json.dumps(payload)
    assert "top-secret" not in encoded
    assert payload["secrets_exposed"] is False
    openai = next(row for row in payload["providers"] if row["provider"] == "openai")
    assert openai["credential_present"] is True


def test_review_payload_keeps_reviewer_and_human_gates_separate(tmp_path: Path) -> None:
    target = tmp_path / ".vibegame" / "review" / "acceptance.json"
    target.parent.mkdir(parents=True)
    target.write_text(
        json.dumps({"reviewer": {"verdict": "accepted"}, "human": {"approved": False}}),
        encoding="utf-8",
    )
    acceptance = build_review_payload(tmp_path)["acceptance"]
    assert acceptance["reviewer"]["verdict"] == "accepted"
    assert acceptance["human"]["approved"] is False


def test_scenes_payload_reads_real_scene_files(tmp_path: Path) -> None:
    scenes = tmp_path / "scenes"
    scenes.mkdir()
    (scenes / "main.scene.json").write_text('{"name":"Main"}', encoding="utf-8")
    payload = build_workspace_payload(tmp_path, "scenes")
    assert payload["scenes"] == [
        {"path": "scenes/main.scene.json", "data": {"name": "Main"}}
    ]


def test_game_evolver_payload_tracks_review_and_baseline_phase(tmp_path: Path) -> None:
    review = tmp_path / ".vibegame" / "review" / "acceptance.json"
    review.parent.mkdir(parents=True)
    review.write_text(
        json.dumps({"reviewer": {"verdict": "accepted"}, "human": {"approved": True}}),
        encoding="utf-8",
    )
    ready = build_game_evolver_payload(tmp_path)
    assert ready["reviewer_accepted"] is True
    assert ready["human_approved"] is True
    assert ready["promoted"] is False
    (tmp_path / "game-evolver-baseline.json").write_text(
        json.dumps({"status": "accepted", "evolution_seed": True}), encoding="utf-8"
    )
    promoted = build_game_evolver_payload(tmp_path)
    assert promoted["phase"] == "evolve"
    assert promoted["promoted"] is True
