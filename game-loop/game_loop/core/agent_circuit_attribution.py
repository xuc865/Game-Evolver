from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from game_loop.core.agent_circuit_evolution import (
    CircuitMutationAction,
    CircuitMutationTransaction,
)
from game_loop.utils import atomic_write_json, read_json, utc_now


@dataclass(frozen=True)
class CircuitAblationTrial:
    bundle_id: str
    action_id: str
    source_parent_harness_id: str
    reference_harness_id: str
    retained_action_ids: tuple[str, ...]
    candidate_transaction: CircuitMutationTransaction | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "bundle_id": self.bundle_id,
            "action_id": self.action_id,
            "source_parent_harness_id": self.source_parent_harness_id,
            "reference_harness_id": self.reference_harness_id,
            "retained_action_ids": list(self.retained_action_ids),
            "candidate_transaction": (
                None
                if self.candidate_transaction is None
                else self.candidate_transaction.to_dict()
            ),
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "CircuitAblationTrial":
        raw_transaction = value.get("candidate_transaction")
        return cls(
            bundle_id=str(value["bundle_id"]),
            action_id=str(value["action_id"]),
            source_parent_harness_id=str(value["source_parent_harness_id"]),
            reference_harness_id=str(value["reference_harness_id"]),
            retained_action_ids=tuple(
                str(item) for item in value.get("retained_action_ids", [])
            ),
            candidate_transaction=(
                None
                if raw_transaction is None
                else CircuitMutationTransaction.from_dict(dict(raw_transaction))
            ),
        )


