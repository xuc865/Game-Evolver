from __future__ import annotations

from tau2.agent.llm_agent import LLMAgent

from game_loop.cache_keys import build_cache_key_headers

from .context import compose_benchmark_instruction, load_harness_context


class GameMakingTauAgent(LLMAgent):
    """Our game-making policy speaking TauBench's native tool-call protocol."""

    @property
    def system_prompt(self) -> str:
        native = super().system_prompt
        return compose_benchmark_instruction(
            native,
            harness_context=load_harness_context(),
            benchmark_name="TauBench",
        )

    def _generate_next_message(self, message, state):
        headers = build_cache_key_headers()
        if headers:
            self.llm_args["extra_headers"] = headers
        return super()._generate_next_message(message, state)


def create_game_making_tau_agent(
    tools,
    domain_policy,
    *,
    llm,
    llm_args=None,
    **_runner_metadata,
):
    """Build the text agent while ignoring Tau runner-only metadata.

    Tau's generic builder passes task/audio arguments to every registered
    factory. Native ``LLMAgent`` only accepts model settings, so those generic
    arguments must stop at this compatibility boundary.
    """
    return GameMakingTauAgent(
        tools=tools,
        domain_policy=domain_policy,
        llm=llm,
        llm_args=llm_args,
    )
