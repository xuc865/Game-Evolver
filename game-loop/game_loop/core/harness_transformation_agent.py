from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from game_loop.core.agent_circuit import (
    AgentCircuit,
    validate_workspace_lineage,
    workspace_artifact_kinds,
)
from game_loop.core.agent_circuit_compiler import HarnessTransformationCompiler
from game_loop.core.agent_circuit_evolution import CircuitMutationEngine
from game_loop.core.harness import HarnessEpochResult
from game_loop.core.harness_transformation_library import (
    HarnessTransformation,
    HarnessTransformationLibraryStore,
    TransformationLibraryAction,
)
from game_loop.utils import utc_now


@dataclass(frozen=True)
class TransformationLibraryUpdate:
    epoch: int
    status: str
    revision_before: int
    revision_after: int
    shortlist: tuple[str, ...] = ()
    disclosed: tuple[dict[str, Any], ...] = ()
    actions: tuple[dict[str, Any], ...] = ()
    error: str | None = None

    @property
    def applied(self) -> bool:
        return self.revision_after > self.revision_before

    def to_dict(self) -> dict[str, Any]:
        return {
            "epoch": self.epoch,
            "status": self.status,
            "revision_before": self.revision_before,
            "revision_after": self.revision_after,
            "shortlist": list(self.shortlist),
            "disclosed": list(self.disclosed),
            "actions": list(self.actions),
            "applied": self.applied,
            "error": self.error,
        }


