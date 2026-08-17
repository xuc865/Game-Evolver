from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from game_loop.config import AppConfig
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
from game_loop.core.outer_harness_library import (
    OuterHarnessLibraryAgent,
    OuterHarnessLibraryStore,
)


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
    ):
        self.memory = memory
        self.outer_library_store = outer_library_store

    def propose_inner(
        self,
        report: AttributionReport,
        *,
        proposer_harness: HarnessProfile,
        target_harness: HarnessProfile,
    ) -> HarnessSemanticGradient:
        del target_harness
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
        return HarnessSemanticGradient(
            diagnosis,
            tags,
            report.run_refs,
        )


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
    inner_engine = HarnessEvolutionEngine(run_dir / "inner", runtime.inner_harness)
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
        OuterHarnessLibraryStore(run_dir / "outer_element_library")
    )
    outer_library_agent.store.initialize(outer_engine.elements.values())
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
        ),
        outer_gradient_proposer=InnerOutcomeOuterGradientProposer(outer_memory),
        replay_oracle=oracle,
        inner_rubric_validator=HarnessRubricValidator(
            runtime.inner_harness,
            judge=judge,
        ),
        outer_rubric_validator=HarnessRubricValidator(
            runtime.outer_harness,
            judge=judge,
        ),
        inner_memory=inner_memory,
        outer_memory=outer_memory,
        outer_library_agent=outer_library_agent,
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
