from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, replace
from pathlib import Path

from game_loop.config import AppConfig
from game_loop.core.agent_circuit import validate_workspace_lineage
from game_loop.core.agent_circuit_attribution import CircuitAblationQueue
from game_loop.core.agent_circuit_compiler import (
    HarnessTransformationCompiler,
    TransformationNotApplicable,
)
from game_loop.core.agent_circuit_evolution import (
    CircuitMutationAction,
    CircuitMutationEngine,
    CircuitMutationTransaction,
)
from game_loop.core.agentx import (
    AgentXNestedEvolution,
    PairedOutcomes,
)
from game_loop.core.attribution import AttributionReport
from game_loop.core.episode_runner import run_frozen_harness_episode
from game_loop.core.harness import (
    HarnessEpochResult,
    HarnessEvolutionConfig,
    HarnessEvolutionEngine,
    HarnessProfile,
    HarnessReplayCase,
    HarnessSemanticGradient,
)
from game_loop.core.harness_evolution_memory import HarnessEvolutionMemory
from game_loop.core.harness_rubric_validator import (
    HarnessRubricValidator,
    HeuristicRubricJudge,
    TaskPoolEntry,
    sample_task_pool,
)
from game_loop.core.harness_transformation_agent import (
    HarnessTransformationLibraryAgent,
)
from game_loop.core.harness_transformation_library import (
    HarnessTransformationLibraryStore,
)
from game_loop.core.outer_harness_library import (
    OuterHarnessLibraryAgent,
    OuterHarnessLibraryStore,
)
from game_loop.runtime.deepseek_circuit import deepseek_role_runtime_contract


@dataclass(frozen=True)
class AgentXRuntimeConfig:
    inner_harness: HarnessEvolutionConfig
    outer_harness: HarnessEvolutionConfig
    app_config: AppConfig
    task_source: Path
    seed_artifact: Path
    seed_score: float = 0.0
    run_id_prefix: str = "ax"
    task_pool: tuple[TaskPoolEntry, ...] = ()


