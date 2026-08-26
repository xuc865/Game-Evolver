from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Mapping

from game_loop.utils import sha256_json

_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_EDGE_PROTOCOLS = {"forward", "feedback"}
_ARTIFACT_MODES = {"inline", "workspace"}
_WORKSPACE_ACCESS_MODES = {"read_only", "read_write"}
_CONTEXT_MODES = {"task_only", "parent_summary", "selected_artifacts", "shared"}
_FAILURE_MODES = {"fail_fast", "continue_independent"}


def _identifier(value: object, *, field_name: str) -> str:
    result = str(value).strip()
    if not _IDENTIFIER.fullmatch(result):
        raise ValueError(
            f"{field_name} must match {_IDENTIFIER.pattern}: {result!r}"
        )
    return result


@dataclass(frozen=True)
class RoleHarnessSpec:
    """Frozen harness inheritance and role-local activation for one circuit node."""

    source_harness_id: str | None = None
    active_module_ids: tuple[str, ...] = ()
    active_element_ids: tuple[str, ...] = ()
    active_cordis_plugins: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for field_name in (
            "active_module_ids",
            "active_element_ids",
            "active_cordis_plugins",
        ):
            values = tuple(
                sorted(dict.fromkeys(str(item) for item in getattr(self, field_name)))
            )
            if any(not item.strip() for item in values):
                raise ValueError(f"role harness {field_name} cannot contain empty ids")
            object.__setattr__(self, field_name, values)
        if self.source_harness_id is not None and not self.source_harness_id.strip():
            raise ValueError("role harness source_harness_id cannot be empty")

    @property
    def spec_hash(self) -> str:
        return "role-harness-" + sha256_json(self.to_dict())[:24]

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_harness_id": self.source_harness_id,
            "active_module_ids": list(self.active_module_ids),
            "active_element_ids": list(self.active_element_ids),
            "active_cordis_plugins": list(self.active_cordis_plugins),
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any] | None) -> RoleHarnessSpec | None:
        if value is None:
            return None
        return cls(
            source_harness_id=(
                None
                if value.get("source_harness_id") is None
                else str(value["source_harness_id"])
            ),
            active_module_ids=tuple(
                str(item) for item in value.get("active_module_ids", [])
            ),
            active_element_ids=tuple(
                str(item) for item in value.get("active_element_ids", [])
            ),
            active_cordis_plugins=tuple(
                str(item) for item in value.get("active_cordis_plugins", [])
            ),
        )


@dataclass(frozen=True)
class AgentBudget:
    """Hard execution ceiling assigned to one circuit role."""

    max_model_calls: int = 1
    max_tokens: int | None = None
    timeout_seconds: int = 1200
    cost_units: float = 1.0

    def __post_init__(self) -> None:
        object.__setattr__(self, "cost_units", float(self.cost_units))
        if self.max_model_calls < 1:
            raise ValueError("agent budget max_model_calls must be positive")
        if self.max_tokens is not None and self.max_tokens < 1:
            raise ValueError("agent budget max_tokens must be positive when set")
        if self.timeout_seconds < 1:
            raise ValueError("agent budget timeout_seconds must be positive")
        if self.cost_units <= 0:
            raise ValueError("agent budget cost_units must be positive")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any] | None) -> AgentBudget:
        raw = value or {}
        return cls(
            max_model_calls=int(raw.get("max_model_calls", 1)),
            max_tokens=(
                None if raw.get("max_tokens") is None else int(raw["max_tokens"])
            ),
            timeout_seconds=int(raw.get("timeout_seconds", 1200)),
            cost_units=float(raw.get("cost_units", 1.0)),
        )


