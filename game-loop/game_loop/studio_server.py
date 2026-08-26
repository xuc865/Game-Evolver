from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import mimetypes
import os
import re
import shutil
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from game_loop.core.agent_circuit import AgentRole
from game_loop.utils import atomic_write_json, read_json


SOURCE_ROOT = Path(__file__).resolve().parents[1]
PACKAGED_ROOT = Path(__file__).resolve().parent / "product_assets"
ROOT = (
    SOURCE_ROOT
    if (SOURCE_ROOT / "experiments" / "configs-v4").is_dir()
    else PACKAGED_ROOT
)
STUDIO_DIR = Path(__file__).resolve().parent / "studio_assets"
PROJECTS_ROOT = Path(
    os.environ.get(
        "GAME_LOOP_STUDIO_HOME",
        str(
            ROOT / "experiments" / "studio-projects"
            if ROOT == SOURCE_ROOT
            else Path.home() / ".game-loop" / "projects"
        ),
    )
)
SEED_ARTIFACT = ROOT / "experiments" / "seed_artifacts" / "puzzle-sokoban-scaffold"
BASE_CONFIG = ROOT / "experiments" / "configs-v4" / "gcbench-L4_deepseek_v4.json"
INNER_CONFIG = ROOT / "experiments" / "agentx" / "inner_harness_gcbench.json"
OUTER_CONFIG = ROOT / "experiments" / "agentx" / "outer_harness.json"
RUNTIME_PROFILES = {
    "opengame": ROOT / "experiments" / "inner-agent" / (
        "opengame-profile.local.json"
        if (ROOT / "experiments" / "inner-agent" / "opengame-profile.local.json").is_file()
        else "opengame-profile.example.json"
    ),
    "deepseek-harness": ROOT / "experiments" / "inner-agent" / (
        "deepseek-harness-profile.local.json"
        if (ROOT / "experiments" / "inner-agent" / "deepseek-harness-profile.local.json").is_file()
        else "deepseek-harness-profile.example.json"
    ),
}
STUDIO_OPENGAME_SYSTEM = ROOT / "experiments" / "inner-agent" / "opengame-studio-system.md"
STUDIO_DSH_SYSTEM = ROOT / "experiments" / "inner-agent" / "deepseek-harness-studio-system.md"
STUDIO_INNER_NAME = "studio-inner-harness.json"
STUDIO_OUTER_NAME = "studio-outer-harness.json"
SNAPSHOT_SCHEMA = "game-evolver-engine-snapshot.v1"
LOCAL_ENV_FILES = (ROOT / ".env.local", ROOT / "experiments" / ".env")
ALLOWED_RUNTIME_ENV = frozenset({
    "CODEX_API_BASE", "CODEX_MODEL", "CODEX_PROVIDER",
    "DEEPSEEK_API_KEY", "DEEPSEEK_API_BASE", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    "GLM_BASE_URL",
    "OPENGAME_REASONING_API_KEY", "OPENGAME_REASONING_BASE_URL",
    "OPENGAME_REASONING_MODEL", "OPENGAME_REASONING_PROVIDER",
})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(text: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:36]
    return value or "untitled-game"


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    values = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            values.append(item)
    return values


