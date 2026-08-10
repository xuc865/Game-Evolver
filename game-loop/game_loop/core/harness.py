from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from statistics import median
from typing import Any, Protocol, Sequence

from game_loop.config import (
    HarnessElementConfig,
    HarnessEvolutionConfig,
    HarnessModuleConfig,
    HarnessToolInterfaceConfig,
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
    ):
        self.root = run_dir / "harness_archive"
        self.profiles = self.root / "profiles"
        self.config = config
        self.allow_mutation = allow_mutation
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

    def initialize(self, initial_profile: HarnessProfile | None = None) -> HarnessProfile:
        self.profiles.mkdir(parents=True, exist_ok=True)
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
            "mutation_width": self.config.mutation_width,
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
        active = list(parent.active_modules)
        active_tool_interfaces = list(parent.active_tool_interfaces)
        active_elements = list(parent.active_elements)
        context_compiler = parent.context_compiler
        recovery_policy = parent.recovery_policy
        validation_policy = parent.validation_policy
        from game_loop.core.harness_element_stats import (
            HarnessElementStatsStore,
            mutate_category_elements,
            resolve_target_category,
        )

        target_category = resolve_target_category(gradient.target_tags)
        if (
            target_category
            and self.config.element_catalog
            and self.config.enable_usage_driven_mutation
        ):
            stats = HarnessElementStatsStore.load(self.root / "element_stats.json")
            mutation = mutate_category_elements(
                active=active_elements,
                category=target_category,
                catalog=self.elements,
                stats=stats,
                limits=self.config.max_active_elements,
                gradient_tags=gradient.target_tags,
                policy=self.config.element_mutation_policy,
            )
            if mutation is not None:
                active_elements = mutation.active
                for addition in mutation.catalog_additions:
                    self.register_element(addition)
                stats.save(self.root / "element_stats.json")
        elif self._targets_tool_interface(gradient):
            active_tool_interfaces = self._mutate_tool_interfaces(
                active_tool_interfaces, gradient
            )
        elif self._targets_context(gradient):
            context_compiler = self._mutate_context(context_compiler, gradient)
        elif self._targets_recovery(gradient):
            recovery_policy = self._mutate_recovery(recovery_policy, gradient)
        elif self._targets_validation(gradient):
            validation_policy = self._mutate_validation(validation_policy, gradient)
        else:
            active = self._mutate_modules(active, gradient)
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
        )
        self._write_profile(profile)
        return profile

    def _mutate_modules(
        self,
        active: list[str],
        gradient: HarnessSemanticGradient,
    ) -> list[str]:
        for _ in range(self.config.mutation_width):
            inactive = [module for module in self.config.modules if module.module_id not in active]
            if not inactive:
                break
            addition = max(
                inactive,
                key=lambda module: self._module_score(module, gradient, active=False),
            )
            if len(active) < self.config.max_active_modules:
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
        if rubric_validation is not None and not rubric_validation.get("accepted", True):
            reasons.extend(str(item) for item in rubric_validation.get("reasons", []))
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
        if len(profile.active_modules) > self.config.max_active_modules:
            raise ValueError("harness profile exceeds max_active_modules")
        if len(profile.active_tool_interfaces) > self.config.max_active_tool_interfaces:
            raise ValueError("harness profile exceeds max_active_tool_interfaces")
        counts: dict[str, int] = {}
        for element in profile.active_elements:
            counts[element.category] = counts.get(element.category, 0) + 1
            limit = self.config.max_active_elements.get(element.category)
            if limit and counts[element.category] > limit:
                raise ValueError(
                    f"harness profile exceeds max_active_elements for {element.category}"
                )
        self._validate_tool_interfaces(profile.active_tool_interfaces)
        expected_id = "harness-" + sha256_json(self._profile_identity(
            profile.parent_harness_id,
            profile.active_modules,
            profile.active_tool_interfaces,
            profile.active_elements,
            profile.context_compiler,
            profile.recovery_policy,
            profile.validation_policy,
            profile.generation,
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
    ) -> dict[str, Any]:
        return {
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

    def _seed_tool_interfaces(self) -> tuple[HarnessToolInterface, ...]:
        return tuple(
            self.tool_interfaces[interface_id]
            for interface_id in self.config.seed_tool_interfaces
        )

    def _seed_elements(self) -> tuple[HarnessActiveElement, ...]:
        seeded: list[HarnessActiveElement] = []
        for category, element_ids in self.config.seed_elements.items():
            for element_id in element_ids:
                seeded.append(HarnessActiveElement.from_config(self.elements[element_id]))
        return tuple(sorted(seeded, key=lambda item: (item.category, item.element_id)))

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
        if len(active) < self.config.max_active_tool_interfaces:
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
    infrastructure_ok = (
        status != "paused_infrastructure" and not evaluator_infrastructure_failure
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
