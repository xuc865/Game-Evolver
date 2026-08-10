from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .utils import sha256_json


@dataclass(frozen=True)
class BenchmarkConfig:
    adapter: str
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class BackendConfig:
    command: tuple[str, ...]
    cwd: Path
    timeout_seconds: int = 10800
    env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "BackendConfig":
        command = value.get("command")
        if not isinstance(command, list) or not command or not all(isinstance(v, str) for v in command):
            raise ValueError("backend.command must be a non-empty argv list")
        cwd = Path(str(value.get("cwd", "."))).expanduser().resolve()
        if not cwd.is_dir():
            raise ValueError(f"backend.cwd does not exist: {cwd}")
        return cls(
            command=tuple(command),
            cwd=cwd,
            timeout_seconds=int(value.get("timeout_seconds", 10800)),
            env={str(k): str(v) for k, v in value.get("env", {}).items()},
        )


@dataclass(frozen=True)
class EvolutionConfig:
    max_generations: int = 3
    candidates_per_generation: int = 2
    delta_min: float = 0.0
    objective_regression_epsilon: float = 0.08
    stop_after_rejections: int = 6
    feedback_disclosure: str = "OBJECTIVES"
    stop_on_terminal_success: bool = True
    max_model_calls: int | None = None
    max_evaluator_queries: int | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "EvolutionConfig":
        disclosure = str(
            value.get("feedback_disclosure", "OBJECTIVES")
        ).upper()
        result = cls(
            max_generations=int(value.get("max_generations", 3)),
            candidates_per_generation=int(value.get("candidates_per_generation", 2)),
            delta_min=float(value.get("delta_min", 0.0)),
            objective_regression_epsilon=float(value.get("objective_regression_epsilon", 0.08)),
            stop_after_rejections=int(value.get("stop_after_rejections", 6)),
            feedback_disclosure=disclosure,
            stop_on_terminal_success=bool(value.get("stop_on_terminal_success", True)),
            max_model_calls=(
                None if value.get("max_model_calls") is None else int(value["max_model_calls"])
            ),
            max_evaluator_queries=(
                None
                if value.get("max_evaluator_queries") is None
                else int(value["max_evaluator_queries"])
            ),
        )
        if result.max_generations < 0 or result.candidates_per_generation < 1:
            raise ValueError("generation budget must be >= 0 and candidate budget must be >= 1")
        if result.stop_after_rejections < 1:
            raise ValueError("stop_after_rejections must be >= 1")
        if result.max_model_calls is not None and result.max_model_calls < 0:
            raise ValueError("max_model_calls must be >= 0")
        if result.max_evaluator_queries is not None and result.max_evaluator_queries < 0:
            raise ValueError("max_evaluator_queries must be >= 0")
        if result.feedback_disclosure not in {"BLACKBOX", "OBJECTIVES", "DIAGNOSTICS"}:
            raise ValueError("unsupported feedback_disclosure")
        return result

    @property
    def effective_max_model_calls(self) -> int:
        return (
            self.max_generations * self.candidates_per_generation
            if self.max_model_calls is None
            else self.max_model_calls
        )

    @property
    def effective_max_evaluator_queries(self) -> int:
        return (
            self.max_generations * self.candidates_per_generation
            if self.max_evaluator_queries is None
            else self.max_evaluator_queries
        )


@dataclass(frozen=True)
class ReliabilityConfig:
    """Benchmark-neutral policy for failures outside the artifact's control."""

    pause_on_infrastructure_failure: bool = True
    count_infrastructure_attempts_in_evaluator_budget: bool = False

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ReliabilityConfig":
        result = cls(
            pause_on_infrastructure_failure=bool(
                value.get("pause_on_infrastructure_failure", True)
            ),
            count_infrastructure_attempts_in_evaluator_budget=bool(
                value.get("count_infrastructure_attempts_in_evaluator_budget", False)
            ),
        )
        if result.count_infrastructure_attempts_in_evaluator_budget:
            raise ValueError(
                "infrastructure evaluator attempts cannot consume the scientific query budget"
            )
        return result


@dataclass(frozen=True)
class FixedProbeConfig:
    """A frozen, benchmark-independent command probe used by L1/L2."""

    probe_id: str
    command: tuple[str, ...]
    cwd: Path
    timeout_seconds: int = 120
    env: dict[str, str] = field(default_factory=dict)
    selection_mode: str = "regression_anchor"
    parser: str = "exit_code"
    regression_epsilon: float = 0.0
    tags: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "FixedProbeConfig":
        probe_id = str(value.get("id", "")).strip()
        if not probe_id:
            raise ValueError("method.fixed_probes[].id is required")
        command = value.get("command")
        if not isinstance(command, list) or not command or not all(
            isinstance(part, str) for part in command
        ):
            raise ValueError(f"fixed probe {probe_id}: command must be a non-empty argv list")
        cwd = Path(str(value.get("cwd", "."))).expanduser().resolve()
        if not cwd.is_dir():
            raise ValueError(f"fixed probe {probe_id}: cwd does not exist: {cwd}")
        raw_tags = value.get("tags", [])
        if not isinstance(raw_tags, list) or not all(isinstance(item, str) for item in raw_tags):
            raise ValueError(f"fixed probe {probe_id}: tags must be a string list")
        result = cls(
            probe_id=probe_id,
            command=tuple(command),
            cwd=cwd,
            timeout_seconds=int(value.get("timeout_seconds", 120)),
            env={str(k): str(v) for k, v in value.get("env", {}).items()},
            selection_mode=str(value.get("selection_mode", "regression_anchor")).lower(),
            parser=str(value.get("parser", "exit_code")).lower(),
            regression_epsilon=float(value.get("regression_epsilon", 0.0)),
            tags=tuple(sorted({item.strip() for item in raw_tags if item.strip()})),
        )
        if result.timeout_seconds < 1:
            raise ValueError(f"fixed probe {probe_id}: timeout_seconds must be >= 1")
        if result.selection_mode not in {"required", "regression_anchor"}:
            raise ValueError(
                f"fixed probe {probe_id}: selection_mode must be required or regression_anchor"
            )
        if result.parser not in {"exit_code", "json_stdout"}:
            raise ValueError(f"fixed probe {probe_id}: unsupported parser {result.parser}")
        if result.regression_epsilon < 0:
            raise ValueError(f"fixed probe {probe_id}: regression_epsilon must be >= 0")
        return result


