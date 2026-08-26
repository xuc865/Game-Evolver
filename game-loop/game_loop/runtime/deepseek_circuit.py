from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Mapping

from game_loop.core.agent_circuit_runtime import (
    CircuitArtifact,
    CircuitRoleRequest,
    CircuitRoleResult,
)
from game_loop.runtime.deepseek_harness import (
    DeepSeekHarnessRunner,
    DeepSeekHarnessRuntime,
    DeepSeekHarnessRuntimeConfig,
    PythonSDKRunner,
    _collect_usage,
    _load_system_prompt,
    _runtime_base_environment,
)
from game_loop.runtime.providers import load_provider
from game_loop.runtime_profile_snapshot import hash_path, materialize_role_cordis
from game_loop.utils import sha256_json


def deepseek_role_runtime_contract() -> dict[str, Any]:
    """Describe the executable accounting semantics disclosed to HPA."""

    return {
        "runtime_type": "deepseek-harness",
        "role_invocation": "one complete DeepSeek Harness session",
        "model_calls_per_role_invocation": 1,
        "cost_units_per_role_invocation": 1.0,
        "repeat_role_invocation_via": "bounded feedback edges only",
        "budget_semantics": (
            "role max_model_calls and cost_units are per-invocation admission ceilings; "
            "raising them does not create additional turns or role invocations"
        ),
    }


@dataclass(frozen=True)
class ResolvedRoleHarness:
    """Executable, content-addressed harness manifest for one circuit role."""

    source_harness_id: str | None
    modules: tuple[dict[str, Any], ...]
    elements: tuple[dict[str, Any], ...]
    tool_interfaces: tuple[dict[str, Any], ...]
    cordis_plugins: tuple[str, ...]
    role_behavior_hash: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_harness_id": self.source_harness_id,
            "modules": list(self.modules),
            "elements": list(self.elements),
            "tool_interfaces": list(self.tool_interfaces),
            "cordis_plugins": list(self.cordis_plugins),
            "role_behavior_hash": self.role_behavior_hash,
        }

    @property
    def effective_hash(self) -> str:
        return "effective-role-harness-" + sha256_json(self.to_dict())[:24]


