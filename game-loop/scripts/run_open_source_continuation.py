#!/usr/bin/env python3
"""Run generic DeepSeek continuation episodes for non-Godot game projects."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
from pathlib import Path
from game_loop.core.continuation_admission import decide_paired_admission
from game_loop.core.game_design_charter import charter_section, load_design_charter

ROOT = Path(__file__).resolve().parents[1]
GOAL = """Improve the existing game every epoch through a substantive, implemented change.

Material-change contract:
- You must edit gameplay, interaction, progression, state, feedback, accessibility, reliability, or another player-visible/system behavior. Analysis alone is not a result.
- Do not finish with only documentation, comments, formatting, renamed labels, decorative overlays, or isolated cosmetic polish.
- The change must fit the game's design charter and appear in the correct gameplay context. Do not place gameplay HUD/panels on title or boot screens unless the charter explicitly calls for it.
- Preserve working features, run the strongest available build/runtime/tests, and give concrete evidence of the changed behavior.
- If a safe substantive improvement cannot be implemented and verified, report failure instead of claiming success."""

_NON_MATERIAL_SUFFIXES = {
    ".md", ".txt", ".rst", ".log", ".lock", ".jsonl",
}
_NON_MATERIAL_NAMES = {
    "license", "licence", "changelog", "contributing", "readme",
}


def _material_change(seed: Path, artifact: Path) -> dict:
    """Conservative inheritance gate: require a changed implementation/asset file."""

    ignored_parts = {".git", ".godot", "node_modules", "dist", "build", "__pycache__", ".pytest_cache", ".qwen", ".dsh", ".agents", "screenshots"}

    def inventory(root: Path) -> dict[str, str]:
        result: dict[str, str] = {}
        if not root.is_dir():
            return result
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            relative = path.relative_to(root)
            if any(part in ignored_parts for part in relative.parts):
                continue
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError:
                continue
            result[relative.as_posix()] = digest
        return result

    before = inventory(seed)
    after = inventory(artifact)
    changed = sorted(name for name in set(before) | set(after) if before.get(name) != after.get(name))
    material = []
    for name in changed:
        path = Path(name)
        if path.suffix.casefold() in _NON_MATERIAL_SUFFIXES:
            continue
        if path.stem.casefold() in _NON_MATERIAL_NAMES:
            continue
        material.append(name)
    return {
        "passed": bool(material),
        "changed_file_count": len(changed),
        "material_file_count": len(material),
        "material_files": material[:50],
    }

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--task-file", type=Path, required=True)
    p.add_argument("--seed", type=Path, required=True)
    p.add_argument("--run-dir", type=Path, required=True)
    p.add_argument("--profile", type=Path, required=True)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--benchmark", default="verigame")
    p.add_argument("--artifact-relpath", default=".")
    p.add_argument("--design-charter", type=Path,
                   help="Frozen human design guidance for this game.")
    p.add_argument("--max-tokens", type=int, default=None,
                   help="Override the DeepSeek runtime profile token budget.")
    p.add_argument("--ab-evaluator-profile", type=Path,
                   help="JSON command profile that evaluates parent and candidate under identical conditions.")
    p.add_argument("--minimum-score-delta", type=float, default=0.0,
                   help="Candidate score must improve by more than this amount.")
    args = p.parse_args()
    root = args.run_dir.resolve(); root.mkdir(parents=True, exist_ok=True)
    profile_path = args.profile.resolve()
    if args.max_tokens is not None:
        profile_payload = json.loads(profile_path.read_text(encoding="utf-8"))
        profile_payload["max_tokens"] = int(args.max_tokens)
        profile_path = root / "runtime-profile.override.json"
        profile_path.write_text(json.dumps(profile_payload, indent=2) + "\n", encoding="utf-8")
    state_path = root / "continuation-state.json"
    state = json.loads(state_path.read_text()) if state_path.is_file() else {"schema":"game-evolver.continuation.v1","next_epoch":1,"seed":str(args.seed.resolve()),"epochs":[]}
    seed = Path(state.get("seed", str(args.seed.resolve()))).resolve()
    child: subprocess.Popen | None = None

    def _stop_child(signum, _frame):
        nonlocal child
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    child.kill()
        raise SystemExit(128 + int(signum))

    signal.signal(signal.SIGTERM, _stop_child)
    signal.signal(signal.SIGINT, _stop_child)

    for epoch in range(int(state["next_epoch"]), args.epochs + 1):
        episode = root / f"epoch_{epoch:03d}"
        episode.mkdir(parents=True, exist_ok=True)
        if any(episode.iterdir()):
            raise RuntimeError(f"episode directory must be empty: {episode}")
        prompt = args.task_file.read_text(encoding="utf-8").rstrip()
        if args.design_charter:
            prompt += charter_section(load_design_charter(args.design_charter))
        prompt += "\n\n## Evolution goal\n\n" + GOAL
        command = [sys.executable, "-m", "game_loop.inner_loop", "run", "--benchmark", args.benchmark, "--task-source", str(args.task_file.resolve()), "--seed-artifact", str(seed), "--run-dir", str(episode), "--profile", str(profile_path), "--prompt", prompt, "--artifact-relpath", args.artifact_relpath]
        env = dict(os.environ); env.setdefault("DEEPSEEK_ROUTE_MODE", "mixed")
        child = subprocess.Popen(command, cwd=ROOT, env=env, start_new_session=True)
        result_code = child.wait()
        result = subprocess.CompletedProcess(command, result_code)
        child = None
        submission_path = episode / "submission.json"
        row = {"epoch": epoch, "run_dir": str(episode), "exit_code": result.returncode}
        if submission_path.is_file():
            submission = json.loads(submission_path.read_text()); row["status"] = submission.get("status"); row["artifact_ref"] = submission.get("artifact_ref")
            # A completed episode is not automatically an accepted evolution.
            # Only an explicit acceptance marker may advance the continuation
            # seed; absent/false means the next epoch retries the same seed.
            accepted = submission.get("accepted")
            if submission.get("status") == "completed" and submission.get("artifact_ref"):
                artifact = Path(str(submission["artifact_ref"])).resolve()
                row["material_change"] = _material_change(seed, artifact)
                paired = _run_paired_evaluator(
                    profile_path=args.ab_evaluator_profile,
                    parent=seed,
                    candidate=artifact,
                    episode=episode,
                    environment=env,
                )
                acceptance = decide_paired_admission(
                    paired,
                    material_change=bool(row["material_change"]["passed"]),
                    minimum_delta=args.minimum_score_delta,
                )
                accepted = bool(acceptance["accepted"])
                row["accepted"] = accepted
                row["acceptance"] = acceptance
                submission["accepted"] = accepted
                submission["acceptance"] = acceptance
                submission_path.write_text(json.dumps(submission, indent=2) + "\n", encoding="utf-8")
                # Explicit evaluator acceptance and a real implementation/asset
                # change are both required before continuation inheritance.
                if accepted and row["material_change"]["passed"]:
                    seed = artifact; state["seed"] = str(seed)
        state["epochs"].append(row); state["next_epoch"] = epoch + 1; state_path.write_text(json.dumps(state,indent=2)+"\n")
    return 0


def _run_paired_evaluator(
    *,
    profile_path: Path | None,
    parent: Path,
    candidate: Path,
    episode: Path,
    environment: dict[str, str],
) -> dict | None:
    if profile_path is None:
        return None
    profile = json.loads(profile_path.resolve().read_text(encoding="utf-8"))
    context = {
        "parent": str(parent.resolve()),
        "candidate": str(candidate.resolve()),
        "episode": str(episode.resolve()),
    }
    output = episode / "paired-evaluation"
    output.mkdir(parents=True, exist_ok=True)
    context["output"] = str(output.resolve())
    command = [str(part).format_map(context) for part in profile["command"]]
    try:
        completed = subprocess.run(
            command,
            cwd=Path(str(profile.get("cwd", ROOT))).resolve(),
            env={**environment, **{str(k): str(v) for k, v in profile.get("environment", {}).items()}},
            timeout=int(profile.get("timeout_seconds", 900)),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"infrastructure_ok": False, "passed": False, "error": str(exc)}
    if completed.returncode != 0:
        return {"infrastructure_ok": False, "passed": False, "error": f"evaluator exit {completed.returncode}"}
    result_path = Path(str(profile["result_path"]).format_map({**context, "output": str(output)}))
    if not result_path.is_absolute():
        result_path = output / result_path
    if not result_path.is_file():
        return {"infrastructure_ok": False, "passed": False, "error": "paired result missing"}
    return json.loads(result_path.read_text(encoding="utf-8"))

if __name__ == "__main__": raise SystemExit(main())
