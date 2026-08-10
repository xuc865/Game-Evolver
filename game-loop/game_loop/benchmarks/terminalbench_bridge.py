from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from game_loop.runtime import GameTask, OpenGameRuntime
from .runtime_config import runtime_config_from_environment
from .agents.context import compose_benchmark_instruction, load_harness_context
from .sandbox import require_project_sandbox


def _image(task_root: Path, override: str | None) -> str:
    if override:
        return override
    text = (task_root / "task.toml").read_text(encoding="utf-8")
    match = re.search(r'docker_image\s*=\s*"([^"]+)"', text)
    if not match:
        raise ValueError(f"TerminalBench task image is missing: {task_root / 'task.toml'}")
    return match.group(1)


def _run_verifier(*, artifact: Path, task_root: Path, image: str,
                  result_dir: Path, timeout: int) -> tuple[int, str]:
    result_dir.mkdir(parents=True, exist_ok=True)
    command = ["docker", "run", "--rm", "--platform", "linux/amd64", "-w", "/app",
               "-v", f"{artifact.resolve()}:/app",
               "-v", f"{(task_root / 'tests').resolve()}:/tests:ro",
               "-v", f"{result_dir.resolve()}:/logs", image, "bash", "/tests/test.sh"]
    try:
        proc = subprocess.run(command, capture_output=True, text=True,
                              timeout=timeout, check=False)
        output = proc.stdout + "\n" + proc.stderr
        return proc.returncode, output
    except subprocess.TimeoutExpired:
        return -1, "TerminalBench verifier timed out"
    except FileNotFoundError:
        return -2, "docker not found"


