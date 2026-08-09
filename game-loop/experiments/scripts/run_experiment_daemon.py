#!/usr/bin/env python3
"""Start, stop, and inspect one isolated experiment run.

This file is copied into a run directory by ``bootstrap_produce_run.py``.  It
derives that directory from its own location, so it has no model/run-specific
source substitutions and never depends on another run's mutable artifacts.
"""
from __future__ import annotations

import os
import json
import signal
import subprocess
import sys
import time
from pathlib import Path


def _run_dir() -> Path:
    return Path(__file__).resolve().parent


def _repo_root() -> Path:
    return _run_dir().parents[2]


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (ProcessLookupError, OSError):
        return False


def _read_pid(path: Path) -> int | None:
    if not path.is_file():
        return None
    raw = path.read_text(encoding="utf-8").strip()
    return int(raw) if raw.isdigit() else None


def _read_json_pid(path: Path) -> int | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    pid = payload.get("pid") if isinstance(payload, dict) else None
    return pid if isinstance(pid, int) and pid > 0 else None


def _process_table() -> dict[int, tuple[int, str]] | None:
    try:
        completed = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,command="],
            check=True,
            text=True,
            capture_output=True,
        )
    except OSError:
        return None
    result: dict[int, tuple[int, str]] = {}
    for line in completed.stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3 and fields[0].isdigit() and fields[1].isdigit():
            result[int(fields[0])] = (int(fields[1]), fields[2])
    return result


def _owned_process_tree(
    run_dir: Path,
    table: dict[int, tuple[int, str]] | None = None,
) -> list[int]:
    if table is None:
        table = _process_table()
    if table is None:
        return []
    marker = str(run_dir)
    roots: set[int] = set()
    pid_files = (
        (run_dir / "daemon.pid", _read_pid),
        (run_dir / "watchdog.pid", _read_pid),
        (run_dir / "supervisor.pid", _read_pid),
        (run_dir / ".supervisor.pid", _read_json_pid),
    )
    for path, reader in pid_files:
        pid = reader(path)
        # A stale/reused pid must never be killed merely because it remains in a
        # pidfile.  Every accepted root has to name this exact run directory.
        if pid is not None and pid in table and marker in table[pid][1]:
            roots.add(pid)
    owned = set(roots)
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _command) in table.items():
            if ppid in owned and pid not in owned:
                owned.add(pid)
                changed = True
    # Children first makes shutdown deterministic and avoids leaving tool/model
    # workers orphaned after their supervisor exits.
    return sorted(owned, key=lambda pid: _depth(pid, table, owned), reverse=True)


def _depth(pid: int, table: dict[int, tuple[int, str]], owned: set[int]) -> int:
    depth = 0
    current = pid
    while current in table and table[current][0] in owned:
        depth += 1
        current = table[current][0]
    return depth


def _daemon_child() -> None:
    root = _repo_root()
    run_dir = _run_dir()
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    pid_text = f"{os.getpid()}\n"
    # The daemon process execs the foreground watchdog, so these two ownership
    # roles intentionally share one PID.  Recording both keeps status/stop
    # semantics truthful without spawning a duplicate watchdog.
    (run_dir / "daemon.pid").write_text(pid_text, encoding="utf-8")
    (run_dir / "watchdog.pid").write_text(pid_text, encoding="utf-8")
    os.umask(0o022)
    os.chdir(root)
    log_fd = os.open(str(run_dir / "daemon.log"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(log_fd, 1)
    os.dup2(log_fd, 2)
    os.close(log_fd)
    env = os.environ.copy()
    env.update(PYTHONPATH=str(root), PYTHONUNBUFFERED="1")
    watchdog = run_dir / "watchdog.sh"
    os.execve("/bin/bash", ["/bin/bash", str(watchdog), "--foreground"], env)


def cmd_start() -> int:
    root = _repo_root()
    run_dir = _run_dir()
    existing = _read_pid(run_dir / "daemon.pid")
    if existing is not None and existing in _owned_process_tree(run_dir):
        print(f"[daemon] already running pid={existing}")
        return 0
    if existing is not None and _pid_alive(existing):
        print(f"[daemon] already running pid={existing} (process table unavailable)")
        return 0
    business_pid = _read_json_pid(run_dir / ".supervisor.pid")
    if business_pid is not None and _pid_alive(business_pid):
        print(f"[daemon] already running business pid={business_pid}")
        return 0
    subprocess.run([sys.executable, str(Path(__file__).resolve()), "--daemon-child"], cwd=root, check=True)
    time.sleep(1)
    subprocess.run(["bash", str(run_dir / "start_supervisor.sh")], cwd=root, check=True)
    print(f"[daemon] started pid={_read_pid(run_dir / 'daemon.pid')}")
    return 0


def cmd_stop() -> int:
    run_dir = _run_dir()
    owned = _owned_process_tree(run_dir)
    for pid in owned:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and any(_pid_alive(pid) for pid in owned):
        time.sleep(0.2)
    for pid in owned:
        if _pid_alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    for name in ("daemon", "watchdog", "supervisor"):
        (run_dir / f"{name}.pid").unlink(missing_ok=True)
    print(f"[daemon] stopped {len(owned)} owned processes")
    return 0


def cmd_status() -> int:
    run_dir = _run_dir()
    table = _process_table()
    owned = set(_owned_process_tree(run_dir, table))
    for name in ("daemon", "watchdog", "supervisor"):
        pid = _read_pid(run_dir / f"{name}.pid")
        if table is None:
            state = "UNKNOWN (process table unavailable)"
        else:
            state = "ALIVE" if pid in owned else "DEAD"
        print(f"{name}: pid={pid} {state}")
    heartbeat = run_dir / ".supervisor_heartbeat.json"
    if heartbeat.is_file():
        print(heartbeat.read_text(encoding="utf-8"))
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--daemon-child"]:
        _daemon_child()
        return 0
    command = argv[0] if argv else "start"
    if command == "start":
        return cmd_start()
    if command == "stop":
        return cmd_stop()
    if command == "status":
        return cmd_status()
    print("Usage: run_experiment_daemon.py {start|stop|status}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