@dataclass(frozen=True)
class ActiveProbeSelectionConfig:
    """Frozen L2 policy weights for selecting a subset of the probe catalog."""

    max_selected_probes: int = 2
    min_observations_per_probe: int = 1
    coverage_weight: float = 1.0
    regression_weight: float = 1.0
    uncertainty_weight: float = 0.75
    intent_affinity_weight: float = 0.5
    recency_weight: float = 0.25

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ActiveProbeSelectionConfig":
        result = cls(
            max_selected_probes=int(value.get("max_selected_probes", 2)),
            min_observations_per_probe=int(value.get("min_observations_per_probe", 1)),
            coverage_weight=float(value.get("coverage_weight", 1.0)),
            regression_weight=float(value.get("regression_weight", 1.0)),
            uncertainty_weight=float(value.get("uncertainty_weight", 0.75)),
            intent_affinity_weight=float(value.get("intent_affinity_weight", 0.5)),
            recency_weight=float(value.get("recency_weight", 0.25)),
        )
        if result.max_selected_probes < 1:
            raise ValueError("L2 active_selection.max_selected_probes must be >= 1")
        if result.min_observations_per_probe < 0:
            raise ValueError("L2 min_observations_per_probe must be >= 0")
        weights = (
            result.coverage_weight,
            result.regression_weight,
            result.uncertainty_weight,
            result.intent_affinity_weight,
            result.recency_weight,
        )
        if any(weight < 0 for weight in weights) or not any(weight > 0 for weight in weights):
            raise ValueError("L2 active-selection weights must be nonnegative and not all zero")
        return result


@dataclass(frozen=True)
class ProbeGeneConfig:
    name: str
    initial: int
    minimum: int
    maximum: int
    step: int
    difficulty_direction: str = "increasing"

    @classmethod
    def from_dict(cls, value: dict[str, Any], family_id: str) -> "ProbeGeneConfig":
        result = cls(
            name=str(value.get("name", "")).strip(),
            initial=int(value.get("initial", 0)),
            minimum=int(value.get("minimum", 0)),
            maximum=int(value.get("maximum", 0)),
            step=int(value.get("step", 0)),
            difficulty_direction=str(
                value.get("difficulty_direction", "increasing")
            ).lower(),
        )
        if not result.name or not result.name.replace("_", "a").isalnum():
            raise ValueError(f"L3 probe family {family_id}: gene.name must be alphanumeric")
        if result.minimum > result.initial or result.initial > result.maximum:
            raise ValueError(f"L3 probe family {family_id}: initial gene is outside bounds")
        if result.step < 1:
            raise ValueError(f"L3 probe family {family_id}: gene.step must be >= 1")
        if result.difficulty_direction not in {"increasing", "decreasing"}:
            raise ValueError(
                f"L3 probe family {family_id}: difficulty_direction must be increasing or decreasing"
            )
        return result


@dataclass(frozen=True)
class ProbeFamilyConfig:
    family_id: str
    gene: ProbeGeneConfig
    template: FixedProbeConfig
    archive_capacity: int = 8

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ProbeFamilyConfig":
        family_id = str(value.get("id", "")).strip()
        if not family_id or not family_id.replace("_", "a").replace("-", "a").isalnum():
            raise ValueError("L3 probe family id must contain only letters, numbers, _ or -")
        gene = ProbeGeneConfig.from_dict(dict(value.get("gene", {})), family_id)
        raw_probe = value.get("probe")
        if not isinstance(raw_probe, dict):
            raise ValueError(f"L3 probe family {family_id}: probe template is required")
        template_value = dict(raw_probe)
        template_value["id"] = f"{family_id}__template"
        template = FixedProbeConfig.from_dict(template_value)
        token = f"[[{gene.name}]]"
        if not any(token in part for part in template.command):
            raise ValueError(
                f"L3 probe family {family_id}: command must contain gene token {token}"
            )
        if template.selection_mode != "regression_anchor":
            raise ValueError(
                f"L3 probe family {family_id}: evolved probes must use regression_anchor"
            )
        capacity = int(value.get("archive_capacity", 8))
        if capacity < 2:
            raise ValueError(f"L3 probe family {family_id}: archive_capacity must be >= 2")
        return cls(family_id, gene, template, capacity)


