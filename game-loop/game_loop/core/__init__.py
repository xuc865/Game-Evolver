from __future__ import annotations

# NOTE: LoopController is imported lazily to avoid a circular import:
#   core/__init__ → controller → artifacts → core/models → core/__init__
# Consumers should do:  from game_loop.core.controller import LoopController

from .harness import (
    HarnessEpisodeOutcome,
    HarnessEvolutionEngine,
    HarnessOuterLoop,
    HarnessProfile,
    HarnessReplayCase,
    HarnessSemanticGradient,
    load_episode_outcome,
)
from .models import EvaluationResult
from .agentx import (
    AgentXNestedEpochResult,
    AgentXNestedEvolution,
    InnerGradientProposer,
    NestedReplayOracle,
    OuterGradientProposer,
    PairedOutcomes,
)

__all__ = [
    "HarnessEvolutionEngine",
    "HarnessOuterLoop",
    "HarnessProfile",
    "HarnessReplayCase",
    "HarnessSemanticGradient",
    "HarnessEpisodeOutcome",
    "load_episode_outcome",
    "EvaluationResult",
    "AgentXNestedEpochResult",
    "AgentXNestedEvolution",
    "InnerGradientProposer",
    "NestedReplayOracle",
    "OuterGradientProposer",
    "PairedOutcomes",
]
