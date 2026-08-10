"""Benchmark-native shells for the game-making agent.

These adapters intentionally live outside ``game_loop.runtime`` so benchmark
tool protocols can evolve without changing the game-making agent core.
"""

from .context import compose_benchmark_instruction, load_harness_context

__all__ = ["compose_benchmark_instruction", "load_harness_context"]
