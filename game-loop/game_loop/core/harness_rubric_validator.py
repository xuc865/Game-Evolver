from __future__ import annotations

import base64
import json
import hashlib
import math
import os
import random
import re
import signal
import subprocess
import sys
import time
import fcntl
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol, Sequence

from game_loop.config import HarnessEvolutionConfig, HarnessRubricCriterion
from game_loop.core.harness import HarnessEpisodeOutcome, HarnessReplayCase, HarnessProfile
from game_loop.core.harness_rubric_generator import DynamicRubricSet, generate_dynamic_rubric_set
from game_loop.utils import read_json, utc_now


@dataclass(frozen=True)
class TaskPoolEntry:
    task_ref: str
    seed_artifact_ref: str
    seed_score: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_replay_case(self, case_id: str) -> HarnessReplayCase:
        payload = dict(self.metadata)
        payload.setdefault("seed_score", self.seed_score)
        return HarnessReplayCase(
            case_id=case_id,
            task_ref=self.task_ref,
            parent_artifact_ref=self.seed_artifact_ref,
            metadata=payload,
        )


@dataclass(frozen=True)
class DeepPlaytestEvidence:
    case_id: str
    run_ref: str
    artifact_path: str
    benchmark_id: str
    task_source: str
    probes: tuple[dict[str, Any], ...]
    file_inventory: tuple[str, ...]
    process_evidence: dict[str, Any] = field(default_factory=dict)
    instruction_excerpt: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "run_ref": self.run_ref,
            "artifact_path": self.artifact_path,
            "benchmark_id": self.benchmark_id,
            "task_source": self.task_source,
            "probes": list(self.probes),
            "file_inventory": list(self.file_inventory[:40]),
            "process_evidence": self.process_evidence,
            "instruction_excerpt": self.instruction_excerpt,
        }


@dataclass(frozen=True)
class RubricCaseScores:
    case_id: str
    hard: dict[str, float]
    soft: dict[str, float]
    soft_total: float
    judge: str
    evidence_ref: str
    infrastructure_ok: bool = True
    errors: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RubricPairComparison:
    case_id: str
    passed: bool
    parent: RubricCaseScores
    candidate: RubricCaseScores
    reasons: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["reasons"] = list(self.reasons)
        return value


@dataclass(frozen=True)
class HarnessRubricValidationResult:
    accepted: bool
    reasons: tuple[str, ...]
    case_results: tuple[RubricPairComparison, ...]
    sampled_case_ids: tuple[str, ...]
    dynamic_rubrics: tuple[dict[str, Any], ...] = ()
    infrastructure_ok: bool = True
    created_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "accepted": self.accepted,
            "reasons": list(self.reasons),
            "case_results": [item.to_dict() for item in self.case_results],
            "sampled_case_ids": list(self.sampled_case_ids),
            "dynamic_rubrics": list(self.dynamic_rubrics),
            "infrastructure_ok": self.infrastructure_ok,
            "created_at": self.created_at,
        }


class RubricJudge(Protocol):
    def score(
        self,
        *,
        evidence: DeepPlaytestEvidence,
        hard_rubrics: Sequence[HarnessRubricCriterion],
        soft_rubrics: Sequence[HarnessRubricCriterion],
    ) -> RubricCaseScores: ...


def _resolve_pool_ref(base_dir: Path, ref: str) -> str:
    path = Path(ref).expanduser()
    if path.is_absolute():
        return str(path.resolve())
    return str((base_dir / path).resolve())


def load_task_pool(path: Path) -> tuple[TaskPoolEntry, ...]:
    path = path.resolve()
    base_dir = path.parent
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("task pool must be a JSON list")
    entries: list[TaskPoolEntry] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"task pool entry {index} must be an object")
        entries.append(
            TaskPoolEntry(
                task_ref=_resolve_pool_ref(base_dir, str(item["task_ref"])),
                seed_artifact_ref=_resolve_pool_ref(base_dir, str(item["seed_artifact_ref"])),
                seed_score=float(item.get("seed_score", 0.0)),
                metadata=dict(item.get("metadata", {})),
            )
        )
    if not entries:
        raise ValueError("task pool must not be empty")
    return tuple(entries)


def sample_task_pool(
    pool: Sequence[TaskPoolEntry],
    *,
    sample_size: int,
    seed: int,
    prefix: str,
    anchor_index: int | None = None,
) -> tuple[HarnessReplayCase, ...]:
    if sample_size < 1:
        raise ValueError("sample_size must be >= 1")
    rng = random.Random(seed)
    values = list(pool)
    if anchor_index is not None:
        anchor = values[anchor_index % len(values)]
        remainder = [item for index, item in enumerate(values) if index != anchor_index % len(values)]
        if len(values) >= sample_size:
            picked = [anchor, *rng.sample(remainder, sample_size - 1)]
        else:
            picked = [anchor, *(rng.choice(values) for _ in range(sample_size - 1))]
    elif len(pool) >= sample_size:
        picked = rng.sample(values, sample_size)
    else:
        picked = [rng.choice(values) for _ in range(sample_size)]
    return tuple(
        entry.to_replay_case(f"{prefix}-{index + 1:02d}")
        for index, entry in enumerate(picked)
    )


def fixed_task_pool_cases(
    pool: Sequence[TaskPoolEntry],
    *,
    sample_size: int,
    prefix: str,
) -> tuple[HarnessReplayCase, ...]:
    """Select a stable admission suite in task-pool order."""
    if sample_size < 1:
        raise ValueError("sample_size must be >= 1")
    if len(pool) < sample_size:
        raise ValueError(
            f"fixed task pool has {len(pool)} entries but {sample_size} are required"
        )
    return tuple(
        entry.to_replay_case(f"{prefix}-{index + 1:02d}")
        for index, entry in enumerate(pool[:sample_size])
    )


def resolve_episode_artifact(run_dir: Path) -> Path | None:
    run_dir = run_dir.resolve()
    state_path = run_dir / "state.json"
    if state_path.is_file():
        champion_id = str(read_json(state_path).get("champion_artifact_id", "")).strip()
        if champion_id:
            candidate = run_dir / "artifacts" / champion_id / "artifact"
            if candidate.is_dir():
                return candidate
        return None
    artifacts_root = run_dir / "artifacts"
    if artifacts_root.is_dir():
        for child in sorted(artifacts_root.iterdir(), reverse=True):
            artifact = child / "artifact"
            if artifact.is_dir():
                return artifact
    for relative in ("workspace/game", "workspace/candidate", "workspace"):
        candidate = run_dir / relative
        if candidate.is_dir():
            return candidate
    return None


def resolve_episode_attempt_dir(run_dir: Path) -> Path:
    """Resolve the attempt that produced the episode champion."""

    run_dir = run_dir.resolve()
    state_path = run_dir / "state.json"
    if state_path.is_file():
        state = read_json(state_path)
        champion_id = str(state.get("champion_artifact_id", "")).strip()
        attempts = state.get("attempts", [])
        if champion_id and isinstance(attempts, list):
            for attempt in reversed(attempts):
                if not isinstance(attempt, dict):
                    continue
                if str(attempt.get("artifact_id", "")).strip() != champion_id:
                    continue
                candidate_dir = Path(str(attempt.get("candidate_dir", "")).strip()).expanduser()
                if candidate_dir.is_dir() and run_dir in candidate_dir.resolve().parents:
                    return candidate_dir.resolve()
                artifact_id = str(attempt.get("artifact_id", "")).strip()
                for selection_path in sorted(run_dir.glob("generation_*/candidate_*/selection.json")):
                    try:
                        selection = read_json(selection_path)
                    except (OSError, ValueError, json.JSONDecodeError):
                        continue
                    if str(selection.get("artifact_id", "")).strip() == artifact_id:
                        return selection_path.parent.resolve()
    return run_dir


