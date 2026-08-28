from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from statistics import median
from typing import Any, Iterable, Mapping, Protocol, Sequence

from game_loop.config import (
    HarnessElementConfig,
    HarnessEvolutionConfig,
    HarnessModuleConfig,
    HarnessToolInterfaceConfig,
)
from game_loop.core.agent_circuit import AgentCircuit, RoleHarnessSpec
from game_loop.core.agent_circuit_evolution import (
    CircuitMutationEngine,
    CircuitMutationTransaction,
)
from game_loop.utils import atomic_write_json, read_json, sha256_json, utc_now


@dataclass(frozen=True)
class ContextCompilerPolicy:
    """Executable policy for selecting and compressing evidence before a model call."""

    history_window: int = 5
    diagnostics_limit: int = 3
    reasons_limit: int = 3
    include_accepted_attempts: bool = True
    include_rejected_attempts: bool = True
    include_probe_summaries: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any] | None) -> "ContextCompilerPolicy":
        raw = value or {}
        result = cls(
            history_window=int(raw.get("history_window", 5)),
            diagnostics_limit=int(raw.get("diagnostics_limit", 3)),
            reasons_limit=int(raw.get("reasons_limit", 3)),
            include_accepted_attempts=bool(raw.get("include_accepted_attempts", True)),
            include_rejected_attempts=bool(raw.get("include_rejected_attempts", True)),
            include_probe_summaries=bool(raw.get("include_probe_summaries", True)),
        )
        if not 0 <= result.history_window <= 20:
            raise ValueError("context history_window must be within 0..20")
        if not 0 <= result.diagnostics_limit <= 20:
            raise ValueError("context diagnostics_limit must be within 0..20")
        if not 0 <= result.reasons_limit <= 20:
            raise ValueError("context reasons_limit must be within 0..20")
        return result


@dataclass(frozen=True)
class RecoveryPolicy:
    """Precommitted transition rules; runtime events select branches, not new rules."""

    infrastructure_retries: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any] | None) -> "RecoveryPolicy":
        raw = value or {}
        result = cls(
            infrastructure_retries=int(raw.get("infrastructure_retries", 0)),
        )
        if not 0 <= result.infrastructure_retries <= 2:
            raise ValueError("infrastructure_retries must be within 0..2")
        return result


@dataclass(frozen=True)
class ValidationPolicy:
    """Precommitted repair branch after deterministic validation failures."""

    repair_attempts: int = 0
    repair_on_gate_failure: bool = True
    repair_on_probe_failure: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any] | None) -> "ValidationPolicy":
        raw = value or {}
        result = cls(
            repair_attempts=int(raw.get("repair_attempts", 0)),
            repair_on_gate_failure=bool(raw.get("repair_on_gate_failure", True)),
            repair_on_probe_failure=bool(raw.get("repair_on_probe_failure", True)),
        )
        if not 0 <= result.repair_attempts <= 2:
            raise ValueError("validation repair_attempts must be within 0..2")
        return result


@dataclass(frozen=True)
class HarnessToolInterface:
    """Content-addressed tool/MCP/interface spec owned by the Agent harness."""

    interface_id: str
    kind: str
    description: str
    command: tuple[str, ...] = ()
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    safety_scope: str = "candidate_workspace_only"
    tags: tuple[str, ...] = ()
    source_hash: str = ""

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["command"] = list(self.command)
        value["tags"] = list(self.tags)
        value["source_hash"] = self.source_hash or self.compute_source_hash(value)
        return value

    @classmethod
    def from_config(cls, config: HarnessToolInterfaceConfig) -> "HarnessToolInterface":
        value = cls(
            interface_id=config.interface_id,
            kind=config.kind,
            description=config.description,
            command=config.command,
            cwd=None if config.cwd is None else str(config.cwd),
            env=dict(config.env),
            safety_scope=config.safety_scope,
            tags=config.tags,
        )
        return cls.from_dict(value.to_dict())

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "HarnessToolInterface":
        result = cls(
            interface_id=str(value["interface_id"]),
            kind=str(value["kind"]),
            description=str(value["description"]),
            command=tuple(str(item) for item in value.get("command", [])),
            cwd=(None if value.get("cwd") is None else str(value["cwd"])),
            env={str(k): str(v) for k, v in value.get("env", {}).items()},
            safety_scope=str(value.get("safety_scope", "candidate_workspace_only")),
            tags=tuple(str(item) for item in value.get("tags", [])),
            source_hash=str(value.get("source_hash", "")),
        )
        expected = cls.compute_source_hash(result.to_dict())
        if result.source_hash and result.source_hash != expected:
            raise ValueError(
                f"harness tool interface {result.interface_id} source_hash mismatch"
            )
        return cls(
            interface_id=result.interface_id,
            kind=result.kind,
            description=result.description,
            command=result.command,
            cwd=result.cwd,
            env=result.env,
            safety_scope=result.safety_scope,
            tags=tuple(sorted(dict.fromkeys(result.tags))),
            source_hash=expected,
        )

    @staticmethod
    def compute_source_hash(value: dict[str, Any]) -> str:
        payload = dict(value)
        payload.pop("source_hash", None)
        return sha256_json(payload)


@dataclass(frozen=True)
class HarnessActiveElement:
    """One activated catalog item inside a harness category (skill/MCP/tool/...)."""

    element_id: str
    category: str
    description: str
    spec: dict[str, Any] = field(default_factory=dict)
    spec_hash: str = ""

    def to_dict(self) -> dict[str, Any]:
        spec_hash = self.spec_hash or self.compute_spec_hash()
        return {
            "element_id": self.element_id,
            "category": self.category,
            "description": self.description,
            "spec": dict(self.spec),
            "spec_hash": spec_hash,
        }

    def compute_spec_hash(self) -> str:
        return self.compute_spec_hash_from_payload(
            {
                "element_id": self.element_id,
                "category": self.category,
                "description": self.description,
                "spec": dict(self.spec),
            }
        )

    @classmethod
    def from_config(cls, config: HarnessElementConfig) -> "HarnessActiveElement":
        payload = {
            "element_id": config.element_id,
            "category": config.category,
            "description": config.description,
            "spec": dict(config.spec),
        }
        return cls(
            element_id=config.element_id,
            category=config.category,
            description=config.description,
            spec=dict(config.spec),
            spec_hash=cls.compute_spec_hash_from_payload(payload),
        )

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "HarnessActiveElement":
        result = cls(
            element_id=str(value["element_id"]),
            category=str(value["category"]),
            description=str(value.get("description", "")),
            spec={str(k): v for k, v in dict(value.get("spec", {})).items()},
            spec_hash=str(value.get("spec_hash", "")),
        )
        expected = result.compute_spec_hash()
        if result.spec_hash and result.spec_hash != expected:
            raise ValueError(f"harness element {result.element_id} spec_hash mismatch")
        return cls(
            element_id=result.element_id,
            category=result.category,
            description=result.description,
            spec=result.spec,
            spec_hash=expected,
        )

    @staticmethod
    def compute_spec_hash_from_payload(payload: dict[str, Any]) -> str:
        body = {
            "element_id": payload["element_id"],
            "category": payload["category"],
            "description": payload.get("description", ""),
            "spec": payload.get("spec", {}),
        }
        return sha256_json(body)


@dataclass(frozen=True)
class HarnessProfile:
    """A content-addressed Agent/engine harness used unchanged for one benchmark episode."""

    harness_id: str
    parent_harness_id: str | None
    active_modules: tuple[str, ...]
    active_tool_interfaces: tuple[HarnessToolInterface, ...]
    active_elements: tuple[HarnessActiveElement, ...]
    context_compiler: ContextCompilerPolicy
    recovery_policy: RecoveryPolicy
    validation_policy: ValidationPolicy
    generation: int
    rationale: str
    created_at: str
    agent_circuit: AgentCircuit | None = None

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["active_modules"] = list(self.active_modules)
        value["active_tool_interfaces"] = [
            item.to_dict() for item in self.active_tool_interfaces
        ]
        value["active_elements"] = [item.to_dict() for item in self.active_elements]
        value["context_compiler"] = self.context_compiler.to_dict()
        value["recovery_policy"] = self.recovery_policy.to_dict()
        value["validation_policy"] = self.validation_policy.to_dict()
        value["agent_circuit"] = (
            None if self.agent_circuit is None else self.agent_circuit.to_dict()
        )
        return value

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "HarnessProfile":
        return cls(
            harness_id=str(value["harness_id"]),
            parent_harness_id=value.get("parent_harness_id"),
            active_modules=tuple(str(item) for item in value.get("active_modules", [])),
            active_tool_interfaces=tuple(
                HarnessToolInterface.from_dict(dict(item))
                for item in value.get("active_tool_interfaces", [])
            ),
            active_elements=tuple(
                HarnessActiveElement.from_dict(dict(item))
                for item in value.get("active_elements", [])
            ),
            context_compiler=ContextCompilerPolicy.from_dict(
                value.get("context_compiler")
            ),
            recovery_policy=RecoveryPolicy.from_dict(value.get("recovery_policy")),
            validation_policy=ValidationPolicy.from_dict(value.get("validation_policy")),
            generation=int(value.get("generation", 0)),
            rationale=str(value.get("rationale", "")),
            created_at=str(value.get("created_at", "")),
            agent_circuit=(
                None
                if value.get("agent_circuit") is None
                else AgentCircuit.from_dict(dict(value["agent_circuit"]))
            ),
        )

    def effective_agent_circuit(self) -> AgentCircuit:
        """Return the explicit v0.3 circuit or a deterministic legacy singleton."""

        if self.agent_circuit is not None:
            return self.agent_circuit
        return AgentCircuit.singleton(
            capabilities=(
                f"{item.category}:{item.element_id}" for item in self.active_elements
            ),
            tool_interface_ids=(
                item.interface_id for item in self.active_tool_interfaces
            ),
            harness_spec=RoleHarnessSpec(
                source_harness_id=self.harness_id,
                active_module_ids=self.active_modules,
                active_element_ids=tuple(
                    item.element_id for item in self.active_elements
                ),
                active_cordis_plugins=tuple(
                    str(item.spec.get("plugin_id", item.element_id))
                    for item in self.active_elements
                    if item.category == "dsh_plugin"
                ),
            ),
        )