class AttributionDrivenInnerGradientProposer:
    """Propose inner-harness gradients from attribution evidence."""

    _MODULE_TAGS = (
        "evidence_first",
        "gameplay_observability",
        "mechanic_depth",
        "regression_first",
        "engine_tooling_first",
        "minimal_coherent_patch",
    )
    _ELEMENT_CATEGORIES = (
        "dsh_plugin",
        "skill",
        "mcp",
        "tool",
        "context",
        "protocol",
        "workflow",
    )

    def __init__(
        self,
        memory: HarnessEvolutionMemory | None = None,
        outer_library_store: OuterHarnessLibraryStore | None = None,
        *,
        dsh_plugin_evolution: bool = False,
        dsh_plugin_target_count: int = 2,
    ):
        if dsh_plugin_target_count < 1:
            raise ValueError("dsh_plugin_target_count must be positive")
        self.memory = memory
        self.outer_library_store = outer_library_store
        self.dsh_plugin_evolution = dsh_plugin_evolution
        self.dsh_plugin_target_count = dsh_plugin_target_count

    def propose_inner(
        self,
        report: AttributionReport,
        *,
        proposer_harness: HarnessProfile,
        target_harness: HarnessProfile,
    ) -> HarnessSemanticGradient:
        memory_hint = ""
        if self.memory is not None:
            memory_hint = self.memory.render_proposer_context(loop_role="inner")
        outer_tags: list[str] = []
        outer_notes: list[str] = []
        if self.outer_library_store is not None:
            try:
                elements = self.outer_library_store.details_for_inner_proposal(
                    proposer_harness
                )
            except Exception:  # noqa: BLE001 - fall back to the frozen profile.
                elements = []
        else:
            elements = []
        if not elements:
            elements = [
                {
                    "id": element.element_id,
                    "category": element.category,
                    "spec": element.spec,
                }
                for element in proposer_harness.active_elements
            ]
        for element in elements:
            outer_notes.append(f"{element['category']}:{element['id']}")
            raw_tags = dict(element.get("spec", {})).get("inner_tags", ())
            if isinstance(raw_tags, list):
                outer_tags.extend(str(tag) for tag in raw_tags)
        counts = dict(report.outcome_counts)
        if counts.get("probe_failed", 0) >= 2:
            diagnosis = (
                "probe failures indicate missing runtime evidence before patching"
            )
            tags = ("skill", "tool", "evidence_first", "usage_driven")
        elif counts.get("infrastructure_failure", 0) >= 1:
            diagnosis = (
                "infrastructure failures require tighter validation and recovery"
            )
            tags = ("protocol", "workflow", "regression_first", "usage_driven")
        elif report.repeated_failures:
            diagnosis = (
                "repeated failure families require an alternative mechanic strategy"
            )
            tags = ("workflow", "skill", "mechanic_depth", "usage_driven")
        else:
            category = self._ELEMENT_CATEGORIES[
                len(report.run_refs) % len(self._ELEMENT_CATEGORIES)
            ]
            module_tag = self._MODULE_TAGS[
                len(report.run_refs) % len(self._MODULE_TAGS)
            ]
            diagnosis = (
                f"rotate inner harness toward {category} catalog and {module_tag}"
            )
            tags = (category, module_tag, "usage_driven")
            if len(report.run_refs) % 3 == 0:
                tags = (*tags, "element_merge")
        if memory_hint:
            diagnosis = f"{diagnosis}; {memory_hint}"
        if outer_notes:
            diagnosis = (
                f"{diagnosis}; outer harness-generation elements active: "
                f"{', '.join(outer_notes[:6])}"
            )
        tags = tuple(dict.fromkeys((*tags, *outer_tags)))
        active_dsh_plugins = sum(
            element.category == "dsh_plugin"
            for element in target_harness.active_elements
        )
        if (
            self.dsh_plugin_evolution
            and active_dsh_plugins < self.dsh_plugin_target_count
        ):
            diagnosis = (
                f"adapt the GOA to DeepSeek Harness with a validated Cordis plugin; "
                "treat plugin startup, context usage, latency and retry amplification, "
                "and compatibility risk as soft marginal costs rather than a hard "
                "activation cap; "
                f"{diagnosis}"
            )
            tags = tuple(dict.fromkeys(("dsh_plugin", "element_add", *tags)))
        return HarnessSemanticGradient(
            diagnosis,
            tags,
            report.run_refs,
        )