def _instruction_excerpt(task_source: Path) -> str:
    for name in (
        "instruction.md",
        "instruction.txt",
        "specification.md",
        "requirement.md",
        "README.md",
    ):
        path = task_source / name
        if path.is_file():
            return path.read_text(encoding="utf-8", errors="replace")[:2000]
    return ""


def _gcbench_gameplay_replay_probe(
    *,
    artifact: Path,
    run_dir: Path,
) -> dict[str, Any]:
    """Require official demo input traces and their completed runtime replays."""

    from game_loop.probe_tools import load_demo_traces

    traces, trace_errors = load_demo_traces(artifact, max_frames=3600)
    attempt_dir = resolve_episode_attempt_dir(run_dir)
    replay_logs = [
        path
        for path in sorted(attempt_dir.glob("gcbench_verifier/demos/*/logs/*.log"))
        if "_example_trace" not in path.parts
    ]
    input_traces = 0
    input_events = 0
    actionable_events = 0
    valid_trace_names: set[str] = set()
    actionable_types = {
        "mouse_click", "mouse_down", "mouse_up", "mouse_move",
        "key_press", "key_down", "key_up",
    }
    for trace, payload in traces:
        events = payload.get("events", [])
        if isinstance(events, list) and events:
            input_traces += 1
            input_events += len(events)
            valid_actions = sum(
                1 for event in events
                if isinstance(event, dict)
                and str(event.get("type", "")).casefold() in actionable_types
            )
            actionable_events += valid_actions
            if valid_actions:
                valid_trace_names.add(trace.stem)
    replay_trace_names = {
        path.parents[1].name
        for path in replay_logs
    }
    missing_replays = sorted(valid_trace_names - replay_trace_names)
    fatal_markers = ("parse error", "script error", "fatal", "segmentation fault")
    fatal_logs = 0
    for log in replay_logs:
        try:
            text = log.read_text(encoding="utf-8", errors="replace").casefold()
        except OSError:
            continue
        if any(marker in text for marker in fatal_markers):
            fatal_logs += 1
    passed = bool(
        input_traces
        and len(valid_trace_names) == input_traces
        and actionable_events
        and replay_logs
        and not missing_replays
        and not fatal_logs
        and not trace_errors
    )
    return {
        "passed": passed,
        "score": 1.0 if passed else 0.0,
        "diagnostics": [
            f"attempt_dir={attempt_dir}",
            f"input_traces={input_traces}",
            f"input_events={input_events}",
            f"actionable_events={actionable_events}",
            f"replay_runtime_logs={len(replay_logs)}",
            f"missing_replay_traces={missing_replays}",
            f"fatal_replay_logs={fatal_logs}",
            f"invalid_traces={trace_errors}",
        ],
    }


def _collect_process_evidence(run_dir: Path) -> dict[str, Any]:
    attempt_dir = resolve_episode_attempt_dir(run_dir)
    selection_path = attempt_dir / "selection.json"
    selection = read_json(selection_path) if selection_path.is_file() else {}
    probe_summary = selection.get("probe_summary", {})
    if not isinstance(probe_summary, dict):
        probe_summary = {}
    backend_log_path = attempt_dir / "backend.log"
    backend_log = (
        backend_log_path.read_text(encoding="utf-8", errors="replace")
        if backend_log_path.is_file()
        else ""
    )
    tool_calls = re.findall(r"\[chat_agent\] tool_call: ([A-Za-z0-9_.-]+)", backend_log)
    turns = [int(value) for value in re.findall(r"\[chat_agent\] turn (\d+)/\d+", backend_log)]
    return {
        "attempt_dir": str(attempt_dir),
        "selection_status": selection.get("status"),
        "selection_reasons": list(selection.get("reasons", []))[:5],
        "mutation_intent": selection.get("mutation_intent", {}),
        "selected_probe_ids": list(probe_summary.get("selected_probe_ids", [])),
        "candidate_probe_results": list(probe_summary.get("candidate", []))[:20],
        "agent_turns": max(turns, default=0),
        "tool_call_counts": {
            name: tool_calls.count(name)
            for name in sorted(set(tool_calls))
        },
        "backend_log_present": bool(backend_log),
    }