@dataclass(frozen=True)
class AgentContextPolicy:
    """Controls which upstream state may enter an isolated role context."""

    mode: str = "parent_summary"
    include_artifact_kinds: tuple[str, ...] = ()
    max_input_chars: int = 24_000
    max_output_chars: int = 12_000

    def __post_init__(self) -> None:
        if self.mode not in _CONTEXT_MODES:
            raise ValueError(f"unsupported agent context mode: {self.mode}")
        if self.max_input_chars < 256 or self.max_output_chars < 256:
            raise ValueError("agent context character limits must be at least 256")
        if any(not str(item).strip() for item in self.include_artifact_kinds):
            raise ValueError("agent context artifact kinds must not be empty")

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["include_artifact_kinds"] = list(self.include_artifact_kinds)
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any] | None) -> AgentContextPolicy:
        raw = value or {}
        return cls(
            mode=str(raw.get("mode", "parent_summary")),
            include_artifact_kinds=tuple(
                sorted(
                    dict.fromkeys(
                        str(item) for item in raw.get("include_artifact_kinds", [])
                    )
                )
            ),
            max_input_chars=int(raw.get("max_input_chars", 24_000)),
            max_output_chars=int(raw.get("max_output_chars", 12_000)),
        )


@dataclass(frozen=True)
class AgentRole:
    """One independently prompted and budgeted worker in a GOA circuit."""

    role_id: str
    name: str
    kind: str
    objective: str
    system_prompt: str
    capabilities: tuple[str, ...] = ()
    tool_interface_ids: tuple[str, ...] = ()
    output_artifact_kinds: tuple[str, ...] = ()
    output_artifact_modes: dict[str, str] = field(default_factory=dict)
    workspace_access: str = "read_write"
    harness_spec: RoleHarnessSpec | None = None
    context: AgentContextPolicy = field(default_factory=AgentContextPolicy)
    budget: AgentBudget = field(default_factory=AgentBudget)
    provider: str | None = None
    model: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "role_id", _identifier(self.role_id, field_name="role_id")
        )
        object.__setattr__(
            self, "kind", _identifier(self.kind, field_name="agent role kind")
        )
        if not self.name.strip() or not self.objective.strip() or not self.system_prompt.strip():
            raise ValueError("agent role name, objective, and system_prompt are required")
        if (self.provider is None) != (self.model is None):
            raise ValueError("agent role provider and model must be set together")
        object.__setattr__(
            self,
            "capabilities",
            tuple(sorted(dict.fromkeys(str(item) for item in self.capabilities))),
        )
        object.__setattr__(
            self,
            "tool_interface_ids",
            tuple(sorted(dict.fromkeys(str(item) for item in self.tool_interface_ids))),
        )
        if any(not str(item).strip() for item in self.output_artifact_kinds):
            raise ValueError("agent role output artifact kinds cannot be empty")
        object.__setattr__(
            self,
            "output_artifact_kinds",
            tuple(sorted(dict.fromkeys(str(item) for item in self.output_artifact_kinds))),
        )
        modes = {
            str(kind): str(mode)
            for kind, mode in dict(self.output_artifact_modes).items()
        }
        unknown_modes = sorted(set(modes.values()) - _ARTIFACT_MODES)
        if unknown_modes:
            raise ValueError(
                f"unsupported role artifact output modes: {unknown_modes}"
            )
        undeclared = sorted(set(modes) - set(self.effective_output_artifact_kinds))
        if undeclared:
            raise ValueError(
                f"role artifact modes reference undeclared outputs: {undeclared}"
            )
        object.__setattr__(self, "output_artifact_modes", modes)
        if self.workspace_access not in _WORKSPACE_ACCESS_MODES:
            raise ValueError(
                f"unsupported role workspace access: {self.workspace_access}"
            )

    @property
    def effective_output_artifact_kinds(self) -> tuple[str, ...]:
        if self.output_artifact_kinds:
            return self.output_artifact_kinds
        defaults = {
            "director": ("brief",),
            "specialist": ("patch",),
            "integrator": ("build", "game"),
            "critic": ("review",),
            "operator": ("build", "game"),
        }
        return defaults.get(self.kind, ("artifact",))

    def output_artifact_mode(self, kind: str) -> str:
        if kind in self.output_artifact_modes:
            return self.output_artifact_modes[kind]
        # Preserve v0.2/v0.3 snapshot behavior while allowing every new kind
        # to opt into workspace publication explicitly.
        return "workspace" if kind in {"build", "game", "patch", "workspace"} else "inline"

    @property
    def effective_harness_hash(self) -> str:
        return "effective-role-harness-" + sha256_json(
            {
                "harness_spec": (
                    None if self.harness_spec is None else self.harness_spec.to_dict()
                ),
                "provider": self.provider,
                "model": self.model,
                "system_prompt": self.system_prompt,
                "capabilities": list(self.capabilities),
                "tool_interface_ids": list(self.tool_interface_ids),
                "output_artifact_kinds": list(self.effective_output_artifact_kinds),
                "output_artifact_modes": {
                    kind: self.output_artifact_mode(kind)
                    for kind in self.effective_output_artifact_kinds
                },
                "workspace_access": self.workspace_access,
                "context": self.context.to_dict(),
                "budget": self.budget.to_dict(),
            }
        )[:24]

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["capabilities"] = list(self.capabilities)
        value["tool_interface_ids"] = list(self.tool_interface_ids)
        if self.output_artifact_kinds:
            value["output_artifact_kinds"] = list(self.output_artifact_kinds)
        else:
            value.pop("output_artifact_kinds", None)
        if self.output_artifact_modes:
            value["output_artifact_modes"] = dict(self.output_artifact_modes)
        else:
            value.pop("output_artifact_modes", None)
        if self.workspace_access == "read_write":
            value.pop("workspace_access", None)
        if self.harness_spec is None:
            value.pop("harness_spec", None)
        else:
            value["harness_spec"] = self.harness_spec.to_dict()
        value["context"] = self.context.to_dict()
        value["budget"] = self.budget.to_dict()
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> AgentRole:
        return cls(
            role_id=str(value["role_id"]),
            name=str(value["name"]),
            kind=str(value["kind"]),
            objective=str(value["objective"]),
            system_prompt=str(value["system_prompt"]),
            capabilities=tuple(str(item) for item in value.get("capabilities", [])),
            tool_interface_ids=tuple(
                str(item) for item in value.get("tool_interface_ids", [])
            ),
            output_artifact_kinds=tuple(
                str(item) for item in value.get("output_artifact_kinds", [])
            ),
            output_artifact_modes={
                str(kind): str(mode)
                for kind, mode in dict(
                    value.get("output_artifact_modes", {})
                ).items()
            },
            workspace_access=str(value.get("workspace_access", "read_write")),
            harness_spec=RoleHarnessSpec.from_dict(value.get("harness_spec")),
            context=AgentContextPolicy.from_dict(value.get("context")),
            budget=AgentBudget.from_dict(value.get("budget")),
            provider=(None if value.get("provider") is None else str(value["provider"])),
            model=None if value.get("model") is None else str(value["model"]),
        )


