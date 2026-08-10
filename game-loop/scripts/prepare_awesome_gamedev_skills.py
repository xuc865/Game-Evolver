#!/usr/bin/env python3
"""Generate and verify the pinned awesome-gamedev-agent-skills baseline metadata."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.baselines.awesome_gamedev_skills import (
    AWESOME_GAMEDEV_SKILLS_SOURCE_URL,
    build_skills_index,
    inspect_skills_source,
)
from game_loop.utils import atomic_write_json


DEFAULT_SOURCE = ROOT / "third_party" / "awesome-gamedev-agent-skills"
DEFAULT_LOCK = ROOT / "experiments" / "baselines" / "awesome-gamedev-agent-skills.lock.json"
DEFAULT_INDEX = ROOT / "experiments" / "baselines" / "awesome-gamedev-agent-skills-index.md"


def _revision(source: Path) -> str:
    completed = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"source is not a git checkout: {source}")
    return completed.stdout.strip()


def build_lock(source: Path) -> dict[str, object]:
    return {
        "schema_version": "awesome-gamedev-agent-skills-lock-v1",
        "source_url": AWESOME_GAMEDEV_SKILLS_SOURCE_URL,
        "revision": _revision(source),
        "skill_count": len(inspect_skills_source(source)),
        "skills": inspect_skills_source(source),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args(argv)

    source = args.source.expanduser().resolve()
    lock = build_lock(source)
    if args.verify:
        expected = json.loads(args.lock.read_text(encoding="utf-8"))
        if expected != lock:
            raise SystemExit("awesome-gamedev-agent-skills lock does not match checkout")
        print(f"verified {lock['skill_count']} skills at {lock['revision']}")
        return 0

    atomic_write_json(args.lock, lock)
    args.index.parent.mkdir(parents=True, exist_ok=True)
    args.index.write_text(build_skills_index(source), encoding="utf-8")
    print(f"wrote lock={args.lock} index={args.index} skills={lock['skill_count']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
