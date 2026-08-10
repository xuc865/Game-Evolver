#!/usr/bin/env python3
"""Run official public benchmark commands in repository-local environments."""
from __future__ import annotations
import argparse, json, os, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def run(name: str, command: list[str], cwd: Path, timeout: int, env_extra: dict[str, str] | None = None) -> dict:
    started = datetime.now(timezone.utc).isoformat()
    try:
        env = dict(os.environ)
        if env_extra:
            env.update(env_extra)
        proc = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True,
                              timeout=timeout, check=False)
        combined = proc.stdout + "\n" + proc.stderr
        status, code, error = ("completed", proc.returncode, proc.stderr[-3000:])
        infra_markers = ("Infra Errors", "AuthenticationError", "infrastructure_failure",
                         "Dataset terminal-bench@2.1 not found", "No module named")
        if proc.returncode != 0 or any(marker in combined for marker in infra_markers):
            status = "infrastructure_failure"
        stdout_tail = proc.stdout[-3000:]
    except subprocess.TimeoutExpired:
        status, code, error, stdout_tail = "infrastructure_failure", -1, "timeout", ""
    except FileNotFoundError as exc:
        status, code, error, stdout_tail = "infrastructure_failure", -1, str(exc), ""
    return {"benchmark": name, "status": status, "return_code": code,
            "command": command, "stdout_tail": stdout_tail,
            "stderr_tail": error, "started_at": started}

def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, default=ROOT / "experiments/public-chain/report.json")
    p.add_argument("--terminal-tasks", type=int, default=1)
    p.add_argument("--terminal-dataset", default=None,
                   help="Harbor dataset name, e.g. terminal-bench/terminal-bench-2-1")
    p.add_argument("--tau-tasks", type=int, default=1)
    p.add_argument("--timeout", type=int, default=3600)
    p.add_argument("--terminal-task-root", type=Path,
                   default=ROOT / "third_party/terminal-bench-2/regex-log")
    p.add_argument("--nl2repo-task-root", type=Path,
                   default=ROOT / "third_party/NL2RepoBench/NL2RepoBench_src/test_files/pyperclip")
    a = p.parse_args()
    run_root = ROOT / "experiments" / "public-chain" / f"run-{time.time_ns()}"
    seed = run_root / "nl2repo-seed"
    seed.mkdir(parents=True, exist_ok=True)
    (seed / "main.py").write_text("# seed artifact\n", encoding="utf-8")
    terminal_workspace = run_root / "terminal-agent-workspace"
    terminal_workspace.mkdir(parents=True, exist_ok=True)
    (terminal_workspace / "instruction.md").write_text(
        (a.terminal_task_root / "instruction.md").read_text(encoding="utf-8"), encoding="utf-8"
    )
    results = [
        run("terminalbench-2.0-official-local-task" if not a.terminal_dataset else "terminalbench-2.1-official-dataset", [sys.executable, "-m", "game_loop.benchmarks.terminalbench_bridge",
            "--task-root", str(a.terminal_task_root), "--agent-workspace", str(terminal_workspace),
            "--instruction-file", str(terminal_workspace / "instruction.md"),
            "--output-manifest", str(run_root / "terminal-manifest.json"),
            *( ["--dataset", a.terminal_dataset] if a.terminal_dataset else [] )], ROOT, a.timeout,
            {"PYTHONPATH": str(ROOT)}),
        run("taubench-v1.0.1", [sys.executable, "-m", "game_loop.benchmarks.taubench_bridge",
            "--tau-root", str(ROOT / "third_party/tau2-bench"), "--domain", "airline",
            "--num-trials", "1", "--num-tasks", str(a.tau_tasks),
            "--output-manifest", str(run_root / "tau-manifest.json")], ROOT, a.timeout,
            {"PYTHONPATH": str(ROOT)}),
        run("nl2repobench", [sys.executable, "-m", "game_loop.benchmarks.nl2repo_bridge",
            "--repo-root", str(seed),
            "--task-file", str(a.nl2repo_task_root / "start.md"),
            "--official-task-root", str(a.nl2repo_task_root), "--project-name", a.nl2repo_task_root.name,
            "--output-manifest", str(run_root / "nl2repo-manifest.json")], ROOT, a.timeout,
            {"PYTHONPATH": str(ROOT)}),
    ]
    terminal = read_json(run_root / "terminal-manifest.json")
    tau_manifest = read_json(run_root / "tau-manifest.json")
    tau_result_ref = str(tau_manifest.get("result_path", ""))
    tau_raw_path = (
        Path(tau_result_ref).with_name("results.json")
        if tau_result_ref else run_root / "missing-tau-results.json"
    )
    tau_raw = read_json(tau_raw_path)
    tau_simulations = tau_raw.get("simulations", [])
    tau_info = tau_raw.get("info") if isinstance(tau_raw.get("info"), dict) else {}
    first_tau_simulation = next(
        (item for item in tau_simulations if isinstance(item, dict)), {}
    )
    nl2repo = read_json(run_root / "nl2repo-manifest.json")
    results[0]["evidence"] = {
        key: terminal.get(key)
        for key in ("solver", "agent_identity", "reward", "passed", "harbor_result")
    }
    results[1]["evidence"] = {
        "agent_identity": (
            tau_info.get("agent_info", {}).get("implementation")
            if isinstance(tau_info.get("agent_info"), dict) else None
        ),
        "reward": (
            first_tau_simulation.get("reward_info", {}).get("reward")
            if first_tau_simulation else tau_manifest.get("reward")
        ),
        "result_path": str(tau_raw_path) if tau_raw_path.is_file() else "",
    }
    results[2]["evidence"] = {
        key: nl2repo.get(key)
        for key in ("project_name", "reward", "passed", "passed_count", "total", "result_dir")
    }
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps({"scope": "public-command-chain", "results": results},
                                   indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0 if all(x["status"] == "completed" for x in results) else 1

if __name__ == "__main__":
    raise SystemExit(main())
