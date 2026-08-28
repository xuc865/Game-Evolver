import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from game_loop.core.agent_circuit import AgentCircuit
from game_loop.core.agent_circuit_compiler import HarnessTransformationCompiler
from game_loop.core.agent_circuit_evolution import CircuitMutationEngine
from game_loop.core.harness_transformation_library import default_transformations
from game_loop.studio_server import ROOT, StudioManager, _generic_rubric, _process_descendants
from game_loop.utils import atomic_write_json


class _DeterministicEvolutionStudio(StudioManager):
    """Exercise the product boundary without claiming synthetic quality evidence."""

    def _capture_preview(self, artifact: Path):
        del artifact
        return None

    def _export_web(self, project: Path, artifact: Path, turn: int):
        del project, artifact, turn
        return {"web_preview_dir": None, "preview_status": "native_only"}

    def _run_command(self, project_id: str, argv: list[str], log_path: Path) -> int:
        del log_path
        run_dir = self._dir(project_id) / "evolution"
        if "agentx-nested-init" in argv:
            run_dir.mkdir(parents=True, exist_ok=True)
            atomic_write_json(run_dir / "nested_evolution.json", {"epochs": []})
            return 0
        epoch = int(argv[argv.index("--epoch") + 1])
        self._write_formal_epoch(run_dir, epoch)
        return 0

    @staticmethod
    def _write_formal_epoch(run_dir: Path, epoch: int) -> None:
        replay_root = run_dir / "replays" / f"epoch_{epoch:03d}"
        outcomes = []
        for side, score in (("parent", 0.50 + epoch * 0.01), ("candidate", 0.51 + epoch * 0.01)):
            replay = replay_root / side
            artifact_id = f"{side}-{epoch:03d}"
            artifact = replay / "artifacts" / artifact_id / "artifact"
            artifact.mkdir(parents=True, exist_ok=True)
            (artifact / "project.godot").write_text(
                f"[application]\nconfig/name=\"Pressure {epoch}\"\n",
                encoding="utf-8",
            )
            (replay / "state.json").write_text(json.dumps({"champion_artifact_id": artifact_id}))
            outcomes.append({
                "final_score": score,
                "infrastructure_ok": True,
                "run_ref": str(replay),
            })

        compiler = HarnessTransformationCompiler()
        studio_seed = default_transformations()[0]
        transaction = compiler.compile(
            studio_seed,
            circuit=AgentCircuit.singleton(),
            evidence_refs=(f"pressure://epoch-{epoch}",),
        )
        circuit = CircuitMutationEngine().apply(AgentCircuit.singleton(), transaction)
        harness_id = f"pressure-goa-{epoch:03d}"
        archive = run_dir / "inner" / "harness_archive"
        (archive / "profiles").mkdir(parents=True, exist_ok=True)
        (archive / "champion.json").write_text(json.dumps({"harness_id": harness_id}))
        (archive / "profiles" / f"{harness_id}.json").write_text(json.dumps({
            "harness_id": harness_id,
            "active_elements": [],
            "agent_circuit": circuit.to_dict(),
        }))

        transformations = list(default_transformations()[: min(epoch, len(default_transformations()))])
        library = run_dir / "harness_transformation_library"
        library.mkdir(parents=True, exist_ok=True)
        (library / "catalog.json").write_text(json.dumps({
            "schema_version": "harness-transformation-library.v1",
            "revision": epoch,
            "items": [item.to_dict() for item in transformations],
        }))
        (library / "stats.json").write_text(json.dumps({
            "items": {
                item.transformation_id: {
                    "uses": epoch,
                    "successes": epoch,
                    "success_rate": 1.0,
                    "mean_net_utility": 0.01,
                }
                for item in transformations
            }
        }))

        nested_path = run_dir / "nested_evolution.json"
        nested = json.loads(nested_path.read_text())
        nested["epochs"].append({
            "inner": {
                "epoch": epoch,
                "accepted": True,
                "parent_outcomes": [outcomes[0]],
                "candidate_outcomes": [outcomes[1]],
            },
            "outer": {"accepted": True},
            "outer_element_library_update": {
                "library_update": {"revision_before": epoch - 1, "revision_after": epoch}
            },
        })
        atomic_write_json(nested_path, nested)


