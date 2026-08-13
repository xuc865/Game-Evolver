#!/usr/bin/env python3
"""Keep the dedicated TerminalBench Docker VM below a disk high-water mark."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNS = (ROOT / "experiments" / "general-baseline-runs").resolve()
EXPECTED_SOCKET = Path.home() / ".colima" / "terminalbench" / "docker.sock"
DOCKER_HOST = f"unix://{EXPECTED_SOCKET}"
LOG_PATH = RUNS / "terminalbench_disk_monitor.jsonl"
LOCK_PATH = RUNS / ".terminalbench_disk_monitor.lock"
PRIVATE_NAME = re.compile(r"^private_task__[a-zA-Z0-9]+__env-main-\d+$")
BENCHMARK_REPOSITORY = re.compile(r"^alexgshaw/[a-zA-Z0-9_.-]+$")


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DOCKER_HOST"] = DOCKER_HOST
    return subprocess.run(command, check=check, capture_output=True, text=True, env=env)


def disk_usage_percent() -> int:
    result = run(
        ["colima", "ssh", "--profile", "terminalbench", "--", "df", "-Pk", "/var/lib/docker"]
    )
    lines = [line.split() for line in result.stdout.splitlines() if line.strip()]
    if len(lines) < 2 or lines[-1][-1] != "/var/lib/docker":
        raise RuntimeError("terminalbench Docker filesystem could not be verified")
    return int(lines[-1][4].rstrip("%"))


def docker_json_lines(command: list[str]) -> list[dict]:
    result = run(command)
    values = []
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            values.append(value)
    return values


def container_ids() -> list[str]:
    result = run(["docker", "ps", "-aq", "--no-trunc"], check=False)
    if result.returncode == 0:
        return result.stdout.split()
    fallback = subprocess.run(
        [
            "colima", "ssh", "--profile", "terminalbench", "--",
            "sudo", "ls", "-1", "/var/lib/docker/containers",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return [value for value in fallback.stdout.split() if re.fullmatch(r"[0-9a-f]{64}", value)]


def removable_containers() -> list[str]:
    removable = []
    for container_id in container_ids():
        result = run(["docker", "inspect", container_id], check=False)
        if result.returncode != 0:
            continue
        details = json.loads(result.stdout)[0]
        name = str(details.get("Name", "")).lstrip("/")
        if not PRIVATE_NAME.fullmatch(name):
            continue
        if details.get("State", {}).get("Running") is not False:
            continue
        labels = details.get("Config", {}).get("Labels", {}) or {}
        project = str(labels.get("com.docker.compose.project", ""))
        working_dir = str(labels.get("com.docker.compose.project.working_dir", ""))
        try:
            owned = Path(working_dir).resolve().is_relative_to(RUNS)
        except (OSError, ValueError):
            owned = False
        if project.startswith("private_task__") and owned:
            removable.append(name)
    return removable


def referenced_image_ids() -> set[str]:
    referenced = set()
    for container_id in container_ids():
        result = run(
            ["docker", "inspect", "--format", "{{.Image}}", container_id], check=False
        )
        if result.returncode == 0 and result.stdout.strip():
            referenced.add(result.stdout.strip())
    return referenced


def removable_images() -> list[tuple[int, str, str]]:
    referenced = referenced_image_ids()
    candidates: dict[str, tuple[int, str, str]] = {}
    for image in docker_json_lines(["docker", "image", "ls", "--no-trunc", "--format", "{{json .}}"]):
        repository = str(image.get("Repository", ""))
        image_id = str(image.get("ID", ""))
        if not BENCHMARK_REPOSITORY.fullmatch(repository) or image_id in referenced:
            continue
        details = json.loads(run(["docker", "image", "inspect", image_id]).stdout)[0]
        candidates[image_id] = (int(details.get("Size", 0)), image_id, repository)
    return sorted(candidates.values(), reverse=True)


def audit(event: dict) -> None:
    RUNS.mkdir(parents=True, exist_ok=True)
    payload = {"timestamp": datetime.now(timezone.utc).isoformat(), **event}
    with LOG_PATH.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, sort_keys=True) + "\n")


def reclaim(*, apply: bool, high_water: int, target: int) -> dict:
    if DOCKER_HOST != f"unix://{Path.home() / '.colima' / 'terminalbench' / 'docker.sock'}":
        raise RuntimeError("refusing to use a non-TerminalBench Docker socket")
    if not EXPECTED_SOCKET.exists():
        raise RuntimeError(f"dedicated Docker socket is missing: {EXPECTED_SOCKET}")
    run(["docker", "info"])
    before = disk_usage_percent()
    summary = {
        "mode": "apply" if apply else "dry-run",
        "disk_before_percent": before,
        "disk_after_percent": before,
        "containers_removed": [],
        "images_removed": [],
    }
    if before < high_water:
        audit({"event": "below_threshold", **summary})
        return summary

    containers = removable_containers()
    images = removable_images()
    if not apply:
        summary["candidate_containers"] = containers
        summary["candidate_images"] = [repository for _, _, repository in images]
        audit({"event": "dry_run", **summary})
        return summary

    for name in containers:
        result = run(["docker", "rm", name], check=False)
        if result.returncode == 0:
            summary["containers_removed"].append(name)

    for _, image_id, repository in removable_images():
        if disk_usage_percent() <= target:
            break
        result = run(["docker", "image", "rm", image_id], check=False)
        if result.returncode == 0:
            summary["images_removed"].append(repository)

    summary["disk_after_percent"] = disk_usage_percent()
    audit({"event": "reclaim", **summary})
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="perform safe Docker-only reclamation")
    parser.add_argument("--watch", action="store_true", help="repeat until stopped")
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--high-water", type=int, default=85)
    parser.add_argument("--target", type=int, default=70)
    args = parser.parse_args()
    if not 0 < args.target < args.high_water <= 100:
        parser.error("require 0 < target < high-water <= 100")
    if args.interval < 10:
        parser.error("interval must be at least 10 seconds")

    RUNS.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a+", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("TerminalBench disk monitor is already running")
            return 0
        while True:
            try:
                print(json.dumps(reclaim(apply=args.apply, high_water=args.high_water, target=args.target)))
            except Exception as exc:
                audit({"event": "error", "error": str(exc)})
                print(f"TerminalBench disk monitor error: {exc}", flush=True)
            if not args.watch:
                return 0
            time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