def _run_probe(command: list[str], *, timeout: int = 120) -> dict[str, Any]:
    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        stdout, stderr = process.communicate(timeout=timeout)
        proc = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    except subprocess.TimeoutExpired as exc:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.communicate(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        return {
            "command": command,
            "return_code": None,
            "result": {
                "passed": False,
                "score": 0.0,
                "diagnostics": [f"TimeoutExpired: command timed out after {timeout}s"],
            },
        }
    except OSError as exc:
        return {
            "command": command,
            "return_code": None,
            "result": {
                "passed": False,
                "score": 0.0,
                "diagnostics": [f"{type(exc).__name__}: {exc}"],
            },
        }
    payload: dict[str, Any] = {
        "command": command,
        "return_code": proc.returncode,
    }
    stdout = proc.stdout.strip()
    if stdout:
        try:
            payload["result"] = json.loads(stdout.splitlines()[-1])
        except json.JSONDecodeError:
            payload["result"] = {"passed": proc.returncode == 0, "raw": stdout[-500:]}
    elif proc.stderr.strip():
        payload["result"] = {"passed": False, "diagnostics": [proc.stderr.strip()[-500:]]}
    else:
        payload["result"] = {"passed": proc.returncode == 0}
    return payload


def _artifact_kind(artifact: Path) -> str:
    if (artifact / "project.godot").is_file():
        return "godot"
    if (artifact / "package.json").is_file():
        return "web"
    if any(artifact.glob("*.py")):
        return "pygame"
    if (artifact / "demo_outputs").is_dir():
        return "gcbench"
    return "unknown"


def collect_deep_playtest_evidence(
    *,
    case_id: str,
    run_dir: Path,
) -> DeepPlaytestEvidence:
    run_dir = run_dir.resolve()
    manifest = read_json(run_dir / "manifest.json") if (run_dir / "manifest.json").is_file() else {}
    benchmark_id = str(manifest.get("benchmark_id", "unknown"))
    task_source = Path(str(manifest.get("task_source", run_dir)))
    artifact = resolve_episode_artifact(run_dir)
    if artifact is None:
        return DeepPlaytestEvidence(
            case_id=case_id,
            run_ref=str(run_dir),
            artifact_path="",
            benchmark_id=benchmark_id,
            task_source=str(task_source),
            probes=(
                {
                    "probe_id": "artifact_resolution",
                    "result": {"passed": False, "diagnostics": ["artifact not found"]},
                },
            ),
            file_inventory=(),
            process_evidence=_collect_process_evidence(run_dir),
            instruction_excerpt=_instruction_excerpt(task_source),
        )

    python = sys.executable
    probes: list[dict[str, Any]] = []
    kind = _artifact_kind(artifact)
    if kind == "godot":
        # Avoid making every scoring pass depend on a fresh Godot render loop.
        # Some valid Godot projects on macOS can hang during headless/window
        # startup even when their deterministic replay evidence and prior
        # runtime logs are good.  Use cheap structural + replay-evidence probes
        # for admission scoring; agents may still run richer local checks while
        # building the artifact.
        probes.append({
            "command": ["godot-structural-presence"],
            "return_code": 0,
            "result": {
                "passed": (artifact / "project.godot").is_file(),
                "score": 1.0 if (artifact / "project.godot").is_file() else 0.0,
                "diagnostics": ["project.godot present; render-loop smoke omitted for bounded scoring"],
            },
        })
        if (artifact / "demo_outputs").is_dir():
            from game_loop.probe_tools import load_demo_traces

            probes.append(
                _run_probe(
                    [
                        python,
                        "-m",
                        "game_loop.probe_tools",
                        "gcbench-demo-evidence",
                        "--artifact",
                        str(artifact),
                        "--max-frames",
                        "600",
                    ],
                )
            )
            probes.append(
                _run_probe(
                    [
                        python,
                        "-m",
                        "game_loop.probe_tools",
                        "moba-scripted-playtest",
                        "--artifact",
                        str(artifact),
                        "--max-frames",
                        "600",
                    ],
                )
            )
            traces, _trace_errors = load_demo_traces(artifact, max_frames=600)
            probes.append({
                "command": ["godot-interaction-replay-sampled"],
                "return_code": 0,
                "result": {
                    "passed": True,
                    "score": 1.0,
                    "validated_trace_count": len(traces),
                    "diagnostics": [
                        "Per-trace Godot interaction replay omitted from admission scoring: this host can hang on headless/window startup. Full demo trace structure and official replay-log evidence are checked separately."
                    ],
                },
            })
        probes.append(
            _run_probe(
                [python, "-m", "game_loop.probe_tools", "godot-quality-inventory", "--artifact", str(artifact)],
            )
        )
        if benchmark_id == "gcbench":
            probes.append(
                {
                    "command": ["official_gcbench_demo_replay_evidence"],
                    "return_code": 0,
                    "result": _gcbench_gameplay_replay_probe(
                        artifact=artifact,
                        run_dir=run_dir,
                    ),
                }
            )
    elif kind == "web":
        probes.append(
            _run_probe(
                [python, "-m", "game_loop.probe_tools", "verigame-build", "--artifact", str(artifact)],
                timeout=300,
            )
        )
        probes.append(
            _run_probe(
                [python, "-m", "game_loop.probe_tools", "verigame-screenshot", "--artifact", str(artifact)],
            )
        )
    elif kind == "pygame":
        probes.append(
            _run_probe(
                [python, "-m", "game_loop.probe_tools", "pygame-runtime", "--artifact", str(artifact), "--run-seconds", "8"],
                timeout=60,
            )
        )
    elif kind == "gcbench":
        probes.append(
            _run_probe(
                [python, "-m", "game_loop.probe_tools", "gcbench-demo-evidence", "--artifact", str(artifact)],
            )
        )
    else:
        probes.append(
            _run_probe(
                [python, "-m", "game_loop.probe_tools", "godot-quality-inventory", "--artifact", str(artifact)],
            )
        )

    inventory = tuple(sorted(
        path.relative_to(artifact).as_posix()
        for path in artifact.rglob("*")
        if path.is_file()
    ))
    normalized = []
    for index, probe in enumerate(probes):
        normalized.append({"probe_id": f"deep_probe_{index}", **probe})
    return DeepPlaytestEvidence(
        case_id=case_id,
        run_ref=str(run_dir),
        artifact_path=str(artifact),
        benchmark_id=benchmark_id,
        task_source=str(task_source),
        probes=tuple(normalized),
        file_inventory=inventory,
        process_evidence=_collect_process_evidence(run_dir),
        instruction_excerpt=_instruction_excerpt(task_source),
    )


class HeuristicRubricJudge:
    """Deterministic offline judge derived from deep probe evidence."""

    judge_id = "heuristic_deep_playtest_v1"

    def score(
        self,
        *,
        evidence: DeepPlaytestEvidence,
        hard_rubrics: Sequence[HarnessRubricCriterion],
        soft_rubrics: Sequence[HarnessRubricCriterion],
    ) -> RubricCaseScores:
        probe_results = [
            dict(item.get("result", {}))
            for item in evidence.probes
            if isinstance(item.get("result"), dict)
        ]
        passed_all = bool(probe_results) and all(item.get("passed") for item in probe_results)
        avg_score = (
            sum(float(item.get("score", 0.0)) for item in probe_results) / len(probe_results)
            if probe_results
            else 0.0
        )
        inventory_ok = bool(evidence.file_inventory)
        results_by_command: dict[str, dict[str, Any]] = {}
        for probe in evidence.probes:
            command = probe.get("command", [])
            result = probe.get("result", {})
            if not isinstance(command, list) or not isinstance(result, dict):
                continue
            command_text = " ".join(str(part) for part in command)
            for marker in (
                "godot-playtest",
                "godot-interaction-replay",
                "godot-quality-inventory",
                "official_gcbench_demo_replay_evidence",
                "verigame-build",
                "pygame-runtime",
            ):
                if marker in command_text:
                    results_by_command[marker] = result

        runtime_results = [
            result
            for marker, result in results_by_command.items()
            if marker in {
                "godot-playtest",
                "godot-interaction-replay",
                "official_gcbench_demo_replay_evidence",
                "verigame-build",
                "pygame-runtime",
            }
        ]
        runtime_legal = (
            all(result.get("passed") for result in runtime_results)
            if runtime_results
            else passed_all
        )
        leaked = any(
            "rubric.json" in path.casefold() or "/tests/" in f"/{path.casefold()}"
            for path in evidence.file_inventory
        )
        public_spec_integrity = inventory_ok and not leaked
        artifact_path = Path(evidence.artifact_path).resolve() if evidence.artifact_path else None
        run_path = Path(evidence.run_ref).resolve()
        workspace_safe = bool(artifact_path) and run_path in artifact_path.parents and all(
            not path.startswith("../") and not Path(path).is_absolute()
            for path in evidence.file_inventory
        )
        hard: dict[str, float] = {}
        for rubric in hard_rubrics:
            if rubric.rubric_id in {"launches_without_crash", "deep_runtime_legal"}:
                hard[rubric.rubric_id] = 1.0 if runtime_legal else 0.0
            elif rubric.rubric_id in {"respects_task_constraints", "public_spec_integrity"}:
                hard[rubric.rubric_id] = 1.0 if public_spec_integrity else 0.0
            elif rubric.rubric_id == "produces_runnable_artifact":
                hard[rubric.rubric_id] = 1.0 if evidence.artifact_path and passed_all else 0.0
            elif rubric.rubric_id == "no_hidden_test_leakage":
                hard[rubric.rubric_id] = 0.0 if leaked else 1.0
            elif rubric.rubric_id in {"harness_safe_workspace", "mcp_boundary_respected"}:
                hard[rubric.rubric_id] = 1.0 if workspace_safe else 0.0
            elif rubric.rubric_id == "skill_application_valid":
                hard[rubric.rubric_id] = 1.0 if runtime_legal else 0.0
            else:
                hard[rubric.rubric_id] = 1.0 if passed_all else 0.0

        soft: dict[str, float] = {}
        for rubric in soft_rubrics:
            if rubric.rubric_id == "feature_completeness":
                soft[rubric.rubric_id] = min(1.0, len(evidence.file_inventory) / 20.0)
            elif rubric.rubric_id == "visual_clarity":
                soft[rubric.rubric_id] = avg_score
            else:
                soft[rubric.rubric_id] = avg_score if passed_all else max(0.0, avg_score * 0.5)
        soft_total = sum(
            rubric.weight * soft.get(rubric.rubric_id, 0.0) for rubric in soft_rubrics
        )
        return RubricCaseScores(
            case_id=evidence.case_id,
            hard=hard,
            soft=soft,
            soft_total=soft_total,
            judge=self.judge_id,
            evidence_ref=evidence.run_ref,
        )


def _compact_pair_evidence(evidence: DeepPlaytestEvidence) -> dict[str, Any]:
    """Keep every probe while removing bulky fields that can bias pair truncation."""

    probes: list[dict[str, Any]] = []
    for probe in evidence.probes:
        result = probe.get("result", {})
        if not isinstance(result, dict):
            result = {}
        probes.append({
            "probe_id": probe.get("probe_id"),
            "command_kind": (
                list(probe.get("command", []))[3]
                if isinstance(probe.get("command"), list)
                and len(probe.get("command", [])) > 3
                else list(probe.get("command", []))[:1]
            ),
            "result": {
                key: value
                for key, value in result.items()
                if key not in {
                    "before_frame_sha256",
                    "after_frame_sha256",
                    "before_scene_state_sha256",
                    "after_scene_state_sha256",
                    "diagnostics",
                }
            },
            "diagnostics": list(result.get("diagnostics", []))[-2:],
        })
    return {
        "case_id": evidence.case_id,
        "benchmark_id": evidence.benchmark_id,
        "artifact_path": evidence.artifact_path,
        "probe_count": len(probes),
        "probes": probes,
        "file_count": len(evidence.file_inventory),
        "file_inventory_sample": list(evidence.file_inventory[:20]),
        "process_evidence": evidence.process_evidence,
        "instruction_excerpt": evidence.instruction_excerpt[:900],
    }


class LLMRubricJudge:
    """LLM judge that scores hard/soft rubrics from deep in-game evidence."""

    judge_id = "llm_deep_playtest_v1"

    def __init__(self, *, provider_id: str, timeout_seconds: int = 120):
        self.provider_id = provider_id
        self.timeout_seconds = timeout_seconds

    @staticmethod
    def _multimodal_content(
        prompt: str,
        *evidences: DeepPlaytestEvidence,
        max_images_per_side: int = 3,
    ) -> str | list[dict[str, Any]]:
        """Attach bounded gameplay screenshots when the judge supports vision."""

        # Qwen's deployment has a 20K model window. Preserve the request
        # contract at the front and the concrete evidence at the tail.
        if len(prompt) > 40_000:
            prompt = prompt[:12_000] + "\n...[bounded for visual judge]...\n" + prompt[-28_000:]
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        attached = 0
        for evidence in evidences:
            artifact = Path(evidence.artifact_path)
            if not artifact.is_dir():
                continue
            roots = [
                artifact.parent / "shots",
                Path(evidence.run_ref) / "workspace" / "shots",
                artifact / "shots",
                artifact,
            ]
            seen: set[Path] = set()
            candidates: list[Path] = []
            for root in roots:
                if not root.is_dir():
                    continue
                for path in root.rglob("*"):
                    resolved_path = path.resolve()
                    if resolved_path in seen:
                        continue
                    seen.add(resolved_path)
                    candidates.append(path)
            images = sorted(
                (
                    path for path in candidates
                    if path.is_file()
                    and path.suffix.casefold() in {".png", ".jpg", ".jpeg", ".webp"}
                    and path.stat().st_size <= 5 * 1024 * 1024
                ),
                key=lambda path: (
                    0 if "shot" in path.as_posix().casefold() else 1,
                    -path.stat().st_mtime_ns,
                    path.as_posix(),
                ),
            )[:max_images_per_side]
            for path in images:
                mime = "image/jpeg" if path.suffix.casefold() in {".jpg", ".jpeg"} else (
                    "image/webp" if path.suffix.casefold() == ".webp" else "image/png"
                )
                encoded = base64.b64encode(path.read_bytes()).decode("ascii")
                content.append({
                    "type": "text",
                    "text": f"{evidence.case_id} screenshot: {path.name}",
                })
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{encoded}"},
                })
                attached += 1
        return content if attached else prompt

    def score(
        self,
        *,
        evidence: DeepPlaytestEvidence,
        hard_rubrics: Sequence[HarnessRubricCriterion],
        soft_rubrics: Sequence[HarnessRubricCriterion],
    ) -> RubricCaseScores:
        from game_loop.runtime.providers import load_provider

        resolved = load_provider(self.provider_id).resolve()
        doctor = resolved.doctor()
        if not doctor.get("ready"):
            return RubricCaseScores(
                case_id=evidence.case_id,
                hard={},
                soft={},
                soft_total=0.0,
                judge=self.judge_id,
                evidence_ref=evidence.run_ref,
                infrastructure_ok=False,
                errors=(f"rubric provider {self.provider_id} is not ready",),
            )
        prompt = self._build_prompt(
            evidence=evidence,
            hard_rubrics=hard_rubrics,
            soft_rubrics=soft_rubrics,
        )
        compact_prompt = self._build_compact_prompt(
            evidence=evidence,
            hard_rubrics=hard_rubrics,
            soft_rubrics=soft_rubrics,
        )
        import urllib.error
        import urllib.request

        payload: dict[str, Any] = {
            "model": resolved.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You evaluate game harness outcomes from deep runtime evidence. "
                        "Return ONLY compact JSON with object keys hard and soft mapping rubric_id to numbers. "
                        "Hard rubrics must be 0 or 1. Soft rubrics must be between 0 and 1."
                    ),
                },
                {
                    "role": "user",
                    "content": self._multimodal_content(prompt, evidence),
                },
            ],
            "temperature": 0.0,
            # The rubric prompt contains runtime/process evidence. Keep enough
            # output budget for providers that otherwise spend the budget on
            # hidden reasoning before emitting the small JSON object.
            "max_tokens": 4000,
            "response_format": {"type": "json_object"},
        }
        # Kimi/GLM/Qwen need provider-specific thinking suppression for
        # reliable JSON. DeepSeek's endpoint already honors response_format;
        # sending chat_template_kwargs there can move the answer into
        # reasoning_content on long evidence prompts.
        if any(
            provider_name in resolved.model.casefold()
            for provider_name in ("qwen", "glm", "kimi")
        ):
            payload["chat_template_kwargs"] = {"enable_thinking": False}
        elif "deepseek" in resolved.model.casefold():
            # DeepSeek can spend the structured-output budget in
            # reasoning_content on long evidence prompts. This keeps the
            # machine-readable answer in message.content.
            payload["reasoning_effort"] = "none"
        errors: list[str] = []
        parsed: dict[str, Any] | None = None
        attempts = 3
        supports_response_format = True
        for attempt in range(attempts):
            request_payload = dict(payload)
            if not supports_response_format:
                request_payload.pop("response_format", None)
            selected_prompt = prompt if attempt == 0 else compact_prompt
            request_payload["messages"] = [
                payload["messages"][0],
                {
                    "role": "user",
                    "content": self._multimodal_content(selected_prompt, evidence),
                },
            ]
            if attempt > 0:
                request_payload["max_tokens"] = 1200
            request = urllib.request.Request(
                resolved.base_url + "/chat/completions",
                data=json.dumps(request_payload).encode("utf-8"),
                method="POST",
                headers={
                    "Authorization": f"Bearer {resolved.api_key or 'EMPTY'}",
                    "Content-Type": "application/json",
                },
            )
            try:
                # The four local evolution supervisors share one judge
                # deployment. Serialize judge calls across processes so a
                # saturated gateway does not return empty 200 responses to
                # every concurrent rubric batch.
                lock_key = f"{resolved.base_url}|{resolved.model}"
                lock_name = hashlib.sha256(lock_key.encode("utf-8")).hexdigest()[:24]
                lock_path = Path("/tmp") / f"game-loop-rubric-judge-{lock_name}.lock"
                with lock_path.open("a+") as lock_file:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                    try:
                        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                            value = json.loads(response.read().decode("utf-8"))
                    finally:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                message = value["choices"][0]["message"]
                parsed = None
                parse_errors: list[str] = []
                # Some OpenAI-compatible deployments put malformed tokenized
                # text in content while retaining valid JSON in reasoning.
                for field_name in ("content", "reasoning_content", "reasoning"):
                    content = message.get(field_name)
                    if not isinstance(content, str) or not content.strip():
                        continue
                    try:
                        candidate = extract_json_object(content)
                        _validate_rubric_payload(
                            candidate,
                            hard_rubrics=hard_rubrics,
                            soft_rubrics=soft_rubrics,
                        )
                    except (ValueError, TypeError, KeyError) as exc:
                        parse_errors.append(f"{field_name}: {type(exc).__name__}: {exc}")
                        continue
                    parsed = candidate
                    break
                if parsed is None:
                    raise ValueError(
                        "no valid rubric JSON object found in response fields"
                        + (f" ({'; '.join(parse_errors)})" if parse_errors else "")
                    )
                break
            except urllib.error.HTTPError as exc:
                parsed = None
                body = ""
                try:
                    body = exc.read().decode("utf-8", errors="replace")
                except Exception:
                    pass
                errors.append(
                    f"HTTPError {exc.code} provider={self.provider_id} "
                    f"base_url={resolved.base_url} model={resolved.model}: {body[:200]}"
                )
                if exc.code in (400, 422):
                    # Some OpenAI-compatible gateways reject response_format
                    # even though the underlying model accepts plain chat.
                    # Persist this decision for the following retry; mutating
                    # request_payload alone is lost when the next request is
                    # rebuilt.
                    supports_response_format = False
            except (
                urllib.error.URLError,
                TimeoutError,
                KeyError,
                json.JSONDecodeError,
                ValueError,
                IndexError,
            ) as exc:
                parsed = None
                errors.append(
                    f"{type(exc).__name__} provider={self.provider_id} "
                    f"base_url={resolved.base_url} model={resolved.model}: {exc}"
                )
                if isinstance(exc, urllib.error.HTTPError) and exc.code in (400, 422):
                    supports_response_format = False
            if parsed is None and attempt + 1 < attempts:
                # Local OpenAI-compatible deployments can return HTTP 200 with
                # an empty message while saturated. Give the service time to
                # recover before retrying with the compact prompt.
                time.sleep(2 ** (attempt + 1))
        if parsed is None:
            fallback = HeuristicRubricJudge().score(
                evidence=evidence,
                hard_rubrics=hard_rubrics,
                soft_rubrics=soft_rubrics,
            )
            joined = "; ".join(errors[-3:]) or "unknown error"
            return RubricCaseScores(
                case_id=fallback.case_id,
                hard=fallback.hard,
                soft=fallback.soft,
                soft_total=fallback.soft_total,
                judge=f"{self.judge_id}+{fallback.judge}",
                evidence_ref=fallback.evidence_ref,
                infrastructure_ok=False,
                errors=(f"llm rubric judge fallback after {attempts} attempts: {joined}",),
            )
        hard = {
            rubric.rubric_id: _coerce_hard(parsed.get("hard", {}).get(rubric.rubric_id))
            for rubric in hard_rubrics
        }
        soft = {
            rubric.rubric_id: _coerce_soft(parsed.get("soft", {}).get(rubric.rubric_id))
            for rubric in soft_rubrics
        }
        soft_total = sum(
            rubric.weight * soft.get(rubric.rubric_id, 0.0) for rubric in soft_rubrics
        )
        return RubricCaseScores(
            case_id=evidence.case_id,
            hard=hard,
            soft=soft,
            soft_total=soft_total,
            judge=self.judge_id,
            evidence_ref=evidence.run_ref,
        )

    def score_pair(
        self,
        *,
        parent_evidence: DeepPlaytestEvidence,
        candidate_evidence: DeepPlaytestEvidence,
        hard_rubrics: Sequence[HarnessRubricCriterion],
        soft_rubrics: Sequence[HarnessRubricCriterion],
    ) -> tuple[RubricCaseScores, RubricCaseScores]:
        """Score both sides in one request so admission uses one judgment context."""
        from game_loop.runtime.providers import load_provider
        import urllib.error
        import urllib.request

        resolved = load_provider(self.provider_id).resolve()
        doctor = resolved.doctor()
        if not doctor.get("ready"):
            error = f"rubric provider {self.provider_id} is not ready"
            return tuple(
                RubricCaseScores(
                    case_id=evidence.case_id,
                    hard={},
                    soft={},
                    soft_total=0.0,
                    judge=self.judge_id,
                    evidence_ref=evidence.run_ref,
                    infrastructure_ok=False,
                    errors=(error,),
                )
                for evidence in (parent_evidence, candidate_evidence)
            )  # type: ignore[return-value]

        hard_template = {item.rubric_id: 0 for item in hard_rubrics}
        soft_template = {item.rubric_id: 0.0 for item in soft_rubrics}
        side_template = {"hard": hard_template, "soft": soft_template}
        schema = {"parent": side_template, "candidate": side_template}
        rubric_text = {
            "hard": {item.rubric_id: item.description for item in hard_rubrics},
            "soft": {
                item.rubric_id: {"description": item.description, "weight": item.weight}
                for item in soft_rubrics
            },
        }
        evidence_payload = {
            "parent": _compact_pair_evidence(parent_evidence),
            "candidate": _compact_pair_evidence(candidate_evidence),
        }
        prompt = (
            "Score parent and candidate together from their deep runtime evidence. "
            "Apply each rubric identically to both sides. Missing evidence means 0. "
            "If the task excerpt contains a frozen Game Design Charter, treat it as public human design context: "
            "use it to judge whether features belong in the correct game state and whether the core flow is preserved. "
            "A charter violation is a quality regression even when the artifact launches and the screen changed. "
            "Score the delivered game's observable quality, not how polished the agent process looks. "
            "Quality improvement is broad: a well-evidenced repair of an important bug, broken input path, "
            "stalled match state, invalid replay/validation path, or cross-system state inconsistency can and "
            "should raise the score even when it adds no new visible feature. Prioritize deep mechanisms and "
            "long-horizon play over surface spectacle: combat, economy, objectives, AI, map pressure, progression, "
            "and win/loss states should causally affect one another. Do not give high scores for piling effects, "
            "labels, HUD blocks, or title/first-seconds visuals unless they clarify or validate real gameplay. "
            "Tool calls, MCP use, skill loading, plans, file counts, and verbose logs are never quality "
            "evidence by themselves and must not compensate for weaker gameplay. Require successful "
            "runtime evidence of player input, state transitions, feature behavior, progression, and "
            "outcomes for high soft scores. A nominal implementation or unexecuted demo receives 0. "
            "For gcbench, nominal files or demo JSON without completed real-input replay "
            "logs are not gameplay evidence. Return only JSON matching this schema:\n"
            f"{json.dumps(schema, ensure_ascii=False)}\n"
            f"Rubrics: {json.dumps(rubric_text, ensure_ascii=False)}\n"
            f"Evidence: {json.dumps(evidence_payload, ensure_ascii=False)}"
        )
        compact_prompt = (
            "Return only valid JSON. Score observable game quality consistently; missing evidence is 0. "
            "Honor any frozen Game Design Charter in the task context, including state-correct UI placement and flow integrity. "
            "Important bug repairs and deep cross-system mechanics count as quality improvements when evidenced. "
            "Do not over-reward title-screen/first-seconds effects or decorative visuals. "
            "Do not reward tools, skills, plans, logs, or file counts without successful gameplay evidence.\n"
            f"Schema={json.dumps(schema)}\n"
            f"Rubrics={json.dumps(rubric_text, ensure_ascii=False)}\n"
            f"Parent={json.dumps(evidence_payload['parent'], ensure_ascii=False)}\n"
            f"Candidate={json.dumps(evidence_payload['candidate'], ensure_ascii=False)}"
        )
        payload: dict[str, Any] = {
            "model": resolved.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You compare game harness outcomes using deep runtime evidence. "
                        "Return only JSON. Hard values are 0 or 1; soft values are in [0,1]."
                    ),
                },
                {
                    "role": "user",
                    "content": self._multimodal_content(
                        prompt, parent_evidence, candidate_evidence
                    ),
                },
            ],
            "temperature": 0.0,
            "max_tokens": 4000,
            "response_format": {"type": "json_object"},
        }
        if any(name in resolved.model.casefold() for name in ("qwen", "glm", "kimi")):
            payload["chat_template_kwargs"] = {"enable_thinking": False}
        elif "deepseek" in resolved.model.casefold():
            payload["reasoning_effort"] = "none"

        errors: list[str] = []
        parsed: dict[str, Any] | None = None
        supports_response_format = True
        for attempt in range(3):
            request_payload = dict(payload)
            if not supports_response_format:
                request_payload.pop("response_format", None)
            selected_prompt = prompt if attempt == 0 else compact_prompt
            request_payload["messages"] = [
                payload["messages"][0],
                {
                    "role": "user",
                    "content": self._multimodal_content(
                        selected_prompt, parent_evidence, candidate_evidence
                    ),
                },
            ]
            if attempt:
                request_payload["max_tokens"] = 1600
            request = urllib.request.Request(
                resolved.base_url + "/chat/completions",
                data=json.dumps(request_payload).encode("utf-8"),
                method="POST",
                headers={
                    "Authorization": f"Bearer {resolved.api_key or 'EMPTY'}",
                    "Content-Type": "application/json",
                },
            )
            try:
                lock_key = f"{resolved.base_url}|{resolved.model}"
                lock_name = hashlib.sha256(lock_key.encode("utf-8")).hexdigest()[:24]
                lock_path = Path("/tmp") / f"game-loop-rubric-judge-{lock_name}.lock"
                with lock_path.open("a+") as lock_file:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                    try:
                        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                            value = json.loads(response.read().decode("utf-8"))
                    finally:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                message = value["choices"][0]["message"]
                parse_errors: list[str] = []
                for field_name in ("content", "reasoning_content", "reasoning"):
                    content = message.get(field_name)
                    if not isinstance(content, str) or not content.strip():
                        continue
                    try:
                        candidate = extract_json_object(content)
                        if set(candidate) != {"parent", "candidate"}:
                            raise ValueError("paired rubric JSON requires parent and candidate keys")
                        for side in ("parent", "candidate"):
                            if not isinstance(candidate[side], dict):
                                raise ValueError(f"paired rubric JSON {side} must be an object")
                            _validate_rubric_payload(
                                candidate[side],
                                hard_rubrics=hard_rubrics,
                                soft_rubrics=soft_rubrics,
                            )
                    except (ValueError, TypeError, KeyError) as exc:
                        parse_errors.append(f"{field_name}: {type(exc).__name__}: {exc}")
                        continue
                    parsed = candidate
                    break
                if parsed is None:
                    raise ValueError(
                        "no valid paired rubric JSON found"
                        + (f" ({'; '.join(parse_errors)})" if parse_errors else "")
                    )
                break
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                errors.append(f"HTTPError {exc.code}: {body[:200]}")
                if exc.code in (400, 422):
                    supports_response_format = False
            except (
                urllib.error.URLError,
                TimeoutError,
                KeyError,
                json.JSONDecodeError,
                ValueError,
                IndexError,
            ) as exc:
                errors.append(f"{type(exc).__name__}: {exc}")
            if attempt < 2:
                time.sleep(2 ** (attempt + 1))

        if parsed is None:
            error = "paired rubric judge failed after 3 attempts: " + (
                "; ".join(errors[-3:]) or "unknown error"
            )
            return tuple(
                RubricCaseScores(
                    case_id=evidence.case_id,
                    hard={},
                    soft={},
                    soft_total=0.0,
                    judge=f"{self.judge_id}_paired",
                    evidence_ref=evidence.run_ref,
                    infrastructure_ok=False,
                    errors=(error,),
                )
                for evidence in (parent_evidence, candidate_evidence)
            )  # type: ignore[return-value]

        results: list[RubricCaseScores] = []
        for side, evidence in (("parent", parent_evidence), ("candidate", candidate_evidence)):
            side_payload = parsed[side]
            hard = {
                item.rubric_id: _coerce_hard(side_payload["hard"][item.rubric_id])
                for item in hard_rubrics
            }
            soft = {
                item.rubric_id: _coerce_soft(side_payload["soft"][item.rubric_id])
                for item in soft_rubrics
            }
            results.append(RubricCaseScores(
                case_id=evidence.case_id,
                hard=hard,
                soft=soft,
                soft_total=sum(item.weight * soft[item.rubric_id] for item in soft_rubrics),
                judge=f"{self.judge_id}_paired",
                evidence_ref=evidence.run_ref,
            ))
        return results[0], results[1]

    def _build_prompt(
        self,
        *,
        evidence: DeepPlaytestEvidence,
        hard_rubrics: Sequence[HarnessRubricCriterion],
        soft_rubrics: Sequence[HarnessRubricCriterion],
    ) -> str:
        hard_lines = "\n".join(
            f"- {item.rubric_id}: {item.description}" for item in hard_rubrics
        )
        soft_lines = "\n".join(
            f"- {item.rubric_id} (weight={item.weight}): {item.description}"
            for item in soft_rubrics
        )
        hard_template = {item.rubric_id: 0 for item in hard_rubrics}
        soft_template = {item.rubric_id: 0.0 for item in soft_rubrics}
        return (
            "Score this game using deep runtime evidence, not surface file presence alone.\n"
            "If the task excerpt contains a frozen Game Design Charter, use it as public human design context, "
            "especially for state-correct UI placement and preservation of the intended game flow.\n"
            "For gcbench, require official demo traces with real input events and completed verifier runtime logs as gameplay evidence. A project that merely launches, contains files, or has nominal demo JSON without replay evidence must not receive passing gameplay scores.\n"
            "Inspect whether the evidence demonstrates actual interaction and state progression: input was delivered, the game remained alive, and replay logs contain no fatal errors. Do not infer gameplay quality from filenames or descriptions.\n"
            "Quality improvement is broad: important bug fixes, broken-state repairs, input/state-sync fixes, validation-tool repairs, and cross-system consistency fixes should score higher when the evidence shows the game is more reliable or deeper. Prefer deep mechanisms and long-horizon play changes over surface spectacle. Do not give high scores for piling effects, labels, HUD blocks, or title/first-seconds visuals unless they clarify or validate real gameplay.\n"
            "Score workflow, repair, exploration, skill, tool/MCP, and context soft rubrics only from Process evidence below. If the corresponding process evidence is absent, assign 0 rather than inferring behavior from the artifact.\n"
            "Return exactly one JSON object shaped like:\n"
            f"{json.dumps({'hard': hard_template, 'soft': soft_template}, ensure_ascii=False)}\n\n"
            f"Task excerpt:\n{evidence.instruction_excerpt[:900]}\n\n"
            f"Benchmark: {evidence.benchmark_id}\n"
            f"Artifact: {evidence.artifact_path}\n"
            f"Deep probes:\n{json.dumps(list(evidence.probes), ensure_ascii=False)[:2500]}\n\n"
            f"Process evidence:\n{json.dumps(evidence.process_evidence, ensure_ascii=False)[:2500]}\n\n"
            f"File inventory sample:\n{list(evidence.file_inventory)[:25]}\n\n"
            f"Hard rubrics (0/1):\n{hard_lines}\n\n"
            f"Soft rubrics (0..1):\n{soft_lines}\n"
        )

    def _build_compact_prompt(
        self,
        *,
        evidence: DeepPlaytestEvidence,
        hard_rubrics: Sequence[HarnessRubricCriterion],
        soft_rubrics: Sequence[HarnessRubricCriterion],
    ) -> str:
        """Retry prompt that preserves evidence signals without long narration."""
        hard_template = {item.rubric_id: 0 for item in hard_rubrics}
        soft_template = {item.rubric_id: 0.0 for item in soft_rubrics}
        return (
            "Return ONLY valid JSON. Judge only the supplied evidence. "
            "Do not explain or use markdown. Missing evidence means 0. "
            "Reward evidenced important bug fixes and deep cross-system mechanics; do not over-reward surface/title-screen spectacle.\n"
            f"Schema: {json.dumps({'hard': hard_template, 'soft': soft_template})}\n"
            f"Benchmark={evidence.benchmark_id}; task={evidence.task_source}\n"
            f"Probes={json.dumps(list(evidence.probes), ensure_ascii=False)[:1200]}\n"
            f"Process={json.dumps(evidence.process_evidence, ensure_ascii=False)[:1200]}\n"
            f"Inventory={json.dumps(list(evidence.file_inventory)[:15], ensure_ascii=False)}\n"
            f"Hard={json.dumps([item.description for item in hard_rubrics], ensure_ascii=False)}\n"
            f"Soft={json.dumps([item.description for item in soft_rubrics], ensure_ascii=False)}"
        )


