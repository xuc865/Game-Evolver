from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class RunLockedError(RuntimeError):
    """Raised when a run directory is already locked."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_json(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Use a unique sibling temporary file so concurrent workers cannot
    # overwrite one another while updating a shared summary or manifest.
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class RunLock:
    def __init__(self, run_dir: Path):
        self.path = run_dir / ".loop.lock"

    def __enter__(self) -> "RunLock":
        if self.path.is_dir() and not self._try_acquire():
            self._clear_if_stale()
        if not self._try_acquire():
            owner = self.path / "owner.json"
            detail = read_json(owner) if owner.is_file() else {}
            raise RunLockedError(f"run already locked: {detail}")
        return self

    def _try_acquire(self) -> bool:
        try:
            self.path.mkdir()
        except FileExistsError:
            return False
        atomic_write_json(self.path / "owner.json", {"pid": os.getpid(), "at": utc_now()})
        return True

    def _clear_if_stale(self) -> None:
        owner = self.path / "owner.json"
        if owner.is_file():
            pid = read_json(owner).get("pid")
            if isinstance(pid, int) and pid > 0:
                try:
                    os.kill(pid, 0)
                    return
                except OSError:
                    pass
        if owner.exists():
            owner.unlink()
        if self.path.exists():
            self.path.rmdir()

    def __exit__(self, exc_type, exc, tb) -> None:
        owner = self.path / "owner.json"
        if owner.exists():
            owner.unlink()
        if self.path.exists():
            self.path.rmdir()
