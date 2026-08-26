from __future__ import annotations

from dataclasses import replace
from typing import Any, Callable, Mapping

from game_loop.core.agent_circuit import (
    AgentBudget,
    AgentCircuit,
    AgentContextPolicy,
    AgentRole,
    CircuitEdge,
    CircuitPolicy,
)
from game_loop.core.agent_circuit_evolution import (
    CircuitMutationAction,
    CircuitMutationEngine,
    CircuitMutationTransaction,
)
from game_loop.core.harness_transformation_library import HarnessTransformation


class TransformationNotApplicable(ValueError):
    """The transformation is valid, but its preconditions do not match this circuit."""


class HarnessTransformationCompiler:
    """Compile reusable HPA transformation plans into executable GOA transactions."""

    _SHAPES = {
        "declarative_circuit",
        "composite",
        "director_parallel_specialists_integrator_critic",
        "critic_feedback",
        "parallel_fanout_fanin",
        "merged_specialist",
        "typed_artifact_mailbox",
    }

    def __init__(
        self,
        *,
        max_roles: int = 8,
        max_total_model_calls: int = 12,
        max_total_cost_units: float = 12.0,
        max_feedback_traversals: int = 3,
    ) -> None:
        if min(max_roles, max_total_model_calls, max_feedback_traversals) < 1:
            raise ValueError("circuit compiler safety limits must be positive")
        if max_total_cost_units <= 0:
            raise ValueError("circuit compiler cost limit must be positive")
        self.max_roles = max_roles
        self.max_total_model_calls = max_total_model_calls
        self.max_total_cost_units = float(max_total_cost_units)
        self.max_feedback_traversals = max_feedback_traversals
        self._compilers: dict[str, Callable[..., CircuitMutationTransaction]] = {
            "declarative_circuit": self._declarative_circuit,
            "composite": self._composite,
            "director_parallel_specialists_integrator_critic": self._studio,
            "critic_feedback": self._critic_feedback,
            "parallel_fanout_fanin": self._parallel_fanout_fanin,
            "merged_specialist": self._merge_specialists,
            "typed_artifact_mailbox": self._typed_artifact_mailbox,
        }

    @property
    def supported_shapes(self) -> tuple[str, ...]:
        return tuple(sorted(self._SHAPES))

    @property
    def planning_schema(self) -> dict[str, Any]:
        return {
            "preferred_shape": "declarative_circuit",
            "shape": "declarative_circuit",
            "applicability": {
                "min_roles": "optional integer",
                "max_roles": "optional integer",
                "required_role_ids": "optional string list",
                "forbidden_role_ids": "optional string list",
                "required_role_kinds": "optional string list",
                "forbidden_role_kinds": "optional string list",
            },
            "selectors": ["$primary", "$entry", "$terminal", "$kind:<role-kind>"],
            "role_schema": {
                "required": ["role_id", "name", "kind", "objective", "system_prompt"],
                "kind": (
                    "open semantic identifier chosen from evidence; it is not a fixed roster. "
                    "Custom kinds should declare output_artifact_kinds explicitly"
                ),
                "optional": [
                    "inherit_from", "capabilities", "tool_interface_ids",
                    "output_artifact_kinds", "output_artifact_modes", "workspace_access", "harness_spec", "context", "budget",
                    "provider", "model",
                ],
                "harness_spec": [
                    "source_harness_id", "active_module_ids", "active_element_ids",
                    "active_cordis_plugins",
                ],
                "output_artifact_modes": {
                    "inline": "publish final-response content",
                    "workspace": "publish the role workspace snapshot",
                },
                "workspace_access": ["read_only", "read_write"],
                "context_modes": ["task_only", "parent_summary", "selected_artifacts", "shared"],
                "context": ["mode", "include_artifact_kinds", "max_input_chars", "max_output_chars"],
                "budget": ["max_model_calls", "max_tokens", "timeout_seconds", "cost_units"],
            },
            "edge_schema": {
                "required": ["edge_id", "source", "target", "kind", "instruction"],
                "kind": "open semantic identifier chosen from the handoff purpose",
                "protocol": {
                    "forward": "one-way DAG handoff",
                    "feedback": "bounded return edge to an ancestor",
                },
                "optional": [
                    "protocol", "artifact_kinds", "required", "max_traversals"
                ],
            },
            "operation_payloads": {
                "add_role": {"role": "role", "entry": "bool?", "terminal": "bool?", "incident_edges": "edge[]?"},
                "delete_role": {"role_id": "role id or selector"},
                "modify_role": {"role_id": "role id or selector", "replacement": "role"},
                "split_role": {"source_role_id": "role id or selector", "replacement_roles": "role[2+]", "replacement_edges": "edge[]", "entry_role_ids": "string[]", "terminal_role_ids": "string[]"},
                "merge_roles": {"source_role_ids": "string[2+]", "merged_role": "role", "replacement_edges": "edge[]"},
                "add_edge": {"edge": "edge"},
                "delete_edge": {"edge_id": "existing edge id"},
                "modify_edge": {"edge_id": "existing edge id", "replacement": "edge"},
                "modify_policy": {"replacement": "full policy or {inherit_current:true,...overrides}"},
                "modify_boundaries": {"entry_role_ids": "string[]", "terminal_role_ids": "string[]"},
            },
            "safety_limits": {
                "max_roles": self.max_roles,
                "max_total_model_calls": self.max_total_model_calls,
                "max_total_cost_units": self.max_total_cost_units,
                "max_feedback_traversals": self.max_feedback_traversals,
            },
            "actions": {
                "type": "ordered list",
                "item": {
                    "action_id": "unique string",
                    "operation": "one supported circuit mutation operation",
                    "rationale": "evidence-linked explanation",
                    "depends_on": "optional prior action_id list",
                    "payload": "normal CircuitMutationAction payload",
                },
                "role_inheritance": (
                    "A role object may set inherit_from to a selector or role id; "
                    "supplied fields override the inherited role, context/budget merge deeply, "
                    "and output_artifact_kinds declares typed outputs available to edges."
                ),
                "policy_inheritance": (
                    "modify_policy replacement may set inherit_current:true and override fields."
                ),
            },
        }

    def validate_template(self, transformation: HarnessTransformation) -> None:
        template = transformation.plan_template
        shape = str(template.get("shape", "")).strip()
        if shape not in self._SHAPES:
            raise ValueError(
                f"transformation {transformation.transformation_id} has no executable "
                f"compiler for shape {shape!r}; supported shapes: {sorted(self._SHAPES)}"
            )
        if shape == "critic_feedback":
            traversals = int(template.get("max_traversals", 1))
            if not 1 <= traversals <= 3:
                raise ValueError("critic feedback max_traversals must be within 1..3")
        if shape == "parallel_fanout_fanin":
            branches = int(template.get("branches", 2))
            if not 2 <= branches <= 3:
                raise ValueError("parallel specialist branches must be within 2..3")
        if shape == "declarative_circuit":
            applicability = template.get("applicability", {})
            if not isinstance(applicability, Mapping):
                raise ValueError("declarative circuit applicability must be an object")
            actions = template.get("actions", [])
            if not isinstance(actions, list) or not actions:
                raise ValueError("declarative circuit requires a non-empty actions list")
            if len(actions) > 8:
                raise ValueError("declarative circuit may contain at most 8 actions")
            action_ids: list[str] = []
            for index, raw_action in enumerate(actions, start=1):
                if not isinstance(raw_action, Mapping):
                    raise ValueError(f"declarative action {index} must be an object")
                action_id = str(raw_action.get("action_id", "")).strip()
                operation = str(raw_action.get("operation", "")).strip()
                rationale = str(raw_action.get("rationale", "")).strip()
                payload = raw_action.get("payload")
                if not action_id or not rationale or not isinstance(payload, Mapping) or not payload:
                    raise ValueError(
                        f"declarative action {index} requires action_id, rationale, and payload"
                    )
                if operation not in transformation.supported_operations:
                    raise ValueError(
                        f"declarative action {action_id} uses undeclared operation {operation}"
                    )
                action_ids.append(action_id)
            if len(action_ids) != len(set(action_ids)):
                raise ValueError("declarative circuit action ids must be unique")
            known: set[str] = set()
            for raw_action in actions:
                action_id = str(raw_action["action_id"])
                dependencies = tuple(
                    str(item) for item in raw_action.get("depends_on", [])
                )
                unknown = set(dependencies) - known
                if unknown:
                    raise ValueError(
                        f"declarative action {action_id} dependencies must reference prior "
                        f"actions: {sorted(unknown)}"
                    )
                known.add(action_id)
        if shape == "composite":
            steps = template.get("steps", [])
            if not isinstance(steps, list) or not 2 <= len(steps) <= 2:
                raise ValueError("composite transformation requires exactly two steps")
            for index, step in enumerate(steps, start=1):
                if not isinstance(step, Mapping):
                    raise ValueError(f"composite step {index} must be an object")
                step_shape = str(step.get("shape", ""))
                if step_shape not in self._SHAPES - {"composite"}:
                    raise ValueError(
                        f"composite step {index} has unsupported shape {step_shape!r}"
                    )
                probe = HarnessTransformation(
                    transformation_id=f"composite_step_{index}",
                    name=f"Composite step {index}",
                    description="Validate one executable composite step.",
                    trigger_signals=("composite",),
                    supported_operations=tuple(sorted(transformation.supported_operations)),
                    plan_template=dict(step),
                )
                self.validate_template(probe)

    def validate_library_entry(
        self,
        transformation: HarnessTransformation,
        *,
        additional_circuits: tuple[AgentCircuit, ...] = (),
    ) -> None:
        """Prove an admitted library element compiles on at least one canonical circuit."""

        self.validate_template(transformation)
        singleton = AgentCircuit.singleton()
        studio_seed = HarnessTransformation(
            transformation_id="compiler_fixture_studio",
            name="Compiler fixture studio",
            description="Build the canonical validation studio fixture.",
            trigger_signals=("fixture",),
            supported_operations=("split_role", "modify_policy"),
            plan_template={
                "shape": "director_parallel_specialists_integrator_critic"
            },
        )
        studio_tx = self.compile(
            studio_seed,
            circuit=singleton,
            evidence_refs=("fixture://singleton",),
        )
        studio = CircuitMutationEngine().apply(singleton, studio_tx)
        errors: list[str] = []
        for fixture in (*additional_circuits, singleton, studio):
            try:
                self.compile(
                    transformation,
                    circuit=fixture,
                    evidence_refs=("fixture://compiler-validation",),
                )
                return
            except TransformationNotApplicable as exc:
                errors.append(str(exc))
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(
                    f"transformation {transformation.transformation_id} failed "
                    f"compiler validation: {type(exc).__name__}: {exc}"
                ) from exc
        raise ValueError(
            f"transformation {transformation.transformation_id} is not applicable "
            f"to canonical singleton or studio fixtures: {errors}"
        )

    def compile(
        self,
        transformation: HarnessTransformation,
        *,
        circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
        max_actions: int = 4,
    ) -> CircuitMutationTransaction:
        self.validate_template(transformation)
        shape = str(transformation.plan_template["shape"])
        transaction = self._compilers[shape](
            transformation=transformation,
            circuit=circuit,
            evidence_refs=evidence_refs or ("attribution://current-run",),
            max_actions=max_actions,
        )
        unsupported = {
            action.operation for action in transaction.actions
        } - set(transformation.supported_operations)
        if unsupported:
            raise ValueError(
                f"transformation {transformation.transformation_id} compiled undeclared "
                f"operations: {sorted(unsupported)}"
            )
        candidate = CircuitMutationEngine().apply(circuit, transaction)
        self._validate_candidate_limits(candidate)
        return transaction

    def _validate_candidate_limits(self, candidate: AgentCircuit) -> None:
        if len(candidate.roles) > self.max_roles:
            raise ValueError(
                f"candidate circuit roles {len(candidate.roles)} exceed safety limit "
                f"{self.max_roles}"
            )
        if candidate.policy.max_total_model_calls > self.max_total_model_calls:
            raise ValueError(
                "candidate circuit model-call budget exceeds compiler safety limit"
            )
        if candidate.policy.max_total_cost_units > self.max_total_cost_units:
            raise ValueError("candidate circuit cost budget exceeds compiler safety limit")
        if any(
            edge.is_feedback
            and edge.max_traversals > self.max_feedback_traversals
            for edge in candidate.edges
        ):
            raise ValueError("candidate circuit feedback traversal exceeds safety limit")

    def _declarative_circuit(
        self,
        *,
        transformation: HarnessTransformation,
        circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
        max_actions: int,
    ) -> CircuitMutationTransaction:
        template = transformation.plan_template
        self._check_applicability(template.get("applicability", {}), circuit)
        raw_actions = list(template.get("actions", []))
        if len(raw_actions) > max_actions:
            raise ValueError(
                f"declarative transformation compiles to {len(raw_actions)} actions, "
                f"exceeding limit {max_actions}"
            )
        actions: list[CircuitMutationAction] = []
        for raw in raw_actions:
            actions.append(
                self._materialize_declarative_action(dict(raw), circuit)
            )
        return CircuitMutationTransaction(
            parent_circuit_id=circuit.circuit_id,
            hypothesis=transformation.description,
            evidence_refs=evidence_refs,
            actions=tuple(actions),
            transformation_ids=(transformation.transformation_id,),
            max_actions=max_actions,
        )

    @staticmethod
    def _check_applicability(raw: Any, circuit: AgentCircuit) -> None:
        applicability = dict(raw or {})
        role_count = len(circuit.roles)
        if role_count < int(applicability.get("min_roles", 0)):
            raise TransformationNotApplicable("circuit has too few roles")
        if role_count > int(applicability.get("max_roles", 10**6)):
            raise TransformationNotApplicable("circuit has too many roles")
        role_ids = {role.role_id for role in circuit.roles}
        role_kinds = {role.kind for role in circuit.roles}
        checks = (
            ("required_role_ids", role_ids, True),
            ("forbidden_role_ids", role_ids, False),
            ("required_role_kinds", role_kinds, True),
            ("forbidden_role_kinds", role_kinds, False),
        )
        for key, available, required in checks:
            wanted = {str(item) for item in applicability.get(key, [])}
            if required and not wanted <= available:
                raise TransformationNotApplicable(f"missing {key}: {sorted(wanted - available)}")
            if not required and wanted & available:
                raise TransformationNotApplicable(f"matched forbidden {key}: {sorted(wanted & available)}")

    def _materialize_declarative_action(
        self,
        raw: dict[str, Any],
        circuit: AgentCircuit,
    ) -> CircuitMutationAction:
        operation = str(raw["operation"])
        payload = dict(raw["payload"])
        if operation == "add_role":
            payload["role"] = self._materialize_role(payload["role"], circuit)
            payload["incident_edges"] = [
                self._materialize_edge(item, circuit)
                for item in payload.get("incident_edges", [])
            ]
        elif operation == "delete_role":
            payload["role_id"] = self._resolve_role(payload["role_id"], circuit)
        elif operation == "modify_role":
            role_id = self._resolve_role(payload["role_id"], circuit)
            replacement = dict(payload["replacement"])
            replacement.setdefault("inherit_from", role_id)
            payload.update(
                role_id=role_id,
                replacement=self._materialize_role(replacement, circuit),
            )
        elif operation == "split_role":
            source = self._resolve_role(payload["source_role_id"], circuit)
            payload["source_role_id"] = source
            payload["replacement_roles"] = [
                self._materialize_role(
                    {"inherit_from": source, **dict(item)}, circuit
                )
                for item in payload.get("replacement_roles", [])
            ]
            payload["replacement_edges"] = [
                self._materialize_edge(item, circuit)
                for item in payload.get("replacement_edges", [])
            ]
            payload["entry_role_ids"] = [
                self._resolve_role(item, circuit, allow_new=True)
                for item in payload.get("entry_role_ids", [])
            ]
            payload["terminal_role_ids"] = [
                self._resolve_role(item, circuit, allow_new=True)
                for item in payload.get("terminal_role_ids", [])
            ]
        elif operation == "merge_roles":
            source_ids = [
                self._resolve_role(item, circuit)
                for item in payload.get("source_role_ids", [])
            ]
            merged = dict(payload["merged_role"])
            if source_ids:
                merged.setdefault("inherit_from", source_ids[0])
            payload["source_role_ids"] = source_ids
            payload["merged_role"] = self._materialize_role(merged, circuit)
            payload["replacement_edges"] = [
                self._materialize_edge(item, circuit)
                for item in payload.get("replacement_edges", [])
            ]
        elif operation == "add_edge":
            payload["edge"] = self._materialize_edge(payload["edge"], circuit)
        elif operation == "modify_edge":
            edge_id = str(payload["edge_id"])
            existing = next(
                (edge.to_dict() for edge in circuit.edges if edge.edge_id == edge_id),
                None,
            )
            if existing is None:
                raise TransformationNotApplicable(f"unknown edge {edge_id}")
            payload["replacement"] = self._materialize_edge(
                {**existing, **dict(payload["replacement"])}, circuit
            )
        elif operation == "modify_policy":
            replacement = dict(payload["replacement"])
            inherit = bool(replacement.pop("inherit_current", False))
            if inherit:
                replacement = {**circuit.policy.to_dict(), **replacement}
            payload["replacement"] = CircuitPolicy.from_dict(replacement).to_dict()
        elif operation == "modify_boundaries":
            payload["entry_role_ids"] = [
                self._resolve_role(item, circuit)
                for item in payload.get("entry_role_ids", [])
            ]
            payload["terminal_role_ids"] = [
                self._resolve_role(item, circuit)
                for item in payload.get("terminal_role_ids", [])
            ]
        return CircuitMutationAction(
            action_id=str(raw["action_id"]),
            operation=operation,
            rationale=str(raw["rationale"]),
            payload=payload,
            depends_on=tuple(str(item) for item in raw.get("depends_on", [])),
        )

    def _materialize_role(
        self,
        raw: Mapping[str, Any],
        circuit: AgentCircuit,
    ) -> dict[str, Any]:
        value = dict(raw)
        inherit_from = value.pop("inherit_from", None)
        if inherit_from is None:
            return AgentRole.from_dict(value).to_dict()
        source_id = self._resolve_role(inherit_from, circuit)
        source = next(role for role in circuit.roles if role.role_id == source_id)
        result = source.to_dict()
        for nested in ("context", "budget", "harness_spec"):
            if nested in value:
                value[nested] = {
                    **dict(result.get(nested) or {}),
                    **dict(value[nested]),
                }
        result.update(value)
        return AgentRole.from_dict(result).to_dict()

    def _materialize_edge(
        self,
        raw: Mapping[str, Any],
        circuit: AgentCircuit,
    ) -> dict[str, Any]:
        value = dict(raw)
        value["source"] = self._resolve_role(value["source"], circuit, allow_new=True)
        value["target"] = self._resolve_role(value["target"], circuit, allow_new=True)
        return CircuitEdge.from_dict(value).to_dict()

    @staticmethod
    def _resolve_role(
        raw: Any,
        circuit: AgentCircuit,
        *,
        allow_new: bool = False,
    ) -> str:
        value = str(raw)
        if not value.startswith("$"):
            if allow_new or value in {role.role_id for role in circuit.roles}:
                return value
            raise TransformationNotApplicable(f"unknown role {value}")
        if value == "$primary":
            return circuit.entry_role_ids[0]
        if value == "$entry":
            candidates = circuit.entry_role_ids
        elif value == "$terminal":
            candidates = circuit.terminal_role_ids
        elif value.startswith("$kind:"):
            kind = value.split(":", 1)[1]
            candidates = tuple(role.role_id for role in circuit.roles if role.kind == kind)
        else:
            raise ValueError(f"unknown declarative circuit selector: {value}")
        if len(candidates) != 1:
            raise TransformationNotApplicable(
                f"selector {value} requires exactly one role, found {len(candidates)}"
            )
        return candidates[0]

    @staticmethod
    def _role(
        source: AgentRole,
        role_id: str,
        name: str,
        kind: str,
        objective: str,
        prompt: str,
        *,
        use_tools: bool = True,
        context_mode: str | None = None,
        workspace_access: str = "read_write",
    ) -> AgentRole:
        return AgentRole(
            role_id=role_id,
            name=name,
            kind=kind,
            objective=objective,
            system_prompt=prompt,
            capabilities=source.capabilities,
            tool_interface_ids=source.tool_interface_ids if use_tools else (),
            output_artifact_kinds=(),
            workspace_access=workspace_access,
            harness_spec=source.harness_spec,
            context=AgentContextPolicy(
                mode=context_mode
                or ("selected_artifacts" if kind == "specialist" else "shared"),
                max_input_chars=source.context.max_input_chars,
                max_output_chars=source.context.max_output_chars,
            ),
            budget=AgentBudget(
                max_model_calls=1,
                max_tokens=source.budget.max_tokens,
                timeout_seconds=min(source.budget.timeout_seconds, 500),
                cost_units=source.budget.cost_units,
            ),
            provider=source.provider,
            model=source.model,
        )

    @staticmethod
    def _fund_policy(
        circuit: AgentCircuit,
        roles: tuple[AgentRole, ...],
        *,
        parallelism: int | None = None,
    ) -> CircuitPolicy:
        calls = sum(role.budget.max_model_calls for role in roles)
        cost = sum(role.budget.cost_units for role in roles)
        return CircuitPolicy(
            max_parallel_roles=min(
                len(roles), parallelism or circuit.policy.max_parallel_roles
            ),
            wall_timeout_seconds=circuit.policy.wall_timeout_seconds,
            max_total_model_calls=max(calls, circuit.policy.max_total_model_calls),
            max_total_cost_units=max(cost, circuit.policy.max_total_cost_units),
            failure_mode=circuit.policy.failure_mode,
            workspace_mode=circuit.policy.workspace_mode,
        )

    def _studio(
        self,
        *,
        transformation: HarnessTransformation,
        circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
        max_actions: int,
    ) -> CircuitMutationTransaction:
        if len(circuit.roles) != 1:
            raise TransformationNotApplicable("studio split requires a singleton circuit")
        source = circuit.roles[0]
        roles = (
            self._role(source, "director", "Creative Director", "director", "Turn the request and evidence into a coherent production brief.", "Define mechanics, visual direction, interfaces, priorities, and acceptance criteria. Do not implement the game.", use_tools=False, workspace_access="read_only"),
            self._role(source, "gameplay_engineer", "Gameplay Engineer", "specialist", "Implement robust mechanics, progression, and end states.", "Own gameplay code and deterministic verification. Publish a focused workspace patch."),
            self._role(source, "visual_designer", "Visual Designer", "specialist", "Implement polished visual communication, feedback, and composition.", "Own presentation and visual feedback without weakening mechanics. Publish a focused workspace patch."),
            self._role(source, "integrator", "Lead Integrator", "integrator", "Merge specialist artifacts into one runnable, coherent game.", "Inspect patches, resolve conflicts, run bounded verification, and publish the integrated build."),
            self._role(source, "playtester", "QA Playtester", "critic", "Deep-play the integrated game and gate release on concrete evidence.", "Exercise the core loop, progression, failure, and success states. Request revision only with actionable evidence.", workspace_access="read_only"),
        )

        traversals = int(transformation.plan_template.get("max_traversals", 1))
        edges = (
            CircuitEdge("director_gameplay", "director", "gameplay_engineer", "delegation", "Implement the gameplay portion of the production brief."),
            CircuitEdge("director_visuals", "director", "visual_designer", "delegation", "Implement the visual portion of the production brief."),
            CircuitEdge("gameplay_integrator", "gameplay_engineer", "integrator", "artifact", "Merge the gameplay patch.", ("patch",)),
            CircuitEdge("visuals_integrator", "visual_designer", "integrator", "artifact", "Merge the visual patch.", ("patch",)),
            CircuitEdge("integrator_playtester", "integrator", "playtester", "review", "Deep-play the integrated build.", ("build",)),
            CircuitEdge("playtester_integrator", "playtester", "integrator", "feedback", "Apply only evidence-backed release blockers.", ("review",), max_traversals=traversals),
        )
        policy = CircuitPolicy(
            max_parallel_roles=2,
            wall_timeout_seconds=circuit.policy.wall_timeout_seconds,
            max_total_model_calls=sum(role.budget.max_model_calls for role in roles) + traversals,
            max_total_cost_units=sum(role.budget.cost_units for role in roles) + traversals,
            failure_mode="fail_fast",
            workspace_mode="isolated_then_merge",
        )
        split_id = "split_maker_into_studio"
        return CircuitMutationTransaction(
            parent_circuit_id=circuit.circuit_id,
            hypothesis=transformation.description,
            evidence_refs=evidence_refs,
            transformation_ids=(transformation.transformation_id,),
            actions=(
                CircuitMutationAction(
                    split_id,
                    "split_role",
                    "Separate independent production responsibilities and explicit handoffs.",
                    {
                        "source_role_id": source.role_id,
                        "replacement_roles": [role.to_dict() for role in roles],
                        "replacement_edges": [edge.to_dict() for edge in edges],
                        "entry_role_ids": ["director"],
                        "terminal_role_ids": ["integrator", "playtester"],
                    },
                ),
                CircuitMutationAction(
                    "fund_bounded_studio",
                    "modify_policy",
                    "Charge every role and bounded feedback traversal.",
                    {"replacement": policy.to_dict()},
                    depends_on=(split_id,),
                ),
            ),
            max_actions=max_actions,
        )

    def _composite(
        self,
        *,
        transformation: HarnessTransformation,
        circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
        max_actions: int,
    ) -> CircuitMutationTransaction:
        current = circuit
        compiled_actions: list[CircuitMutationAction] = []
        prior_step_action_ids: tuple[str, ...] = ()
        for index, raw_step in enumerate(
            transformation.plan_template.get("steps", []), start=1
        ):
            step = dict(raw_step)
            step_transformation = HarnessTransformation(
                transformation_id=f"{transformation.transformation_id}_step_{index}",
                name=f"{transformation.name} step {index}",
                description=f"{transformation.description} (step {index})",
                trigger_signals=transformation.trigger_signals,
                supported_operations=transformation.supported_operations,
                plan_template=step,
                tags=transformation.tags,
                cost_prior=transformation.cost_prior,
            )
            step_shape = str(step["shape"])
            step_transaction = self._compilers[step_shape](
                transformation=step_transformation,
                circuit=current,
                evidence_refs=evidence_refs,
                max_actions=max_actions,
            )
            id_map = {
                action.action_id: f"s{index}_{action.action_id}"[:64]
                for action in step_transaction.actions
            }
            renamed: list[CircuitMutationAction] = []
            for action in step_transaction.actions:
                dependencies = tuple(id_map[item] for item in action.depends_on)
                if not dependencies and prior_step_action_ids:
                    dependencies = prior_step_action_ids
                renamed.append(
                    CircuitMutationAction(
                        action_id=id_map[action.action_id],
                        operation=action.operation,
                        rationale=action.rationale,
                        payload=action.payload,
                        depends_on=dependencies,
                    )
                )
            compiled_actions.extend(renamed)
            if len(compiled_actions) > max_actions:
                raise ValueError(
                    f"composite transformation compiles to {len(compiled_actions)} "
                    f"actions, exceeding limit {max_actions}"
                )
            current = CircuitMutationEngine().apply(current, step_transaction)
            prior_step_action_ids = tuple(item.action_id for item in renamed)
        return CircuitMutationTransaction(
            parent_circuit_id=circuit.circuit_id,
            hypothesis=transformation.description,
            evidence_refs=evidence_refs,
            transformation_ids=(transformation.transformation_id,),
            actions=tuple(compiled_actions),
            max_actions=max_actions,
        )

    def _critic_feedback(
        self,
        *,
        transformation: HarnessTransformation,
        circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
        max_actions: int,
    ) -> CircuitMutationTransaction:
        if any(role.kind == "critic" for role in circuit.roles):
            raise TransformationNotApplicable("circuit already has a critic")
        if "playtester" in {role.role_id for role in circuit.roles}:
            raise TransformationNotApplicable("playtester role id is already occupied")
        source_id = circuit.terminal_role_ids[0]
        source = next(role for role in circuit.roles if role.role_id == source_id)
        critic = self._role(source, "playtester", "QA Playtester", "critic", "Gate the build using deep gameplay evidence.", "Exercise core, failure, progression, and success states; report actionable blockers.", context_mode="shared", workspace_access="read_only")
        traversals = int(transformation.plan_template.get("max_traversals", 1))
        roles = (*circuit.roles, critic)
        policy = self._fund_policy(circuit, roles)
        return CircuitMutationTransaction(
            parent_circuit_id=circuit.circuit_id,
            hypothesis=transformation.description,
            evidence_refs=evidence_refs,
            transformation_ids=(transformation.transformation_id,),
            actions=(
                CircuitMutationAction(
                    "add_playtester", "add_role", "Add independent release evidence.",
                    {"role": critic.to_dict(), "incident_edges": [
                        CircuitEdge("build_playtester", source_id, "playtester", "review", "Deep-play the build.", ("build",)).to_dict(),
                        CircuitEdge("playtester_repair", "playtester", source_id, "feedback", "Repair concrete blockers.", ("review",), max_traversals=traversals).to_dict(),
                    ]},
                ),
                CircuitMutationAction(
                    "make_playtester_terminal",
                    "modify_boundaries",
                    "Release only after independent playtest while preserving the workspace publisher.",
                    {
                        "entry_role_ids": list(circuit.entry_role_ids),
                        "terminal_role_ids": list(circuit.terminal_role_ids) + ["playtester"],
                    },
                    depends_on=("add_playtester",),
                ),
                CircuitMutationAction("fund_playtest_loop", "modify_policy", "Charge the critic and bounded repair invocations.", {"replacement": policy.to_dict()}, depends_on=("add_playtester",)),
            ),
            max_actions=max_actions,
        )

    def _parallel_fanout_fanin(
        self,
        *,
        transformation: HarnessTransformation,
        circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
        max_actions: int,
    ) -> CircuitMutationTransaction:
        candidates = [role for role in circuit.roles if role.kind in {"operator", "specialist"}]
        if not candidates:
            raise TransformationNotApplicable("no operator or specialist can be parallelized")
        source = sorted(candidates, key=lambda role: role.role_id)[0]
        branches = int(transformation.plan_template.get("branches", 2))
        replacements = tuple(
            self._role(source, f"{source.role_id}_branch_{index + 1}", f"{source.name} Specialist {index + 1}", "specialist", f"Own an independent bounded slice of {source.objective}", "Work only on the delegated slice and publish a typed patch for integration.")
            for index in range(branches)
        )
        integrator = self._role(source, f"{source.role_id}_integrator", f"{source.name} Integrator", "integrator", f"Integrate parallel contributions for {source.objective}", "Merge typed patches, resolve conflicts, and verify the integrated result.")
        all_replacements = (*replacements, integrator)
        replacement_edges: list[CircuitEdge] = []
        for edge in circuit.edges:
            if edge.target == source.role_id:
                for index, branch in enumerate(replacements, start=1):
                    replacement_edges.append(CircuitEdge(f"{edge.edge_id}_b{index}", edge.source, branch.role_id, edge.kind, edge.instruction, edge.artifact_kinds, edge.required, edge.max_traversals, edge.protocol))
            elif edge.source == source.role_id:
                replacement_edges.append(CircuitEdge(f"{edge.edge_id}_integrated", integrator.role_id, edge.target, edge.kind, edge.instruction, edge.artifact_kinds, edge.required, edge.max_traversals, edge.protocol))
        for index, branch in enumerate(replacements, start=1):
            replacement_edges.append(CircuitEdge(f"{source.role_id}_branch_{index}_merge", branch.role_id, integrator.role_id, "artifact", "Integrate this independent patch.", ("patch",)))
        entry = [item for item in circuit.entry_role_ids if item != source.role_id]
        terminal = [item for item in circuit.terminal_role_ids if item != source.role_id]
        if source.role_id in circuit.entry_role_ids:
            entry.extend(role.role_id for role in replacements)
        if source.role_id in circuit.terminal_role_ids:
            terminal.append(integrator.role_id)
        final_roles = tuple(role for role in circuit.roles if role.role_id != source.role_id) + all_replacements
        policy = self._fund_policy(circuit, final_roles, parallelism=max(circuit.policy.max_parallel_roles, branches))
        split_id = f"parallelize_{source.role_id}"
        return CircuitMutationTransaction(
            parent_circuit_id=circuit.circuit_id,
            hypothesis=transformation.description,
            evidence_refs=evidence_refs,
            transformation_ids=(transformation.transformation_id,),
            actions=(
                CircuitMutationAction(split_id, "split_role", "Separate independent work and add explicit fan-in.", {"source_role_id": source.role_id, "replacement_roles": [role.to_dict() for role in all_replacements], "replacement_edges": [edge.to_dict() for edge in replacement_edges], "entry_role_ids": entry if source.role_id in circuit.entry_role_ids else [], "terminal_role_ids": terminal if source.role_id in circuit.terminal_role_ids else []}),
                CircuitMutationAction(f"fund_{source.role_id}_fanout", "modify_policy", "Fund bounded parallel branches and integration.", {"replacement": policy.to_dict()}, depends_on=(split_id,)),
            ),
            max_actions=max_actions,
        )

    def _merge_specialists(
        self,
        *,
        transformation: HarnessTransformation,
        circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
        max_actions: int,
    ) -> CircuitMutationTransaction:
        specialists = sorted((role for role in circuit.roles if role.kind == "specialist"), key=lambda role: role.role_id)
        if len(specialists) < 2:
            raise TransformationNotApplicable("fewer than two specialists can be merged")
        first, second = specialists[:2]
        source_ids = {first.role_id, second.role_id}
        merged_id = f"{first.role_id}_merged"
        occupied = {role.role_id for role in circuit.roles} - source_ids
        if merged_id in occupied:
            merged_id = f"{first.role_id}_combined"
        merged = AgentRole(
            role_id=merged_id,
            name=f"{first.name} + {second.name}",
            kind="specialist",
            objective=f"Own the overlapping responsibilities of {first.objective} and {second.objective}",
            system_prompt=f"{first.system_prompt}\n\nAlso preserve this responsibility:\n{second.system_prompt}",
            capabilities=tuple(sorted(set(first.capabilities) | set(second.capabilities))),
            tool_interface_ids=tuple(sorted(set(first.tool_interface_ids) | set(second.tool_interface_ids))),
            context=first.context,
            budget=AgentBudget(max_model_calls=max(first.budget.max_model_calls, second.budget.max_model_calls), max_tokens=first.budget.max_tokens or second.budget.max_tokens, timeout_seconds=max(first.budget.timeout_seconds, second.budget.timeout_seconds), cost_units=max(first.budget.cost_units, second.budget.cost_units)),
            provider=first.provider,
            model=first.model,
        )
        replacements: list[CircuitEdge] = []
        seen: set[tuple[str, str, str]] = set()
        for edge in circuit.edges:
            if edge.source in source_ids and edge.target in source_ids:
                continue
            source = merged_id if edge.source in source_ids else edge.source
            target = merged_id if edge.target in source_ids else edge.target
            key = (source, target, edge.kind)
            if key in seen:
                continue
            seen.add(key)
            replacements.append(CircuitEdge(f"merge_{len(replacements) + 1}_{edge.edge_id}"[:64], source, target, edge.kind, edge.instruction, edge.artifact_kinds, edge.required, edge.max_traversals, edge.protocol))
        final_roles = tuple(role for role in circuit.roles if role.role_id not in source_ids) + (merged,)
        policy = replace(self._fund_policy(circuit, final_roles), max_total_model_calls=sum(role.budget.max_model_calls for role in final_roles), max_total_cost_units=sum(role.budget.cost_units for role in final_roles), max_parallel_roles=min(circuit.policy.max_parallel_roles, len(final_roles)))
        merge_id = f"merge_{first.role_id}_{second.role_id}"[:64]
        return CircuitMutationTransaction(
            parent_circuit_id=circuit.circuit_id,
            hypothesis=transformation.description,
            evidence_refs=evidence_refs,
            transformation_ids=(transformation.transformation_id,),
            actions=(
                CircuitMutationAction(merge_id, "merge_roles", "Remove repeatedly overlapping specialist boundaries.", {"source_role_ids": sorted(source_ids), "merged_role": merged.to_dict(), "replacement_edges": [edge.to_dict() for edge in replacements]}),
                CircuitMutationAction("refund_merged_specialists", "modify_policy", "Return redundant coordination and model-call budget.", {"replacement": policy.to_dict()}, depends_on=(merge_id,)),
            ),
            max_actions=max_actions,
        )

    def _typed_artifact_mailbox(
        self,
        *,
        transformation: HarnessTransformation,
        circuit: AgentCircuit,
        evidence_refs: tuple[str, ...],
        max_actions: int,
    ) -> CircuitMutationTransaction:
        candidates = [edge for edge in circuit.edges if not edge.is_feedback]
        if not candidates:
            raise TransformationNotApplicable("circuit has no handoff edge to tighten")
        edge = sorted(candidates, key=lambda item: (bool(item.artifact_kinds), item.edge_id))[0]
        source = next(role for role in circuit.roles if role.role_id == edge.source)
        target = next(role for role in circuit.roles if role.role_id == edge.target)
        if edge.kind == "artifact" and edge.artifact_kinds and target.context.mode == "selected_artifacts":
            raise TransformationNotApplicable("typed artifact handoff is already enforced")
        kinds = edge.artifact_kinds or source.effective_output_artifact_kinds
        replacement_edge = CircuitEdge(edge.edge_id, edge.source, edge.target, "artifact", edge.instruction, kinds, edge.required)
        replacement_role = replace(target, context=AgentContextPolicy(mode="selected_artifacts", include_artifact_kinds=kinds, max_input_chars=min(target.context.max_input_chars, 16_000), max_output_chars=target.context.max_output_chars))
        edge_action = f"type_{edge.edge_id}"
        return CircuitMutationTransaction(
            parent_circuit_id=circuit.circuit_id,
            hypothesis=transformation.description,
            evidence_refs=evidence_refs,
            transformation_ids=(transformation.transformation_id,),
            actions=(
                CircuitMutationAction(edge_action, "modify_edge", "Replace broad handoff with a typed artifact contract.", {"edge_id": edge.edge_id, "replacement": replacement_edge.to_dict()}),
                CircuitMutationAction(f"isolate_{target.role_id}_context", "modify_role", "Limit the consumer context to declared artifacts.", {"role_id": target.role_id, "replacement": replacement_role.to_dict()}, depends_on=(edge_action,)),
            ),
            max_actions=max_actions,
        )
