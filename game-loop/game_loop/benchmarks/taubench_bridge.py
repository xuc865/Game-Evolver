from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from game_loop.runtime.credentials import select_provider_api_key
from .sandbox import require_project_sandbox


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the official tau2-bench CLI")
    parser.add_argument("--tau-root", type=Path, required=True)
    parser.add_argument("--domain", default="airline")
    parser.add_argument("--task-ids", nargs="*", type=int)
    parser.add_argument("--agent-llm", default=None)
    parser.add_argument("--user-llm", default=None)
    parser.add_argument("--num-tasks", type=int, default=None)
    parser.add_argument("--num-trials", type=int, default=1)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--harness-context", type=Path, default=None)
    parser.add_argument("--timeout", type=int, default=3600)
    args = parser.parse_args(argv)
    model = args.agent_llm or os.environ.get("CODEX_MODEL", "gpt-4.1")
    root = args.tau_root.resolve()  # official source; never used as a writable run root
    output_manifest = require_project_sandbox(args.output_manifest, label="output_manifest")
    result_dir = output_manifest.parent / f"tau2_{time.time_ns()}"
    tau_python = root / ".venv" / "bin" / "python"
    if not tau_python.is_file():
        raise FileNotFoundError(f"Tau project environment is missing: {tau_python}")
    command = [str(tau_python), "-m",
               "game_loop.benchmarks.agents.tau_runner",
               "--domain", args.domain, "--agent-llm", model,
               "--user-llm", args.user_llm or model,
               "--num-trials", str(args.num_trials), "--save-to", str(result_dir)]
    if args.task_ids:
        command += ["--task-ids", *map(str, args.task_ids)]
    if args.num_tasks is not None:
        command += ["--num-tasks", str(args.num_tasks)]
    error = ""
    started_ns = time.time_ns()
    env = dict(os.environ)
    repo_root = Path(__file__).resolve().parents[2]
    env["PYTHONPATH"] = str(repo_root) + os.pathsep + env.get("PYTHONPATH", "")
    # Tau/LiteLLM is run against the configured OpenAI-compatible deployment.
    # Keep the official source read-only and put all caches/home state in the
    # project sandbox as well.
    env["HOME"] = str(output_manifest.parent / "tau_home")
    env["XDG_CACHE_HOME"] = str(output_manifest.parent / "tau_xdg_cache")
    env["UV_CACHE_DIR"] = str(output_manifest.parent / "tau_uv_cache")
    if env.get("CODEX_API_BASE"):
        env["OPENAI_BASE_URL"] = env["CODEX_API_BASE"]
    # LiteLLM requires the field to be present for keyless internal endpoints.
    env.setdefault("OPENAI_API_KEY", "EMPTY")
    if env.get("CODEX_MODEL"):
        model = env["CODEX_MODEL"]
        if "/" not in model:
            model = "openai/" + model
        env["TAU_GAME_MAKING_MODEL"] = model
    provider = env.get("CODEX_PROVIDER", env.get("GAME_LOOP_BACKBONE_PROVIDER", "")).casefold()
    provider_key = select_provider_api_key(provider, env, salt=str(output_manifest)) or {
        "claude": env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") or env.get("CODEX_API_KEY_CLAUDE"),
        "gpt55": env.get("CODEX_API_KEY_GPT55") or env.get("OPENAI_API_KEY"),
        "deepseek": env.get("DEEPSEEK_API_KEY"),
    }.get(provider)
    if provider_key:
        env["OPENAI_API_KEY"] = provider_key
    if args.harness_context:
        env["GAME_LOOP_HARNESS_CONTEXT"] = str(args.harness_context.resolve())
    runner_log = result_dir / "tau_runner.log"
    try:
        result_dir.mkdir(parents=True, exist_ok=True)
        with runner_log.open("w", encoding="utf-8") as log:
            proc = subprocess.run(
                command,
                cwd=root,
                env=env,
                text=True,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=args.timeout,
            )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        proc = None
        error = type(exc).__name__
    result_path = result_dir / "results.json"
    if not result_path.is_file():
        result_path = None
    rewards: list[float] = []
    infrastructure_errors: list[str] = []
    if result_path:
        try:
            raw = json.loads(result_path.read_text(encoding="utf-8"))
            for simulation in raw.get("simulations", []):
                if simulation.get("termination_reason") == "infrastructure_error":
                    infrastructure_errors.append(str(simulation.get("info", {}).get("error", "infrastructure error")))
                reward_info = simulation.get("reward_info")
                if isinstance(reward_info, dict) and isinstance(reward_info.get("reward"), (int, float)):
                    rewards.append(float(reward_info["reward"]))
        except (OSError, json.JSONDecodeError):
            infrastructure_errors.append("tau2 result JSON could not be parsed")
    normalized = result_path.parent / "game_loop_result.json" if result_path else None
    if normalized:
        normalized.write_text(json.dumps({"status": "completed" if rewards and not infrastructure_errors else "infrastructure_failure",
            "reward": sum(rewards) / len(rewards) if rewards else None,
            "infrastructure_errors": infrastructure_errors, "domain": args.domain}, indent=2) + "\n")
    log_tail = ""
    if runner_log.is_file():
        with runner_log.open("rb") as log:
            log.seek(max(0, runner_log.stat().st_size - 2000))
            log_tail = log.read().decode("utf-8", errors="replace")
    payload = {"status": "completed" if proc and proc.returncode == 0 and rewards and not infrastructure_errors
               else "infrastructure_failure", "result_path": str(normalized or ""),
               "return_code": proc.returncode if proc else -1,
               "diagnostics": infrastructure_errors + ([error] if error else []) +
               ([log_tail] if proc and log_tail else [])}
    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    output_manifest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0 if payload["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
