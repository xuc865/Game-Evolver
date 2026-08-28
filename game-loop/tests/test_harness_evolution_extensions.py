from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from game_loop.config import HarnessElementConfig, HarnessEvolutionConfig
from game_loop.core.harness import (
    ContextCompilerPolicy,
    HarnessActiveElement,
    HarnessEpochResult,
    HarnessEvolutionEngine,
    HarnessProfile,
    HarnessSemanticGradient,
    RecoveryPolicy,
    ValidationPolicy,
)
from game_loop.core.harness_element_stats import (
    ElementStat,
    HarnessElementStatsStore,
    compose_merged_element,
    element_similarity,
    inner_harness_score_and_hard_regression,
    mutate_category_elements,
    resolve_target_category,
)
from game_loop.core.harness_evolution_loop import HarnessBenchLoopRunner
from game_loop.core.harness_rubric_generator import generate_dynamic_rubric_set
from game_loop.core.harness_rubric_validator import TaskPoolEntry
from game_loop.core.outer_harness_library import (
    OuterHarnessLibraryAgent,
    OuterHarnessLibraryStore,
    _extract_json_object,
    _normalize_outer_plan,
)
from game_loop.harness_element_catalog import INNER_ELEMENT_CATALOG
from game_loop.utils import atomic_write_json, read_json


def _profile(*, elements: tuple[HarnessActiveElement, ...] = ()) -> HarnessProfile:
    return HarnessProfile(
        harness_id="h-test",
        parent_harness_id=None,
        active_modules=("evidence_first",),
        active_tool_interfaces=(),
        active_elements=elements,
        context_compiler=ContextCompilerPolicy(),
        recovery_policy=RecoveryPolicy(),
        validation_policy=ValidationPolicy(),
        generation=1,
        rationale="test",
        created_at="now",
    )


def _element(element_id: str) -> HarnessActiveElement:
    spec = next(item for item in INNER_ELEMENT_CATALOG if item["id"] == element_id)
    return HarnessActiveElement.from_config(HarnessElementConfig.from_dict(spec))


def _catalog() -> dict[str, HarnessElementConfig]:
    return {
        item.element_id: item
        for item in (
            HarnessElementConfig.from_dict(spec) for spec in INNER_ELEMENT_CATALOG
        )
    }


class DynamicRubricGeneratorTests(unittest.TestCase):
    def test_generates_task_and_harness_specific_rubrics_without_official_leakage(self):
        with tempfile.TemporaryDirectory() as td:
            task = Path(td) / "task"
            task.mkdir()
            (task / "instruction.md").write_text(
                "Build a pygame game with player controls and score UI.",
                encoding="utf-8",
            )
            rubric = generate_dynamic_rubric_set(
                task_ref=task,
                benchmark_id="gcbench",
                harness_profile=_profile(
                    elements=(
                        _element("skill_runtime_smoke"),
                        _element("tool_entrypoint_discover"),
                        _element("wf_plan_patch_verify"),
                    )
                ),
                loop_role="inner",
            )
            self.assertGreaterEqual(len(rubric.hard_rubrics), 3)
            self.assertGreaterEqual(len(rubric.soft_rubrics), 4)
            blob = rubric.to_dict()
            text = str(blob).lower()
            self.assertNotIn("primary_score", text)
            self.assertNotIn("hidden rubric", text)
            self.assertIn("skill", rubric.harness_focus)
            soft_ids = {item.rubric_id for item in rubric.soft_rubrics}
            self.assertEqual(soft_ids, {
                "public_feature_completion",
                "core_gameplay_depth",
                "interaction_correctness",
                "progression_and_end_state",
                "playability_and_balance",
                "runtime_feedback_quality",
                "demo_coverage",
            })
            self.assertAlmostEqual(sum(item.weight for item in rubric.soft_rubrics), 1.0)
            self.assertFalse(any(
                token in rubric_id
                for rubric_id in soft_ids
                for token in ("skill", "tool", "mcp", "context", "workflow")
            ))