class EvidenceDrivenCircuitProposer:
    """Use HPA transformation memory to propose deep GOA topology changes."""

    def __init__(
        self,
        store: HarnessTransformationLibraryStore,
        *,
        max_actions: int = 4,
        bundle_width: int = 1,
        compiler: HarnessTransformationCompiler | None = None,
    ):
        if not 1 <= bundle_width <= 4:
            raise ValueError("circuit bundle_width must be within 1..4")
        self.store = store
        self.max_actions = max_actions
        self.bundle_width = bundle_width
        self.compiler = compiler or HarnessTransformationCompiler()

    def propose_circuit(
        self,
        report: AttributionReport,
        *,
        proposer_harness: HarnessProfile,
        target_harness: HarnessProfile,
    ) -> CircuitMutationTransaction | None:
        del proposer_harness
        circuit = target_harness.effective_agent_circuit()
        signals = self._signals(report, circuit)
        shortlist = self.store.shortlist(signals, limit=max(4, self.bundle_width * 2))
        catalog = self.store.catalog()
        stats = self.store.stats()
        current = circuit
        bundled_actions: list[CircuitMutationAction] = []
        transformation_ids: list[str] = []
        hypotheses: list[str] = []
        prior_action_ids: tuple[str, ...] = ()
        for transformation_id in shortlist:
            transformation = catalog[transformation_id]
            if self.store.quarantine_reason(
                transformation,
                circuit_id=current.circuit_id,
            ) is not None:
                continue
            overlap = len(
                {item.casefold() for item in signals}
                & {item.casefold() for item in transformation.trigger_signals}
            )
            stat = stats.get(transformation_id)
            marginal_evidence_utility = (
                4.0 * overlap
                + (1.0 if stat is None else 1.0 / (1 + stat.uses))
                + (0.0 if stat is None else stat.mean_net_utility)
                - transformation.cost_prior
                - (0.0 if stat is None else 0.5 * stat.hard_regressions)
            )
            if overlap == 0 or marginal_evidence_utility <= 0:
                continue
            try:
                transaction = self.compiler.compile(
                    transformation,
                    circuit=current,
                    evidence_refs=report.run_refs,
                    max_actions=self.max_actions,
                )
                candidate = CircuitMutationEngine().apply(current, transaction)
                validate_workspace_lineage(candidate)
            except TransformationNotApplicable:
                continue
            except (KeyError, TypeError, ValueError) as exc:
                self.store.record_quarantine(
                    transformation,
                    circuit_id=current.circuit_id,
                    reason=f"{type(exc).__name__}: {exc}",
                    stage="goa_proposal",
                )
                continue
            if len(bundled_actions) + len(transaction.actions) > self.max_actions:
                continue

            prefix = f"b{len(transformation_ids) + 1}_{transformation_id}_"
            id_map = {
                action.action_id: self._unique_action_id(
                    prefix + action.action_id,
                    {item.action_id for item in bundled_actions},
                )
                for action in transaction.actions
            }
            renamed: list[CircuitMutationAction] = []
            for action in transaction.actions:
                dependencies = tuple(id_map[item] for item in action.depends_on)
                if not dependencies and prior_action_ids:
                    dependencies = prior_action_ids
                renamed.append(
                    CircuitMutationAction(
                        action_id=id_map[action.action_id],
                        operation=action.operation,
                        rationale=action.rationale,
                        payload=action.payload,
                        depends_on=dependencies,
                    )
                )
            bundled_actions.extend(renamed)
            transformation_ids.append(transformation_id)
            hypotheses.append(transformation.description)
            current = candidate
            prior_action_ids = tuple(item.action_id for item in renamed)
            if (
                len(transformation_ids) >= self.bundle_width
                or len(bundled_actions) >= self.max_actions
            ):
                break

        if not bundled_actions:
            return None
        result = CircuitMutationTransaction(
            parent_circuit_id=circuit.circuit_id,
            hypothesis="Evidence-linked circuit bundle: " + " Then: ".join(hypotheses),
            evidence_refs=report.run_refs,
            actions=tuple(bundled_actions),
            transformation_ids=tuple(transformation_ids),
            max_actions=self.max_actions,
        )
        validate_workspace_lineage(CircuitMutationEngine().apply(circuit, result))
        return result

    @staticmethod
    def _unique_action_id(candidate: str, existing: set[str]) -> str:
        if candidate not in existing:
            return candidate
        suffix = 2
        while f"{candidate}_{suffix}" in existing:
            suffix += 1
        return f"{candidate}_{suffix}"

    @staticmethod
    def _signals(report: AttributionReport, circuit) -> tuple[str, ...]:
        signals: list[str] = [
            str(name)
            for name, count in report.outcome_counts.items()
            if count > 0
        ]
        if len(circuit.roles) == 1:
            signals.append("single_agent")
        counts = report.outcome_counts
        if counts.get("probe_failed", 0):
            signals.extend(("gameplay_gap", "presentation_gap"))
        if counts.get("infrastructure_failure", 0):
            signals.append("integration_failure")
        if report.repeated_failures:
            signals.extend(("cross_domain_failure", "regression"))
        if not signals:
            signals.extend(("gameplay_gap", "presentation_gap"))
        return tuple(dict.fromkeys(signals))

