#!/usr/bin/env python3
"""Run the VeriGame public-test awesome-skills arm without harness evolution.

Each case is one isolated OpenGame maker episode followed by the configured
GameGen-Verifier contract evaluator.  The runner is resumable and writes a
separate namespace so its accounting cannot be confused with evolution runs.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / ".baseline-agent-runs"
TASKS = ROOT / "third_party" / "GameGen-Verifier" / "spec"
SEED = ROOT / "experiments" / "public_baseline_seeds" / "verigame"
WORKER = ROOT / "scripts" / "ggv_contract_worker.py"
PROVIDERS = {
    "kimi": "Kimi-K2.7-Code",
    "qwen": "Qwen3.6-27B",
    "glm": "GLM-5.2-W4AFP8",
    "deepseek": "deepseek-v4-flash",
}


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def task_dirs(root: Path) -> list[Path]:
    return sorted(path for path in root.iterdir() if path.is_file() and path.suffix == ".md")


def case_key(provider: str, task: Path) -> str:
    return f"verigame_public_awesome_{provider}_{task.stem}"


def run_case(provider: str, task: Path, case_dir: Path, timeout: int) -> dict:
    attempt_root = case_dir / f"attempt-{int(time.time())}"
    attempt_root.mkdir(parents=True, exist_ok=False)
    case_dir = attempt_root
    public_task = case_dir / "public_task"
    public_task.mkdir(parents=True, exist_ok=True)
    agent_workspace = case_dir / "agent_workspace"
    if not agent_workspace.exists():
        shutil.copytree(SEED, agent_workspace)
    specification = public_task / "specification.md"
    if not specification.exists():
        shutil.copy2(task, specification)
    instruction = case_dir / "instruction.md"
    if not instruction.exists():
        instruction.write_text(
            "# VeriGame public test\n\n"
            "Implement the supplied public game specification as a runnable web game. "
            "Use the available game-development skills when relevant. Keep gameplay "
            "state inspectable and controllable by the evaluator.\n\n"
            + task.read_text(encoding="utf-8"),
            encoding="utf-8",
        )
    manifest = case_dir / "verigame_execution.json"
    cmd = [
        sys.executable,
        "-m",
        "game_loop.benchmarks.verigame_bridge",
        "--agent-workspace",
        str(agent_workspace),
        "--instruction-file",
        str(instruction),
        "--task-root",
        str(public_task),
        "--output-manifest",
        str(manifest),
        "--backbone-provider",
        provider,
        "--worker-command-json",
        json.dumps([sys.executable, str(WORKER)]),
        "--timeout",
        str(timeout),
        "--worker-timeout",
        "600",
    ]
    log = case_dir / "case.log"
    started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    env["GAME_LOOP_USE_AWESOME_GAMEDEV_SKILLS"] = "1"
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    with log.open("a", encoding="utf-8") as stream:
        stream.write("$ " + " ".join(cmd) + "\n")
        stream.flush()
        try:
            proc = subprocess.run(
                cmd,
                cwd=ROOT,
                env=env,
                stdout=stream,
                stderr=subprocess.STDOUT,
                timeout=timeout + 120,
                check=False,
            )
            return_code = proc.returncode
        except subprocess.TimeoutExpired:
            return_code = -1
            stream.write("[runner] timeout\n")
    manifest_value = read_json(manifest)
    evaluation = read_json(Path(str(manifest_value.get("evaluation_path", ""))))
    status = "completed" if return_code == 0 and manifest_value.get("status") == "completed" else "failed"
    return {
        "run_id": case_key(provider, task),
        "provider": provider,
        "model": PROVIDERS[provider],
        "task": task.stem,
        "status": status,
        "return_code": return_code,
        "started_at": started,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "primary_score": evaluation.get("primary_score"),
        "evaluation_status": evaluation.get("status"),
        "manifest": str(manifest),
        "log": str(log),
    }


def run_provider(provider: str, output_root: Path, timeout: int) -> None:
    tasks = task_dirs(TASKS)
    provider_root = output_root / provider
    provider_root.mkdir(parents=True, exist_ok=True)
    summary_path = provider_root / "summary.json"
    summary = read_json(summary_path)
    summary.setdefault("schema_version", "verigame-public-awesome-v1")
    summary.setdefault("experiment_type", "public_test")
    summary.setdefault("evolution_enabled", False)
    summary.setdefault("awesome_skills", True)
    summary.setdefault("provider", provider)
    summary.setdefault("model", PROVIDERS[provider])
    summary.setdefault("task_source", str(TASKS))
    summary.setdefault("planned_count", len(tasks))
    summary.setdefault("cases", [])
    summary.setdefault("attempted_count", len(summary["cases"]))
    summary.setdefault("completed_count", sum(item.get("status") == "completed" for item in summary["cases"]))
    summary.setdefault("failed_count", summary["attempted_count"] - summary["completed_count"])
    # A task is attempted at most once in this namespace. Failed attempts are
    # retained as infrastructure/model failures and are not silently retried.
    by_task = {str(item.get("task")): item for item in summary["cases"]}
    for index, task in enumerate(tasks, 1):
        if task.stem in by_task:
            continue
        case_dir = provider_root / task.stem
        print(f"[{provider}] {index}/{len(tasks)} {task.stem}", flush=True)
        summary["current_case"] = {
            "task": task.stem,
            "index": index,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        summary["finished_at"] = None
        write_json(summary_path, summary)
        item = run_case(provider, task, case_dir, timeout)
        by_task[task.stem] = item
        summary["cases"] = [by_task[name] for name in sorted(by_task)]
        summary["current_case"] = None
        summary["attempted_count"] = len(summary["cases"])
        summary["completed_count"] = sum(x.get("status") == "completed" for x in summary["cases"])
        summary["failed_count"] = summary["attempted_count"] - summary["completed_count"]
        write_json(summary_path, summary)
    summary["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z") if summary.get("attempted_count", 0) >= len(tasks) else None
    write_json(summary_path, summary)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", action="append", choices=sorted(PROVIDERS))
    parser.add_argument("--output-root", type=Path, default=RUNS / "verigame-public-awesome")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--smoke", action="store_true", help="run one task per provider")
    args = parser.parse_args()
    if not TASKS.is_dir() or not SEED.is_dir() or not WORKER.is_file():
        raise SystemExit("VeriGame public-test prerequisites are missing")
    providers = args.provider or list(PROVIDERS)
    if args.smoke:
        original = task_dirs
        globals()["task_dirs"] = lambda _root: original(_root)[:1]
    for provider in providers:
        run_provider(provider, args.output_root.resolve(), args.timeout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
