from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from game_loop.config import AppConfig
from game_loop.core.agentx import (
    AgentXNestedEvolution,
    InnerGradientProposer,
    NestedReplayOracle,
    OuterGradientProposer,
    PairedOutcomes,
)
from game_loop.core.attribution import AttributionReport
from game_loop.core.episode_runner import run_frozen_harness_episode
from game_loop.core.harness import (
    HarnessEpochResult,
    HarnessEvolutionEngine,
    HarnessEvolutionConfig,
    HarnessProfile,
    HarnessReplayCase,
    HarnessSemanticGradient,
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


class AttributionDrivenInnerGradientProposer:
    """Propose inner-harness gradients from attribution evidence."""

    _TAGS = (
        "evidence_first",
        "gameplay_observability",
        "mechanic_depth",
        "regression_first",
        "engine_tooling_first",
        "minimal_coherent_patch",
    )

    def propose_inner(
        self,
        report: AttributionReport,
        *,
        proposer_harness: HarnessProfile,
        target_harness: HarnessProfile,
    ) -> HarnessSemanticGradient:
        del proposer_harness, target_harness
        counts = dict(report.outcome_counts)
        if counts.get("probe_failed", 0) >= 2:
            return HarnessSemanticGradient(
                "probe failures indicate missing runtime evidence before patching",
                ("evidence_first", "engine_tooling_first"),
                report.run_refs,
            )
        if counts.get("infrastructure_failure", 0) >= 1:
            return HarnessSemanticGradient(
                "infrastructure failures require tighter validation and recovery",
                ("regression_first", "minimal_coherent_patch"),
                report.run_refs,
            )
        if report.repeated_failures:
            return HarnessSemanticGradient(
                "repeated failure families require an alternative mechanic strategy",
                ("mechanic_depth", "gameplay_observability"),
                report.run_refs,
            )
        tag = self._TAGS[len(report.run_refs) % len(self._TAGS)]
        return HarnessSemanticGradient(
            f"rotate inner harness emphasis toward {tag}",
            (tag,),
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

    def propose_outer(
        self,
        report: AttributionReport,
        *,
        latest_inner_result: HarnessEpochResult,
        proposer_harness: HarnessProfile,
    ) -> HarnessSemanticGradient:
        del proposer_harness
        if latest_inner_result.accepted:
            diagnosis = "inner epoch promoted; refine the harness-improvement contract"
            tags = ("validation", "module_strategy")
        else:
            diagnosis = "inner epoch rejected; strengthen evidence-grounded refinement"
            tags = ("context_compiler", "recovery")
        if report.infrastructure_events:
            tags = ("recovery", "tool_interface")
            diagnosis = "infrastructure events require safer outer-loop refinement"
        tag = self._OUTER_TAGS[latest_inner_result.epoch % len(self._OUTER_TAGS)]
        return HarnessSemanticGradient(
            f"{diagnosis}; explore {tag}",
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
        outcomes = []
        for case in cases:
            case_dir = self.replay_root / f"epoch_{epoch:03d}" / side / case.case_id
            outcomes.append(
                run_frozen_harness_episode(
                    case_id=case.case_id,
                    case_dir=case_dir,
                    harness=harness,
                    config=self.config,
                    task_source=Path(case.task_ref),
                    seed_artifact=Path(case.parent_artifact_ref),
                    seed_score=float(case.metadata.get("seed_score", self.seed_score)),
                    epoch=epoch,
                    run_id_prefix=f"{self.run_id_prefix}-{side[:1]}-",
                    init_handler=self.init_handler,
                    evolve_handler=self.evolve_handler,
                )
            )
        return tuple(outcomes)


def build_agentx_nested_evolution(
    *,
    run_dir: Path,
    runtime: AgentXRuntimeConfig,
    init_handler,
    evolve_handler,
) -> AgentXNestedEvolution:
    inner_engine = HarnessEvolutionEngine(run_dir / "inner", runtime.inner_harness)
    outer_engine = HarnessEvolutionEngine(run_dir / "outer", runtime.outer_harness)
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
        inner_gradient_proposer=AttributionDrivenInnerGradientProposer(),
        outer_gradient_proposer=InnerOutcomeOuterGradientProposer(),
        replay_oracle=oracle,
    )
