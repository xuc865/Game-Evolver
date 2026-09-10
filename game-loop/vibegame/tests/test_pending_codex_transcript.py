import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from web import server

pytestmark = pytest.mark.base


def _rollout(tmp_path: Path, *, session_id: str, source="cli") -> Path:
    path = tmp_path / ".codex" / "sessions" / "2026" / "09" / "11" / f"rollout-{session_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "type": "session_meta",
        "payload": {
            "id": session_id,
            "cwd": str(tmp_path),
            "source": source,
        },
    }) + "\n", encoding="utf-8")
    return path


def test_discover_codex_transcript_uses_open_top_level_rollout(tmp_path, monkeypatch):
    main = _rollout(tmp_path, session_id="real-session")
    subagent = _rollout(
        tmp_path,
        session_id="child-session",
        source={"subagent": {"thread_spawn": {"depth": 1}}},
    )
    monkeypatch.setattr(server, "_tmux_pane_process_ids", lambda pane: {123})
    monkeypatch.setattr(server.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        returncode=0,
        stdout=f"p123\nn{main}\nn{subagent}\n",
    ))

    assert server._discover_codex_transcript_for_pane("%7", str(tmp_path)) == (
        "real-session",
        str(main),
    )


def test_rollout_identity_rejects_different_workspace(tmp_path):
    rollout = _rollout(tmp_path, session_id="wrong-workspace")
    assert server._codex_rollout_identity(rollout, str(tmp_path / "elsewhere")) is None