@dataclass(frozen=True)
class CircuitEdge:
    """Typed context or control transfer between two circuit roles."""

    edge_id: str
    source: str
    target: str
    kind: str
    instruction: str
    artifact_kinds: tuple[str, ...] = ()
    required: bool = True
    max_traversals: int = 1
    protocol: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "edge_id", _identifier(self.edge_id, field_name="edge_id")
        )
        object.__setattr__(self, "source", _identifier(self.source, field_name="source"))
        object.__setattr__(self, "target", _identifier(self.target, field_name="target"))
        if self.source == self.target:
            raise ValueError("circuit edge cannot target its source role")
        object.__setattr__(
            self, "kind", _identifier(self.kind, field_name="circuit edge kind")
        )
        protocol = self.protocol
        if protocol is None:
            # agent-circuit.v1 snapshots used kind=feedback as the executable
            # feedback marker. Preserve replay while decoupling future semantic
            # labels from runtime control flow.
            protocol = "feedback" if self.kind == "feedback" else "forward"
        if protocol not in _EDGE_PROTOCOLS:
            raise ValueError(f"unsupported circuit edge protocol: {protocol}")
        object.__setattr__(self, "protocol", protocol)
        if not self.instruction.strip():
            raise ValueError("circuit edge instruction is required")
        if self.is_feedback:
            if not 1 <= self.max_traversals <= 3:
                raise ValueError("feedback edge max_traversals must be within 1..3")
        elif self.max_traversals != 1:
            raise ValueError("only feedback edges may traverse more than once")
        object.__setattr__(
            self,
            "artifact_kinds",
            tuple(sorted(dict.fromkeys(str(item) for item in self.artifact_kinds))),
        )

    @property
    def is_feedback(self) -> bool:
        return self.protocol == "feedback"

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["artifact_kinds"] = list(self.artifact_kinds)
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> CircuitEdge:
        return cls(
            edge_id=str(value["edge_id"]),
            source=str(value["source"]),
            target=str(value["target"]),
            kind=str(value["kind"]),
            instruction=str(value["instruction"]),
            artifact_kinds=tuple(str(item) for item in value.get("artifact_kinds", [])),
            required=bool(value.get("required", True)),
            max_traversals=int(value.get("max_traversals", 1)),
            protocol=(
                None if value.get("protocol") is None else str(value["protocol"])
            ),
        )