class InnerOutcomeOuterGradientProposer:
    """Propose outer-harness gradients after a complete inner epoch."""

    _OUTER_TAGS = (
        "context_compiler",
        "module_strategy",
        "skill_governance",
        "tool_interface",
        "validation",
        "recovery",
    )

    def __init__(self, memory: HarnessEvolutionMemory | None = None):
        self.memory = memory

    def propose_outer(
        self,
        report: AttributionReport,
        *,
        latest_inner_result: HarnessEpochResult,
        proposer_harness: HarnessProfile,
    ) -> HarnessSemanticGradient:
        del proposer_harness
        memory_hint = ""
        if self.memory is not None:
            memory_hint = self.memory.render_proposer_context(loop_role="outer")
        if latest_inner_result.accepted:
            diagnosis = "inner epoch promoted; reinforce accurate harness-generation elements"
            tags = ("workflow", "usage_driven", "element_merge")
        else:
            diagnosis = "inner epoch rejected; update reusable harness-generation experience elements"
            tags = ("context", "skill", "usage_driven", "element_add")
        if report.infrastructure_events:
            tags = ("protocol", "tool", "usage_driven", "element_add")
            diagnosis = "infrastructure events require safer outer element-library refinement"
        tag = self._OUTER_TAGS[latest_inner_result.epoch % len(self._OUTER_TAGS)]
        diagnosis = f"{diagnosis}; explore {tag}"
        if memory_hint:
            diagnosis = f"{diagnosis}; {memory_hint}"
        return HarnessSemanticGradient(
            diagnosis,
            tags,
            report.run_refs,
        )


class HarnessLoopNestedReplayOracle:
    """Replay parent/candidate harnesses through the real init+evolve pipeline."""

    def __init__(
        self,
        *,
        config: AppConfig,
        task_source: Path,
        seed_artifact: Path,
        seed_score: float = 0.0,
        run_id_prefix: str = "ax",
        init_handler,
        evolve_handler,
        replay_root: Path,
    ):
        self.config = config
        self.task_source = task_source.resolve()
        self.seed_artifact = seed_artifact.resolve()
        self.seed_score = seed_score
        self.run_id_prefix = run_id_prefix
        self.init_handler = init_handler
        self.evolve_handler = evolve_handler
        self.replay_root = replay_root.resolve()

    def evaluate_inner(
        self,
        cases: Sequence[HarnessReplayCase],
        *,
        parent: HarnessProfile,
        candidate: HarnessProfile,
        proposer_harness: HarnessProfile,
        epoch: int,
    ) -> PairedOutcomes:
        del proposer_harness
        return PairedOutcomes(
            self._evaluate_side(cases, parent, epoch, side="inner_parent"),
            self._evaluate_side(cases, candidate, epoch, side="inner_candidate"),
        )

    def evaluate_outer(
        self,
        cases: Sequence[HarnessReplayCase],
        *,
        parent: HarnessProfile,
        candidate: HarnessProfile,
        target_harness: HarnessProfile,
        epoch: int,
    ) -> PairedOutcomes:
        del target_harness
        return PairedOutcomes(
            self._evaluate_side(cases, parent, epoch, side="outer_parent"),
            self._evaluate_side(cases, candidate, epoch, side="outer_candidate"),
        )

    def _evaluate_side(
        self,
        cases: Sequence[HarnessReplayCase],
        harness: HarnessProfile,
        epoch: int,
        *,
        side: str,
    ):
        def run_case(case: HarnessReplayCase):
            case_dir = self.replay_root / f"epoch_{epoch:03d}" / side / case.case_id
            metadata = dict(case.metadata)
            task_source = Path(metadata.pop("task_source_override", case.task_ref))
            seed_artifact = Path(
                metadata.pop("seed_artifact_override", case.parent_artifact_ref)
            )
            return run_frozen_harness_episode(
                case_id=case.case_id,
                case_dir=case_dir,
                harness=harness,
                config=self.config,
                task_source=task_source,
                seed_artifact=seed_artifact,
                seed_score=float(metadata.get("seed_score", self.seed_score)),
                epoch=epoch,
                run_id_prefix=f"{self.run_id_prefix}-{side[:1]}-",
                init_handler=self.init_handler,
                evolve_handler=self.evolve_handler,
            )

        try:
            configured_workers = int(
                os.environ.get("GAME_LOOP_NESTED_REPLAY_CASE_WORKERS", "1")
            )
        except ValueError as exc:
            raise ValueError(
                "GAME_LOOP_NESTED_REPLAY_CASE_WORKERS must be an integer"
            ) from exc
        case_workers = min(len(cases), max(1, configured_workers))
        if case_workers == 1:
            return tuple(run_case(case) for case in cases)

        outcomes_by_case: dict[str, object] = {}
        with ThreadPoolExecutor(
            max_workers=case_workers,
            thread_name_prefix=f"nested-{side}-e{epoch:03d}",
        ) as executor:
            futures = {executor.submit(run_case, case): case for case in cases}
            for future in as_completed(futures):
                case = futures[future]
                outcomes_by_case[case.case_id] = future.result()
        outcomes = []
        for case in cases:
            outcomes.append(outcomes_by_case[case.case_id])
        return tuple(outcomes)


