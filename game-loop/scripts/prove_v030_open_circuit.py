#!/usr/bin/env python3
"""Run the real HPA-to-GOA open-circuit admission proof."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.config import HarnessEvolutionConfig
from game_loop.core.agent_circuit_evolution import CircuitMutationEngine
from game_loop.core.agentx_runtime import EvidenceDrivenCircuitProposer
from game_loop.core.attribution import AttributionReport
from game_loop.core.harness import HarnessEpochResult, HarnessEvolutionEngine, HarnessProfile
from game_loop.core.harness_transformation_agent import HarnessTransformationLibraryAgent
from game_loop.core.harness_transformation_library import HarnessTransformationLibraryStore
from game_loop.runtime.deepseek_circuit import deepseek_role_runtime_contract
from game_loop.studio_server import StudioManager
from game_loop.utils import atomic_write_json, read_json


DEFAULT_CONFIG = ROOT / "game_loop/product_assets/experiments/agentx/inner_harness_gcbench.json"


def imperfect_result() -> HarnessEpochResult:
    return HarnessEpochResult(
        epoch=1,
        parent_harness_id="real-singleton-parent",
        candidate_harness_id="real-singleton-candidate",
        accepted=True,
        paired_deltas=(0.0,),
        median_delta=0.0,
        reasons=("valid ACCEPT with soft rubric below perfect",),
        excluded_pairs=(),
        parent_outcomes=(),
        candidate_outcomes=(),
        created_at="proof",
        rubric_validation={
            "infrastructure_ok": True,
            "case_results": [{
                "case_id": "studio-task",
                "candidate": {
                    "hard": {
                        "launches_without_crash": 1.0,
                        "produces_runnable_artifact": 1.0,
                    },
                    "soft": {
                        "gameplay_responsiveness": 0.62,
                        "feature_completeness": 0.58,
                        "visual_clarity": 0.55,
                        "overall_play_experience": 0.60,
                    },
                },
            }],
        },
    )


def run(args: argparse.Namespace) -> dict[str, object]:
    os.environ.update(StudioManager._runtime_environment())
    run_dir = args.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    config = HarnessEvolutionConfig.from_dict(read_json(args.inner_config))
    engine = HarnessEvolutionEngine(
        run_dir / "engine",
        config,
        role_runtime_contract=deepseek_role_runtime_contract(),
    )
    profile = HarnessProfile.from_dict(read_json(args.profile))
    store = HarnessTransformationLibraryStore(run_dir / "hpa-library")
    store.initialize(())
    compiler = EvidenceDrivenCircuitProposer(store).compiler
    agent = HarnessTransformationLibraryAgent(
        store,
        compiler=compiler,
        max_structural_actions=4,
        max_additions=2,
    )
    update = agent.evolve(
        epoch=1,
        inner_history=[],
        latest_inner_result=imperfect_result(),
        current_circuit=profile.effective_agent_circuit(),
        harness_catalog=engine.role_harness_catalog(),
    )
    payload: dict[str, object] = {"hpa_update": update.to_dict()}
    if not update.applied:
        atomic_write_json(run_dir / "proof.json", payload)
        return payload

    report = AttributionReport(
        run_refs=("inner://epoch/1/result",),
        outcome_counts={"probe_failed": 1},
        repeated_failures=(),
        infrastructure_events=0,
    )
    transaction = EvidenceDrivenCircuitProposer(
        store,
        max_actions=4,
        bundle_width=1,
        compiler=compiler,
    ).propose_circuit(
        report,
        proposer_harness=profile,
        target_harness=profile,
    )
    if transaction is None:
        payload["goa_error"] = "HPA library produced no evidence-matched GOA transaction"
        atomic_write_json(run_dir / "proof.json", payload)
        return payload
    candidate = CircuitMutationEngine().apply(
        profile.effective_agent_circuit(), transaction
    )
    payload.update(
        transaction=transaction.to_dict(),
        parent_circuit=profile.effective_agent_circuit().to_dict(),
        candidate_circuit=candidate.to_dict(),
        expanded=len(candidate.roles) > len(profile.effective_agent_circuit().roles),
        open_role_kinds=sorted({role.kind for role in candidate.roles}),
    )
    atomic_write_json(run_dir / "proof.json", payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--inner-config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    payload = run(args)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload.get("expanded") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
