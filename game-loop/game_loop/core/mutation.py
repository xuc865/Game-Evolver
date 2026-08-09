from __future__ import annotations

from typing import Any, Sequence

from game_loop.core.models import AttemptRecord, EvaluationResult, MutationIntent


class L0MutationPolicy:
    def select(
        self,
        *,
        parent: EvaluationResult,
        history: Sequence[AttemptRecord],
        generation: int,
        candidate_index: int,
        capabilities: dict[str, Any],
    ) -> MutationIntent:
        del history, generation
        topology = str(capabilities.get("score_topology", "continuous_multi_objective"))
        if candidate_index >= 2:
            return MutationIntent(
                "ExploreAlternative",
                None,
                "Try a meaningfully different change family from the current parent.",
                exploration=True,
            )
        if topology == "binary":
            return MutationIntent(
                "CoverUnverifiedRequirement",
                None,
                "Close the remaining binary benchmark requirement without breaking feasibility.",
            )
        if not parent.objectives:
            return MutationIntent(
                "ImproveObjective",
                None,
                "Increase the primary benchmark score while preserving feasibility.",
            )
        target = min(parent.objectives.items(), key=lambda item: item[1])[0]
        return MutationIntent(
            "ImproveObjective",
            target,
            f"Improve the weakest objective {target} without regressing the others.",
        )