@dataclass(frozen=True)
class HarnessModuleConfig:
    """A benchmark-neutral, bounded mutation unit for an Agent harness."""

    module_id: str
    instruction: str
    tags: tuple[str, ...] = ()
    category: str = "workflow"

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "HarnessModuleConfig":
        module_id = str(value.get("id", "")).strip()
        if not module_id or not module_id.replace("_", "a").replace("-", "a").isalnum():
            raise ValueError("L4 harness module id must contain only letters, numbers, _ or -")
        instruction = str(value.get("instruction", "")).strip()
        if not instruction:
            raise ValueError(f"L4 harness module {module_id}: instruction is required")
        if len(instruction) > 4000:
            raise ValueError(f"L4 harness module {module_id}: instruction exceeds 4000 characters")
        raw_tags = value.get("tags", [])
        if not isinstance(raw_tags, list) or not all(isinstance(item, str) for item in raw_tags):
            raise ValueError(f"L4 harness module {module_id}: tags must be a string list")
        category = str(value.get("category", "workflow")).strip().lower()
        if category not in {
            "skill",
            "mcp",
            "tool",
            "context",
            "protocol",
            "workflow",
            "gameplay",
            "observability",
            "repair",
            "strategy",
        }:
            raise ValueError(f"L4 harness module {module_id}: unsupported category {category!r}")
        return cls(
            module_id=module_id,
            instruction=instruction,
            tags=tuple(sorted({item.strip() for item in raw_tags if item.strip()})),
            category=category,
        )


@dataclass(frozen=True)
class HarnessElementConfig:
    """One concrete managed item inside a harness category (skill/MCP/tool/...)."""

    element_id: str
    category: str
    description: str
    spec: dict[str, Any] = field(default_factory=dict)
    tags: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "HarnessElementConfig":
        element_id = str(value.get("id", "")).strip()
        if not element_id:
            raise ValueError("harness element id is required")
        category = str(value.get("category", "")).strip().lower()
        if category not in {
            "skill",
            "mcp",
            "tool",
            "context",
            "protocol",
            "workflow",
        }:
            raise ValueError(f"harness element {element_id}: unsupported category {category!r}")
        description = str(value.get("description", "")).strip()
        if not description:
            raise ValueError(f"harness element {element_id}: description is required")
        raw_spec = value.get("spec", {})
        if not isinstance(raw_spec, dict):
            raise ValueError(f"harness element {element_id}: spec must be an object")
        raw_tags = value.get("tags", [])
        if not isinstance(raw_tags, list) or not all(isinstance(item, str) for item in raw_tags):
            raise ValueError(f"harness element {element_id}: tags must be a string list")
        return cls(
            element_id=element_id,
            category=category,
            description=description,
            spec=dict(raw_spec),
            tags=tuple(sorted({item.strip() for item in raw_tags if item.strip()})),
        )


def _parse_element_catalog(raw: list | None) -> tuple[HarnessElementConfig, ...]:
    if not raw:
        return ()
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        raise ValueError("harness_evolution.element_catalog must be an object list")
    return tuple(HarnessElementConfig.from_dict(dict(item)) for item in raw)


def _parse_seed_elements(raw: dict | None) -> dict[str, tuple[str, ...]]:
    if not raw:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("harness_evolution.seed_elements must be an object")
    result: dict[str, tuple[str, ...]] = {}
    for category, ids in raw.items():
        name = str(category).strip().lower()
        if not isinstance(ids, list) or not all(isinstance(item, str) for item in ids):
            raise ValueError(f"seed_elements[{name}] must be a string list")
        result[name] = tuple(dict.fromkeys(str(item) for item in ids))
    return result


def _parse_max_active_elements(raw: dict | None) -> dict[str, int]:
    defaults = {
        "skill": 4,
        "mcp": 2,
        "tool": 3,
        "context": 3,
        "protocol": 2,
        "workflow": 3,
    }
    if not raw:
        return defaults
    if not isinstance(raw, dict):
        raise ValueError("harness_evolution.max_active_elements must be an object")
    merged = dict(defaults)
    for key, value in raw.items():
        merged[str(key).strip().lower()] = int(value)
    return merged


@dataclass(frozen=True)
class HarnessToolInterfaceConfig:
    """A bounded Agent/engine tool interface that can become part of a Harness genome."""

    interface_id: str
    kind: str
    description: str
    command: tuple[str, ...] = ()
    cwd: Path | None = None
    env: dict[str, str] = field(default_factory=dict)
    safety_scope: str = "candidate_workspace_only"
    tags: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "HarnessToolInterfaceConfig":
        interface_id = str(value.get("id", "")).strip()
        if not interface_id or not interface_id.replace("_", "a").replace("-", "a").isalnum():
            raise ValueError(
                "L4 harness tool interface id must contain only letters, numbers, _ or -"
            )
        kind = str(value.get("kind", "")).strip().lower()
        if kind not in {"mcp_server", "command_wrapper", "engine_probe", "env_binding"}:
            raise ValueError(f"L4 harness tool interface {interface_id}: unsupported kind")
        description = str(value.get("description", "")).strip()
        if not description:
            raise ValueError(
                f"L4 harness tool interface {interface_id}: description is required"
            )
        if len(description) > 2000:
            raise ValueError(
                f"L4 harness tool interface {interface_id}: description exceeds 2000 characters"
            )
        raw_command = value.get("command", [])
        if not isinstance(raw_command, list) or not all(
            isinstance(part, str) for part in raw_command
        ):
            raise ValueError(
                f"L4 harness tool interface {interface_id}: command must be a string list"
            )
        cwd = (
            None
            if value.get("cwd") is None
            else Path(str(value["cwd"])).expanduser().resolve()
        )
        if cwd is not None and not cwd.is_dir():
            raise ValueError(
                f"L4 harness tool interface {interface_id}: cwd does not exist: {cwd}"
            )
        raw_env = value.get("env", {})
        if not isinstance(raw_env, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in raw_env.items()
        ):
            raise ValueError(
                f"L4 harness tool interface {interface_id}: env must be a string object"
            )
        safety_scope = str(
            value.get("safety_scope", "candidate_workspace_only")
        ).strip().lower()
        if safety_scope not in {
            "candidate_workspace_only",
            "task_and_candidate_readonly",
            "engine_runtime_only",
        }:
            raise ValueError(
                f"L4 harness tool interface {interface_id}: unsupported safety_scope"
            )
        raw_tags = value.get("tags", [])
        if not isinstance(raw_tags, list) or not all(
            isinstance(item, str) for item in raw_tags
        ):
            raise ValueError(
                f"L4 harness tool interface {interface_id}: tags must be a string list"
            )
        return cls(
            interface_id=interface_id,
            kind=kind,
            description=description,
            command=tuple(raw_command),
            cwd=cwd,
            env=dict(raw_env),
            safety_scope=safety_scope,
            tags=tuple(sorted({item.strip() for item in raw_tags if item.strip()})),
        )


