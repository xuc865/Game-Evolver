from __future__ import annotations

import argparse
import json
import re
import shlex
import subprocess
from pathlib import Path

from game_loop.runtime import GameTask, OpenGameRuntime
from .runtime_config import runtime_config_from_environment
from .sandbox import require_project_sandbox


PACKAGE_CONFIG_FILES = (
    "setup.py", "setup.cfg", "pyproject.toml", "requirements.txt",
    "requirements-dev.txt", "requirements-test.txt", "requirements_dev.txt",
    "requirements_test.txt", "tox.ini", "pytest.ini", "poetry.lock",
    "Pipfile", "Pipfile.lock", "MANIFEST.in", "manifest.in",
    "environment.yml", "conda-env.yaml",
)


def _load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate one NL2Repo task officially")
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--task-file", type=Path, required=True)  # compatibility/prompt trace
    parser.add_argument("--official-task-root", type=Path, required=True)
    parser.add_argument("--project-name", required=True)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--runtime-config-json")
    args = parser.parse_args(argv)

    repo_root = require_project_sandbox(args.repo_root, label="repo_root")
    output_manifest = require_project_sandbox(args.output_manifest, label="output_manifest")
    task_root = args.official_task_root.resolve()
    test_commands = [str(x) for x in _load_json(task_root / "test_commands.json")]
    test_files = [str(x) for x in _load_json(task_root / "test_files.json")]
    total = int((task_root / "test_case_count.txt").read_text(encoding="utf-8").strip())
    result_dir = repo_root.parent / "nl2repo_results"
    result_dir.mkdir(parents=True, exist_ok=True)
    runtime_config = runtime_config_from_environment(timeout_seconds=args.timeout)
    if args.runtime_config_json:
        from game_loop.runtime import OpenGameRuntimeConfig
        runtime_config = OpenGameRuntimeConfig.from_dict(json.loads(args.runtime_config_json))
    maker_task = GameTask(
        task_id=args.project_name,
        benchmark_id="nl2repo",
        prompt=args.task_file.resolve().read_text(encoding="utf-8"),
        task_source_ref=str(args.task_file.resolve()),
        workspace_seed_ref=str(repo_root),
        artifact_relpath=".",
    )
    maker = OpenGameRuntime(runtime_config)
    maker_submission = maker.run(maker_task, episode_dir=result_dir / "opengame_episode")
    artifact = Path(maker_submission.artifact_ref) if maker_submission.artifact_ref else None
    if maker_submission.status != "completed" or artifact is None:
        result = {"passed": False, "passed_count": 0, "total": total,
                  "failures": 0, "errors": maker_submission.diagnostics[:5],
                  "reward": 0.0, "infrastructure_error": True,
                  "project_name": args.project_name, "return_code": -1}
        (result_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        output_manifest.parent.mkdir(parents=True, exist_ok=True)
        output_manifest.write_text(json.dumps({**result, "result_dir": str(result_dir)}, indent=2) + "\n",
                                          encoding="utf-8")
        return 1
    repo_root = artifact.resolve()
    output_file = result_dir / "pytest_output.txt"
    script_file = result_dir / "official_eval.sh"

    remove_configs = " ".join(shlex.quote("/agent_copy/" + item) for item in PACKAGE_CONFIG_FILES)
    remove_tests = "\n".join(
        f"rm -rf {shlex.quote('/agent_copy/' + item)}" for item in test_files
    )
    commands = "\n".join(
        (
            f"(cd /workspace_eval && {cmd}) 2>&1 | "
            "tee -a /game_loop_result/pytest_output.txt\n"
            "command_rc=${PIPESTATUS[0]}\n"
            "if [ \"$command_rc\" -gt \"$overall_rc\" ]; then "
            "overall_rc=$command_rc; fi"
        )
        for cmd in test_commands
    )
    script_file.write_text(
        "#!/usr/bin/env bash\nset -e\nset -o pipefail\n"
        # Official NL2Repo images keep the private reference project and tests
        # in /workspace. Build a separate evaluation tree before overlaying the
        # candidate so the image's private tests are never exposed to OpenGame.
        "cp -a /workspace /workspace_eval\n"
        "cp -a /workspace_agent /agent_copy\n"
        f"rm -f {remove_configs}\n{remove_tests}\n"
        "cp -a /agent_copy/. /workspace_eval/\n"
        "export PYTHONPATH=/workspace_eval:${PYTHONPATH:-}\n"
        "set +e\noverall_rc=0\n"
        f"{commands}\nexit \"$overall_rc\"\n",
        encoding="utf-8",
    )
    image = f"ghcr.io/multimodal-art-projection/nl2repobench/{args.project_name}:1.0"
    command = ["docker", "run", "--rm", "-i", "--platform", "linux/amd64",
               "-v", f"{repo_root}:/workspace_agent:ro",
               "-v", f"{result_dir}:/game_loop_result", image,
               "bash", "-s"]
    error = ""
    docker_log = result_dir / "docker_driver.log"
    try:
        # Pytest output is already persisted by official_eval.sh.  Capturing the
        # duplicated docker stream here can retain unbounded output in RAM.
        with script_file.open("rb") as script, docker_log.open("wb") as log:
            proc = subprocess.run(
                command,
                stdin=script,
                stdout=subprocess.DEVNULL,
                stderr=log,
                timeout=args.timeout,
            )
        return_code = proc.returncode
        if return_code not in (0, 1):
            with docker_log.open("rb") as log:
                log.seek(max(0, docker_log.stat().st_size - 2000))
                error = log.read().decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return_code, error = -1, "timeout"
    except FileNotFoundError:
        return_code, error = -2, "docker not found"
    # Pytest summaries are at the end.  Keep parsing bounded even when a test
    # emits pathological amounts of output.
    if output_file.is_file():
        with output_file.open("rb") as output:
            output.seek(max(0, output_file.stat().st_size - 1024 * 1024))
            text = output.read().decode("utf-8", errors="replace")
    else:
        text = ""
    passed_matches = re.findall(r"(\d+) passed", text)
    failed_matches = re.findall(r"(\d+) failed", text)
    error_matches = re.findall(r"(\d+) error", text)
    passed_count = int(passed_matches[-1]) if passed_matches else 0
    failures = int(failed_matches[-1]) if failed_matches else 0
    errors = int(error_matches[-1]) if error_matches else 0
    reward = min(passed_count / total, 1.0) if total else 0.0
    infrastructure_error = (
        not output_file.is_file()
        or return_code not in (0, 1)
        or bool(error)
    )
    diagnostics = [error] if error else []
    if return_code not in (0, 1) and not diagnostics:
        diagnostics.append(f"pytest exited with code {return_code}")
    result = {"passed": reward >= 1.0 and not infrastructure_error,
              "passed_count": passed_count, "total": total, "failures": failures,
              "errors": diagnostics + ([f"{errors} pytest errors"] if errors else []),
              "reward": reward, "infrastructure_error": infrastructure_error,
              "project_name": args.project_name, "return_code": return_code,
              "artifact_ref": str(repo_root)}
    (result_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    output_manifest.write_text(json.dumps({**result, "result_dir": str(result_dir)}, indent=2) + "\n",
                                           encoding="utf-8")
    return 0 if not infrastructure_error else 1


if __name__ == "__main__":
    raise SystemExit(main())
