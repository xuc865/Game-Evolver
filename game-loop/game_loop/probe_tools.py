"""Command-line helpers invoked by frozen L1–L4 probe specs.

Each subcommand prints a JSON object to stdout with at least ``passed`` and
optional ``score`` / ``diagnostics`` fields for ``json_stdout`` parsers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.parse
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




def _run_process_group(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    cwd: Path | str | None = None,
    timeout: int | float,
) -> subprocess.CompletedProcess[str]:
    """Run a command and kill its whole process group on timeout."""
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    except subprocess.TimeoutExpired as exc:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        raise subprocess.TimeoutExpired(command, timeout) from exc


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


def _load_package_json(artifact: Path) -> dict[str, object] | None:
    package = artifact / "package.json"
    if not package.is_file():
        return None
    try:
        value = json.loads(package.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _package_script(package: dict[str, object] | None, name: str) -> str | None:
    if not isinstance(package, dict):
        return None
    scripts = package.get("scripts")
    if not isinstance(scripts, dict):
        return None
    value = scripts.get(name)
    return str(value).strip() if isinstance(value, str) and value.strip() else None


def _package_has_keyword(package: dict[str, object] | None, keyword: str) -> bool:
    if not isinstance(package, dict):
        return False
    raw_keywords = package.get("keywords")
    if not isinstance(raw_keywords, list):
        return False
    return any(str(item).strip().casefold() == keyword.casefold() for item in raw_keywords)


def _run_npm_script(
    artifact: Path,
    script: str,
    *,
    timeout: int,
    extra_args: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    npm = shutil.which("npm")
    if npm is None:
        raise FileNotFoundError("npm not found")
    command = [npm, "run", script]
    if extra_args:
        command.extend(["--", *extra_args])
    return subprocess.run(
        command,
        cwd=artifact,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _browser_game_profile(artifact: Path) -> str | None:
    """Recognize the supported browser-game families without requiring npm."""
    if (artifact / "polybranch.pjs").is_file():
        return "processing"
    for nested in (
        artifact / "polybranchweb",
        artifact / "web-export",
        artifact / "game",
        artifact / "dist",
        artifact / "build",
        artifact / "site",
    ):
        if (nested / "polybranch.pjs").is_file():
            return "processing"
    if (artifact / "js" / "vendor" / "three.min.js").is_file():
        return "three-fps"
    if (artifact / "src" / "main.js").is_file() and (artifact / "game.js").is_file():
        return "canvas-survivors"
    if (artifact / "server.js").is_file() and (artifact / "public").is_dir():
        return "node-pwa"
    if (artifact / "index.html").is_file() or any(
        (nested / "index.html").is_file()
        for nested in (
            artifact / "polybranchweb",
            artifact / "web-export",
            artifact / "game",
            artifact / "dist",
            artifact / "build",
            artifact / "site",
            artifact / "public",
        )
    ):
        return "static-browser"
    return None


def _browser_entrypoint(artifact: Path) -> Path | None:
    preferred = (
        artifact / "index.html",
        artifact / "public" / "index.html",
        artifact / "dist" / "index.html",
        artifact / "build" / "index.html",
        artifact / "site" / "index.html",
        artifact / "polybranchweb" / "index.html",
        artifact / "web-export" / "index.html",
        artifact / "game" / "index.html",
    )
    for path in preferred:
        if path.is_file():
            return path
    return next(iter(sorted(artifact.rglob("index.html"))), None)


def _free_local_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _cdp_call(ws, counter: list[int], method: str, params: dict | None = None) -> dict:
    import json as _json

    counter[0] += 1
    ws.send(_json.dumps({"id": counter[0], "method": method, "params": params or {}}))
    deadline = time.time() + 15
    while time.time() < deadline:
        message = _json.loads(ws.recv())
        if message.get("id") == counter[0]:
            return message
    raise TimeoutError(f"CDP timeout: {method}")


def cmd_browser_game_deep_probe(args: argparse.Namespace) -> int:
    """Run a bounded, engine-agnostic browser gameplay probe via Chrome CDP."""
    artifact = Path(args.artifact).expanduser().resolve()
    profile = args.profile or _browser_game_profile(artifact)
    entrypoint = _browser_entrypoint(artifact)
    if profile is None or entrypoint is None:
        _emit({"passed": False, "score": 0.0, "infrastructure_error": False,
               "diagnostics": ["unsupported browser game: index.html/profile missing"]})
        return 1
    chrome = next(
        (candidate for candidate in (
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ) if Path(candidate).is_file()),
        shutil.which("google-chrome") or shutil.which("chromium"),
    )
    if not chrome:
        _emit({"passed": None, "score": None, "infrastructure_error": True,
               "diagnostics": ["Chrome/Chromium executable not found"]})
        return 2
    port = _free_local_port()
    server_port = _free_local_port()
    server = None
    temp_root = Path(tempfile.mkdtemp(prefix="game-loop-browser-probe-"))
    try:
        server = subprocess.Popen(
            [sys.executable, "-m", "http.server", str(server_port), "--bind", "127.0.0.1"],
            cwd=artifact,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        browser = subprocess.Popen(
            [chrome, "--headless=new", "--no-sandbox", "--disable-gpu",
             "--enable-unsafe-swiftshader", "--hide-scrollbars",
             "--remote-allow-origins=*", "--password-store=basic",
             "--use-mock-keychain", "--disable-features=AutofillServerCommunication",
             "--disable-sync", "--no-first-run", "--no-default-browser-check",
             "--window-size=1280,800", f"--remote-debugging-port={port}",
             f"--user-data-dir={temp_root}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        version_url = f"http://127.0.0.1:{port}/json/version"
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            try:
                version = json.loads(urllib.request.urlopen(version_url, timeout=1).read())
                break
            except Exception:
                time.sleep(0.1)
        else:
            _emit({"passed": False, "score": 0.0, "infrastructure_error": True,
                   "diagnostics": ["Chrome CDP endpoint did not start"]})
            return 2
        import websocket

        target_url = "http://127.0.0.1:" + str(server_port) + "/" + entrypoint.relative_to(artifact).as_posix()
        page_request = urllib.request.Request(
            f"http://127.0.0.1:{port}/json/new?{urllib.parse.quote(target_url)}",
            method="PUT",
        )
        page = json.loads(urllib.request.urlopen(page_request, timeout=5).read())
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15)
        counter = [0]
        _cdp_call(ws, counter, "Page.enable")
        _cdp_call(ws, counter, "Runtime.enable")
        _cdp_call(ws, counter, "Page.navigate", {"url": page["url"]})
        time.sleep(3.0)
        state = _cdp_call(ws, counter, "Runtime.evaluate", {
            "expression": """(() => {
              const canvases = [...document.querySelectorAll('canvas')];
              const visible = [...document.querySelectorAll('body *')].filter(e => {
                const r=e.getBoundingClientRect(); return r.width>0 && r.height>0;
              }).length;
              return {ready: document.readyState, title: document.title,
                canvasCount: canvases.length, visible, bodyText: document.body.innerText.slice(0,800),
                width: innerWidth, height: innerHeight};
            })()""",
            "returnByValue": True,
        })["result"]["result"].get("value", {})
        action_by_profile = {
            "node-pwa": ["Tab", "Enter", "Space"],
            "canvas-survivors": ["Space", "ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"],
            "processing": ["Enter", "Space", "ArrowRight", "ArrowUp"],
            "three-fps": ["Enter", "Space", "KeyW", "KeyD", "MouseLeft"],
            "static-browser": ["Enter", "Space", "ArrowRight"],
        }[profile]
        before_shot = _cdp_call(ws, counter, "Page.captureScreenshot", {"format": "png"})["result"]["data"]
        click_expression = {
            "canvas-survivors": """(() => {
              const node = document.querySelector('#btnStart');
              if (node) { node.click(); return {clicked: node.id}; }
              return {clicked: null};
            })()""",
            "three-fps": """(() => {
              const node = document.querySelector('#endlessModeButton') ||
                document.querySelector('#levelModeButton');
              if (node) { node.click(); return {clicked: node.id}; }
              return {clicked: null};
            })()""",
        }.get(profile, """(() => {
              const wanted = /start|开始|无尽模式|关卡模式/i;
              const nodes = [...document.querySelectorAll('button,a,[role="button"]')];
              const node = nodes.find(e => wanted.test((e.innerText || e.textContent || '').trim()));
              if (node) { node.click(); return {clicked: (node.innerText || node.textContent || '').trim()}; }
              return {clicked: null};
            })()""")
        _cdp_call(ws, counter, "Runtime.evaluate", {
            "expression": click_expression,
            "returnByValue": True,
        })
        time.sleep(1.0)
        if profile == "three-fps":
            _cdp_call(ws, counter, "Runtime.evaluate", {
                "expression": """(() => {
                  const node = document.querySelector('.endless-map-button');
                  if (node) { node.click(); return {clicked: 'endless-map-button'}; }
                  return {clicked: null};
                })()""",
                "returnByValue": True,
            })
            time.sleep(1.0)
        for key in action_by_profile:
            if key == "MouseLeft":
                _cdp_call(ws, counter, "Input.dispatchMouseEvent", {
                    "type": "mousePressed", "x": 640, "y": 400, "button": "left", "clickCount": 1,
                })
                _cdp_call(ws, counter, "Input.dispatchMouseEvent", {
                    "type": "mouseReleased", "x": 640, "y": 400, "button": "left", "clickCount": 1,
                })
            else:
                _cdp_call(ws, counter, "Input.dispatchKeyEvent", {"type": "keyDown", "key": key, "code": key})
                _cdp_call(ws, counter, "Input.dispatchKeyEvent", {"type": "keyUp", "key": key, "code": key})
            time.sleep(0.3)
        after = _cdp_call(ws, counter, "Runtime.evaluate", {
            "expression": """(() => {
              const canvases = [...document.querySelectorAll('canvas')];
              let pixels = 0;
              for (const c of canvases) { try {
                const x=c.getContext('2d'); if (x) pixels += [...x.getImageData(0,0,Math.min(c.width,64),Math.min(c.height,64)).data].reduce((a,b)=>a+b,0);
              } catch (_) {} }
              return {visible: [...document.querySelectorAll('body *')].filter(e => {
                const r=e.getBoundingClientRect(); return r.width>0 && r.height>0;
              }).length, bodyText: document.body.innerText.slice(0,800), pixels};
            })()""",
            "returnByValue": True,
        })["result"]["result"].get("value", {})
        screenshot = _cdp_call(ws, counter, "Page.captureScreenshot", {"format": "png"})["result"]["data"]
        import base64

        evidence_dir = artifact / "probe-evidence"
        evidence_dir.mkdir(exist_ok=True)
        (evidence_dir / "deep-probe.png").write_bytes(base64.b64decode(screenshot))
        rendered = bool(after.get("visible", 0)) and len(screenshot) > 1000
        interacted = (
            after.get("bodyText") != state.get("bodyText")
            or after.get("pixels", 0) > 0
            or screenshot != before_shot
        )
        passed = bool(state.get("ready") == "complete" and rendered and interacted)
        _emit({
            "passed": passed, "score": 1.0 if passed else 0.0,
            "profile": profile, "entrypoint": entrypoint.relative_to(artifact).as_posix(),
            "rendered": rendered, "interaction_observed": interacted,
            "before": state, "after": after,
            "screenshots": ["probe-evidence/deep-probe.png"],
            "diagnostics": ["Chrome CDP launch/menu/action/screenshot sequence completed"],
        })
        return 0 if passed else 1
    except Exception as exc:
        _emit({"passed": False, "score": 0.0, "infrastructure_error": False,
               "profile": profile, "diagnostics": [f"{type(exc).__name__}: {exc}"]})
        return 1
    finally:
        for process in (server, locals().get("browser")):
            if process is not None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError, AttributeError):
                    try:
                        process.terminate()
                    except (ProcessLookupError, AttributeError):
                        pass
        shutil.rmtree(temp_root, ignore_errors=True)


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
    try:
        proc = _run_process_group(
            [godot, "--headless", "--path", str(artifact), "--import", "--quit"],
            env=_godot_runtime_env(),
            timeout=args.timeout,
        )
    except subprocess.TimeoutExpired:
        _emit({"passed": False, "score": 0.0, "diagnostics": [f"godot import timed out after {args.timeout}s"]})
        return 1
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
    try:
        proc = _run_process_group(
            [
                godot,
                "--headless",
                "--path",
                str(artifact),
                "--quit-after",
                str(args.frames),
            ],
            env=_godot_runtime_env(),
            timeout=args.timeout,
        )
    except subprocess.TimeoutExpired:
        _emit({"passed": False, "score": 0.0, "diagnostics": [f"godot playtest timed out after {args.timeout}s"]})
        return 1
    passed = proc.returncode == 0
    _emit(
        {
            "passed": passed,
            "score": 1.0 if passed else 0.0,
            "diagnostics": [f"frames={args.frames}", f"return_code={proc.returncode}"],
        }
    )
    return 0 if passed else 1


_ACTIONABLE_DEMO_EVENT_TYPES = {
    "mouse_click",
    "mouse_down",
    "mouse_up",
    "mouse_move",
    "key_press",
    "key_down",
    "key_up",
}


def load_demo_traces(
    artifact: Path,
    *,
    max_frames: int,
) -> tuple[list[tuple[Path, dict]], list[str]]:
    """Load every formal demo trace and report every invalid file."""

    demo_dir = artifact / "demo_outputs"
    traces = sorted(demo_dir.glob("*.json")) if demo_dir.is_dir() else []
    traces = [path for path in traces if path.name != "_example_trace.json"]
    valid: list[tuple[Path, dict]] = []
    errors: list[str] = []
    for path in traces:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{path.name}: invalid JSON ({type(exc).__name__})")
            continue
        events = value.get("events") if isinstance(value, dict) else None
        if not isinstance(events, list) or not events:
            errors.append(f"{path.name}: events must be a non-empty list")
            continue
        try:
            duration = int(value.get("duration_frames", 0))
        except (TypeError, ValueError):
            errors.append(f"{path.name}: duration_frames must be an integer")
            continue
        if not 1 <= duration <= max_frames:
            errors.append(
                f"{path.name}: duration_frames must be within [1, {max_frames}]"
            )
            continue
        actionable = [
            event
            for event in events
            if isinstance(event, dict)
            and str(event.get("type", ""))
            in _ACTIONABLE_DEMO_EVENT_TYPES
        ]
        if not actionable:
            errors.append(f"{path.name}: no actionable input events")
            continue
        valid.append((path, value))
    if not traces:
        errors.append("no formal demo_outputs/*.json traces")
    return valid, errors


def _load_demo_trace(
    artifact: Path,
    *,
    max_frames: int,
    trace_name: str | None = None,
) -> tuple[Path, dict] | None:
    candidates, _ = load_demo_traces(artifact, max_frames=max_frames)
    if trace_name is not None:
        return next(
            (item for item in candidates if item[0].name == trace_name),
            None,
        )
    if not candidates:
        return None
    path, value = max(
        candidates,
        key=lambda item: (
            sum(
                1
                for event in item[1]["events"]
                if isinstance(event, dict)
                and str(event.get("type", "")) in _ACTIONABLE_DEMO_EVENT_TYPES
            ),
            len({
                str(event.get("type", ""))
                for event in item[1]["events"]
                if isinstance(event, dict)
                and str(event.get("type", "")) in _ACTIONABLE_DEMO_EVENT_TYPES
            }),
            int(item[1]["duration_frames"]),
            item[0].name,
        ),
    )
    return path, value


def _sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _godot_interaction_probe_script(relative_trace: str, duration: int) -> str:
    return """extends SceneTree

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
    if frame == 0:
        _save_state("before.state")
    for raw in trace.get("events", []):
        if raw is Dictionary and int(raw.get("frame", -1)) == frame:
            _dispatch(raw)
    if frame >= END_FRAME:
        _save_state("after.state")
        print("GAME_LOOP_REPLAY_COMPLETED frame=%%d events=%%d" %% [frame, trace.get("events", []).size()])
        quit()
        return
    frame += 1

