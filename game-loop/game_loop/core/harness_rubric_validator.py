from __future__ import annotations

import json
import random
import re
import subprocess
import sys
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
) -> tuple[HarnessReplayCase, ...]:
    if sample_size < 1:
        raise ValueError("sample_size must be >= 1")
    rng = random.Random(seed)
    if len(pool) >= sample_size:
        picked = rng.sample(list(pool), sample_size)
    else:
        picked = [rng.choice(list(pool)) for _ in range(sample_size)]
    return tuple(
        entry.to_replay_case(f"{prefix}-{index + 1:02d}")
        for index, entry in enumerate(picked)
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


def _run_probe(command: list[str], *, timeout: int = 120) -> dict[str, Any]:
    proc = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
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
            instruction_excerpt=_instruction_excerpt(task_source),
        )

    python = sys.executable
    probes: list[dict[str, Any]] = []
    kind = _artifact_kind(artifact)
    if kind == "godot":
        probes.append(
            _run_probe(
                [python, "-m", "game_loop.probe_tools", "godot-playtest", "--artifact", str(artifact), "--frames", "60"],
                timeout=90,
            )
        )
        probes.append(
            _run_probe(
                [python, "-m", "game_loop.probe_tools", "godot-quality-inventory", "--artifact", str(artifact)],
            )
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

    inventory = tuple(
        sorted(
            path.relative_to(artifact).as_posix()
            for path in artifact.rglob("*")
            if path.is_file()
        )[:80]
    )
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
        hard: dict[str, float] = {}
        for rubric in hard_rubrics:
            if rubric.rubric_id == "launches_without_crash":
                hard[rubric.rubric_id] = 1.0 if passed_all else 0.0
            elif rubric.rubric_id == "respects_task_constraints":
                hard[rubric.rubric_id] = 1.0 if inventory_ok else 0.0
            elif rubric.rubric_id == "produces_runnable_artifact":
                hard[rubric.rubric_id] = 1.0 if evidence.artifact_path and passed_all else 0.0
            elif rubric.rubric_id == "no_hidden_test_leakage":
                leaked = any(
                    "rubric.json" in path or "/tests/" in path
                    for path in evidence.file_inventory
                )
                hard[rubric.rubric_id] = 0.0 if leaked else 1.0
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


class LLMRubricJudge:
    """LLM judge that scores hard/soft rubrics from deep in-game evidence."""

    judge_id = "llm_deep_playtest_v1"

    def __init__(self, *, provider_id: str, timeout_seconds: int = 120):
        self.provider_id = provider_id
        self.timeout_seconds = timeout_seconds

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
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.0,
            "max_tokens": 1800,
            "response_format": {"type": "json_object"},
        }
        if "qwen" in resolved.model.casefold() or "glm" in resolved.model.casefold():
            payload["chat_template_kwargs"] = {"enable_thinking": False}
        errors: list[str] = []
        parsed: dict[str, Any] | None = None
        attempts = 3
        for attempt in range(attempts):
            request = urllib.request.Request(
                resolved.base_url + "/chat/completions",
                data=json.dumps(payload).encode("utf-8"),
                method="POST",
                headers={
                    "Authorization": f"Bearer {resolved.api_key or 'EMPTY'}",
                    "Content-Type": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                    value = json.loads(response.read().decode("utf-8"))
                message = value["choices"][0]["message"]
                content = message.get("content") or message.get("reasoning_content") or ""
                parsed = extract_json_object(content)
                _validate_rubric_payload(parsed)
                break
            except urllib.error.HTTPError as exc:
                body = ""
                try:
                    body = exc.read().decode("utf-8", errors="replace")
                except Exception:
                    pass
                errors.append(f"HTTPError {exc.code}: {body[:200]}")
                if exc.code in (400, 422):
                    payload.pop("response_format", None)
            except (
                urllib.error.URLError,
                TimeoutError,
                KeyError,
                json.JSONDecodeError,
                ValueError,
                IndexError,
            ) as exc:
                errors.append(f"{type(exc).__name__}: {exc}")
                payload.pop("response_format", None)
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
                infrastructure_ok=True,
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
            "Return exactly one JSON object shaped like:\n"
            f"{json.dumps({'hard': hard_template, 'soft': soft_template}, ensure_ascii=False)}\n\n"
            f"Task excerpt:\n{evidence.instruction_excerpt[:900]}\n\n"
            f"Benchmark: {evidence.benchmark_id}\n"
            f"Artifact: {evidence.artifact_path}\n"
            f"Deep probes:\n{json.dumps(list(evidence.probes), ensure_ascii=False)[:2500]}\n\n"
            f"File inventory sample:\n{list(evidence.file_inventory)[:25]}\n\n"
            f"Hard rubrics (0/1):\n{hard_lines}\n\n"
            f"Soft rubrics (0..1):\n{soft_lines}\n"
        )


def _coerce_hard(value: Any) -> float:
    if value is None:
        return 0.0
    number = float(value)
    return 1.0 if number >= 0.5 else 0.0


def _coerce_soft(value: Any) -> float:
    if value is None:
        return 0.0
    number = float(value)
    return max(0.0, min(1.0, number))


def _validate_rubric_payload(parsed: dict[str, Any]) -> None:
    if not isinstance(parsed.get("hard"), dict):
        raise ValueError("rubric JSON key 'hard' must be an object")
    if not isinstance(parsed.get("soft"), dict):
        raise ValueError("rubric JSON key 'soft' must be an object")


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
    for rubric in hard_rubrics:
        old = parent.hard.get(rubric.rubric_id, 0.0)
        new = candidate.hard.get(rubric.rubric_id, 0.0)
        if new < old:
            reasons.append(
                f"{case_id}: hard rubric {rubric.rubric_id} regressed "
                f"(parent={old:.0f}, candidate={new:.0f})"
            )
    if candidate.soft_total + 1e-9 < parent.soft_total:
        reasons.append(
            f"{case_id}: soft rubric total regressed "
            f"(parent={parent.soft_total:.4f}, candidate={candidate.soft_total:.4f})"
        )
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
        profile = candidate_profile or parent_profile
        for case_id in sample_ids:
            parent_outcome = parents[case_id]
            candidate_outcome = candidates[case_id]
            if not parent_outcome.run_ref or not candidate_outcome.run_ref:
                reasons.append(f"{case_id}: missing run_ref for deep rubric validation")
                continue
            if not parent_outcome.infrastructure_ok or not candidate_outcome.infrastructure_ok:
                reasons.append(f"{case_id}: infrastructure failure excludes rubric evidence")
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
            case_results.append(comparison)
            reasons.extend(comparison.reasons)
            if not parent_scores.infrastructure_ok or not candidate_scores.infrastructure_ok:
                infrastructure_ok = False

        if len(case_results) < self.config.rubric_validation_sample_size:
            reasons.append(
                "usable rubric validation cases "
                f"{len(case_results)} < required {self.config.rubric_validation_sample_size}"
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
            if "hard" in value or "soft" in value:
                return value
    if first_object is not None:
        return first_object
    raise ValueError("no JSON object found")
