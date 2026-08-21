#!/usr/bin/env python3
"""Extract one pinned GameDevBench task zip for local smoke runs."""

from __future__ import annotations

import argparse
import shutil
import zipfile
from pathlib import Path


def available_task_names(gdbench_root: Path, *, task_collection: str = "tasks") -> tuple[str, ...]:
    return tuple(
        path.stem
        for path in sorted(gdbench_root.resolve().glob(f"{task_collection}/task_*.zip"))
    )


def prepare(
    *,
    gdbench_root: Path,
    task_collection: str,
    task_name: str | None,
    output_dir: Path,
) -> Path:
    gdbench_root = gdbench_root.resolve()
    output_dir = output_dir.resolve()
    if task_name is None:
        task_name = next(iter(available_task_names(gdbench_root, task_collection=task_collection)), None)
    if task_name is None:
        raise FileNotFoundError(
            f"no GameDevBench task archives found: {gdbench_root / task_collection}"
        )
    archive = gdbench_root / task_collection / f"{task_name}.zip"
    if not archive.is_file():
        raise FileNotFoundError(f"missing gdbench task archive: {archive}")
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)
    with zipfile.ZipFile(archive) as handle:
        handle.extractall(output_dir)
    candidates = sorted(output_dir.rglob(task_name))
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "project.godot").is_file():
            return candidate
    direct = output_dir / "tasks" / task_name
    if direct.is_dir():
        return direct
    raise FileNotFoundError(f"could not locate extracted gdbench task {task_name}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gdbench-root", type=Path, required=True)
    parser.add_argument("--task-collection", default="tasks")
    parser.add_argument("--task-name", default=None)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    task_dir = prepare(
        gdbench_root=args.gdbench_root,
        task_collection=args.task_collection,
        task_name=args.task_name,
        output_dir=args.output_dir,
    )
    print(task_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