def build_agentx_nested_evolution(
    *,
    run_dir: Path,
    runtime: AgentXRuntimeConfig,
    init_handler,
    evolve_handler,
    offline_rubric_judge: bool = False,
    outer_enabled: bool = False,
) -> AgentXNestedEvolution:
    raw_runtime_profile = runtime.app_config.backend.runtime_profile_value
    runtime_profile = (
        raw_runtime_profile if isinstance(raw_runtime_profile, Mapping) else {}
    )
    raw_dsh_plugin_catalog = runtime_profile.get("cordis_plugin_catalog", {})
    dsh_plugin_catalog = (
        raw_dsh_plugin_catalog
        if isinstance(raw_dsh_plugin_catalog, Mapping)
        else {}
    )
    inner_harness = runtime.inner_harness
    if dsh_plugin_catalog:
        # The audited catalog is the natural boundary. Do not impose a second,
        # smaller activation ceiling that prevents HPA from evaluating entries.
        max_active_elements = dict(inner_harness.max_active_elements)
        max_active_elements["dsh_plugin"] = max(
            len(dsh_plugin_catalog),
            sum(
                element.category == "dsh_plugin"
                for element in inner_harness.element_catalog
            ),
        )
        inner_harness = replace(
            inner_harness,
            max_active_elements=max_active_elements,
        )
    role_runtime_contract = (
        deepseek_role_runtime_contract()
        if str(runtime_profile.get("runtime_type", "")).casefold()
        == "deepseek-harness"
        else None
    )
    inner_engine = HarnessEvolutionEngine(
        run_dir / "inner",
        inner_harness,
        role_runtime_contract=role_runtime_contract,
    )
    outer_engine = HarnessEvolutionEngine(run_dir / "outer", runtime.outer_harness)
    inner_memory = (
        HarnessEvolutionMemory(run_dir / "inner" / "harness_archive")
        if runtime.inner_harness.enable_long_term_memory
        else None
    )
    outer_memory = (
        HarnessEvolutionMemory(run_dir / "outer" / "harness_archive")
        if runtime.outer_harness.enable_long_term_memory
        else None
    )
    outer_library_agent = OuterHarnessLibraryAgent(
        OuterHarnessLibraryStore(run_dir / "outer_element_library"),
        max_structural_actions=runtime.outer_harness.outer_library_max_actions,
        max_additions=runtime.outer_harness.outer_library_max_additions,
    )
    outer_library_agent.store.initialize(outer_engine.elements.values())
    circuit_proposer = None
    transformation_store = None
    transformation_agent = None
    circuit_ablation_queue = None
    if inner_harness.enable_agent_circuit_evolution:
        circuit_compiler = HarnessTransformationCompiler(
            max_roles=inner_harness.circuit_max_roles,
            max_total_model_calls=inner_harness.circuit_max_model_calls,
            max_total_cost_units=inner_harness.circuit_max_cost_units,
            max_feedback_traversals=inner_harness.circuit_max_feedback_traversals,
        )
        transformation_store = HarnessTransformationLibraryStore(
            run_dir / "harness_transformation_library"
        )
        # New v0.3 runs begin without a source-defined team roster. HPA must
        # construct evidence-backed declarative circuits; legacy compilers
        # remain available only to replay existing snapshots.
        transformation_store.initialize(())
        transformation_agent = HarnessTransformationLibraryAgent(
            transformation_store,
            compiler=circuit_compiler,
            max_structural_actions=runtime.outer_harness.outer_library_max_actions,
            max_additions=runtime.outer_harness.outer_library_max_additions,
            max_circuit_actions=inner_harness.circuit_max_actions,
        )
        circuit_proposer = EvidenceDrivenCircuitProposer(
            transformation_store,
            max_actions=inner_harness.circuit_max_actions,
            bundle_width=inner_harness.circuit_bundle_width,
            compiler=circuit_compiler,
        )
        circuit_ablation_queue = CircuitAblationQueue(
            run_dir / "inner" / "harness_archive" / "circuit_ablation.json"
        )
    dsh_plugin_target_count = len(dsh_plugin_catalog)
    judge = HeuristicRubricJudge() if offline_rubric_judge else None
    oracle = HarnessLoopNestedReplayOracle(
        config=runtime.app_config,
        task_source=runtime.task_source,
        seed_artifact=runtime.seed_artifact,
        seed_score=runtime.seed_score,
        run_id_prefix=runtime.run_id_prefix,
        init_handler=init_handler,
        evolve_handler=evolve_handler,
        replay_root=run_dir / "replays",
    )
    return AgentXNestedEvolution(
        run_dir=run_dir,
        inner_engine=inner_engine,
        outer_engine=outer_engine,
        inner_gradient_proposer=AttributionDrivenInnerGradientProposer(
            inner_memory,
            outer_library_agent.store,
            dsh_plugin_evolution=bool(
                dsh_plugin_catalog
            ),
            dsh_plugin_target_count=max(1, dsh_plugin_target_count),
        ),
        inner_circuit_proposer=circuit_proposer,
        outer_gradient_proposer=InnerOutcomeOuterGradientProposer(outer_memory),
        replay_oracle=oracle,
        inner_rubric_validator=HarnessRubricValidator(
            inner_harness,
            judge=judge,
        ),
        outer_rubric_validator=HarnessRubricValidator(
            runtime.outer_harness,
            judge=judge,
        ),
        inner_memory=inner_memory,
        outer_memory=outer_memory,
        outer_library_agent=outer_library_agent,
        circuit_transformation_store=transformation_store,
        circuit_transformation_agent=transformation_agent,
        circuit_ablation_queue=circuit_ablation_queue,
        hpa_max_structural_actions=runtime.outer_harness.outer_library_max_actions,
        hpa_max_additions=runtime.outer_harness.outer_library_max_additions,
        outer_enabled=outer_enabled,
    )