_KNOWN_NICHES = frozenset({
    "context_compiler",
    "module_strategy",
    "skill_governance",
    "tool_interface",
    "probe_governance",
    "feedback_synthesis",
    "artifact_persistence",
    "session_routing",
})


def _parse_allowed_niches(value: list) -> tuple[str, ...]:
    """Validate and normalise the allowed-niche list for ablation ladders."""
    if not isinstance(value, list):
        raise ValueError("harness_evolution.allowed_niches must be a list")
    niches: list[str] = []
    for item in value:
        name = str(item).strip()
        if name not in _KNOWN_NICHES:
            raise ValueError(
                f"unknown niche '{name}'; valid niches: {sorted(_KNOWN_NICHES)}"
            )
        if name not in niches:
            niches.append(name)
    return tuple(niches)


@dataclass(frozen=True)
class HarnessRubricCriterion:
    """One hard (0/1) or soft (0..1) admission rubric for harness validation."""

    rubric_id: str
    kind: str
    description: str
    weight: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "rubric_id": self.rubric_id,
            "kind": self.kind,
            "description": self.description,
            "weight": self.weight,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "HarnessRubricCriterion":
        kind = str(value.get("kind", "")).strip().lower()
        if kind not in {"hard", "soft"}:
            raise ValueError("harness rubric kind must be 'hard' or 'soft'")
        weight = float(value.get("weight", 1.0))
        if kind == "hard" and weight != 1.0:
            raise ValueError("hard rubrics must use weight 1.0")
        if kind == "soft" and not 0.0 < weight:
            raise ValueError("soft rubric weight must be > 0")
        return cls(
            rubric_id=str(value["rubric_id"]).strip(),
            kind=kind,
            description=str(value.get("description", "")).strip(),
            weight=weight,
        )


DEFAULT_HARD_RUBRICS: tuple[HarnessRubricCriterion, ...] = (
    HarnessRubricCriterion(
        "launches_without_crash",
        "hard",
        "Game launches and runs without immediate crash or fatal runtime error.",
    ),
    HarnessRubricCriterion(
        "respects_task_constraints",
        "hard",
        "Delivered game respects public task constraints and does not break legality gates.",
    ),
    HarnessRubricCriterion(
        "produces_runnable_artifact",
        "hard",
        "Candidate workspace contains a runnable game artifact verified by deep probes.",
    ),
    HarnessRubricCriterion(
        "no_hidden_test_leakage",
        "hard",
        "No benchmark hidden tests, rubrics, or infrastructure files were copied into workspace.",
    ),
)

DEFAULT_SOFT_RUBRICS: tuple[HarnessRubricCriterion, ...] = (
    HarnessRubricCriterion(
        "gameplay_responsiveness",
        "soft",
        "Controls, pacing, and interaction feel responsive during actual play.",
        weight=0.25,
    ),
    HarnessRubricCriterion(
        "feature_completeness",
        "soft",
        "Core requested mechanics and win/lose/progress loops are present.",
        weight=0.25,
    ),
    HarnessRubricCriterion(
        "visual_clarity",
        "soft",
        "Visual presentation is readable and supports understanding gameplay state.",
        weight=0.20,
    ),
    HarnessRubricCriterion(
        "feedback_and_progress",
        "soft",
        "Player receives clear feedback and can perceive progress.",
        weight=0.15,
    ),
    HarnessRubricCriterion(
        "overall_play_experience",
        "soft",
        "Holistic play experience is coherent and engaging.",
        weight=0.15,
    ),
)


def _parse_rubric_criteria(
    raw: list | None,
    *,
    default: tuple[HarnessRubricCriterion, ...],
    label: str,
) -> tuple[HarnessRubricCriterion, ...]:
    if raw is None:
        return default
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        raise ValueError(f"harness_evolution.{label} must be an object list")
    return tuple(HarnessRubricCriterion.from_dict(dict(item)) for item in raw)


def _parse_element_mutation_policy(raw: dict | None) -> dict[str, Any]:
    from game_loop.core.harness_element_stats import DEFAULT_ELEMENT_MUTATION_POLICY

    merged = dict(DEFAULT_ELEMENT_MUTATION_POLICY)
    if not raw:
        return merged
    if not isinstance(raw, dict):
        raise ValueError("harness_evolution.element_mutation_policy must be an object")
    for key, value in raw.items():
        merged[str(key)] = value
    return merged


