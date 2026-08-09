from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

from game_loop.utils import atomic_write_json, utc_now


class SupervisorHeartbeatWriter:
    """Background heartbeat writer for long-running supervisor / case work."""

    def __init__(self, path: Path, *, interval_seconds: float = 30.0) -> None:
        self.path = path.resolve()
        self.interval_seconds = interval_seconds
        self._state: dict[str, Any] = {"pid": os.getpid()}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def update(self, **fields: Any) -> None:
        with self._lock:
            self._state.update(fields)
            self._state["pid"] = os.getpid()

    def write_now(self) -> None:
        with self._lock:
            payload = dict(self._state)
        payload["updated_at"] = utc_now()
        atomic_write_json(self.path, payload)

    def start(self) -> None:
        if self._thread is not None:
            return
        self.write_now()

        def _loop() -> None:
            while not self._stop.wait(self.interval_seconds):
                self.write_now()

        self._thread = threading.Thread(target=_loop, name="supervisor-heartbeat", daemon=True)
        self._thread.start()

    def stop(self, *, phase: str = "stopped") -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self.update(phase=phase)
        self.write_now()
