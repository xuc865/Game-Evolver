"""Command-line helpers invoked by frozen L1–L4 probe specs.

Each subcommand prints a JSON object to stdout with at least ``passed`` and
optional ``score`` / ``diagnostics`` fields for ``json_stdout`` parsers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
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


def _load_demo_trace(artifact: Path, *, max_frames: int) -> tuple[Path, dict] | None:
    demo_dir = artifact / "demo_outputs"
    traces = sorted(demo_dir.glob("*.json")) if demo_dir.is_dir() else []
    traces.sort(key=lambda path: (path.name == "_example_trace.json", path.name))
    for path in traces:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        events = value.get("events") if isinstance(value, dict) else None
        if not isinstance(events, list) or not events:
            continue
        duration = int(value.get("duration_frames", 0))
        if not 1 <= duration <= max_frames:
            continue
        if not any(
            isinstance(event, dict)
            and str(event.get("type", ""))
            in {
                "mouse_click",
                "mouse_down",
                "mouse_up",
                "mouse_move",
                "key_press",
                "key_down",
                "key_up",
            }
            for event in events
        ):
            continue
        return path, value
    return None


def _sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cmd_godot_interaction_replay(args: argparse.Namespace) -> int:
    artifact = _artifact_root(Path(args.artifact))
    if not (artifact / "project.godot").is_file():
        _emit({"passed": False, "score": 0.0, "diagnostics": ["project.godot missing"]})
        return 1
    selected = _load_demo_trace(artifact, max_frames=args.max_frames)
    if selected is None:
        _emit({
            "passed": False,
            "score": 0.0,
            "diagnostics": ["no valid actionable demo trace"],
        })
        return 1
    godot = _resolve_godot_bin(args.godot_bin)
    if godot is None:
        _emit({"passed": False, "score": 0.0, "diagnostics": ["godot binary not found"]})
        return 1
    trace_path, trace = selected
    duration = int(trace["duration_frames"])
    actionable = sum(
        1
        for event in trace["events"]
        if isinstance(event, dict) and str(event.get("type", "")) != "wait"
    )
    with tempfile.TemporaryDirectory(prefix="game-loop-godot-replay-") as td:
        workspace = Path(td) / "game"
        shutil.copytree(
            artifact,
            workspace,
            symlinks=True,
            ignore=shutil.ignore_patterns(
                ".godot", ".circuit_home", ".circuit_sessions", "handoffs"
            ),
        )
        relative_trace = trace_path.relative_to(artifact).as_posix()
        script = workspace / "__game_loop_interaction_probe.gd"
        script.write_text(
            """extends SceneTree

const TRACE_PATH := %s
const END_FRAME := %d
var frame := 0
var trace: Dictionary

func _initialize() -> void:
    trace = JSON.parse_string(FileAccess.get_file_as_string(TRACE_PATH))
    var scene_path := str(ProjectSettings.get_setting("application/run/main_scene", ""))
    var packed := load(scene_path) as PackedScene
    if packed == null:
        push_error("GAME_LOOP_REPLAY_MAIN_SCENE_MISSING")
        quit(2)
        return
    root.add_child(packed.instantiate())
    process_frame.connect(_on_frame)

func _on_frame() -> void:
    frame += 1
    if frame == 3:
        _save_state("before.state")
    for raw in trace.get("events", []):
        if raw is Dictionary and int(raw.get("frame", -1)) == frame:
            _dispatch(raw)
    if frame >= END_FRAME:
        _save_state("after.state")
        print("GAME_LOOP_REPLAY_COMPLETED frame=%%d events=%%d" %% [frame, trace.get("events", []).size()])
        quit()

func _dispatch(event: Dictionary) -> void:
    var kind := str(event.get("type", ""))
    if kind.begins_with("mouse_"):
        var mouse := InputEventMouseButton.new()
        mouse.button_index = MOUSE_BUTTON_RIGHT if str(event.get("button", "left")) == "right" else MOUSE_BUTTON_LEFT
        mouse.position = Vector2(float(event.get("x", 0)), float(event.get("y", 0)))
        mouse.pressed = kind != "mouse_up"
        root.push_input(mouse)
        if kind == "mouse_click":
            mouse.pressed = false
            root.push_input(mouse)
    elif kind.begins_with("key_"):
        var key := InputEventKey.new()
        key.keycode = OS.find_keycode_from_string(str(event.get("key", event.get("keycode", ""))))
        key.pressed = kind != "key_up"
        root.push_input(key)
        if kind == "key_press":
            key.pressed = false
            root.push_input(key)

func _save_state(name: String) -> void:
    var rows: Array[String] = []
    _snapshot_node(root, rows)
    var file := FileAccess.open("res://" + name, FileAccess.WRITE)
    file.store_string("\n".join(rows))