def build_agentx_replay_cases(
    runtime: AgentXRuntimeConfig,
    *,
    loop_role: str,
    epoch: int,
    config_path: Path,
) -> tuple[HarnessReplayCase, ...]:
    if runtime.task_pool:
        sample_size = (
            runtime.outer_harness.rubric_validation_sample_size
            if loop_role == "outer"
            else runtime.inner_harness.rubric_validation_sample_size
        )
        cases = sample_task_pool(
            runtime.task_pool,
            sample_size=sample_size,
            seed=epoch,
            prefix=loop_role,
        )
        enriched: list[HarnessReplayCase] = []
        for case in cases:
            metadata = dict(case.metadata)
            metadata.setdefault("seed_score", case.metadata.get("seed_score", runtime.seed_score))
            metadata["config_path"] = str(config_path.resolve())
            enriched.append(
                HarnessReplayCase(
                    case.case_id,
                    case.task_ref,
                    case.parent_artifact_ref,
                    metadata=metadata,
                )
            )
        return tuple(enriched)

    sample_size = (
        runtime.outer_harness.rubric_validation_sample_size
        if loop_role == "outer"
        else runtime.inner_harness.rubric_validation_sample_size
    )
    return tuple(
        HarnessReplayCase(
            f"{loop_role}-{index + 1:02d}",
            str(runtime.task_source.resolve()),
            str(runtime.seed_artifact.resolve()),
            metadata={
                "seed_score": runtime.seed_score,
                "config_path": str(config_path.resolve()),
            },
        )
        for index in range(sample_size)
    )