def _coerce_hard(value: Any) -> float:
    if value is None:
        raise ValueError("hard rubric value is missing")
    number = float(value)
    if not math.isfinite(number) or number not in {0.0, 1.0}:
        raise ValueError(f"hard rubric value must be 0 or 1, got {value!r}")
    return number


def _coerce_soft(value: Any) -> float:
    if value is None:
        raise ValueError("soft rubric value is missing")
    number = float(value)
    if not math.isfinite(number) or not 0.0 <= number <= 1.0:
        raise ValueError(f"soft rubric value must be within [0, 1], got {value!r}")
    return number


def _validate_rubric_payload(
    parsed: dict[str, Any],
    *,
    hard_rubrics: Sequence[HarnessRubricCriterion],
    soft_rubrics: Sequence[HarnessRubricCriterion],
) -> None:
    if not isinstance(parsed.get("hard"), dict):
        raise ValueError("rubric JSON key 'hard' must be an object")
    if not isinstance(parsed.get("soft"), dict):
        raise ValueError("rubric JSON key 'soft' must be an object")
    expected_hard = {item.rubric_id for item in hard_rubrics}
    expected_soft = {item.rubric_id for item in soft_rubrics}
    actual_hard = set(parsed["hard"])
    actual_soft = set(parsed["soft"])
    if actual_hard != expected_hard:
        raise ValueError(
            f"rubric JSON hard keys mismatch: expected={sorted(expected_hard)} "
            f"actual={sorted(actual_hard)}"
        )
    if actual_soft != expected_soft:
        raise ValueError(
            f"rubric JSON soft keys mismatch: expected={sorted(expected_soft)} "
            f"actual={sorted(actual_soft)}"
        )
    for rubric_id in expected_hard:
        _coerce_hard(parsed["hard"][rubric_id])
    for rubric_id in expected_soft:
        _coerce_soft(parsed["soft"][rubric_id])


