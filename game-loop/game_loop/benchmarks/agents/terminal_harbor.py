from __future__ import annotations

from harbor.agents.terminus_2.terminus_2 import Terminus2

from game_loop.cache_keys import build_cache_key_headers

from .context import compose_benchmark_instruction, load_harness_context


class GameMakingHarborAgent(Terminus2):
    """Our game-making policy fused with Harbor's terminal transport."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        original_call = self._llm.call

        async def call_with_cache_key(*call_args, **call_kwargs):
            headers = build_cache_key_headers()
            if headers:
                extra_headers = dict(call_kwargs.get("extra_headers") or {})
                extra_headers.update(headers)
                call_kwargs["extra_headers"] = extra_headers
            return await original_call(*call_args, **call_kwargs)

        self._llm.call = call_with_cache_key

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
