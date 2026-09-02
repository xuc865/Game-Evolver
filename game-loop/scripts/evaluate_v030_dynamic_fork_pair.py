#!/usr/bin/env python3
"""Formally compare singleton DSH with an HPA-evolved dynamic fork target."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.config import HarnessEvolutionConfig
from game_loop.core.harness import HarnessEpisodeOutcome, HarnessProfile
from game_loop.core.harness_rubric_validator import HarnessRubricValidator, _artifact_kind
from game_loop.core.game_design_charter import charter_section, load_design_charter
from game_loop.gcbench_runtime import (
    ensure_godot_env,
    render_runtime_instruction_block,
    sanitize_public_instruction,
    stage_local_runtime_overlay,
)
from game_loop.runtime.deepseek_harness import (
    DeepSeekHarnessRuntime,
    DeepSeekHarnessRuntimeConfig,
)
from game_loop.runtime.protocol import GameSubmission, GameTask
from game_loop.runtime_profile_snapshot import (
    capture_runtime_profile,
    hash_path,
    materialize_runtime_profile,
)
from game_loop.studio_server import StudioManager
from game_loop.subagent_prototype import (
    tool_description_for_subagent_prototype,
    tool_name_for_subagent_prototype,
)
from game_loop.utils import atomic_write_json, read_json


DEFAULT_HPA_PROOF = (
    ROOT
    / "experiments/complex-game-multiagent-v030"
    / "dynamic-fork-hpa-v7/proof.json"
)
DEFAULT_PARENT = (
    ROOT
    / "experiments/complex-game-multiagent-v030"
    / "auto-chess-transfer-v5-restart-controlled-formal/parent-runtime/submission.json"
)
DEFAULT_TASK = (
    ROOT
    / "experiments/complex-game-multiagent-v030"
    / "auto-chess-transfer-v5-restart-controlled-formal/task/instruction.md"
)
DEFAULT_SEED = (
    ROOT
    / "experiments/complex-game-multiagent-v030/auto-chess-seed-v1"
)
DEFAULT_PROFILE = ROOT / "experiments/inner-agent/deepseek-harness-profile.local.json"
DEFAULT_INNER = ROOT / "experiments/agentx/inner_harness_gcbench.json"
DEFAULT_GCBENCH_ROOT = ROOT.parent / "gcbench"


def _relative_fork_cost_penalty(parent_calls: int, candidate_calls: int) -> float:
    """Return the conservative call component of marginal cost."""

    extra_calls = max(0, int(candidate_calls) - int(parent_calls))
    return min(1.0, extra_calls / max(1, int(parent_calls)))


def _fork_cost_penalty(call_cost: float, time_cost: float) -> float:
    """Charge modest bounded marginal cost while keeping quality decisive."""

    return min(0.35, 0.25 * max(0.0, call_cost) + 0.10 * max(0.0, time_cost))


def _trajectory_wall_seconds(*paths: Path) -> float:
    """Recover observed episode duration from persisted trajectory timestamps."""

    stamps: list[datetime] = []
    for path in paths:
        if not path.is_file():
            continue
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    value = json.loads(line).get("created_at")
                    if value:
                        stamps.append(datetime.fromisoformat(str(value)))
                except (json.JSONDecodeError, TypeError, ValueError):
                    continue
        except OSError:
            continue
    if len(stamps) < 2:
        return 0.0
    return max(0.0, (max(stamps) - min(stamps)).total_seconds())


def _soft_rubric_capacity(validation: object) -> float:
    """Return the fixed soft-score capacity used to normalize quality gains."""

    capacity = 0.0
    for rubric in getattr(validation, "dynamic_rubrics", ()):
        if isinstance(rubric, dict):
            try:
                capacity += float(rubric.get("weight", 0.0))
            except (TypeError, ValueError):
                pass
    return max(1.0, capacity)


def _default_task_identity(task_file: Path) -> str:
    """Derive a stable internal identity from the supplied task location."""

    resolved = task_file.resolve()
    # Task fixtures conventionally live in <case>/task/instruction.md.  Fall
    # back to the nearest meaningful parent for standalone task files.
    candidate = resolved.parent.parent if resolved.parent.name == "task" else resolved.parent
    raw = candidate.name or resolved.stem
    identity = re.sub(r"[^a-zA-Z0-9]+", "-", raw).strip("-").casefold()
    return identity or "task"


def _load_submission(path: Path) -> GameSubmission:
    submission = GameSubmission.from_dict(read_json(path))
    if submission.status != "completed" or submission.artifact_ref is None:
        raise RuntimeError(f"submission is not completed reusable evidence: {path}")
    if submission.metadata.get("infrastructure_ok", True) is not True:
        raise RuntimeError(f"submission infrastructure is unhealthy: {path}")
    return submission


def _parent_capability_failure(submission: GameSubmission) -> bool:
    """Allow a completed model turn with no artifact to be a zero baseline."""

    if submission.status != "failed":
        return False
    if submission.metadata.get("finish_reason") != "completed":
        return False
    diagnostics = tuple(str(item) for item in submission.diagnostics)
    return bool(diagnostics) and all(
        item.startswith("expected artifact ") for item in diagnostics
    )


def _zero_parent_evidence_run(
    *,
    destination: Path,
    task_source: Path,
    submission: GameSubmission,
) -> Path:
    """Create auditable empty evidence without inventing a parent artifact."""

    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    atomic_write_json(destination / "manifest.json", {
        "benchmark_id": "studio-proof",
        "task_source": str(task_source.resolve()),
        "runtime_id": submission.runtime_id,
        "side": "parent",
        "score_mode": "zero_capability_failure",
        "source_submission_id": submission.submission_id,
    })
    atomic_write_json(destination / "state.json", {
        "status": "completed",
        "score": 0.0,
        "score_mode": "zero_capability_failure",
        "artifact_present": False,
    })
    return destination


def _evidence_run(
    *,
    destination: Path,
    submission: GameSubmission,
    task_source: Path,
    side: str,
    artifact_relpath: str | None = None,
) -> Path:
    if destination.exists():
        shutil.rmtree(destination)
    artifact_id = f"dynamic-fork-{side}-artifact"
    artifact = destination / "artifacts" / artifact_id / "artifact"
    artifact.parent.mkdir(parents=True)
    source = Path(str(submission.artifact_ref))
    if artifact_relpath and _artifact_kind(source) == "unknown":
        nested = source / artifact_relpath
        if nested.is_dir():
            source = nested
    shutil.copytree(source, artifact, symlinks=True)
    atomic_write_json(destination / "manifest.json", {
        "benchmark_id": "studio-proof",
        "task_source": str(task_source.resolve()),
        "runtime_id": submission.runtime_id,
        "side": side,
    })
    atomic_write_json(destination / "state.json", {
        "status": "completed",
        "champion_artifact_id": artifact_id,
        "submission_id": submission.submission_id,
    })
    return destination


def _runtime_config(
    *,
    runtime_profile: Path,
    prototypes: list[dict] | None,
    snapshot_root: Path,
    timeout_seconds: int,
    max_tokens: int,
    reasoning_effort: str,
    shared_runtime_plugins: tuple[str, ...] = (),
) -> DeepSeekHarnessRuntimeConfig:
    profile, _, assets = capture_runtime_profile(runtime_profile)
    profile["timeout_seconds"] = timeout_seconds
    profile["max_tokens"] = max_tokens
    if reasoning_effort != "max":
        source = Path(assets["cordis"]["path"])
        cordis_text = source.read_text(encoding="utf-8")
        expected = "reasoningEffort: max"
        if expected not in cordis_text:
            raise ValueError("Cordis does not expose the expected reasoningEffort setting")
        replacement_effort = "low"
        if reasoning_effort == "off":
            thinking = "thinking: enabled"
            if thinking not in cordis_text:
                raise ValueError("Cordis does not expose the expected thinking setting")
            cordis_text = cordis_text.replace(
                thinking, "thinking: disabled", 1
            )
        variant = snapshot_root.with_name(
            f"{snapshot_root.name}-cordis-{reasoning_effort}{''.join(source.suffixes)}"
        )
        variant.write_text(
            cordis_text.replace(expected, f"reasoningEffort: {replacement_effort}", 1),
            encoding="utf-8",
        )
        profile["cordis"] = str(variant)
        assets = dict(assets)
        assets["cordis"] = {"path": str(variant), "sha256": hash_path(variant)}
    active_plugins = set(profile.get("active_cordis_plugins", []))
    unknown_shared_plugins = sorted(
        set(shared_runtime_plugins) - set(profile.get("cordis_plugin_catalog", {}))
    )
    if unknown_shared_plugins:
        raise ValueError(
            "unknown shared runtime plugins: " + ", ".join(unknown_shared_plugins)
        )
    active_plugins.update(shared_runtime_plugins)
    # Polaris may spend up to its 300s stream-idle interval on a retry. Keep
    # enough hard-deadline budget for the mandatory evidence-preserving wrap-up
    # after the main turn is cancelled.
    profile["finalization_reserve_seconds"] = _finalization_reserve_seconds(
        int(profile.get("finalization_reserve_seconds", 120))
    )
    if prototypes is None:
        active_plugins.discard("fork_context_subagent")
        profile.pop("active_subagent_prototypes", None)
    else:
        active_plugins.add("fork_context_subagent")
        profile["active_subagent_prototypes"] = prototypes
    profile["active_cordis_plugins"] = sorted(active_plugins)
    snapshot_path, _ = materialize_runtime_profile(
        profile=profile,
        assets=assets,
        destination=snapshot_root,
    )
    value = read_json(snapshot_path)
    return DeepSeekHarnessRuntimeConfig.from_dict(value)


def _run_submission(
    *,
    output: Path,
    side: str,
    task: GameTask,
    runtime_profile: Path,
    prototypes: list[dict] | None,
    timeout_seconds: int,
    max_tokens: int,
    reasoning_effort: str,
    shared_runtime_plugins: tuple[str, ...] = (),
) -> GameSubmission:
    config = _runtime_config(
        runtime_profile=runtime_profile,
        prototypes=prototypes,
        snapshot_root=output / f"{side}-profile-snapshot",
        timeout_seconds=timeout_seconds,
        max_tokens=max_tokens,
        reasoning_effort=reasoning_effort,
        shared_runtime_plugins=shared_runtime_plugins,
    )
    runtime = DeepSeekHarnessRuntime(config)
    doctor = runtime.doctor()
    atomic_write_json(output / f"{side}-doctor.json", doctor)
    if doctor.get("ok") is not True:
        raise RuntimeError(f"dynamic-fork {side} doctor failed")
    return runtime.run(task, episode_dir=output / f"{side}-runtime")


def _finalization_reserve_seconds(configured: int) -> int:
    return max(configured, 420)


def _normalized_seed_project_root(seed: Path) -> Path:
    source = seed.resolve()
    if not (source / "project.godot").is_file() and (
        source / "game" / "project.godot"
    ).is_file():
        source = source / "game"
    if not (source / "project.godot").is_file():
        raise ValueError(f"seed does not contain a Godot project root: {source}")
    return source


def _prepare_task_seed(
    *,
    output: Path,
    seed: Path,
    gcbench_root: Path,
) -> Path:
    staged = output / "task-seed"
    staged.mkdir()
    source = _normalized_seed_project_root(seed)
    # Accepted artifacts may be a workspace wrapper whose actual Godot project
    # is at ``game/project.godot``. The task contract already supplies the
    # ``game/`` boundary, so unwrap that one level before staging.
    shutil.copytree(source, staged / "game")
    godot = ensure_godot_env()
    stage_local_runtime_overlay(
        overlay_workspace=staged,
        gcbench_root=gcbench_root,
        godot_bin=godot,
    )
    return staged


def _fork_usage_from_events(
    events: list[dict[str, object]],
    *,
    session: str,
) -> dict[str, object]:
    session_event = next(
        (event for event in events if event.get("type") == "session"),
        {},
    )
    session_data = dict(session_event.get("data", {}))
    delegation_depth = session_event.get(
        "delegationDepth",
        session_data.get("delegationDepth", 0),
    )
    if int(delegation_depth) != 0:
        return {
            "fork_tool_calls": [],
            "fork_results": [],
            "post_fork_root_actions": [],
        }

    calls: list[dict[str, object]] = []
    results_by_call: dict[str, dict[str, object]] = {}
    mutating_calls: list[dict[str, object]] = []
    for event in events:
        event_type = event.get("type")
        data = dict(event.get("data", {}))
        sequence = int(event.get("seq", -1))
        if event_type == "tool/call":
            name = str(data.get("name", ""))
            call_id = str(data.get("callId", ""))
            if name == "subagent" or name.startswith("fork_agent_"):
                calls.append({
                    "name": name,
                    "call_id": call_id,
                    "arguments": data.get("arguments"),
                    "sequence": sequence,
                    "session": session,
                })
            elif name in {"write", "edit", "bash"}:
                mutating_calls.append({
                    "name": name,
                    "call_id": call_id,
                    "sequence": sequence,
                    "session": session,
                })
        elif event_type == "tool/result":
            message = dict(data.get("message", {}))
            source = dict(message.get("source", {}))
            call_id = str(source.get("callId", ""))
            if call_id:
                content = message.get("content", [])
                serialized = json.dumps(content, ensure_ascii=False)
                results_by_call[call_id] = {
                    "call_id": call_id,
                    "sequence": sequence,
                    "successful": '"isError": true' not in serialized and bool(content),
                    "content_size": len(serialized),
                    "session": session,
                }

    fork_results: list[dict[str, object]] = []
    adoption_actions: list[dict[str, object]] = []
    for call in calls:
        result = results_by_call.get(str(call["call_id"]))
        if result is None:
            continue
        fork_results.append(result)
        if result["successful"] is not True:
            continue
        later = next(
            (
                action
                for action in mutating_calls
                if int(action["sequence"]) > int(result["sequence"])
            ),
            None,
        )
        if later is not None:
            adoption_actions.append({
                **later,
                "fork_call_id": call["call_id"],
                "fork_result_sequence": result["sequence"],
            })
    return {
        "fork_tool_calls": calls,
        "fork_results": fork_results,
        "post_fork_root_actions": adoption_actions,
    }


_BACKGROUND_CHILD_PATTERNS = (
    re.compile(r"started background child ([A-Za-z0-9_-]+)"),
    re.compile(r'\"subagentId\"\s*:\s*\"([A-Za-z0-9_-]+)\"'),
)
_BACKGROUND_REPORT_PATTERN = re.compile(
    r"Background subagent ([A-Za-z0-9_-]+) (?:reported:|finished\b)"
)


def _session_events(session: Path) -> list[dict[str, object]]:
    completed = subprocess.run(
        ["zstdcat", str(session)],
        check=True,
        capture_output=True,
        text=True,
    )
    events: list[dict[str, object]] = []
    for line in completed.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def _event_text(event: dict[str, object]) -> str:
    return json.dumps(event.get("data", {}), ensure_ascii=False)


def _session_lineage(events: list[dict[str, object]]) -> dict[str, object]:
    session_event = next(
        (event for event in events if event.get("type") == "session"),
        {},
    )
    data = dict(session_event.get("data", {}) or {})
    return {
        "session_id": str(
            session_event.get("id", data.get("id", "")) or ""
        ),
        "parent_session": str(
            session_event.get(
                "parentSession", data.get("parentSession", "")
            )
            or ""
        ),
        "delegation_depth": int(
            session_event.get(
                "delegationDepth", data.get("delegationDepth", 0)
            )
        ),
    }


def _session_completed(events: list[dict[str, object]]) -> bool:
    return any(
        event.get("type") == "turn/end"
        and str(dict(event.get("data", {})).get("reason", {}).get("kind", ""))
        == "completed"
        for event in events
    )


def _background_child_id(result: dict[str, object]) -> str | None:
    serialized = str(result.get("serialized_content", ""))
    for pattern in _BACKGROUND_CHILD_PATTERNS:
        match = pattern.search(serialized)
        if match is not None:
            return match.group(1)
    return None


def _background_report_child_id(event: dict[str, object]) -> str | None:
    data = dict(event.get("data", {}) or {})
    inserted = data.get("inserted", [])
    if isinstance(inserted, list):
        for raw_message in inserted:
            if not isinstance(raw_message, dict):
                continue
            source = raw_message.get("source", {})
            if not isinstance(source, dict):
                continue
            if (
                source.get("kind") == "subagent-settled"
                and source.get("form") == "notice"
                and source.get("senderSessionId")
            ):
                return str(source["senderSessionId"])
    match = _BACKGROUND_REPORT_PATTERN.search(_event_text(event))
    return None if match is None else match.group(1)


def _fork_usage(submission: GameSubmission) -> dict[str, object]:
    session_root = Path(str(submission.metadata.get("session_root", "")))
    sessions = sorted(session_root.rglob("*.zstd")) if session_root.is_dir() else []
    records: list[dict[str, object]] = []
    for session in sessions:
        events = _session_events(session)
        records.append({
            "path": str(session),
            "events": events,
            **_session_lineage(events),
            "completed": _session_completed(events),
        })

    calls: list[dict[str, object]] = []
    starts: list[dict[str, object]] = []
    completion_reports: list[dict[str, object]] = []
    completed_children: list[dict[str, object]] = []
    adoption_actions: list[dict[str, object]] = []
    for root in (item for item in records if item["delegation_depth"] == 0):
        events = list(root["events"])
        audit = _fork_usage_from_events(events, session=str(root["path"]))
        calls.extend(audit["fork_tool_calls"])
        call_ids = {str(call["call_id"]): call for call in audit["fork_tool_calls"]}
        root_mutations = [
            {
                "name": str(dict(event.get("data", {})).get("name", "")),
                "call_id": str(dict(event.get("data", {})).get("callId", "")),
                "sequence": int(event.get("seq", -1)),
                "session": str(root["path"]),
            }
            for event in events
            if event.get("type") == "tool/call"
            and str(dict(event.get("data", {})).get("name", ""))
            in {"write", "edit", "bash"}
        ]
        root_starts: list[dict[str, object]] = []
        for event in events:
            if event.get("type") != "tool/result":
                continue
            data = dict(event.get("data", {}))
            message = dict(data.get("message", {}))
            call_id = str(dict(message.get("source", {})).get("callId", ""))
            if call_id not in call_ids:
                continue
            serialized = json.dumps(message.get("content", []), ensure_ascii=False)
            start = {
                "call_id": call_id,
                "sequence": int(event.get("seq", -1)),
                "successful": '"isError": true' not in serialized,
                "serialized_content": serialized,
                "session": str(root["path"]),
            }
            child_id = _background_child_id(start)
            if child_id is not None:
                start["child_id"] = child_id
            starts.append(start)
            root_starts.append(start)

        notices: dict[str, dict[str, object]] = {}
        for event in events:
            child_id = _background_report_child_id(event)
            if child_id is None:
                continue
            notice = {
                "child_id": child_id,
                "sequence": int(event.get("seq", -1)),
                "session": str(root["path"]),
                "event_type": str(event.get("type", "")),
            }
            previous = notices.get(child_id)
            if previous is None or int(notice["sequence"]) < int(previous["sequence"]):
                notices[child_id] = notice

        for start in root_starts:
            if not start.get("child_id"):
                continue
            child_id = str(start["child_id"])
            child = next(
                (
                    item
                    for item in records
                    if item["session_id"] == child_id
                    and item["parent_session"] == root["session_id"]
                    and item["delegation_depth"] == 1
                    and item["completed"] is True
                ),
                None,
            )
            notice = notices.get(child_id)
            if child is None or notice is None:
                continue
            completed_children.append({
                "child_id": child_id,
                "session": child["path"],
                "parent_session": child["parent_session"],
                "delegation_depth": child["delegation_depth"],
                "completed": True,
            })
            completion_reports.append(notice)
            later = next(
                (
                    action
                    for action in root_mutations
                    if int(action["sequence"]) > int(notice["sequence"])
                ),
                None,
            )
            if later is not None:
                adoption_actions.append({
                    **later,
                    "fork_call_id": start["call_id"],
                    "child_id": child_id,
                    "completion_report_sequence": notice["sequence"],
                })
            else:
                # A completed, matching handoff is already a usable contribution.
                # Root-side editing is useful evidence, but not a second hard gate.
                adoption_actions.append({
                    "name": "child_handoff",
                    "call_id": "",
                    "sequence": notice["sequence"],
                    "session": str(root["path"]),
                    "fork_call_id": start["call_id"],
                    "child_id": child_id,
                    "completion_report_sequence": notice["sequence"],
                })
    adopted_call_ids = {
        str(action["fork_call_id"])
        for action in adoption_actions
    }
    return {
        "fork_tool_calls": calls,
        "fork_tool_call_count": len(calls),
        "fork_results": starts,
        "fork_result_count": len(starts),
        "completed_child_sessions": completed_children,
        "completed_child_session_count": len(completed_children),
        "completion_reports": completion_reports,
        "completion_report_count": len(completion_reports),
        "post_fork_root_actions": adoption_actions,
        "adopted_fork_count": len(adopted_call_ids),
        "fork_contract_satisfied": bool(adopted_call_ids),
        "session_file_count": len(sessions),
    }


def _root_contract_visibility(
    submission: GameSubmission,
    prototypes: list[dict],
    model_tool_surface: dict[str, object] | None = None,
) -> dict[str, object]:
    expected = [
        tool_name_for_subagent_prototype(str(item["id"]))
        for item in prototypes
    ]
    recorded = [
        str(item)
        for item in submission.metadata.get("root_visible_subagent_tools", [])
    ]
    prompt_hash = submission.metadata.get("subagent_contract_prompt_sha256")
    surface = model_tool_surface or _root_model_tool_surface(submission, prototypes)
    visible = [str(item) for item in surface.get("model_visible_tools", [])]
    contracts = dict(surface.get("evolved_tool_contracts", {}))
    return {
        "expected_tools": expected,
        "recorded_tools": recorded,
        **surface,
        "contract_prompt_sha256": prompt_hash,
        "verified": (
            bool(expected)
            and sorted(recorded) == sorted(expected)
            and all(item in visible for item in expected)
            and all(contracts.get(item) is True for item in expected)
            and isinstance(prompt_hash, str)
            and len(prompt_hash) == 64
        ),
    }


def _root_model_tool_surface(
    submission: GameSubmission,
    prototypes: list[dict],
) -> dict[str, object]:
    """Audit the model-facing schemas persisted in the root request header."""

    session_root = Path(str(submission.metadata.get("session_root", "")))
    sessions = sorted(session_root.rglob("*.zstd")) if session_root.is_dir() else []
    expected_contracts = {
        tool_name_for_subagent_prototype(str(item["id"])): (
            tool_description_for_subagent_prototype(
                str(item["id"]),
                str(item.get("persona", "")),
                str(item.get("description", "")),
            )
        )
        for item in prototypes
    }
    schemas: dict[str, dict[str, object]] = {}
    root_prompt_text = "\n".join(_root_model_prompt_text(session) for session in sessions)
    header_count = 0
    for session in sessions:
        completed = subprocess.run(
            ["zstdcat", str(session)],
            check=True,
            capture_output=True,
            text=True,
        )
        events: list[dict[str, object]] = []
        for line in completed.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict):
                events.append(event)
        session_event = next(
            (item for item in events if item.get("type") == "session"),
            {},
        )
        session_data = dict(session_event.get("data", {}))
        depth = session_event.get(
            "delegationDepth", session_data.get("delegationDepth", 0)
        )
        if int(depth) != 0:
            continue
        for event in events:
            if event.get("type") != "request/header":
                continue
            header = dict(dict(event.get("data", {})).get("header", {}))
            tools = header.get("tools", [])
            if not isinstance(tools, list):
                continue
            header_count += 1
            for raw_tool in tools:
                if not isinstance(raw_tool, dict):
                    continue
                name = str(raw_tool.get("name", ""))
                description = str(raw_tool.get("description", ""))
                schemas[name] = {
                    "description_chars": len(description),
                    "description_sha256": hashlib.sha256(
                        description.encode("utf-8")
                    ).hexdigest(),
                }
    return {
        "request_header_count": header_count,
        "model_visible_tools": sorted(schemas),
        "model_visible_tool_schemas": schemas,
        "evolved_tool_contracts": {
            name: bool(
                persona
                and (
                    persona in str(next(
                        (
                            raw.get("description", "")
                            for session in sessions
                            for raw in _request_header_tools(session)
                            if str(raw.get("name", "")) == name
                        ),
                        "",
                    ))
                    or persona in root_prompt_text
                )
            )
            for name, persona in expected_contracts.items()
        },
        "generic_subagent_present": "subagent" in schemas,
    }


def _root_model_prompt_text(session: Path) -> str:
    completed = subprocess.run(
        ["zstdcat", str(session)], check=True, capture_output=True, text=True
    )
    root = False
    parts: list[str] = []
    for line in completed.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "session":
            data = dict(event.get("data", {}))
            root = int(event.get("delegationDepth", data.get("delegationDepth", 0))) == 0
            continue
        if not root or event.get("type") not in {"user/message", "agent/inbox/spliced"}:
            continue
        serialized = json.dumps(event.get("data", {}), ensure_ascii=False)
        parts.append(serialized)
    return "\n".join(parts)


def _request_header_tools(session: Path) -> list[dict[str, object]]:
    completed = subprocess.run(
        ["zstdcat", str(session)], check=True, capture_output=True, text=True
    )
    tools: list[dict[str, object]] = []
    root = False
    for line in completed.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "session":
            data = dict(event.get("data", {}))
            root = int(event.get("delegationDepth", data.get("delegationDepth", 0))) == 0
        elif root and event.get("type") == "request/header":
            header = dict(dict(event.get("data", {})).get("header", {}))
            raw_tools = header.get("tools", [])
            if isinstance(raw_tools, list):
                tools.extend(item for item in raw_tools if isinstance(item, dict))
    return tools


def run(args: argparse.Namespace) -> dict[str, object]:
    os.environ.update(StudioManager._runtime_environment())
    output = args.output_dir.resolve()
    if output.exists() and args.force:
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)

    hpa_proof = read_json(args.hpa_proof)
    prototypes = list(hpa_proof.get("subagent_prototypes", []))
    if not prototypes:
        raise ValueError("HPA proof contains no executable subagent prototypes")
    task_text = sanitize_public_instruction(
        args.task_file.read_text(encoding="utf-8")
    )
    if args.design_charter:
        task_text = f"{task_text.rstrip()}{charter_section(load_design_charter(args.design_charter))}"
    if args.evolution_goal:
        task_text = f"{task_text.rstrip()}\n\n## Evolution goal\n\n{args.evolution_goal.strip()}"
    task_source = output / "task"
    task_source.mkdir()
    (task_source / "instruction.md").write_text(task_text, encoding="utf-8")
    staged_seed = _prepare_task_seed(
        output=output,
        seed=args.seed,
        gcbench_root=args.gcbench_root,
    )
    runtime_block = render_runtime_instruction_block({
        "godot_bin": ensure_godot_env(),
        "game_dir": "game",
        "tools_dir": "tools",
        "runtime_note": str(staged_seed / "RUNTIME_PATHS.md"),
    })
    task_identity = _default_task_identity(args.task_file)
    task_id = args.task_id or f"dynamic-fork-{task_identity}"
    case_id = args.case_id or f"dynamic-fork-{task_identity}"
    task = GameTask(
        task_id=task_id,
        benchmark_id=args.benchmark_id,
        prompt=f"{task_text.rstrip()}\n\n{runtime_block}",
        task_source_ref=str(task_source),
        workspace_seed_ref=str(staged_seed),
        artifact_relpath="game",
    )

    if args.regenerate_parent:
        parent_submission = _run_submission(
            output=output,
            side="parent",
            task=task,
            runtime_profile=args.runtime_profile,
            prototypes=None,
            timeout_seconds=args.wall_timeout_seconds,
            max_tokens=args.max_tokens,
            reasoning_effort=args.reasoning_effort,
            shared_runtime_plugins=tuple(args.shared_runtime_plugin),
        )
    else:
        parent_raw = GameSubmission.from_dict(read_json(args.parent_submission))
        parent_submission = parent_raw
    parent_zero_baseline = _parent_capability_failure(parent_submission)
    if parent_submission.status != "completed" and not parent_zero_baseline:
        payload = {
            "schema": "v030-dynamic-fork-paired-proof.v1",
            "accepted": False,
            "infrastructure_ok": False,
            "reason": "parent infrastructure failure; candidate was not started",
            "parent": parent_submission.to_dict(),
            "candidate": None,
        }
        atomic_write_json(output / "paired-proof.json", payload)
        return payload
    if args.candidate_submission is not None:
        candidate_submission = _load_submission(args.candidate_submission)
    else:
        candidate_submission = _run_submission(
            output=output,
            side="candidate",
            task=task,
            runtime_profile=args.runtime_profile,
            prototypes=prototypes,
            timeout_seconds=args.wall_timeout_seconds,
            max_tokens=args.max_tokens,
            reasoning_effort=args.reasoning_effort,
            shared_runtime_plugins=tuple(args.shared_runtime_plugin),
        )
    if (
        (parent_submission.status != "completed" and not parent_zero_baseline)
        or candidate_submission.status != "completed"
    ):
        payload = {
            "schema": "v030-dynamic-fork-paired-proof.v1",
            "accepted": False,
            "infrastructure_ok": False,
            "reason": (
                "candidate did not complete"
                if parent_zero_baseline
                else "parent or candidate did not complete"
            ),
            "parent": parent_submission.to_dict(),
            "candidate": candidate_submission.to_dict(),
        }
        atomic_write_json(output / "paired-proof.json", payload)
        return payload

    evidence_root = output / "evidence-runs"
    if parent_zero_baseline:
        parent_run = _zero_parent_evidence_run(
            destination=evidence_root / "parent-zero",
            submission=parent_submission,
            task_source=task_source,
        )
    else:
        parent_run = _evidence_run(
            destination=evidence_root / "parent",
            submission=parent_submission,
            task_source=task_source,
            side="parent",
            artifact_relpath=task.artifact_relpath,
        )
    candidate_run = _evidence_run(
        destination=evidence_root / "candidate",
        submission=candidate_submission,
        task_source=task_source,
        side="candidate",
        artifact_relpath=task.artifact_relpath,
    )
    parent_profile = HarnessProfile.from_dict({
        "harness_id": "v030-singleton-parent",
    })
    candidate_profile = HarnessProfile.from_dict({
        "harness_id": "v030-dynamic-fork-candidate",
        "parent_harness_id": parent_profile.harness_id,
        "active_elements": [
            {
                "element_id": prototype["id"],
                "category": "subagent",
                "description": prototype["description"],
                "spec": {
                    key: value
                    for key, value in prototype.items()
                    if key not in {"id", "description"}
                },
            }
            for prototype in prototypes
        ],
    })
    harness_config = replace(
        HarnessEvolutionConfig.from_dict(read_json(args.inner_config)),
        rubric_validation_sample_size=1,
    )
    parent_outcome = HarnessEpisodeOutcome(
        case_id=case_id,
        harness_id=parent_profile.harness_id,
        final_score=0.0,
        feasible=True,
        model_calls=int(parent_submission.usage.get("modelCalls", 1)),
        evaluator_queries=1,
        infrastructure_ok=True,
        run_ref=str(parent_run),
    )
    candidate_outcome = HarnessEpisodeOutcome(
        case_id=case_id,
        harness_id=candidate_profile.harness_id,
        final_score=0.0,
        feasible=True,
        model_calls=int(candidate_submission.usage.get("modelCalls", 1)),
        evaluator_queries=1,
        infrastructure_ok=True,
        run_ref=str(candidate_run),
    )
    validation = HarnessRubricValidator(harness_config).validate_paired_outcomes(
        parent_outcomes=(parent_outcome,),
        candidate_outcomes=(candidate_outcome,),
        parent_profile=parent_profile,
        candidate_profile=candidate_profile,
        case_task_refs={case_id: task_source},
    )
    parent_soft = sum(item.parent.soft_total for item in validation.case_results)
    candidate_soft = sum(item.candidate.soft_total for item in validation.case_results)
    quality_delta = candidate_soft - parent_soft
    quality_gain = max(
        -1.0,
        min(1.0, quality_delta / _soft_rubric_capacity(validation)),
    )
    parent_calls = int(parent_submission.usage.get("modelCalls", 1))
    candidate_calls = int(candidate_submission.usage.get("modelCalls", 1))
    call_cost = _relative_fork_cost_penalty(parent_calls, candidate_calls)
    parent_seconds = _trajectory_wall_seconds(Path(parent_submission.trajectory_ref))
    candidate_seconds = _trajectory_wall_seconds(Path(candidate_submission.trajectory_ref))
    time_cost = max(0.0, candidate_seconds - parent_seconds) / max(
        1, int(args.wall_timeout_seconds)
    )
    cost_penalty = _fork_cost_penalty(call_cost, time_cost)
    net_utility = quality_gain - cost_penalty
    fork_usage = _fork_usage(candidate_submission)
    root_contract_visibility = _root_contract_visibility(
        candidate_submission, prototypes
    )
    fork_admission_reasons: list[str] = []
    if root_contract_visibility["verified"] is not True:
        fork_admission_reasons.append(
            "candidate root-visible child contracts were not auditable"
        )
    if fork_usage["fork_tool_call_count"] == 0:
        fork_admission_reasons.append("candidate did not invoke an exposed fork target")
    if fork_usage["fork_result_count"] == 0:
        fork_admission_reasons.append("candidate produced no successful background child start")
    if fork_usage["completed_child_session_count"] == 0:
        fork_admission_reasons.append(
            "candidate produced no completed direct depth-1 child session"
        )
    if fork_usage["completion_report_count"] == 0:
        fork_admission_reasons.append(
            "candidate root received no matching child completion report"
        )
    if fork_usage["adopted_fork_count"] == 0:
        fork_admission_reasons.append(
            "root received no complete child handoff with artifact evidence"
        )
    # A fork is only a successful evolution when it improves the delivered
    # artifact. Lower inference cost alone is not evidence that delegation
    # contributed; retain the quality gate even when the candidate is cheaper.
    accepted = not fork_admission_reasons and validation.accepted and (
        quality_delta > 0 and net_utility >= 0
    )
    payload = {
        "schema": "v030-dynamic-fork-paired-proof.v1",
        "accepted": accepted,
        "infrastructure_ok": validation.infrastructure_ok,
        "source_hpa_proof": str(args.hpa_proof.resolve()),
        "prototypes": prototypes,
        "parent": parent_submission.to_dict(),
        "candidate": candidate_submission.to_dict(),
        "fork_usage": fork_usage,
        "root_contract_visibility": root_contract_visibility,
        "fork_admission": {
            "accepted": not fork_admission_reasons,
            "reasons": fork_admission_reasons,
        },
        "rubric_validation": validation.to_dict(),
        "utility": {
            "quality_delta": quality_delta,
            "quality_gain": quality_gain,
            "model_call_delta": candidate_calls - parent_calls,
            "parent_wall_seconds": parent_seconds,
            "candidate_wall_seconds": candidate_seconds,
            "call_cost": call_cost,
            "time_cost": time_cost,
            "cost_penalty": cost_penalty,
            "net_utility": net_utility,
        },
        "parent_baseline": {
            "score": 0.0 if parent_zero_baseline else None,
            "mode": (
                "zero_capability_failure"
                if parent_zero_baseline
                else "completed_artifact"
            ),
        },
    }
    atomic_write_json(output / "paired-proof.json", payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hpa-proof", type=Path, default=DEFAULT_HPA_PROOF)
    parser.add_argument("--parent-submission", type=Path, default=DEFAULT_PARENT)
    parser.add_argument("--regenerate-parent", action="store_true")
    parser.add_argument("--task-file", type=Path, default=DEFAULT_TASK)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--gcbench-root", type=Path, default=DEFAULT_GCBENCH_ROOT)
    parser.add_argument("--runtime-profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--candidate-submission", type=Path)
    parser.add_argument("--evolution-goal", default="")
    parser.add_argument("--design-charter", type=Path,
                        help="Frozen human design guidance supplied to agents and the rubric judge.")
    parser.add_argument("--inner-config", type=Path, default=DEFAULT_INNER)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--wall-timeout-seconds", type=int, default=600)
    parser.add_argument("--max-tokens", type=int, default=16384)
    parser.add_argument(
        "--reasoning-effort", choices=("off", "low", "max"), default="max"
    )
    parser.add_argument(
        "--shared-runtime-plugin",
        action="append",
        default=[],
        help="Enable an audited runtime plugin identically for parent and candidate.",
    )
    parser.add_argument("--task-id")
    parser.add_argument("--benchmark-id", default="studio-proof")
    parser.add_argument("--case-id")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    payload = run(args)
    print(
        f"accepted={payload['accepted']} infrastructure_ok={payload['infrastructure_ok']} "
        f"proof={args.output_dir.resolve() / 'paired-proof.json'}"
    )
    return 0 if payload["infrastructure_ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