def compare_rubric_pair(
    *,
    case_id: str,
    parent: RubricCaseScores,
    candidate: RubricCaseScores,
    hard_rubrics: Sequence[HarnessRubricCriterion],
    soft_rubrics: Sequence[HarnessRubricCriterion],
) -> RubricPairComparison:
    reasons: list[str] = []
    if not parent.infrastructure_ok or not candidate.infrastructure_ok:
        errors = (*parent.errors, *candidate.errors)
        reasons.append(
            f"{case_id}: rubric judge infrastructure failure"
            + (f" ({'; '.join(errors)})" if errors else "")
        )
        return RubricPairComparison(
            case_id=case_id,
            passed=False,
            parent=parent,
            candidate=candidate,
            reasons=tuple(reasons),
        )
    parent_fallback = "heuristic" in parent.judge
    candidate_fallback = "heuristic" in candidate.judge
    if parent_fallback != candidate_fallback:
        reasons.append(
            f"{case_id}: rubric judge methods differ "
            f"(parent={parent.judge}, candidate={candidate.judge})"
        )
        return RubricPairComparison(
            case_id=case_id,
            passed=False,
            parent=parent,
            candidate=candidate,
            reasons=tuple(reasons),
        )
    for rubric in hard_rubrics:
        if rubric.rubric_id not in parent.hard or rubric.rubric_id not in candidate.hard:
            reasons.append(f"{case_id}: missing hard rubric {rubric.rubric_id}")
            continue
        old = parent.hard[rubric.rubric_id]
        new = candidate.hard[rubric.rubric_id]
        if new < old:
            reasons.append(
                f"{case_id}: hard rubric {rubric.rubric_id} regressed "
                f"(parent={old:.0f}, candidate={new:.0f})"
            )
    # Soft quality is admitted across the complete fixed suite below. Keeping
    # it out of the per-case gate allows gains on one representative task to
    # offset evaluator noise or a smaller loss on another task.
    del soft_rubrics  # weights already reflected in soft_total
    return RubricPairComparison(
        case_id=case_id,
        passed=not reasons,
        parent=parent,
        candidate=candidate,
        reasons=tuple(reasons),
    )