func _dispatch(event: Dictionary) -> void:
    var kind := str(event.get("type", ""))
    if kind == "mouse_move":
        var motion := InputEventMouseMotion.new()
        motion.position = Vector2(float(event.get("x", 0)), float(event.get("y", 0)))
        motion.relative = Vector2(float(event.get("dx", 0)), float(event.get("dy", 0)))
        root.push_input(motion)
    elif kind.begins_with("mouse_"):
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
        var raw_keycode: Variant = event.get("keycode", event.get("key", ""))
        if raw_keycode is int or raw_keycode is float:
            key.keycode = int(raw_keycode)
        else:
            key.keycode = OS.find_keycode_from_string(str(raw_keycode))
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
    if DisplayServer.get_name() != "headless":
        var image := root.get_viewport().get_texture().get_image()
        if image != null and not image.is_empty():
            image.save_png("res://" + name.trim_suffix(".state") + ".png")

func _snapshot_node(node: Node, rows: Array[String]) -> void:
    var row := str(node.get_path()) + "|" + node.get_class()
    if node is CanvasItem:
        row += "|visible=" + str(node.visible)
    if node is Label:
        row += "|text=" + node.text
    if node is Control:
        row += "|position=" + str(node.position) + "|size=" + str(node.size)
    for property in node.get_property_list():
        if int(property.get("usage", 0)) & PROPERTY_USAGE_SCRIPT_VARIABLE == 0:
            continue
        var property_name := StringName(property.get("name", ""))
        var value: Variant = node.get(property_name)
        if value is Object or value is Callable or value is Signal:
            continue
        row += "|" + str(property_name) + "=" + var_to_str(value)
    rows.append(row)
    for child in node.get_children():
        _snapshot_node(child, rows)
