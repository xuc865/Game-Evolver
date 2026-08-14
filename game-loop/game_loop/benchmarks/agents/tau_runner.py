from __future__ import annotations

import argparse
import os
from pathlib import Path

from tau2.data_model.simulation import TextRunConfig
from tau2.registry import registry
from tau2.run import run_domain

from .tau_agent import create_game_making_tau_agent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run TauBench with the game-making agent")
    parser.add_argument("--domain", default="airline")
    parser.add_argument("--agent-llm", default=None)
    parser.add_argument("--user-llm", default=None)
    parser.add_argument("--task-ids", nargs="*")
    parser.add_argument("--num-tasks", type=int)
    parser.add_argument("--num-trials", type=int, default=1)
    parser.add_argument("--retrieval-config", default=None)
    parser.add_argument("--auto-resume", action="store_true")
    parser.add_argument("--save-to", required=True)
    args = parser.parse_args(argv)
    agent_llm = args.agent_llm or os.environ.get("TAU_GAME_MAKING_MODEL") or os.environ.get("CODEX_MODEL")
    user_llm = args.user_llm or agent_llm
    if not agent_llm or not user_llm:
        parser.error("an agent model is required via --agent-llm or CODEX_MODEL")
    if os.environ.get("OPENAI_BASE_URL"):
        if "/" not in agent_llm:
            agent_llm = "openai/" + agent_llm
        if "/" not in user_llm:
            user_llm = "openai/" + user_llm
    registry.register_agent_factory(create_game_making_tau_agent, "game_making_agent")
    run_domain(TextRunConfig(
        domain=args.domain,
        agent="game_making_agent",
        llm_agent=agent_llm,
        llm_user=user_llm,
        task_ids=args.task_ids,
        num_tasks=args.num_tasks,
        num_trials=args.num_trials,
        retrieval_config=args.retrieval_config,
        auto_resume=args.auto_resume,
        save_to=args.save_to,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