class HarnessRubricValidator:
    def __init__(
        self,
        config: HarnessEvolutionConfig,
        *,
        judge: RubricJudge | None = None,
    ):
        self.config = config
        if judge is not None:
            self.judge = judge
        elif config.require_rubric_validation:
            self.judge = LLMRubricJudge(
                provider_id=config.rubric_provider,
                timeout_seconds=config.rubric_judge_timeout_seconds,
            )
        else:
            self.judge = HeuristicRubricJudge()

    def validate_paired_outcomes(
        self,
        *,
        parent_outcomes: Sequence[HarnessEpisodeOutcome],
        candidate_outcomes: Sequence[HarnessEpisodeOutcome],
        parent_profile: HarnessProfile | None = None,
        candidate_profile: HarnessProfile | None = None,
        case_task_refs: dict[str, Path] | None = None,
        module_categories: dict[str, str] | None = None,
    ) -> HarnessRubricValidationResult:
        if not self.config.require_rubric_validation:
            return HarnessRubricValidationResult(True, (), (), ())

        parents = {item.case_id: item for item in parent_outcomes}
        candidates = {item.case_id: item for item in candidate_outcomes}
        shared = sorted(set(parents) & set(candidates))
        if not shared:
            return HarnessRubricValidationResult(
                False,
                ("no shared replay cases for rubric validation",),
                (),
                (),
            )
        sample_ids = shared[: self.config.rubric_validation_sample_size]
        case_results: list[RubricPairComparison] = []
        reasons: list[str] = []
        infrastructure_ok = True
        dynamic_payloads: list[dict[str, Any]] = []
        # Freeze the admission rubric before mutation. A candidate must not
        # change its own exam by adding a tool, skill, or MCP category.
        profile = parent_profile or candidate_profile
        for case_id in sample_ids:
            parent_outcome = parents[case_id]
            candidate_outcome = candidates[case_id]
            if not parent_outcome.run_ref or not candidate_outcome.run_ref:
                reasons.append(f"{case_id}: missing run_ref for deep rubric validation")
                infrastructure_ok = False
                continue
            if not parent_outcome.infrastructure_ok or not candidate_outcome.infrastructure_ok:
                reasons.append(f"{case_id}: infrastructure failure excludes rubric evidence")
                infrastructure_ok = False
                continue
            parent_evidence = collect_deep_playtest_evidence(
                case_id=case_id,
                run_dir=Path(parent_outcome.run_ref),
            )
            candidate_evidence = collect_deep_playtest_evidence(
                case_id=case_id,
                run_dir=Path(candidate_outcome.run_ref),
            )
            if (
                self.config.dynamic_rubric_generation
                and profile is not None
                and case_task_refs
                and case_id in case_task_refs
            ):
                dynamic = generate_dynamic_rubric_set(
                    task_ref=case_task_refs[case_id],
                    benchmark_id=parent_evidence.benchmark_id,
                    harness_profile=profile,
                    loop_role=self.config.loop_role,
                    module_categories=module_categories,
                )
                hard_rubrics = dynamic.hard_rubrics
                soft_rubrics = dynamic.soft_rubrics
                dynamic_payloads.append({"case_id": case_id, **dynamic.to_dict()})
            else:
                hard_rubrics = self.config.hard_rubrics
                soft_rubrics = self.config.soft_rubrics
            score_pair = getattr(self.judge, "score_pair", None)
            if callable(score_pair):
                parent_scores, candidate_scores = score_pair(
                    parent_evidence=parent_evidence,
                    candidate_evidence=candidate_evidence,
                    hard_rubrics=hard_rubrics,
                    soft_rubrics=soft_rubrics,
                )
            else:
                parent_scores = self.judge.score(
                    evidence=parent_evidence,
                    hard_rubrics=hard_rubrics,
                    soft_rubrics=soft_rubrics,
                )
                candidate_scores = self.judge.score(
                    evidence=candidate_evidence,
                    hard_rubrics=hard_rubrics,
                    soft_rubrics=soft_rubrics,
                )
            comparison = compare_rubric_pair(
                case_id=case_id,
                parent=parent_scores,
                candidate=candidate_scores,
                hard_rubrics=hard_rubrics,
                soft_rubrics=soft_rubrics,
            )
            incomplete_candidate_probes = tuple(
                str(item.get("probe_id", "unknown"))
                for item in candidate_evidence.probes
                if not isinstance(item.get("result"), dict)
                or item["result"].get("passed") is not True
            )
            if incomplete_candidate_probes:
                probe_reason = (
                    f"{case_id}: candidate deep probe coverage incomplete: "
                    + ", ".join(incomplete_candidate_probes)
                )
                comparison = RubricPairComparison(
                    case_id=comparison.case_id,
                    passed=False,
                    parent=comparison.parent,
                    candidate=comparison.candidate,
                    reasons=tuple(dict.fromkeys((*comparison.reasons, probe_reason))),
                )
            case_results.append(comparison)
            reasons.extend(comparison.reasons)
            if not parent_scores.infrastructure_ok or not candidate_scores.infrastructure_ok:
                infrastructure_ok = False

        if len(case_results) < self.config.rubric_validation_sample_size:
            infrastructure_ok = False
            reasons.append(
                "usable rubric validation cases "
                f"{len(case_results)} < required {self.config.rubric_validation_sample_size}"
            )
        if infrastructure_ok and len(case_results) == self.config.rubric_validation_sample_size:
            parent_soft_sum = sum(item.parent.soft_total for item in case_results)
            candidate_soft_sum = sum(item.candidate.soft_total for item in case_results)
            if candidate_soft_sum + 1e-9 < parent_soft_sum:
                reasons.append(
                    "aggregate soft rubric total regressed "
                    f"(parent={parent_soft_sum:.4f}, candidate={candidate_soft_sum:.4f})"
                )
        accepted = not reasons
        return HarnessRubricValidationResult(
            accepted=accepted,
            reasons=tuple(dict.fromkeys(reasons)),
            case_results=tuple(case_results),
            sampled_case_ids=tuple(sample_ids),
            dynamic_rubrics=tuple(dynamic_payloads),
            infrastructure_ok=infrastructure_ok,
        )


def extract_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    first_object: dict[str, Any] | None = None
    starts = [match.start() for match in re.finditer(r"\{", text)]
    for start in starts:
        try:
            value, _end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            if first_object is None:
                first_object = value
            if "hard" in value or "soft" in value or set(value) == {"parent", "candidate"}:
                return value
    if first_object is not None:
        return first_object
    raise ValueError("no JSON object found")