def _run_harbor(*, task_root: Path, output_manifest: Path, harness_context: Path | None,
                model: str, timeout: int, dataset: str | None = None) -> int:
    """Run the official TerminalBench task through our Harbor-fused agent."""
    repo_root = Path(__file__).resolve().parents[2]
    harbor_python = repo_root / "third_party" / "harbor" / ".venv" / "bin" / "harbor"
    result_root = output_manifest.parent / f"terminalbench_harbor_{time.time_ns()}"
    result_root.mkdir(parents=True, exist_ok=True)
    if not harbor_python.is_file():
        result = {"passed": False, "reward": 0.0, "infrastructure_error": True,
                  "errors": [f"Harbor environment is missing: {harbor_python}"],
                  "task_id": task_root.name}
        output_manifest.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return 1
    env = dict(os.environ)
    if not env.get("DOCKER_HOST"):
        context = subprocess.run(["docker", "context", "show"], capture_output=True,
                                 text=True, check=False).stdout.strip()
        if context and context != "default":
            endpoint = subprocess.run(
                ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}", context],
                capture_output=True, text=True, check=False,
            ).stdout.strip()
            if endpoint:
                env["DOCKER_HOST"] = endpoint
    env["PYTHONPATH"] = str(repo_root) + os.pathsep + env.get("PYTHONPATH", "")
    if harness_context:
        env["GAME_LOOP_HARNESS_CONTEXT"] = str(harness_context.resolve())
    # Harbor and its Docker environment are benchmark transport only; keep
    # their home/cache state beside the result, never in the user's home.
    env["HOME"] = str(result_root / "home")
    env["XDG_CACHE_HOME"] = str(result_root / "xdg-cache")
    env["UV_CACHE_DIR"] = str(result_root / "uv-cache")
    local_docker_config = repo_root / "experiments" / "docker-cli-config"
    if (local_docker_config / "cli-plugins" / "docker-compose").is_file():
        env["DOCKER_CONFIG"] = str(local_docker_config)
    if env.get("CODEX_API_BASE"):
        env["OPENAI_BASE_URL"] = env["CODEX_API_BASE"]
    # LiteLLM validates that an API-key field exists even for the internal
    # OpenAI-compatible deployments that intentionally do not require one.
    env.setdefault("OPENAI_API_KEY", "EMPTY")
    provider = env.get("CODEX_PROVIDER", env.get("GAME_LOOP_BACKBONE_PROVIDER", "")).casefold()
    provider_key = {
        "claude": env.get("ANTHROPIC_AUTH_TOKEN") or env.get("ANTHROPIC_API_KEY") or env.get("CODEX_API_KEY_CLAUDE"),
        "gpt55": env.get("CODEX_API_KEY_GPT55") or env.get("OPENAI_API_KEY"),
        "deepseek": env.get("DEEPSEEK_API_KEY"),
    }.get(provider)
    if provider_key:
        env["OPENAI_API_KEY"] = provider_key
    model_name = model if "/" in model else f"openai/{model}"
    command = [str(harbor_python), "run", *( ["--dataset", dataset] if dataset else ["--path", str(task_root)] ),
               "--agent", "game_loop.benchmarks.agents.terminal_harbor:GameMakingHarborAgent",
               "--model", model_name, "--jobs-dir", str(result_root / "jobs"),
               "--n-attempts", "1", "--n-concurrent", "1", "--yes"]
    if dataset:
        command += ["--n-tasks", "1"]
    if env.get("CODEX_API_BASE"):
        command += ["--ak", f"api_base={env['CODEX_API_BASE']}"]
    try:
        proc = subprocess.run(command, cwd=repo_root, env=env, capture_output=True,
                              text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        result = {"passed": False, "reward": 0.0, "infrastructure_error": True,
                  "errors": ["Harbor TerminalBench run timed out"], "task_id": task_root.name}
        output_manifest.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return 1
    job_results = sorted(result_root.glob("jobs/*/result.json"))
    reward = 0.0
    identity = ""
    errors: list[str] = []
    if job_results:
        raw = json.loads(job_results[-1].read_text(encoding="utf-8"))
        evaluation = raw.get("stats", {}).get("evals", {})
        if evaluation:
            first = next(iter(evaluation.values()))
            reward = float(first.get("metrics", [{}])[0].get("mean", 0.0))
            identity = str(next(iter(evaluation.keys())))
        if int(raw.get("stats", {}).get("n_errored_trials", 0)):
            errors.append(proc.stderr[-2000:] or proc.stdout[-2000:])
    else:
        errors.append(proc.stderr[-2000:] or proc.stdout[-2000:] or "Harbor result missing")
    result = {"passed": reward >= 1.0 and not errors, "reward": reward,
              "infrastructure_error": not bool(job_results) or bool(errors),
              "errors": errors, "task_id": task_root.name,
              "solver": "game_loop.benchmarks.agents.terminal_harbor:GameMakingHarborAgent",
              "dataset": dataset or "local-task",
              "harbor_result": str(job_results[-1]) if job_results else "",
              "agent_identity": identity, "return_code": proc.returncode}
    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    output_manifest.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0 if not result["infrastructure_error"] else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run our game-making agent then the official TerminalBench verifier")
    parser.add_argument("--task-root", type=Path, required=True)
    parser.add_argument("--agent-workspace", type=Path, required=True)
    parser.add_argument("--instruction-file", type=Path, required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--model", default=None)
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--container-image", default=None)
    parser.add_argument("--harness-context", type=Path, default=None)
    parser.add_argument("--runtime-config-json")
    parser.add_argument("--solver", choices=("harbor", "opengame"), default="harbor")
    parser.add_argument("--dataset", default=None,
                        help="Harbor dataset name, e.g. terminal-bench/terminal-bench-2-1")
    args = parser.parse_args(argv)
    task_root = args.task_root.resolve()
    agent_workspace = require_project_sandbox(args.agent_workspace, label="agent_workspace")
    output_manifest = require_project_sandbox(args.output_manifest, label="output_manifest")
    if args.solver == "harbor":
        model = args.model or os.environ.get("CODEX_MODEL", "gpt-4.1")
        return _run_harbor(task_root=task_root, output_manifest=output_manifest,
                           harness_context=args.harness_context, model=model,
                           timeout=args.timeout, dataset=args.dataset)
    result_dir = output_manifest.parent / "terminalbench_results"
    runtime_env = dict(os.environ)
    if args.harness_context:
        runtime_env["GAME_LOOP_HARNESS_CONTEXT"] = str(args.harness_context.resolve())
    config = runtime_config_from_environment(timeout_seconds=args.timeout)
    if args.runtime_config_json:
        from game_loop.runtime import OpenGameRuntimeConfig
        config = OpenGameRuntimeConfig.from_dict(json.loads(args.runtime_config_json))
    with tempfile.TemporaryDirectory(prefix="terminalbench-game-making-") as td:
        episode = Path(td) / "opengame"
        instruction = args.instruction_file.resolve()
        prompt = compose_benchmark_instruction(
            instruction.read_text(encoding="utf-8"),
            harness_context=load_harness_context(args.harness_context),
            benchmark_name="TerminalBench",
        )
        task = GameTask(
            task_id=task_root.name,
            benchmark_id="terminalbench",
            prompt=prompt,
            task_source_ref=str(instruction),
            workspace_seed_ref=str(agent_workspace),
            artifact_relpath=".",
        )
        # OpenGameRuntime remains the only solver. The container is verifier-only.
        runtime = OpenGameRuntime(config)
        previous = os.environ.copy()
        os.environ.update(runtime_env)
        try:
            submission = runtime.run(task, episode_dir=episode)
        finally:
            os.environ.clear()
            os.environ.update(previous)
        artifact = Path(submission.artifact_ref) if submission.artifact_ref else None
        infrastructure_error = submission.status != "completed" or artifact is None
        return_code = -1
        output = "OpenGame did not produce a candidate artifact"
        reward = 0.0
        if not infrastructure_error:
            try:
                return_code, output = _run_verifier(
                    artifact=artifact, task_root=task_root,
                    image=_image(task_root, args.container_image),
                    result_dir=result_dir, timeout=args.timeout,
                )
                reward_file = result_dir / "verifier" / "reward.txt"
                reward = float(reward_file.read_text().strip()) if reward_file.is_file() else 0.0
                infrastructure_error = return_code < 0 or not reward_file.is_file()
            except (OSError, ValueError) as exc:
                infrastructure_error, output = True, str(exc)
        result = {"passed": reward >= 1.0 and not infrastructure_error,
                  "reward": reward, "task_id": task_root.name,
                  "errors": [] if not infrastructure_error else [output[-2000:]],
                  "infrastructure_error": infrastructure_error,
                  "return_code": return_code,
                  "artifact_dir": str(artifact or "")}
    (result_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    output_manifest.write_text(json.dumps({**result, "result_dir": str(result_dir)}, indent=2) + "\n",
                                               encoding="utf-8")
    return 0 if not infrastructure_error else 1


if __name__ == "__main__":
    raise SystemExit(main())