class StudioManagerTests(unittest.TestCase):
    def test_project_view_tolerates_in_progress_nested_state_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Concurrent Publication")
            run_dir = manager._dir(project["id"]) / "evolution"
            run_dir.mkdir()
            (run_dir / "nested_evolution.json").write_text("", encoding="utf-8")

            current = manager.get_project(project["id"])

            self.assertEqual(current["engine"]["library_revision"], 0)
            self.assertEqual(current["evolution_graph"]["hpa_revision"], 0)

    def test_project_view_tolerates_inner_only_interrupted_epoch(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Interrupted Outer Evolution")
            run_dir = manager._dir(project["id"]) / "evolution"
            run_dir.mkdir()
            atomic_write_json(
                run_dir / "nested_evolution.json",
                {
                    "epochs": [{
                        "inner": {"epoch": 1, "accepted": False},
                        "outer": None,
                        "outer_element_library_update": None,
                    }]
                },
            )

            current = manager.get_project(project["id"])

            self.assertEqual(current["engine"]["game"], "Best version retained")
            self.assertEqual(current["engine"]["maker"], "Evidence retained")
            self.assertEqual(current["engine"]["library_revision"], 0)

    def test_ten_request_product_pressure_path_updates_goa_hpa_and_snapshots(self):
        tasks = (
            "Build a tactile rooftop courier game",
            "Add momentum-preserving wall runs",
            "Add a rival courier with readable intent",
            "Create two alternate routes through each district",
            "Add delivery grades and a clean results screen",
            "Add weather that changes traversal decisions",
            "Add an authored night district with moving trains",
            "Improve controller feel and accessibility options",
            "Add a final multi-stage delivery challenge",
            "Polish feedback, transitions, audio cues, and replay flow",
        )
        with tempfile.TemporaryDirectory() as tmp:
            manager = _DeterministicEvolutionStudio(Path(tmp))
            project = manager.create_project(title="Ten Turn Pressure")
            for turn, task in enumerate(tasks, 1):
                manager.send_message(project["id"], task)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    project = manager.get_project(project["id"])
                    if project["status"] != "running":
                        break
                    time.sleep(0.01)
                self.assertEqual(project["status"], "ready", project.get("error"))
                self.assertEqual(project["turn_count"], turn)
                self.assertEqual(project["evolution_graph"]["hpa_revision"], turn)
                self.assertEqual(len(project["evolution_graph"]["goa"]), 5)
                self.assertTrue(project["evolution_graph"]["goa_edges"])
                self.assertIn(
                    "role_behavior_hash", project["evolution_graph"]["goa"][0]
                )
                self.assertIn("harness", project["evolution_graph"]["goa"][0])
                self.assertIn("outputs", project["evolution_graph"]["goa"][0])
                self.assertIn("provider", project["evolution_graph"]["goa"][0])

            self.assertEqual(len(project["turns"]), 10)
            self.assertEqual(len([m for m in project["messages"] if m["role"] == "user"]), 10)
            self.assertGreaterEqual(len(project["evolution_graph"]["hpa"]), 5)
            self.assertAlmostEqual(project["current_score"], 0.61)

            goa = manager.save_snapshot(project["id"], kind="goa", name="Pressure GOA")
            hpa = manager.save_snapshot(project["id"], kind="hpa", name="Pressure HPA")
            self.assertEqual({goa["kind"], hpa["kind"]}, {"goa", "hpa"})
            self.assertEqual(len(manager.list_snapshots(project["id"])), 2)

    def test_process_descendants_crosses_nested_process_groups(self):
        table = """
          10 1
          20 10
          30 20
          40 10
          50 30
          99 1
        """
        self.assertEqual(_process_descendants(10, table), [20, 40, 30, 50])

    def test_project_defaults_to_proven_deepseek_harness_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Moon Garden", runtime="unknown")
            self.assertEqual(project["runtime"], "deepseek-harness")
            config = json.loads((Path(tmp) / project["id"] / "studio-config.json").read_text())
            self.assertIn("studio-deepseek-harness-profile.json", config["backend"]["runtime_profile"])
            self.assertEqual(config["backend"]["command"][-1], "{task_source}")
            self.assertEqual(Path(config["benchmark"]["options"]["root"]), ROOT)
            profile = json.loads(Path(config["backend"]["runtime_profile"]).read_text())
            self.assertEqual(profile["runtime_type"], "deepseek-harness")
            self.assertEqual(Path(profile["cordis"]), (Path(tmp) / project["id"] / "studio-deepseek-harness.cordis.yml").resolve())
            inner = json.loads((Path(tmp) / project["id"] / "studio-inner-harness.json").read_text())
            outer = json.loads((Path(tmp) / project["id"] / "studio-outer-harness.json").read_text())
            audited_plugins = {
                "repeat_tool_reminder",
                "llm_retry",
                "workflow_orchestration",
                "fork_context_subagent",
                "context_efficiency_guards",
            }
            self.assertEqual(set(profile["cordis_plugin_catalog"]), audited_plugins)
            self.assertEqual(
                {
                    item["spec"]["plugin_id"]
                    for item in inner["element_catalog"]
                    if item["category"] == "dsh_plugin"
                },
                audited_plugins - {"fork_context_subagent"},
            )
            self.assertEqual(inner["replay_min_cases"], 1)
            self.assertEqual(outer["rubric_validation_sample_size"], 1)
            self.assertEqual(outer["outer_library_max_actions"], 4)
            self.assertEqual(outer["outer_library_max_additions"], 2)

    def test_dsh_studio_profile_uses_interactive_reasoning_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Fast Garden", runtime="deepseek-harness")
            root = Path(tmp) / project["id"]
            profile = json.loads((root / "studio-deepseek-harness-profile.json").read_text())
            self.assertEqual(profile["max_tokens"], 24576)
            self.assertEqual(profile["timeout_seconds"], 1200)
            self.assertEqual(Path(profile["cordis"]), (root / "studio-deepseek-harness.cordis.yml").resolve())
            self.assertTrue(Path(profile["system_prompt_path"]).name == "deepseek-harness-studio-system.md")
            cordis = Path(profile["cordis"]).read_text()
            self.assertIn("reasoningEffort: low", cordis)
            self.assertNotIn("reasoningEffort: max", cordis)

    def test_task_envelope_accumulates_user_turns(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Ink City")
            root = Path(tmp) / project["id"]
            for turn, text in enumerate(("Make a rooftop racer", "Add a grappling hook"), 1):
                with (root / "messages.jsonl").open("a") as stream:
                    stream.write(json.dumps({"role": "user", "content": text}) + "\n")
                task = manager._write_task(project["id"], turn)
            instruction = (task / "instruction.md").read_text()
            self.assertIn("Make a rooftop racer", instruction)
            self.assertIn("Add a grappling hook", instruction)
            self.assertTrue((task / "tests" / "rubric.json").is_file())

    def test_new_turn_does_not_reuse_score_from_an_older_rubric(self):
        self.assertEqual(StudioManager._turn_seed_score({"current_score": 0.91}), 0.0)

    def test_generic_rubric_is_public_and_game_quality_focused(self):
        rubric = _generic_rubric("Make a tactile puzzle game")
        self.assertEqual(len(rubric["requirements"]), 8)
        self.assertIn("BUILD", rubric["score_formula"])
        self.assertNotIn("hidden", json.dumps(rubric).lower())

    def test_evolution_graph_exposes_hpa_and_goa_without_raw_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Graph Game")
            graph = project["evolution_graph"]
            self.assertEqual(graph["runtime"], "deepseek-harness")
            self.assertTrue(graph["hpa"])
            self.assertTrue(graph["goa"])
            self.assertIn("description", graph["hpa"][0])

    def test_runtime_can_change_only_before_first_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Runtime Game")
            changed = manager.set_runtime(project["id"], "deepseek-harness")
            self.assertEqual(changed["runtime"], "deepseek-harness")
            meta = manager._meta(project["id"])
            meta["turn_count"] = 1
            manager._save(project["id"], meta)
            with self.assertRaises(ValueError):
                manager.set_runtime(project["id"], "opengame")

    def test_formal_result_keeps_highest_scoring_artifact_independent_of_harness_acceptance(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            replays = run_dir / "replays"
            outcomes = []
            for side, score in (("parent", 0.83), ("candidate", 0.77)):
                replay = replays / side
                artifact = replay / "artifacts" / side / "artifact"
                artifact.mkdir(parents=True)
                (artifact / "project.godot").write_text(side)
                (replay / "state.json").write_text(json.dumps({"champion_artifact_id": side}))
                outcomes.append({"final_score": score, "infrastructure_ok": True, "run_ref": str(replay)})
            (run_dir / "nested_evolution.json").write_text(json.dumps({"epochs": [{"inner": {
                "epoch": 2,
                "accepted": True,
                "parent_outcomes": [outcomes[0]],
                "candidate_outcomes": [outcomes[1]],
            }}]}))
            result = StudioManager(run_dir / "projects")._formal_result(run_dir, 2)
            self.assertIsNotNone(result)
            artifact, score, harness_accepted = result
            self.assertEqual((artifact / "project.godot").read_text(), "parent")
            self.assertEqual(score, 0.83)
            self.assertTrue(harness_accepted)

    def test_formal_result_requires_infrastructure_complete_parent_candidate_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            replay = run_dir / "replays" / "candidate"
            artifact = replay / "artifacts" / "candidate" / "artifact"
            artifact.mkdir(parents=True)
            (artifact / "project.godot").write_text("candidate")
            (replay / "state.json").write_text(json.dumps({"champion_artifact_id": "candidate"}))
            (run_dir / "nested_evolution.json").write_text(json.dumps({"epochs": [{"inner": {
                "epoch": 8,
                "accepted": False,
                "parent_outcomes": [{"infrastructure_ok": False}],
                "candidate_outcomes": [{"final_score": 0.8, "infrastructure_ok": True, "run_ref": str(replay)}],
            }}]}))
            self.assertIsNone(StudioManager(run_dir / "projects")._formal_result(run_dir, 8))

    def test_formal_result_tie_follows_the_formally_accepted_harness_side(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            outcomes = []
            for side in ("parent", "candidate"):
                replay = run_dir / "replays" / side
                artifact = replay / "artifacts" / side / "artifact"
                artifact.mkdir(parents=True)
                (artifact / "project.godot").write_text(side)
                (replay / "state.json").write_text(json.dumps({"champion_artifact_id": side}))
                outcomes.append({"final_score": 0.7, "infrastructure_ok": True, "run_ref": str(replay)})
            (run_dir / "nested_evolution.json").write_text(json.dumps({"epochs": [{"inner": {
                "epoch": 3, "accepted": True,
                "parent_outcomes": [outcomes[0]], "candidate_outcomes": [outcomes[1]],
            }}]}))
            artifact, _, _ = StudioManager(run_dir / "projects")._formal_result(run_dir, 3)
            self.assertEqual((artifact / "project.godot").read_text(), "candidate")

    def test_preview_prefers_persisted_studio_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Preview Game")
            artifact = Path(tmp) / project["id"] / "artifact"
            artifact.mkdir()
            (artifact / "sprite.png").write_bytes(b"sprite")
            (artifact / "studio-preview.png").write_bytes(b"preview")
            url = manager._preview_url(project["id"], {"current_artifact": str(artifact)})
            self.assertIn("studio-preview.png", url or "")

    def test_runtime_environment_loads_only_allowlisted_local_values(self):
        environment = StudioManager._runtime_environment()
        self.assertEqual(Path(environment["PYTHON"]).resolve(), Path(__import__("sys").executable).resolve())
        self.assertEqual(Path(environment["PATH"].split(":", 1)[0]), Path(__import__("sys").executable).parent)
        self.assertEqual(environment["CODEX_API_BASE"], "https://api.deepseek.com")
        self.assertEqual(environment["CODEX_MODEL"], "deepseek-v4-flash")
        self.assertEqual(environment["GAME_LOOP_BACKBONE_PROVIDER"], "deepseek")
        self.assertNotIn("CODEX_API_KEY_GPT55", environment)
        if "DEEPSEEK_API_KEY" in environment:
            self.assertTrue(environment.get("OPENAI_API_KEY"))

    def test_runtime_environment_passes_configured_glm_judge_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env.local"
            env_file.write_text(
                "GLM_BASE_URL=http://healthy-judge.test/v1\n"
                "GLM_PRIVATE_TOKEN=must-not-leak\n"
            )
            with patch("game_loop.studio_server.LOCAL_ENV_FILES", (env_file,)):
                with patch.dict("os.environ", {}, clear=True):
                    environment = StudioManager._runtime_environment()
            self.assertEqual(environment["GLM_BASE_URL"], "http://healthy-judge.test/v1")
            self.assertNotIn("GLM_PRIVATE_TOKEN", environment)

    def test_goa_snapshot_round_trip_is_isolated_and_preserves_game(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Snapshot Garden")
            root = Path(tmp) / project["id"]
            goa = root / "evolution" / "inner" / "harness_archive"
            hpa = root / "evolution" / "outer_element_library"
            goa.mkdir(parents=True)
            hpa.mkdir(parents=True)
            (goa / "champion.json").write_text(json.dumps({"harness_id": "goa-before"}))
            (hpa / "catalog.json").write_text(json.dumps({"revision": 3}))
            artifact = root / "artifacts" / "turn-001"
            artifact.mkdir(parents=True)
            (artifact / "project.godot").write_text("playable")
            meta = manager._meta(project["id"])
            meta.update({"turn_count": 1, "current_artifact": str(artifact)})
            manager._save(project["id"], meta)

            snapshot = manager.save_snapshot(project["id"], kind="goa", name="Good builder")
            (goa / "champion.json").write_text(json.dumps({"harness_id": "goa-after"}))
            (hpa / "catalog.json").write_text(json.dumps({"revision": 9}))
            restored = manager.load_snapshot(project["id"], snapshot["id"])

            self.assertEqual(json.loads((goa / "champion.json").read_text())["harness_id"], "goa-before")
            self.assertEqual(json.loads((hpa / "catalog.json").read_text())["revision"], 9)
            self.assertEqual((artifact / "project.godot").read_text(), "playable")
            self.assertEqual(restored["current_artifact"], str(artifact))
            self.assertTrue(any(item["automatic"] for item in restored["snapshots"]))

    def test_hpa_snapshot_restores_library_and_outer_harness_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="HPA Memory")
            root = Path(tmp) / project["id"] / "evolution"
            goa = root / "inner" / "harness_archive"
            outer = root / "outer" / "harness_archive"
            library = root / "outer_element_library"
            for path in (goa, outer, library):
                path.mkdir(parents=True)
            (goa / "champion.json").write_text(json.dumps({"harness_id": "goa-stable"}))
            (outer / "champion.json").write_text(json.dumps({"harness_id": "hpa-before"}))
            (library / "catalog.json").write_text(json.dumps({"revision": 1, "items": []}))
            snapshot = manager.save_snapshot(project["id"], kind="hpa", name="Useful proposer")
            (goa / "champion.json").write_text(json.dumps({"harness_id": "goa-new"}))
            (outer / "champion.json").write_text(json.dumps({"harness_id": "hpa-new"}))
            (library / "catalog.json").write_text(json.dumps({"revision": 2, "items": []}))

            manager.load_snapshot(project["id"], snapshot["id"])
            self.assertEqual(json.loads((goa / "champion.json").read_text())["harness_id"], "goa-new")
            self.assertEqual(json.loads((outer / "champion.json").read_text())["harness_id"], "hpa-before")
            self.assertEqual(json.loads((library / "catalog.json").read_text())["revision"], 1)

    def test_snapshot_integrity_check_rejects_tampered_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Sealed Memory")
            root = Path(tmp) / project["id"]
            archive = root / "evolution" / "inner" / "harness_archive"
            archive.mkdir(parents=True)
            (archive / "champion.json").write_text(json.dumps({"harness_id": "sealed"}))
            snapshot = manager.save_snapshot(project["id"], kind="goa", name="Sealed")
            stored = root / "snapshots" / snapshot["id"] / "state" / "inner__harness_archive" / "champion.json"
            stored.write_text(json.dumps({"harness_id": "tampered"}))
            with self.assertRaisesRegex(ValueError, "integrity"):
                manager.load_snapshot(project["id"], snapshot["id"])

    def test_snapshot_actions_refuse_while_evolution_is_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = StudioManager(Path(tmp))
            project = manager.create_project(title="Busy Memory")
            root = Path(tmp) / project["id"]
            archive = root / "evolution" / "inner" / "harness_archive"
            archive.mkdir(parents=True)
            (archive / "champion.json").write_text("ready")
            snapshot = manager.save_snapshot(project["id"], kind="goa", name="Before work")
            meta = manager._meta(project["id"])
            meta["status"] = "running"
            manager._save(project["id"], meta)
            with self.assertRaises(RuntimeError):
                manager.save_snapshot(project["id"], kind="goa", name="Too soon")
            with self.assertRaises(RuntimeError):
                manager.load_snapshot(project["id"], snapshot["id"])


if __name__ == "__main__":
    unittest.main()