@dataclass(frozen=True)
class HarnessEvolutionConfig:
    """Frozen outer-loop search and admission policy for Agent harnesses."""

    modules: tuple[HarnessModuleConfig, ...]
    tool_interfaces: tuple[HarnessToolInterfaceConfig, ...] = ()
    seed_modules: tuple[str, ...] = ()
    seed_tool_interfaces: tuple[str, ...] = ()
    max_active_modules: int = 3
    max_active_tool_interfaces: int = 2
    mutation_width: int = 1
    replay_min_cases: int = 2
    promotion_delta_min: float = 0.0
    max_case_regression: float = 0.08
    allowed_niches: tuple[str, ...] = ()
    loop_role: str = "inner"
    rubric_validation_sample_size: int = 2
    rubric_provider: str = "deepseek"
    rubric_judge_timeout_seconds: int = 120
    require_rubric_validation: bool = True
    dynamic_rubric_generation: bool = True
    enable_usage_driven_mutation: bool = True
    element_catalog: tuple[HarnessElementConfig, ...] = ()
    seed_elements: dict[str, tuple[str, ...]] = field(default_factory=dict)
    max_active_elements: dict[str, int] = field(
        default_factory=lambda: _parse_max_active_elements(None)
    )
    element_mutation_policy: dict[str, Any] = field(
        default_factory=lambda: _parse_element_mutation_policy(None)
    )
    hard_rubrics: tuple[HarnessRubricCriterion, ...] = DEFAULT_HARD_RUBRICS
    soft_rubrics: tuple[HarnessRubricCriterion, ...] = DEFAULT_SOFT_RUBRICS

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "HarnessEvolutionConfig":
        raw_modules = value.get("modules", [])
        if not isinstance(raw_modules, list) or not all(
            isinstance(item, dict) for item in raw_modules
        ):
            raise ValueError("L4 harness_evolution.modules must be an object list")
        modules = tuple(HarnessModuleConfig.from_dict(dict(item)) for item in raw_modules)
        ids = [module.module_id for module in modules]
        if not modules or len(set(ids)) != len(ids):
            raise ValueError("L4 requires a non-empty harness module catalog with unique ids")
        raw_interfaces = value.get("tool_interfaces", [])
        if not isinstance(raw_interfaces, list) or not all(
            isinstance(item, dict) for item in raw_interfaces
        ):
            raise ValueError("L4 harness_evolution.tool_interfaces must be an object list")
        tool_interfaces = tuple(
            HarnessToolInterfaceConfig.from_dict(dict(item)) for item in raw_interfaces
        )
        interface_ids = [interface.interface_id for interface in tool_interfaces]
        if len(set(interface_ids)) != len(interface_ids):
            raise ValueError("L4 harness tool interface ids must be unique")
        raw_seed = value.get("seed_modules", [])
        if not isinstance(raw_seed, list) or not all(isinstance(item, str) for item in raw_seed):
            raise ValueError("L4 harness_evolution.seed_modules must be a string list")
        seed_modules = tuple(dict.fromkeys(str(item) for item in raw_seed))
        unknown = sorted(set(seed_modules) - set(ids))
        if unknown:
            raise ValueError(f"L4 seed harness references unknown modules: {unknown}")
        raw_seed_interfaces = value.get("seed_tool_interfaces", [])
        if not isinstance(raw_seed_interfaces, list) or not all(
            isinstance(item, str) for item in raw_seed_interfaces
        ):
            raise ValueError(
                "L4 harness_evolution.seed_tool_interfaces must be a string list"
            )
        seed_tool_interfaces = tuple(dict.fromkeys(str(item) for item in raw_seed_interfaces))
        unknown_interfaces = sorted(set(seed_tool_interfaces) - set(interface_ids))
        if unknown_interfaces:
            raise ValueError(
                f"L4 seed harness references unknown tool interfaces: {unknown_interfaces}"
            )
        loop_role = str(value.get("loop_role", "inner")).strip().lower()
        if loop_role not in {"inner", "outer"}:
            raise ValueError("harness_evolution.loop_role must be 'inner' or 'outer'")
        element_catalog = _parse_element_catalog(value.get("element_catalog"))
        seed_elements = _parse_seed_elements(value.get("seed_elements"))
        max_active_elements = _parse_max_active_elements(value.get("max_active_elements"))
        element_mutation_policy = _parse_element_mutation_policy(
            value.get("element_mutation_policy")
        )
        element_ids = [item.element_id for item in element_catalog]
        if element_catalog and len(set(element_ids)) != len(element_ids):
            raise ValueError("harness element ids must be unique")
        result = cls(
            modules=modules,
            tool_interfaces=tool_interfaces,
            seed_modules=seed_modules,
            seed_tool_interfaces=seed_tool_interfaces,
            max_active_modules=int(value.get("max_active_modules", 3)),
            max_active_tool_interfaces=int(value.get("max_active_tool_interfaces", 2)),
            mutation_width=int(value.get("mutation_width", 1)),
            replay_min_cases=int(value.get("replay_min_cases", 2)),
            promotion_delta_min=float(value.get("promotion_delta_min", 0.0)),
            max_case_regression=float(value.get("max_case_regression", 0.08)),
            allowed_niches=_parse_allowed_niches(value.get("allowed_niches", [])),
            loop_role=loop_role,
            rubric_validation_sample_size=int(
                value.get(
                    "rubric_validation_sample_size",
                    value.get("replay_min_cases", 2),
                )
            ),
            rubric_provider=str(value.get("rubric_provider", "deepseek")).strip().lower(),
            rubric_judge_timeout_seconds=int(value.get("rubric_judge_timeout_seconds", 120)),
            require_rubric_validation=bool(value.get("require_rubric_validation", True)),
            dynamic_rubric_generation=bool(value.get("dynamic_rubric_generation", True)),
            enable_usage_driven_mutation=bool(
                value.get("enable_usage_driven_mutation", loop_role == "inner")
            ),
            element_catalog=element_catalog,
            seed_elements=seed_elements,
            max_active_elements=max_active_elements,
            element_mutation_policy=element_mutation_policy,
            hard_rubrics=_parse_rubric_criteria(
                value.get("hard_rubrics"),
                default=DEFAULT_HARD_RUBRICS,
                label="hard_rubrics",
            ),
            soft_rubrics=_parse_rubric_criteria(
                value.get("soft_rubrics"),
                default=DEFAULT_SOFT_RUBRICS,
                label="soft_rubrics",
            ),
        )
        if not 1 <= result.max_active_modules <= len(modules):
            raise ValueError("L4 max_active_modules must be within the module catalog")
        if len(seed_modules) > result.max_active_modules:
            raise ValueError("L4 seed_modules exceeds max_active_modules")
        if result.max_active_tool_interfaces < 0:
            raise ValueError("L4 max_active_tool_interfaces must be >= 0")
        if (
            tool_interfaces
            and result.max_active_tool_interfaces > 0
            and result.max_active_tool_interfaces > len(tool_interfaces)
            and len(seed_tool_interfaces) > len(tool_interfaces)
        ):
            raise ValueError(
                "L4 max_active_tool_interfaces must be within the tool interface catalog"
            )
        if len(seed_tool_interfaces) > result.max_active_tool_interfaces:
            raise ValueError("L4 seed_tool_interfaces exceeds max_active_tool_interfaces")
        if not 1 <= result.mutation_width <= result.max_active_modules:
            raise ValueError("L4 mutation_width must be within 1..max_active_modules")
        if result.replay_min_cases < 1:
            raise ValueError("L4 replay_min_cases must be >= 1")
        if result.max_case_regression < 0:
            raise ValueError("L4 max_case_regression must be >= 0")
        if result.rubric_validation_sample_size < 1:
            raise ValueError("L4 rubric_validation_sample_size must be >= 1")
        if result.rubric_judge_timeout_seconds < 5:
            raise ValueError("L4 rubric_judge_timeout_seconds must be >= 5")
        if result.require_rubric_validation and result.replay_min_cases < result.rubric_validation_sample_size:
            raise ValueError(
                "L4 replay_min_cases must be >= rubric_validation_sample_size"
            )
        hard_ids = [item.rubric_id for item in result.hard_rubrics]
        if len(set(hard_ids)) != len(hard_ids):
            raise ValueError("L4 hard_rubrics must have unique rubric_id values")
        soft_ids = [item.rubric_id for item in result.soft_rubrics]
        if len(set(soft_ids)) != len(soft_ids):
            raise ValueError("L4 soft_rubrics must have unique rubric_id values")
        for category, ids in result.seed_elements.items():
            unknown_elements = sorted(set(ids) - set(element_ids))
            if unknown_elements:
                raise ValueError(
                    f"seed_elements[{category}] references unknown elements: {unknown_elements}"
                )
            limit = result.max_active_elements.get(category, 0)
            if limit and len(ids) > limit:
                raise ValueError(
                    f"seed_elements[{category}] exceeds max_active_elements ({limit})"
                )
        return result


