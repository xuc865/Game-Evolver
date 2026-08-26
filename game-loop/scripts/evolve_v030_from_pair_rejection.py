#!/usr/bin/env python3
"""Feed a formal circuit rejection back into HPA and propose the next GOA trial."""

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
from game_loop.core.agent_circuit import AgentCircuit
from game_loop.core.agent_circuit_evolution import CircuitMutationEngine
from game_loop.core.agentx_runtime import EvidenceDrivenCircuitProposer
from game_loop.core.attribution import AttributionReport
from game_loop.core.harness import (
    HarnessEpochResult,
    HarnessEvolutionEngine,
    HarnessProfile,
)
from game_loop.core.harness_transformation_agent import (
    HarnessTransformationLibraryAgent,
)
from game_loop.core.harness_transformation_library import (
    HarnessTransformationLibraryStore,
)
from game_loop.runtime.deepseek_circuit import deepseek_role_runtime_contract
from game_loop.studio_server import StudioManager
from game_loop.utils import atomic_write_json, read_json


DEFAULT_SOURCE = ROOT / "experiments/studio-projects/v030-real-hpa-open-circuit-v9"
DEFAULT_INNER = (
    ROOT / "game_loop/product_assets/experiments/agentx/inner_harness_gcbench.json"
)


def _rejection_result(pair: dict, *, epoch: int) -> HarnessEpochResult:
    validation = dict(pair["rubric_validation"])
    utility = dict(pair["circuit_utility"])
    reasons = tuple(
        dict.fromkeys(
            [
                *[str(item) for item in validation.get("reasons", [])],
                *[str(item) for item in utility.get("reasons", [])],
            ]
        )
    )
    quality_delta = float(utility["quality_delta"])
    return HarnessEpochResult(
        epoch=epoch,
        parent_harness_id="v030-singleton-parent",
        candidate_harness_id="v030-open-circuit-candidate",
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
    source = args.source_run.resolve()
    output = args.output_dir.resolve()
    if output.exists() and args.force:
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    proof = read_json(source / "proof.json")
    pair = read_json(source / "formal-pair/paired-proof.json")
    if pair.get("infrastructure_ok") is not True or pair.get("accepted") is not False:
        raise ValueError("source pair must be an infrastructure-healthy formal rejection")
    parent_circuit = AgentCircuit.from_dict(dict(proof["parent_circuit"]))

    library_root = output / "hpa-library"
    if not library_root.exists():
        shutil.copytree(source / "hpa-library", library_root)
    store = HarnessTransformationLibraryStore(library_root)
    store.initialize()
    utility = dict(pair["circuit_utility"])
    stats = store.stats()
    transformation_id = str(proof["transaction"]["transformation_ids"][0])
    if 1 not in stats[transformation_id].attributed_epochs:
        store.record_use(
            transformation_ids=(transformation_id,),
            epoch=1,
            success=False,
            quality_delta=float(utility["quality_delta"]),
            cost_penalty=float(utility["cost_penalty"]),
            hard_regression=False,
        )

    config = HarnessEvolutionConfig.from_dict(read_json(args.inner_config))
    engine = HarnessEvolutionEngine(
        output / "engine",
        config,
        role_runtime_contract=deepseek_role_runtime_contract(),
    )
    latest = _rejection_result(pair, epoch=1)
    compiler = EvidenceDrivenCircuitProposer(store).compiler
    update = HarnessTransformationLibraryAgent(
        store,
        compiler=compiler,
        max_structural_actions=4,
        max_additions=2,
    ).evolve(
        epoch=2,
        inner_history=[
            {
                "inner": latest.to_dict(),
                "circuit_utility": utility,
            }
        ],
        latest_inner_result=latest,
        current_circuit=parent_circuit,
        harness_catalog=engine.role_harness_catalog(),
    )
    payload: dict[str, object] = {
        "schema": "v030-hpa-rejection-feedback.v1",
        "source_pair": str((source / "formal-pair/paired-proof.json").resolve()),
        "hpa_update": update.to_dict(),
        "library_revision": store.revision(),
        "library_stats": {
            key: value.to_dict() for key, value in store.stats().items()
        },
    }
    if update.applied:
        profile = HarnessProfile.from_dict(
            {
                "harness_id": "v030-singleton-parent",
                "agent_circuit": parent_circuit.to_dict(),
            }
        )
        transaction = EvidenceDrivenCircuitProposer(
            store,
            max_actions=4,
            bundle_width=1,
            compiler=compiler,
        ).propose_circuit(
            AttributionReport(
                run_refs=("inner://epoch/1/result",),
                outcome_counts={
                    "probe_failed": 1,
                    "interaction_quality_regression": 1,
                    "coordination_cost_regression": 1,
                },
                repeated_failures=("multi_agent_overhead_without_feature_gain",),
                infrastructure_events=0,
            ),
            proposer_harness=profile,
            target_harness=profile,
        )
        if transaction is not None:
            candidate = CircuitMutationEngine().apply(parent_circuit, transaction)
            payload.update(
                transaction=transaction.to_dict(),
                parent_circuit=parent_circuit.to_dict(),
                candidate_circuit=candidate.to_dict(),
                expanded=len(candidate.roles) > len(parent_circuit.roles),
            )
        else:
            payload["goa_error"] = "updated HPA library proposed no justified circuit"
    atomic_write_json(output / "proof.json", payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-run", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--inner-config", type=Path, default=DEFAULT_INNER)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    payload = run(args)
    update = dict(payload["hpa_update"])
    print(
        f"hpa_status={update.get('status')} revision={payload['library_revision']} "
        f"expanded={payload.get('expanded')} proof={args.output_dir.resolve() / 'proof.json'}"
    )
    return 0 if update.get("status") in {"applied", "no_change"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