@dataclass(frozen=True)
class CircuitPolicy:
    max_parallel_roles: int = 1
    wall_timeout_seconds: int = 2350
    max_total_model_calls: int = 8
    max_total_cost_units: float = 8.0
    failure_mode: str = "fail_fast"
    workspace_mode: str = "isolated_then_merge"

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "max_total_cost_units", float(self.max_total_cost_units)
        )
        if self.max_parallel_roles < 1:
            raise ValueError("circuit max_parallel_roles must be positive")
        if self.wall_timeout_seconds < 1 or self.max_total_model_calls < 1:
            raise ValueError("circuit timeout and model-call budget must be positive")
        if self.max_total_cost_units <= 0:
            raise ValueError("circuit max_total_cost_units must be positive")
        if self.failure_mode not in _FAILURE_MODES:
            raise ValueError(f"unsupported circuit failure mode: {self.failure_mode}")
        if self.workspace_mode not in {"isolated_then_merge", "shared"}:
            raise ValueError(f"unsupported circuit workspace mode: {self.workspace_mode}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any] | None) -> CircuitPolicy:
        raw = value or {}
        return cls(
            max_parallel_roles=int(raw.get("max_parallel_roles", 1)),
            wall_timeout_seconds=int(raw.get("wall_timeout_seconds", 2350)),
            max_total_model_calls=int(raw.get("max_total_model_calls", 8)),
            max_total_cost_units=float(raw.get("max_total_cost_units", 8.0)),
            failure_mode=str(raw.get("failure_mode", "fail_fast")),
            workspace_mode=str(raw.get("workspace_mode", "isolated_then_merge")),
        )


@dataclass(frozen=True)
class AgentCircuit:
    """Content-addressable executable organization for one GOA harness."""

    roles: tuple[AgentRole, ...]
    edges: tuple[CircuitEdge, ...]
    entry_role_ids: tuple[str, ...]
    terminal_role_ids: tuple[str, ...]
    policy: CircuitPolicy = field(default_factory=CircuitPolicy)
    schema_version: str = "agent-circuit.v1"

    def __post_init__(self) -> None:
        if self.schema_version != "agent-circuit.v1":
            raise ValueError(f"unsupported agent circuit schema: {self.schema_version}")
        roles = tuple(sorted(self.roles, key=lambda item: item.role_id))
        edges = tuple(sorted(self.edges, key=lambda item: item.edge_id))
        object.__setattr__(self, "roles", roles)
        object.__setattr__(self, "edges", edges)
        role_ids = [item.role_id for item in roles]
        edge_ids = [item.edge_id for item in edges]
        if not role_ids:
            raise ValueError("agent circuit requires at least one role")
        if len(role_ids) != len(set(role_ids)):
            raise ValueError("agent circuit role ids must be unique")
        if len(edge_ids) != len(set(edge_ids)):
            raise ValueError("agent circuit edge ids must be unique")
        role_set = set(role_ids)
        entry = tuple(sorted(dict.fromkeys(self.entry_role_ids)))
        terminal = tuple(sorted(dict.fromkeys(self.terminal_role_ids)))
        object.__setattr__(self, "entry_role_ids", entry)
        object.__setattr__(self, "terminal_role_ids", terminal)
        if not entry or not terminal:
            raise ValueError("agent circuit requires entry and terminal roles")
        unknown_boundary = sorted((set(entry) | set(terminal)) - role_set)
        if unknown_boundary:
            raise ValueError(f"agent circuit boundary references unknown roles: {unknown_boundary}")
        for edge in edges:
            unknown = {edge.source, edge.target} - role_set
            if unknown:
                raise ValueError(
                    f"circuit edge {edge.edge_id} references unknown roles: {sorted(unknown)}"
                )
        roles_by_id = {role.role_id: role for role in roles}
        for edge in edges:
            if not edge.required or not edge.artifact_kinds:
                continue
            missing = set(edge.artifact_kinds) - set(
                roles_by_id[edge.source].effective_output_artifact_kinds
            )
            if missing:
                raise ValueError(
                    f"required edge {edge.edge_id} requests undeclared producer artifacts: "
                    f"{sorted(missing)}"
                )
        if self.policy.max_parallel_roles > len(roles):
            raise ValueError("circuit parallelism cannot exceed its role count")
        total_calls = sum(role.budget.max_model_calls for role in roles)
        total_cost = sum(role.budget.cost_units for role in roles)
        if total_calls > self.policy.max_total_model_calls:
            raise ValueError("role model-call budgets exceed circuit total")
        if total_cost > self.policy.max_total_cost_units:
            raise ValueError("role cost budgets exceed circuit total")
        self._validate_control_flow()

    @property
    def circuit_id(self) -> str:
        return "circuit-" + sha256_json(self.executable_dict())[:24]

    def executable_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "roles": [item.to_dict() for item in self.roles],
            "edges": [item.to_dict() for item in self.edges],
            "entry_role_ids": list(self.entry_role_ids),
            "terminal_role_ids": list(self.terminal_role_ids),
            "policy": self.policy.to_dict(),
        }

    def to_dict(self) -> dict[str, Any]:
        return {"circuit_id": self.circuit_id, **self.executable_dict()}

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> AgentCircuit:
        result = cls(
            roles=tuple(AgentRole.from_dict(item) for item in value.get("roles", [])),
            edges=tuple(CircuitEdge.from_dict(item) for item in value.get("edges", [])),
            entry_role_ids=tuple(str(item) for item in value.get("entry_role_ids", [])),
            terminal_role_ids=tuple(str(item) for item in value.get("terminal_role_ids", [])),
            policy=CircuitPolicy.from_dict(value.get("policy")),
            schema_version=str(value.get("schema_version", "agent-circuit.v1")),
        )
        supplied_id = str(value.get("circuit_id", ""))
        if supplied_id and supplied_id != result.circuit_id:
            raise ValueError("agent circuit content hash mismatch")
        return result

    @classmethod
    def singleton(
        cls,
        *,
        role_id: str = "maker",
        system_prompt: str = "Build and verify the requested game in the assigned workspace.",
        capabilities: Iterable[str] = (),
        tool_interface_ids: Iterable[str] = (),
        timeout_seconds: int = 1200,
        max_model_calls: int = 1,
        harness_spec: RoleHarnessSpec | None = None,
    ) -> AgentCircuit:
        role = AgentRole(
            role_id=role_id,
            name="Game Maker",
            kind="operator",
            objective="Produce the best verified game artifact for the user request.",
            system_prompt=system_prompt,
            capabilities=tuple(capabilities),
            tool_interface_ids=tuple(tool_interface_ids),
            harness_spec=harness_spec,
            budget=AgentBudget(
                max_model_calls=max_model_calls,
                timeout_seconds=timeout_seconds,
            ),
        )
        return cls(
            roles=(role,),
            edges=(),
            entry_role_ids=(role_id,),
            terminal_role_ids=(role_id,),
            policy=CircuitPolicy(
                max_parallel_roles=1,
                wall_timeout_seconds=timeout_seconds,
                max_total_model_calls=max_model_calls,
                max_total_cost_units=role.budget.cost_units,
                failure_mode="fail_fast",
            ),
        )

    def _validate_control_flow(self) -> None:
        ordinary = [edge for edge in self.edges if not edge.is_feedback]
        adjacency: dict[str, list[str]] = {role.role_id: [] for role in self.roles}
        indegree = {role.role_id: 0 for role in self.roles}
        for edge in ordinary:
            adjacency[edge.source].append(edge.target)
            indegree[edge.target] += 1
        queue = sorted(role_id for role_id, degree in indegree.items() if degree == 0)
        visited: list[str] = []
        while queue:
            role_id = queue.pop(0)
            visited.append(role_id)
            for target in sorted(adjacency[role_id]):
                indegree[target] -= 1
                if indegree[target] == 0:
                    queue.append(target)
                    queue.sort()
        if len(visited) != len(self.roles):
            raise ValueError("non-feedback circuit edges must form a DAG")

        reachable = set(self.entry_role_ids)
        changed = True
        while changed:
            changed = False
            for edge in ordinary:
                if edge.source in reachable and edge.target not in reachable:
                    reachable.add(edge.target)
                    changed = True
        unreachable = sorted({role.role_id for role in self.roles} - reachable)
        if unreachable:
            raise ValueError(f"agent circuit contains unreachable roles: {unreachable}")
        if not set(self.terminal_role_ids) <= reachable:
            raise ValueError("agent circuit terminal roles must be reachable")

        ancestors: dict[str, set[str]] = {role.role_id: set() for role in self.roles}
        for source in visited:
            for target in adjacency[source]:
                ancestors[target].add(source)
                ancestors[target].update(ancestors[source])
        for edge in self.edges:
            if edge.is_feedback and edge.target not in ancestors[edge.source]:
                raise ValueError(
                    f"feedback edge {edge.edge_id} must return to an ancestor role"
                )