class ElementStatsMutationTests(unittest.TestCase):
    def test_bundle_mutation_schedules_leave_one_out_ablation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config = HarnessEvolutionConfig.from_dict(
                {
                    "modules": [{"id": "base", "instruction": "base", "tags": []}],
                    "seed_modules": ["base"],
                    "max_active_modules": 1,
                    "mutation_width": 1,
                    "bundle_width": 3,
                    "attribution_mode": "bundle_then_ablate",
                    "replay_min_cases": 1,
                    "require_rubric_validation": False,
                    "max_active_elements": {"dsh_plugin": 4},
                    "element_catalog": [
                        {
                            "id": f"plugin_{index}",
                            "category": "dsh_plugin",
                            "description": f"plugin {index}",
                            "spec": {"plugin_id": f"plugin_{index}"},
                            "tags": ["dsh_plugin"],
                        }
                        for index in range(4)
                    ],
                    "seed_elements": {"dsh_plugin": ["plugin_0"]},
                }
            )
            engine = HarnessEvolutionEngine(root, config)
            parent = engine.initialize()
            candidate = engine.propose(
                parent_id=parent.harness_id,
                gradient=HarnessSemanticGradient(
                    "add a coherent plugin bundle",
                    ("dsh_plugin", "element_add", "usage_driven"),
                    ("evidence.json",),
                ),
                epoch=1,
            )
            self.assertEqual(len(candidate.active_elements), 4)
            manifest = read_json(
                engine.root
                / "bundle_manifests"
                / f"epoch_001_{candidate.harness_id}.json"
            )
            self.assertEqual(len(manifest["actions"]), 3)

            accepted = replace(
                _epoch_result(),
                parent_harness_id=parent.harness_id,
                candidate_harness_id=candidate.harness_id,
                rubric_validation={"infrastructure_ok": True, "case_results": []},
            )
            engine.record_epoch(accepted)
            pending = read_json(engine.root / "bundle_attribution.json")["pending"]
            self.assertEqual(len(pending), 3)

            ablation = engine.propose(
                parent_id=candidate.harness_id,
                gradient=HarnessSemanticGradient(
                    "normal next mutation", ("tool", "usage_driven"), ()
                ),
                epoch=2,
            )
            self.assertEqual(len(ablation.active_elements), 3)
            ablation_manifest = read_json(
                engine.root
                / "bundle_manifests"
                / f"epoch_002_{ablation.harness_id}.json"
            )
            self.assertEqual(ablation_manifest["mode"], "ablation")

    def test_score_moments_and_hard_regression_survive_reload(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "stats.json"
            stats = HarnessElementStatsStore(root=Path(td))
            stats.touch(category="skill", element_id="x", success=True, score=2.0)
            stats.touch(
                category="skill",
                element_id="x",
                success=False,
                score=4.0,
                hard_regression=True,
            )
            stats.save(path)
            loaded = HarnessElementStatsStore.load(path).items["skill:x"]
            self.assertEqual(loaded.score_count, 2)
            self.assertAlmostEqual(loaded.score_total, 6.0)
            self.assertAlmostEqual(loaded.score_mean, 3.0)
            self.assertAlmostEqual(loaded.score_variance, 1.0)
            self.assertTrue(loaded.hard_regression_ever)
            self.assertEqual(loaded.hard_regression_count, 1)

    def test_old_element_stat_json_is_backward_compatible(self):
        stat = ElementStat.from_dict({
            "element_id": "old",
            "category": "workflow",
            "usage_count": 3,
            "success_count": 2,
        })
        self.assertEqual(stat.score_count, 0)
        self.assertIsNone(stat.score_mean)
        self.assertFalse(stat.hard_regression_ever)

        recovered = ElementStat.from_dict({
            "element_id": "partial-v2",
            "category": "workflow",
            "score_count": 2,
            "score_total": 6.0,
            "score_variance": 1.0,
        })
        self.assertAlmostEqual(recovered.score_variance, 1.0)

    def test_partial_infrastructure_failure_does_not_record_partial_score(self):
        result = replace(
            _epoch_result(),
            rubric_validation={
                "case_results": [
                    {
                        "parent": {"infrastructure_ok": True, "hard": {"runtime": 1}},
                        "candidate": {
                            "infrastructure_ok": True,
                            "hard": {"runtime": 1},
                            "soft_total": 4.0,
                        },
                    },
                    {
                        "parent": {"infrastructure_ok": True, "hard": {"runtime": 1}},
                        "candidate": {
                            "infrastructure_ok": False,
                            "hard": {},
                        },
                    },
                ]
            },
        )
        score, hard_regression = inner_harness_score_and_hard_regression(result)
        self.assertIsNone(score)
        self.assertFalse(hard_regression)

    def test_explicit_category_precedes_usage_control_alias(self):
        self.assertEqual(
            resolve_target_category(("workflow", "usage_driven", "godot")),
            "workflow",
        )

    def test_benchmark_affinity_prevents_web_skill_in_godot_evolution(self):
        stats = HarnessElementStatsStore(root="/tmp")
        selected = stats.addition_target(
            _catalog(),
            [
                _element("skill_runtime_smoke"),
                _element("skill_regression_suite"),
            ],
            "skill",
            preferred_tags=("skill", "usage_driven", "godot"),
        )
        self.assertEqual(selected, "skill_godot_headless_playtest")

    def test_strict_removal_requires_high_usage_share_and_low_accuracy(self):
        stats = HarnessElementStatsStore(root="/tmp")
        for _ in range(3):
            stats.touch(category="skill", element_id="skill_regression_suite", success=False)
        for _ in range(10):
            stats.touch(category="skill", element_id="skill_runtime_smoke", success=True)
        active = [
            _element("skill_regression_suite"),
            _element("skill_runtime_smoke"),
        ]
        self.assertIsNone(stats.removal_target(active, "skill"))

        for _ in range(10):
            stats.touch(category="skill", element_id="skill_regression_suite", success=False)
        removal = stats.removal_target(active, "skill")
        self.assertEqual(removal, "skill_regression_suite")

    def test_merge_combines_similar_active_elements(self):
        catalog = _catalog()
        left = catalog["wf_probe_first"]
        right = catalog["wf_diagnose_then_patch"]
        self.assertGreaterEqual(element_similarity(left, right), 0.55)
        merged = compose_merged_element(left=left, right=right)
        self.assertEqual(merged.category, "workflow")
        self.assertIn("wf_probe_first", merged.spec["merged_from"])

    def test_mutate_can_compose_new_catalog_element(self):
        stats = HarnessElementStatsStore(root="/tmp")
        catalog = _catalog()
        active = [_element("skill_runtime_smoke")]
        result = mutate_category_elements(
            active=active,
            category="skill",
            catalog=catalog,
            stats=stats,
            limits={"skill": 4},
            gradient_tags=("skill", "usage_driven"),
        )
        self.assertIsNotNone(result)
        self.assertIn(result.operation, {"add", "compose", "replace", "derive"})
        if result.operation == "compose":
            self.assertEqual(len(result.catalog_additions), 1)


def _outer_element(
    element_id: str,
    category: str = "workflow",
    *,
    description: str | None = None,
) -> HarnessElementConfig:
    return HarnessElementConfig.from_dict({
        "id": element_id,
        "category": category,
        "description": description or f"shared evidence workflow {element_id}",
        "spec": {"inner_tags": ["evidence_first"], "rule": "probe then verify"},
        "tags": [category, "evidence", "verify"],
    })


def _epoch_result(epoch: int = 1) -> HarnessEpochResult:
    return HarnessEpochResult(
        epoch=epoch,
        parent_harness_id="parent",
        candidate_harness_id="candidate",
        accepted=True,
        paired_deltas=(0.1,),
        median_delta=0.1,
        reasons=(),
        excluded_pairs=(),
        parent_outcomes=(),
        candidate_outcomes=(),
        created_at="now",
        rubric_validation={
            "case_results": [
                {
                    "parent": {"hard": {"runtime": 1}, "soft_total": 2.0},
                    "candidate": {
                        "infrastructure_ok": True,
                        "hard": {"runtime": 1},
                        "soft_total": 3.0,
                    },
                }
            ]
        },
    )


class OuterHarnessLibraryTests(unittest.TestCase):
    def test_root_element_plan_without_evidence_is_not_silently_unchanged(self):
        with self.assertRaisesRegex(ValueError, "root-level element addition"):
            _normalize_outer_plan({
                "id": "adaptive_child",
                "category": "subagent",
                "description": "A child prototype.",
                "spec": {"persona": "Return evidence to the parent."},
                "operations": [],
                "additions": [],
            })

    def test_outer_agent_retries_missing_addition_evidence_before_apply(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("prototype_synthesis", "skill"),))
            plans = [
                {
                    "operations": [],
                    "additions": [{
                        "operation": "add",
                        "capability_boundary_evidence": "epoch 1 rejected fixed teamwork",
                        "supporting_epoch_ids": [],
                        "element": {
                            "id": "adaptive_child",
                            "category": "subagent",
                            "description": "Evidence-derived fork target.",
                            "spec": {"persona": "Resolve the delegated task."},
                            "tags": ["subagent"],
                        },
                    }],
                },
                {
                    "operations": [],
                    "additions": [{
                        "operation": "add",
                        "capability_boundary_evidence": "epoch 1 rejected fixed teamwork",
                        "supporting_epoch_ids": [1],
                        "element": {
                            "id": "adaptive_child",
                            "category": "subagent",
                            "description": "Evidence-derived fork target.",
                            "spec": {"persona": "Resolve the delegated task."},
                            "tags": ["subagent"],
                        },
                    }],
                },
            ]

            def request(stage, _payload):
                if stage == "shortlist":
                    return {
                        "shortlist": ["prototype_synthesis"],
                        "addition_needed": True,
                        "rationale": "fixed team failed",
                    }
                return plans.pop(0)

            failed = replace(
                _epoch_result(),
                accepted=False,
                rubric_validation={"infrastructure_ok": True, "case_results": []},
            )
            update = OuterHarnessLibraryAgent(
                store,
                request,
                max_additions=1,
            ).evolve(
                epoch=2,
                inner_history=[],
                latest_inner_result=failed,
                current_inner_element_ids=("prototype_synthesis",),
            )
            self.assertEqual(update.status, "applied")
            self.assertIn("adaptive_child", store.catalog())
            self.assertEqual(plans, [])

    def test_outer_plan_throughput_counts_symmetric_merge_once(self):
        with tempfile.TemporaryDirectory() as td:
            agent = OuterHarnessLibraryAgent(
                OuterHarnessLibraryStore(Path(td) / "library"),
                lambda *_args: {},
                max_structural_actions=4,
                max_additions=2,
            )
            plan = {
                "operations": [
                    {"element_id": "old", "operation": "delete"},
                    {
                        "element_id": "left",
                        "operation": "merge",
                        "merge_with": "right",
                        "merged_element": {
                            "id": "merged",
                            "category": "workflow",
                            "description": "merged workflow",
                            "spec": {"steps": ["inspect", "verify"]},
                            "tags": ["workflow"],
                        },
                    },
                    {
                        "element_id": "right",
                        "operation": "merge",
                        "merge_with": "left",
                        "merged_element": {
                            "id": "merged",
                            "category": "workflow",
                            "description": "merged workflow",
                            "spec": {"steps": ["inspect", "verify"]},
                            "tags": ["workflow"],
                        },
                    },
                ],
                "additions": [{"operation": "add"}, {"operation": "add"}],
            }
            self.assertEqual(agent._validate_plan_throughput(plan), plan)
            plan["operations"].append(
                {"element_id": "another", "operation": "modify"}
            )
            with self.assertRaisesRegex(ValueError, "structural actions 5"):
                agent._validate_plan_throughput(plan)

    def test_outer_plan_throughput_rejects_empty_merge_partner_before_apply(self):
        with tempfile.TemporaryDirectory() as td:
            agent = OuterHarnessLibraryAgent(
                OuterHarnessLibraryStore(Path(td) / "library"),
                lambda *_args: {},
                max_structural_actions=4,
                max_additions=2,
            )
            with self.assertRaisesRegex(ValueError, "non-empty partner"):
                agent._validate_plan_throughput({
                    "operations": [{
                        "element_id": "protocol_outer_output_validation_gate",
                        "operation": "merge",
                        "merge_with": "",
                        "merged_element": {
                            "id": "merged",
                            "category": "protocol",
                            "description": "merged protocol",
                            "spec": {"rules": ["validate"]},
                            "tags": ["protocol"],
                        },
                    }],
                    "additions": [],
                })

    def test_outer_plan_throughput_rejects_semantically_different_merge(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            left = _outer_element(
                "left",
                description="render sprites and animate characters",
            )
            right = _outer_element(
                "right",
                description="recover database transactions after deadlock",
            )
            store.initialize((left, right))
            merged = {
                "id": "merged",
                "category": "workflow",
                "description": "merged workflow",
                "spec": {"steps": ["inspect", "verify"]},
                "tags": ["workflow"],
            }
            agent = OuterHarnessLibraryAgent(
                store,
                lambda *_args: {},
                max_structural_actions=4,
                max_additions=2,
            )
            with self.assertRaisesRegex(ValueError, "similar same-category"):
                agent._validate_plan_throughput({
                    "operations": [
                        {
                            "element_id": "left",
                            "operation": "merge",
                            "merge_with": "right",
                            "merged_element": merged,
                        },
                        {
                            "element_id": "right",
                            "operation": "merge",
                            "merge_with": "left",
                            "merged_element": merged,
                        },
                    ],
                    "additions": [],
                })

    def test_outer_plan_throughput_rejects_modify_without_correction_hypothesis(self):
        with tempfile.TemporaryDirectory() as td:
            agent = OuterHarnessLibraryAgent(
                OuterHarnessLibraryStore(Path(td) / "library"),
                lambda *_args: {},
                max_structural_actions=4,
                max_additions=2,
            )
            with self.assertRaisesRegex(ValueError, "correction hypothesis"):
                agent._validate_plan_throughput({
                    "operations": [{
                        "element_id": "workflow_targeted_element_addition",
                        "operation": "modify",
                        "replacement": {"id": "workflow_targeted_element_addition"},
                    }],
                    "additions": [],
                })

    def test_outer_plan_throughput_rejects_modify_without_replacement(self):
        with tempfile.TemporaryDirectory() as td:
            agent = OuterHarnessLibraryAgent(
                OuterHarnessLibraryStore(Path(td) / "library"),
                lambda *_args: {},
                max_structural_actions=4,
                max_additions=2,
            )
            with self.assertRaisesRegex(ValueError, "complete replacement"):
                agent._validate_plan_throughput({
                    "operations": [{
                        "element_id": "workflow_targeted_element_addition",
                        "operation": "modify",
                        "correction_hypothesis": "A concrete replacement should improve it.",
                    }],
                    "additions": [],
                })

    def test_extract_json_object_repairs_bare_plan_enum_values(self):
        parsed = _extract_json_object(
            '''```json
            {
              "operations": [
                {"element_id": "workflow", "operation": unchanged},
                {"element_id": "retry", "operation": modify}
              ],
              "additions": [],
              "approved": true
            }
            ```'''
        )
        self.assertEqual(parsed["operations"][0]["operation"], "unchanged")
        self.assertEqual(parsed["operations"][1]["operation"], "modify")
        self.assertIs(parsed["approved"], True)

    def test_extract_json_object_repairs_bare_shortlist_items(self):
        parsed = _extract_json_object(
            "{shortlist: [skill_harness_gap_analysis, ctx_inner_rejection_memory]}"
        )
        self.assertEqual(
            parsed,
            {
                "shortlist": [
                    "skill_harness_gap_analysis",
                    "ctx_inner_rejection_memory",
                ]
            },
        )

    def test_extract_json_object_safely_decodes_python_tuple_with_bare_names(self):
        parsed = _extract_json_object(
            "{'shortlist': (skill_harness_gap_analysis,), 'mode': inspect}"
        )
        self.assertEqual(parsed["shortlist"], ("skill_harness_gap_analysis",))
        self.assertEqual(parsed["mode"], "inspect")

    def test_extract_json_object_normalizes_inert_python_set_to_list(self):
        parsed = _extract_json_object(
            "{'additions': [{'supporting_epoch_ids': {13, 14}}]}"
        )
        self.assertEqual(
            set(parsed["additions"][0]["supporting_epoch_ids"]),
            {13, 14},
        )

    def test_extract_json_object_rejects_executable_python_expression(self):
        with self.assertRaisesRegex(ValueError, "unsupported node"):
            _extract_json_object("{'shortlist': dangerous_call()}")

    def test_extract_json_object_rejects_ellipsis_schema_placeholder(self):
        with self.assertRaisesRegex(TypeError, "not JSON-serializable"):
            _extract_json_object("{'operations': [], 'additions': [...]}")

    def test_configured_backbone_retries_an_ellipsis_schema_placeholder(self):
        fake_agent = mock.Mock()
        fake_agent._call_api.side_effect = [
            {"choices": [{"message": {"content": "{'operations': [], 'additions': [...]}"}}]},
            {"choices": [{"message": {"content": '{"operations": [], "additions": []}'}}]},
        ]
        with mock.patch("game_loop.chat_agent.LocalChatAgent", return_value=fake_agent):
            result = OuterHarnessLibraryAgent._request_with_configured_backbone(
                "plan",
                {"task": "return a plan"},
            )
        self.assertEqual(result, {"operations": [], "additions": []})

    def test_configured_backbone_can_recover_after_repeated_placeholders(self):
        fake_agent = mock.Mock()
        invalid = {"choices": [{"message": {"content": "{'operations': [], 'additions': [...]}"}}]}
        fake_agent._call_api.side_effect = [
            invalid,
            invalid,
            invalid,
            {"choices": [{"message": {"content": '{"operations": [], "additions": []}'}}]},
        ]
        with mock.patch("game_loop.chat_agent.LocalChatAgent", return_value=fake_agent):
            result = OuterHarnessLibraryAgent._request_with_configured_backbone(
                "plan",
                {"task": "return a plan"},
            )
        self.assertEqual(result, {"operations": [], "additions": []})
        self.assertEqual(fake_agent._call_api.call_count, 4)

    def test_configured_backbone_retries_a_non_json_response_once(self):
        fake_agent = mock.Mock()
        fake_agent._call_api.side_effect = [
            {"choices": [{"message": {"content": "I recommend keeping the library."}}]},
            {"choices": [{"message": {"content": '{"shortlist": []}'}}]},
        ]
        with mock.patch("game_loop.chat_agent.LocalChatAgent", return_value=fake_agent):
            result = OuterHarnessLibraryAgent._request_with_configured_backbone(
                "shortlist",
                {"task": "return a shortlist"},
            )
        self.assertEqual(result, {"shortlist": []})
        self.assertEqual(fake_agent._call_api.call_count, 2)
        retry_messages = fake_agent._call_api.call_args_list[1].args[0]
        self.assertIn("could not be parsed", retry_messages[-1]["content"])

    def test_progressive_disclosure_and_sparse_plan_preserve_revision(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("a"), _outer_element("b")))
            calls = []

            def request(stage, payload):
                calls.append((stage, payload))
                if stage == "shortlist":
                    self.assertNotIn("description", str(payload["catalog_index"]))
                    self.assertNotIn("spec", str(payload["catalog_index"]))
                    return {"shortlist": ["a"]}
                self.assertEqual([item["id"] for item in payload["disclosed_elements"]], ["a"])
                return {"operations": [{"element_id": "a", "operation": "unchanged"}]}

            update = OuterHarnessLibraryAgent(store, request).evolve(
                epoch=1,
                inner_history=[],
                latest_inner_result=_epoch_result(),
            )
            self.assertEqual([stage for stage, _ in calls], ["shortlist", "plan"])
            self.assertEqual(update.status, "unchanged")
            self.assertEqual(update.revision_before, update.revision_after)
            self.assertEqual(store.revision(), 0)
            self.assertEqual(
                {item["operation"] for item in update.operations},
                {"unchanged"},
            )

    def test_outer_evolve_retries_unknown_shortlist_ids_once(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("a"), _outer_element("b")))
            calls = []

            def request(stage, payload):
                calls.append((stage, payload))
                if stage == "shortlist" and len(calls) == 1:
                    return {"shortlist": ["ids"]}
                if stage == "shortlist":
                    self.assertIn("validation_error", payload)
                    return {"shortlist": ["a"]}
                return {"operations": []}

            update = OuterHarnessLibraryAgent(store, request).evolve(
                epoch=1,
                inner_history=[],
                latest_inner_result=_epoch_result(),
            )
            self.assertEqual(
                [stage for stage, _ in calls],
                ["shortlist", "shortlist", "plan"],
            )
            self.assertEqual(update.status, "unchanged")

    def test_undisclosed_element_cannot_be_changed(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("a"), _outer_element("b")))
            plan = {
                "operations": [
                    {"element_id": "a", "operation": "unchanged"},
                    {
                        "element_id": "b",
                        "operation": "modify",
                        "correction_hypothesis": "change b",
                        "replacement": {
                            "id": "b",
                            "category": "workflow",
                            "description": "changed",
                            "spec": {"rule": "changed"},
                            "tags": ["workflow"],
                        },
                    },
                ],
                "additions": [],
            }
            with self.assertRaisesRegex(ValueError, "undisclosed element b"):
                store.apply_plan(epoch=1, shortlist=("a",), plan=plan)
            self.assertEqual(store.revision(), 0)

    def test_delete_requires_low_score_even_after_hard_regression(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("high"), _outer_element("low")))
            stats = HarnessElementStatsStore.load(store.stats_path)
            for _ in range(5):
                stats.touch(
                    category="workflow",
                    element_id="high",
                    success=False,
                    score=10.0,
                    hard_regression=True,
                )
                stats.touch(
                    category="workflow",
                    element_id="low",
                    success=False,
                    score=0.0,
                )
            stats.save(store.stats_path)
            plan = {
                "operations": [
                    {
                        "element_id": "high",
                        "operation": "delete",
                        "modification_inadequate_reason": "cannot repair",
                    },
                    {"element_id": "low", "operation": "unchanged"},
                ],
                "additions": [],
            }
            with self.assertRaisesRegex(ValueError, "low-score evidence"):
                store.apply_plan(epoch=1, shortlist=("high",), plan=plan)
            self.assertEqual(store.revision(), 0)

    def test_add_requires_evidence_from_an_actual_failed_epoch(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("current"),))
            added = _outer_element("new_boundary", "protocol")
            plan = {
                "operations": [
                    {"element_id": "current", "operation": "unchanged"}
                ],
                "additions": [
                    {
                        "operation": "add",
                        "capability_boundary_evidence": "epoch 2 exposed a missing boundary",
                        "supporting_epoch_ids": [2],
                        "element": {
                            "id": added.element_id,
                            "category": added.category,
                            "description": added.description,
                            "spec": added.spec,
                            "tags": list(added.tags),
                        },
                    }
                ],
            }
            with self.assertRaisesRegex(ValueError, "supporting failed"):
                store.apply_plan(
                    epoch=3,
                    shortlist=(),
                    plan=plan,
                    failed_history_epochs=(1,),
            )
            self.assertEqual(store.revision(), 0)

    def test_add_can_use_an_infrastructure_valid_imperfect_score_epoch(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("current"),))
            added = _outer_element("soft_gap_protocol", "protocol")
            plan = {
                "operations": [],
                "additions": [
                    {
                        "operation": "add",
                        "capability_boundary_evidence": (
                            "accepted epoch 2 still scored below 1.0 on interaction correctness"
                        ),
                        "supporting_epoch_ids": [2],
                        "element": {
                            "id": added.element_id,
                            "category": added.category,
                            "description": added.description,
                            "spec": added.spec,
                            "tags": list(added.tags),
                        },
                    }
                ],
            }
            update = store.apply_plan(
                epoch=3,
                shortlist=(),
                plan=plan,
                imperfect_score_epochs=(2,),
            )
            self.assertEqual(update.status, "applied")
            self.assertEqual(store.revision(), 1)
            self.assertIn("soft_gap_protocol", store.catalog())

    def test_add_can_use_outer_library_failure_as_boundary_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("current"),))
            added = _outer_element("outer_json_guard", "protocol")
            plan = {
                "operations": [
                    {"element_id": "current", "operation": "unchanged"}
                ],
                "additions": [
                    {
                        "operation": "add",
                        "capability_boundary_evidence": (
                            "outer epoch 2 failed while validating library JSON"
                        ),
                        "supporting_epoch_ids": [2],
                        "element": {
                            "id": added.element_id,
                            "category": added.category,
                            "description": added.description,
                            "spec": added.spec,
                            "tags": list(added.tags),
                        },
                    }
                ],
            }
            update = store.apply_plan(
                epoch=3,
                shortlist=(),
                plan=plan,
                failed_outer_library_epochs=(2,),
                current_inner_element_ids=("current",),
            )
            self.assertEqual(update.status, "applied")
            self.assertEqual(store.revision(), 1)
            self.assertIn("outer_json_guard", store.catalog())

    def test_applies_all_five_operations_atomically(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            elements = (
                _outer_element("merge_a", description="probe evidence and verify runtime"),
                _outer_element("merge_b", description="probe evidence and verify runtime"),
                _outer_element("delete_me", "skill"),
                _outer_element("modify_me", "context"),
                _outer_element("keep_me", "tool"),
            )
            store.initialize(elements)
            stats = HarnessElementStatsStore.load(store.stats_path)
            for _ in range(5):
                stats.touch(
                    category="skill",
                    element_id="delete_me",
                    success=False,
                    score=0.0,
                    hard_regression=True,
                )
            for _ in range(3):
                stats.touch(
                    category="context",
                    element_id="modify_me",
                    success=False,
                    score=0.25,
                    hard_regression=True,
                )
            stats.touch(
                category="workflow",
                element_id="merge_a",
                success=True,
                score=2.0,
            )
            stats.touch(
                category="workflow",
                element_id="merge_b",
                success=False,
                score=4.0,
                hard_regression=True,
            )
            stats.save(store.stats_path)
            merged = _outer_element("merged", description="probe evidence and verify runtime")
            replacement = _outer_element(
                "modify_me", "context", description="improved context selection"
            )
            added = _outer_element("added", "protocol")
            plan = {
                "operations": [
                    {
                        "element_id": "merge_a",
                        "operation": "merge",
                        "merge_with": "merge_b",
                        "merged_element": {
                            "id": merged.element_id,
                            "category": merged.category,
                            "description": merged.description,
                            "spec": merged.spec,
                            "tags": list(merged.tags),
                        },
                    },
                    {
                        "element_id": "merge_b",
                        "operation": "merge",
                        "merge_with": "merge_a",
                        "merged_element": {
                            "id": merged.element_id,
                            "category": merged.category,
                            "description": merged.description,
                            "spec": merged.spec,
                            "tags": list(merged.tags),
                        },
                    },
                    {
                        "element_id": "delete_me",
                        "operation": "delete",
                        "modification_inadequate_reason": "duplicates a harmful boundary",
                    },
                    {
                        "element_id": "modify_me",
                        "operation": "modify",
                        "correction_hypothesis": "narrowing context selection removes stale evidence",
                        "replacement": {
                            "id": replacement.element_id,
                            "category": replacement.category,
                            "description": replacement.description,
                            "spec": replacement.spec,
                            "tags": list(replacement.tags),
                        },
                    },
                    {"element_id": "keep_me", "operation": "unchanged"},
                ],
                "additions": [
                    {
                        "operation": "add",
                        "capability_boundary_evidence": "three failures lack this protocol",
                        "supporting_epoch_ids": [1],
                        "element": {
                            "id": added.element_id,
                            "category": added.category,
                            "description": added.description,
                            "spec": added.spec,
                            "tags": list(added.tags),
                        },
                    }
                ],
            }
            update = store.apply_plan(
                epoch=1,
                shortlist=(
                    "merge_a",
                    "merge_b",
                    "delete_me",
                    "modify_me",
                    "keep_me",
                ),
                plan=plan,
                failed_history_epochs=(1,),
                current_inner_element_ids=("merge_a", "delete_me", "modify_me"),
            )
            store.write_epoch_record(1, {
                "epoch": 1,
                "status": update.status,
                "shortlist": [
                    "merge_a",
                    "merge_b",
                    "delete_me",
                    "modify_me",
                    "keep_me",
                ],
                "plan": plan,
                "update": update.to_dict(),
            })
            self.assertEqual(update.status, "applied")
            self.assertEqual(store.revision(), 1)
            catalog = store.catalog()
            self.assertEqual(set(catalog), {"merged", "modify_me", "keep_me", "added"})
            self.assertEqual(catalog["modify_me"].description, "improved context selection")
            merged_metadata = store.metadata()["merged"]
            self.assertEqual(merged_metadata["usage_count"], 2)
            self.assertEqual(merged_metadata["score_total"], 6.0)
            self.assertAlmostEqual(merged_metadata["score_variance"], 1.0)
            self.assertTrue(merged_metadata["hard_regression_ever"])
            selected_ids = {
                item["id"] for item in store.latest_progressive_selection()
            }
            self.assertEqual(selected_ids, {"merged", "modify_me", "added"})

    def test_shortlisted_unchanged_non_active_element_is_not_activated(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("active"), _outer_element("observed")))
            plan = {
                "operations": [
                    {"element_id": "active", "operation": "unchanged"},
                    {"element_id": "observed", "operation": "unchanged"},
                ],
                "additions": [],
            }
            update = store.apply_plan(
                epoch=1,
                shortlist=("observed",),
                plan=plan,
                current_inner_element_ids=("active",),
            )
            store.write_epoch_record(1, {
                "epoch": 1,
                "status": update.status,
                "shortlist": ["observed"],
                "plan": plan,
                "update": update.to_dict(),
            })
            self.assertEqual(update.next_inner_element_ids, ("active",))
            self.assertEqual(
                [item["id"] for item in store.latest_progressive_selection()],
                ["active"],
            )

    def test_current_selection_generator_is_consumed_once(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("active"), _outer_element("other")))
            plan = {
                "operations": [
                    {"element_id": "active", "operation": "unchanged"},
                    {"element_id": "other", "operation": "unchanged"},
                ],
                "additions": [],
            }
            current = (element_id for element_id in ("active", "active"))
            update = store.apply_plan(
                epoch=1,
                shortlist=(),
                plan=plan,
                current_inner_element_ids=current,
            )
            self.assertEqual(update.next_inner_element_ids, ("active",))

    def test_plan_normalizes_common_llm_schema_aliases(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("current"),))
            plan = {
                "operations": [{"id": "current", "operation": "unchanged"}],
                "additions": [{
                    "operation": "add",
                    "capability_boundary_evidence": "epoch 1 exposed a boundary",
                    "supporting_epoch_ids": ["epoch_001"],
                    "element": {
                        "element_id": "new_boundary",
                        "category": "protocol",
                        "description": "new protocol boundary",
                        "spec": {"rule": "record boundary"},
                        "tags": ["protocol"],
                    },
                }],
            }
            update = store.apply_plan(
                epoch=2,
                shortlist=(),
                plan=plan,
                failed_history_epochs=(1,),
                current_inner_element_ids=("current",),
            )
            self.assertEqual(update.status, "applied")
            self.assertIn("new_boundary", store.catalog())
            self.assertEqual(
                [item["element"]["id"] for item in update.additions],
                ["new_boundary"],
            )

    def test_plan_normalizes_complete_root_addition_payload(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("current"),))
            plan = {
                "element_id": "root_protocol",
                "category": "protocol",
                "description": "Require one validated JSON plan object.",
                "spec": {"output": "single_json_object"},
                "tags": ["protocol", "json"],
                "capability_boundary_evidence": "epoch 2 exposed schema drift",
                "supporting_epoch_ids": [2],
                "operations": [],
                "additions": [],
            }
            update = store.apply_plan(
                epoch=3,
                shortlist=(),
                plan=plan,
                failed_outer_library_epochs=(2,),
            )
            self.assertEqual(update.status, "applied")
            self.assertEqual(store.revision(), 1)
            self.assertIn("root_protocol", store.catalog())

    def test_failed_plan_is_written_before_validation(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("a"),))

            def request(stage, payload):
                if stage == "shortlist":
                    return {"shortlist": ["a"]}
                return {
                    "operations": [{
                        "element_id": "a",
                        "operation": "modify",
                        "correction_hypothesis": "change without evidence",
                        "replacement": {
                            "id": "a",
                            "category": "workflow",
                            "description": "changed",
                            "spec": {"rule": "changed"},
                            "tags": ["workflow"],
                        },
                    }],
                    "additions": [],
                }

            update = OuterHarnessLibraryAgent(store, request).evolve(
                epoch=1,
                inner_history=[],
                latest_inner_result=_epoch_result(),
                current_inner_element_ids=("a",),
            )
            self.assertEqual(update.status, "failed_infrastructure_or_validation")
            record = read_json(store.epochs_dir / "epoch_001.json")
            self.assertEqual(record["plan"]["operations"][0]["operation"], "modify")
            self.assertIn("modify requires at least 3 uses", record["error"])

    def test_duplicate_and_excessive_additions_are_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            existing = _outer_element(
                "existing",
                "protocol",
                description="inspect runtime evidence and verify the result",
            )
            store.initialize((existing,))
            unchanged = [{"element_id": "existing", "operation": "unchanged"}]

            duplicate = _outer_element(
                "duplicate",
                "protocol",
                description="inspect runtime evidence and verify the result",
            )
            duplicate_plan = {
                "operations": unchanged,
                "additions": [{
                    "operation": "add",
                    "capability_boundary_evidence": "failed epoch lacked this protocol",
                    "supporting_epoch_ids": [1],
                    "element": {
                        "id": duplicate.element_id,
                        "category": duplicate.category,
                        "description": duplicate.description,
                        "spec": duplicate.spec,
                        "tags": list(duplicate.tags),
                    },
                }],
            }
            with self.assertRaisesRegex(ValueError, "duplicates an existing capability"):
                store.apply_plan(
                    epoch=2,
                    shortlist=(),
                    plan=duplicate_plan,
                    failed_history_epochs=(1,),
                )

            excessive_plan = {
                "operations": unchanged,
                "additions": [
                    {
                        "operation": "add",
                        "capability_boundary_evidence": f"boundary {index}",
                        "supporting_epoch_ids": [1],
                        "element": {
                            "id": f"new_{index}",
                            "category": "protocol",
                            "description": f"distinct protocol boundary {index}",
                            "spec": {"rule": f"distinct_{index}"},
                            "tags": [f"boundary_{index}"],
                        },
                    }
                    for index in range(3)
                ],
            }
            with self.assertRaisesRegex(ValueError, "at most 2"):
                store.apply_plan(
                    epoch=2,
                    shortlist=(),
                    plan=excessive_plan,
                    failed_history_epochs=(1,),
                )

    def test_exact_existing_addition_is_an_idempotent_noop(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            existing = _outer_element("existing", "protocol")
            store.initialize((existing,))
            plan = {
                "operations": [
                    {"element_id": "existing", "operation": "unchanged"}
                ],
                "additions": [{
                    "operation": "add",
                    "capability_boundary_evidence": "epoch 1 repeated the boundary",
                    "supporting_epoch_ids": [1],
                    "element": {
                        "id": existing.element_id,
                        "category": existing.category,
                        "description": existing.description,
                        "spec": existing.spec,
                        "tags": list(existing.tags),
                    },
                }],
            }

            update = store.apply_plan(
                epoch=2,
                shortlist=(),
                plan=plan,
                failed_history_epochs=(1,),
                current_inner_element_ids=("existing",),
            )

            self.assertEqual(update.status, "unchanged")
            self.assertEqual(update.revision_after, 0)
            self.assertEqual(update.additions, ())
            self.assertEqual(update.next_inner_element_ids, ("existing",))

    def test_exact_dormant_addition_activates_existing_catalog_element(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            active = _outer_element("active", "context")
            dormant = _outer_element("dormant", "protocol")
            store.initialize((active, dormant))
            plan = {
                "operations": [],
                "additions": [{
                    "operation": "add",
                    "capability_boundary_evidence": "epoch 1 needs the dormant protocol",
                    "supporting_epoch_ids": [1],
                    "element": {
                        "id": dormant.element_id,
                        "category": dormant.category,
                        "description": dormant.description,
                        "spec": dormant.spec,
                        "tags": list(dormant.tags),
                    },
                }],
            }
            update = store.apply_plan(
                epoch=2,
                shortlist=(),
                plan=plan,
                imperfect_score_epochs=(1,),
                current_inner_element_ids=("active",),
            )
            self.assertEqual(update.status, "applied")
            self.assertEqual(update.revision_after, 1)
            self.assertEqual(
                update.next_inner_element_ids,
                ("active", "dormant"),
            )
            self.assertTrue(update.additions[0]["activation_only"])
            self.assertEqual(set(store.catalog()), {"active", "dormant"})

    def test_applied_update_surfaces_final_audit_record_failure(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("current"),))
            added = _outer_element("boundary", "protocol")

            def request(stage, payload):
                if stage == "shortlist":
                    return {"shortlist": []}
                return {
                    "operations": [
                        {"element_id": "current", "operation": "unchanged"}
                    ],
                    "additions": [{
                        "operation": "add",
                        "capability_boundary_evidence": "epoch 1 exposed a boundary",
                        "supporting_epoch_ids": [1],
                        "element": {
                            "id": added.element_id,
                            "category": added.category,
                            "description": added.description,
                            "spec": added.spec,
                            "tags": list(added.tags),
                        },
                    }],
                }

            agent = OuterHarnessLibraryAgent(store, request)
            real_write = store.write_epoch_record
            write_count = 0

            def fail_final_write(epoch, payload):
                nonlocal write_count
                write_count += 1
                if write_count == 4:
                    raise OSError("simulated final audit failure")
                return real_write(epoch, payload)

            with mock.patch.object(store, "write_epoch_record", fail_final_write):
                update = agent.evolve(
                    epoch=2,
                    inner_history=[{
                        "epoch": 1,
                        "accepted": False,
                        "rubric_validation": {"infrastructure_ok": True},
                    }],
                    latest_inner_result=_epoch_result(2),
                    current_inner_element_ids=("current",),
                )
            self.assertTrue(update.applied)
            self.assertEqual((update.revision_before, update.revision_after), (0, 1))
            self.assertIn("audit_record_error", update.error)
            self.assertEqual(store.revision(), 1)
            self.assertIn("boundary", store.catalog())

    def test_inner_epoch_attribution_is_scored_and_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("used"), _outer_element("unused")))
            result = _epoch_result()
            first = store.record_inner_epoch(element_ids=("used",), result=result)
            second = store.record_inner_epoch(element_ids=("used",), result=result)
            self.assertEqual(first, second)
            (store.usage_dir / "inner_epoch_001.json").unlink()
            store.record_inner_epoch(element_ids=("used",), result=result)
            metadata = store.metadata()
            self.assertEqual(metadata["used"]["usage_count"], 1)
            self.assertEqual(metadata["used"]["score_total"], 3.0)
            self.assertEqual(metadata["used"]["attributed_inner_epochs"], [1])
            self.assertEqual(metadata["unused"]["usage_count"], 0)
            with self.assertRaisesRegex(ValueError, "conflicting"):
                store.record_inner_epoch(element_ids=("unused",), result=result)

    def test_inner_epoch_attribution_replaces_unscored_retry_record(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("used"),))
            successful = _epoch_result()
            failed = replace(
                successful,
                accepted=False,
                rubric_validation={
                    "infrastructure_ok": False,
                    "case_results": [],
                },
            )
            first = store.record_inner_epoch(element_ids=("used",), result=failed)
            self.assertFalse(first["recorded_in_metadata"])

            recovered = store.record_inner_epoch(
                element_ids=("used",), result=successful
            )

            self.assertTrue(recovered["recorded_in_metadata"])
            self.assertTrue(recovered["accepted"])
            self.assertEqual(store.metadata()["used"]["usage_count"], 1)
            self.assertEqual(
                len(list((store.usage_dir / "conflicts").glob("*.json"))), 1
            )

    def test_inner_epoch_attribution_replaces_scored_same_epoch_retry(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("used"),))
            first = _epoch_result()
            store.record_inner_epoch(element_ids=("used",), result=first)
            retried = replace(
                first,
                candidate_harness_id="candidate-retry",
                accepted=False,
                rubric_validation={
                    "case_results": [{
                        "parent": {"hard": {"runtime": 1}, "soft_total": 2.0},
                        "candidate": {
                            "infrastructure_ok": True,
                            "hard": {"runtime": 1},
                            "soft_total": 1.5,
                        },
                    }],
                },
            )

            record = store.record_inner_epoch(element_ids=("used",), result=retried)

            stat = store.metadata()["used"]
            self.assertEqual(record["candidate_harness_id"], "candidate-retry")
            self.assertEqual(stat["usage_count"], 1)
            self.assertEqual(stat["success_count"], 0)
            self.assertEqual(stat["score_count"], 1)
            self.assertEqual(stat["score_total"], 1.5)
            self.assertEqual(stat["attributed_inner_epochs"], [1])

    def test_catalog_and_stats_rollback_when_second_commit_write_fails(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize((_outer_element("current"),))
            before_catalog = store.catalog()
            before_stats = store.metadata()
            added = _outer_element("boundary", "protocol")
            plan = {
                "operations": [
                    {"element_id": "current", "operation": "unchanged"}
                ],
                "additions": [
                    {
                        "operation": "add",
                        "capability_boundary_evidence": "failed epoch lacks protocol",
                        "supporting_epoch_ids": [1],
                        "element": {
                            "id": added.element_id,
                            "category": added.category,
                            "description": added.description,
                            "spec": added.spec,
                            "tags": list(added.tags),
                        },
                    }
                ],
            }
            from game_loop.core import outer_harness_library as library_module

            real_write = library_module.atomic_write_json
            failed_once = False

            def flaky_write(path, payload):
                nonlocal failed_once
                if (
                    Path(path) == store.catalog_path
                    and isinstance(payload, dict)
                    and payload.get("revision") == 1
                    and not failed_once
                ):
                    failed_once = True
                    raise OSError("simulated catalog commit failure")
                return real_write(path, payload)

            with mock.patch.object(  # noqa: SIM117 - retain Python 3.9 syntax.
                library_module, "atomic_write_json", flaky_write
            ):
                with self.assertRaisesRegex(OSError, "simulated catalog"):
                    store.apply_plan(
                        epoch=2,
                        shortlist=(),
                        plan=plan,
                        failed_history_epochs=(1,),
                    )
            self.assertEqual(store.revision(), 0)
            self.assertEqual(store.catalog(), before_catalog)
            self.assertEqual(store.metadata(), before_stats)
            self.assertFalse(store.transaction_path.exists())

    def test_pending_catalog_transaction_rolls_back_on_restart(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "library"
            store = OuterHarnessLibraryStore(root)
            seed = _outer_element("current")
            store.initialize((seed,))
            before_catalog = read_json(store.catalog_path)
            before_stats = read_json(store.stats_path)
            atomic_write_json(store.transaction_path, {
                "schema_version": "outer-library-transaction.v1",
                "before_catalog": before_catalog,
                "before_stats": before_stats,
            })
            corrupted_catalog = dict(before_catalog)
            corrupted_catalog["revision"] = 99
            corrupted_catalog["items"] = []
            atomic_write_json(store.catalog_path, corrupted_catalog)
            atomic_write_json(store.stats_path, {
                "schema_version": "harness-element-stats.v2",
                "items": {},
            })

            restarted = OuterHarnessLibraryStore(root)
            restarted.initialize((seed,))
            self.assertEqual(read_json(restarted.catalog_path), before_catalog)
            recovered_stats = read_json(restarted.stats_path)
            self.assertEqual(
                recovered_stats["items"], before_stats["items"]
            )
            self.assertFalse(restarted.transaction_path.exists())

    def test_progressive_shortlist_cannot_expand_to_entire_library(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            store.initialize(tuple(_outer_element(f"e{i}") for i in range(6)))

            def request(stage, payload):
                self.assertEqual(stage, "shortlist")
                self.assertEqual(payload["shortlist_limit"], 2)
                return {"shortlist": [item["id"] for item in payload["catalog_index"]]}

            update = OuterHarnessLibraryAgent(store, request).evolve(
                epoch=1,
                inner_history=[],
                latest_inner_result=_epoch_result(),
            )
            self.assertEqual(update.status, "failed_infrastructure_or_validation")
            self.assertIn("progressive disclosure limit", update.error)
            self.assertEqual(store.revision(), 0)

    def test_merge_rejects_structural_but_semantically_different_elements(self):
        with tempfile.TemporaryDirectory() as td:
            store = OuterHarnessLibraryStore(Path(td) / "library")
            left = HarnessElementConfig.from_dict({
                "id": "left",
                "category": "workflow",
                "description": "render sprites and animate characters",
                "spec": {"mode": "visual_animation"},
                "tags": ["workflow", "shared"],
            })
            right = HarnessElementConfig.from_dict({
                "id": "right",
                "category": "workflow",
                "description": "recover database transactions after deadlock",
                "spec": {"mode": "database_recovery"},
                "tags": ["workflow", "shared"],
            })
            store.initialize((left, right))
            merged_payload = {
                "id": "merged",
                "category": "workflow",
                "description": "merged",
                "spec": {"mode": "merged"},
                "tags": ["workflow"],
            }
            plan = {
                "operations": [
                    {
                        "element_id": "left",
                        "operation": "merge",
                        "merge_with": "right",
                        "merged_element": merged_payload,
                    },
                    {
                        "element_id": "right",
                        "operation": "merge",
                        "merge_with": "left",
                        "merged_element": merged_payload,
                    },
                ],
                "additions": [],
            }
            with self.assertRaisesRegex(ValueError, "similar same-category"):
                store.apply_plan(
                    epoch=1,
                    shortlist=("left", "right"),
                    plan=plan,
                )
            self.assertEqual(store.revision(), 0)


class BenchLoopRunnerTests(unittest.TestCase):
    def test_runner_state_advances_task_index(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            pool = (
                TaskPoolEntry(str(root / "t1"), str(root / "s1")),
                TaskPoolEntry(str(root / "t2"), str(root / "s2")),
            )
            cfg = HarnessEvolutionConfig.from_dict({
                "modules": [{"id": "a", "instruction": "a", "tags": [], "category": "workflow"}],
                "seed_modules": ["a"],
                "max_active_modules": 1,
                "max_active_tool_interfaces": 0,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
            })
            from game_loop.core.harness import HarnessEvolutionEngine

            engine = HarnessEvolutionEngine(root / "harness", cfg)
            engine.initialize()
            runner = HarnessBenchLoopRunner(
                loop_dir=root / "loop",
                config=__import__("unittest.mock").mock.Mock(),
                task_pool=pool,
                harness_engine=engine,
                init_handler=lambda *_args, **_kwargs: 0,
                evolve_handler=lambda *_args, **_kwargs: 0,
                bench="gcbench",
            )
            runner.config = __import__("unittest.mock").mock.Mock()
            runner.initialize()
            state = runner.load_state()
            self.assertEqual(state.task_index, 0)


class CircuitHarnessRenderingTests(unittest.TestCase):
    def test_circuit_profile_does_not_leak_global_components_into_every_role(self):
        from dataclasses import replace

        from game_loop.core.agent_circuit import AgentCircuit
        from game_loop.core.harness import HarnessEvolutionEngine

        with tempfile.TemporaryDirectory() as td:
            cfg = HarnessEvolutionConfig.from_dict({
                "modules": [{
                    "id": "private_workflow",
                    "instruction": "PRIVATE MODULE INSTRUCTION",
                    "tags": [],
                    "category": "workflow",
                }],
                "seed_modules": ["private_workflow"],
                "max_active_modules": 1,
                "max_active_tool_interfaces": 0,
                "mutation_width": 1,
                "replay_min_cases": 1,
                "require_rubric_validation": False,
            })
            engine = HarnessEvolutionEngine(Path(td), cfg)
            profile = engine.initialize()
            circuit_profile = replace(
                profile,
                agent_circuit=AgentCircuit.singleton(),
            )

            rendered = engine.render(circuit_profile)

            self.assertIn("Agent Circuit harness profile", rendered)
            self.assertNotIn("PRIVATE MODULE INSTRUCTION", rendered)
            self.assertIn("role-local harness manifest", rendered)


if __name__ == "__main__":
    unittest.main()