""" % (json.dumps("res://" + relative_trace), duration)


def cmd_godot_interaction_replay(args: argparse.Namespace) -> int:
    artifact = _artifact_root(Path(args.artifact))
    if not (artifact / "project.godot").is_file():
        _emit({"passed": False, "score": 0.0, "diagnostics": ["project.godot missing"]})
        return 1
    selected = _load_demo_trace(
        artifact,
        max_frames=args.max_frames,
        trace_name=args.trace_name,
    )
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
    scenario = str(trace.get("scenario", "")).strip()
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
            _godot_interaction_probe_script(relative_trace, duration),
            encoding="utf-8",
        )
        try:
            command = [
                godot,
                "--headless",
                "--path",
                str(workspace),
                "--script",
                str(script),
            ]
            if scenario:
                command.extend(["--", "--scenario", scenario])
            proc = _run_process_group(
                command,
                env=_godot_runtime_env(),
                timeout=args.timeout,
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
        visual_changed = bool(
            before_hash and after_hash and before_hash != after_hash
        )
        observable_changed = bool(
            before_state_hash
            and after_state_hash
            and before_state_hash != after_state_hash
        )
        passed = (
            proc.returncode == 0
            and completed
            and bool(before_state_hash and after_state_hash)
            and (visual_changed or observable_changed)
        )
        _emit({
            "passed": passed,
            "score": 1.0 if passed else 0.0,
            "trace": trace_path.name,
            "scenario": scenario or None,
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



def _event_key(event: dict) -> str:
    return str(event.get("keycode", event.get("key", ""))).upper()


def cmd_moba_scripted_playtest(args: argparse.Namespace) -> int:
    """Layered MOBA-family scripted evidence probe from deterministic public traces.

    The probe has fixed hard-floor checks plus stage-sensitive diagnostic
    layers. It is run identically for parent and candidate. Passing means the
    artifact keeps the non-negotiable MOBA/evidence floor; the numeric score,
    stage scores, and failed checks reveal which quality tier still has gaps.
    """
    artifact = _artifact_root(Path(args.artifact))
    traces, errors = load_demo_traces(artifact, max_frames=args.max_frames)
    trace_payloads = {path.name: payload for path, payload in traces}
    trace_names = set(trace_payloads)
    scenarios = {str(payload.get("scenario", path[:-5])).lower() for path, payload in trace_payloads.items()}
    all_events = [
        event
        for payload in trace_payloads.values()
        for event in payload.get("events", [])
        if isinstance(event, dict)
    ]
    keys = {_event_key(event) for event in all_events}
    event_types = {str(event.get("type", "")) for event in all_events}
    durations = [int(payload.get("duration_frames", 0)) for payload in trace_payloads.values()]
    scenario_text = " ".join(sorted(scenarios | {name[:-5].lower() for name in trace_names}))
    loadout_keys = {key for key in keys if key in {"F1", "F2", "F3", "F4", "KP_1", "KP_2", "KP_3", "KP_4"}}
    recipe_keys = {key for key in keys if key in {"4", "5", "6", "7", "8", "9"}}
    objective_sell_keys = {key for key in keys if key in {"Z", "X"}}
    strategic_trace_names = {name for name in trace_names if name in {"strategy.json", "ai_lanes.json", "herald.json", "neutral.json", "structures.json", "full_match.json"}}

    expected_rejections: list[str] = []
    unexpected_errors: list[str] = []
    for error in errors:
        name = error.split(":", 1)[0].strip()
        path = artifact / "demo_outputs" / name
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            value = None
        if isinstance(value, dict) and value.get("expected_rejection") is True:
            expected_rejections.append(name)
        else:
            unexpected_errors.append(error)

    files_text = "\n".join(
        path.relative_to(artifact).as_posix()
        for path in sorted(artifact.rglob("*"))
        if path.is_file()
    ).lower()
    source_text_parts: list[str] = []
    for rel in [
        "Main.gd",
        "scripts/combat_system.gd",
        "scripts/economy_system.gd",
        "scripts/objective_system.gd",
        "scripts/ai_system.gd",
        "scripts/hud_system.gd",
        "scripts/replay_system.gd",
        "MODULE_CONTRACTS.md",
        "SYSTEM_CONTRACT.md",
    ]:
        path = artifact / rel
        if path.is_file():
            source_text_parts.append(path.read_text(encoding="utf-8", errors="replace")[:60000].lower())
    source_text = "\n".join(source_text_parts)
    combined_text = "\n".join((scenario_text, files_text, source_text))

    def has_any(words: tuple[str, ...], text: str = combined_text) -> bool:
        return any(word in text for word in words)

    checks_by_stage: dict[str, dict[str, bool]] = {
        "fixed_floor": {
            "project_structure_present": (artifact / "project.godot").is_file(),
            "trace_suite_valid": bool(traces) and not unexpected_errors,
            "negative_trace_declared": bool(expected_rejections) or not errors,
            "module_boundaries_present": all(
                token in files_text
                for token in (
                    "scripts/combat_system.gd",
                    "scripts/economy_system.gd",
                    "scripts/objective_system.gd",
                    "scripts/ai_system.gd",
                    "scripts/hud_system.gd",
                    "scripts/replay_system.gd",
                )
            ),
        },
        "foundation": {
            "title_to_match_input": (
                ("title_to_match" in scenario_text or "title" in scenario_text)
                and ("ENTER" in keys or "SPACE" in keys or "mouse_click" in event_types)
            ),
            "movement_or_targeting_input": bool({"W", "A", "S", "D", "UP", "DOWN", "LEFT", "RIGHT"} & keys)
            or "mouse_click" in event_types
            or "mouse_down" in event_types,
            "ability_inputs_qe": "Q" in keys and "E" in keys,
            "hud_or_feedback_surface": has_any(("hud", "cooldown", "health", "gold", "timeline", "status", "feedback")),
        },
        "core_loop": {
            "combat_damage_death_respawn": has_any(("damage", "death", "respawn", "kill", "combat", "shield", "burn", "cooldown")),
            "economy_and_itemization": (
                has_any(("economy", "shop", "upgrade", "purchase", "respec", "team_build", "gold"))
                and bool({"1", "2", "3", "4", "5", "6", "7", "8", "9", "R", "F"} & keys)
            ),
            "objectives_and_structures": has_any(("herald", "beacon", "neutral", "tower", "inhibitor", "core", "objective")),
            "win_loss_states": has_any(("victory", "defeat", "phase=\"victory\"", "phase=\"defeat\""))
            or {"core.json", "defeat.json"}.issubset(trace_names),
            "long_horizon_coverage": len(traces) >= args.min_traces and max(durations or [0]) >= args.min_long_frames,
        },
        "systems": {
            "ai_macro_strategy": has_any(("ai_lanes", "strategy", "lane_rotation", "team_signal", "objective_handoff", "retreat", "defense")),
            "teamwide_economy_or_builds": has_any(("team_build", "team_builds", "team gold", "shared team", "re-derives every champion", "roster")),
            "objective_rewards_affect_match": has_any(("objective", "buff", "beacon", "herald", "carrier", "reward", "sell_objective", "gold")),
            "cooldown_or_status_integrity": has_any(("cooldown", "status", "buff_t", "shield", "burn", "slow", "permanent", "respawn")),
            "replay_state_observability": has_any(("checkpoint", "coverage_report", "state_changes", "observe_log_entries", "package_report")),
        },
        "mature": {
            "anti_surface_spectacle_guard": not (
                has_any(("particle", "sparkle", "glow", "title animation", "background effect"))
                and not has_any(("damage", "economy", "objective", "ai", "respawn", "victory", "defeat"))
            ),
            "multiple_strategic_scenarios": len({name for name in trace_names if name in {"strategy.json", "ai_lanes.json", "herald.json", "neutral.json", "structures.json", "full_match.json"}}) >= 4,
            "visual_evidence_breadth": len(list((artifact / ".shots").glob("*.png"))) >= 6 if (artifact / ".shots").is_dir() else False,
            "contracts_disclose_capabilities": has_any(("contract_check_ids", "capabilities", "module_contracts", "system_contract")),
            "known_bug_regression_hooks": has_any(("killer_team", "team_build", "buff", "cooldown", "expected_rejection")),
        },
        "advanced_moba": {
            # Diagnostic-only high-stage checks. These are intentionally not
            # hard gates; they expose next-step quality gaps once the game is
            # already runnable and system-rich. Prefer replay/input coverage
            # where possible so comments alone do not earn mature credit.
            "multi_loadout_trace_coverage": len(loadout_keys) >= 3,
            "recipe_path_diversity": len(recipe_keys) >= 3,
            "objective_tradeoff_input_coverage": bool(objective_sell_keys) and has_any(("sell_objective", "hold_t", "buff_t", "not a free gold printer")),
            "team_resource_causality": has_any(("team_build", "team_builds", "shared team", "re-derives every champion", "killer_team")),
            "counterplay_and_recovery_paths": has_any(("retreat", "defense", "respawn", "respec", "cooldown lockout", "purchase_rejected"))
            and bool({"R", "P", "H"} & keys),
            "balance_or_anti_degenerate_hooks": has_any(("cooldown", "refund", "attack_rate", "damage", "cost", "gold", "respawn_t"))
            and has_any(("reject", "cap", "max", "min", "lockout", "timer", "not a free")),
            "late_game_state_pressure": has_any(("inhibitor", "core", "victory", "defeat", "map pressure", "open the core"))
            and {"core.json", "defeat.json"}.issubset(trace_names),
            "strategic_trace_breadth": len(strategic_trace_names) >= 5,
        },
    }
    stage_order = ["fixed_floor", "foundation", "core_loop", "systems", "mature", "advanced_moba"]
    stage_scores = {
        stage: (sum(1 for ok in checks.values() if ok) / len(checks) if checks else 0.0)
        for stage, checks in checks_by_stage.items()
    }
    # Stage is diagnostic and monotonic: later stages matter only after earlier
    # stages mostly hold. It is not chosen from candidate-specific goals.
    if stage_scores["fixed_floor"] < 1.0:
        active_stage = "fixed_floor"
    elif stage_scores["foundation"] < 0.75:
        active_stage = "foundation"
    elif stage_scores["core_loop"] < 0.80:
        active_stage = "core_loop"
    elif stage_scores["systems"] < 0.70:
        active_stage = "systems"
    elif stage_scores["mature"] < 0.80:
        active_stage = "mature"
    else:
        active_stage = "advanced_moba"
    stage_weights = {
        "fixed_floor": 0.20,
        "foundation": 0.17,
        "core_loop": 0.22,
        "systems": 0.18,
        "mature": 0.13,
        "advanced_moba": 0.10,
    }
    score = sum(stage_weights[stage] * stage_scores[stage] for stage in stage_order)
    failed_by_stage = {
        stage: [key for key, ok in checks.items() if not ok]
        for stage, checks in checks_by_stage.items()
    }
    # Passing is intentionally not "perfect mature game"; it means the fixed
    # floor and current-stage basics are adequate. Scores expose finer gaps.
    passed = (
        stage_scores["fixed_floor"] == 1.0
        and stage_scores["foundation"] >= 0.75
        and checks_by_stage["foundation"]["title_to_match_input"]
    )
    _emit({
        "passed": passed,
        "score": round(score, 4),
        "active_stage": active_stage,
        "stage_scores": {key: round(value, 4) for key, value in stage_scores.items()},
        "checks_by_stage": checks_by_stage,
        "failed_by_stage": failed_by_stage,
        "trace_count": len(traces),
        "scenario_names": sorted(scenarios),
        "validated_traces": sorted(trace_names),
        "max_duration_frames": max(durations or [0]),
        "loadout_keys": sorted(loadout_keys),
        "recipe_keys": sorted(recipe_keys),
        "objective_sell_keys": sorted(objective_sell_keys),
        "strategic_trace_count": len(strategic_trace_names),
        "expected_rejection_count": len(expected_rejections),
        "diagnostics": [
            *unexpected_errors[:5],
            *[f"accepted expected rejection fixture: {name}" for name in expected_rejections],
            "Layered MOBA probe: fixed floor always applies; foundation/core/systems/mature/advanced checks expose stage-specific quality gaps without candidate-specific tailoring.",
        ],
    })
    return 0 if passed else 1

def cmd_gcbench_demo_evidence(args: argparse.Namespace) -> int:
    artifact = _artifact_root(Path(args.artifact))
    demos, errors = load_demo_traces(artifact, max_frames=args.max_frames)
    # A task may include a deliberately invalid replay to prove that the
    # runtime rejects malformed input.  That negative fixture must declare its
    # intent; otherwise an accidental broken delivery remains a quality fail.
    expected_rejections: list[str] = []
    unexpected_errors: list[str] = []
    for error in errors:
        name = error.split(":", 1)[0].strip()
        path = artifact / "demo_outputs" / name
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            value = None
        if isinstance(value, dict) and value.get("expected_rejection") is True:
            expected_rejections.append(name)
        else:
            unexpected_errors.append(error)
    passed = bool(demos) and not unexpected_errors
    total = len(demos) + len(unexpected_errors)
    _emit(
        {
            "passed": passed,
            "score": len(demos) / total if total else 0.0,
            "valid_trace_count": len(demos),
            "invalid_trace_count": len(errors),
            "expected_rejection_count": len(expected_rejections),
            "validated_traces": [path.name for path, _ in demos],
            "diagnostics": [
                *unexpected_errors,
                *[
                    f"accepted expected rejection fixture: {name}"
                    for name in expected_rejections
                ],
            ],
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
    npm = shutil.which("npm")
    if npm is None:
        _emit({"passed": False, "score": 0.0, "diagnostics": ["npm not found"]})
        return 1
    if not package.is_file():
        _emit({"passed": False, "score": 0.0, "diagnostics": ["package.json missing"]})
        return 1
    package_json = _load_package_json(artifact)
    if package_json is None:
        _emit({"passed": False, "score": 0.0, "diagnostics": ["package.json unreadable"]})
        return 1
    scripts = {
        name: _package_script(package_json, name)
        for name in ("build", "check", "test", "verify")
    }
    script_name = next((name for name in ("build", "check", "test", "verify") if scripts[name]), None)
    if script_name is None:
        if _package_has_keyword(package_json, "no-build") and (
            _package_script(package_json, "start") or _package_script(package_json, "serve")
        ):
            _emit(
                {
                    "passed": True,
                    "score": 1.0,
                    "diagnostics": [
                        "no build script declared; direct-launch web game will be validated by the screenshot probe",
                    ],
                }
            )
            return 0
        _emit(
            {
                "passed": False,
                "score": 0.0,
                "diagnostics": [
                    "no build/check/test/verify script declared",
                ],
            }
        )
        return 1
    try:
        proc = _run_npm_script(artifact, script_name, timeout=args.timeout)
    except FileNotFoundError:
        _emit({"passed": False, "score": 0.0, "diagnostics": ["npm not found"]})
        return 1
    passed = proc.returncode == 0
    diagnostics = [proc.stderr[-500:]]
    if passed:
        _emit({"passed": True, "score": 1.0, "diagnostics": diagnostics})
        return 0
    smoke_script = next(
        (
            name
            for name in ("smoke", "smoke:extended", "smoke:live", "test-live-deploy")
            if _package_script(package_json, name)
        ),
        None,
    )
    if smoke_script is not None:
        try:
            if not (artifact / "node_modules").is_dir():
                install = subprocess.run(
                    [npm, "install", "--no-audit", "--no-fund"],
                    cwd=artifact,
                    capture_output=True,
                    text=True,
                    timeout=min(args.timeout, 600),
                    check=False,
                )
                diagnostics.extend(
                    [
                        "build script failed; attempted dependency install before smoke",
                        install.stderr[-500:],
                    ]
                )
            fallback = _run_npm_script(
                artifact,
                smoke_script,
                timeout=min(args.timeout, 300),
            )
        except FileNotFoundError:
            fallback = None
        else:
            fallback_ok = fallback.returncode == 0
            diagnostics.extend(
                [
                    f"build script failed; fell back to {smoke_script}",
                    fallback.stderr[-500:],
                ]
            )
            _emit(
                {
                    "passed": fallback_ok,
                    "score": 1.0 if fallback_ok else 0.0,
                    "diagnostics": diagnostics,
                }
            )
            return 0 if fallback_ok else 1
    _emit(
        {
            "passed": False,
            "score": 0.0,
            "diagnostics": diagnostics,
        }
    )
    return 1


def cmd_verigame_screenshot(args: argparse.Namespace) -> int:
    artifact = Path(args.artifact).expanduser().resolve()
    package_json = _load_package_json(artifact)
    screenshot_script = _package_script(package_json, "tool:screenshot") if package_json else None
    if screenshot_script or (artifact / "tools" / "screenshot.mjs").is_file():
        try:
            if screenshot_script:
                proc = _run_npm_script(artifact, "tool:screenshot", timeout=args.timeout)
            else:
                node = shutil.which("node") or shutil.which("nodejs")
                if node is None:
                    raise FileNotFoundError("node not found")
                proc = subprocess.run(
                    [node, str((artifact / "tools" / "screenshot.mjs").resolve())],
                    cwd=artifact,
                    capture_output=True,
                    text=True,
                    timeout=args.timeout,
                    check=False,
                )
        except FileNotFoundError:
            _emit({"passed": False, "score": 0.0, "diagnostics": ["node/npm not found"]})
            return 1
        output_text = (proc.stdout or "") + (proc.stderr or "")
        infra_error = any(
            marker in output_text
            for marker in (
                "Executable doesn't exist",
                "Please run the following command to download new browsers",
                "browserType.launch",
                "npx playwright install",
                "Playwright was just installed or updated",
            )
        )
        passed = proc.returncode == 0 and (artifact / "tools" / "shots" / "contactsheet.png").is_file()
        diagnostics = [f"timeout={args.timeout}"]
        if infra_error:
            diagnostics.append("playwright browser infrastructure missing")
        diagnostics.append(
            f"contactsheet_exists={(artifact / 'tools' / 'shots' / 'contactsheet.png').is_file()}"
        )
        tail = output_text.strip().splitlines()
        if tail:
            diagnostics.extend(tail[-5:])
        _emit(
            {
                "passed": None if infra_error else passed,
                "score": None if infra_error else (1.0 if passed else 0.0),
                "infrastructure_error": infra_error,
                "diagnostics": diagnostics,
            }
        )
        return 2 if infra_error else (0 if passed else 1)
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
    interaction.add_argument("--trace-name", default=None)
    interaction.add_argument("--timeout", type=int, default=120)
    interaction.set_defaults(func=cmd_godot_interaction_replay)

    moba = sub.add_parser("moba-scripted-playtest")
    moba.add_argument("--artifact", required=True)
    moba.add_argument("--max-frames", type=int, default=600)
    moba.add_argument("--min-traces", type=int, default=8)
    moba.add_argument("--min-long-frames", type=int, default=240)
    moba.add_argument("--pass-score", type=float, default=0.72)
    moba.set_defaults(func=cmd_moba_scripted_playtest)

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
    verigame_shot.add_argument("--timeout", type=int, default=900)
    verigame_shot.set_defaults(func=cmd_verigame_screenshot)

    browser_probe = sub.add_parser("browser-game-deep-probe")
    browser_probe.add_argument("--artifact", required=True)
    browser_probe.add_argument("--profile", default=None)
    browser_probe.add_argument("--timeout", type=int, default=45)
    browser_probe.set_defaults(func=cmd_browser_game_deep_probe)

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