@dataclass(frozen=True)
class HarnessSemanticGradient:
    """Trace-grounded diagnosis passed to a harness proposer."""

    diagnosis: str
    target_tags: tuple[str, ...] = ()
    evidence_refs: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class HarnessReplayCase:
    """One frozen starting point used by both sides of a paired replay."""

    case_id: str
    task_ref: str
    parent_artifact_ref: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class HarnessEpisodeOutcome:
    """Final benchmark result from one frozen-harness episode."""

    case_id: str
    harness_id: str
    final_score: float | None
    feasible: bool
    model_calls: int
    evaluator_queries: int
    infrastructure_ok: bool = True
    run_ref: str | None = None
    allocated_model_calls: int | None = None
    allocated_evaluator_queries: int | None = None
    allocated_probe_calls: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class HarnessEpochResult:
    epoch: int
    parent_harness_id: str
    candidate_harness_id: str
    accepted: bool
    paired_deltas: tuple[float, ...]
    median_delta: float | None
    reasons: tuple[str, ...]
    excluded_pairs: tuple[str, ...]
    parent_outcomes: tuple[HarnessEpisodeOutcome, ...]
    candidate_outcomes: tuple[HarnessEpisodeOutcome, ...]
    created_at: str
    rubric_validation: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["paired_deltas"] = list(self.paired_deltas)
        value["reasons"] = list(self.reasons)
        value["excluded_pairs"] = list(self.excluded_pairs)
        value["parent_outcomes"] = [item.to_dict() for item in self.parent_outcomes]
        value["candidate_outcomes"] = [item.to_dict() for item in self.candidate_outcomes]
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "HarnessEpochResult":
        return cls(
            epoch=int(value["epoch"]),
            parent_harness_id=str(value["parent_harness_id"]),
            candidate_harness_id=str(value["candidate_harness_id"]),
            accepted=bool(value.get("accepted", False)),
            paired_deltas=tuple(float(item) for item in value.get("paired_deltas", [])),
            median_delta=(
                None
                if value.get("median_delta") is None
                else float(value["median_delta"])
            ),
            reasons=tuple(str(item) for item in value.get("reasons", [])),
            excluded_pairs=tuple(
                str(item) for item in value.get("excluded_pairs", [])
            ),
            parent_outcomes=tuple(
                HarnessEpisodeOutcome(**dict(item))
                for item in value.get("parent_outcomes", [])
            ),
            candidate_outcomes=tuple(
                HarnessEpisodeOutcome(**dict(item))
                for item in value.get("candidate_outcomes", [])
            ),
            created_at=str(value.get("created_at", utc_now())),
            rubric_validation=(
                None
                if value.get("rubric_validation") is None
                else dict(value["rubric_validation"])
            ),
        )


class HarnessReplayRunner(Protocol):
    def run_episode(
        self,
        case: HarnessReplayCase,
        harness: HarnessProfile,
        *,
        side: str,
        epoch: int,
    ) -> HarnessEpisodeOutcome: ...