class DeepSeekCircuitRoleRunner:
    """Execute one real Agent Circuit role through the DeepSeek Harness SDK."""

    def __init__(
        self,
        config: DeepSeekHarnessRuntimeConfig,
        *,
        runner: DeepSeekHarnessRunner | None = None,
    ):
        self.config = config
        self.runner = runner or PythonSDKRunner()

    def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult:
        resolved_harness = self._resolve_harness(request.role)
        config = self._role_config(request, resolved_harness=resolved_harness)
        environment = self._environment(config, request.workspace)
        session_root = (
            request.workspace
            / ".circuit_sessions"
            / request.role.role_id
            / f"attempt_{request.attempt:02d}"
        )
        session_root.mkdir(parents=True, exist_ok=True)
        result = self.runner.run(
            self._prompt(request, config, resolved_harness=resolved_harness),
            cwd=request.workspace,
            session_root=session_root,
            config=config,
            environment=environment,
        )
        usage = _collect_usage(result.events, result.notifications)
        tokens = int(usage.get("totalTokens", 0))
        if not tokens:
            tokens = int(usage.get("inputTokens", 0)) + int(
                usage.get("outputTokens", 0)
            )
        success = result.finish_reason in config.successful_finish_reasons
        final_response = result.final_response.strip()
        feedback_requested = (
            request.may_request_feedback
            and "CIRCUIT_STATUS: REVISE" in final_response.upper()
        )
        artifacts = self._artifacts(request, final_response, success=success)
        return CircuitRoleResult(
            role_id=request.role.role_id,
            status="completed" if success else "failed",
            summary=final_response[: request.role.context.max_output_chars],
            artifacts=artifacts,
            model_calls=1,
            tokens=tokens,
            cost_units=request.role.budget.cost_units,
            feedback_requested=feedback_requested,
            error=(
                None
                if success
                else f"DeepSeek Harness finish reason: {result.finish_reason or 'missing'}"
            ),
            # An incomplete SDK session cannot become formal GOA evidence. The
            # benchmark may still retain its trace for diagnosis and replay.
            infrastructure_ok=success,
            effective_harness_hash=resolved_harness.effective_hash,
            effective_cordis_hash=(
                None if config.cordis is None else hash_path(Path(config.cordis))
            ),
        )

    def _role_config(
        self,
        request: CircuitRoleRequest,
        *,
        resolved_harness: ResolvedRoleHarness | None = None,
    ) -> DeepSeekHarnessRuntimeConfig:
        resolved_harness = resolved_harness or self._resolve_harness(request.role)
        max_tokens = self.config.max_tokens
        if request.role.budget.max_tokens is not None:
            max_tokens = (
                request.role.budget.max_tokens
                if max_tokens is None
                else min(max_tokens, request.role.budget.max_tokens)
            )
        role_plugins = resolved_harness.cordis_plugins
        cordis = self._role_cordis(
            request=request,
            active_plugins=role_plugins,
            effective_harness_hash=resolved_harness.effective_hash,
        )
        return replace(
            self.config,
            provider=request.role.provider or self.config.provider,
            model=request.role.model or self.config.model,
            max_tokens=max_tokens,
            timeout_seconds=min(
                self.config.timeout_seconds,
                request.role.budget.timeout_seconds,
                (
                    request.role.budget.timeout_seconds
                    if request.runtime_timeout_seconds is None
                    else request.runtime_timeout_seconds
                ),
            ),
            cordis=cordis,
            active_cordis_plugins=role_plugins,
            effective_cordis_sha256=(
                None if cordis is None else hash_path(Path(cordis))
            ),
            agent_circuit=None,
        )

    def doctor_role(self, role, *, workspace: Path) -> dict[str, Any]:
        workspace.mkdir(parents=True, exist_ok=True)
        request = CircuitRoleRequest(
            task="Validate role-local harness startup.",
            role=role,
            workspace=workspace,
            attempt=0,
        )
        resolved_harness = self._resolve_harness(role)
        config = self._role_config(request, resolved_harness=resolved_harness)
        report = DeepSeekHarnessRuntime(config, runner=self.runner).doctor()
        return {
            "ok": bool(report.get("ok")),
            "checks": dict(report.get("checks", {})),
            "effective_harness_hash": resolved_harness.effective_hash,
            "effective_cordis_hash": (
                None if config.cordis is None else hash_path(Path(config.cordis))
            ),
            "active_cordis_plugins": list(config.active_cordis_plugins),
            "manifest": resolved_harness.to_dict(),
        }

    def _resolve_harness(self, role) -> ResolvedRoleHarness:
        spec = role.harness_spec
        module_ids = (
            tuple(self.config.harness_module_catalog)
            if spec is None
            else spec.active_module_ids
        )
        element_ids = (
            tuple(self.config.harness_element_catalog)
            if spec is None
            else spec.active_element_ids
        )
        plugins = (
            self.config.active_cordis_plugins
            if spec is None
            else spec.active_cordis_plugins
        )
        modules = self._resolve_catalog_rows(
            role_id=role.role_id,
            component_kind="module",
            component_ids=module_ids,
            catalog=self.config.harness_module_catalog,
        )
        elements = self._resolve_catalog_rows(
            role_id=role.role_id,
            component_kind="element",
            component_ids=element_ids,
            catalog=self.config.harness_element_catalog,
        )
        tool_interfaces = self._resolve_catalog_rows(
            role_id=role.role_id,
            component_kind="tool interface",
            component_ids=role.tool_interface_ids,
            catalog=self.config.harness_tool_interface_catalog,
        )
        unknown_plugins = sorted(set(plugins) - set(self.config.cordis_plugin_catalog))
        if unknown_plugins and self.config.cordis_plugin_catalog:
            raise ValueError(
                f"role {role.role_id} references unknown Cordis plugins: {unknown_plugins}"
            )
        return ResolvedRoleHarness(
            source_harness_id=None if spec is None else spec.source_harness_id,
            modules=modules,
            elements=elements,
            tool_interfaces=tool_interfaces,
            cordis_plugins=tuple(plugins),
            role_behavior_hash=role.effective_harness_hash,
        )

    @staticmethod
    def _resolve_catalog_rows(
        *,
        role_id: str,
        component_kind: str,
        component_ids: tuple[str, ...],
        catalog: Mapping[str, Mapping[str, Any]],
    ) -> tuple[dict[str, Any], ...]:
        if not component_ids:
            return ()
        missing = sorted(set(component_ids) - set(catalog))
        if missing:
            raise ValueError(
                f"role {role_id} references unresolved {component_kind}s: {missing}"
            )
        return tuple(dict(catalog[item]) for item in component_ids)

    def _role_cordis(
        self,
        *,
        request: CircuitRoleRequest,
        active_plugins: tuple[str, ...],
        effective_harness_hash: str,
    ) -> str | None:
        seed_raw = self.config.cordis_seed or self.config.cordis
        if seed_raw is None:
            if active_plugins:
                raise ValueError("role-local Cordis plugins require a Cordis seed")
            return None
        seed = Path(seed_raw)
        if not self.config.cordis_plugin_catalog:
            if active_plugins and active_plugins != self.config.active_cordis_plugins:
                raise ValueError("role-local Cordis selection requires the audited plugin catalog")
            return str(seed)
        target = (
            request.workspace
            / ".circuit_config"
            / f"{effective_harness_hash}.cordis.yml"
        )
        materialized, _ = materialize_role_cordis(
            seed=seed,
            destination=target,
            plugin_catalog=self.config.cordis_plugin_catalog,
            active_plugins=active_plugins,
        )
        return str(materialized)

    @staticmethod
    def _environment(
        config: DeepSeekHarnessRuntimeConfig,
        workspace: Path,
    ) -> dict[str, str]:
        environment = _runtime_base_environment()
        environment.update(config.environment)
        home = workspace / ".circuit_home"
        dsh_home = home / ".dsh"
        dsh_home.mkdir(parents=True, exist_ok=True)
        environment.update(
            {
                "HOME": str(home),
                "USERPROFILE": str(home),
                "XDG_CONFIG_HOME": str(home / ".config"),
                "XDG_CACHE_HOME": str(home / ".cache"),
                "XDG_DATA_HOME": str(home / ".local" / "share"),
                "DSH_HOME": str(dsh_home),
            }
        )
        if config.backbone_provider is not None:
            provider = load_provider(config.backbone_provider)
            provider_environment = dict(os.environ)
            provider_environment.update(config.environment)
            resolved = provider.resolve(provider_environment)
            if resolved.api_key is None and resolved.requires_credential:
                raise RuntimeError(
                    f"{config.backbone_provider} credential is missing; set one of: "
                    + ", ".join(provider.credential_envs)
                )
            if resolved.provider_id == "deepseek":
                environment.update(
                    {
                        "DEEPSEEK_BASE_URL": resolved.base_url,
                        "DEEPSEEK_API_KEY": resolved.api_key or "EMPTY",
                    }
                )
            else:
                environment = resolved.inject(environment)
        return environment

    @staticmethod
    def _prompt(
        request: CircuitRoleRequest,
        config: DeepSeekHarnessRuntimeConfig,
        *,
        resolved_harness: ResolvedRoleHarness,
    ) -> str:
        sections = [
            "## Agent Circuit role",
            f"Role: {request.role.name} ({request.role.role_id}, {request.role.kind})",
            f"Objective: {request.role.objective}",
            f"Workspace access: {request.role.workspace_access}",
            "Capabilities: " + (
                ", ".join(request.role.capabilities)
                if request.role.capabilities
                else "role prompt and inherited harness only"
            ),
            (
                "Budget: "
                f"max_model_calls={request.role.budget.max_model_calls}, "
                f"max_tokens={request.role.budget.max_tokens or 'runtime default'}, "
                f"timeout_seconds={request.role.budget.timeout_seconds}, "
                f"cost_units={request.role.budget.cost_units:g}"
            ),
            request.role.system_prompt,
            "",
            "## User task",
            request.task,
        ]
        base_system = _load_system_prompt(config)
        if base_system:
            sections[0:0] = [base_system.rstrip(), ""]
        harness_lines = [
            "",
            "## Role-local executable harness",
            f"Effective harness: {resolved_harness.effective_hash}",
        ]
        if resolved_harness.source_harness_id:
            harness_lines.append(
                f"Inherited from champion harness: {resolved_harness.source_harness_id}"
            )
        for module in resolved_harness.modules:
            harness_lines.append(
                f"- [module:{module.get('id', 'unknown')}] "
                f"{str(module.get('instruction', '')).strip()}"
            )
        for element in resolved_harness.elements:
            element_id = element.get("element_id", element.get("id", "unknown"))
            category = element.get("category", "element")
            description = str(element.get("description", "")).strip()
            spec = json.dumps(
                element.get("spec", {}), sort_keys=True, separators=(",", ":")
            )
            harness_lines.append(
                f"- [{category}:{element_id}] {description} (policy={spec})"
            )
        for interface in resolved_harness.tool_interfaces:
            harness_lines.append(
                f"- [interface:{interface.get('interface_id', 'unknown')}] "
                f"{interface.get('kind', 'tool')}: {interface.get('description', '')}"
            )
        if resolved_harness.cordis_plugins:
            harness_lines.append(
                "- [cordis] " + ", ".join(resolved_harness.cordis_plugins)
            )
        role_header_end = sections.index("## User task") - 1
        sections[role_header_end:role_header_end] = harness_lines
        if request.edge_instructions:
            sections.extend(
                ["", "## Assigned handoffs", *[f"- {item}" for item in request.edge_instructions]]
            )
        mode = request.role.context.mode
        if mode in {"parent_summary", "shared"} and request.upstream_summaries:
            sections.extend(["", "## Upstream summaries"])
            sections.extend(
                f"### {role_id}\n{summary}"
                for role_id, summary in sorted(request.upstream_summaries.items())
            )
        if mode != "task_only" and request.artifacts:
            allowed = set(request.role.context.include_artifact_kinds)
            visible = [
                artifact
                for artifact in request.artifacts
                if not allowed or artifact.kind in allowed
            ]
            if visible:
                sections.extend(["", "## Materialized upstream artifacts"])
                for artifact in visible:
                    location = (
                        artifact.path
                        if artifact.path is not None
                        else f"inline: {artifact.content}"
                    )
                    sections.append(
                        f"- {artifact.kind} from {artifact.producer_role_id}: {location}"
                    )
        if request.feedback_from:
            sections.extend(
                [
                    "",
                    "## Feedback repair",
                    f"This is bounded repair attempt {request.attempt}, requested by "
                    f"{request.feedback_from}. Address its evidence without discarding valid work.",
                ]
            )
        if request.may_request_feedback:
            sections.extend(
                [
                    "",
                    "## Required critic verdict",
                    "End with exactly one verdict line: CIRCUIT_STATUS: PASS or "
                    "CIRCUIT_STATUS: REVISE. Request revision only for concrete, actionable "
                    "quality failures found in the supplied build.",
                ]
            )
        if request.role.workspace_access == "read_only":
            sections.extend(
                [
                    "",
                    "## Enforced read-only boundary",
                    "Do not create, modify, delete, move, or rename any project or source "
                    "file under the assigned workspace. Do not apply patches there, even "
                    "when you find an obvious defect. Run write-producing probes only on a "
                    "temporary copy outside the assigned workspace. Publish findings and "
                    "typed artifacts inline in the final response; the runtime will reject "
                    "this role if the workspace source digest changes.",
                ]
            )
        sections.extend(
            [
                "",
                "## Required published outputs",
                "Publish these typed artifact contracts in your final response or workspace: "
                + ", ".join(request.role.effective_output_artifact_kinds),
            ]
        )
        prompt = "\n".join(sections)
        limit = request.role.context.max_input_chars
        if len(prompt) > limit:
            prompt = prompt[: limit - 80] + "\n\n[context truncated at role policy limit]"
        return prompt

    @staticmethod
    def _artifacts(
        request: CircuitRoleRequest,
        response: str,
        *,
        success: bool,
    ) -> tuple[CircuitArtifact, ...]:
        if not success:
            return ()
        artifacts = []
        for kind in request.role.effective_output_artifact_kinds:
            if request.role.output_artifact_mode(kind) == "workspace":
                artifacts.append(
                    CircuitArtifact(
                        kind=kind,
                        producer_role_id=request.role.role_id,
                        path=".",
                        metadata={"workspace_snapshot": True},
                    )
                )
            else:
                artifacts.append(
                    CircuitArtifact(
                        kind=kind,
                        producer_role_id=request.role.role_id,
                        content=response,
                    )
                )
        return tuple(artifacts)
