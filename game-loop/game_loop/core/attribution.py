from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol, Sequence

from game_loop.utils import read_json

from .harness import HarnessSemanticGradient


@dataclass(frozen=True)
class AttributionReport:
    run_refs: tuple[str, ...]
    outcome_counts: dict[str, int]
    repeated_failures: tuple[dict[str, Any], ...]
    infrastructure_events: int

    def __post_init__(self) -> None:
        if isinstance(self.run_refs, str):
            object.__setattr__(self, "run_refs", (self.run_refs,))

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["run_refs"] = list(self.run_refs)
        value["repeated_failures"] = list(self.repeated_failures)
        return value


class SemanticGradientProposer(Protocol):
    def propose(self, report: AttributionReport) -> HarnessSemanticGradient: ...


class TrajectoryAttributor:
    """Builds benchmark-neutral failure evidence from completed episode records."""

    def collect(self, run_dirs: Sequence[Path]) -> AttributionReport:
        counts: dict[str, int] = {}
        failures: dict[tuple[str, str], dict[str, Any]] = {}
        infrastructure_events = 0
        refs: list[str] = []
        for run_dir in run_dirs:
            state = read_json(run_dir / "state.json")
            refs.append(str(run_dir.resolve()))
            for raw in state.get("attempts", []):
                status = str(raw.get("status", "unknown"))
                counts[status] = counts.get(status, 0) + 1
                if status == "infra_failed":
                    infrastructure_events += 1
                    continue
                reasons = [str(item) for item in raw.get("reasons", [])]
                if not reasons and status == "accepted":
                    continue
                reason = reasons[0] if reasons else status
                key = (status, reason)
                entry = failures.setdefault(key, {
                    "status": status,
                    "reason": reason,
                    "count": 0,
                    "evidence_refs": [],
                })
                entry["count"] += 1
                entry["evidence_refs"].append(
                    f"{run_dir.resolve()}#{raw.get('attempt_id', 'unknown')}"
                )
        repeated = sorted(
            failures.values(),
            key=lambda item: (-int(item["count"]), item["status"], item["reason"]),
        )
        return AttributionReport(
            run_refs=tuple(refs),
            outcome_counts=counts,
            repeated_failures=tuple(repeated),
            infrastructure_events=infrastructure_events,
        )


class RuleBasedSemanticGradientProposer:
    """Deterministic fallback; a model proposer can replace this interface."""

    def propose(self, report: AttributionReport) -> HarnessSemanticGradient:
        if report.outcome_counts.get("gate_failed", 0):
            tags = ("gate_repair",)
            diagnosis = "Repeated candidates fail deterministic artifact gates."
        elif report.outcome_counts.get("probe_failed", 0):
            tags = ("probe_repair",)
            diagnosis = "Repeated candidates regress observable behavior before selection."
        elif report.repeated_failures:
            tags = ("context_history", "failure_memory")
            diagnosis = (
                "Repeated quality failures are not being avoided: "
                + str(report.repeated_failures[0]["reason"])
            )
        elif report.infrastructure_events:
            tags = ("infra_recovery",)
            diagnosis = "Episodes repeatedly terminate on infrastructure failures."
        else:
            tags = ("context",)
            diagnosis = "No repeated failure class dominates; test a bounded context change."
        evidence = tuple(
            ref
            for item in report.repeated_failures[:3]
            for ref in item.get("evidence_refs", [])[:2]
        ) or report.run_refs[:3]
        return HarnessSemanticGradient(diagnosis, tags, evidence)


class CommandSemanticGradientProposer:
    """External/meta-model proposer with a stable JSON stdin/stdout contract."""

    def __init__(
        self,
        command: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: int = 600,
    ):
        if not command:
            raise ValueError("semantic-gradient proposer command cannot be empty")
        self.command = tuple(command)
        self.cwd = cwd.resolve()
        self.timeout_seconds = timeout_seconds

    def propose(self, report: AttributionReport) -> HarnessSemanticGradient:
        completed = subprocess.run(
            self.command,
            cwd=self.cwd,
            input=json.dumps(report.to_dict(), ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=self.timeout_seconds,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                "semantic-gradient proposer failed: " + completed.stderr[-2000:]
            )
        value = json.loads(completed.stdout)
        return HarnessSemanticGradient(
            diagnosis=str(value["diagnosis"]),
            target_tags=tuple(str(item) for item in value.get("target_tags", [])),
            evidence_refs=tuple(str(item) for item in value.get("evidence_refs", [])),
        )