class HarnessEvolutionEngine:
    """Stores and proposes harnesses; it never promotes from a single game attempt."""

    policy_version = "two-timescale-executable-harness-v4"

    def __init__(
        self,
        run_dir: Path,
        config: HarnessEvolutionConfig,
        *,
        allow_mutation: bool = True,
        role_runtime_contract: Mapping[str, Any] | None = None,
        managed_element_categories: Iterable[str] = (),
    ):
        self.root = run_dir / "harness_archive"
        self.profiles = self.root / "profiles"
        self.config = config
        self.allow_mutation = allow_mutation
        self.role_runtime_contract = (
            None if role_runtime_contract is None else dict(role_runtime_contract)
        )
        self.managed_element_categories = frozenset(
            str(category).strip().casefold()
            for category in managed_element_categories
            if str(category).strip()
        )
        self._live_managed_element_ids: dict[str, frozenset[str]] = {}
        self.modules = {module.module_id: module for module in config.modules}
        self.module_categories = {
            module.module_id: module.category for module in config.modules
        }
        self.tool_interfaces = {
            interface.interface_id: HarnessToolInterface.from_config(interface)
            for interface in config.tool_interfaces
        }
        self.elements = {element.element_id: element for element in config.element_catalog}
        self._load_extended_element_catalog()

    def category_is_mutable(self, category: str) -> bool:
        if category.casefold() in self.managed_element_categories:
            return False
        allowed = self.config.allowed_element_categories
        return not allowed or category.casefold() in allowed

    def role_harness_catalog(self) -> dict[str, Any]:
        """Disclose the audited component vocabulary available to HPA roles."""

        live_managed_ids = set().union(*self._live_managed_element_ids.values())
        plugins = []
        for element in self.elements.values():
            if element.category != "dsh_plugin":
                continue
            plugins.append({
                "id": str(element.spec.get("plugin_id", element.element_id)),
                "element_id": element.element_id,
                "description": element.description,
                "spec_hash": HarnessActiveElement.from_config(element).spec_hash,
            })
        catalog = {
            "schema_version": "role-harness-catalog.v1",
            "modules": [
                {
                    "id": item.module_id,
                    "category": item.category,
                    "instruction": item.instruction,
                    "tags": list(item.tags),
                    "content_hash": sha256_json({
                        "instruction": item.instruction,
                        "category": item.category,
                        "tags": list(item.tags),
                    }),
                }
                for item in sorted(
                    self.modules.values(), key=lambda value: value.module_id
                )
            ],
            "elements": [
                {
                    "element_id": item.element_id,
                    "category": item.category,
                    "description": item.description,
                    "tags": list(item.tags),
                    "spec_hash": HarnessActiveElement.from_config(item).spec_hash,
                }
                for item in sorted(
                    (
                        item
                        for item in self.elements.values()
                        if item.category not in self.managed_element_categories
                        or item.element_id in live_managed_ids
                    ),
                    key=lambda value: value.element_id,
                )
            ],
            "tool_interfaces": [
                {
                    "interface_id": item.interface_id,
                    "kind": item.kind,
                    "description": item.description,
                    "tags": list(item.tags),
                    "source_hash": item.source_hash,
                }
                for item in sorted(
                    self.tool_interfaces.values(),
                    key=lambda value: value.interface_id,
                )
            ],
            "cordis_plugins": sorted(plugins, key=lambda item: item["id"]),
            "per_role_limits": {
                "modules": self.config.max_active_modules,
                "tool_interfaces": self.config.max_active_tool_interfaces,
                "elements": dict(self.config.max_active_elements),
            },
            "managed_element_categories": sorted(self.managed_element_categories),
        }
        if self.role_runtime_contract is not None:
            catalog["runtime_contract"] = dict(self.role_runtime_contract)
        return catalog

    def initialize(self, initial_profile: HarnessProfile | None = None) -> HarnessProfile:
        self.profiles.mkdir(parents=True, exist_ok=True)
        manifest_path = self.root / "manifest.json"
        epochs_path = self.root / "epochs.json"
        champion_path = self.root / "champion.json"
        existing = tuple(
            path.is_file() for path in (manifest_path, epochs_path, champion_path)
        )
        if all(existing):
            manifest = read_json(manifest_path)
            if manifest.get("policy_version") != self.policy_version:
                raise ValueError("existing harness archive policy version mismatch")
            epochs = read_json(epochs_path)
            if not isinstance(epochs.get("items"), list):
                raise ValueError("existing harness archive epochs are invalid")
            champion = self.champion()
            self._validate_profile(champion)
            return champion
        if any(existing):
            missing = [
                path.name
                for path, present in zip(
                    (manifest_path, epochs_path, champion_path), existing
                )
                if not present
            ]
            raise RuntimeError(
                "partial harness archive cannot be initialized safely; missing: "
                + ", ".join(missing)
            )
        profile = initial_profile or self._profile(
            parent_id=None,
            modules=self.config.seed_modules,
            tool_interfaces=self._seed_tool_interfaces(),
            active_elements=self._seed_elements(),
            context_compiler=ContextCompilerPolicy(),
            recovery_policy=RecoveryPolicy(),
            validation_policy=ValidationPolicy(),
            generation=0,
            rationale="configuration-frozen seed harness",
        )
        self._validate_profile(profile)
        self._write_profile(profile)
        atomic_write_json(self.root / "manifest.json", {
            "schema_version": "2.0",
            "policy_version": self.policy_version,
            "timescale": "harness changes only between complete benchmark episodes",
            "module_catalog": [
                {
                    "id": module.module_id,
                    "tags": list(module.tags),
                    "instruction_hash": sha256_json(module.instruction),
                }
                for module in self.config.modules
            ],
            "tool_interface_catalog": [
                {
                    "id": interface.interface_id,
                    "kind": interface.kind,
                    "tags": list(interface.tags),
                    "safety_scope": interface.safety_scope,
                    "source_hash": interface.source_hash,
                    "command_hash": sha256_json(list(interface.command)),
                }
                for interface in self.tool_interfaces.values()
            ],
            "seed_harness_id": profile.harness_id,
            "max_active_modules": self.config.max_active_modules,
            "max_active_tool_interfaces": self.config.max_active_tool_interfaces,
            "managed_element_categories": sorted(self.managed_element_categories),
            "mutation_width": self.config.mutation_width,
            "bundle_width": self.config.bundle_width,
            "attribution_mode": self.config.attribution_mode,
            "replay_min_cases": self.config.replay_min_cases,
            "promotion_delta_min": self.config.promotion_delta_min,
            "max_case_regression": self.config.max_case_regression,
        })
        atomic_write_json(self.root / "epochs.json", {"schema_version": "2.0", "items": []})
        atomic_write_json(self.root / "champion.json", {
            "harness_id": profile.harness_id,
            "updated_at": utc_now(),
        })
        return profile

    def get(self, harness_id: str) -> HarnessProfile:
        return HarnessProfile.from_dict(read_json(self.profiles / f"{harness_id}.json"))

    def champion(self) -> HarnessProfile:
        value = read_json(self.root / "champion.json")
        return self.get(str(value["harness_id"]))

    def propose(
        self,
        *,
        parent_id: str,
        gradient: HarnessSemanticGradient,
        epoch: int,
    ) -> HarnessProfile:
        parent = self.get(parent_id)
        if not self.allow_mutation:
            return parent
        ablation = self._propose_pending_ablation(
            parent=parent,
            gradient=gradient,
            epoch=epoch,
        )
        if ablation is not None:
            return ablation
        active = list(parent.active_modules)
        active_tool_interfaces = list(parent.active_tool_interfaces)
        active_elements = list(parent.active_elements)
        context_compiler = parent.context_compiler
        recovery_policy = parent.recovery_policy
        validation_policy = parent.validation_policy
        from game_loop.core.harness_element_stats import (
            HarnessElementStatsStore,
            mutate_category_elements,
            resolve_target_categories,
        )

        target_categories = resolve_target_categories(gradient.target_tags)
        bundle_actions: list[dict[str, Any]] = []
        role_capacity_multiplier = (
            1 if parent.agent_circuit is None else len(parent.agent_circuit.roles)
        )
        element_limits = {
            category: limit * role_capacity_multiplier
            for category, limit in self.config.max_active_elements.items()
        }
        if (
            target_categories
            and self.elements
            and self.config.enable_usage_driven_mutation
        ):
            stats = HarnessElementStatsStore.load(self.root / "element_stats.json")
            for _ in range(self.config.bundle_width):
                mutation_applied = False
                for target_category in target_categories:
                    if not self.category_is_mutable(target_category):
                        continue
                    before_ids = {
                        item.element_id
                        for item in active_elements
                        if item.category == target_category
                    }
                    mutation = mutate_category_elements(
                        active=active_elements,
                        category=target_category,
                        catalog=self.elements,
                        stats=stats,
                        limits=element_limits,
                        gradient_tags=gradient.target_tags,
                        policy=self.config.element_mutation_policy,
                        allow_explicit_replacement=(
                            bool(self.config.allowed_element_categories)
                            or "element_replace"
                            in {tag.casefold() for tag in gradient.target_tags}
                        ),
                    )
                    if mutation is None:
                        continue
                    active_elements = mutation.active
                    for addition in mutation.catalog_additions:
                        self.register_element(addition)
                    after_ids = {
                        item.element_id
                        for item in active_elements
                        if item.category == target_category
                    }
                    bundle_actions.append(
                        {
                            "category": target_category,
                            "operation": mutation.operation,
                            "added_element_ids": sorted(after_ids - before_ids),
                            "removed_element_ids": sorted(before_ids - after_ids),
                        }
                    )
                    mutation_applied = True
                    break
                if not mutation_applied:
                    break
            if bundle_actions:
                stats.save(self.root / "element_stats.json")
        elif (
            self.config.enable_tool_interface_mutation
            and self._targets_tool_interface(gradient)
        ):
            active_tool_interfaces = self._mutate_tool_interfaces(
                active_tool_interfaces,
                gradient,
                max_active=(
                    self.config.max_active_tool_interfaces
                    * role_capacity_multiplier
                ),
            )
        elif self._targets_context(gradient):
            context_compiler = self._mutate_context(context_compiler, gradient)
        elif (
            self.config.enable_executable_policy_mutation
            and self._targets_recovery(gradient)
        ):
            recovery_policy = self._mutate_recovery(recovery_policy, gradient)
        elif (
            self.config.enable_executable_policy_mutation
            and self._targets_validation(gradient)
        ):
            validation_policy = self._mutate_validation(validation_policy, gradient)
        else:
            active = self._mutate_modules(
                active,
                gradient,
                max_active=self.config.max_active_modules * role_capacity_multiplier,
            )
        candidate_circuit = parent.agent_circuit
        if candidate_circuit is not None:
            candidate_circuit, role_assignments = self._retarget_circuit_components(
                parent=parent,
                requested_modules=tuple(active),
                requested_tool_interfaces=tuple(active_tool_interfaces),
                requested_elements=tuple(active_elements),
                gradient=gradient,
            )
            active, active_tool_interfaces, active_elements = self._components_for_circuit(
                candidate_circuit,
                inherited_from=parent,
            )
            if role_assignments:
                bundle_actions.append(
                    {
                        "category": "agent_circuit",
                        "operation": "assign_role_harness_components",
                        "role_assignments": role_assignments,
                        "added_element_ids": [],
                        "removed_element_ids": [],
                    }
                )
        profile = self._profile(
            parent_id=parent_id,
            modules=tuple(active),
            tool_interfaces=tuple(active_tool_interfaces),
            active_elements=tuple(active_elements),
            context_compiler=context_compiler,
            recovery_policy=recovery_policy,
            validation_policy=validation_policy,
            generation=epoch,
            rationale=gradient.diagnosis,
            agent_circuit=candidate_circuit,
        )
        if self._behavior_signature(profile) == self._behavior_signature(parent):
            raise ValueError(
                "harness mutation is a no-op: candidate does not change executable behavior"
            )
        self._write_profile(profile)
        self._write_bundle_manifest(
            epoch=epoch,
            parent=parent,
            candidate=profile,
            gradient=gradient,
            actions=bundle_actions,
        )
        return profile

    def _retarget_circuit_components(
        self,
        *,
        parent: HarnessProfile,
        requested_modules: tuple[str, ...],
        requested_tool_interfaces: tuple[HarnessToolInterface, ...],
        requested_elements: tuple[HarnessActiveElement, ...],
        gradient: HarnessSemanticGradient,
    ) -> tuple[AgentCircuit, list[dict[str, Any]]]:
        """Apply component deltas to evidence-matched roles, without a fixed roster."""

        circuit = parent.agent_circuit
        if circuit is None:
            raise ValueError("role retargeting requires an explicit agent circuit")
        old_modules = set(parent.active_modules)
        new_modules = set(requested_modules)
        old_interfaces = {
            item.interface_id for item in parent.active_tool_interfaces
        }
        new_interfaces = {
            item.interface_id for item in requested_tool_interfaces
        }
        old_elements = {item.element_id for item in parent.active_elements}
        new_elements = {item.element_id for item in requested_elements}
        roles = {role.role_id: role.to_dict() for role in circuit.roles}
        parent_plugin_ids = tuple(
            str(item.spec.get("plugin_id", item.element_id))
            for item in parent.active_elements
            if item.category == "dsh_plugin"
        )
        for role in circuit.roles:
            if role.harness_spec is not None:
                continue
            roles[role.role_id]["harness_spec"] = RoleHarnessSpec(
                source_harness_id=parent.harness_id,
                active_module_ids=parent.active_modules,
                active_element_ids=tuple(
                    item.element_id for item in parent.active_elements
                ),
                active_cordis_plugins=parent_plugin_ids,
            ).to_dict()

        assignments: list[dict[str, Any]] = []

        def mutate_spec(role_id: str, field_name: str, item_id: str, *, add: bool) -> None:
            role = roles[role_id]
            spec = dict(role["harness_spec"])
            values = set(str(item) for item in spec.get(field_name, []))
            if add:
                values.add(item_id)
            else:
                values.discard(item_id)
            spec[field_name] = sorted(values)
            role["harness_spec"] = spec

        def remove_everywhere(field_name: str, item_id: str) -> tuple[str, ...]:
            affected: list[str] = []
            for role_id in sorted(roles):
                values = set(roles[role_id]["harness_spec"].get(field_name, []))
                if item_id not in values:
                    continue
                mutate_spec(role_id, field_name, item_id, add=False)
                affected.append(role_id)
            return tuple(affected)

        for module_id in sorted(old_modules - new_modules):
            affected = remove_everywhere("active_module_ids", module_id)
            assignments.append({
                "operation": "remove",
                "component_kind": "module",
                "component_id": module_id,
                "role_ids": list(affected),
            })
        for element_id in sorted(old_elements - new_elements):
            affected = set(remove_everywhere("active_element_ids", element_id))
            element = self.elements[element_id]
            if element.category == "dsh_plugin":
                plugin_id = str(element.spec.get("plugin_id", element_id))
                affected.update(
                    remove_everywhere("active_cordis_plugins", plugin_id)
                )
            assignments.append({
                "operation": "remove",
                "component_kind": element.category,
                "component_id": element_id,
                "role_ids": sorted(affected),
            })
        for interface_id in sorted(old_interfaces - new_interfaces):
            affected: list[str] = []
            for role_id in sorted(roles):
                values = set(roles[role_id].get("tool_interface_ids", []))
                if interface_id not in values:
                    continue
                values.remove(interface_id)
                roles[role_id]["tool_interface_ids"] = sorted(values)
                affected.append(role_id)
            assignments.append({
                "operation": "remove",
                "component_kind": "tool_interface",
                "component_id": interface_id,
                "role_ids": affected,
            })

        def select_role(*, description: str, tags: tuple[str, ...], category: str) -> str:
            wanted = {
                item.casefold()
                for item in (*gradient.target_tags, *tags, category)
                if item.strip()
            }
            wanted.update(
                token
                for token in re.findall(r"[a-z0-9_]+", description.casefold())
                if len(token) >= 4
            )
            ranked: list[tuple[int, int, str]] = []
            for role_id in sorted(roles):
                role = roles[role_id]
                text = " ".join(
                    [
                        str(role.get("kind", "")),
                        str(role.get("objective", "")),
                        str(role.get("system_prompt", "")),
                        *[str(item) for item in role.get("capabilities", [])],
                    ]
                ).casefold()
                affinity = sum(1 for token in wanted if token in text)
                spec = roles[role_id]["harness_spec"]
                load = (
                    len(spec.get("active_module_ids", []))
                    + len(spec.get("active_element_ids", []))
                    + len(role.get("tool_interface_ids", []))
                )
                ranked.append((affinity, -load, role_id))
            best_score = max((affinity, load) for affinity, load, _ in ranked)
            return next(
                role_id
                for affinity, load, role_id in ranked
                if (affinity, load) == best_score
            )

        for module_id in sorted(new_modules - old_modules):
            module = self.modules[module_id]
            role_id = select_role(
                description=module.instruction,
                tags=module.tags,
                category=module.category,
            )
            mutate_spec(role_id, "active_module_ids", module_id, add=True)
            assignments.append({
                "operation": "add",
                "component_kind": "module",
                "component_id": module_id,
                "role_ids": [role_id],
            })
        for element_id in sorted(new_elements - old_elements):
            element = self.elements[element_id]
            role_id = select_role(
                description=element.description,
                tags=element.tags,
                category=element.category,
            )
            mutate_spec(role_id, "active_element_ids", element_id, add=True)
            if element.category == "dsh_plugin":
                mutate_spec(
                    role_id,
                    "active_cordis_plugins",
                    str(element.spec.get("plugin_id", element_id)),
                    add=True,
                )
            assignments.append({
                "operation": "add",
                "component_kind": element.category,
                "component_id": element_id,
                "role_ids": [role_id],
            })
        for interface_id in sorted(new_interfaces - old_interfaces):
            interface = self.tool_interfaces[interface_id]
            role_id = select_role(
                description=interface.description,
                tags=interface.tags,
                category=interface.kind,
            )
            values = set(roles[role_id].get("tool_interface_ids", []))
            values.add(interface_id)
            roles[role_id]["tool_interface_ids"] = sorted(values)
            assignments.append({
                "operation": "add",
                "component_kind": "tool_interface",
                "component_id": interface_id,
                "role_ids": [role_id],
            })

        payload = circuit.executable_dict()
        payload["roles"] = [roles[role_id] for role_id in sorted(roles)]
        return AgentCircuit.from_dict(payload), assignments

    def propose_circuit(
        self,
        *,
        parent_id: str,
        transaction: CircuitMutationTransaction,
        epoch: int,
    ) -> HarnessProfile:
        """Apply one evidence-backed topology transaction to a frozen harness."""

        parent = self.get(parent_id)
        if not self.allow_mutation:
            return parent
        candidate_circuit = CircuitMutationEngine().apply(
            parent.effective_agent_circuit(), transaction
        )
        (
            circuit_modules,
            circuit_tool_interfaces,
            circuit_elements,
        ) = self._components_for_circuit(candidate_circuit, inherited_from=parent)
        profile = self._profile(
            parent_id=parent.harness_id,
            modules=circuit_modules,
            tool_interfaces=circuit_tool_interfaces,
            active_elements=circuit_elements,
            context_compiler=parent.context_compiler,
            recovery_policy=parent.recovery_policy,
            validation_policy=parent.validation_policy,
            generation=epoch,
            rationale=transaction.hypothesis,
            agent_circuit=candidate_circuit,
        )
        self._validate_profile(profile)
        self._write_profile(profile)
        root = self.root / "circuit_transactions"
        root.mkdir(parents=True, exist_ok=True)
        atomic_write_json(
            root / f"epoch_{epoch:03d}_{profile.harness_id}.json",
            {
                "schema_version": "agent-circuit-transaction-result.v1",
                "epoch": epoch,
                "parent_harness_id": parent.harness_id,
                "candidate_harness_id": profile.harness_id,
                "parent_circuit_id": parent.effective_agent_circuit().circuit_id,
                "candidate_circuit_id": candidate_circuit.circuit_id,
                "transaction": transaction.to_dict(),
                "pending_ablation_action_ids": [
                    action.action_id for action in transaction.actions
                ],
                "created_at": utc_now(),
            },
        )
        return profile

    def _components_for_circuit(
        self,
        circuit: AgentCircuit,
        *,
        inherited_from: HarnessProfile,
    ) -> tuple[
        tuple[str, ...],
        tuple[HarnessToolInterface, ...],
        tuple[HarnessActiveElement, ...],
    ]:
        """Resolve the audited union of independently selected role harnesses."""

        module_ids: set[str] = set()
        element_ids: set[str] = set()
        interface_ids: set[str] = set()
        plugin_ids: set[str] = set()
        for role in circuit.roles:
            interface_ids.update(role.tool_interface_ids)
            spec = role.harness_spec
            if spec is None:
                module_ids.update(inherited_from.active_modules)
                element_ids.update(
                    item.element_id for item in inherited_from.active_elements
                )
                plugin_ids.update(
                    str(item.spec.get("plugin_id", item.element_id))
                    for item in inherited_from.active_elements
                    if item.category == "dsh_plugin"
                )
                continue
            module_ids.update(spec.active_module_ids)
            element_ids.update(spec.active_element_ids)
            plugin_ids.update(spec.active_cordis_plugins)

        unknown_modules = sorted(module_ids - set(self.modules))
        unknown_elements = sorted(element_ids - set(self.elements))
        unknown_interfaces = sorted(interface_ids - set(self.tool_interfaces))
        plugin_elements: dict[str, HarnessElementConfig] = {}
        for element in self.elements.values():
            if element.category != "dsh_plugin":
                continue
            plugin_id = str(element.spec.get("plugin_id", element.element_id))
            if plugin_id in plugin_elements:
                raise ValueError(f"duplicate audited Cordis plugin id: {plugin_id}")
            plugin_elements[plugin_id] = element
        unknown_plugins = sorted(plugin_ids - set(plugin_elements))
        if unknown_modules or unknown_elements or unknown_interfaces or unknown_plugins:
            raise ValueError(
                "agent circuit references unaudited harness components: "
                f"modules={unknown_modules}, elements={unknown_elements}, "
                f"interfaces={unknown_interfaces}, plugins={unknown_plugins}"
            )
        element_ids.update(
            plugin_elements[plugin_id].element_id for plugin_id in plugin_ids
        )
        return (
            tuple(sorted(module_ids)),
            tuple(self.tool_interfaces[item] for item in sorted(interface_ids)),
            tuple(
                HarnessActiveElement.from_config(self.elements[item])
                for item in sorted(element_ids)
            ),
        )

    def _write_bundle_manifest(
        self,
        *,
        epoch: int,
        parent: HarnessProfile,
        candidate: HarnessProfile,
        gradient: HarnessSemanticGradient,
        actions: list[dict[str, Any]],
        mode: str = "bundle",
        bundle_id: str | None = None,
    ) -> None:
        root = self.root / "bundle_manifests"
        root.mkdir(parents=True, exist_ok=True)
        atomic_write_json(
            root / f"epoch_{epoch:03d}_{candidate.harness_id}.json",
            {
                "schema_version": "harness-bundle-attribution.v1",
                "epoch": epoch,
                "mode": mode,
                "bundle_id": bundle_id or candidate.harness_id,
                "parent_harness_id": parent.harness_id,
                "candidate_harness_id": candidate.harness_id,
                "attribution_mode": self.config.attribution_mode,
                "bundle_width_limit": self.config.bundle_width,
                "actions": actions,
                "evidence_refs": list(gradient.evidence_refs),
                "hypothesis": gradient.diagnosis,
                "created_at": utc_now(),
            },
        )

    @property
    def _bundle_attribution_path(self) -> Path:
        return self.root / "bundle_attribution.json"

    def _propose_pending_ablation(
        self,
        *,
        parent: HarnessProfile,
        gradient: HarnessSemanticGradient,
        epoch: int,
    ) -> HarnessProfile | None:
        if self.config.attribution_mode != "bundle_then_ablate":
            return None
        state = (
            read_json(self._bundle_attribution_path)
            if self._bundle_attribution_path.is_file()
            else {"schema_version": "harness-bundle-ablation.v1", "pending": []}
        )
        pending = list(state.get("pending", []))
        active_ids = {item.element_id for item in parent.active_elements}
        while pending and str(pending[0].get("element_id")) not in active_ids:
            pending.pop(0)
        if pending != list(state.get("pending", [])):
            state["pending"] = pending
            atomic_write_json(self._bundle_attribution_path, state)
        if not pending:
            return None
        item = pending[0]
        element_id = str(item["element_id"])
        removed = next(
            element for element in parent.active_elements if element.element_id == element_id
        )
        remaining_elements = tuple(
            element
            for element in parent.active_elements
            if element.element_id != element_id
        )
        candidate_circuit = parent.agent_circuit
        role_assignments: list[dict[str, Any]] = []
        candidate_modules = parent.active_modules
        candidate_interfaces = parent.active_tool_interfaces
        if candidate_circuit is not None:
            candidate_circuit, role_assignments = self._retarget_circuit_components(
                parent=parent,
                requested_modules=parent.active_modules,
                requested_tool_interfaces=parent.active_tool_interfaces,
                requested_elements=remaining_elements,
                gradient=gradient,
            )
            (
                candidate_modules,
                candidate_interfaces,
                remaining_elements,
            ) = self._components_for_circuit(
                candidate_circuit,
                inherited_from=parent,
            )
        candidate = self._profile(
            parent_id=parent.harness_id,
            modules=candidate_modules,
            tool_interfaces=candidate_interfaces,
            active_elements=remaining_elements,
            context_compiler=parent.context_compiler,
            recovery_policy=parent.recovery_policy,
            validation_policy=parent.validation_policy,
            generation=epoch,
            rationale=(
                f"leave-one-out ablation for bundle {item['bundle_id']}: "
                f"remove {element_id} and retain it only if quality regresses"
            ),
            agent_circuit=candidate_circuit,
        )
        self._write_profile(candidate)
        self._write_bundle_manifest(
            epoch=epoch,
            parent=parent,
            candidate=candidate,
            gradient=gradient,
            actions=[
                {
                    "category": removed.category,
                    "operation": "ablate",
                    "added_element_ids": [],
                    "removed_element_ids": [element_id],
                    "role_assignments": role_assignments,
                }
            ],
            mode="ablation",
            bundle_id=str(item["bundle_id"]),
        )
        return candidate

    def _record_bundle_attribution(self, result: HarnessEpochResult) -> None:
        if self.config.attribution_mode != "bundle_then_ablate":
            return
        validation = result.rubric_validation or {}
        if validation.get("infrastructure_ok") is not True or any(
            not outcome.infrastructure_ok
            for outcome in (*result.parent_outcomes, *result.candidate_outcomes)
        ):
            return
        manifest_path = (
            self.root
            / "bundle_manifests"
            / f"epoch_{result.epoch:03d}_{result.candidate_harness_id}.json"
        )
        if not manifest_path.is_file():
            return
        manifest = read_json(manifest_path)
        state = (
            read_json(self._bundle_attribution_path)
            if self._bundle_attribution_path.is_file()
            else {"schema_version": "harness-bundle-ablation.v1", "pending": []}
        )
        pending = list(state.get("pending", []))
        if manifest.get("mode") == "ablation":
            if pending and str(pending[0].get("bundle_id")) == str(
                manifest.get("bundle_id")
            ):
                pending.pop(0)
        elif result.accepted:
            added_ids = [
                str(element_id)
                for action in manifest.get("actions", [])
                for element_id in action.get("added_element_ids", [])
            ]
            if len(added_ids) > 1:
                existing = {
                    (str(item.get("bundle_id")), str(item.get("element_id")))
                    for item in pending
                }
                for element_id in added_ids:
                    key = (result.candidate_harness_id, element_id)
                    if key not in existing:
                        pending.append(
                            {
                                "bundle_id": result.candidate_harness_id,
                                "element_id": element_id,
                                "scheduled_by_epoch": result.epoch,
                            }
                        )
        state["pending"] = pending
        state["updated_at"] = utc_now()
        atomic_write_json(self._bundle_attribution_path, state)

    @staticmethod
    def _behavior_signature(profile: HarnessProfile) -> tuple[Any, ...]:
        circuit_behavior = profile.effective_agent_circuit().executable_dict()
        for role in circuit_behavior.get("roles", []):
            harness_spec = role.get("harness_spec")
            if isinstance(harness_spec, dict):
                harness_spec.pop("source_harness_id", None)
        return (
            profile.active_modules,
            tuple(
                (item.interface_id, item.kind, item.description, item.command, item.source_hash)
                for item in profile.active_tool_interfaces
            ),
            tuple(
                (item.element_id, item.category, item.description, item.spec_hash)
                for item in profile.active_elements
            ),
            profile.context_compiler.to_dict().__repr__(),
            profile.recovery_policy.to_dict().__repr__(),
            profile.validation_policy.to_dict().__repr__(),
            circuit_behavior.__repr__(),
        )

    def _mutate_modules(
        self,
        active: list[str],
        gradient: HarnessSemanticGradient,
        *,
        max_active: int | None = None,
    ) -> list[str]:
        capacity = self.config.max_active_modules if max_active is None else max_active
        for _ in range(self.config.mutation_width):
            inactive = [module for module in self.config.modules if module.module_id not in active]
            if not inactive:
                break
            addition = max(
                inactive,
                key=lambda module: self._module_score(module, gradient, active=False),
            )
            if len(active) < capacity:
                active.append(addition.module_id)
            else:
                removal = min(
                    (self.modules[module_id] for module_id in active),
                    key=lambda module: self._module_score(module, gradient, active=True),
                )
                active[active.index(removal.module_id)] = addition.module_id
        return active

    def record_element_stats(self, *, profile: HarnessProfile, result: HarnessEpochResult) -> None:
        self.record_element_usage(profile=profile, success=result.accepted)

    def record_element_usage(self, *, profile: HarnessProfile, success: bool) -> None:
        if not self.config.enable_usage_driven_mutation or not profile.active_elements:
            return
        from game_loop.core.harness_element_stats import HarnessElementStatsStore

        stats = HarnessElementStatsStore.load(self.root / "element_stats.json")
        for element in profile.active_elements:
            stats.touch(
                category=element.category,
                element_id=element.element_id,
                success=success,
            )
        stats.save(self.root / "element_stats.json")

    def render(self, profile: HarnessProfile) -> str:
        if (
            not profile.active_modules
            and not profile.active_tool_interfaces
            and not profile.active_elements
        ):
            return ""
        if profile.agent_circuit is not None:
            return "\n".join(
                [
                    "Agent Circuit harness profile (fixed for this complete evolution episode):",
                    f"- Circuit: {profile.agent_circuit.circuit_id}",
                    f"- Roles: {len(profile.agent_circuit.roles)}",
                    "Each role receives only its content-addressed role-local harness manifest at runtime.",
                    "The circuit harness may change how roles work, but it does not change the evaluator, rubric, hidden tests, or task requirements.",
                    "Do not edit benchmark infrastructure or encode evaluator-specific shortcuts.",
                ]
            )
        lines = ["Agent harness profile (fixed for this complete evolution episode):"]
        for module_id in profile.active_modules:
            lines.append(f"- [module:{module_id}] {self.modules[module_id].instruction}")
        if profile.active_elements:
            lines.append("Active managed elements by category:")
            for element in sorted(
                profile.active_elements,
                key=lambda item: (item.category, item.element_id),
            ):
                lines.append(
                    f"- [{element.category}:{element.element_id}] {element.description}"
                )
        if profile.active_tool_interfaces:
            lines.append("Harness-owned tool interfaces available in this episode:")
            for interface in profile.active_tool_interfaces:
                command = " ".join(interface.command) if interface.command else "(configured externally)"
                lines.append(
                    f"- [{interface.interface_id}] {interface.kind}: {interface.description} "
                    f"(scope={interface.safety_scope}, source_hash={interface.source_hash}, command={command})"
                )
        lines.extend([
            "The harness may change how you work, but it does not change the evaluator, rubric, hidden tests, or task requirements.",
            "Harness-owned tools may inspect or transform only the scopes declared in their interface specs.",
            "Do not edit benchmark infrastructure or encode evaluator-specific shortcuts.",
        ])
        return "\n".join(lines)

    def assess_epoch(
        self,
        *,
        epoch: int,
        parent: HarnessProfile,
        candidate: HarnessProfile,
        parent_outcomes: Sequence[HarnessEpisodeOutcome],
        candidate_outcomes: Sequence[HarnessEpisodeOutcome],
        rubric_validation: dict[str, Any] | None = None,
        net_utility_admission: bool = False,
    ) -> HarnessEpochResult:
        parents = {item.case_id: item for item in parent_outcomes}
        candidates = {item.case_id: item for item in candidate_outcomes}
        reasons: list[str] = []
        excluded_pairs: list[str] = []
        if set(parents) != set(candidates):
            reasons.append("paired replay case sets differ")
        deltas: list[float] = []
        for case_id in sorted(set(parents) & set(candidates)):
            old = parents[case_id]
            new = candidates[case_id]
            if old.harness_id != parent.harness_id or new.harness_id != candidate.harness_id:
                reasons.append(f"{case_id}: outcome harness identity mismatch")
                continue
            if not old.infrastructure_ok or not new.infrastructure_ok:
                excluded_pairs.append(
                    f"{case_id}: infrastructure failure; pair is not quality evidence"
                )
                continue
            old_budget = (
                old.model_calls
                if old.allocated_model_calls is None
                else old.allocated_model_calls,
                old.evaluator_queries
                if old.allocated_evaluator_queries is None
                else old.allocated_evaluator_queries,
                old.allocated_probe_calls,
            )
            new_budget = (
                new.model_calls
                if new.allocated_model_calls is None
                else new.allocated_model_calls,
                new.evaluator_queries
                if new.allocated_evaluator_queries is None
                else new.allocated_evaluator_queries,
                new.allocated_probe_calls,
            )
            if old_budget != new_budget:
                reasons.append(f"{case_id}: paired budgets differ")
                continue
            if not old.feasible or not new.feasible:
                reasons.append(f"{case_id}: infeasible replay outcome")
                continue
            if old.final_score is None or new.final_score is None:
                reasons.append(f"{case_id}: missing final benchmark score")
                continue
            deltas.append(new.final_score - old.final_score)
        median_delta = median(deltas) if deltas else None
        if len(deltas) < self.config.replay_min_cases:
            reasons.append(
                f"usable replay pairs {len(deltas)} < required {self.config.replay_min_cases}"
            )
        if deltas and any(
            delta < -self.config.max_case_regression for delta in deltas
        ):
            worst = min(deltas)
            reasons.append(
                f"worst case regression {worst:.4f} exceeds "
                f"{-self.config.max_case_regression:.4f}"
            )
        if (
            median_delta is not None
            and not net_utility_admission
            and median_delta + 1e-12 < self.config.promotion_delta_min
        ):
            reasons.append(
                f"median delta {median_delta:.4f} is below promotion minimum "
                f"{self.config.promotion_delta_min:.4f}"
            )
        if self.config.require_rubric_validation and rubric_validation is None:
            reasons.append("required rubric validation is missing")
        elif rubric_validation is not None and rubric_validation.get("accepted") is not True:
            validation_reasons = rubric_validation.get("reasons", [])
            reasons.extend(str(item) for item in validation_reasons)
            if not validation_reasons:
                reasons.append("rubric validation did not explicitly accept")
        accepted = not reasons
        return HarnessEpochResult(
            epoch=epoch,
            parent_harness_id=parent.harness_id,
            candidate_harness_id=candidate.harness_id,
            accepted=accepted,
            paired_deltas=tuple(deltas),
            median_delta=median_delta,
            reasons=tuple(reasons),
            excluded_pairs=tuple(excluded_pairs),
            parent_outcomes=tuple(parent_outcomes),
            candidate_outcomes=tuple(candidate_outcomes),
            created_at=utc_now(),
            rubric_validation=rubric_validation,
        )

    def record_epoch(self, result: HarnessEpochResult) -> None:
        path = self.root / "epochs.json"
        value = read_json(path)
        value.setdefault("items", []).append(result.to_dict())
        atomic_write_json(path, value)
        if result.accepted:
            atomic_write_json(self.root / "champion.json", {
                "harness_id": result.candidate_harness_id,
                "updated_at": utc_now(),
                "promoted_by_epoch": result.epoch,
            })
        self._record_bundle_attribution(result)
        try:
            candidate = self.get(result.candidate_harness_id)
            should_record = True
            if isinstance(result.rubric_validation, dict):
                should_record = bool(
                    result.rubric_validation.get("record_element_stats", True)
                )
            if should_record:
                self.record_element_stats(profile=candidate, result=result)
        except (ValueError, KeyError):
            pass

    def _module_score(
        self,
        module: HarnessModuleConfig,
        gradient: HarnessSemanticGradient,
        *,
        active: bool,
    ) -> tuple[float, str]:
        wanted = {item.casefold() for item in gradient.target_tags}
        tags = {tag.casefold() for tag in module.tags}
        affinity = 2.0 * len(wanted & tags)
        novelty = 1.0 if not active else 0.0
        return affinity + novelty, module.module_id

    def _profile(
        self,
        *,
        parent_id: str | None,
        modules: Sequence[str],
        tool_interfaces: Sequence[HarnessToolInterface],
        active_elements: Sequence[HarnessActiveElement] = (),
        context_compiler: ContextCompilerPolicy,
        recovery_policy: RecoveryPolicy,
        validation_policy: ValidationPolicy,
        generation: int,
        rationale: str,
        agent_circuit: AgentCircuit | None = None,
    ) -> HarnessProfile:
        active = tuple(sorted(dict.fromkeys(modules)))
        active_tool_interfaces = tuple(
            sorted(tool_interfaces, key=lambda item: item.interface_id)
        )
        elements = tuple(
            sorted(active_elements, key=lambda item: (item.category, item.element_id))
        )
        identity = self._profile_identity(
            parent_id,
            active,
            active_tool_interfaces,
            elements,
            context_compiler,
            recovery_policy,
            validation_policy,
            generation,
            agent_circuit,
        )
        return HarnessProfile(
            harness_id="harness-" + sha256_json(identity)[:24],
            parent_harness_id=parent_id,
            active_modules=active,
            active_tool_interfaces=active_tool_interfaces,
            active_elements=elements,
            context_compiler=context_compiler,
            recovery_policy=recovery_policy,
            validation_policy=validation_policy,
            generation=generation,
            rationale=rationale,
            created_at=utc_now(),
            agent_circuit=agent_circuit,
        )

    def _validate_profile(self, profile: HarnessProfile) -> None:
        unknown = sorted(set(profile.active_modules) - set(self.modules))
        if unknown:
            raise ValueError(f"harness profile references unknown modules: {unknown}")
        unknown_elements = sorted(
            {item.element_id for item in profile.active_elements} - set(self.elements)
        )
        if unknown_elements:
            raise ValueError(
                f"harness profile references unknown elements: {unknown_elements}"
            )
        if (
            profile.agent_circuit is None
            and len(profile.active_modules) > self.config.max_active_modules
        ):
            raise ValueError("harness profile exceeds max_active_modules")
        if (
            profile.agent_circuit is None
            and len(profile.active_tool_interfaces) > self.config.max_active_tool_interfaces
        ):
            raise ValueError("harness profile exceeds max_active_tool_interfaces")
        counts: dict[str, int] = {}
        for element in profile.active_elements:
            counts[element.category] = counts.get(element.category, 0) + 1
            if element.category in self.managed_element_categories:
                continue
            limit = self.config.max_active_elements.get(element.category)
            if profile.agent_circuit is None and limit and counts[element.category] > limit:
                raise ValueError(
                    f"harness profile exceeds max_active_elements for {element.category}"
                )
        self._validate_tool_interfaces(profile.active_tool_interfaces)
        if profile.agent_circuit is not None:
            available_interfaces = {
                item.interface_id for item in profile.active_tool_interfaces
            }
            referenced_interfaces = {
                interface_id
                for role in profile.agent_circuit.roles
                for interface_id in role.tool_interface_ids
            }
            unknown_circuit_interfaces = sorted(
                referenced_interfaces - available_interfaces
            )
            if unknown_circuit_interfaces:
                raise ValueError(
                    "agent circuit references inactive tool interfaces: "
                    f"{unknown_circuit_interfaces}"
                )
            available_modules = set(profile.active_modules)
            available_elements = {
                item.element_id for item in profile.active_elements
            }
            available_plugins = {
                str(item.spec.get("plugin_id", item.element_id))
                for item in profile.active_elements
                if item.category == "dsh_plugin"
            }
            for role in profile.agent_circuit.roles:
                spec = role.harness_spec
                role_module_ids = (
                    available_modules if spec is None else set(spec.active_module_ids)
                )
                role_element_ids = (
                    available_elements if spec is None else set(spec.active_element_ids)
                )
                role_plugin_ids = (
                    available_plugins if spec is None else set(spec.active_cordis_plugins)
                )
                if len(role_module_ids) > self.config.max_active_modules:
                    raise ValueError(
                        f"role {role.role_id} exceeds max_active_modules"
                    )
                if len(role.tool_interface_ids) > self.config.max_active_tool_interfaces:
                    raise ValueError(
                        f"role {role.role_id} exceeds max_active_tool_interfaces"
                    )
                role_category_counts: dict[str, int] = {}
                selected_element_ids = set(role_element_ids)
                selected_element_ids.update(
                    item.element_id
                    for item in profile.active_elements
                    if item.category == "dsh_plugin"
                    and str(item.spec.get("plugin_id", item.element_id))
                    in role_plugin_ids
                )
                for element in profile.active_elements:
                    if element.element_id not in selected_element_ids:
                        continue
                    count = role_category_counts.get(element.category, 0) + 1
                    role_category_counts[element.category] = count
                    if element.category in self.managed_element_categories:
                        continue
                    limit = self.config.max_active_elements.get(element.category)
                    if limit and count > limit:
                        raise ValueError(
                            f"role {role.role_id} exceeds max_active_elements "
                            f"for {element.category}"
                        )
                unknown_modules = role_module_ids - available_modules
                unknown_elements = role_element_ids - available_elements
                unknown_plugins = role_plugin_ids - available_plugins
                if unknown_modules or unknown_elements or unknown_plugins:
                    raise ValueError(
                        f"role {role.role_id} harness references inactive components: "
                        f"modules={sorted(unknown_modules)}, "
                        f"elements={sorted(unknown_elements)}, "
                        f"plugins={sorted(unknown_plugins)}"
                    )
        expected_id = "harness-" + sha256_json(self._profile_identity(
            profile.parent_harness_id,
            profile.active_modules,
            profile.active_tool_interfaces,
            profile.active_elements,
            profile.context_compiler,
            profile.recovery_policy,
            profile.validation_policy,
            profile.generation,
            profile.agent_circuit,
        ))[:24]
        if profile.harness_id != expected_id:
            raise ValueError("harness profile content does not match its harness_id")

    def _profile_identity(
        self,
        parent_id: str | None,
        modules: Sequence[str],
        tool_interfaces: Sequence[HarnessToolInterface],
        active_elements: Sequence[HarnessActiveElement],
        context_compiler: ContextCompilerPolicy,
        recovery_policy: RecoveryPolicy,
        validation_policy: ValidationPolicy,
        generation: int,
        agent_circuit: AgentCircuit | None = None,
    ) -> dict[str, Any]:
        identity = {
            "policy_version": self.policy_version,
            "parent_harness_id": parent_id,
            "active_modules": tuple(sorted(dict.fromkeys(modules))),
            "active_tool_interfaces": [
                item.to_dict()
                for item in sorted(tool_interfaces, key=lambda value: value.interface_id)
            ],
            "active_elements": [
                item.to_dict()
                for item in sorted(
                    active_elements, key=lambda value: (value.category, value.element_id)
                )
            ],
            "context_compiler": context_compiler.to_dict(),
            "recovery_policy": recovery_policy.to_dict(),
            "validation_policy": validation_policy.to_dict(),
            "generation": generation,
        }
        # Omitting the field for legacy singleton profiles preserves every v0.2
        # harness ID while explicit v0.3 circuits become content addressed.
        if agent_circuit is not None:
            identity["agent_circuit"] = agent_circuit.executable_dict()
        return identity

    def _seed_tool_interfaces(self) -> tuple[HarnessToolInterface, ...]:
        return tuple(
            self.tool_interfaces[interface_id]
            for interface_id in self.config.seed_tool_interfaces
        )

    def _seed_elements(self) -> tuple[HarnessActiveElement, ...]:
        seeded: dict[str, HarnessActiveElement] = {}
        for category, element_ids in self.config.seed_elements.items():
            for element_id in element_ids:
                seeded[element_id] = HarnessActiveElement.from_config(
                    self.elements[element_id]
                )
        for category, element_ids in self._live_managed_element_ids.items():
            for element_id in element_ids:
                seeded[element_id] = HarnessActiveElement.from_config(
                    self.elements[element_id]
                )
        return tuple(
            sorted(seeded.values(), key=lambda item: (item.category, item.element_id))
        )

    def _extended_catalog_path(self) -> Path:
        return self.root / "element_catalog_extensions.json"

    def _load_extended_element_catalog(self) -> None:
        path = self._extended_catalog_path()
        if not path.is_file():
            return
        from game_loop.config import HarnessElementConfig

        raw = read_json(path)
        for item in raw.get("items", []):
            spec = HarnessElementConfig.from_dict(dict(item))
            self.elements[spec.element_id] = spec

    def register_element(self, spec) -> None:
        from game_loop.config import HarnessElementConfig

        if not isinstance(spec, HarnessElementConfig):
            raise TypeError("register_element expects HarnessElementConfig")
        if not self.category_is_mutable(spec.category):
            raise ValueError(
                f"harness element category {spec.category!r} is frozen by this ablation"
            )
        if spec.element_id in self.elements:
            return
        self.elements[spec.element_id] = spec
        path = self._extended_catalog_path()
        payload = {"schema_version": "harness-element-extensions.v1", "items": []}
        if path.is_file():
            payload = read_json(path)
        items = list(payload.get("items", []))
        items.append(
            {
                "id": spec.element_id,
                "category": spec.category,
                "description": spec.description,
                "spec": dict(spec.spec),
                "tags": list(spec.tags),
            }
        )
        atomic_write_json(path, {
            "schema_version": "harness-element-extensions.v1",
            "updated_at": utc_now(),
            "items": items,
        })

    def upsert_element(self, spec) -> None:
        """Persist a validated HPA library element without losing old profiles."""

        from game_loop.config import HarnessElementConfig

        if not isinstance(spec, HarnessElementConfig):
            raise TypeError("upsert_element expects HarnessElementConfig")
        if (
            not self.category_is_mutable(spec.category)
            and spec.category not in self.managed_element_categories
        ):
            raise ValueError(
                f"harness element category {spec.category!r} is frozen by this ablation"
            )
        self.elements[spec.element_id] = spec
        path = self._extended_catalog_path()
        payload = {"schema_version": "harness-element-extensions.v1", "items": []}
        if path.is_file():
            payload = read_json(path)
        item = {
            "id": spec.element_id,
            "category": spec.category,
            "description": spec.description,
            "spec": dict(spec.spec),
            "tags": list(spec.tags),
        }
        items = [
            existing
            for existing in payload.get("items", [])
            if str(existing.get("id", "")) != spec.element_id
        ]
        items.append(item)
        atomic_write_json(path, {
            "schema_version": "harness-element-extensions.v1",
            "updated_at": utc_now(),
            "items": items,
        })

    def sync_element_library(self, category: str, specs) -> None:
        """Mirror an external live catalog while frozen profiles stay self-contained."""

        from game_loop.config import HarnessElementConfig

        desired: dict[str, HarnessElementConfig] = {}
        for spec in specs:
            if not isinstance(spec, HarnessElementConfig):
                raise TypeError("sync_element_library expects HarnessElementConfig rows")
            if spec.category != category:
                raise ValueError(
                    f"cannot sync {spec.category!r} element into {category!r} library"
                )
            desired[spec.element_id] = spec
        if category in self.managed_element_categories:
            # Retain superseded definitions so frozen content-addressed profiles
            # remain replayable. Only the live id set is automatically mounted.
            self._live_managed_element_ids[category] = frozenset(desired)
        else:
            self.elements = {
                element_id: spec
                for element_id, spec in self.elements.items()
                if spec.category != category or element_id in desired
            }
        for spec in desired.values():
            self.upsert_element(spec)
        if category in self.managed_element_categories:
            self._refresh_managed_champion(category)

    def _refresh_managed_champion(self, category: str) -> None:
        archive_paths = (
            self.root / "manifest.json",
            self.root / "epochs.json",
            self.root / "champion.json",
        )
        if not all(path.is_file() for path in archive_paths):
            return
        champion = self.champion()
        live_ids = self._live_managed_element_ids.get(category, frozenset())
        active = [
            element
            for element in champion.active_elements
            if element.category != category
        ]
        active.extend(
            HarnessActiveElement.from_config(self.elements[element_id])
            for element_id in sorted(live_ids)
        )
        normalized = tuple(
            sorted(active, key=lambda item: (item.category, item.element_id))
        )
        if normalized == champion.active_elements:
            return
        refreshed = self._profile(
            parent_id=champion.harness_id,
            modules=champion.active_modules,
            tool_interfaces=champion.active_tool_interfaces,
            active_elements=normalized,
            context_compiler=champion.context_compiler,
            recovery_policy=champion.recovery_policy,
            validation_policy=champion.validation_policy,
            generation=champion.generation + 1,
            rationale=f"HPA live {category} library synchronization",
            agent_circuit=champion.agent_circuit,
        )
        self._write_profile(refreshed)
        atomic_write_json(self.root / "champion.json", {
            "harness_id": refreshed.harness_id,
            "updated_at": utc_now(),
            "managed_library_sync": category,
        })

    def _targets_tool_interface(self, gradient: HarnessSemanticGradient) -> bool:
        tags = {tag.casefold() for tag in gradient.target_tags}
        return bool(tags & {
            "tool_interface", "engine_tooling", "godot_mcp", "mcp",
            "mcp_server", "command_wrapper", "engine_probe",
        })

    def _mutate_tool_interfaces(
        self,
        active: list[HarnessToolInterface],
        gradient: HarnessSemanticGradient,
        *,
        max_active: int | None = None,
    ) -> list[HarnessToolInterface]:
        active_ids = {item.interface_id for item in active}
        inactive = [
            interface for interface in self.tool_interfaces.values()
            if interface.interface_id not in active_ids
        ]
        if not inactive:
            return active
        addition = max(
            inactive,
            key=lambda interface: self._tool_interface_score(
                interface, gradient, active=False
            ),
        )
        capacity = (
            self.config.max_active_tool_interfaces
            if max_active is None
            else max_active
        )
        if len(active) < capacity:
            return [*active, addition]
        if not active:
            return [addition]
        removal = min(
            active,
            key=lambda interface: self._tool_interface_score(
                interface, gradient, active=True
            ),
        )
        return [
            addition if item.interface_id == removal.interface_id else item
            for item in active
        ]

    def _tool_interface_score(
        self,
        interface: HarnessToolInterface,
        gradient: HarnessSemanticGradient,
        *,
        active: bool,
    ) -> tuple[float, str]:
        wanted = {item.casefold() for item in gradient.target_tags}
        tags = {tag.casefold() for tag in interface.tags}
        affinity = 2.0 * len(wanted & tags)
        novelty = 1.0 if not active else 0.0
        return affinity + novelty, interface.interface_id

    def _validate_tool_interfaces(
        self,
        interfaces: Sequence[HarnessToolInterface],
    ) -> None:
        seen: set[str] = set()
        for interface in interfaces:
            if interface.interface_id in seen:
                raise ValueError("harness profile contains duplicate tool interfaces")
            seen.add(interface.interface_id)
            if interface.safety_scope not in {
                "candidate_workspace_only",
                "task_and_candidate_readonly",
                "engine_runtime_only",
            }:
                raise ValueError(
                    f"harness tool interface {interface.interface_id} has unsafe scope"
                )
            expected_hash = HarnessToolInterface.compute_source_hash(
                interface.to_dict()
            )
            if interface.source_hash != expected_hash:
                raise ValueError(
                    f"harness tool interface {interface.interface_id} source_hash mismatch"
                )

    def _targets_context(self, gradient: HarnessSemanticGradient) -> bool:
        tags = {tag.casefold() for tag in gradient.target_tags}
        return bool(tags & {
            "context", "context_history", "diagnostics", "failure_memory",
            "history_noise", "probe_context",
        })

    def _mutate_context(
        self,
        policy: ContextCompilerPolicy,
        gradient: HarnessSemanticGradient,
    ) -> ContextCompilerPolicy:
        tags = {tag.casefold() for tag in gradient.target_tags}
        value = policy.to_dict()
        if "history_noise" in tags:
            value["history_window"] = max(1, policy.history_window - 2)
        elif "context_history" in tags or "failure_memory" in tags:
            value["history_window"] = min(20, policy.history_window + 2)
            value["include_rejected_attempts"] = True
        elif "diagnostics" in tags:
            value["diagnostics_limit"] = min(20, policy.diagnostics_limit + 2)
            value["reasons_limit"] = min(20, policy.reasons_limit + 1)
        elif "probe_context" in tags:
            value["include_probe_summaries"] = not policy.include_probe_summaries
        else:
            value["history_window"] = min(20, policy.history_window + 1)
        return ContextCompilerPolicy.from_dict(value)

    def _targets_recovery(self, gradient: HarnessSemanticGradient) -> bool:
        tags = {tag.casefold() for tag in gradient.target_tags}
        return bool(tags & {"recovery", "infra_recovery", "infrastructure"})

    def _mutate_recovery(
        self,
        policy: RecoveryPolicy,
        gradient: HarnessSemanticGradient,
    ) -> RecoveryPolicy:
        del gradient
        return RecoveryPolicy(
            infrastructure_retries=(policy.infrastructure_retries + 1) % 3,
        )

    def _targets_validation(self, gradient: HarnessSemanticGradient) -> bool:
        tags = {tag.casefold() for tag in gradient.target_tags}
        return bool(tags & {"validation", "gate_repair", "probe_repair"})

    def _mutate_validation(
        self,
        policy: ValidationPolicy,
        gradient: HarnessSemanticGradient,
    ) -> ValidationPolicy:
        tags = {tag.casefold() for tag in gradient.target_tags}
        return ValidationPolicy(
            repair_attempts=(policy.repair_attempts + 1) % 3,
            repair_on_gate_failure=(
                policy.repair_on_gate_failure if "probe_repair" in tags else True
            ),
            repair_on_probe_failure=(
                policy.repair_on_probe_failure if "gate_repair" in tags else True
            ),
        )

    def _write_profile(self, profile: HarnessProfile) -> None:
        self._validate_profile(profile)
        path = self.profiles / f"{profile.harness_id}.json"
        if not path.exists():
            atomic_write_json(path, profile.to_dict())