def _read_json_view(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    """Read concurrently published state without taking down the Studio view."""
    for attempt in range(3):
        try:
            value = read_json(path)
        except (OSError, ValueError, json.JSONDecodeError):
            if attempt < 2:
                time.sleep(0.002)
            continue
        if isinstance(value, dict):
            return value
        break
    return dict(default)


def _process_descendants(root_pid: int, process_table: str | None = None) -> list[int]:
    """Snapshot descendants before termination can reparent them to launchd."""
    if process_table is None:
        completed = subprocess.run(
            ["ps", "-axo", "pid=,ppid="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
        process_table = completed.stdout
    children: dict[int, list[int]] = {}
    for raw_line in process_table.splitlines():
        fields = raw_line.split()
        if len(fields) != 2 or not all(field.isdigit() for field in fields):
            continue
        pid, parent = map(int, fields)
        children.setdefault(parent, []).append(pid)
    descendants: list[int] = []
    pending = list(children.get(root_pid, ()))
    seen = {root_pid}
    while pending:
        pid = pending.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        descendants.append(pid)
        pending.extend(children.get(pid, ()))
    return descendants


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _generic_rubric(instruction: str) -> dict[str, Any]:
    requirement = instruction.strip()[:5000]
    descriptions = [
        ("M1", "The main interaction described by the creator is implemented and directly playable."),
        ("M2", "Controls are responsive, discoverable in the game, and produce clear feedback."),
        ("M3", "The game has a complete loop with goals, consequences, and restart or continuation."),
        ("D1", "There is enough authored content and variation to sustain more than a brief demo."),
        ("D2", "Progression, challenge, or systemic variation gives the player meaningful decisions."),
        ("V1", "The game starts in a polished, readable state with non-overlapping interface regions."),
        ("V2", "Gameplay state and important events are communicated through visible feedback."),
        ("A1", "Art direction, typography, motion, and UI form a coherent presentation."),
    ]
    return {
        "score_formula": "BUILD * ((M1+M2+M3+D1+D2+V1+V2+A1)/8)",
        "max_demos": 6,
        "max_demo_seconds": 20,
        "build_check": {
            "id": "BUILD",
            "cmd": "godot --headless --path /workspace/game --quit-after 5",
            "description": "The Godot project launches without fatal errors.",
        },
        "categories": [
            {"name": "Playability", "items": ["M1", "M2", "M3"]},
            {"name": "Depth", "items": ["D1", "D2"]},
            {"name": "Clarity", "items": ["V1", "V2"]},
            {"name": "Presentation", "items": ["A1"]},
        ],
        "requirements": [
            {
                "id": key,
                "agg": "mean",
                "description": f"{description} Creator brief: {requirement}",
            }
            for key, description in descriptions
        ],
    }


class StudioManager:
    def __init__(self, projects_root: Path = PROJECTS_ROOT, *, runner=None):
        self.projects_root = projects_root.resolve()
        self.projects_root.mkdir(parents=True, exist_ok=True)
        self.runner = runner or subprocess.Popen
        self._lock = threading.RLock()
        self._processes: dict[str, subprocess.Popen] = {}
        self._stopping: set[str] = set()
        self._recover_interrupted_projects()

    def _dir(self, project_id: str) -> Path:
        if not re.fullmatch(r"[a-z0-9-]{8,80}", project_id):
            raise ValueError("invalid project id")
        path = (self.projects_root / project_id).resolve()
        if self.projects_root not in path.parents:
            raise ValueError("invalid project path")
        return path

    def _meta(self, project_id: str) -> dict[str, Any]:
        path = self._dir(project_id) / "project.json"
        if not path.is_file():
            raise FileNotFoundError(project_id)
        return read_json(path)

    def _save(self, project_id: str, meta: dict[str, Any]) -> None:
        meta["updated_at"] = _now()
        atomic_write_json(self._dir(project_id) / "project.json", meta)

    def list_projects(self) -> list[dict[str, Any]]:
        projects = []
        for path in self.projects_root.glob("*/project.json"):
            try:
                projects.append(read_json(path))
            except (OSError, ValueError, json.JSONDecodeError):
                continue
        return sorted(projects, key=lambda item: item.get("updated_at", ""), reverse=True)

    def create_project(self, *, title: str, runtime: str = "deepseek-harness") -> dict[str, Any]:
        runtime = runtime if runtime in RUNTIME_PROFILES else "deepseek-harness"
        title = title.strip() or "Untitled game"
        project_id = f"{_slug(title)}-{uuid.uuid4().hex[:8]}"
        path = self._dir(project_id)
        (path / "turns").mkdir(parents=True)
        (path / "artifacts").mkdir()
        meta = {
            "id": project_id,
            "title": title[:80],
            "runtime": runtime,
            "status": "ready",
            "stage": "Ready for your first idea",
            "turn_count": 0,
            "current_artifact": None,
            "current_score": None,
            "created_at": _now(),
            "updated_at": _now(),
            "error": None,
        }
        self._write_config(path, runtime)
        self._save(project_id, meta)
        return self.get_project(project_id)

    def _write_config(self, path: Path, runtime: str) -> None:
        config = read_json(BASE_CONFIG)
        config["benchmark"]["options"]["root"] = str(ROOT)
        runtime_profile = read_json(RUNTIME_PROFILES[runtime])
        if runtime == "opengame":
            runtime_profile["backbone_provider"] = "deepseek"
            runtime_profile["system_prompt_path"] = str(STUDIO_OPENGAME_SYSTEM)
            runtime_profile.pop("system_prompt_variables", None)
        else:
            source_cordis = ROOT / "experiments" / "inner-agent" / "deepseek-harness.cordis.yml"
            studio_cordis = path / "studio-deepseek-harness.cordis.yml"
            cordis_text = source_cordis.read_text(encoding="utf-8")
            cordis_text = cordis_text.replace("reasoningEffort: max", "reasoningEffort: low", 1)
            studio_cordis.write_text(cordis_text, encoding="utf-8")
            runtime_profile["cordis"] = str(studio_cordis)
            runtime_profile.pop("runtime_bin", None)
            runtime_profile["runtime_cwd"] = str(ROOT)
            runtime_profile["system_prompt_path"] = str(STUDIO_DSH_SYSTEM)
            runtime_profile["max_tokens"] = 24576
            runtime_profile["timeout_seconds"] = 1200
        profile_path = path / f"studio-{runtime}-profile.json"
        atomic_write_json(profile_path, runtime_profile)
        config["backend"]["runtime_profile"] = str(profile_path)
        command = list(config["backend"]["command"])
        if "{task_source}" not in command:
            command.append("{task_source}")
        config["backend"]["command"] = command
        config["evolution"]["max_generations"] = 1
        config["evolution"]["candidates_per_generation"] = 1
        atomic_write_json(path / "studio-config.json", config)
        inner = read_json(INNER_CONFIG)
        inner["replay_min_cases"] = 1
        inner["rubric_validation_sample_size"] = 1
        inner["enable_agent_circuit_evolution"] = True
        inner["circuit_max_actions"] = 4
        inner["circuit_bundle_width"] = 3
        inner["circuit_max_roles"] = 8
        inner["circuit_max_model_calls"] = 12
        inner["circuit_max_cost_units"] = 12
        inner["circuit_max_feedback_traversals"] = 3
        inner["circuit_min_net_utility"] = 0.0
        outer = read_json(OUTER_CONFIG)
        outer["replay_min_cases"] = 1
        outer["rubric_validation_sample_size"] = 1
        outer["outer_library_max_actions"] = 4
        outer["outer_library_max_additions"] = 2
        atomic_write_json(path / STUDIO_INNER_NAME, inner)
        atomic_write_json(path / STUDIO_OUTER_NAME, outer)

    def _recover_interrupted_projects(self) -> None:
        for meta in self.list_projects():
            if meta.get("status") != "running":
                continue
            project_id = str(meta.get("id", ""))
            pending = max(
                (int(item.get("turn", 0)) for item in _read_jsonl(self._dir(project_id) / "messages.jsonl") if item.get("role") == "user"),
                default=0,
            )
            if pending <= int(meta.get("turn_count", 0)):
                meta.update({"status": "ready", "stage": "Ready to play"})
                self._save(project_id, meta)
                continue
            meta["stage"] = "Resuming an interrupted build"
            self._save(project_id, meta)
            thread = threading.Thread(target=self._run_turn, args=(project_id, pending), name=f"studio-recover-{project_id}", daemon=True)
            thread.start()

    def get_project(self, project_id: str) -> dict[str, Any]:
        meta = self._meta(project_id)
        meta["messages"] = _read_jsonl(self._dir(project_id) / "messages.jsonl")
        meta["turns"] = self._turns(project_id)
        meta["engine"] = self._engine_summary(project_id)
        meta["evolution_graph"] = self._evolution_graph(project_id)
        meta["snapshots"] = self.list_snapshots(project_id)
        meta["running"] = self._is_running(project_id)
        meta["preview_url"] = self._preview_url(project_id, meta)
        meta["web_preview_url"] = (
            f"/api/projects/{project_id}/game/index.html"
            if meta.get("web_preview_dir") and Path(str(meta["web_preview_dir"])).is_dir()
            else None
        )
        return meta

    @staticmethod
    def _snapshot_sources(
        project: Path,
        kind: str,
        *,
        include_missing: bool = False,
    ) -> tuple[Path, ...]:
        run_dir = project / "evolution"
        if kind == "goa":
            candidates = (run_dir / "inner" / "harness_archive",)
        elif kind == "hpa":
            candidates = (
                run_dir / "outer" / "harness_archive",
                run_dir / "outer_element_library",
                run_dir / "harness_transformation_library",
            )
        else:
            raise ValueError("snapshot kind must be goa or hpa")
        return candidates if include_missing else tuple(
            source for source in candidates if source.is_dir()
        )

    @staticmethod
    def _snapshot_target_name(project: Path, source: Path) -> str:
        return source.relative_to(project / "evolution").as_posix().replace("/", "__")

    @staticmethod
    def _tree_hash(paths: tuple[Path, ...]) -> str:
        digest = hashlib.sha256()
        for index, root in enumerate(paths):
            digest.update(str(index).encode())
            for path in sorted(item for item in root.rglob("*") if item.is_file()):
                digest.update(path.relative_to(root).as_posix().encode())
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
        return digest.hexdigest()

    def list_snapshots(self, project_id: str) -> list[dict[str, Any]]:
        root = self._dir(project_id) / "snapshots"
        values = []
        for path in root.glob("*/manifest.json") if root.is_dir() else ():
            try:
                item = read_json(path)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            if item.get("schema") == SNAPSHOT_SCHEMA and item.get("kind") in {"goa", "hpa"}:
                values.append(item)
        return sorted(values, key=lambda item: item.get("created_at", ""), reverse=True)

    def save_snapshot(self, project_id: str, *, kind: str, name: str, automatic: bool = False) -> dict[str, Any]:
        with self._lock:
            meta = self._meta(project_id)
            if self._is_running(project_id) or meta.get("status") == "running":
                raise RuntimeError("wait for the current evolution turn before saving a snapshot")
            project = self._dir(project_id)
            sources = self._snapshot_sources(project, kind)
            if not sources:
                raise ValueError(f"{kind.upper()} has no evolved state to snapshot yet")
            clean_name = re.sub(r"\s+", " ", name.strip())[:80]
            if not clean_name:
                clean_name = f"{kind.upper()} at version {int(meta.get('turn_count', 0))}"
            snapshot_id = f"{kind}-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
            root = project / "snapshots"
            root.mkdir(exist_ok=True)
            staging = root / f".{snapshot_id}.tmp"
            final = root / snapshot_id
            state_dir = staging / "state"
            state_dir.mkdir(parents=True)
            for source in sources:
                shutil.copytree(source, state_dir / self._snapshot_target_name(project, source), symlinks=True)
            manifest = {
                "schema": SNAPSHOT_SCHEMA,
                "id": snapshot_id,
                "name": clean_name,
                "kind": kind,
                "created_at": _now(),
                "source_turn": int(meta.get("turn_count", 0)),
                "runtime": str(meta.get("runtime", "deepseek-harness")),
                "source_names": [
                    self._snapshot_target_name(project, source) for source in sources
                ],
                "content_hash": self._tree_hash(sources),
                "automatic": bool(automatic),
            }
            atomic_write_json(staging / "manifest.json", manifest)
            staging.rename(final)
            return manifest

    def load_snapshot(self, project_id: str, snapshot_id: str) -> dict[str, Any]:
        if not re.fullmatch(r"(?:goa|hpa)-[a-zA-Z0-9-]{8,100}", snapshot_id):
            raise ValueError("invalid snapshot id")
        with self._lock:
            meta = self._meta(project_id)
            if self._is_running(project_id) or meta.get("status") == "running":
                raise RuntimeError("stop or finish the current evolution turn before loading a snapshot")
            project = self._dir(project_id)
            snapshot = project / "snapshots" / snapshot_id
            manifest_path = snapshot / "manifest.json"
            if not manifest_path.is_file():
                raise FileNotFoundError(snapshot_id)
            manifest = read_json(manifest_path)
            kind = str(manifest.get("kind", ""))
            if manifest.get("schema") != SNAPSHOT_SCHEMA or kind not in {"goa", "hpa"}:
                raise ValueError("unsupported snapshot schema")
            if manifest.get("runtime") != meta.get("runtime"):
                raise ValueError("snapshot runtime does not match this project")
            allowed_targets = {
                self._snapshot_target_name(project, target): target
                for target in self._snapshot_sources(
                    project, kind, include_missing=True
                )
            }
            source_names = manifest.get("source_names")
            if isinstance(source_names, list) and source_names:
                try:
                    targets = tuple(allowed_targets[str(name)] for name in source_names)
                except KeyError as exc:
                    raise ValueError("snapshot contains an unknown state target") from exc
            else:
                targets = self._snapshot_sources(project, kind)
            stored = tuple(snapshot / "state" / self._snapshot_target_name(project, target) for target in targets)
            if any(not path.is_dir() for path in stored):
                raise ValueError("snapshot state is incomplete")
            if self._tree_hash(stored) != manifest.get("content_hash"):
                raise ValueError("snapshot integrity check failed")

            self.save_snapshot(
                project_id,
                kind=kind,
                name=f"Auto backup before loading {manifest.get('name', snapshot_id)}",
                automatic=True,
            )
            transaction = project / f".snapshot-load-{uuid.uuid4().hex}"
            staged_root = transaction / "staged"
            prior_root = transaction / "prior"
            staged_root.mkdir(parents=True)
            prior_root.mkdir()
            for source, target in zip(stored, targets):
                shutil.copytree(source, staged_root / self._snapshot_target_name(project, target), symlinks=True)
            moved: list[tuple[Path, Path]] = []
            installed: list[Path] = []
            try:
                for target in targets:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    prior = prior_root / self._snapshot_target_name(project, target)
                    if target.exists():
                        target.rename(prior)
                        moved.append((prior, target))
                    (staged_root / self._snapshot_target_name(project, target)).rename(target)
                    installed.append(target)
            except Exception:
                for target in installed:
                    if target.exists():
                        shutil.rmtree(target)
                for prior, target in reversed(moved):
                    prior.rename(target)
                raise
            finally:
                shutil.rmtree(transaction, ignore_errors=True)
            meta["stage"] = f"Loaded {kind.upper()} snapshot: {manifest.get('name', snapshot_id)}"
            self._save(project_id, meta)
            return self.get_project(project_id)

    def set_runtime(self, project_id: str, runtime: str) -> dict[str, Any]:
        if runtime not in RUNTIME_PROFILES:
            raise ValueError("unsupported maker runtime")
        with self._lock:
            meta = self._meta(project_id)
            if int(meta.get("turn_count", 0)) or meta.get("status") == "running":
                raise ValueError("maker runtime is fixed after the first build")
            meta["runtime"] = runtime
            self._write_config(self._dir(project_id), runtime)
            self._save(project_id, meta)
        return self.get_project(project_id)

    def _turns(self, project_id: str) -> list[dict[str, Any]]:
        values = []
        for path in sorted((self._dir(project_id) / "turns").glob("*/turn.json")):
            try:
                values.append(read_json(path))
            except (OSError, ValueError, json.JSONDecodeError):
                pass
        return values

    def _is_running(self, project_id: str) -> bool:
        process = self._processes.get(project_id)
        return process is not None and process.poll() is None

    def send_message(self, project_id: str, content: str) -> dict[str, Any]:
        content = content.strip()
        if not content:
            raise ValueError("message is required")
        with self._lock:
            meta = self._meta(project_id)
            if self._is_running(project_id) or meta.get("status") == "running":
                raise RuntimeError("this project is already evolving")
            if meta.get("status") == "error":
                raise RuntimeError("retry the interrupted build before adding another request")
            turn = int(meta.get("turn_count", 0)) + 1
            _append_jsonl(self._dir(project_id) / "messages.jsonl", {
                "id": uuid.uuid4().hex,
                "role": "user",
                "content": content,
                "turn": turn,
                "created_at": _now(),
            })
            meta.update({"status": "running", "stage": "Understanding your direction", "error": None})
            self._save(project_id, meta)
            thread = threading.Thread(
                target=self._run_turn,
                args=(project_id, turn),
                name=f"studio-{project_id}-t{turn}",
                daemon=True,
            )
            thread.start()
        return self.get_project(project_id)

    def retry(self, project_id: str) -> dict[str, Any]:
        with self._lock:
            meta = self._meta(project_id)
            if self._is_running(project_id) or meta.get("status") == "running":
                raise RuntimeError("this project is already evolving")
            pending = max(
                (int(item.get("turn", 0)) for item in _read_jsonl(self._dir(project_id) / "messages.jsonl") if item.get("role") == "user"),
                default=0,
            )
            if pending <= int(meta.get("turn_count", 0)):
                raise ValueError("there is no interrupted build to retry")
            meta.update({"status": "running", "stage": "Retrying the interrupted build", "error": None})
            self._save(project_id, meta)
            thread = threading.Thread(target=self._run_turn, args=(project_id, pending), name=f"studio-retry-{project_id}", daemon=True)
            thread.start()
        return self.get_project(project_id)

    def _task_instruction(self, project_id: str) -> str:
        messages = _read_jsonl(self._dir(project_id) / "messages.jsonl")
        user_messages = [item["content"] for item in messages if item.get("role") == "user"]
        first = user_messages[0]
        followups = "\n".join(f"- {text}" for text in user_messages[1:])
        return (
            "Build and refine a polished, directly playable Godot 4 game.\n\n"
            f"Original direction:\n{first}\n\n"
            + (f"Requested refinements, in order:\n{followups}\n\n" if followups else "")
            + "Preserve good existing behavior while implementing the newest request. "
            "Use authored visuals where practical, keep UI readable, and leave a runnable project."
        )

    def _write_task(self, project_id: str, turn: int) -> Path:
        turn_dir = self._dir(project_id) / "turns" / f"{turn:03d}"
        task = turn_dir / "task"
        (task / "tests").mkdir(parents=True, exist_ok=True)
        instruction = self._task_instruction(project_id)
        (task / "instruction.md").write_text(instruction + "\n", encoding="utf-8")
        (task / "task.toml").write_text(
            'schema_version = "1.2"\nartifacts = []\n\n[task]\n'
            f'name = "game-evolver/{self._dir(project_id).name}-turn-{turn}"\n'
            f'description = {json.dumps(instruction[:500])}\n',
            encoding="utf-8",
        )
        atomic_write_json(task / "tests" / "rubric.json", _generic_rubric(instruction))
        atomic_write_json(turn_dir / "turn.json", {
            "turn": turn,
            "status": "running",
            "stage": "Preparing the game maker",
            "created_at": _now(),
        })
        return task

    def _run_command(self, project_id: str, argv: list[str], log_path: Path) -> int:
        env = self._runtime_environment()
        env.setdefault("PYTHONUNBUFFERED", "1")
        with log_path.open("a", encoding="utf-8") as log:
            process = self.runner(
                argv,
                cwd=ROOT,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            self._processes[project_id] = process
            return process.wait()

    @staticmethod
    def _runtime_environment() -> dict[str, str]:
        env = os.environ.copy()
        interpreter = Path(sys.executable)
        interpreter_dir = str(interpreter.parent)
        env["PYTHON"] = str(interpreter)
        env["PATH"] = interpreter_dir + os.pathsep + env.get("PATH", "")
        for path in LOCAL_ENV_FILES:
            if not path.is_file():
                continue
            for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].lstrip()
                name, separator, raw_value = line.partition("=")
                name = name.strip()
                if not separator or name not in ALLOWED_RUNTIME_ENV:
                    continue
                try:
                    parts = shlex.split(raw_value, comments=True, posix=True)
                except ValueError:
                    continue
                if parts:
                    env.setdefault(name, parts[0])
        proposer_env = read_json(BASE_CONFIG).get("backend", {}).get("env", {})
        for name in ("CODEX_API_BASE", "CODEX_MODEL", "GAME_LOOP_BACKBONE_PROVIDER"):
            value = proposer_env.get(name)
            if value:
                env.setdefault(name, str(value))
        if env.get("DEEPSEEK_API_BASE") and not env.get("DEEPSEEK_BASE_URL"):
            env["DEEPSEEK_BASE_URL"] = env["DEEPSEEK_API_BASE"]
        if env.get("DEEPSEEK_API_KEY"):
            env.setdefault("OPENAI_API_KEY", env["DEEPSEEK_API_KEY"])
        return env

    def _run_turn(self, project_id: str, turn: int) -> None:
        lock_path = self._dir(project_id) / ".studio-run.lock"
        with lock_path.open("a+", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            try:
                self._run_turn_locked(project_id, turn)
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _run_turn_locked(self, project_id: str, turn: int) -> None:
        project = self._dir(project_id)
        turn_dir = project / "turns" / f"{turn:03d}"
        try:
            task = self._write_task(project_id, turn)
            meta = self._meta(project_id)
            seed = Path(meta["current_artifact"]) if meta.get("current_artifact") else SEED_ARTIFACT
            run_dir = project / "evolution"
            common = [
                "--run-dir", str(run_dir),
                "--config", str(project / "studio-config.json"),
                "--inner-config", str(project / STUDIO_INNER_NAME),
                "--outer-config", str(project / STUDIO_OUTER_NAME),
            ]
            log_path = turn_dir / "run.log"
            if not (run_dir / "nested_evolution.json").is_file():
                meta["stage"] = "Starting the creative engine"
                self._save(project_id, meta)
                rc = self._run_command(project_id, [
                    sys.executable, "-m", "game_loop.cli", "agentx-nested-init", *common,
                    "--bench", "gcbench", "--enable-outer-evolution",
                ], log_path)
                if rc:
                    raise RuntimeError(f"creative engine initialization failed ({rc})")
            replay_dir = run_dir / "replays" / f"epoch_{turn:03d}"
            if replay_dir.exists() and self._formal_result(run_dir, turn) is None:
                archive = project / "incomplete_replays" / f"epoch_{turn:03d}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
                archive.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(replay_dir), str(archive))
            result = self._formal_result(run_dir, turn)
            if result is None:
                meta = self._meta(project_id)
                meta["stage"] = "Building and comparing versions"
                self._save(project_id, meta)
                rc = self._run_command(project_id, [
                    sys.executable, "-m", "game_loop.cli", "agentx-nested-epoch", *common,
                    "--epoch", str(turn), "--task-source", str(task),
                    "--seed-artifact", str(seed), "--seed-score", str(self._turn_seed_score(meta)),
                    "--enable-outer-evolution",
                ], log_path)
                if rc:
                    raise RuntimeError(f"game evolution stopped unexpectedly ({rc})")
                result = self._formal_result(run_dir, turn)
            if result is None:
                raise RuntimeError("no infrastructure-complete result was produced")
            source, score, accepted = result
            artifact = project / "artifacts" / f"turn-{turn:03d}"
            if artifact.exists():
                shutil.rmtree(artifact)
            shutil.copytree(source, artifact)
            self._capture_preview(artifact)
            web_preview = self._export_web(project, artifact, turn)
            turn_meta = read_json(turn_dir / "turn.json")
            turn_meta.update({
                "status": "completed", "stage": "Ready to play", "completed_at": _now(),
                "score": score, "accepted_harness": accepted, "artifact": str(artifact),
                **web_preview,
            })
            atomic_write_json(turn_dir / "turn.json", turn_meta)
            meta = self._meta(project_id)
            meta.update({
                "status": "ready", "stage": "Ready to play", "turn_count": turn,
                "current_artifact": str(artifact), "current_score": score, "error": None,
                **web_preview,
            })
            self._save(project_id, meta)
            _append_jsonl(project / "messages.jsonl", {
                "id": uuid.uuid4().hex, "role": "assistant", "turn": turn,
                "content": "Your new playable version is ready. I kept the strongest result and carried what I learned into the next edit.",
                "created_at": _now(),
            })
        except Exception as exc:  # worker boundary
            meta = self._meta(project_id)
            stopped = project_id in self._stopping
            meta.update({
                "status": "ready" if stopped else "error",
                "stage": "Stopped" if stopped else "Needs attention",
                "error": None if stopped else str(exc),
            })
            self._save(project_id, meta)
            if (turn_dir / "turn.json").is_file():
                value = read_json(turn_dir / "turn.json")
                value.update({"status": "stopped" if stopped else "error", "error": None if stopped else str(exc), "completed_at": _now()})
                atomic_write_json(turn_dir / "turn.json", value)
        finally:
            self._processes.pop(project_id, None)
            self._stopping.discard(project_id)

    @staticmethod
    def _turn_seed_score(meta: dict[str, Any]) -> float:
        # Every message expands the public rubric, so a score from the prior
        # turn is not comparable to candidates evaluated under the new rubric.
        del meta
        return 0.0

    def _export_web(self, project: Path, artifact: Path, turn: int) -> dict[str, Any]:
        godot = self._godot_bin()
        if godot is None:
            return {"web_preview_dir": None, "preview_status": "native_only"}
        web_dir = project / "previews" / f"turn-{turn:03d}"
        web_dir.mkdir(parents=True, exist_ok=True)
        preset = artifact / "export_presets.cfg"
        created_preset = not preset.exists()
        if created_preset:
            preset.write_text(
                '[preset.0]\nname="Web"\nplatform="Web"\nrunnable=true\nadvanced_options=false\n'
                'export_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nexport_path="web/index.html"\n\n'
                '[preset.0.options]\nvariant/extensions_support=false\nvariant/thread_support=false\n'
                'vram_texture_compression/for_desktop=true\nvram_texture_compression/for_mobile=false\n'
                'html/canvas_resize_policy=2\nhtml/focus_canvas_on_start=true\nprogressive_web_app/enabled=false\n',
                encoding="utf-8",
            )
        try:
            completed = subprocess.run(
                [str(godot), "--headless", "--path", str(artifact), "--export-release", "Web", str(web_dir / "index.html")],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=300,
                check=False,
            )
            (web_dir / "export.log").write_text(completed.stdout[-20000:], encoding="utf-8")
            if completed.returncode == 0 and (web_dir / "index.html").is_file():
                return {"web_preview_dir": str(web_dir), "preview_status": "web_ready"}
            return {"web_preview_dir": None, "preview_status": "native_only"}
        except (OSError, subprocess.TimeoutExpired) as exc:
            (web_dir / "export.log").write_text(str(exc), encoding="utf-8")
            return {"web_preview_dir": None, "preview_status": "native_only"}
        finally:
            if created_preset and preset.exists():
                preset.unlink()

    def _capture_preview(self, artifact: Path) -> Path | None:
        godot = self._godot_bin()
        script = STUDIO_DIR / "screenshot.gd"
        if godot is None or not script.is_file():
            return None
        preview = artifact / "studio-preview.png"
        try:
            imported = subprocess.run(
                [str(godot), "--headless", "--editor", "--path", str(artifact), "--quit"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=120,
                check=False,
            )
            if imported.returncode:
                return None
            command = [str(godot), "--path", str(artifact)]
            if sys.platform == "darwin":
                command += ["--display-driver", "macos", "--rendering-driver", "opengl3"]
            else:
                command += ["--headless"]
            command += [
                "--audio-driver", "Dummy", "--resolution", "1280x720",
                "--script", str(script), "--", "--out", str(preview), "--frames", "100",
            ]
            captured = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=75,
                check=False,
            )
            return preview if captured.returncode == 0 and preview.is_file() else None
        except (OSError, subprocess.TimeoutExpired):
            return None

    @staticmethod
    def _godot_bin() -> Path | None:
        candidates = [
            os.environ.get("GODOT_EXEC_PATH"),
            shutil.which("godot"),
            ROOT / ".tools" / "godot" / "Godot_v4.6.2-stable",
        ]
        for value in candidates:
            if value and Path(value).is_file() and os.access(value, os.X_OK):
                return Path(value).resolve()
        return None

    def _formal_result(self, run_dir: Path, epoch: int) -> tuple[Path, float, bool] | None:
        nested = read_json(run_dir / "nested_evolution.json")
        matches = [item for item in nested.get("epochs", []) if item.get("inner", {}).get("epoch") == epoch]
        if not matches:
            return None
        inner = matches[-1]["inner"]
        parent_outcomes = [item for item in inner.get("parent_outcomes", []) if item.get("infrastructure_ok")]
        candidate_outcomes = [item for item in inner.get("candidate_outcomes", []) if item.get("infrastructure_ok")]
        if not parent_outcomes or not candidate_outcomes:
            return None
        preferred_side = "candidate" if inner.get("accepted") else "parent"
        outcomes = [
            (side, item)
            for side, values in (("parent", parent_outcomes), ("candidate", candidate_outcomes))
            for item in values
        ]
        _, outcome = max(outcomes, key=lambda pair: (
            float(pair[1].get("final_score") or 0.0),
            pair[0] == preferred_side,
        ))
        replay = Path(outcome["run_ref"])
        state = read_json(replay / "state.json")
        artifact_id = state.get("champion_artifact_id")
        artifact = replay / "artifacts" / str(artifact_id) / "artifact"
        if not artifact.is_dir():
            return None
        return artifact, float(outcome.get("final_score") or 0.0), bool(inner.get("accepted"))

    def _engine_summary(self, project_id: str) -> dict[str, Any]:
        run_dir = self._dir(project_id) / "evolution"
        nested_path = run_dir / "nested_evolution.json"
        if not nested_path.is_file():
            return {"game": "Learning starts with your first build", "maker": "Ready"}
        nested = _read_json_view(nested_path, {"epochs": []})
        epochs = nested.get("epochs", [])
        latest = epochs[-1] if epochs else {}
        inner = latest.get("inner") or {}
        outer = latest.get("outer") or {}
        outer_update = latest.get("outer_element_library_update") or {}
        library = outer_update.get("library_update") or {}
        return {
            "game": "Promoted" if inner.get("accepted") else "Best version retained",
            "maker": "Improved" if outer.get("accepted") else "Evidence retained",
            "library_revision": library.get("revision_after", 0),
        }

    @staticmethod
    def _graph_node(element: dict[str, Any], stats: dict[str, Any], *, active: bool = True) -> dict[str, Any]:
        element_id = str(element.get("element_id", element.get("id", "element")))
        category = str(element.get("category", "element"))
        item_stats = stats.get(f"{category}:{element_id}", {})
        return {
            "id": element_id,
            "label": element_id.removeprefix("dsh_plugin_").replace("_", " "),
            "category": category,
            "description": str(element.get("description", "Reusable harness capability.")),
            "active": active,
            "uses": int(item_stats.get("usage_count", 0)),
            "successes": int(item_stats.get("success_count", 0)),
            "accuracy": item_stats.get("accuracy"),
            "score_mean": item_stats.get("score_mean"),
        }

    def _evolution_graph(self, project_id: str) -> dict[str, Any]:
        project = self._dir(project_id)
        meta = self._meta(project_id)
        run_dir = project / "evolution"
        inner_archive = run_dir / "inner" / "harness_archive"
        stats_path = inner_archive / "element_stats.json"
        inner_stats = (
            _read_json_view(stats_path, {}).get("items", {})
            if stats_path.is_file()
            else {}
        )
        champion_path = inner_archive / "champion.json"
        champion_id = None
        active_elements: list[dict[str, Any]] = []
        agent_circuit: dict[str, Any] | None = None
        if champion_path.is_file():
            champion_id = str(
                _read_json_view(champion_path, {}).get("harness_id", "")
            )
            profile_path = inner_archive / "profiles" / f"{champion_id}.json"
            if profile_path.is_file():
                profile = _read_json_view(profile_path, {})
                active_elements = list(profile.get("active_elements", []))
                raw_circuit = profile.get("agent_circuit")
                if isinstance(raw_circuit, dict):
                    agent_circuit = raw_circuit
        if not active_elements:
            inner_cfg = read_json(INNER_CONFIG)
            catalog = {item["id"]: item for item in inner_cfg.get("element_catalog", [])}
            for category, ids in inner_cfg.get("seed_element_ids", {}).items():
                for element_id in ids:
                    item = dict(catalog.get(element_id, {"id": element_id, "category": category}))
                    item.setdefault("category", category)
                    active_elements.append(item)
            if not active_elements:
                modules = {item["id"]: item for item in inner_cfg.get("modules", [])}
                for module_id in inner_cfg.get("seed_modules", []):
                    module = modules.get(module_id, {"id": module_id})
                    active_elements.append({
                        "id": module_id,
                        "category": "workflow",
                        "description": module.get("instruction", "Seed game-making workflow."),
                    })

        outer_store = run_dir / "outer_element_library"
        catalog_path = outer_store / "catalog.json"
        outer_stats_path = outer_store / "element_stats.json"
        outer_catalog = (
            _read_json_view(catalog_path, {}).get("items", [])
            if catalog_path.is_file()
            else read_json(OUTER_CONFIG).get("element_catalog", [])
        )
        outer_stats = (
            _read_json_view(outer_stats_path, {}).get("items", {})
            if outer_stats_path.is_file()
            else {}
        )
        transformation_store = run_dir / "harness_transformation_library"
        transformation_catalog_path = transformation_store / "catalog.json"
        transformation_stats_path = transformation_store / "stats.json"
        transformation_catalog = (
            _read_json_view(transformation_catalog_path, {}).get("items", [])
            if transformation_catalog_path.is_file()
            else []
        )
        transformation_stats = (
            _read_json_view(transformation_stats_path, {}).get("items", {})
            if transformation_stats_path.is_file()
            else {}
        )
        runtime = str(meta.get("runtime", "opengame"))
        if runtime == "deepseek-harness":
            plugins = [item for item in active_elements if item.get("category") == "dsh_plugin"]
            if not plugins:
                runtime_profile = read_json(RUNTIME_PROFILES["deepseek-harness"])
                plugins = [
                    {
                        "id": f"dsh_plugin_{plugin_id}",
                        "category": "dsh_plugin",
                        "description": f"Audited Cordis plugin available to the evolving DSH game-maker harness: {plugin_id.replace('_', ' ')}.",
                        "available": True,
                    }
                    for plugin_id in runtime_profile.get("cordis_plugin_catalog", {})
                ]
            selected_inner = plugins + [item for item in active_elements if item.get("category") != "dsh_plugin"][:4]
        else:
            priority = {"workflow": 0, "skill": 1, "tool": 2, "mcp": 3, "context": 4, "protocol": 5}
            selected_inner = sorted(active_elements, key=lambda item: priority.get(str(item.get("category")), 9))[:10]
        active_outer_ids: set[str] = set()
        nested_path = run_dir / "nested_evolution.json"
        if nested_path.is_file():
            epochs = _read_json_view(nested_path, {"epochs": []}).get("epochs", [])
            if epochs:
                active_outer_ids = set(epochs[-1].get("outer_element_ids_used_for_inner_proposal", []))
        if transformation_catalog:
            hpa_nodes = []
            for item in transformation_catalog:
                transformation_id = str(item.get("id", "transformation"))
                stats = transformation_stats.get(transformation_id, {})
                hpa_nodes.append({
                    "id": transformation_id,
                    "label": str(item.get("name", transformation_id)),
                    "category": "transformation",
                    "description": str(item.get("description", "Reusable circuit transformation.")),
                    "active": True,
                    "uses": int(stats.get("uses", 0)),
                    "successes": int(stats.get("successes", 0)),
                    "accuracy": stats.get("success_rate"),
                    "score_mean": stats.get("mean_net_utility"),
                    "operations": list(item.get("supported_operations", [])),
                    "signals": list(item.get("trigger_signals", [])),
                    "cost_prior": item.get("cost_prior"),
                })
        else:
            hpa_nodes = [
                self._graph_node(
                    item,
                    outer_stats,
                    active=(not active_outer_ids or item.get("id") in active_outer_ids),
                )
                for item in outer_catalog[:10]
            ]
        goa_edges: list[dict[str, Any]] = []
        if agent_circuit is not None:
            runtime_profile_path = project / "studio-deepseek-harness-profile.json"
            runtime_profile = (
                read_json(runtime_profile_path)
                if runtime_profile_path.is_file()
                else {}
            )
            latest_role_results: dict[str, dict[str, Any]] = {}
            circuit_id = str(agent_circuit.get("circuit_id", ""))
            circuit_runs = sorted(
                project.glob("evolution/replays/**/circuit_run.json"),
                key=lambda path: path.stat().st_mtime_ns,
                reverse=True,
            )
            for circuit_run in circuit_runs:
                run = _read_json_view(circuit_run, {})
                if circuit_id and str(run.get("circuit_id", "")) != circuit_id:
                    continue
                latest_role_results = {
                    str(item.get("role_id")): dict(item)
                    for item in run.get("role_results", [])
                    if isinstance(item, dict)
                }
                break
            goa_nodes = [
                {
                    "id": str(role.get("role_id")),
                    "label": str(role.get("name", role.get("role_id", "agent"))),
                    "category": str(role.get("kind", "operator")),
                    "description": str(role.get("objective", "Circuit role.")),
                    "active": True,
                    "uses": 1,
                    "successes": 0,
                    "accuracy": None,
                    "score_mean": None,
                    "context": role.get("context", {}),
                    "budget": role.get("budget", {}),
                    "tools": list(role.get("tool_interface_ids", [])),
                    "capabilities": list(role.get("capabilities", [])),
                    "outputs": list(
                        role.get(
                            "output_artifact_kinds",
                            AgentRole.from_dict(role).effective_output_artifact_kinds,
                        )
                    ),
                    "provider": role.get("provider", runtime_profile.get("provider")),
                    "model": role.get("model", runtime_profile.get("model")),
                    "harness": dict(role.get("harness_spec", {})),
                    "role_behavior_hash": AgentRole.from_dict(
                        role
                    ).effective_harness_hash,
                    "effective_harness_hash": latest_role_results.get(
                        str(role.get("role_id")), {}
                    ).get("effective_harness_hash"),
                    "effective_cordis_hash": latest_role_results.get(
                        str(role.get("role_id")), {}
                    ).get("effective_cordis_hash"),
                    "runtime_status": latest_role_results.get(
                        str(role.get("role_id")), {}
                    ).get("status"),
                    "infrastructure_ok": latest_role_results.get(
                        str(role.get("role_id")), {}
                    ).get("infrastructure_ok"),
                }
                for role in agent_circuit.get("roles", [])
            ]
            goa_edges = [
                {
                    "id": str(edge.get("edge_id")),
                    "source": str(edge.get("source")),
                    "target": str(edge.get("target")),
                    "kind": str(edge.get("kind", "control")),
                    "description": str(edge.get("instruction", "Typed circuit handoff.")),
                    "artifact_kinds": list(edge.get("artifact_kinds", [])),
                    "max_traversals": int(edge.get("max_traversals", 1)),
                }
                for edge in agent_circuit.get("edges", [])
            ]
        else:
            goa_nodes = [
                self._graph_node(item, inner_stats, active=not item.get("available", False))
                for item in selected_inner
            ]
        return {
            "runtime": runtime,
            "goa_harness_id": champion_id,
            "hpa_revision": self._engine_summary(project_id).get("library_revision", 0),
            "hpa": hpa_nodes,
            "goa": goa_nodes,
            "goa_edges": goa_edges,
        }

    def _preview_url(self, project_id: str, meta: dict[str, Any]) -> str | None:
        artifact = meta.get("current_artifact")
        if not artifact:
            return None
        root = Path(artifact)
        images = sorted(
            path for path in root.rglob("*")
            if path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
            and ".godot" not in path.parts
        )
        if not images:
            return None
        def rank(path: Path) -> tuple[int, int]:
            text = path.as_posix().lower()
            semantic = 0 if any(word in text for word in ("screenshot", "preview", "title", "background")) else 1
            return semantic, -path.stat().st_size
        selected = min(images, key=rank)
        return f"/api/projects/{project_id}/preview?path={selected.relative_to(root).as_posix()}"

    def stop(self, project_id: str) -> dict[str, Any]:
        process = self._processes.get(project_id)
        if process is None or process.poll() is not None:
            return self.get_project(project_id)
        self._stopping.add(project_id)
        targets = [process.pid, *_process_descendants(process.pid)]
        for pid in targets:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and any(_pid_exists(pid) for pid in targets):
            time.sleep(0.05)
        for pid in targets:
            if not _pid_exists(pid):
                continue
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        meta = self._meta(project_id)
        meta.update({"status": "ready", "stage": "Stopped", "error": None})
        self._save(project_id, meta)
        return self.get_project(project_id)

    def launch_game(self, project_id: str) -> None:
        meta = self._meta(project_id)
        artifact = meta.get("current_artifact")
        if not artifact:
            raise ValueError("no playable version yet")
        godot = self._godot_bin()
        if not godot:
            raise RuntimeError("Godot executable was not found")
        subprocess.Popen([str(godot), "--path", artifact], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class StudioRequestHandler(BaseHTTPRequestHandler):
    manager = StudioManager()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in {"/", "/index.html"}:
            return self._file(STUDIO_DIR / "index.html")
        if parsed.path in {"/styles.css", "/app.js"}:
            return self._file(STUDIO_DIR / parsed.path[1:])
        if parsed.path == "/api/projects":
            return self._json({"projects": self.manager.list_projects()})
        snapshots = re.fullmatch(r"/api/projects/([^/]+)/snapshots", parsed.path)
        if snapshots:
            return self._json({"snapshots": self.manager.list_snapshots(snapshots.group(1))})
        match = re.fullmatch(r"/api/projects/([^/]+)", parsed.path)
        if match:
            return self._json(self.manager.get_project(match.group(1)))
        preview = re.fullmatch(r"/api/projects/([^/]+)/preview", parsed.path)
        if preview:
            return self._preview(preview.group(1), parse_qs(parsed.query).get("path", [""])[0])
        game = re.fullmatch(r"/api/projects/([^/]+)/game/(.+)", parsed.path)
        if game:
            return self._game_file(game.group(1), game.group(2))
        if parsed.path == "/api/health":
            checks = studio_doctor()
            return self._json({
                "status": "ok" if all(
                    checks.get(name, False)
                    for name in (
                        "deepseek-harness-sdk",
                        "DEEPSEEK_API_KEY",
                        "product-assets",
                    )
                ) else "setup_required",
                "checks": checks,
            })
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            payload = self._body()
            if parsed.path == "/api/projects":
                return self._json(self.manager.create_project(
                    title=str(payload.get("title", "")), runtime=str(payload.get("runtime", "deepseek-harness")),
                ), HTTPStatus.CREATED)
            action = re.fullmatch(r"/api/projects/([^/]+)/(messages|runtime|retry|stop|play|snapshots)", parsed.path)
            if action:
                project_id, operation = action.groups()
                if operation == "messages":
                    return self._json(self.manager.send_message(project_id, str(payload.get("content", ""))), HTTPStatus.ACCEPTED)
                if operation == "runtime":
                    return self._json(self.manager.set_runtime(project_id, str(payload.get("runtime", ""))))
                if operation == "retry":
                    return self._json(self.manager.retry(project_id), HTTPStatus.ACCEPTED)
                if operation == "stop":
                    return self._json(self.manager.stop(project_id))
                if operation == "snapshots":
                    return self._json(self.manager.save_snapshot(
                        project_id,
                        kind=str(payload.get("kind", "")),
                        name=str(payload.get("name", "")),
                    ), HTTPStatus.CREATED)
                self.manager.launch_game(project_id)
                return self._json({"ok": True})
            load_snapshot = re.fullmatch(r"/api/projects/([^/]+)/snapshots/([^/]+)/load", parsed.path)
            if load_snapshot:
                return self._json(self.manager.load_snapshot(*load_snapshot.groups()))
        except FileNotFoundError:
            return self._json({"error": "project not found"}, HTTPStatus.NOT_FOUND)
        except (ValueError, RuntimeError) as exc:
            return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        self.send_error(HTTPStatus.NOT_FOUND)

    def _body(self) -> dict[str, Any]:
        size = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(size) or b"{}")

    def _json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _file(self, path: Path, *, headers: dict[str, str] | None = None) -> None:
        if not path.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def _preview(self, project_id: str, relative: str) -> None:
        meta = self.manager._meta(project_id)
        root = Path(str(meta.get("current_artifact", ""))).resolve()
        path = (root / relative).resolve()
        if not root.is_dir() or root not in path.parents or not path.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        self._file(path)

    def _game_file(self, project_id: str, relative: str) -> None:
        meta = self.manager._meta(project_id)
        root_value = meta.get("web_preview_dir")
        if not root_value:
            return self.send_error(HTTPStatus.NOT_FOUND)
        root = Path(str(root_value)).resolve()
        path = (root / relative).resolve()
        if root not in path.parents or not path.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        self._file(path, headers={
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Cache-Control": "no-store",
        })

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        pass


def run_server(host: str = "127.0.0.1", port: int = 8766) -> None:
    server = ThreadingHTTPServer((host, port), StudioRequestHandler)
    print(f"[studio] http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def studio_doctor() -> dict[str, bool]:
    try:
        import deepseek_harness  # noqa: F401

        deepseek_harness = True
    except ImportError:
        deepseek_harness = False
    try:
        runtime_env = StudioManager()._runtime_environment()
    except (OSError, ValueError):
        runtime_env = dict(os.environ)
    return {
        "godot": StudioManager._godot_bin() is not None,
        "deepseek-harness-sdk": deepseek_harness,
        "DEEPSEEK_API_KEY": bool(runtime_env.get("DEEPSEEK_API_KEY")),
        "product-assets": all(
            path.is_file()
            for path in (BASE_CONFIG, INNER_CONFIG, OUTER_CONFIG, SEED_ARTIFACT / "project.godot")
        ),
        "projects-writable": os.access(PROJECTS_ROOT, os.W_OK),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="game-evolver-studio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args(argv)
    run_server(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
