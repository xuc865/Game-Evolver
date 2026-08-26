from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from game_loop.studio_pressure import (
    DEFAULT_TASKS,
    PressureSettings,
    RealStudioPressureRunner,
    collect_turn_evidence,
)
from game_loop.utils import atomic_write_json


class _ImmediateStudio:
    def __init__(self, root: Path):
        self.root = root
        self.project_id = "real-pressure-test-1234"
        self.project = self.root / self.project_id
        self.messages: list[dict[str, object]] = []
        self.turn_count = 0
        self.snapshots: list[dict[str, object]] = []
        self.status = "ready"
        self.error: str | None = None

    def _dir(self, project_id: str) -> Path:
        assert project_id == self.project_id
        return self.project

    def create_project(self, *, title: str, runtime: str):
        del title, runtime
        self.project.mkdir(parents=True)
        return self.get_project(self.project_id)

    def get_project(self, project_id: str):
        self._dir(project_id)
        return {
            "id": project_id,
            "status": self.status,
            "turn_count": self.turn_count,
            "messages": list(self.messages),
            "error": self.error,
        }

    def send_message(self, project_id: str, content: str):
        self._dir(project_id)
        turn = self.turn_count + 1
        self.messages.append({"role": "user", "turn": turn, "content": content})
        self._publish_turn(turn)
        self.turn_count = turn
        return self.get_project(project_id)

    def retry(self, project_id: str):
        raise AssertionError(f"unexpected retry for {project_id}")

    def list_snapshots(self, project_id: str):
        self._dir(project_id)
        return list(self.snapshots)

    def save_snapshot(self, project_id: str, *, kind: str, name: str):
        self._dir(project_id)
        row = {"id": f"{kind}-snapshot-test", "kind": kind, "name": name}
        self.snapshots.append(row)
        return row

    def _publish_turn(self, turn: int) -> None:
        evolution = self.project / "evolution"
        archive = evolution / "inner" / "harness_archive"
        (archive / "profiles").mkdir(parents=True, exist_ok=True)
        parent_id = f"parent-{turn}"
        candidate_id = f"candidate-{turn}"
        candidate_circuit = {
            "schema_version": "agent-circuit.v1",
            "roles": [
                {"role_id": "maker", "kind": "maker"},
                {"role_id": f"critic-{turn}", "kind": "critic"},
            ],
            "edges": [{"source": "maker", "target": f"critic-{turn}"}],
        }
        atomic_write_json(archive / "champion.json", {"harness_id": candidate_id})
        atomic_write_json(archive / "profiles" / f"{parent_id}.json", {"harness_id": parent_id})
        atomic_write_json(
            archive / "profiles" / f"{candidate_id}.json",
            {"harness_id": candidate_id, "agent_circuit": candidate_circuit},
        )
        catalog = evolution / "outer_element_library" / "catalog.json"
        catalog.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(catalog, {"revision": turn, "items": []})
        transformation = evolution / "harness_transformation_library" / "catalog.json"
        transformation.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(transformation, {"revision": turn, "items": []})
        nested_path = evolution / "nested_evolution.json"
        nested = json.loads(nested_path.read_text()) if nested_path.is_file() else {"epochs": []}
        nested["epochs"].append({
            "inner": {
                "epoch": turn,
                "parent_harness_id": parent_id,
                "candidate_harness_id": candidate_id,
                "accepted": True,
                "median_delta": 0.1,
                "parent_outcomes": [{"infrastructure_ok": True, "final_score": 0.5}],
                "candidate_outcomes": [{"infrastructure_ok": True, "final_score": 0.6}],
                "rubric_validation": {"infrastructure_ok": True},
            },
            "outer": {"accepted": True},
            "inner_circuit_transaction": {"operations": [{"operation": "split_role"}]},
            "outer_element_library_update": {"library_update": {
                "status": "applied",
                "revision_before": turn - 1,
                "revision_after": turn,
                "operations": [{"operation": "modify", "element_id": "workflow"}],
                "additions": [],
            }},
        })
        atomic_write_json(nested_path, nested)
        artifact = self.project / "artifacts" / f"turn-{turn:03d}"
        artifact.mkdir(parents=True)
        (artifact / "project.godot").write_text("[application]\n", encoding="utf-8")
        turn_dir = self.project / "turns" / f"{turn:03d}"
        turn_dir.mkdir(parents=True)
        atomic_write_json(turn_dir / "turn.json", {
            "turn": turn,
            "status": "completed",
            "completed_at": f"turn-{turn}",
            "score": 0.5 + turn / 100,
            "artifact": str(artifact),
        })


class StudioPressureTests(unittest.TestCase):
    def test_recover_turn_clears_only_validated_interrupted_retry_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manager = _ImmediateStudio(root / "projects")
            runner = RealStudioPressureRunner(root, manager=manager)
            state = runner._state()
            manager.turn_count = 3
            manager.messages = [
                {"role": "user", "turn": turn, "content": DEFAULT_TASKS[turn - 1]}
                for turn in range(1, 5)
            ]
            manager.status = "error"
            manager.error = "no infrastructure-complete result was produced"
            state.update(
                status="error",
                active_turn=4,
                turns=[{"turn": turn} for turn in range(1, 4)],
                retry_counts={"3": 1, "4": 2},
                error="turn 4 exhausted retries",
            )
            runner._save_state(state)

            recovered = runner.recover_turn(4)

            self.assertEqual(recovered["status"], "running")
            self.assertEqual(recovered["active_turn"], 4)
            self.assertIsNone(recovered["error"])
            self.assertEqual(recovered["retry_counts"], {"3": 1})
            event = json.loads(runner.events_path.read_text().splitlines()[-1])
            self.assertEqual(event["event"], "turn_recovery_authorized")
            self.assertEqual(event["cleared_retries"], 2)

    def test_collect_turn_evidence_requires_formal_runnable_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = _ImmediateStudio(Path(tmp))
            manager.create_project(title="test", runtime="deepseek-harness")
            manager.send_message(manager.project_id, "task")
            evidence = collect_turn_evidence(manager.project, 1)
            self.assertTrue(evidence["inner"]["infrastructure_ok"])
            self.assertTrue(evidence["artifact_ok"])
            self.assertEqual(evidence["inner"]["candidate"]["role_count"], 2)

    def test_ten_turn_runner_is_resumable_and_saves_both_snapshots(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manager = _ImmediateStudio(root / "projects")
            runner = RealStudioPressureRunner(
                root,
                manager=manager,
                settings=PressureSettings(timeout_seconds=1, poll_seconds=0),
            )
            proof = runner.run()
            self.assertTrue(proof["passed"])
            self.assertEqual(proof["summary"]["turns_completed"], 10)
            self.assertEqual({item["kind"] for item in proof["snapshots"]}, {"goa", "hpa"})
            self.assertEqual(len(DEFAULT_TASKS), 10)

            resumed = RealStudioPressureRunner(
                root,
                manager=manager,
                settings=PressureSettings(timeout_seconds=1, poll_seconds=0),
            ).run()
            self.assertTrue(resumed["passed"])
            self.assertEqual(manager.turn_count, 10)


if __name__ == "__main__":
    unittest.main()
