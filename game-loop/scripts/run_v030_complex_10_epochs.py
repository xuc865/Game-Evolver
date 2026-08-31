#!/usr/bin/env python3
"""Run a resumable ten-epoch dynamic-fork experiment on a complex game task."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAIR_RUNNER = ROOT / "scripts/evaluate_v030_dynamic_fork_pair.py"
HPA_RUNNER = ROOT / "scripts/evolve_v030_subagent_prototypes.py"
DEFAULT_HPA = ROOT / "experiments/complex-game-multiagent-v030/hpa-after-correct-case-and-polaris-v7/proof.json"
DEFAULT_PROFILE = ROOT / "experiments/inner-agent/deepseek-harness-profile.local.json"
DEFAULT_INNER = ROOT / "experiments/agentx/inner_harness_gcbench.json"


def _run(command: list[str], *, log: Path, environment: dict[str, str]) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w", encoding="utf-8") as handle:
        result = subprocess.run(
            command,
            cwd=ROOT,
            env=environment,
            stdout=handle,
            stderr=subprocess.STDOUT,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}")


def _proof(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def run(args: argparse.Namespace) -> dict:
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    state_path = output / "ten-epoch-state.json"
    state = _proof(state_path) if state_path.is_file() else {
        "schema": "v030-complex-ten-epoch-run.v1",
        "next_epoch": 1,
        "epochs": [],
        "hpa_proof": str(args.hpa_proof.resolve()),
    }
    environment = dict(os.environ)
    environment.update({
        "DEEPSEEK_ROUTE_MODE": "mixed",
        "DEEPSEEK_POLARIS_BASE_URL": args.polaris_base_url,
        "DEEPSEEK_POLARIS_API_KEY": args.polaris_api_key,
        "DEEPSEEK_POLARIS_MODEL": args.polaris_model,
        "GAME_LOOP_PROVIDER_KEY_SALT": args.provider_salt,
    })
    for epoch in range(int(state["next_epoch"]), args.epochs + 1):
        epoch_dir = output / f"epoch_{epoch:03d}"
        pair_dir = epoch_dir / "pair"
        hpa_proof = Path(str(state["hpa_proof"]))
        if not hpa_proof.is_absolute():
            hpa_proof = (ROOT / hpa_proof).resolve()
        try:
            _run([
                sys.executable, str(PAIR_RUNNER),
                "--force", "--regenerate-parent",
                "--hpa-proof", str(hpa_proof),
                "--task-file", str(args.task_file.resolve()),
                "--seed", str(args.seed.resolve()),
                "--runtime-profile", str(args.runtime_profile.resolve()),
                "--inner-config", str(args.inner_config.resolve()),
                "--output-dir", str(pair_dir),
                "--wall-timeout-seconds", str(args.wall_timeout_seconds),
                "--max-tokens", str(args.max_tokens),
                "--reasoning-effort", args.reasoning_effort,
            ], log=epoch_dir / "pair.log", environment=environment)
            pair = _proof(pair_dir / "paired-proof.json")
            if pair.get("infrastructure_ok") is not True:
                raise RuntimeError("pair infrastructure failure; evolution chain stopped")

            next_hpa = hpa_proof
            hpa_status = "carried"
            if pair.get("accepted") is not True:
                hpa_dir = epoch_dir / "hpa"
                _run([
                    sys.executable, str(HPA_RUNNER),
                    "--pair", str(pair_dir / "paired-proof.json"),
                    "--seed-proof", str(hpa_proof),
                    "--outer-config", str(args.outer_config.resolve()),
                    "--output-dir", str(hpa_dir),
                    "--force",
                ], log=epoch_dir / "hpa.log", environment=environment)
                next_hpa = hpa_dir / "proof.json"
                hpa_status = _proof(next_hpa).get("hpa_update", {}).get("status", "unknown")
            state["epochs"].append({
                "epoch": epoch,
                "pair": str((pair_dir / "paired-proof.json").resolve()),
                "accepted": pair.get("accepted"),
                "hpa_status": hpa_status,
                "parent_baseline": pair.get("parent_baseline"),
                "fork_usage": pair.get("fork_usage"),
                "utility": pair.get("utility"),
            })
            state["hpa_proof"] = str(next_hpa.resolve())
            state["next_epoch"] = epoch + 1
            state_path.write_text(json.dumps(state, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        except Exception as exc:
            state["blocked_at_epoch"] = epoch
            state["blocked_reason"] = str(exc)
            state_path.write_text(json.dumps(state, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
            raise
    return state


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-file", type=Path, required=True)
    parser.add_argument("--seed", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--hpa-proof", type=Path, default=DEFAULT_HPA)
    parser.add_argument("--outer-config", type=Path, default=ROOT / "game_loop/product_assets/experiments/agentx/outer_harness.json")
    parser.add_argument("--runtime-profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--inner-config", type=Path, default=DEFAULT_INNER)
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--wall-timeout-seconds", type=int, default=1800)
    parser.add_argument("--max-tokens", type=int, default=49152)
    parser.add_argument("--reasoning-effort", choices=("off", "low", "max"), default="max")
    parser.add_argument("--polaris-base-url", default="http://kaiwu.llm.dsv4flash0731.polaris:8080/v1/chat/completions")
    parser.add_argument("--polaris-api-key", required=True)
    parser.add_argument("--polaris-model", default="kaiwu-llm-model")
    parser.add_argument("--provider-salt", default="v030-complex-ten-epoch")
    args = parser.parse_args()
    result = run(args)
    print(f"completed_epochs={len(result['epochs'])} next_epoch={result['next_epoch']} state={args.output_dir.resolve() / 'ten-epoch-state.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
