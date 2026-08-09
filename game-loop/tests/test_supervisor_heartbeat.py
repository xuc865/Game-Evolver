from __future__ import annotations

import json
import time
from pathlib import Path

from game_loop.supervisor_heartbeat import SupervisorHeartbeatWriter


def test_supervisor_heartbeat_writer_updates_file(tmp_path: Path):
    path = tmp_path / ".supervisor_heartbeat.json"
    writer = SupervisorHeartbeatWriter(path, interval_seconds=0.05)
    writer.update(current_epoch=1, phase="epoch_1", case_id="e001-02")
    writer.start()
    time.sleep(0.12)
    writer.stop(phase="stopped:test")

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["current_epoch"] == 1
    assert payload["case_id"] == "e001-02"
    assert payload["phase"] == "stopped:test"
    assert "updated_at" in payload