func _snapshot_node(node: Node, rows: Array[String]) -> void:
    var row := str(node.get_path()) + "|" + node.get_class()
    if node is CanvasItem:
        row += "|visible=" + str(node.visible)
    if node is Label:
        row += "|text=" + node.text
    if node is Control:
        row += "|position=" + str(node.position) + "|size=" + str(node.size)
    rows.append(row)
    for child in node.get_children():
        _snapshot_node(child, rows)
""" % (json.dumps("res://" + relative_trace), duration),
            encoding="utf-8",
        )
        try:
            proc = subprocess.run(
                [
                    godot,
                    "--headless",
                    "--path",
                    str(workspace),
                    "--script",
                    str(script),
                ],
                env=_godot_runtime_env(),
                capture_output=True,
                text=True,
                timeout=args.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            _emit({
                "passed": False,
                "score": 0.0,
                "trace": trace_path.name,
                "actionable_events": actionable,
                "diagnostics": ["interaction replay timed out"],
            })
            return 1
        before_hash = _sha256_file(workspace / "before.png")
        after_hash = _sha256_file(workspace / "after.png")
        before_state_hash = _sha256_file(workspace / "before.state")
        after_state_hash = _sha256_file(workspace / "after.state")
        completed = "GAME_LOOP_REPLAY_COMPLETED" in proc.stdout
        passed = (
            proc.returncode == 0
            and completed
            and bool(before_state_hash and after_state_hash)
        )
        visual_changed = bool(
            before_hash and after_hash and before_hash != after_hash
        )
        observable_changed = bool(
            before_state_hash
            and after_state_hash
            and before_state_hash != after_state_hash
        )
        _emit({
            "passed": passed,
            "score": (
                1.0
                if passed and (visual_changed or observable_changed)
                else (0.5 if passed else 0.0)
            ),
            "trace": trace_path.name,
            "duration_frames": duration,
            "actionable_events": actionable,
            "completed": completed,
            "visual_state_changed_after_input": visual_changed,
            "observable_scene_state_changed_after_input": observable_changed,
            "before_frame_sha256": before_hash,
            "after_frame_sha256": after_hash,
            "before_scene_state_sha256": before_state_hash,
            "after_scene_state_sha256": after_state_hash,
            "diagnostics": [
                f"return_code={proc.returncode}",
                *[
                    line.strip()
                    for line in (proc.stdout + proc.stderr).splitlines()
                    if line.strip()
                ][-8:],
            ],
        })
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
    import shutil
    import tempfile

    from game_loop.benchmarks.gdbench_bridge import (
        _default_godot_path,
        _godot_backend_error,
        _copy_hidden_validation,
    )

    artifact = _artifact_root(Path(args.artifact))
    task_source = Path(args.task_source).resolve()
    godot = args.godot_bin or _default_godot_path(task_source)
    backend_error = _godot_backend_error(godot)
    if backend_error:
        _emit({"passed": None, "score": None, "infrastructure_error": True,
               "diagnostics": [backend_error]})
        return 2
    with tempfile.TemporaryDirectory(prefix="gdbench-probe-") as td:
        task = Path(td) / task_source.name
        shutil.copytree(artifact, task)
        _copy_hidden_validation(task_source, task)
        try:
            imported = subprocess.run(
                [godot, "--headless", "--import", "--quit", "--path", str(task)],
                capture_output=True, text=True, timeout=args.timeout, check=False,
            )
            validated = subprocess.run(
                [godot, "--headless", "--path", str(task), "res://scenes/test.tscn"],
                capture_output=True, text=True, timeout=args.timeout, check=False,
            )
        except subprocess.TimeoutExpired:
            _emit({"passed": None, "score": None, "infrastructure_error": True,
                   "diagnostics": ["Official validator timed out"]})
            return 2
    output = validated.stdout + validated.stderr
    passed = "VALIDATION_PASSED" in output
    failed = "VALIDATION_FAILED" in output
    if not passed and not failed:
        detail = (output or imported.stdout + imported.stderr).strip()[-2000:]
        _emit({"passed": None, "score": None, "infrastructure_error": True,
               "diagnostics": ["Official validator emitted no result marker", detail]})
        return 2
    marker = next(
        (line.strip() for line in output.splitlines()
         if "VALIDATION_PASSED" in line or "VALIDATION_FAILED" in line),
        "official validation completed",
    )
    _emit({"passed": passed, "score": 1.0 if passed else 0.0,
           "diagnostics": [marker]})
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

    interaction = sub.add_parser("godot-interaction-replay")
    interaction.add_argument("--artifact", required=True)
    interaction.add_argument("--godot-bin", default=None)
    interaction.add_argument("--max-frames", type=int, default=600)
    interaction.add_argument("--timeout", type=int, default=120)
    interaction.set_defaults(func=cmd_godot_interaction_replay)

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
    gdbench.add_argument("--timeout", type=int, default=600)
    gdbench.set_defaults(func=cmd_gdbench_validation)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