@dataclass(frozen=True)
class MethodConfig:
    level: str = "L0"
    observation_contract: str = "benchmark_evaluator_and_validity_gates"
    fixed_probes: tuple[FixedProbeConfig, ...] = ()
    max_probe_calls: int = 0
    active_selection: ActiveProbeSelectionConfig | None = None
    probe_families: tuple[ProbeFamilyConfig, ...] = ()
    harness_evolution: HarnessEvolutionConfig | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "MethodConfig":
        level = str(value.get("level", "L0")).upper()
        contracts = {
            "L0": "benchmark_evaluator_and_validity_gates",
            "L1": "fixed_probes_plus_benchmark_evaluator_and_validity_gates",
            "L2": "active_frozen_probe_catalog_plus_benchmark_evaluator_and_validity_gates",
            "L3": "coevolving_probe_archive_plus_benchmark_evaluator_and_validity_gates",
            "L4": "two_timescale_agent_harness_evolution_plus_benchmark_evaluator_and_validity_gates",
        }
        default_contract = contracts.get(level, contracts["L0"])
        if "fixed_probes" in value and "probe_catalog" in value:
            raise ValueError("configure method.fixed_probes or method.probe_catalog, not both")
        raw_probes = value.get("probe_catalog", value.get("fixed_probes", []))
        if not isinstance(raw_probes, list):
            raise ValueError("method probe catalog must be a list")
        if not all(isinstance(item, dict) for item in raw_probes):
            raise ValueError("each method probe catalog item must be an object")
        probes = tuple(
            FixedProbeConfig.from_dict(dict(item))
            for item in raw_probes
        )
        raw_families = value.get("probe_families", [])
        if not isinstance(raw_families, list) or not all(
            isinstance(item, dict) for item in raw_families
        ):
            raise ValueError("method.probe_families must be an object list")
        families = tuple(ProbeFamilyConfig.from_dict(dict(item)) for item in raw_families)
        result = cls(
            level=level,
            observation_contract=str(
                value.get("observation_contract", default_contract)
            ),
            fixed_probes=probes,
            max_probe_calls=int(value.get("max_probe_calls", 0)),
            active_selection=(
                ActiveProbeSelectionConfig.from_dict(dict(value["active_selection"]))
                if value.get("active_selection") is not None
                else None
            ),
            probe_families=families,
            harness_evolution=(
                HarnessEvolutionConfig.from_dict(dict(value["harness_evolution"]))
                if value.get("harness_evolution") is not None
                else None
            ),
        )
        if result.level not in {"L0", "L1", "L2", "L3", "L4"}:
            raise ValueError("this release implements L0-L4")
        if len({probe.probe_id for probe in probes}) != len(probes):
            raise ValueError("method.fixed_probes ids must be unique")
        if result.level == "L0" and result.observation_contract != "benchmark_evaluator_and_validity_gates":
            raise ValueError(
                "L0 requires observation_contract=benchmark_evaluator_and_validity_gates"
            )
        if result.level == "L0" and (
            result.fixed_probes
            or result.max_probe_calls
            or result.active_selection
            or result.probe_families
            or result.harness_evolution
        ):
            raise ValueError("L0 cannot configure probes, active selection, or a probe budget")
        if result.level == "L1":
            if result.observation_contract != "fixed_probes_plus_benchmark_evaluator_and_validity_gates":
                raise ValueError(
                    "L1 requires observation_contract="
                    "fixed_probes_plus_benchmark_evaluator_and_validity_gates"
                )
            if not result.fixed_probes:
                raise ValueError("L1 requires at least one fixed probe")
            minimum_pair = 2 * len(result.fixed_probes)
            if result.max_probe_calls < minimum_pair:
                raise ValueError(
                    f"L1 max_probe_calls must allow one parent/candidate pair ({minimum_pair})"
                )
            if result.active_selection is not None:
                raise ValueError("L1 cannot configure active_selection")
            if result.probe_families:
                raise ValueError("L1 cannot configure probe_families")
            if result.harness_evolution is not None:
                raise ValueError("L1 cannot configure harness_evolution")
        if result.level == "L2":
            if result.observation_contract != contracts["L2"]:
                raise ValueError(
                    "L2 requires observation_contract="
                    "active_frozen_probe_catalog_plus_benchmark_evaluator_and_validity_gates"
                )
            if not result.fixed_probes:
                raise ValueError("L2 requires a non-empty frozen probe catalog")
            if result.active_selection is None:
                raise ValueError("L2 requires active_selection")
            selected = result.active_selection.max_selected_probes
            if selected > len(result.fixed_probes):
                raise ValueError("L2 max_selected_probes cannot exceed probe catalog size")
            required_count = sum(
                probe.selection_mode == "required" for probe in result.fixed_probes
            )
            if required_count > selected:
                raise ValueError("L2 max_selected_probes must include every required probe")
            if result.max_probe_calls < 2 * selected:
                raise ValueError(
                    "L2 max_probe_calls must allow one complete active parent/candidate pair"
                )
            if result.probe_families:
                raise ValueError("L2 cannot configure probe_families")
            if result.harness_evolution is not None:
                raise ValueError("L2 cannot configure harness_evolution")
        if result.level in {"L3", "L4"}:
            if result.observation_contract != contracts[result.level]:
                raise ValueError(
                    f"{result.level} requires observation_contract={contracts[result.level]}"
                )
            if result.active_selection is None:
                raise ValueError(f"{result.level} requires active_selection")
            if not result.probe_families:
                raise ValueError(f"{result.level} requires at least one parameterized probe family")
            family_ids = [family.family_id for family in result.probe_families]
            if len(set(family_ids)) != len(family_ids):
                raise ValueError("L3 probe family ids must be unique")
            selected = result.active_selection.max_selected_probes
            required_count = sum(
                probe.selection_mode == "required" for probe in result.fixed_probes
            )
            initial_catalog_size = len(result.fixed_probes) + len(result.probe_families)
            if selected > initial_catalog_size:
                raise ValueError("L3 max_selected_probes exceeds the initial probe archive")
            if required_count >= selected:
                raise ValueError("L3 must reserve at least one slot for an evolved probe")
            if result.max_probe_calls < 2 * selected:
                raise ValueError(
                    f"{result.level} max_probe_calls must allow one complete coevolution probe pair"
                )
            if result.level == "L3" and result.harness_evolution is not None:
                raise ValueError("L3 keeps the Agent harness frozen")
            if result.level == "L4" and result.harness_evolution is None:
                raise ValueError("L4 requires harness_evolution")
        return result


