from __future__ import annotations

from harbor.agents.terminus_2.terminus_2 import Terminus2

from .context import compose_benchmark_instruction, load_harness_context


class GameMakingHarborAgent(Terminus2):
    """Our game-making policy fused with Harbor's terminal transport."""

    @staticmethod
    def name() -> str:
        return "game-making-agent"

    def version(self) -> str | None:
        return "game-loop-fusion-v1"

    async def run(self, instruction, environment, context) -> None:
        fused = compose_benchmark_instruction(
            instruction,
            harness_context=load_harness_context(),
            benchmark_name="TerminalBench/Harbor",
        )
        await super().run(fused, environment, context)
