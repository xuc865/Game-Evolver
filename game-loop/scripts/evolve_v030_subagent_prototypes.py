#!/usr/bin/env python3
"""Evolve dynamic fork targets from an infrastructure-healthy formal rejection."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.config import HarnessElementConfig, HarnessEvolutionConfig
from game_loop.core.harness import HarnessEpochResult
from game_loop.core.outer_harness_library import (
    OuterHarnessLibraryAgent,
    OuterHarnessLibraryStore,
)
from game_loop.studio_server import StudioManager
from game_loop.utils import atomic_write_json, read_json


DEFAULT_PAIRS = (
    ROOT / "experiments/studio-projects/v030-real-hpa-open-circuit-v9/formal-pair/paired-proof.json",
    ROOT / "experiments/studio-projects/v030-real-hpa-open-circuit-v10/formal-pair/paired-proof.json",
    (
        ROOT
        / "experiments/complex-game-multiagent-v030"
        / "auto-chess-transfer-v5-restart-controlled-formal/paired-proof.json"
    ),
    (
        ROOT
        / "experiments/complex-game-multiagent-v030"
        / "dynamic-fork-auto-chess-formal-v1/paired-proof.json"
    ),
)
DEFAULT_OUTER = ROOT / "experiments/agentx/outer_harness.json"
DEFAULT_SEED_PROOF = (
    ROOT
    / "experiments/complex-game-multiagent-v030"
    / "dynamic-fork-hpa-v7/proof.json"
)


def _pair_utility(pair: dict) -> dict:
    utility = pair.get("circuit_utility", pair.get("utility", {}))
    if not isinstance(utility, dict) or "quality_delta" not in utility:
        raise ValueError("source pair lacks formal utility evidence")
    return dict(utility)


def _fork_usage(pair_path: Path) -> dict[str, object]:
    sessions = sorted((pair_path.parent / "candidate-runtime" / "sessions").rglob("*.zstd"))
    calls: list[str] = []
    for session in sessions:
        completed = subprocess.run(
            ["zstdcat", str(session)],
            check=True,
            capture_output=True,
            text=True,
        )
        for line in completed.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "tool/call":
                continue
            name = str(dict(event.get("data", {})).get("name", ""))
            if name == "subagent" or name.startswith("fork_agent_"):
                calls.append(name)
    return {
        "fork_tool_calls": calls,
        "fork_tool_call_count": len(calls),
        "session_file_count": len(sessions),
    }


def _rejection_result(
    pair: dict,
    *,
    pair_path: Path,
    epoch: int,
) -> tuple[HarnessEpochResult, dict[str, object] | None]:
    validation = dict(pair["rubric_validation"])
    utility = _pair_utility(pair)
    usage = None
    evidence_note = (
        "The formal candidate failed admission. Use the disclosed rubric gaps and "
        "measured marginal cost to evolve the smallest reusable behavior object."
    )
    if pair.get("source_hpa_proof"):
        recorded_usage = pair.get("fork_usage")
        usage = (
            dict(recorded_usage)
            if isinstance(recorded_usage, dict)
            else _fork_usage(pair_path)
        )
        evidence_note = (
            "The formal candidate exposed an HPA-evolved child job, but trajectory evidence "
            f"recorded {usage['fork_tool_call_count']} fork tool calls, quality delta "
            f"{utility['quality_delta']}, and net utility {utility.get('net_utility')}. "
            "Evolve a more task-legible bounded child job if evidence supports one; fork "
            "mechanics are not part of the decision."
        )
    reasons = tuple(dict.fromkeys([
        *[str(item) for item in validation.get("reasons", [])],
        *[str(item) for item in utility.get("reasons", [])],
        evidence_note,
    ]))
    quality_delta = float(utility["quality_delta"])
    return HarnessEpochResult(
        epoch=epoch,
        parent_harness_id="v030-singleton-parent",
        candidate_harness_id="v030-fixed-team-candidate",
        accepted=False,
        paired_deltas=(quality_delta,),
        median_delta=quality_delta,
        reasons=reasons,
        excluded_pairs=(),
        parent_outcomes=(),
        candidate_outcomes=(),
        created_at="formal-pair-rejection",
        rubric_validation=validation,
    ), usage


def run(args: argparse.Namespace) -> dict[str, object]:
    os.environ.update(StudioManager._runtime_environment())
    output = args.output_dir.resolve()
    if output.exists() and args.force:
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)

    pair_paths = tuple(args.pair or DEFAULT_PAIRS)
    pairs = [read_json(path) for path in pair_paths]
    if any(
        pair.get("infrastructure_ok") is not True
        or pair.get("accepted") is not False
        for pair in pairs
    ):
        raise ValueError("source pairs must be infrastructure-healthy formal rejections")
    outer = HarnessEvolutionConfig.from_dict(read_json(args.outer_config))
    seed_proof = read_json(args.seed_proof)
    seed_prototypes = tuple(
        HarnessElementConfig.from_dict({
            "id": item["id"],
            "category": "subagent",
            "description": item["description"],
            "spec": {
                key: value
                for key, value in item.items()
                if key not in {"id", "description"}
            },
            "tags": ["subagent", "evidence_evolved"],
        })
        for item in seed_proof.get("subagent_prototypes", [])
    )
    store = OuterHarnessLibraryStore(output / "hpa-prototype-library")
    store.initialize((*outer.element_catalog, *seed_prototypes))
    current_ids = tuple(
        element_id
        for ids in outer.seed_elements.values()
        for element_id in ids
    )
    result_rows = [
        _rejection_result(pair, pair_path=path, epoch=index)
        for index, (path, pair) in enumerate(zip(pair_paths, pairs), start=1)
    ]
    results = [result for result, _usage in result_rows]
    fork_usage = [
        {"source_pair": str(path.resolve()), **usage}
        for path, (_result, usage) in zip(pair_paths, result_rows)
        if usage is not None
    ]
    latest = results[-1]
    update = OuterHarnessLibraryAgent(
        store,
        max_structural_actions=4,
        max_additions=2,
    ).evolve(
        epoch=len(results) + 1,
        inner_history=[
            {
                "inner": result.to_dict(),
                "utility": _pair_utility(pair),
            }
            for result, pair in zip(results, pairs)
        ],
        latest_inner_result=latest,
        current_inner_element_ids=current_ids,
    )
    prototypes = [
        {
            "id": item.element_id,
            "description": item.description,
            **dict(item.spec),
        }
        for item in store.catalog().values()
        if item.category == "subagent"
    ]
    payload: dict[str, object] = {
        "schema": "v030-dynamic-fork-hpa-proof.v1",
        "source_pairs": [str(path.resolve()) for path in pair_paths],
        "seed_proof": str(args.seed_proof.resolve()),
        "fork_usage_evidence": fork_usage,
        "hpa_update": update.to_dict(),
        "library_revision": store.revision(),
        "subagent_prototypes": prototypes,
        "prototype_count": len(prototypes),
    }
    atomic_write_json(output / "proof.json", payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pair", type=Path, action="append")
    parser.add_argument("--outer-config", type=Path, default=DEFAULT_OUTER)
    parser.add_argument("--seed-proof", type=Path, default=DEFAULT_SEED_PROOF)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    payload = run(args)
    update = dict(payload["hpa_update"])
    print(
        f"hpa_status={update.get('status')} revision={payload['library_revision']} "
        f"prototype_count={payload['prototype_count']} "
        f"proof={args.output_dir.resolve() / 'proof.json'}"
    )
    return 0 if update.get("status") in {"applied", "unchanged"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