class HarnessTransformationLibraryAgent:
    """HPA agent that evolves executable, reusable GOA topology transformations."""

    def __init__(
        self,
        store: HarnessTransformationLibraryStore,
        request_json: Callable[[str, dict[str, Any]], dict[str, Any]] | None = None,
        *,
        compiler: HarnessTransformationCompiler | None = None,
        max_structural_actions: int = 4,
        max_additions: int = 2,
        max_circuit_actions: int = 4,
        shortlist_limit: int = 4,
    ):
        if max_structural_actions < 1:
            raise ValueError("HPA transformation action limit must be positive")
        if not 0 <= max_additions <= max_structural_actions:
            raise ValueError("HPA transformation addition limit is invalid")
        if max_circuit_actions < 1:
            raise ValueError("HPA compiled circuit action limit must be positive")
        if shortlist_limit < 1:
            raise ValueError("HPA transformation shortlist limit must be positive")
        self.store = store
        self.request_json = request_json or self._request_with_configured_backbone
        self.compiler = compiler or HarnessTransformationCompiler()
        self.max_structural_actions = max_structural_actions
        self.max_additions = max_additions
        self.max_circuit_actions = max_circuit_actions
        self.shortlist_limit = shortlist_limit

    @staticmethod
    def _request_with_configured_backbone(
        stage: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        from game_loop.chat_agent import LocalChatAgent
        from game_loop.core.outer_harness_library import _extract_json_object

        agent = LocalChatAgent()
        messages = [
            {
                "role": "system",
                "content": (
                    "You are the HPA topology-transformation librarian. Evolve reusable "
                    "Agent Circuit transformations from disclosed evidence only. Return one "
                    "valid JSON object and no prose. Never invent benchmark-private evidence."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {"stage": stage, **payload}, ensure_ascii=False
                ),
            },
        ]
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = agent._call_api(
                    messages,
                    response_format={"type": "json_object"},
                )
            except RuntimeError as exc:
                detail = str(exc).casefold()
                if not any(
                    marker in detail
                    for marker in ("response_format", "json_object", "api error 400")
                ):
                    raise
                response = agent._call_api(messages)
            message = response["choices"][0]["message"]
            content = message.get("content") or message.get("reasoning_content") or ""
            try:
                return _extract_json_object(str(content))
            except (TypeError, ValueError, SyntaxError) as exc:
                last_error = exc
                if attempt == 2:
                    break
                finish_reason = str(response["choices"][0].get("finish_reason", ""))
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "The prior response was invalid or truncated "
                            f"(finish_reason={finish_reason or 'unknown'}). Start over; do not "
                            "continue or repeat it. Return exactly one compact JSON object. "
                            "When adding to an empty library, add exactly one transformation "
                            "with at most three declarative circuit actions. Keep names, "
                            "rationales, objectives, prompts, and edge instructions concise. "
                            "Use empty arrays for no actions."
                        ),
                    }
                )
        assert last_error is not None
        raise last_error

    @staticmethod
    def _evidence_refs(
        *,
        latest: HarnessEpochResult,
        inner_history: Iterable[Mapping[str, Any]],
    ) -> tuple[str, ...]:
        refs = [f"inner://epoch/{latest.epoch}/result"]
        refs.extend(
            f"inner://epoch/{latest.epoch}/case/{index + 1}"
            for index, _ in enumerate(latest.paired_deltas)
        )
        rubric = latest.rubric_validation or {}
        case_results = rubric.get("case_results", [])
        if isinstance(case_results, list):
            for case in case_results:
                if not isinstance(case, Mapping):
                    continue
                case_id = str(case.get("case_id", "unknown"))
                candidate = case.get("candidate", {})
                if not isinstance(candidate, Mapping):
                    continue
                for score_kind in ("hard", "soft"):
                    scores = candidate.get(score_kind, {})
                    if not isinstance(scores, Mapping):
                        continue
                    refs.extend(
                        f"rubric://epoch/{latest.epoch}/case/{case_id}/{score_kind}/{rubric_id}"
                        for rubric_id in sorted(str(item) for item in scores)
                    )
        for item in list(inner_history)[-12:]:
            try:
                inner = item.get("inner", {})
                previous_epoch = int(
                    inner.get("epoch", 0)
                    if isinstance(inner, Mapping)
                    else item.get("epoch", 0)
                )
            except (TypeError, ValueError):
                continue
            if previous_epoch > 0:
                refs.append(f"inner://epoch/{previous_epoch}/result")
        return tuple(dict.fromkeys(refs))

    @staticmethod
    def _compact_result(result: HarnessEpochResult) -> dict[str, Any]:
        return {
            "epoch": result.epoch,
            "accepted": result.accepted,
            "median_delta": result.median_delta,
            "paired_deltas": list(result.paired_deltas),
            "reasons": list(result.reasons),
            "excluded_pairs": list(result.excluded_pairs),
            "rubric_validation": result.rubric_validation,
        }

    def _validate_actions(
        self,
        raw_actions: Any,
        *,
        disclosed_ids: set[str],
        allowed_evidence_refs: set[str],
    ) -> tuple[TransformationLibraryAction, ...]:
        if not isinstance(raw_actions, list):
            raise TypeError("HPA transformation plan actions must be a list")
        if len(raw_actions) > self.max_structural_actions:
            raise ValueError("HPA transformation structural action limit exceeded")
        actions: list[TransformationLibraryAction] = []
        for raw in raw_actions:
            if not isinstance(raw, Mapping):
                raise TypeError("HPA transformation action must be an object")
            action = TransformationLibraryAction(
                action_id=str(raw.get("action_id", "")),
                operation=str(raw.get("library_operation", raw.get("operation", ""))),
                rationale=str(raw.get("rationale", "")),
                evidence_refs=tuple(str(item) for item in raw.get("evidence_refs", [])),
                payload=dict(raw.get("payload", {})),
            )
            invented = set(action.evidence_refs) - allowed_evidence_refs
            if invented:
                raise ValueError(
                    f"HPA action {action.action_id} cited undisclosed evidence: "
                    f"{sorted(invented)}"
                )
            if action.operation in {"delete", "modify"}:
                target = str(action.payload.get("transformation_id", ""))
                if target not in disclosed_ids:
                    raise ValueError(
                        f"HPA may not {action.operation} undisclosed transformation {target}"
                    )
            if action.operation == "merge":
                sources = {
                    str(item) for item in action.payload.get("source_ids", [])
                }
                if not sources <= disclosed_ids:
                    raise ValueError(
                        "HPA may not merge undisclosed transformations: "
                        f"{sorted(sources - disclosed_ids)}"
                    )
            actions.append(action)
        if sum(action.operation == "add" for action in actions) > self.max_additions:
            raise ValueError("HPA transformation addition limit exceeded")
        return tuple(actions)

    @staticmethod
    def _validate_harness_references(
        plan_template: Mapping[str, Any],
        catalog: Mapping[str, Any],
        *,
        allowed_source_harness_ids: set[str] | None = None,
    ) -> None:
        allowed = {
            "active_module_ids": {
                str(item["id"]) for item in catalog.get("modules", [])
            },
            "active_element_ids": {
                str(item.get("element_id", item.get("id")))
                for item in catalog.get("elements", [])
            },
            "active_cordis_plugins": {
                str(item["id"]) for item in catalog.get("cordis_plugins", [])
            },
            "tool_interface_ids": {
                str(item.get("interface_id", item.get("id")))
                for item in catalog.get("tool_interfaces", [])
            },
        }
        limits = dict(catalog.get("per_role_limits", {}))
        element_limits = dict(limits.get("elements", {}))
        element_categories = {
            str(item.get("element_id", item.get("id"))): str(
                item.get("category", "")
            )
            for item in catalog.get("elements", [])
        }

        def visit(value: Any) -> None:
            if isinstance(value, Mapping):
                for key, item in value.items():
                    if (
                        key == "source_harness_id"
                        and item is not None
                        and allowed_source_harness_ids is not None
                        and str(item) not in allowed_source_harness_ids
                    ):
                        raise ValueError(
                            "HPA role harness references unknown source_harness_id: "
                            f"{item}"
                        )
                    if key in allowed:
                        if not isinstance(item, list) or not all(
                            isinstance(component_id, str) for component_id in item
                        ):
                            raise ValueError(
                                f"HPA role harness field {key} must be a string list"
                            )
                        unknown = sorted(set(item) - allowed[key])
                        if unknown:
                            raise ValueError(
                                f"HPA transformation references unaudited {key}: {unknown}"
                            )
                        if key == "active_module_ids" and len(item) > int(
                            limits.get("modules", len(item))
                        ):
                            raise ValueError("HPA role harness exceeds module limit")
                        if key == "tool_interface_ids" and len(item) > int(
                            limits.get("tool_interfaces", len(item))
                        ):
                            raise ValueError(
                                "HPA role harness exceeds tool interface limit"
                            )
                        if key == "active_cordis_plugins" and len(item) > int(
                            element_limits.get("dsh_plugin", len(item))
                        ):
                            raise ValueError("HPA role harness exceeds dsh_plugin limit")
                        if key == "active_element_ids":
                            counts: dict[str, int] = {}
                            for element_id in item:
                                category = element_categories[element_id]
                                counts[category] = counts.get(category, 0) + 1
                            exceeded = sorted(
                                category
                                for category, count in counts.items()
                                if count > int(element_limits.get(category, count))
                            )
                            if exceeded:
                                raise ValueError(
                                    "HPA role harness exceeds element limits: "
                                    f"{exceeded}"
                                )
                    visit(item)
            elif isinstance(value, list):
                for item in value:
                    visit(item)

        visit(plan_template)

    @staticmethod
    def _validate_role_runtime_contract(
        circuit: AgentCircuit,
        catalog: Mapping[str, Any],
    ) -> None:
        contract = catalog.get("runtime_contract")
        if not isinstance(contract, Mapping):
            return
        fixed_calls = contract.get("model_calls_per_role_invocation")
        fixed_cost = contract.get("cost_units_per_role_invocation")
        for role in circuit.roles:
            if isinstance(fixed_calls, int) and (
                role.budget.max_model_calls != fixed_calls
            ):
                raise ValueError(
                    f"role {role.role_id} max_model_calls must equal runtime contract "
                    f"value {fixed_calls}; repeated invocations require explicit bounded "
                    "feedback edges"
                )
            if isinstance(fixed_cost, (int, float)) and abs(
                role.budget.cost_units - float(fixed_cost)
            ) > 1e-9:
                raise ValueError(
                    f"role {role.role_id} cost_units must equal runtime contract value "
                    f"{float(fixed_cost):g}"
                )

    @staticmethod
    def _has_imperfect_soft_score(result: HarnessEpochResult) -> bool:
        rubric = result.rubric_validation or {}
        if rubric.get("infrastructure_ok") is False:
            return False
        for case in rubric.get("case_results", []):
            if not isinstance(case, Mapping):
                continue
            candidate = case.get("candidate", {})
            if not isinstance(candidate, Mapping):
                continue
            soft = candidate.get("soft", {})
            if not isinstance(soft, Mapping):
                continue
            for value in soft.values():
                try:
                    if float(value) < 1.0:
                        return True
                except (TypeError, ValueError):
                    continue
        return False

    def _expands_current_circuit(
        self,
        transformation: HarnessTransformation,
        *,
        current_circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
    ) -> bool:
        try:
            transaction = self.compiler.compile(
                transformation,
                circuit=current_circuit,
                evidence_refs=evidence_refs,
                max_actions=self.max_circuit_actions,
            )
            candidate = CircuitMutationEngine().apply(current_circuit, transaction)
            validate_workspace_lineage(candidate)
        except (KeyError, TypeError, ValueError):
            return False
        return len(candidate.roles) > len(current_circuit.roles)

    def _library_has_structural_expansion(
        self,
        *,
        current_circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
    ) -> bool:
        return any(
            self._expands_current_circuit(
                transformation,
                current_circuit=current_circuit,
                evidence_refs=evidence_refs,
            )
            for transformation in self.store.catalog().values()
        )

    @staticmethod
    def _validate_publishable_terminal(circuit: AgentCircuit) -> None:
        roles = {role.role_id: role for role in circuit.roles}
        if any(
            workspace_artifact_kinds(role)
            for role in (roles[role_id] for role_id in circuit.terminal_role_ids)
        ):
            return
        raise ValueError(
            "candidate circuit has no terminal workspace artifact; declare a terminal "
            "output kind with output_artifact_modes[kind]=workspace"
        )

    @staticmethod
    def _validate_workspace_flow(circuit: AgentCircuit) -> None:
        validate_workspace_lineage(circuit)

    def _validate_required_structural_expansion(
        self,
        actions: tuple[TransformationLibraryAction, ...],
        *,
        current_circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
    ) -> None:
        candidates: list[HarnessTransformation] = []
        for action in actions:
            raw: Any = None
            if action.operation == "add":
                raw = action.payload.get("transformation")
            elif action.operation == "modify":
                raw = action.payload.get("replacement")
            elif action.operation == "merge":
                raw = action.payload.get("merged")
            if isinstance(raw, Mapping):
                candidates.append(HarnessTransformation.from_dict(raw))
        diagnostics: list[str] = []
        for transformation in candidates:
            if "single_agent" not in {
                signal.casefold() for signal in transformation.trigger_signals
            }:
                diagnostics.append(
                    f"{transformation.transformation_id}: trigger_signals lacks single_agent"
                )
                continue
            try:
                transaction = self.compiler.compile(
                    transformation,
                    circuit=current_circuit,
                    evidence_refs=evidence_refs,
                    max_actions=self.max_circuit_actions,
                )
                candidate = CircuitMutationEngine().apply(
                    current_circuit, transaction
                )
            except (KeyError, TypeError, ValueError) as exc:
                diagnostics.append(
                    f"{transformation.transformation_id}: {type(exc).__name__}: {exc}"
                )
                continue
            if len(candidate.roles) > len(current_circuit.roles):
                return
            diagnostics.append(
                f"{transformation.transformation_id}: candidate did not add roles"
            )
        detail = "; ".join(diagnostics[:3]) or "no complete transformation supplied"
        raise ValueError(
            "required singleton structural exploration is missing a valid applicable "
            f"single_agent expansion: {detail}"
        )

    def _materialize_bootstrap_plan(
        self,
        raw: Mapping[str, Any],
        *,
        current_circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
    ) -> dict[str, Any]:
        if len(current_circuit.roles) != 1:
            raise ValueError("structural bootstrap requires a singleton circuit")
        transformation_id = str(raw.get("id", "")).strip()
        name = str(raw.get("name", "")).strip()
        description = str(raw.get("description", "")).strip()
        rationale = str(raw.get("rationale", "")).strip()
        if not all((transformation_id, name, description, rationale)):
            received = sorted(str(key) for key in raw)
            raise ValueError(
                "bootstrap circuit requires id, name, description, and rationale; "
                f"received root keys {received}"
            )
        selected_evidence = tuple(
            str(item) for item in raw.get("evidence_refs", [])
        )
        if not selected_evidence:
            raise ValueError("bootstrap circuit requires evidence_refs")
        invented = sorted(set(selected_evidence) - set(evidence_refs))
        if invented:
            raise ValueError(
                f"bootstrap circuit cited undisclosed evidence: {invented}"
            )
        trigger_signals = tuple(
            str(item) for item in raw.get("trigger_signals", [])
        )
        if "single_agent" not in {
            signal.casefold() for signal in trigger_signals
        }:
            raise ValueError("bootstrap trigger_signals must include single_agent")

        raw_roles = raw.get("roles", [])
        if not isinstance(raw_roles, list) or len(raw_roles) < 2:
            raise ValueError("bootstrap circuit requires at least two roles")
        roles: list[dict[str, Any]] = []
        for index, item in enumerate(raw_roles, start=1):
            if not isinstance(item, Mapping):
                raise TypeError(f"bootstrap role {index} must be an object")
            role = dict(item)
            if role.get("workspace_access") not in {"read_only", "read_write"}:
                raise ValueError(
                    f"bootstrap role {index} requires workspace_access read_only/read_write"
                )
            contracts = role.pop("output_artifacts", None)
            if not isinstance(contracts, list) or not contracts:
                raise ValueError(
                    f"bootstrap role {index} requires output_artifacts contracts"
                )
            kinds: list[str] = []
            modes: dict[str, str] = {}
            for contract in contracts:
                if not isinstance(contract, Mapping):
                    raise TypeError("bootstrap output artifact contract must be an object")
                kind = str(contract.get("kind", "")).strip()
                mode = str(contract.get("mode", "")).strip()
                if not kind or mode not in {"inline", "workspace"}:
                    raise ValueError(
                        "bootstrap output artifact requires kind and mode inline/workspace"
                    )
                kinds.append(kind)
                modes[kind] = mode
            role["output_artifact_kinds"] = kinds
            role["output_artifact_modes"] = modes
            roles.append(role)

        raw_edges = raw.get("edges", [])
        if not isinstance(raw_edges, list):
            raise TypeError("bootstrap circuit edges must be a list")
        edges = [dict(item) for item in raw_edges]
        entry_role_ids = [str(item) for item in raw.get("entry_role_ids", [])]
        terminal_role_ids = [str(item) for item in raw.get("terminal_role_ids", [])]
        if not entry_role_ids or not terminal_role_ids:
            raise ValueError("bootstrap circuit requires entry and terminal role ids")
        policy = raw.get("policy")
        if not isinstance(policy, Mapping) or not policy:
            raise ValueError("bootstrap circuit requires an explicit bounded policy")
        policy_payload = {"inherit_current": True, **dict(policy)}
        source_role_id = current_circuit.roles[0].role_id
        split_id = "bootstrap_split_singleton"
        plan_template = {
            "shape": "declarative_circuit",
            "applicability": {"min_roles": 1, "max_roles": 1},
            "actions": [
                {
                    "action_id": split_id,
                    "operation": "split_role",
                    "rationale": rationale,
                    "payload": {
                        "source_role_id": source_role_id,
                        "replacement_roles": roles,
                        "replacement_edges": edges,
                        "entry_role_ids": entry_role_ids,
                        "terminal_role_ids": terminal_role_ids,
                    },
                },
                {
                    "action_id": "bootstrap_bound_policy",
                    "operation": "modify_policy",
                    "rationale": "Fund and bound the proposed evidence-linked circuit.",
                    "depends_on": [split_id],
                    "payload": {"replacement": policy_payload},
                },
            ],
        }
        transformation = {
            "id": transformation_id,
            "name": name,
            "description": description,
            "trigger_signals": list(trigger_signals),
            "supported_operations": ["split_role", "modify_policy"],
            "plan_template": plan_template,
            "tags": [str(item) for item in raw.get("tags", [])],
            "cost_prior": float(raw.get("cost_prior", 1.0)),
        }
        action_id = "add_" + re.sub(
            r"[^a-zA-Z0-9_]+", "_", transformation_id
        ).strip("_")
        return {
            "library_actions": [{
                "action_id": action_id,
                "library_operation": "add",
                "rationale": rationale,
                "evidence_refs": list(selected_evidence),
                "payload": {"transformation": transformation},
            }],
        }

    @staticmethod
    def _bootstrap_architecture(raw: Mapping[str, Any]) -> Mapping[str, Any]:
        """Accept a direct architecture or a plainly named architecture wrapper."""
        for key in ("architecture", "agent_circuit", "circuit"):
            value = raw.get(key)
            if isinstance(value, Mapping):
                return value
        return raw

    @staticmethod
    def _bootstrap_library_actions(raw: Mapping[str, Any]) -> Any | None:
        """Recognize the normal HPA library transaction contract at bootstrap."""
        if "library_actions" in raw:
            return raw.get("library_actions")
        # Older HPA responses used `actions` for the same outer transaction.
        actions = raw.get("actions")
        if isinstance(actions, list) and any(
            isinstance(item, Mapping)
            and ("library_operation" in item or "operation" in item)
            for item in actions
        ):
            return actions
        return None

    def _request_bootstrap_plan(
        self,
        *,
        current_circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
        harness_catalog: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "current_role": current_circuit.roles[0].to_dict(),
            "evidence_refs": list(evidence_refs),
            "safety_limits": self.compiler.planning_schema["safety_limits"],
            "audited_role_harness_catalog": harness_catalog,
            "schema": {
                "required": [
                    "id", "name", "description", "rationale", "evidence_refs",
                    "trigger_signals", "roles", "edges", "entry_role_ids",
                    "terminal_role_ids", "policy",
                ],
                "role_required": [
                    "role_id", "name", "kind", "objective", "system_prompt",
                    "workspace_access", "output_artifacts",
                ],
                "workspace_access": ["read_only", "read_write"],
                "output_artifact": {
                    "kind": "open identifier",
                    "mode": ["inline", "workspace"],
                },
                "edge_required": [
                    "edge_id", "source", "target", "kind", "instruction",
                    "protocol", "artifact_kinds",
                ],
                "edge_protocol": ["forward", "feedback"],
                "policy_required": [
                    "max_parallel_roles", "wall_timeout_seconds",
                    "max_total_model_calls", "max_total_cost_units",
                    "failure_mode", "workspace_mode",
                ],
                "failure_mode": [
                    "fail_fast", "continue_independent"
                ],
                "workspace_mode": ["isolated_then_merge", "shared"],
            },
            "task": (
                "Design one evidence-linked multi-role circuit that replaces the current "
                "singleton. Return the architecture object directly, not library_actions and "
                "not declarative mutation actions. Invent role identities, semantic kinds, "
                "objectives, prompts, topology, and typed communication from evidence; do not "
                "use a preset roster. Every required edge artifact must be an output_artifact "
                "of its source. At least one terminal output must use mode=workspace. Use "
                "protocol=feedback only for a bounded edge to an ancestor and include "
                "max_traversals. Omit harness_spec to inherit the current DSH unless evidence "
                "specifically supports a role-local difference. trigger_signals must include "
                "single_agent. Under isolated_then_merge, every non-terminal read_write role "
                "must publish a workspace-mode artifact, and required workspace-carrying forward "
                "edges must form a complete path from every writing branch to a terminal workspace "
                "publisher. A verifier or packager between them must republish the inherited "
                "workspace when later roles need those edits. Inline artifacts never apply file "
                "edits. read_only roles are runtime-enforced. "
                "Keep the object compact."
            ),
        }
        last_error: Exception | None = None
        raw: dict[str, Any] | None = None
        for attempt in range(3):
            stage = "bootstrap_circuit" if attempt == 0 else "bootstrap_circuit_repair"
            request = dict(payload)
            if raw is not None and last_error is not None:
                request.update(
                    invalid_architecture=raw,
                    validation_error=f"{type(last_error).__name__}: {last_error}",
                    task=(
                        payload["task"]
                        + " Repair the invalid architecture completely and return the full "
                        "architecture object again."
                    ),
                )
            raw = self.request_json(stage, request)
            try:
                raw_library_actions = self._bootstrap_library_actions(raw)
                if raw_library_actions is None:
                    plan = self._materialize_bootstrap_plan(
                        self._bootstrap_architecture(raw),
                        current_circuit=current_circuit,
                        evidence_refs=evidence_refs,
                    )
                else:
                    plan = {"library_actions": raw_library_actions}
                actions = self._validate_actions(
                    plan["library_actions"],
                    disclosed_ids=set(),
                    allowed_evidence_refs=set(evidence_refs),
                )
                self._validate_required_structural_expansion(
                    actions,
                    current_circuit=current_circuit,
                    evidence_refs=evidence_refs,
                )
                transformation = HarnessTransformation.from_dict(
                    actions[0].payload["transformation"]
                )
                transaction = self.compiler.compile(
                    transformation,
                    circuit=current_circuit,
                    evidence_refs=evidence_refs,
                    max_actions=self.max_circuit_actions,
                )
                candidate = CircuitMutationEngine().apply(
                    current_circuit, transaction
                )
                self._validate_publishable_terminal(candidate)
                self._validate_workspace_flow(candidate)
                if harness_catalog is not None:
                    self._validate_role_runtime_contract(candidate, harness_catalog)
                    self._validate_harness_references(
                        transformation.plan_template,
                        harness_catalog,
                        allowed_source_harness_ids={
                            role.harness_spec.source_harness_id
                            for role in current_circuit.roles
                            if role.harness_spec is not None
                            and role.harness_spec.source_harness_id is not None
                        },
                    )
                return plan
            except (KeyError, TypeError, ValueError) as exc:
                last_error = exc
        assert last_error is not None
        raise last_error

    def evolve(
        self,
        *,
        epoch: int,
        inner_history: list[dict[str, Any]],
        latest_inner_result: HarnessEpochResult,
        current_circuit: AgentCircuit,
        harness_catalog: Mapping[str, Any] | None = None,
    ) -> TransformationLibraryUpdate:
        revision = self.store.revision()
        evidence_refs = self._evidence_refs(
            latest=latest_inner_result,
            inner_history=inner_history,
        )
        structural_exploration_required = (
            len(current_circuit.roles) == 1
            and self._has_imperfect_soft_score(latest_inner_result)
            and not self._library_has_structural_expansion(
                current_circuit=current_circuit,
                evidence_refs=evidence_refs,
            )
        )
        quarantine_issues = self.store.quarantine_issues(
            circuit_id=current_circuit.circuit_id
        )
        record: dict[str, Any] = {
            "schema_version": "hpa-transformation-evolution.v1",
            "epoch": epoch,
            "status": "shortlisting",
            "revision_before": revision,
            "revision_after": revision,
            "catalog_index": self.store.progressive_index(),
            "shortlist": [],
            "disclosed": [],
            "evidence_refs": list(evidence_refs),
            "current_circuit": current_circuit.to_dict(),
            "audited_role_harness_catalog": (
                None if harness_catalog is None else dict(harness_catalog)
            ),
            "latest_inner_result": self._compact_result(latest_inner_result),
            "structural_exploration_required": structural_exploration_required,
            "catalog_validation_issues": list(quarantine_issues),
            "plan": None,
            "created_at": utc_now(),
        }
        self.store.write_epoch_record(epoch, record)
        try:
            all_ids = {str(item["id"]) for item in record["catalog_index"]}
            shortlist_response = (
                {
                    "shortlist": [],
                    "addition_needed": structural_exploration_required,
                    "rationale": "transformation library is empty",
                }
                if not all_ids
                else self.request_json(
                    "shortlist",
                    {
                        "catalog_index": record["catalog_index"],
                        "current_circuit": record["current_circuit"],
                        "latest_inner_result": record["latest_inner_result"],
                        "evidence_refs": list(evidence_refs),
                        "catalog_validation_issues": list(quarantine_issues),
                        "limit": min(self.shortlist_limit, len(all_ids)),
                        "task": (
                            "Select only exact IDs from catalog_index worth inspecting for "
                            "delete, modify, or merge. Return {shortlist:[exact ids], "
                            "addition_needed:boolean,rationale:string}. A valid ACCEPT below "
                            "a perfect rubric score remains improvement evidence. This stage "
                            "does not select role harness components and must not invent or "
                            "infer undisclosed transformation plans."
                        ),
                    },
                )
            )
            raw_shortlist = shortlist_response.get("shortlist", [])
            if not isinstance(raw_shortlist, list):
                raise TypeError("HPA transformation shortlist must be a list")
            shortlist = tuple(dict.fromkeys(str(item) for item in raw_shortlist))
            if len(shortlist) > self.shortlist_limit:
                raise ValueError("HPA transformation shortlist limit exceeded")
            unknown = set(shortlist) - all_ids
            if unknown:
                raise ValueError(
                    f"HPA transformation shortlist contains unknown ids: {sorted(unknown)}"
                )
            disclosed = tuple(self.store.details(shortlist))
            record.update(
                status="planning",
                shortlist=list(shortlist),
                disclosed=list(disclosed),
                shortlist_response=shortlist_response,
            )
            self.store.write_epoch_record(epoch, record)
            plan_payload = {
                "supported_plan_shapes": ["declarative_circuit"],
                "declarative_circuit_schema": self.compiler.planning_schema,
                "disclosed_transformations": list(disclosed),
                "current_circuit": record["current_circuit"],
                "audited_role_harness_catalog": record[
                    "audited_role_harness_catalog"
                ],
                "latest_inner_result": record["latest_inner_result"],
                "structural_exploration_required": structural_exploration_required,
                "evidence_refs": list(evidence_refs),
                "catalog_validation_issues": list(quarantine_issues),
                        "task": (
                            "Return {library_actions:[...],no_change_rationale:string}. Each "
                            "OUTER library action requires "
                    "action_id, library_operation (add/delete/modify/merge), rationale, and "
                    "evidence_refs chosen exactly from "
                    "the supplied list, and payload matching the transaction store schema. "
                    "Existing transformations may be changed only when disclosed. A merge must "
                    "name at least two distinct disclosed exact source_ids. Every add, modify, "
                    "or merge must contain a complete transformation whose plan_template uses a "
                    "supported_plan_shape. Prefer declarative_circuit when proposing a topology "
                    "that is not already represented: choose role identities, prompts, tools, "
                    "budgets, fork/fan-in edges, typed artifact handoffs, and bounded feedback "
                    "from evidence instead of assuming a fixed studio roster. Role-local "
                    "artifact kinds are open: set output_artifact_modes[kind]=workspace for a "
                    "role that publishes its workspace, otherwise inline publishes its final "
                    "response. At least one terminal role must publish a workspace artifact. In "
                    "isolated_then_merge mode, every non-terminal writing branch must have a "
                    "complete path of required workspace artifact handoffs to a terminal workspace "
                    "publisher; an inline report does not transfer prior file edits. Treat supplied "
                    "catalog_validation_issues as evidence to modify, replace, or supersede an "
                    "invalid transformation rather than repeating it. "
                    "harness_spec and tool_interface_ids may use only exact IDs from the "
                    "audited_role_harness_catalog; omitted harness_spec inherits the current "
                    "champion harness. If the catalog includes runtime_contract, obey its "
                    "per-invocation accounting exactly: larger role budgets do not create "
                    "extra work, while bounded feedback edges can repeat a role. Use at most "
                    f"{self.max_structural_actions} actions and {self.max_additions} additions. "
                    "When the disclosed library is empty, return at most one addition whose "
                    "declarative plan contains at most three circuit actions. Keep all strings "
                    "concise and never echo the supplied schema or catalog. "
                    "Return an empty actions list only when evidence does not justify a "
                    "change; when any transformation was disclosed, a non-empty "
                    "no_change_rationale is required for that decision. "
                    "For add, payload MUST be {transformation:{id,name,description,"
                    "trigger_signals,supported_operations,plan_template,tags,cost_prior}}. "
                    "Only plan_template.actions may contain INNER circuit operations such as "
                    "split_role, add_role, add_edge, or modify_policy. The root JSON object "
                    "MUST be {\"library_actions\":[...]}; never put a circuit operation at "
                    "the outer level and never return a bare role, edge, circuit action, or "
                    "transformation. "
                    + (
                        "Structural exploration is required this epoch because the current "
                        "champion is a singleton, soft quality is imperfect, and the library "
                        "has no applicable expansion. Add one evidence-linked transformation "
                        "triggered by single_agent that compiles the current circuit to more "
                        "than one role. Split children automatically inherit the current DSH; "
                        "omit harness_spec for inherited children unless the disclosed evidence "
                        "specifically justifies a role-local component difference. This requires "
                        "trying a candidate, never accepting it."
                        if structural_exploration_required
                        else ""
                    )
                ),
            }
            plan = (
                self._request_bootstrap_plan(
                    current_circuit=current_circuit,
                    evidence_refs=evidence_refs,
                    harness_catalog=harness_catalog,
                )
                if structural_exploration_required and not all_ids
                else self.request_json("plan", plan_payload)
            )
            applied: dict[str, Any] | None = None
            actions: tuple[TransformationLibraryAction, ...] = ()
            for plan_attempt in range(3):
                try:
                    raw_library_actions = plan.get(
                        "library_actions", plan.get("actions")
                    )
                    if raw_library_actions is None:
                        raise ValueError(
                            "HPA transformation plan root must contain library_actions"
                        )
                    actions = self._validate_actions(
                        raw_library_actions,
                        disclosed_ids=set(shortlist),
                        allowed_evidence_refs=set(evidence_refs),
                    )
                    if disclosed and not actions and not str(
                        plan.get("no_change_rationale", "")
                    ).strip():
                        raise ValueError(
                            "an empty HPA transformation plan with disclosed entries "
                            "requires no_change_rationale"
                        )
                    if structural_exploration_required:
                        self._validate_required_structural_expansion(
                            actions,
                            current_circuit=current_circuit,
                            evidence_refs=evidence_refs,
                        )
                    if actions:
                        def validate_transformation(transformation) -> None:
                            if transformation.plan_template.get("shape") != "declarative_circuit":
                                raise ValueError(
                                    "new HPA transformations must use declarative_circuit; "
                                    "fixed role-shape compilers are legacy replay only"
                                )
                            self.compiler.validate_library_entry(
                                transformation,
                                additional_circuits=(current_circuit,),
                            )
                            transaction = self.compiler.compile(
                                transformation,
                                circuit=current_circuit,
                                evidence_refs=evidence_refs,
                                max_actions=self.max_circuit_actions,
                            )
                            candidate_circuit = CircuitMutationEngine().apply(
                                current_circuit, transaction
                            )
                            self._validate_publishable_terminal(candidate_circuit)
                            self._validate_workspace_flow(candidate_circuit)
                            if harness_catalog is not None:
                                self._validate_role_runtime_contract(
                                    candidate_circuit, harness_catalog
                                )
                                self._validate_harness_references(
                                    transformation.plan_template,
                                    harness_catalog,
                                    allowed_source_harness_ids={
                                        role.harness_spec.source_harness_id
                                        for role in current_circuit.roles
                                        if role.harness_spec is not None
                                        and role.harness_spec.source_harness_id is not None
                                    },
                                )

                        applied = self.store.apply_actions(
                            epoch=epoch,
                            actions=actions,
                            max_actions=self.max_structural_actions,
                            max_additions=self.max_additions,
                            validate_transformation=validate_transformation,
                        )
                    break
                except (KeyError, TypeError, ValueError) as exc:
                    if plan_attempt == 2:
                        raise
                    record.update(plan=plan, plan_validation_error=f"{type(exc).__name__}: {exc}")
                    self.store.write_epoch_record(epoch, record)
                    plan = self.request_json(
                        "plan_repair",
                        {
                            "supported_plan_shapes": ["declarative_circuit"],
                            "outer_action_contract": {
                                "root_required": ["library_actions"],
                                "action_required": [
                                    "action_id",
                                    "library_operation",
                                    "rationale",
                                    "evidence_refs",
                                    "payload",
                                ],
                                "library_operations": {
                                    "add": {
                                        "payload_required": ["transformation"],
                                    },
                                    "delete": {
                                        "payload_required": ["transformation_id"],
                                    },
                                    "modify": {
                                        "payload_required": [
                                            "transformation_id",
                                            "replacement",
                                        ],
                                    },
                                    "merge": {
                                        "payload_required": ["source_ids", "merged"],
                                    },
                                },
                                "transformation_required": [
                                    "id",
                                    "name",
                                    "description",
                                    "trigger_signals",
                                    "supported_operations",
                                    "plan_template",
                                    "tags",
                                    "cost_prior",
                                ],
                            },
                            "declarative_circuit_schema": self.compiler.planning_schema,
                            "disclosed_transformation_ids": list(shortlist),
                            "role_runtime_contract": (harness_catalog or {}).get(
                                "runtime_contract"
                            ),
                            "current_circuit": {
                                "circuit_id": current_circuit.circuit_id,
                                "role_ids": [
                                    role.role_id for role in current_circuit.roles
                                ],
                                "role_kinds": [
                                    role.kind for role in current_circuit.roles
                                ],
                            },
                            "allowed_role_harness_ids": {
                                "modules": [
                                    item["id"]
                                    for item in (harness_catalog or {}).get(
                                        "modules", []
                                    )
                                ],
                                "elements": [
                                    item.get("element_id", item.get("id"))
                                    for item in (harness_catalog or {}).get(
                                        "elements", []
                                    )
                                ],
                                "tool_interfaces": [
                                    item.get("interface_id", item.get("id"))
                                    for item in (harness_catalog or {}).get(
                                        "tool_interfaces", []
                                    )
                                ],
                                "cordis_plugins": [
                                    item["id"]
                                    for item in (harness_catalog or {}).get(
                                        "cordis_plugins", []
                                    )
                                ],
                            },
                            "evidence_refs": list(evidence_refs),
                            "structural_exploration_required": structural_exploration_required,
                            "invalid_plan": plan,
                            "validation_error": f"{type(exc).__name__}: {exc}",
                            "task": (
                                "Repair the supplied invalid plan. Preserve the disclosed-id, "
                                "evidence, action, and addition limits. Return "
                                "one JSON object whose required root key is library_actions; its "
                                "value must be a real JSON array, never an ellipsis or schema "
                                "placeholder. Every OUTER action must contain all fields in "
                                "outer_action_contract.action_required. Put the transformation "
                                "only under payload using the exact operation-specific payload "
                                "contract. OUTER library_operation is one of "
                                "add/delete/modify/merge. INNER add_role/split_role/add_edge/"
                                "modify_policy operations belong only inside "
                                "payload.transformation.plan_template.actions. For an add, emit "
                                "the complete transformation object. For modify, preserve an exact "
                                "disclosed transformation id in both payload.transformation_id and "
                                "payload.replacement.id. Cite only exact supplied evidence_refs; "
                                "validation errors and stage names are not evidence or trigger "
                                "signals. Use only operations admitted by declarative_circuit_schema. "
                                "Respect role_runtime_contract exactly: per-role model-call and "
                                "cost ceilings do not create extra work; use bounded feedback edges "
                                "when evidence justifies repeated role invocation. "
                                "Simplify rather than expand: "
                                "split children inherit the current role automatically, so omit "
                                "harness_spec unless repairing an evidence-backed component delta. "
                                "Every required edge artifact must be declared by its source role. "
                                "At least one terminal output must set "
                                "output_artifact_modes[kind]=workspace so the game is publishable. "
                                "Use an empty list only when structural_exploration_required is "
                                "false and no valid repair exists; then include a non-empty root "
                                "no_change_rationale grounded in disclosed stats and evidence."
                            ),
                        },
                    )
                    record["plan_repair"] = plan
            if not actions:
                record.update(
                    status="unchanged",
                    plan=plan,
                    revision_after=revision,
                    completed_at=utc_now(),
                )
                self.store.write_epoch_record(epoch, record)
                return TransformationLibraryUpdate(
                    epoch,
                    "unchanged",
                    revision,
                    revision,
                    shortlist,
                    disclosed,
                )
            assert applied is not None
            action_payloads = tuple(
                {
                    "action_id": action.action_id,
                    "operation": action.operation,
                    "rationale": action.rationale,
                    "evidence_refs": list(action.evidence_refs),
                    "payload": action.payload,
                }
                for action in actions
            )
            record.update(
                status="applied",
                plan=plan,
                actions=list(action_payloads),
                revision_after=int(applied["revision_after"]),
                completed_at=utc_now(),
            )
            self.store.write_epoch_record(epoch, record)
            return TransformationLibraryUpdate(
                epoch,
                "applied",
                revision,
                int(applied["revision_after"]),
                shortlist,
                disclosed,
                action_payloads,
            )
        except Exception as exc:  # noqa: BLE001 - isolate HPA metadata evolution.
            error = f"{type(exc).__name__}: {exc}"
            record.update(
                status="failed_infrastructure_or_validation",
                error=error,
                revision_after=self.store.revision(),
                completed_at=utc_now(),
            )
            self.store.write_epoch_record(epoch, record)
            return TransformationLibraryUpdate(
                epoch,
                "failed_infrastructure_or_validation",
                revision,
                self.store.revision(),
                tuple(str(item) for item in record.get("shortlist", [])),
                tuple(record.get("disclosed", [])),
                error=error,
            )