@dataclass(frozen=True)
class GateConfig:
    max_files: int = 5000
    max_total_bytes: int = 1_073_741_824
    fail_suspicious_references: bool = True

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "GateConfig":
        return cls(
            max_files=int(value.get("max_files", 5000)),
            max_total_bytes=int(value.get("max_total_bytes", 1_073_741_824)),
            fail_suspicious_references=bool(value.get("fail_suspicious_references", True)),
        )


@dataclass(frozen=True)
class ExperimentConfig:
    """Frozen experimental semantics for a run.

    ``standard`` preserves the normal L0--L4 controller. Named arms are
    deliberately narrow interventions used by the registered experiment.
    """

    arm: str = "standard"
    ablation_level: str = ""

    @classmethod
    def from_dict(
        cls,
        value: dict[str, Any],
        *,
        method: MethodConfig,
        evolution: EvolutionConfig,
        benchmark_adapter: str,
    ) -> "ExperimentConfig":
        arm = str(value.get("arm", "standard")).strip()
        ablation_level = str(value.get("ablation_level", "")).strip()
        allowed = {
            "standard",
            "single_shot",
            "retry3",
            "parent_only",
            "L0",
            "L1",
            "L2",
            "L3",
            "L4",
            "L2_uniform",
            "L3_no_evolve",
            "L3_no_protect",
            "L4_no_harness_evolve",
            "L4_agent",
            "L4_agent_no_harness_evolve",
        }
        if arm not in allowed:
            raise ValueError(f"unsupported experiment.arm: {arm}")
        if arm == "standard" and evolution.max_generations < 1:
            raise ValueError("standard runs require at least one generation")
        required_level = {
            "single_shot": "L0",
            "retry3": "L0",
            "parent_only": "L0",
            "L0": "L0",
            "L1": "L1",
            "L2": "L2",
            "L3": "L3",
            "L2_uniform": "L2",
            "L3_no_evolve": "L3",
            "L3_no_protect": "L3",
            "L4": "L4",
            "L4_no_harness_evolve": "L4",
            "L4_agent": "L4",
            "L4_agent_no_harness_evolve": "L4",
        }.get(arm)
        if required_level is not None and method.level != required_level:
            raise ValueError(f"experiment arm {arm} requires method.level={required_level}")
        calls = evolution.effective_max_model_calls
        single_shot_calls = 0 if benchmark_adapter == "gcbench" else 1
        if arm == "single_shot" and calls != single_shot_calls:
            raise ValueError(
                f"{benchmark_adapter} single_shot requires exactly {single_shot_calls} "
                "additional model calls"
            )
        iterative_arms = allowed - {"standard", "single_shot"}
        if arm in iterative_arms and calls != 3:
            raise ValueError(f"{arm} requires an effective model-call budget of exactly 3")
        expected_queries = single_shot_calls if arm == "single_shot" else 3
        if arm != "standard" and evolution.effective_max_evaluator_queries != expected_queries:
            raise ValueError(
                f"{arm} requires an effective evaluator-query budget of exactly {expected_queries}"
            )
        expected_single_generations = single_shot_calls
        if arm == "single_shot" and (
            evolution.max_generations != expected_single_generations
            or evolution.candidates_per_generation != 1
        ):
            raise ValueError(
                f"{benchmark_adapter} single_shot requires a "
                f"{expected_single_generations} generation x 1 candidate layout"
            )
        if arm == "retry3" and (
            evolution.max_generations != 1 or evolution.candidates_per_generation != 3
        ):
            raise ValueError("retry3 requires a 1 generation x 3 independent-candidate layout")
        if arm == "parent_only" and evolution.candidates_per_generation != 1:
            raise ValueError("parent_only requires candidates_per_generation=1")
        if arm in iterative_arms - {"retry3"} and evolution.max_generations != 3:
            raise ValueError(f"{arm} requires a 3 generation x 1 candidate layout")
        if arm == "L1":
            expected_probe_calls = 6 * len(method.fixed_probes)
            if method.max_probe_calls != expected_probe_calls:
                raise ValueError(f"L1 requires exactly {expected_probe_calls} probe calls")
        if arm in {
            "L2", "L2_uniform", "L3", "L3_no_evolve", "L3_no_protect",
            "L4", "L4_no_harness_evolve", "L4_agent", "L4_agent_no_harness_evolve",
        }:
            assert method.active_selection is not None
            expected_probe_calls = 6 * method.active_selection.max_selected_probes
            if method.max_probe_calls != expected_probe_calls:
                raise ValueError(f"{arm} requires exactly {expected_probe_calls} probe calls")
        return cls(arm=arm, ablation_level=ablation_level)

    @property
    def freezes_artifact_parent(self) -> bool:
        """True when a run tests agent/harness behavior without product lineage."""

        return self.arm in {
            "retry3",
            "L4_agent",
            "L4_agent_no_harness_evolve",
        }

    @property
    def freezes_harness_outer_loop(self) -> bool:
        return self.arm in {"L4_no_harness_evolve", "L4_agent_no_harness_evolve"}


