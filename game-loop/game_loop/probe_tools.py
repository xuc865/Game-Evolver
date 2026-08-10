"""Command-line helpers invoked by frozen L1–L4 probe specs.

Each subcommand prints a JSON object to stdout with at least ``passed`` and
optional ``score`` / ``diagnostics`` fields for ``json_stdout`` parsers.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def resolve_godot_executable(explicit: str | None = None) -> str | None:
    """Return an executable Godot binary path for local probes and agents."""
    if explicit:
        path = Path(explicit).expanduser()
        if path.is_file():
            return str(path.resolve())
    for env_name in ("GODOT_EXEC_PATH", "GODOT_BIN"):
        env = os.environ.get(env_name, "").strip()
        if env and Path(env).expanduser().is_file():
            return str(Path(env).expanduser().resolve())
    install_root = Path(__file__).resolve().parents[1] / ".tools" / "godot"
    if install_root.is_dir():
        for candidate in sorted(install_root.glob("Godot_v*-stable*")):
            if candidate.is_file():
                return str(candidate.resolve())
    for candidate in (
        "/Applications/Godot.app/Contents/MacOS/Godot",
        "/usr/local/bin/godot",
        "/usr/bin/godot",
    ):
        if Path(candidate).is_file():
            return candidate
    return shutil.which("godot")


def _resolve_godot_bin(explicit: str | None) -> str | None:
    return resolve_godot_executable(explicit)


def _godot_runtime_env() -> dict[str, str]:
    """Isolate Godot from the host user config directory during probes."""
    env = os.environ.copy()
    probe_home = env.get("GAME_LOOP_GODOT_HOME")
    if not probe_home:
        probe_home = str(Path.home() / ".cache" / "game-loop-godot-probe")
    probe_root = Path(probe_home).expanduser()
    config_home = probe_root / "config"
    cache_home = probe_root / "cache"
    data_home = probe_root / "data"
    home = probe_root / "home"
    for path in (home, config_home, cache_home, data_home):
        path.mkdir(parents=True, exist_ok=True)
    env.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "XDG_CONFIG_HOME": str(config_home),
            "XDG_CACHE_HOME": str(cache_home),
            "XDG_DATA_HOME": str(data_home),
        }
    )
    return env


def _artifact_root(path: Path) -> Path:
    root = path.expanduser().resolve()
    if not root.is_dir():
        return root
    if (root / "project.godot").is_file():
        return root
    for child in sorted(root.iterdir()):
        if child.is_dir() and (child / "project.godot").is_file():
            return child
    return root


def cmd_godot_import(args: argparse.Namespace) -> int:
    artifact = _artifact_root(Path(args.artifact))
    project = artifact / "project.godot"
    if not project.is_file():
        _emit({"passed": False, "score": 0.0, "diagnostics": ["project.godot missing"]})
        return 1
    godot = _resolve_godot_bin(args.godot_bin)
    if godot is None:
        _emit({"passed": False, "score": 0.0, "diagnostics": ["godot binary not found"]})
        return 1
    proc = subprocess.run(
        [godot, "--headless", "--path", str(artifact), "--import", "--quit"],
        env=_godot_runtime_env(),
        capture_output=True,
        text=True,
        timeout=args.timeout,
        check=False,
    )
    passed = proc.returncode == 0
    diagnostics = []
    if proc.stdout.strip():
        diagnostics.append(proc.stdout.strip()[-500:])
    if proc.stderr.strip():
        diagnostics.append(proc.stderr.strip()[-500:])
    _emit({"passed": passed, "score": 1.0 if passed else 0.0, "diagnostics": diagnostics})
    return 0 if passed else 1


def cmd_godot_playtest(args: argparse.Namespace) -> int:
    artifact = _artifact_root(Path(args.artifact))
    project = artifact / "project.godot"
    if not project.is_file():
        _emit({"passed": False, "score": 0.0, "diagnostics": ["project.godot missing"]})
        return 1
    godot = _resolve_godot_bin(args.godot_bin)
    if godot is None:
        _emit({"passed": False, "score": 0.0, "diagnostics": ["godot binary not found"]})
        return 1
    proc = subprocess.run(
        [
            godot,
            "--headless",
            "--path",
            str(artifact),
            "--quit-after",
            str(args.frames),
        ],
        env=_godot_runtime_env(),
        capture_output=True,
        text=True,
        timeout=args.timeout,
        check=False,
    )
    passed = proc.returncode == 0
    _emit(
        {
            "passed": passed,
            "score": 1.0 if passed else 0.0,
            "diagnostics": [f"frames={args.frames}", f"return_code={proc.returncode}"],
        }
    )
    return 0 if passed else 1


def cmd_gcbench_demo_evidence(args: argparse.Namespace) -> int:
    artifact = _artifact_root(Path(args.artifact))
    demo_dir = artifact / "demo_outputs"
    demos = sorted(demo_dir.glob("*.json")) if demo_dir.is_dir() else []
    demos = demos[: args.max_demos]
    passed = bool(demos)
    _emit(
        {
            "passed": passed,
            "score": min(1.0, len(demos) / max(args.max_demos, 1)),
            "diagnostics": [str(item.name) for item in demos[:5]],
        }
    )
    return 0 if passed else 1


def cmd_godot_quality_inventory(args: argparse.Namespace) -> int:
    artifact = _artifact_root(Path(args.artifact))
    gd_files = list(artifact.rglob("*.gd"))
    tscn_files = list(artifact.rglob("*.tscn"))
    passed = bool(gd_files or tscn_files)
    _emit(
        {
            "passed": passed,
            "score": min(1.0, (len(gd_files) + len(tscn_files)) / 10.0),
            "diagnostics": [
                f"gd_scripts={len(gd_files)}",
                f"scenes={len(tscn_files)}",
            ],
        }
    )
    return 0 if passed else 1


def cmd_verigame_build(args: argparse.Namespace) -> int:
    artifact = Path(args.artifact).expanduser().resolve()
    package = artifact / "package.json"
    if not package.is_file():
        _emit({"passed": False, "score": 0.0, "diagnostics": ["package.json missing"]})
        return 1
    npm = shutil.which("npm")
    if npm is None:
        _emit({"passed": False, "score": 0.0, "diagnostics": ["npm not found"]})
        return 1
    proc = subprocess.run(
        [npm, "run", "build"],
        cwd=artifact,
        capture_output=True,
        text=True,
        timeout=args.timeout,
        check=False,
    )
    passed = proc.returncode == 0
    _emit({"passed": passed, "score": 1.0 if passed else 0.0, "diagnostics": [proc.stderr[-500:]]})
    return 0 if passed else 1


def cmd_verigame_screenshot(args: argparse.Namespace) -> int:
    artifact = Path(args.artifact).expanduser().resolve()
    dist = artifact / "dist"
    index = dist / "index.html"
    passed = index.is_file()
    _emit(
        {
            "passed": passed,
            "score": 1.0 if passed else 0.0,
            "diagnostics": [f"wait_ms={args.wait_ms}", f"index_exists={passed}"],
        }
    )
    return 0 if passed else 1


def cmd_pygame_runtime(args: argparse.Namespace) -> int:
    artifact = Path(args.artifact).expanduser().resolve()
    candidates = [
        artifact / "main.py",
        artifact / "game.py",
        artifact / "run.py",
    ]
    entry = next((path for path in candidates if path.is_file()), None)
    if entry is None:
        py_files = list(artifact.rglob("*.py"))
        entry = py_files[0] if py_files else None
    if entry is None:
        _emit({"passed": False, "score": 0.0, "diagnostics": ["no python entrypoint"]})
        return 1
    proc = subprocess.run(
        [sys.executable, str(entry)],
        cwd=entry.parent,
        capture_output=True,
        text=True,
        timeout=args.run_seconds,
        check=False,
    )
    passed = proc.returncode == 0
    _emit(
        {
            "passed": passed,
            "score": 1.0 if passed else 0.0,
            "diagnostics": [f"entry={entry.name}", f"run_seconds={args.run_seconds}"],
        }
    )
    return 0 if passed else 1


def cmd_gdbench_validation(args: argparse.Namespace) -> int:
    artifact = _artifact_root(Path(args.artifact))
    project = artifact / "project.godot"
    scripts = list((artifact / "scripts").glob("*.gd")) if (artifact / "scripts").is_dir() else []
    passed = project.is_file() and bool(scripts)
    _emit(
        {
            "passed": passed,
            "score": 1.0 if passed else 0.0,
            "diagnostics": [
                f"project.godot={project.is_file()}",
                f"script_count={len(scripts)}",
                f"task_source={args.task_source}",
            ],
        }
    )
    return 0 if passed else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="game_loop.probe_tools")
    sub = parser.add_subparsers(dest="command", required=True)

    godot_import = sub.add_parser("godot-import")
    godot_import.add_argument("--artifact", required=True)
    godot_import.add_argument("--godot-bin", default=None)
    godot_import.add_argument("--timeout", type=int, default=180)
    godot_import.set_defaults(func=cmd_godot_import)

    godot_playtest = sub.add_parser("godot-playtest")
    godot_playtest.add_argument("--artifact", required=True)
    godot_playtest.add_argument("--godot-bin", default=None)
    godot_playtest.add_argument("--frames", type=int, default=600)
    godot_playtest.add_argument("--timeout", type=int, default=1800)
    godot_playtest.set_defaults(func=cmd_godot_playtest)

    demo = sub.add_parser("gcbench-demo-evidence")
    demo.add_argument("--artifact", required=True)
    demo.add_argument("--max-demos", type=int, default=10)
    demo.add_argument("--max-frames", type=int, default=600)
    demo.set_defaults(func=cmd_gcbench_demo_evidence)

    inventory = sub.add_parser("godot-quality-inventory")
    inventory.add_argument("--artifact", required=True)
    inventory.set_defaults(func=cmd_godot_quality_inventory)

    verigame_build = sub.add_parser("verigame-build")
    verigame_build.add_argument("--artifact", required=True)
    verigame_build.add_argument("--timeout", type=int, default=600)
    verigame_build.set_defaults(func=cmd_verigame_build)

    verigame_shot = sub.add_parser("verigame-screenshot")
    verigame_shot.add_argument("--artifact", required=True)
    verigame_shot.add_argument("--wait-ms", type=int, default=1000)
    verigame_shot.set_defaults(func=cmd_verigame_screenshot)

    pygame = sub.add_parser("pygame-runtime")
    pygame.add_argument("--artifact", required=True)
    pygame.add_argument("--run-seconds", type=int, default=8)
    pygame.set_defaults(func=cmd_pygame_runtime)

    gdbench = sub.add_parser("gdbench-validation")
    gdbench.add_argument("--artifact", required=True)
    gdbench.add_argument("--task-source", required=True)
    gdbench.add_argument("--godot-bin", default=None)
    gdbench.set_defaults(func=cmd_gdbench_validation)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