class CircuitAblationQueue:
    """Persistent conditional leave-one-out attribution for circuit bundles."""

    schema_version = "agent-circuit-ablation.v1"

    def __init__(self, path: Path):
        self.path = path

    def initialize(self) -> None:
        if self.path.is_file():
            self._validate_state(read_json(self.path))
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(
            self.path,
            {
                "schema_version": self.schema_version,
                "pending": [],
                "completed": [],
                "updated_at": utc_now(),
            },
        )

    def pending_count(self) -> int:
        return sum(
            len(item.get("pending_action_ids", []))
            for item in self._state().get("pending", [])
        )

    def schedule(
        self,
        *,
        epoch: int,
        source_parent_harness_id: str,
        accepted_harness_id: str,
        transaction: CircuitMutationTransaction,
    ) -> None:
        if len(transaction.actions) < 2:
            return
        state = self._state()
        pending = list(state.get("pending", []))
        bundle_id = transaction.transaction_id
        if any(str(item.get("bundle_id")) == bundle_id for item in pending):
            return
        completed = list(state.get("completed", []))
        if any(str(item.get("bundle_id")) == bundle_id for item in completed):
            return
        action_ids = [action.action_id for action in transaction.actions]
        pending.append(
            {
                "bundle_id": bundle_id,
                "source_parent_harness_id": source_parent_harness_id,
                "current_harness_id": accepted_harness_id,
                "transaction": transaction.to_dict(),
                "retained_action_ids": action_ids,
                "pending_action_ids": action_ids,
                "decisions": [],
                "scheduled_by_epoch": epoch,
                "created_at": utc_now(),
            }
        )
        state["pending"] = pending
        self._write(state)

    def next_trial(self, *, champion_harness_id: str) -> CircuitAblationTrial | None:
        state = self._state()
        pending = list(state.get("pending", []))
        if not pending:
            return None
        item = dict(pending[0])
        expected = str(item["current_harness_id"])
        if champion_harness_id != expected:
            raise RuntimeError(
                "circuit ablation champion drift: "
                f"expected {expected}, found {champion_harness_id}"
            )
        action_id = str(item["pending_action_ids"][0])
        transaction = CircuitMutationTransaction.from_dict(item["transaction"])
        retained = tuple(str(value) for value in item["retained_action_ids"])
        retained_after = self._retained_without(
            transaction=transaction,
            retained_action_ids=retained,
            removed_action_id=action_id,
        )
        candidate_transaction = self._transaction_subset(
            transaction,
            retained_after,
            ablated_action_id=action_id,
        )
        return CircuitAblationTrial(
            bundle_id=str(item["bundle_id"]),
            action_id=action_id,
            source_parent_harness_id=str(item["source_parent_harness_id"]),
            reference_harness_id=expected,
            retained_action_ids=retained_after,
            candidate_transaction=candidate_transaction,
        )

    def record_trial(
        self,
        *,
        epoch: int,
        trial: CircuitAblationTrial,
        infrastructure_ok: bool,
        accepted: bool,
        candidate_harness_id: str,
        quality_delta: float | None,
        cost_penalty: float | None,
        net_utility: float | None,
        reasons: tuple[str, ...],
    ) -> None:
        state = self._state()
        pending = list(state.get("pending", []))
        if not pending or str(pending[0].get("bundle_id")) != trial.bundle_id:
            raise RuntimeError("circuit ablation trial no longer matches queue head")
        item = dict(pending[0])
        if str(item["pending_action_ids"][0]) != trial.action_id:
            raise RuntimeError("circuit ablation action no longer matches queue head")
        attempts = list(item.get("attempts", []))
        attempts.append(
            {
                "epoch": epoch,
                "action_id": trial.action_id,
                "infrastructure_ok": infrastructure_ok,
                "accepted": accepted if infrastructure_ok else False,
                "candidate_harness_id": candidate_harness_id,
                "quality_delta": quality_delta,
                "cost_penalty": cost_penalty,
                "net_utility": net_utility,
                "reasons": list(reasons),
                "created_at": utc_now(),
            }
        )
        item["attempts"] = attempts
        if not infrastructure_ok:
            pending[0] = item
            state["pending"] = pending
            self._write(state)
            return
        remaining = list(item["pending_action_ids"])
        remaining.pop(0)
        decisions = list(item.get("decisions", []))
        decisions.append(
            {
                "epoch": epoch,
                "action_id": trial.action_id,
                "removed": accepted,
                "candidate_harness_id": candidate_harness_id,
                "quality_delta": quality_delta,
                "cost_penalty": cost_penalty,
                "net_utility": net_utility,
                "reasons": list(reasons),
            }
        )
        item["decisions"] = decisions
        if accepted:
            prior_retained = set(str(value) for value in item["retained_action_ids"])
            next_retained = set(trial.retained_action_ids)
            dependency_removed = prior_retained - next_retained - {trial.action_id}
            remaining = [
                action_id
                for action_id in remaining
                if action_id not in dependency_removed
            ]
            for action_id in sorted(dependency_removed):
                decisions.append(
                    {
                        "epoch": epoch,
                        "action_id": action_id,
                        "removed": True,
                        "removed_by_dependency": trial.action_id,
                        "candidate_harness_id": candidate_harness_id,
                        "quality_delta": quality_delta,
                        "cost_penalty": cost_penalty,
                        "net_utility": net_utility,
                        "reasons": [
                            f"dependency closure of ablated action {trial.action_id}"
                        ],
                    }
                )
            item["retained_action_ids"] = list(trial.retained_action_ids)
            item["current_harness_id"] = candidate_harness_id
        item["decisions"] = decisions
        item["pending_action_ids"] = remaining
        if remaining:
            pending[0] = item
            state["pending"] = pending
        else:
            pending.pop(0)
            item["completed_at"] = utc_now()
            completed = list(state.get("completed", []))
            completed.append(item)
            state["pending"] = pending
            state["completed"] = completed
        self._write(state)

    @staticmethod
    def _retained_without(
        *,
        transaction: CircuitMutationTransaction,
        retained_action_ids: tuple[str, ...],
        removed_action_id: str,
    ) -> tuple[str, ...]:
        retained = set(retained_action_ids)
        if removed_action_id not in retained:
            raise ValueError(f"circuit action is not retained: {removed_action_id}")
        removed = {removed_action_id}
        changed = True
        while changed:
            changed = False
            for action in transaction.actions:
                if action.action_id not in retained or action.action_id in removed:
                    continue
                if removed.intersection(action.depends_on):
                    removed.add(action.action_id)
                    changed = True
        return tuple(
            action.action_id
            for action in transaction.actions
            if action.action_id in retained and action.action_id not in removed
        )

    @staticmethod
    def _transaction_subset(
        transaction: CircuitMutationTransaction,
        retained_action_ids: tuple[str, ...],
        *,
        ablated_action_id: str,
    ) -> CircuitMutationTransaction | None:
        if not retained_action_ids:
            return None
        retained = set(retained_action_ids)
        actions = tuple(
            CircuitMutationAction(
                action_id=action.action_id,
                operation=action.operation,
                rationale=action.rationale,
                payload=action.payload,
                depends_on=tuple(
                    dependency
                    for dependency in action.depends_on
                    if dependency in retained
                ),
            )
            for action in transaction.actions
            if action.action_id in retained
        )
        return CircuitMutationTransaction(
            parent_circuit_id=transaction.parent_circuit_id,
            hypothesis=(
                f"conditional leave-one-out of {ablated_action_id}: "
                f"{transaction.hypothesis}"
            ),
            evidence_refs=transaction.evidence_refs,
            actions=actions,
            transformation_ids=transaction.transformation_ids,
            max_actions=transaction.max_actions,
        )

    def _state(self) -> dict[str, Any]:
        self.initialize()
        state = read_json(self.path)
        self._validate_state(state)
        return state

    def _write(self, state: Mapping[str, Any]) -> None:
        value = dict(state)
        value["schema_version"] = self.schema_version
        value["updated_at"] = utc_now()
        self._validate_state(value)
        atomic_write_json(self.path, value)

    def _validate_state(self, state: Mapping[str, Any]) -> None:
        if state.get("schema_version") != self.schema_version:
            raise ValueError("unsupported circuit ablation queue schema")
        if not isinstance(state.get("pending", []), list):
            raise ValueError("circuit ablation pending queue must be a list")
        if not isinstance(state.get("completed", []), list):
            raise ValueError("circuit ablation completed queue must be a list")
