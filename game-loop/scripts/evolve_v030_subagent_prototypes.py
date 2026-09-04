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
from game_loop.core.subagent_evolution import PrototypeEvidenceStore
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
        / "dynamic-fork-auto-chess-formal-v2-full-coverage-rescore/paired-proof.json"
    ),
)
DEFAULT_OUTER = ROOT / "experiments/agentx/outer_harness.json"
DEFAULT_SEED_PROOF = (
    ROOT
    / "experiments/complex-game-multiagent-v030"
    / "dynamic-fork-hpa-v11-eligibility-retry/proof.json"
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


def _delegation_reasoning_evidence(pair_path: Path) -> list[str]:
    """Extract bounded root explanations about why an exposed child was not used."""

    excerpts: list[str] = []
    sessions = sorted((pair_path.parent / "candidate-runtime" / "sessions").rglob("*.zstd"))
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
            if event.get("type") != "assistant/message":
                continue
            message = dict(dict(event.get("data", {})).get("message", {}))
            blocks = message.get("content", [])
            if not isinstance(blocks, list):
                continue
            for block in blocks:
                if not isinstance(block, dict) or block.get("type") != "reasoning":
                    continue
                text = " ".join(str(block.get("text", "")).split())
                folded = text.casefold()
                delegation_term = any(term in folded for term in ("delegat", "fork", "child"))
                boundary_term = any(
                    term in folded
                    for term in (
                        "integrat",
                        "tightly coupled",
                        "independent",
                        "shared interface",
                        "shared state",
                    )
                )
                if delegation_term and boundary_term:
                    excerpts.append(text[:800])
                    if len(excerpts) == 3:
                        return excerpts
    return excerpts


def _prototype_non_adoption_diagnostics(prototype: dict) -> dict[str, object]:
    description = str(prototype.get("description", ""))
    persona = str(prototype.get("persona", ""))
    text = f"{description} {persona}".casefold()
    artifact_job = any(
        term in text
        for term in ("artifact", "implement", "patch", "code", "mechanic")
    )
    all_writes_retained_by_root = any(
        term in text
        for term in (
            "parent retains all workspace writing",
            "without requiring workspace ownership",
            "do not alter the overall harness",
        )
    )
    explicit_bounded_slice_ownership = (
        "own" in text
        and any(
            term in text
            for term in ("delegated artifact slice", "assigned artifact slice")
        )
    )
    subjective_marginal_value_gate = any(
        term in text
        for term in (
            "clear marginal value",
            "sufficient marginal value",
            "worth delegating",
        )
    )
    forbids_later_root_integration = any(
        term in text
        for term in (
            "without whole-artifact integration",
            "without whole artifact integration",
            "can pass without integration",
        )
    )
    permits_root_interface_adaptation = any(
        term in text
        for term in (
            "root adapts shared interfaces",
            "root adapts its consumers",
            "root integrates the slice through shared interfaces",
            "root may adapt shared interfaces",
            "root-side adaptation",
        )
    )
    return {
        "artifact_producing_job": artifact_job,
        "all_workspace_writes_retained_or_disclaimed": all_writes_retained_by_root,
        "explicit_bounded_slice_ownership": explicit_bounded_slice_ownership,
        "artifact_ownership_mismatch": (
            artifact_job
            and all_writes_retained_by_root
            and not explicit_bounded_slice_ownership
        ),
        "subjective_marginal_value_gate": subjective_marginal_value_gate,
        "integration_boundary_overconstraint": (
            artifact_job
            and forbids_later_root_integration
            and not permits_root_interface_adaptation
        ),
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
        exposed_prototype_ids = [
            str(item.get("id", ""))
            for item in pair.get("prototypes", [])
            if isinstance(item, dict) and item.get("id")
        ]
        prototype_diagnostics = {
            str(item["id"]): _prototype_non_adoption_diagnostics(item)
            for item in pair.get("prototypes", [])
            if isinstance(item, dict) and item.get("id")
        }
        delegation_reasoning = _delegation_reasoning_evidence(pair_path)
        visibility = dict(pair.get("root_contract_visibility", {}))
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
            f"The exposed existing prototype ids were {exposed_prototype_ids}. Fork is optional "
            "for formal acceptance; zero invocation alone is neither an admission failure "
            "nor proof of a defective prototype. Treat zero invocation as non-adoption evidence "
            "about usage, and check whether root-only integration was appropriate: "
            f"their general contract diagnostics were {prototype_diagnostics}. An "
            "artifact_ownership_mismatch means an artifact-producing child is presented as "
            "unable to own even its explicitly delegated slice, making it advisory-only. "
            f"The persisted root request-header audit was verified={visibility.get('verified')}, "
            f"generic_subagent_present={visibility.get('generic_subagent_present')}, and "
            f"model_visible_tools={visibility.get('model_visible_tools', [])}. When the evolved "
            "tool was the only model-visible delegation entry and still received zero calls, "
            "treat a subjective_marginal_value_gate as a trigger defect: replace it with "
            "observable task-structure conditions such as an existing bounded module or artifact "
            "boundary, locally runnable acceptance checks, and competing independent required "
            "slices. Do not promise or presuppose the unknown utility of delegation. "
            "Treat integration_boundary_overconstraint as a boundary defect: a child-owned "
            "artifact slice may implement against an existing interface and pass its local "
            "checks even when the root must later adapt shared interfaces or consumers, "
            "integrate the slice, and run whole-artifact verification. Do not require the "
            "slice to be globally integration-free. "
            f"Audited root delegation reasoning excerpts were {delegation_reasoning}. "
            "inspect and repair their reusable trigger, owned scope, direct deliverable, and "
            "handoff value before adding another context, protocol, gate, reminder, or metric. "
            "Never force or quota fork calls to satisfy admission evidence. Prioritize the "
            "actual rubric, quality and cost failures; repair delegation only when independent "
            "contract or task-boundary evidence supports that diagnosis. "
            "If evidence supports another child, make its reusable delegation trigger, bounded "
            "scope, independent deliverable, observable completion evidence, and root handoff "
            "explicit; fork mechanics are not part of the decision. When an adopted fork has "
            "positive quality delta but negative net utility, prefer the smallest sufficient "
            "slice and an immediate local handoff so the root preserves budget for whole-artifact "
            "verification; do not turn this cost lesson into a fixed child-count quota."
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


def _current_element_ids(
    seed_proof: dict[str, object],
    outer: HarnessEvolutionConfig,
) -> tuple[str, ...]:
    known_ids = {item.element_id for item in outer.element_catalog}
    prior_update = seed_proof.get("hpa_update", {})
    prior_current_ids = (
        prior_update.get("next_inner_element_ids")
        if isinstance(prior_update, dict)
        else None
    )
    fallback_current_ids = tuple(
        element_id
        for ids in outer.seed_elements.values()
        for element_id in ids
    )
    active_prototype_ids = tuple(
        str(item.get("id", ""))
        for item in seed_proof.get("subagent_prototypes", [])
        if isinstance(item, dict) and item.get("id")
    )
    return tuple(dict.fromkeys(
        item
        for item in (
            *(prior_current_ids or fallback_current_ids),
            *active_prototype_ids,
        )
        if item in known_ids
    ))


def _non_adopted_prototype_ids(pairs: list[dict]) -> tuple[str, ...]:
    ids: list[str] = []
    for pair in pairs:
        if not pair.get("source_hpa_proof"):
            continue
        usage = pair.get("fork_usage")
        if not isinstance(usage, dict) or int(
            usage.get("fork_tool_call_count", 0)
        ) != 0:
            continue
        for prototype in pair.get("prototypes", []):
            if not isinstance(prototype, dict) or not prototype.get("id"):
                continue
            prototype_id = str(prototype["id"])
            if prototype_id not in ids:
                ids.append(prototype_id)
    return tuple(ids)


def _required_non_adoption_repair_ids(pairs: list[dict]) -> tuple[str, ...]:
    ids: list[str] = []
    non_adopted = set(_non_adopted_prototype_ids(pairs))
    for pair in pairs:
        for prototype in pair.get("prototypes", []):
            if not isinstance(prototype, dict) or not prototype.get("id"):
                continue
            prototype_id = str(prototype["id"])
            visibility = dict(pair.get("root_contract_visibility", {}))
            diagnostics = _prototype_non_adoption_diagnostics(prototype)
            trigger_defect = (
                visibility.get("verified") is True
                and visibility.get("generic_subagent_present") is False
                and (
                    diagnostics["subjective_marginal_value_gate"] is True
                    or diagnostics["integration_boundary_overconstraint"] is True
                )
            )
            if (
                prototype_id in non_adopted
                and (
                    diagnostics["artifact_ownership_mismatch"] is True
                    or trigger_defect
                )
                and prototype_id not in ids
            ):
                ids.append(prototype_id)
    return tuple(ids)


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
    raw_seed_library = seed_proof.get("library_elements")
    if args.seed_catalog is not None:
        catalog_payload = read_json(args.seed_catalog)
        raw_seed_library = catalog_payload.get("items", [])
    if raw_seed_library is not None:
        if not isinstance(raw_seed_library, list):
            raise ValueError("seed library elements must be a list")
        seed_elements = tuple(
            HarnessElementConfig.from_dict(dict(item)) for item in raw_seed_library
        )
    else:
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
        seed_elements = (*outer.element_catalog, *seed_prototypes)
    library_root = output / "hpa-prototype-library"
    if args.seed_library is not None:
        if not args.seed_library.is_dir():
            raise ValueError(f"seed library does not exist: {args.seed_library}")
        shutil.copytree(args.seed_library, library_root)
    store = OuterHarnessLibraryStore(library_root)
    store.initialize(seed_elements)
    evidence_store = PrototypeEvidenceStore(output / "prototype-evidence.json").load()
    current_ids = _current_element_ids(seed_proof, outer)
    non_adopted_ids = _non_adopted_prototype_ids(pairs)
    required_repair_ids = _required_non_adoption_repair_ids(pairs)
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
    for pair, (_result, usage) in zip(pairs, result_rows):
        if usage is None:
            continue
        prototype_ids = [
            str(item["id"])
            for item in pair.get("prototypes", [])
            if isinstance(item, dict) and item.get("id")
        ]
        utility = _pair_utility(pair)
        evidence_store.observe_pair(
            prototype_ids=prototype_ids,
            fork_calls=int(usage.get("fork_tool_call_count", 0)),
            fork_results=len(usage.get("fork_results", [])),
            adopted=len(usage.get("post_fork_root_actions", [])),
            quality_delta=float(utility["quality_delta"]),
            cost=utility.get("cost_penalty"),
            boundary=str(
                pair.get("case_id") or pair.get("task_id") or "unknown"
            ),
            lesson=(
                "A fork was invoked and its result was followed by a root mutation."
                if usage.get("post_fork_root_actions")
                else (
                    "A child completed and delivered a handoff; root-side editing was "
                    "not needed to count the contribution."
                    if usage.get("adopted_fork_count")
                    else "A fork was invoked, but no completed child handoff was observed."
                )
            ),
        )
    evidence_store.save()
    latest = results[-1]
    prior_library_epochs = [
        int(path.stem.removeprefix("epoch_"))
        for path in store.epochs_dir.glob("epoch_*.json")
        if path.stem.removeprefix("epoch_").isdigit()
    ]
    evolution_epoch = max([len(results), *prior_library_epochs]) + 1
    update = OuterHarnessLibraryAgent(
        store,
        max_structural_actions=4,
        max_additions=2,
    ).evolve(
        epoch=evolution_epoch,
        inner_history=[
            {
                "inner": result.to_dict(),
                "utility": _pair_utility(pair),
            }
            for result, pair in zip(results, pairs)
        ],
        latest_inner_result=latest,
        current_inner_element_ids=current_ids,
        non_adopted_element_ids=non_adopted_ids,
        required_non_adoption_repair_ids=required_repair_ids,
        prototype_evidence=evidence_store.summary(),
        evolution_goal=args.evolution_goal,
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
    library_elements = [
        {
            "id": item.element_id,
            "category": item.category,
            "description": item.description,
            "spec": dict(item.spec),
            "tags": list(item.tags),
        }
        for item in store.catalog().values()
    ]
    payload: dict[str, object] = {
        "schema": "v030-dynamic-fork-hpa-proof.v1",
        "source_pairs": [str(path.resolve()) for path in pair_paths],
        "seed_proof": str(args.seed_proof.resolve()),
        "seed_library": (
            str(args.seed_library.resolve()) if args.seed_library is not None else None
        ),
        "fork_usage_evidence": fork_usage,
        "non_adopted_prototype_ids": list(non_adopted_ids),
        "required_non_adoption_repair_ids": list(required_repair_ids),
        "hpa_update": update.to_dict(),
        "library_revision": store.revision(),
        "subagent_prototypes": prototypes,
        "prototype_count": len(prototypes),
        "library_elements": library_elements,
        "library_element_count": len(library_elements),
        "prototype_evidence": evidence_store.summary(),
        "prototype_evidence_path": str((output / "prototype-evidence.json").resolve()),
    }
    atomic_write_json(output / "proof.json", payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pair", type=Path, action="append")
    parser.add_argument("--outer-config", type=Path, default=DEFAULT_OUTER)
    parser.add_argument("--seed-proof", type=Path, default=DEFAULT_SEED_PROOF)
    parser.add_argument("--seed-catalog", type=Path)
    parser.add_argument("--seed-library", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--evolution-goal", default="")
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