@dataclass(frozen=True)
class AppConfig:
    benchmark: BenchmarkConfig
    backend: BackendConfig
    method: MethodConfig
    evolution: EvolutionConfig
    reliability: ReliabilityConfig
    gates: GateConfig
    experiment: ExperimentConfig
    raw: dict[str, Any]

    @classmethod
    def load(cls, path: Path) -> "AppConfig":
        raw = json.loads(path.read_text(encoding="utf-8"))
        benchmark = raw.get("benchmark", {})
        adapter = str(benchmark.get("adapter", "")).strip()
        if not adapter:
            raise ValueError("benchmark.adapter is required")
        method = MethodConfig.from_dict(dict(raw.get("method", {})))
        evolution = EvolutionConfig.from_dict(dict(raw.get("evolution", {})))
        reliability = ReliabilityConfig.from_dict(dict(raw.get("reliability", {})))
        experiment = ExperimentConfig.from_dict(
            dict(raw.get("experiment", {})),
            method=method,
            evolution=evolution,
            benchmark_adapter=adapter,
        )
        return cls(
            benchmark=BenchmarkConfig(adapter, dict(benchmark.get("options", {}))),
            backend=BackendConfig.from_dict(dict(raw.get("backend", {}))),
            method=method,
            evolution=evolution,
            reliability=reliability,
            gates=GateConfig.from_dict(dict(raw.get("gates", {}))),
            experiment=experiment,
            raw=raw,
        )

    @property
    def fingerprint(self) -> str:
        return sha256_json(self.raw)
