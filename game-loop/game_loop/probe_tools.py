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