def workspace_artifact_kinds(role: AgentRole) -> frozenset[str]:
    """Return the artifacts that publish the role's complete workspace snapshot."""

    return frozenset(
        kind
        for kind in role.effective_output_artifact_kinds
        if role.output_artifact_mode(kind) == "workspace"
    )


def edge_carries_workspace(
    edge: CircuitEdge,
    *,
    roles: Mapping[str, AgentRole],
) -> bool:
    """Whether a required forward edge transfers its producer's workspace."""

    if edge.is_feedback or not edge.required:
        return False
    produced = workspace_artifact_kinds(roles[edge.source])
    if not produced:
        return False
    # An empty artifact filter forwards every artifact emitted by the source.
    return not edge.artifact_kinds or bool(produced & set(edge.artifact_kinds))


def validate_workspace_lineage(circuit: AgentCircuit) -> None:
    """Validate that isolated edits can reach a publishable terminal workspace.

    Inline artifacts carry information, never file mutations. Every non-terminal
    writer therefore needs a complete path of required workspace handoffs to a
    terminal workspace publisher. This is intentionally role-name agnostic so an
    HPA may invent arbitrary studios, fan-out/fan-in graphs, and role semantics.
    """

    roles = {role.role_id: role for role in circuit.roles}
    terminal_ids = set(circuit.terminal_role_ids)
    publishable_terminals = {
        role_id
        for role_id in terminal_ids
        if workspace_artifact_kinds(roles[role_id])
    }
    if not publishable_terminals:
        raise ValueError(
            "candidate circuit has no terminal workspace artifact; declare a terminal "
            "output kind with output_artifact_modes[kind]=workspace"
        )
    if circuit.policy.workspace_mode == "shared":
        return

    workspace_successors: dict[str, set[str]] = {
        role_id: set() for role_id in roles
    }
    for edge in circuit.edges:
        if edge_carries_workspace(edge, roles=roles):
            workspace_successors[edge.source].add(edge.target)

    for role in circuit.roles:
        if role.role_id in terminal_ids or role.workspace_access != "read_write":
            continue
        if not workspace_artifact_kinds(role):
            raise ValueError(
                f"isolated read-write role {role.role_id} must publish a workspace "
                "artifact to its successor"
            )

        reachable = {role.role_id}
        frontier = [role.role_id]
        while frontier:
            source = frontier.pop()
            for target in workspace_successors[source]:
                if target not in reachable:
                    reachable.add(target)
                    frontier.append(target)
        if not (reachable & publishable_terminals):
            raise ValueError(
                f"isolated read-write role {role.role_id} has no required workspace "
                "handoff path to a terminal publisher; inline edges do not transfer edits"
            )