class HarnessOuterLoop:
    """Runs old/new harnesses on matched benchmark episodes."""

    def __init__(self, engine: HarnessEvolutionEngine, runner: HarnessReplayRunner):
        self.engine = engine
        self.runner = runner

    def run_epoch(
        self,
        *,
        epoch: int,
        cases: Sequence[HarnessReplayCase],
        gradient: HarnessSemanticGradient,
    ) -> HarnessEpochResult:
        parent = self.engine.champion()
        candidate = self.engine.propose(
            parent_id=parent.harness_id,
            gradient=gradient,
            epoch=epoch,
        )
        parent_outcomes = [
            self.runner.run_episode(case, parent, side="parent", epoch=epoch)
            for case in cases
        ]
        candidate_outcomes = [
            self.runner.run_episode(case, candidate, side="candidate", epoch=epoch)
            for case in cases
        ]
        result = self.engine.assess_epoch(
            epoch=epoch,
            parent=parent,
            candidate=candidate,
            parent_outcomes=parent_outcomes,
            candidate_outcomes=candidate_outcomes,
        )
        self.engine.record_epoch(result)
        return result


def load_episode_outcome(
    *,
    case_id: str,
    harness_id: str,
    run_dir: Path,
) -> HarnessEpisodeOutcome:
    """Normalize a persisted game-loop run for an outer paired replay."""

    state = read_json(run_dir / "state.json")
    manifest = read_json(run_dir / "manifest.json")
    recorded_harness = state.get("champion_harness_id")
    if recorded_harness != harness_id:
        raise ValueError(
            f"episode harness mismatch: expected {harness_id}, found {recorded_harness}"
        )
    if not manifest.get("harness_frozen_within_episode"):
        raise ValueError("run does not prove that its harness was frozen within the episode")
    evaluation = dict(state.get("champion_evaluation", {}))
    status = str(state.get("status", ""))
    evaluator = evaluation.get("evaluator", {})
    evaluator_infrastructure_failure = (
        isinstance(evaluator, dict)
        and bool(evaluator.get("infrastructure_failure", False))
    )
    attempts = state.get("attempts", [])
    latest_attempt_infrastructure_failure = bool(
        isinstance(attempts, list)
        and attempts
        and isinstance(attempts[-1], dict)
        and attempts[-1].get("status") == "infra_failed"
    )
    infrastructure_ok = (
        status != "paused_infrastructure"
        and not evaluator_infrastructure_failure
        and not latest_attempt_infrastructure_failure
    )
    budgets = dict(manifest.get("budgets", {}))
    return HarnessEpisodeOutcome(
        case_id=case_id,
        harness_id=harness_id,
        final_score=(
            None
            if evaluation.get("primary_score") is None
            else float(evaluation["primary_score"])
        ),
        feasible=bool(evaluation.get("feasible", False)),
        model_calls=int(state.get("model_calls", 0)),
        evaluator_queries=int(state.get("evaluator_queries", 0)),
        infrastructure_ok=infrastructure_ok,
        run_ref=str(run_dir.resolve()),
        allocated_model_calls=(
            None if budgets.get("model_calls") is None else int(budgets["model_calls"])
        ),
        allocated_evaluator_queries=(
            None
            if budgets.get("evaluator_queries") is None
            else int(budgets["evaluator_queries"])
        ),
        allocated_probe_calls=(
            None if budgets.get("probe_calls") is None else int(budgets["probe_calls"])
        ),
    )
