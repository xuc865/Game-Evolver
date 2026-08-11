#!/usr/bin/env python3
"""Stage an OpenGame web artifact and invoke the released GGV-Harness."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path


def _link(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        raise FileExistsError(target)
    target.symlink_to(source.resolve(), target_is_directory=True)


def run(
    *,
    official_root: Path,
    artifact_dir: Path,
    specification: Path,
    keypoints_md: Path,
    output_dir: Path,
    output_json: Path,
    game_name: str,
    run_id: str,
    backend: str,
    model: str,
    only_keypoints: str,
    min_keypoints: int,
    timeout: int,
) -> dict[str, object]:
    official_root = official_root.resolve()
    workspace = output_dir.resolve() / "official_workspace"
    if workspace.exists():
        raise FileExistsError(f"official evaluation workspace must be new: {workspace}")
    game = workspace / "games" / game_name
    shutil.copytree(
        artifact_dir.resolve(),
        game,
        ignore=shutil.ignore_patterns("node_modules"),
    )
    for required in ("package.json", "src", "data.md", "state_injection_api.md"):
        if not (game / required).exists():
            raise FileNotFoundError(f"OpenGame artifact lacks official GGV input: {required}")
    descriptions = workspace / "descriptions_example"
    descriptions.mkdir(parents=True)
    shutil.copy2(specification.resolve(), descriptions / f"{game_name}.md")
    shutil.copy2(keypoints_md.resolve(), game / "keypoints.md")
    _link(official_root / "skills", workspace / ".codex" / "skills")
    _link(official_root / "tools" / "playwright", workspace / "tools" / "playwright")

    python = official_root / ".venv" / "bin" / "python"
    command = [
        str(python),
        str(official_root / "harness" / "run_normal_eval.py"),
        "--workspace", str(workspace),
        "--game-name", game_name,
        "--run-id", run_id,
        "--backend", backend,
        "--keypoints-md", str(game / "keypoints.md"),
        "--min-keypoints", str(min_keypoints),
        "--max-workers", "3",
        "--keypoints-per-session", "1",
    ]
    if model:
        command.extend(["--model", model])
    if only_keypoints:
        command.extend(["--only-keypoints", only_keypoints])
    environment = dict(os.environ)
    environment["PATH"] = f"{official_root / '.venv' / 'bin'}:{environment.get('PATH', '')}"
    environment["PYTHONPATH"] = os.pathsep.join(
        part for part in (
            str(official_root / "scripts"),
            str(official_root),
            environment.get("PYTHONPATH", ""),
        ) if part
    )
    browser_cache = official_root.parents[1] / ".cache" / "gamegen-verifier-playwright-v1"
    if browser_cache.is_dir():
        environment["PLAYWRIGHT_BROWSERS_PATH"] = str(browser_cache)
    log_path = output_dir.resolve() / "official_ggv.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("wb") as log:
        completed = subprocess.run(
            command,
            cwd=official_root,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
    run_dir = workspace / "runs" / game_name / run_id
    rows: list[dict[str, object]] = []
    for path in sorted(run_dir.glob("keypoint_*/result.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        status = str(value.get("status", "")).upper()
        if status not in {"PASS", "FAIL", "INCOMPLETE"}:
            status = "PASS" if value.get("passed") is True else "FAIL" if value.get("passed") is False else "INCOMPLETE"
        rows.append({"keypoint": path.parent.name, "status": status, "result_ref": str(path)})
    incomplete = completed.returncode != 0 or not rows or any(row["status"] == "INCOMPLETE" for row in rows)
    passed = sum(row["status"] == "PASS" for row in rows)
    result: dict[str, object] = {
        "schema_version": "gamegen-verifier-official-v1",
        "implementation": "official-github-reference-implementation",
        "official_repository": "https://github.com/NetX-lab/GameGen-Verifier",
        "official_commit": (
            subprocess.check_output(
                ["git", "-C", str(official_root), "rev-parse", "HEAD"], text=True
            ).strip()
            if (official_root / ".git").exists()
            else None
        ),
        "official_source": "vendored-reference-tree",
        "status": "infrastructure_failure" if incomplete else "completed",
        "primary_score": None if incomplete else passed / len(rows),
        "objectives": {} if incomplete else {"keypoint_pass_rate": passed / len(rows)},
        "constraints": {
            "official_harness_completed": not incomplete,
            "state_injection_complete": not incomplete,
            "bounded_interactions_complete": not incomplete,
            "evidence_complete": not incomplete,
            "judge_complete": not incomplete,
        },
        "keypoint_results": rows,
        "run_dir": str(run_dir),
        "log_ref": str(log_path),
        "evaluator_return_code": completed.returncode,
    }
    output_json.resolve().parent.mkdir(parents=True, exist_ok=True)
    output_json.resolve().write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-root", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--specification", type=Path, required=True)
    parser.add_argument("--keypoints-md", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--game-name", default="opengame_smoke")
    parser.add_argument("--run-id", default="official_smoke")
    parser.add_argument("--backend", choices=("codex", "claude"), default="codex")
    parser.add_argument("--model", default="")
    parser.add_argument("--only-keypoints", default="")
    parser.add_argument("--min-keypoints", type=int, default=30)
    parser.add_argument("--timeout", type=int, default=7200)
    args = parser.parse_args(argv)
    result = run(
        official_root=args.official_root,
        artifact_dir=args.artifact_dir,
        specification=args.specification,
        keypoints_md=args.keypoints_md,
        output_dir=args.output_dir,
        output_json=args.output_json,
        game_name=args.game_name,
        run_id=args.run_id,
        backend=args.backend,
        model=args.model,
        only_keypoints=args.only_keypoints,
        min_keypoints=args.min_keypoints,
        timeout=args.timeout,
    )
    return 0 if result["status"] == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
