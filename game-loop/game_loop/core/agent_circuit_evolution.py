from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from game_loop.core.agent_circuit import (
    AgentCircuit,
    AgentRole,
    CircuitEdge,
    CircuitPolicy,
)
from game_loop.utils import sha256_json


_OPERATIONS = {
    "add_role",
    "delete_role",
    "modify_role",
    "split_role",
    "merge_roles",
    "add_edge",
    "delete_edge",
    "modify_edge",
    "modify_policy",
    "modify_boundaries",
}


@dataclass(frozen=True)
class CircuitMutationAction:
    action_id: str
    operation: str
    rationale: str
    payload: dict[str, Any]
    depends_on: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.action_id.strip() or not self.rationale.strip():
            raise ValueError("circuit mutation action id and rationale are required")
        if self.operation not in _OPERATIONS:
            raise ValueError(f"unsupported circuit mutation operation: {self.operation}")
        if not self.payload:
            raise ValueError("circuit mutation action payload is required")
        if self.action_id in self.depends_on:
            raise ValueError("circuit mutation action cannot depend on itself")
        object.__setattr__(
            self,
            "depends_on",
            tuple(dict.fromkeys(str(item) for item in self.depends_on)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "action_id": self.action_id,
            "operation": self.operation,
            "rationale": self.rationale,
            "payload": dict(self.payload),
            "depends_on": list(self.depends_on),
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> CircuitMutationAction:
        return cls(
            action_id=str(value["action_id"]),
            operation=str(value["operation"]),
            rationale=str(value["rationale"]),
            payload=dict(value.get("payload", {})),
            depends_on=tuple(str(item) for item in value.get("depends_on", [])),
        )


@dataclass(frozen=True)
class CircuitMutationTransaction:
    parent_circuit_id: str
    hypothesis: str
    evidence_refs: tuple[str, ...]
    actions: tuple[CircuitMutationAction, ...]
    transformation_ids: tuple[str, ...] = ()
    max_actions: int = 4

    def __post_init__(self) -> None:
        if not self.parent_circuit_id.strip() or not self.hypothesis.strip():
            raise ValueError("circuit transaction parent and hypothesis are required")
        if not self.evidence_refs or any(not item.strip() for item in self.evidence_refs):
            raise ValueError("circuit transaction requires concrete evidence refs")
        if not self.actions:
            raise ValueError("circuit transaction requires at least one action")
        if len(self.actions) > self.max_actions:
            raise ValueError(
                f"circuit transaction actions {len(self.actions)} exceed limit {self.max_actions}"
            )
        action_ids = [item.action_id for item in self.actions]
        if len(action_ids) != len(set(action_ids)):
            raise ValueError("circuit transaction action ids must be unique")
        known_action_ids = set(action_ids)
        for action in self.actions:
            unknown_dependencies = set(action.depends_on) - known_action_ids
            if unknown_dependencies:
                raise ValueError(
                    f"circuit action {action.action_id} has unknown dependencies: "
                    f"{sorted(unknown_dependencies)}"
                )
        if any(not item.strip() for item in self.transformation_ids):
            raise ValueError("circuit transformation ids cannot be empty")
        object.__setattr__(
            self,
            "transformation_ids",
            tuple(dict.fromkeys(self.transformation_ids)),
        )

    @property
    def transaction_id(self) -> str:
        return "circuit-tx-" + sha256_json(self.executable_dict())[:24]

    def executable_dict(self) -> dict[str, Any]:
        return {
            "parent_circuit_id": self.parent_circuit_id,
            "hypothesis": self.hypothesis,
            "evidence_refs": list(self.evidence_refs),
            "actions": [item.to_dict() for item in self.actions],
            "transformation_ids": list(self.transformation_ids),
            "max_actions": self.max_actions,
        }

    def to_dict(self) -> dict[str, Any]:
        return {"transaction_id": self.transaction_id, **self.executable_dict()}

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> CircuitMutationTransaction:
        result = cls(
            parent_circuit_id=str(value["parent_circuit_id"]),
            hypothesis=str(value["hypothesis"]),
            evidence_refs=tuple(str(item) for item in value.get("evidence_refs", [])),
            actions=tuple(
                CircuitMutationAction.from_dict(item)
                for item in value.get("actions", [])
            ),
            transformation_ids=tuple(
                str(item) for item in value.get("transformation_ids", [])
            ),
            max_actions=int(value.get("max_actions", 4)),
        )
        supplied = str(value.get("transaction_id", ""))
        if supplied and supplied != result.transaction_id:
            raise ValueError("circuit transaction content hash mismatch")
        return result

    def without(self, action_id: str) -> CircuitMutationTransaction:
        remaining = tuple(item for item in self.actions if item.action_id != action_id)
        if len(remaining) == len(self.actions):
            raise ValueError(f"unknown circuit transaction action: {action_id}")
        if not remaining:
            raise ValueError("cannot ablate the only circuit transaction action")
        return CircuitMutationTransaction(
            parent_circuit_id=self.parent_circuit_id,
            hypothesis=f"leave-one-out {action_id}: {self.hypothesis}",
            evidence_refs=self.evidence_refs,
            actions=remaining,
            transformation_ids=self.transformation_ids,
            max_actions=self.max_actions,
        )


class CircuitMutationEngine:
    """Apply topology transactions atomically; invalid drafts never escape."""

    def apply(
        self,
        parent: AgentCircuit,
        transaction: CircuitMutationTransaction,
    ) -> AgentCircuit:
        if transaction.parent_circuit_id != parent.circuit_id:
            raise ValueError("circuit transaction parent does not match current circuit")
        roles = {item.role_id: item.to_dict() for item in parent.roles}
        edges = {item.edge_id: item.to_dict() for item in parent.edges}
        policy = parent.policy.to_dict()
        entry = list(parent.entry_role_ids)
        terminal = list(parent.terminal_role_ids)
        for action in transaction.actions:
            self._apply_action(
                action,
                roles=roles,
                edges=edges,
                policy=policy,
                entry=entry,
                terminal=terminal,
            )
        candidate = AgentCircuit(
            roles=tuple(AgentRole.from_dict(item) for item in roles.values()),
            edges=tuple(CircuitEdge.from_dict(item) for item in edges.values()),
            entry_role_ids=tuple(entry),
            terminal_role_ids=tuple(terminal),
            policy=CircuitPolicy.from_dict(policy),
        )
        if candidate.circuit_id == parent.circuit_id:
            raise ValueError("circuit mutation transaction is a no-op")
        return candidate

    def _apply_action(
        self,
        action: CircuitMutationAction,
        *,
        roles: dict[str, dict[str, Any]],
        edges: dict[str, dict[str, Any]],
        policy: dict[str, Any],
        entry: list[str],
        terminal: list[str],
    ) -> None:
        payload = action.payload
        operation = action.operation
        if operation == "add_role":
            role = AgentRole.from_dict(dict(payload["role"]))
            if role.role_id in roles:
                raise ValueError(f"cannot add existing circuit role: {role.role_id}")
            roles[role.role_id] = role.to_dict()
            for edge_payload in payload.get("incident_edges", []):
                self._add_edge(edges, CircuitEdge.from_dict(edge_payload))
            if payload.get("entry") is True:
                entry.append(role.role_id)
            if payload.get("terminal") is True:
                terminal.append(role.role_id)
            return
        if operation == "delete_role":
            role_id = str(payload["role_id"])
            self._require_role(roles, role_id)
            roles.pop(role_id)
            edges_to_remove = [
                edge_id
                for edge_id, edge in edges.items()
                if edge["source"] == role_id or edge["target"] == role_id
            ]
            for edge_id in edges_to_remove:
                edges.pop(edge_id)
            entry[:] = [item for item in entry if item != role_id]
            terminal[:] = [item for item in terminal if item != role_id]
            return
        if operation == "modify_role":
            role_id = str(payload["role_id"])
            self._require_role(roles, role_id)
            replacement = AgentRole.from_dict(dict(payload["replacement"]))
            if replacement.role_id != role_id:
                raise ValueError("modify_role must preserve role_id")
            roles[role_id] = replacement.to_dict()
            return
        if operation == "split_role":
            source_id = str(payload["source_role_id"])
            self._require_role(roles, source_id)
            replacements = [
                AgentRole.from_dict(item) for item in payload.get("replacement_roles", [])
            ]
            if len(replacements) < 2:
                raise ValueError("split_role requires at least two replacement roles")
            was_entry, was_terminal = source_id in entry, source_id in terminal
            self._remove_roles({source_id}, roles, edges, entry, terminal)
            for replacement in replacements:
                if replacement.role_id in roles:
                    raise ValueError(f"split role collides with {replacement.role_id}")
                roles[replacement.role_id] = replacement.to_dict()
            self._replace_edges(edges, payload.get("replacement_edges", []))
            entry.extend(str(item) for item in payload.get("entry_role_ids", []))
            terminal.extend(str(item) for item in payload.get("terminal_role_ids", []))
            if was_entry and not payload.get("entry_role_ids"):
                raise ValueError("split of an entry role must declare replacement entry roles")
            if was_terminal and not payload.get("terminal_role_ids"):
                raise ValueError("split of a terminal role must declare replacement terminal roles")
            return
        if operation == "merge_roles":
            source_ids = {str(item) for item in payload.get("source_role_ids", [])}
            if len(source_ids) < 2:
                raise ValueError("merge_roles requires at least two source roles")
            for source_id in source_ids:
                self._require_role(roles, source_id)
            replacement = AgentRole.from_dict(dict(payload["merged_role"]))
            if replacement.role_id in roles and replacement.role_id not in source_ids:
                raise ValueError(f"merged role collides with {replacement.role_id}")
            had_entry = bool(source_ids & set(entry))
            had_terminal = bool(source_ids & set(terminal))
            self._remove_roles(source_ids, roles, edges, entry, terminal)
            roles[replacement.role_id] = replacement.to_dict()
            self._replace_edges(edges, payload.get("replacement_edges", []))
            if had_entry:
                entry.append(replacement.role_id)
            if had_terminal:
                terminal.append(replacement.role_id)
            return
        if operation == "add_edge":
            self._add_edge(edges, CircuitEdge.from_dict(dict(payload["edge"])))
            return
        if operation == "delete_edge":
            edge_id = str(payload["edge_id"])
            if edge_id not in edges:
                raise ValueError(f"cannot delete unknown circuit edge: {edge_id}")
            edges.pop(edge_id)
            return
        if operation == "modify_edge":
            edge_id = str(payload["edge_id"])
            if edge_id not in edges:
                raise ValueError(f"cannot modify unknown circuit edge: {edge_id}")
            replacement = CircuitEdge.from_dict(dict(payload["replacement"]))
            if replacement.edge_id != edge_id:
                raise ValueError("modify_edge must preserve edge_id")
            edges[edge_id] = replacement.to_dict()
            return
        if operation == "modify_policy":
            policy.clear()
            policy.update(CircuitPolicy.from_dict(payload["replacement"]).to_dict())
            return
        if operation == "modify_boundaries":
            entry[:] = [str(item) for item in payload.get("entry_role_ids", [])]
            terminal[:] = [str(item) for item in payload.get("terminal_role_ids", [])]
            if not entry or not terminal:
                raise ValueError("circuit boundaries must retain entry and terminal roles")
            return
        raise AssertionError(f"unhandled circuit mutation operation: {operation}")

    @staticmethod
    def _require_role(roles: Mapping[str, Any], role_id: str) -> None:
        if role_id not in roles:
            raise ValueError(f"unknown circuit role: {role_id}")

    @staticmethod
    def _add_edge(edges: dict[str, dict[str, Any]], edge: CircuitEdge) -> None:
        if edge.edge_id in edges:
            raise ValueError(f"cannot add existing circuit edge: {edge.edge_id}")
        edges[edge.edge_id] = edge.to_dict()

    def _replace_edges(
        self,
        edges: dict[str, dict[str, Any]],
        replacements: Sequence[Mapping[str, Any]],
    ) -> None:
        for raw in replacements:
            self._add_edge(edges, CircuitEdge.from_dict(raw))

    @staticmethod
    def _remove_roles(
        role_ids: set[str],
        roles: dict[str, dict[str, Any]],
        edges: dict[str, dict[str, Any]],
        entry: list[str],
        terminal: list[str],
    ) -> None:
        for role_id in role_ids:
            roles.pop(role_id)
        for edge_id in [
            edge_id
            for edge_id, edge in edges.items()
            if edge["source"] in role_ids or edge["target"] in role_ids
        ]:
            edges.pop(edge_id)
        entry[:] = [item for item in entry if item not in role_ids]
        terminal[:] = [item for item in terminal if item not in role_ids]


@dataclass(frozen=True)
class CircuitCostEstimate:
    role_count: int
    edge_count: int
    max_parallel_roles: int
    max_model_calls: int
    max_tokens: int | None
    cost_units: float
    coordination_load: float
    feedback_exposure: int
    latency_upper_bound_seconds: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "role_count": self.role_count,
            "edge_count": self.edge_count,
            "max_parallel_roles": self.max_parallel_roles,
            "max_model_calls": self.max_model_calls,
            "max_tokens": self.max_tokens,
            "cost_units": self.cost_units,
            "coordination_load": self.coordination_load,
            "feedback_exposure": self.feedback_exposure,
            "latency_upper_bound_seconds": self.latency_upper_bound_seconds,
        }


@dataclass(frozen=True)
class CircuitUtilityDecision:
    accepted: bool
    quality_delta: float
    cost_penalty: float
    net_utility: float
    reasons: tuple[str, ...]


class CircuitCostModel:
    def __init__(
        self,
        *,
        cost_unit_weight: float = 0.02,
        coordination_weight: float = 0.01,
        latency_weight: float = 0.00001,
        minimum_net_utility: float = 0.0,
    ):
        self.cost_unit_weight = cost_unit_weight
        self.coordination_weight = coordination_weight
        self.latency_weight = latency_weight
        self.minimum_net_utility = minimum_net_utility

    def estimate(self, circuit: AgentCircuit) -> CircuitCostEstimate:
        token_budgets = [role.budget.max_tokens for role in circuit.roles]
        max_tokens = (
            None if any(item is None for item in token_budgets) else sum(token_budgets)  # type: ignore[arg-type]
        )
        fanout = sum(
            max(0, sum(edge.source == role.role_id for edge in circuit.edges) - 1)
            for role in circuit.roles
        )
        feedback = sum(
            edge.max_traversals for edge in circuit.edges if edge.is_feedback
        )
        coordination = len(circuit.edges) + 0.5 * fanout + 1.5 * feedback
        latency = self._critical_path_timeout(circuit) * (1 + feedback)
        return CircuitCostEstimate(
            role_count=len(circuit.roles),
            edge_count=len(circuit.edges),
            max_parallel_roles=circuit.policy.max_parallel_roles,
            max_model_calls=circuit.policy.max_total_model_calls,
            max_tokens=max_tokens,
            cost_units=circuit.policy.max_total_cost_units,
            coordination_load=coordination,
            feedback_exposure=feedback,
            latency_upper_bound_seconds=min(
                latency, circuit.policy.wall_timeout_seconds
            ),
        )

    def decide(
        self,
        *,
        parent: AgentCircuit,
        candidate: AgentCircuit,
        quality_delta: float,
    ) -> CircuitUtilityDecision:
        before = self.estimate(parent)
        after = self.estimate(candidate)
        # Signed marginal cost rewards a simpler circuit during ablation just
        # as strongly as it penalizes an unnecessary expansion.
        cost_penalty = (
            (after.cost_units - before.cost_units) * self.cost_unit_weight
            + (after.coordination_load - before.coordination_load)
            * self.coordination_weight
            + (
                after.latency_upper_bound_seconds
                - before.latency_upper_bound_seconds
            )
            * self.latency_weight
        )
        net = quality_delta - cost_penalty
        reasons = []
        if quality_delta <= 0 and cost_penalty >= 0:
            reasons.append("candidate improved neither measured quality nor circuit cost")
        if net < self.minimum_net_utility:
            reasons.append(
                f"net utility {net:.4f} is below {self.minimum_net_utility:.4f}"
            )
        return CircuitUtilityDecision(
            accepted=not reasons,
            quality_delta=quality_delta,
            cost_penalty=cost_penalty,
            net_utility=net,
            reasons=tuple(reasons),
        )

    @staticmethod
    def _critical_path_timeout(circuit: AgentCircuit) -> int:
        incoming: dict[str, list[str]] = {role.role_id: [] for role in circuit.roles}
        for edge in circuit.edges:
            if not edge.is_feedback:
                incoming[edge.target].append(edge.source)
        role_map = {role.role_id: role for role in circuit.roles}
        remaining = set(role_map)
        totals: dict[str, int] = {}
        while remaining:
            ready = sorted(
                role_id
                for role_id in remaining
                if all(source in totals for source in incoming[role_id])
            )
            if not ready:
                raise ValueError("cannot estimate cyclic circuit")
            for role_id in ready:
                totals[role_id] = role_map[role_id].budget.timeout_seconds + max(
                    (totals[source] for source in incoming[role_id]),
                    default=0,
                )
                remaining.remove(role_id)
        return max(totals.values())
