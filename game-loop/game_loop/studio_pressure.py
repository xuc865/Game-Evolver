from __future__ import annotations

import fcntl
import hashlib
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from game_loop.studio_server import StudioManager
from game_loop.utils import atomic_write_json, read_json

PRESSURE_SCHEMA = "game-evolver-real-studio-pressure.v1"
DEFAULT_TASKS = (
    "Build a tactile rooftop courier game in a flooded neon city. Make traversal directly playable, give the player a delivery objective, and finish with a clear result and replay loop.",
    "Add momentum-preserving wall runs and rooftop vaults. Give each move readable anticipation, impact feedback, and forgiving recovery so the controls feel deliberate rather than brittle.",
    "Add a rival courier with readable intent who competes for the same delivery. Its behavior must change the player's route decisions and remain fair enough to learn through play.",
    "Create two meaningfully different routes through every district: one safer and slower, one risky and fast. Make the tradeoff visible in the world instead of explaining it only with text.",
    "Add delivery grades and a polished results screen that explains time, damage, route risk, and rivalry outcome. Let the player immediately retry or continue from that screen.",
    "Add weather that changes traversal decisions, including wind and rain with visible gameplay consequences. Preserve control readability and avoid purely cosmetic weather.",
    "Add an authored night district built around moving trains, timing windows, and route choices. Integrate it into progression and make arrival there feel like a substantial new stage.",
    "Improve controller feel and accessibility: remapping-friendly actions, reduced-motion and high-contrast options, generous input buffering, and clear in-game control discovery.",
    "Add a final multi-stage delivery challenge that combines traversal, the rival, weather, and trains. It needs escalating phases, recovery rules, and a satisfying success state.",
    "Polish the complete game: strengthen visual hierarchy, transitions, animation timing, audio cues or visible audio-ready feedback, onboarding, and replay flow without removing mechanical depth.",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _read_optional(path: Path, default: Any) -> Any:
    try:
        return read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        return default


def _profile_summary(archive: Path, harness_id: str | None) -> dict[str, Any]:
    if not harness_id:
        return {"harness_id": None, "circuit": None, "circuit_hash": None}
    profile = _read_optional(archive / "profiles" / f"{harness_id}.json", {})
    circuit = profile.get("agent_circuit")
    if circuit is None:
        circuit = {
            "schema_version": "agent-circuit.v1",
            "topology": "singleton",
            "roles": [{"role_id": "maker", "kind": "maker"}],
            "edges": [],
        }
    return {
        "harness_id": harness_id,
        "circuit": circuit,
        "circuit_hash": _json_hash(circuit),
        "role_count": len(circuit.get("roles", [])),
        "edge_count": len(circuit.get("edges", [])),
    }


def collect_turn_evidence(project: Path, turn: int) -> dict[str, Any]:
    run_dir = project / "evolution"
    nested = _read_optional(run_dir / "nested_evolution.json", {"epochs": []})
    matches = [
        item for item in nested.get("epochs", [])
        if item.get("inner", {}).get("epoch") == turn
    ]
    if not matches:
        raise RuntimeError(f"turn {turn} has no formal nested-evolution record")
    epoch = matches[-1]
    inner = epoch.get("inner", {})
    outer = epoch.get("outer", {})
    rubric = inner.get("rubric_validation", {})
    parent_outcomes = [
        item for item in inner.get("parent_outcomes", []) if item.get("infrastructure_ok")
    ]
    candidate_outcomes = [
        item for item in inner.get("candidate_outcomes", []) if item.get("infrastructure_ok")
    ]
    infrastructure_ok = bool(
        rubric.get("infrastructure_ok") is True
        and parent_outcomes
        and candidate_outcomes
    )
    if not infrastructure_ok:
        raise RuntimeError(f"turn {turn} is not infrastructure-complete formal evidence")

    archive = run_dir / "inner" / "harness_archive"
    champion_row = _read_optional(archive / "champion.json", {})
    parent = _profile_summary(archive, inner.get("parent_harness_id"))
    candidate = _profile_summary(archive, inner.get("candidate_harness_id"))
    champion = _profile_summary(archive, champion_row.get("harness_id"))

    outer_validation = outer.get("rubric_validation", {})
    element_update = (
        epoch.get("outer_element_library_update", {}).get("library_update", {})
        or outer_validation.get("library_update", {})
    )
    transformation_update = (
        epoch.get("hpa_transformation_library_update", {})
        or epoch.get("outer_element_library_update", {}).get("transformation_library_update", {})
        or outer_validation.get("transformation_library_update", {})
    )
    element_catalog = _read_optional(run_dir / "outer_element_library" / "catalog.json", {})
    transformation_catalog = _read_optional(
        run_dir / "harness_transformation_library" / "catalog.json", {}
    )
    turn_meta = _read_optional(project / "turns" / f"{turn:03d}" / "turn.json", {})
    artifact = Path(str(turn_meta.get("artifact", "")))
    artifact_ok = artifact.is_dir() and (artifact / "project.godot").is_file()
    if turn_meta.get("status") != "completed" or not artifact_ok:
        raise RuntimeError(f"turn {turn} did not publish a runnable Studio artifact")

    operations = list(element_update.get("operations", []))
    actions = list(transformation_update.get("actions", []))
    changed_operations = [
        item for item in operations if item.get("operation") not in (None, "unchanged")
    ]
    return {
        "turn": turn,
        "completed_at": turn_meta.get("completed_at"),
        "score": turn_meta.get("score"),
        "artifact": str(artifact),
        "artifact_ok": artifact_ok,
        "inner": {
            "decision": "ACCEPT" if inner.get("accepted") else "REJECT",
            "infrastructure_ok": infrastructure_ok,
            "median_delta": inner.get("median_delta"),
            "parent_scores": [item.get("final_score") for item in parent_outcomes],
            "candidate_scores": [item.get("final_score") for item in candidate_outcomes],
            "parent": parent,
            "candidate": candidate,
            "champion": champion,
            "transaction": epoch.get("inner_circuit_transaction"),
            "circuit_utility": epoch.get("circuit_utility") or rubric.get("circuit_utility"),
        },
        "outer": {
            "decision": "ACCEPT" if outer.get("accepted") else "REJECT",
            "element_status": element_update.get("status"),
            "element_revision_before": element_update.get("revision_before"),
            "element_revision_after": element_update.get(
                "revision_after", element_catalog.get("revision")
            ),
            "shortlist": element_update.get("shortlist", []),
            "operations": operations,
            "changed_operations": changed_operations,
            "additions": element_update.get("additions", []),
            "transformation_status": transformation_update.get("status"),
            "transformation_revision_before": transformation_update.get("revision_before"),
            "transformation_revision_after": transformation_update.get(
                "revision_after", transformation_catalog.get("revision")
            ),
            "transformation_shortlist": transformation_update.get("shortlist", []),
            "transformation_actions": actions,
            "no_change_rationale": transformation_update.get("no_change_rationale"),
        },
    }


@dataclass(frozen=True)
class PressureSettings:
    title: str = "Rooftop Relay v0.3 Real Pressure"
    runtime: str = "deepseek-harness"
    timeout_seconds: float = 3600.0
    poll_seconds: float = 5.0
    max_retries_per_turn: int = 2


class RealStudioPressureRunner:
    def __init__(
        self,
        run_root: Path,
        *,
        manager: StudioManager | None = None,
        tasks: Sequence[str] = DEFAULT_TASKS,
        settings: PressureSettings = PressureSettings(),
    ):
        if len(tasks) != 10 or any(not item.strip() for item in tasks):
            raise ValueError("the real pressure run requires exactly ten non-empty tasks")
        self.run_root = run_root.resolve()
        self.run_root.mkdir(parents=True, exist_ok=True)
        self.projects_root = self.run_root / "projects"
        self.manager = manager or StudioManager(self.projects_root)
        self.tasks = tuple(item.strip() for item in tasks)
        self.settings = settings
        self.state_path = self.run_root / "pressure-state.json"
        self.proof_path = self.run_root / "proof.json"
        self.events_path = self.run_root / "events.jsonl"

    @property
    def task_hash(self) -> str:
        return _json_hash(self.tasks)

    def _event(self, event: str, **fields: Any) -> None:
        row = {"at": _now(), "event": event, **fields}
        with self.events_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")

    def _state(self) -> dict[str, Any]:
        if self.state_path.is_file():
            state = read_json(self.state_path)
            if state.get("schema_version") != PRESSURE_SCHEMA:
                raise ValueError("unsupported pressure-run state")
            if state.get("task_hash") != self.task_hash:
                raise ValueError("pressure task list changed after the run started")
            return state
        project = self.manager.create_project(
            title=self.settings.title,
            runtime=self.settings.runtime,
        )
        state = {
            "schema_version": PRESSURE_SCHEMA,
            "created_at": _now(),
            "updated_at": _now(),
            "status": "running",
            "task_hash": self.task_hash,
            "tasks": list(self.tasks),
            "project_id": project["id"],
            "turns": [],
            "snapshots": [],
        }
        atomic_write_json(self.state_path, state)
        self._event("project_created", project_id=project["id"])
        return state

    def _save_state(self, state: dict[str, Any]) -> None:
        state["updated_at"] = _now()
        atomic_write_json(self.state_path, state)

    def recover_turn(self, turn: int) -> dict[str, Any]:
        """Reset only retry bookkeeping for one proven interrupted pressure turn."""

        if not 1 <= turn <= len(self.tasks):
            raise ValueError(f"recovery turn must be within 1..{len(self.tasks)}")
        lock_path = self.run_root / ".pressure.lock"
        with lock_path.open("a+", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError(
                    "cannot recover while this pressure run has an active instance"
                ) from exc
            try:
                state = self._state()
                completed = {
                    int(item.get("turn", 0)) for item in state.get("turns", [])
                }
                expected = set(range(1, turn))
                if completed != expected:
                    raise RuntimeError(
                        f"turn {turn} recovery requires exactly completed turns "
                        f"{sorted(expected)}, found {sorted(completed)}"
                    )
                if int(state.get("active_turn", turn)) != turn:
                    raise RuntimeError(
                        f"pressure state active_turn does not match recovery turn {turn}"
                    )
                project_id = str(state["project_id"])
                project = self.manager.get_project(project_id)
                if project.get("status") != "error":
                    raise RuntimeError(
                        "pressure recovery requires the Studio project to be in error state"
                    )
                user_turns = self._user_turns(project)
                if user_turns.get(turn) != self.tasks[turn - 1]:
                    raise RuntimeError(
                        f"turn {turn} user journal does not match the frozen pressure task"
                    )
                if int(project.get("turn_count", 0)) != turn - 1:
                    raise RuntimeError(
                        f"turn {turn} recovery expected Studio turn_count {turn - 1}, "
                        f"found {project.get('turn_count')}"
                    )

                prior_retries = int(
                    state.get("retry_counts", {}).get(str(turn), 0)
                )
                state.setdefault("retry_counts", {}).pop(str(turn), None)
                state.update(
                    status="running",
                    active_turn=turn,
                    error=None,
                )
                self._save_state(state)
                self._event(
                    "turn_recovery_authorized",
                    turn=turn,
                    cleared_retries=prior_retries,
                    project_status=project.get("status"),
                )
                return state
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _user_turns(project: dict[str, Any]) -> dict[int, str]:
        return {
            int(item.get("turn", 0)): str(item.get("content", ""))
            for item in project.get("messages", [])
            if item.get("role") == "user"
        }

    def _wait_for_turn(self, project_id: str, turn: int, state: dict[str, Any]) -> dict[str, Any]:
        deadline = time.monotonic() + self.settings.timeout_seconds
        retries = int(state.get("retry_counts", {}).get(str(turn), 0))
        while True:
            project = self.manager.get_project(project_id)
            if (
                int(project.get("turn_count", 0)) >= turn
                and project.get("status") == "ready"
            ):
                return project
            if project.get("status") == "error":
                if retries >= self.settings.max_retries_per_turn:
                    raise RuntimeError(
                        f"turn {turn} exhausted {retries} infrastructure retries: "
                        f"{project.get('error')}"
                    )
                retries += 1
                retry_counts = state.setdefault("retry_counts", {})
                retry_counts[str(turn)] = retries
                self._save_state(state)
                self._event(
                    "turn_retry",
                    turn=turn,
                    retry=retries,
                    error=project.get("error"),
                )
                self.manager.retry(project_id)
            if time.monotonic() >= deadline:
                raise TimeoutError(f"turn {turn} exceeded the Studio pressure deadline")
            time.sleep(self.settings.poll_seconds)

    def _ensure_turn(self, state: dict[str, Any], turn: int, task: str) -> dict[str, Any]:
        project_id = str(state["project_id"])
        project = self.manager.get_project(project_id)
        user_turns = self._user_turns(project)
        if turn in user_turns and user_turns[turn] != task:
            raise RuntimeError(f"turn {turn} journal does not match the pressure task")
        if turn not in user_turns:
            if int(project.get("turn_count", 0)) != turn - 1:
                raise RuntimeError(
                    f"cannot submit turn {turn} after completed turn {project.get('turn_count')}"
                )
            state["active_turn"] = turn
            self._save_state(state)
            self._event("turn_submitted", turn=turn, task=task)
            self.manager.send_message(project_id, task)
        project = self._wait_for_turn(project_id, turn, state)
        evidence = collect_turn_evidence(self.manager._dir(project_id), turn)
        existing = {int(item["turn"]): item for item in state.get("turns", [])}
        existing[turn] = {"task": task, **evidence}
        state["turns"] = [existing[index] for index in sorted(existing)]
        state["active_turn"] = None
        self._save_state(state)
        self._event(
            "turn_completed",
            turn=turn,
            score=evidence.get("score"),
            inner_decision=evidence["inner"]["decision"],
            outer_decision=evidence["outer"]["decision"],
        )
        return project

    def _ensure_snapshots(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        project_id = str(state["project_id"])
        snapshots = self.manager.list_snapshots(project_id)
        for kind, name in (("goa", "v0.3 real pressure GOA"), ("hpa", "v0.3 real pressure HPA")):
            matching = [item for item in snapshots if item.get("kind") == kind and item.get("name") == name]
            if not matching:
                self.manager.save_snapshot(project_id, kind=kind, name=name)
                snapshots = self.manager.list_snapshots(project_id)
        selected = [
            item for item in snapshots
            if item.get("name") in {"v0.3 real pressure GOA", "v0.3 real pressure HPA"}
        ]
        state["snapshots"] = selected
        self._save_state(state)
        return selected

    @staticmethod
    def _changed_goa(turn: dict[str, Any]) -> bool:
        inner = turn["inner"]
        transaction = inner.get("transaction")
        return bool(
            transaction
            or inner["candidate"].get("circuit_hash") != inner["parent"].get("circuit_hash")
        )

    @staticmethod
    def _changed_hpa(turn: dict[str, Any]) -> bool:
        outer = turn["outer"]
        return bool(
            outer.get("changed_operations")
            or outer.get("additions")
            or outer.get("transformation_actions")
            or outer.get("element_revision_after") != outer.get("element_revision_before")
            or outer.get("transformation_revision_after") != outer.get("transformation_revision_before")
        )

    def _proof(self, state: dict[str, Any]) -> dict[str, Any]:
        turns = list(state.get("turns", []))
        snapshots = list(state.get("snapshots", []))
        goa_updates = sum(self._changed_goa(item) for item in turns)
        hpa_updates = sum(self._changed_hpa(item) for item in turns)
        scores = [float(item["score"]) for item in turns if item.get("score") is not None]
        assertions = {
            "ten_real_turns_completed": len(turns) == 10,
            "all_infrastructure_ok": len(turns) == 10 and all(
                item["inner"].get("infrastructure_ok") is True for item in turns
            ),
            "all_artifacts_runnable": len(turns) == 10 and all(
                item.get("artifact_ok") is True for item in turns
            ),
            "goa_produced_updates": goa_updates > 0,
            "hpa_produced_updates": hpa_updates > 0,
            "goa_and_hpa_snapshots_saved": {item.get("kind") for item in snapshots} == {"goa", "hpa"},
        }
        return {
            "schema_version": PRESSURE_SCHEMA,
            "created_at": state.get("created_at"),
            "completed_at": _now(),
            "project_id": state.get("project_id"),
            "task_hash": self.task_hash,
            "tasks": list(self.tasks),
            "turns": turns,
            "snapshots": snapshots,
            "summary": {
                "turns_completed": len(turns),
                "goa_update_turns": goa_updates,
                "hpa_update_turns": hpa_updates,
                "scores": scores,
                "score_min": min(scores) if scores else None,
                "score_max": max(scores) if scores else None,
            },
            "assertions": assertions,
            "passed": all(assertions.values()),
        }

    def run(self) -> dict[str, Any]:
        lock_path = self.run_root / ".pressure.lock"
        with lock_path.open("a+", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("this real Studio pressure run already has an active instance") from exc
            state = self._state()
            try:
                for turn, task in enumerate(self.tasks, start=1):
                    if any(int(item.get("turn", 0)) == turn for item in state.get("turns", [])):
                        continue
                    self._ensure_turn(state, turn, task)
                self._ensure_snapshots(state)
                proof = self._proof(state)
                state["status"] = "completed" if proof["passed"] else "completed_with_failed_assertions"
                state["proof"] = str(self.proof_path)
                self._save_state(state)
                atomic_write_json(self.proof_path, proof)
                self._event("pressure_completed", passed=proof["passed"])
                return proof
            except Exception as exc:
                state["status"] = "error"
                state["error"] = f"{type(exc).__name__}: {exc}"
                self._save_state(state)
                self._event("pressure_error", error=state["error"])
                raise
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
