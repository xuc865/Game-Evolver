#!/usr/bin/env python3
"""Evolve dynamic fork targets from an infrastructure-healthy formal rejection."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.config import HarnessEvolutionConfig
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
)
DEFAULT_OUTER = ROOT / "experiments/agentx/outer_harness.json"


def _rejection_result(pair: dict, *, epoch: int) -> HarnessEpochResult:
    validation = dict(pair["rubric_validation"])
    utility = dict(pair["circuit_utility"])
    reasons = tuple(dict.fromkeys([
        *[str(item) for item in validation.get("reasons", [])],
        *[str(item) for item in utility.get("reasons", [])],
        (
            "A source-defined fixed team spent substantial coordination cost while its "
            "workspace-writing role produced no artifact. Prefer optional evidence-derived "
            "fork targets inside the singleton builder so the root writes immediately and "
            "delegates only bounded uncertainty or artifact slices."
        ),
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
    )


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
    store = OuterHarnessLibraryStore(output / "hpa-prototype-library")
    store.initialize(outer.element_catalog)
    current_ids = tuple(
        element_id
        for ids in outer.seed_elements.values()
        for element_id in ids
    )
    results = [
        _rejection_result(pair, epoch=index)
        for index, pair in enumerate(pairs, start=1)
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
                "circuit_utility": dict(pair["circuit_utility"]),
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
