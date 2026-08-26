from __future__ import annotations

import hashlib
import shutil
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from game_loop.core.agent_circuit import (
    AgentCircuit,
    AgentRole,
    CircuitEdge,
    edge_carries_workspace,
)
from game_loop.utils import sha256_json

_ROLE_STATUSES = {"completed", "failed", "blocked"}
CIRCUIT_RUNTIME_ROOTS = (
    ".circuit_config",
    ".circuit_home",
    ".circuit_sessions",
    ".godot",
    "handoffs",
)


@dataclass(frozen=True)
class CircuitArtifact:
    kind: str
    producer_role_id: str
    path: str | None = None
    content: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.kind.strip() or not self.producer_role_id.strip():
            raise ValueError("circuit artifact kind and producer are required")
        if (self.path is None) == (self.content is None):
            raise ValueError("circuit artifact requires exactly one of path or content")

    @property
    def artifact_id(self) -> str:
        return "artifact-" + sha256_json(self.to_dict(include_id=False))[:24]

    def to_dict(self, *, include_id: bool = True) -> dict[str, Any]:
        value = {
            "kind": self.kind,
            "producer_role_id": self.producer_role_id,
            "path": self.path,
            "content": self.content,
            "metadata": dict(self.metadata),
        }
        return {"artifact_id": self.artifact_id, **value} if include_id else value


@dataclass(frozen=True)
class CircuitRoleRequest:
    task: str
    role: AgentRole
    workspace: Path
    attempt: int
    edge_instructions: tuple[str, ...] = ()
    upstream_summaries: dict[str, str] = field(default_factory=dict)
    artifacts: tuple[CircuitArtifact, ...] = ()
    feedback_from: str | None = None
    may_request_feedback: bool = False
    runtime_timeout_seconds: int | None = None


@dataclass(frozen=True)
class CircuitRoleResult:
    role_id: str
    status: str
    summary: str
    artifacts: tuple[CircuitArtifact, ...] = ()
    model_calls: int = 0
    tokens: int = 0
    cost_units: float = 0.0
    feedback_requested: bool = False
    error: str | None = None
    infrastructure_ok: bool = True
    effective_harness_hash: str | None = None
    effective_cordis_hash: str | None = None

    def __post_init__(self) -> None:
        if self.status not in _ROLE_STATUSES:
            raise ValueError(f"unsupported circuit role status: {self.status}")
        if min(self.model_calls, self.tokens) < 0 or self.cost_units < 0:
            raise ValueError("circuit role usage counters cannot be negative")
        if self.status == "completed" and self.error:
            raise ValueError("completed circuit role cannot contain an error")
        if self.status != "completed" and not self.error:
            raise ValueError("failed or blocked circuit role requires an error")
        if any(item.producer_role_id != self.role_id for item in self.artifacts):
            raise ValueError("role result may only publish its own artifacts")

    def to_dict(self) -> dict[str, Any]:
        return {
            "role_id": self.role_id,
            "status": self.status,
            "summary": self.summary,
            "artifacts": [item.to_dict() for item in self.artifacts],
            "model_calls": self.model_calls,
            "tokens": self.tokens,
            "cost_units": float(self.cost_units),
            "feedback_requested": self.feedback_requested,
            "error": self.error,
            "infrastructure_ok": self.infrastructure_ok,
            "effective_harness_hash": self.effective_harness_hash,
            "effective_cordis_hash": self.effective_cordis_hash,
        }


class CircuitRoleRunner(Protocol):
    def run_role(self, request: CircuitRoleRequest) -> CircuitRoleResult: ...


class CircuitWorkspaceManager(Protocol):
    def prepare(
        self,
        *,
        role: AgentRole,
        attempt: int,
        prior_workspace: Path | None,
    ) -> Path: ...


class FilesystemCircuitWorkspaceManager:
    """Create deterministic per-role workspaces without sharing mutable state."""

    def __init__(
        self,
        *,
        source_workspace: Path,
        run_root: Path,
        shared: bool = False,
    ):
        self.source_workspace = source_workspace.resolve()
        self.run_root = run_root.resolve()
        self.shared = shared
        if not self.source_workspace.is_dir():
            raise ValueError(f"circuit source workspace is not a directory: {source_workspace}")

    def prepare(
        self,
        *,
        role: AgentRole,
        attempt: int,
        prior_workspace: Path | None,
    ) -> Path:
        if self.shared:
            return self.source_workspace
        target = self.run_root / "roles" / role.role_id / f"attempt_{attempt:02d}"
        if target.exists():
            shutil.rmtree(target)
        source = prior_workspace if prior_workspace is not None else self.source_workspace
        shutil.copytree(
            source,
            target,
            symlinks=True,
            ignore=shutil.ignore_patterns(*CIRCUIT_RUNTIME_ROOTS),
        )
        return target


@dataclass(frozen=True)
class CircuitRunResult:
    circuit_id: str
    status: str
    role_results: tuple[CircuitRoleResult, ...]
    role_attempts: dict[str, int]
    role_workspaces: dict[str, str]
    terminal_role_ids: tuple[str, ...]
    artifacts: tuple[CircuitArtifact, ...]
    model_calls: int
    tokens: int
    cost_units: float
    elapsed_seconds: float
    infrastructure_ok: bool
    reasons: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": "agent-circuit-run.v1",
            "circuit_id": self.circuit_id,
            "status": self.status,
            "role_results": [item.to_dict() for item in self.role_results],
            "role_attempts": dict(self.role_attempts),
            "role_workspaces": dict(self.role_workspaces),
            "terminal_role_ids": list(self.terminal_role_ids),
            "artifacts": [item.to_dict() for item in self.artifacts],
            "usage": {
                "model_calls": self.model_calls,
                "tokens": self.tokens,
                "cost_units": self.cost_units,
                "elapsed_seconds": self.elapsed_seconds,
            },
            "infrastructure_ok": self.infrastructure_ok,
            "reasons": list(self.reasons),
        }


class AgentCircuitExecutor:
    """Execute an AgentCircuit with typed handoffs and bounded feedback rounds."""

    def __init__(
        self,
        *,
        runner: CircuitRoleRunner,
        workspace_manager: CircuitWorkspaceManager,
    ):
        self.runner = runner
        self.workspace_manager = workspace_manager

    def run(self, circuit: AgentCircuit, *, task: str) -> CircuitRunResult:
        if not task.strip():
            raise ValueError("circuit task is required")
        started = time.monotonic()
        roles = {item.role_id: item for item in circuit.roles}
        ordinary_edges = tuple(edge for edge in circuit.edges if not edge.is_feedback)
        feedback_edges = tuple(edge for edge in circuit.edges if edge.is_feedback)
        predecessors: dict[str, list[CircuitEdge]] = defaultdict(list)
        successors: dict[str, list[CircuitEdge]] = defaultdict(list)
        for edge in ordinary_edges:
            predecessors[edge.target].append(edge)
            successors[edge.source].append(edge)
        layers = self._topological_layers(circuit, ordinary_edges)
        latest: dict[str, CircuitRoleResult] = {}
        history: list[CircuitRoleResult] = []
        attempts: dict[str, int] = defaultdict(int)
        workspaces: dict[str, Path] = {}
        usage = {"model_calls": 0, "tokens": 0, "cost_units": 0.0}
        reasons: list[str] = []
        deferred: set[str] = set()

        for layer in layers:
            runnable_role_ids: list[str] = []
            for role_id in layer:
                incoming = predecessors[role_id]
                if any(
                    edge.source in deferred
                    or (
                        latest.get(edge.source) is not None
                        and latest[edge.source].feedback_requested
                    )
                    for edge in incoming
                ):
                    deferred.add(role_id)
                    latest.pop(role_id, None)
                    continue
                runnable_role_ids.append(role_id)
            if not runnable_role_ids:
                continue
            self._run_layer(
                circuit=circuit,
                task=task,
                role_ids=tuple(runnable_role_ids),
                roles=roles,
                predecessors=predecessors,
                latest=latest,
                history=history,
                attempts=attempts,
                workspaces=workspaces,
                usage=usage,
                reasons=reasons,
                started=started,
            )
            if reasons and circuit.policy.failure_mode == "fail_fast":
                break

        if not reasons or circuit.policy.failure_mode != "fail_fast":
            for edge in feedback_edges:
                traversals = 0
                while (
                    traversals < edge.max_traversals
                    and latest.get(edge.source) is not None
                    and latest[edge.source].feedback_requested
                ):
                    traversals += 1
                    for role_id in self._descendants_in_order(
                        target=edge.source,
                        layers=layers,
                        successors=successors,
                        include_target=False,
                    ):
                        latest.pop(role_id, None)
                    affected = self._descendants_in_order(
                        target=edge.target,
                        layers=layers,
                        successors=successors,
                    )
                    for role_id in affected:
                        if role_id != edge.target and any(
                            latest.get(incoming.source) is None
                            or latest[incoming.source].feedback_requested
                            for incoming in predecessors[role_id]
                        ):
                            latest.pop(role_id, None)
                            continue
                        extra_edges = (edge,) if role_id == edge.target else ()
                        self._run_one(
                            circuit=circuit,
                            task=task,
                            role=roles[role_id],
                            incoming=tuple(predecessors[role_id]) + extra_edges,
                            latest=latest,
                            history=history,
                            attempts=attempts,
                            workspaces=workspaces,
                            usage=usage,
                            reasons=reasons,
                            started=started,
                            feedback_from=edge.source if role_id == edge.target else None,
                        )
                        if reasons and circuit.policy.failure_mode == "fail_fast":
                            break
                    if reasons and circuit.policy.failure_mode == "fail_fast":
                        break
                if (
                    latest.get(edge.source) is not None
                    and latest[edge.source].feedback_requested
                ):
                    reasons.append(
                        f"feedback traversal budget exhausted on edge {edge.edge_id}"
                    )

        terminal_results = [latest.get(item) for item in circuit.terminal_role_ids]
        terminals_completed = all(
            item is not None and item.status == "completed" for item in terminal_results
        )
        elapsed = time.monotonic() - started
        if elapsed > circuit.policy.wall_timeout_seconds:
            reasons.append("circuit exceeded wall timeout")
        for role_id, result in zip(circuit.terminal_role_ids, terminal_results):
            if result is None or result.status != "completed":
                reasons.append(f"terminal role {role_id} did not complete")
        status = "completed" if terminals_completed and not reasons else "failed"
        published = tuple(
            artifact
            for role_id in circuit.terminal_role_ids
            for artifact in (latest.get(role_id).artifacts if latest.get(role_id) else ())
        )
        return CircuitRunResult(
            circuit_id=circuit.circuit_id,
            status=status,
            role_results=tuple(history),
            role_attempts=dict(attempts),
            role_workspaces={key: str(value) for key, value in workspaces.items()},
            terminal_role_ids=circuit.terminal_role_ids,
            artifacts=published,
            model_calls=int(usage["model_calls"]),
            tokens=int(usage["tokens"]),
            cost_units=float(usage["cost_units"]),
            elapsed_seconds=elapsed,
            infrastructure_ok=(
                elapsed <= circuit.policy.wall_timeout_seconds
                and all(
                    item.infrastructure_ok
                    and not (item.error or "").startswith("runner exception:")
                    for item in history
                )
            ),
            reasons=tuple(dict.fromkeys(reasons)),
        )

    def _run_layer(
        self,
        *,
        circuit: AgentCircuit,
        task: str,
        role_ids: Sequence[str],
        roles: Mapping[str, AgentRole],
        predecessors: Mapping[str, list[CircuitEdge]],
        latest: dict[str, CircuitRoleResult],
        history: list[CircuitRoleResult],
        attempts: dict[str, int],
        workspaces: dict[str, Path],
        usage: dict[str, float],
        reasons: list[str],
        started: float,
    ) -> None:
        if len(role_ids) == 1:
            role_id = role_ids[0]
            self._run_one(
                circuit=circuit,
                task=task,
                role=roles[role_id],
                incoming=predecessors[role_id],
                latest=latest,
                history=history,
                attempts=attempts,
                workspaces=workspaces,
                usage=usage,
                reasons=reasons,
                started=started,
            )
            return
        prepared: dict[str, CircuitRoleRequest | CircuitRoleResult] = {}
        for role_id in role_ids:
            prepared[role_id] = self._prepare_request(
                circuit=circuit,
                task=task,
                role=roles[role_id],
                incoming=predecessors[role_id],
                latest=latest,
                attempts=attempts,
                workspaces=workspaces,
                usage=usage,
                started=started,
            )
        runnable = {
            role_id: request
            for role_id, request in prepared.items()
            if isinstance(request, CircuitRoleRequest)
        }
        completed: dict[str, CircuitRoleResult] = {
            role_id: result
            for role_id, result in prepared.items()
            if isinstance(result, CircuitRoleResult)
        }
        if runnable:
            with ThreadPoolExecutor(
                max_workers=min(circuit.policy.max_parallel_roles, len(runnable))
            ) as pool:
                future_roles = {
                    pool.submit(self._invoke_runner, request): role_id
                    for role_id, request in runnable.items()
                }
                for future in as_completed(future_roles):
                    role_id = future_roles[future]
                    try:
                        completed[role_id] = future.result()
                    except Exception as exc:  # noqa: BLE001 - convert runner faults to infra evidence.
                        completed[role_id] = CircuitRoleResult(
                            role_id=role_id,
                            status="failed",
                            summary="",
                            error=f"runner exception: {type(exc).__name__}: {exc}",
                            infrastructure_ok=False,
                        )
        for role_id in sorted(role_ids):
            self._record_result(
                circuit=circuit,
                role=roles[role_id],
                result=completed[role_id],
                latest=latest,
                history=history,
                usage=usage,
                reasons=reasons,
            )

    def _run_one(
        self,
        *,
        circuit: AgentCircuit,
        task: str,
        role: AgentRole,
        incoming: Sequence[CircuitEdge],
        latest: dict[str, CircuitRoleResult],
        history: list[CircuitRoleResult],
        attempts: dict[str, int],
        workspaces: dict[str, Path],
        usage: dict[str, float],
        reasons: list[str],
        started: float,
        feedback_from: str | None = None,
    ) -> None:
        prepared = self._prepare_request(
            circuit=circuit,
            task=task,
            role=role,
            incoming=incoming,
            latest=latest,
            attempts=attempts,
            workspaces=workspaces,
            usage=usage,
            started=started,
            feedback_from=feedback_from,
        )
        if isinstance(prepared, CircuitRoleResult):
            result = prepared
        else:
            try:
                result = self._invoke_runner(prepared)
            except Exception as exc:  # noqa: BLE001 - convert runner faults to infra evidence.
                result = CircuitRoleResult(
                    role_id=role.role_id,
                    status="failed",
                    summary="",
                    error=f"runner exception: {type(exc).__name__}: {exc}",
                    infrastructure_ok=False,
                )
        self._record_result(
            circuit=circuit,
            role=role,
            result=result,
            latest=latest,
            history=history,
            usage=usage,
            reasons=reasons,
        )

    def _prepare_request(
        self,
        *,
        circuit: AgentCircuit,
        task: str,
        role: AgentRole,
        incoming: Sequence[CircuitEdge],
        latest: Mapping[str, CircuitRoleResult],
        attempts: dict[str, int],
        workspaces: dict[str, Path],
        usage: Mapping[str, float],
        started: float,
        feedback_from: str | None = None,
    ) -> CircuitRoleRequest | CircuitRoleResult:
        failed_required = [
            edge.source
            for edge in incoming
            if edge.required
            and (latest.get(edge.source) is None or latest[edge.source].status != "completed")
        ]
        if failed_required:
            return CircuitRoleResult(
                role_id=role.role_id,
                status="blocked",
                summary="",
                error=f"required upstream roles unavailable: {sorted(set(failed_required))}",
                infrastructure_ok=all(
                    latest.get(source) is not None
                    and latest[source].infrastructure_ok
                    for source in failed_required
                ),
            )
        if time.monotonic() - started >= circuit.policy.wall_timeout_seconds:
            return CircuitRoleResult(
                role_id=role.role_id,
                status="blocked",
                summary="",
                error="circuit wall timeout exhausted before role start",
                infrastructure_ok=False,
            )
        if usage["model_calls"] + role.budget.max_model_calls > circuit.policy.max_total_model_calls:
            return CircuitRoleResult(
                role_id=role.role_id,
                status="blocked",
                summary="",
                error="circuit model-call budget exhausted before role start",
                infrastructure_ok=False,
            )
        if usage["cost_units"] + role.budget.cost_units > circuit.policy.max_total_cost_units:
            return CircuitRoleResult(
                role_id=role.role_id,
                status="blocked",
                summary="",
                error="circuit cost budget exhausted before role start",
                infrastructure_ok=False,
            )
        attempts[role.role_id] += 1
        prior_workspace = workspaces.get(role.role_id)
        if circuit.policy.workspace_mode == "isolated_then_merge":
            roles = {item.role_id: item for item in circuit.roles}
            upstream_workspace_roots = {
                workspaces[edge.source]
                for edge in incoming
                if edge_carries_workspace(edge, roles=roles)
                if edge.source in workspaces
                and latest.get(edge.source) is not None
                and latest[edge.source].status == "completed"
                and any(
                    artifact.metadata.get("workspace_snapshot") is True
                    and (
                        not edge.artifact_kinds
                        or artifact.kind in edge.artifact_kinds
                    )
                    for artifact in latest[edge.source].artifacts
                )
            }
            if len(upstream_workspace_roots) == 1:
                # A linear workspace handoff has no merge ambiguity. Continue
                # from that exact snapshot so the consumer verifies or edits
                # the producer's artifact at the workspace root. Fan-in keeps
                # isolated snapshots staged under handoffs for explicit merge.
                prior_workspace = next(iter(upstream_workspace_roots))
        workspace = self.workspace_manager.prepare(
            role=role,
            attempt=attempts[role.role_id],
            prior_workspace=prior_workspace,
        )
        workspaces[role.role_id] = workspace
        artifacts: list[CircuitArtifact] = []
        summaries: dict[str, str] = {}
        instructions: list[str] = []
        for edge in incoming:
            source = latest.get(edge.source)
            if source is None or source.status != "completed":
                continue
            summaries[edge.source] = source.summary
            instructions.append(edge.instruction)
            allowed = set(edge.artifact_kinds)
            selected = [
                item for item in source.artifacts if not allowed or item.kind in allowed
            ]
            if edge.required and edge.artifact_kinds and not selected:
                return CircuitRoleResult(
                    role_id=role.role_id,
                    status="blocked",
                    summary="",
                    error=f"required artifacts missing on edge {edge.edge_id}",
                )
            artifacts.extend(selected)
        staged_artifacts = self._stage_artifacts(
            workspace=workspace,
            artifacts=artifacts,
            producer_workspaces=workspaces,
        )
        return CircuitRoleRequest(
            task=task,
            role=role,
            workspace=workspace,
            attempt=attempts[role.role_id],
            edge_instructions=tuple(instructions),
            upstream_summaries=summaries,
            artifacts=staged_artifacts,
            feedback_from=feedback_from,
            may_request_feedback=any(
                edge.source == role.role_id and edge.is_feedback
                for edge in circuit.edges
            ),
            runtime_timeout_seconds=max(
                1,
                min(
                    role.budget.timeout_seconds,
                    int(
                        circuit.policy.wall_timeout_seconds
                        - (time.monotonic() - started)
                    ),
                ),
            ),
        )

    def _invoke_runner(self, request: CircuitRoleRequest) -> CircuitRoleResult:
        started = time.monotonic()
        source_digest_before = (
            self._workspace_source_digest(request.workspace)
            if request.role.workspace_access == "read_only"
            else None
        )
        result = self.runner.run_role(request)
        elapsed = time.monotonic() - started
        if result.role_id != request.role.role_id:
            raise ValueError("circuit runner returned a result for the wrong role")
        if (
            source_digest_before is not None
            and self._workspace_source_digest(request.workspace)
            != source_digest_before
        ):
            return CircuitRoleResult(
                role_id=request.role.role_id,
                status="failed",
                summary=result.summary,
                model_calls=result.model_calls,
                tokens=result.tokens,
                cost_units=result.cost_units,
                error="read-only circuit role modified workspace source files",
                infrastructure_ok=result.infrastructure_ok,
                effective_harness_hash=result.effective_harness_hash,
                effective_cordis_hash=result.effective_cordis_hash,
            )
        effective_timeout = (
            request.role.budget.timeout_seconds
            if request.runtime_timeout_seconds is None
            else min(
                request.role.budget.timeout_seconds,
                request.runtime_timeout_seconds,
            )
        )
        if elapsed > effective_timeout:
            return CircuitRoleResult(
                role_id=request.role.role_id,
                status="failed",
                summary="",
                model_calls=result.model_calls,
                tokens=result.tokens,
                cost_units=result.cost_units,
                error="role exceeded its timeout budget",
                infrastructure_ok=False,
            )
        if result.model_calls > request.role.budget.max_model_calls:
            return CircuitRoleResult(
                role_id=request.role.role_id,
                status="failed",
                summary="",
                model_calls=result.model_calls,
                tokens=result.tokens,
                cost_units=result.cost_units,
                error="role exceeded its model-call budget",
                infrastructure_ok=False,
            )
        if result.cost_units > request.role.budget.cost_units:
            return CircuitRoleResult(
                role_id=request.role.role_id,
                status="failed",
                summary="",
                model_calls=result.model_calls,
                tokens=result.tokens,
                cost_units=result.cost_units,
                error="role exceeded its cost budget",
                infrastructure_ok=False,
            )
        self._validate_artifacts(request.workspace, result.artifacts)
        return result

    @staticmethod
    def _workspace_source_digest(workspace: Path) -> str:
        ignored_roots = set(CIRCUIT_RUNTIME_ROOTS)
        digest = hashlib.sha256()
        for path in sorted(workspace.rglob("*")):
            relative = path.relative_to(workspace)
            if any(part in ignored_roots for part in relative.parts):
                continue
            if path.is_symlink():
                digest.update(relative.as_posix().encode("utf-8"))
                digest.update(str(path.readlink()).encode("utf-8"))
                continue
            if not path.is_file():
                continue
            digest.update(relative.as_posix().encode("utf-8"))
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _stage_artifacts(
        *,
        workspace: Path,
        artifacts: Sequence[CircuitArtifact],
        producer_workspaces: Mapping[str, Path],
    ) -> tuple[CircuitArtifact, ...]:
        staged: list[CircuitArtifact] = []
        for artifact in artifacts:
            if artifact.path is None:
                staged.append(artifact)
                continue
            producer_root = producer_workspaces.get(artifact.producer_role_id)
            if producer_root is None:
                raise ValueError(
                    f"producer workspace is unavailable: {artifact.producer_role_id}"
                )
            raw_source = Path(artifact.path)
            source = (
                raw_source.resolve()
                if raw_source.is_absolute()
                else (producer_root / raw_source).resolve()
            )
            if not source.is_relative_to(producer_root.resolve()):
                raise ValueError("circuit artifact escapes its producer workspace")
            if not source.exists():
                raise ValueError(f"circuit artifact path does not exist: {artifact.path}")
            destination = (
                workspace
                / "handoffs"
                / artifact.producer_role_id
                / artifact.artifact_id
                / source.name
            )
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(
                    source,
                    destination,
                    symlinks=True,
                    ignore=shutil.ignore_patterns(*CIRCUIT_RUNTIME_ROOTS),
                )
            else:
                shutil.copy2(source, destination)
            staged.append(
                CircuitArtifact(
                    kind=artifact.kind,
                    producer_role_id=artifact.producer_role_id,
                    path=destination.relative_to(workspace).as_posix(),
                    metadata={**artifact.metadata, "source_artifact_id": artifact.artifact_id},
                )
            )
        return tuple(staged)

    @staticmethod
    def _validate_artifacts(
        workspace: Path,
        artifacts: Sequence[CircuitArtifact],
    ) -> None:
        root = workspace.resolve()
        for artifact in artifacts:
            if artifact.path is None:
                continue
            path = Path(artifact.path)
            resolved = (root / path).resolve() if not path.is_absolute() else path.resolve()
            if not resolved.is_relative_to(root):
                raise ValueError("circuit artifact escapes its role workspace")
            if not resolved.exists():
                raise ValueError(f"circuit artifact path does not exist: {artifact.path}")

    @staticmethod
    def _record_result(
        *,
        circuit: AgentCircuit,
        role: AgentRole,
        result: CircuitRoleResult,
        latest: dict[str, CircuitRoleResult],
        history: list[CircuitRoleResult],
        usage: dict[str, float],
        reasons: list[str],
    ) -> None:
        latest[role.role_id] = result
        history.append(result)
        usage["model_calls"] += result.model_calls
        usage["tokens"] += result.tokens
        usage["cost_units"] += result.cost_units
        if result.status != "completed":
            reasons.append(f"{role.role_id}: {result.error}")
        if usage["model_calls"] > circuit.policy.max_total_model_calls:
            reasons.append("circuit model-call budget exceeded")
        if usage["cost_units"] > circuit.policy.max_total_cost_units:
            reasons.append("circuit cost budget exceeded")

    @staticmethod
    def _topological_layers(
        circuit: AgentCircuit,
        edges: Sequence[CircuitEdge],
    ) -> tuple[tuple[str, ...], ...]:
        indegree = {role.role_id: 0 for role in circuit.roles}
        successors: dict[str, list[str]] = defaultdict(list)
        for edge in edges:
            indegree[edge.target] += 1
            successors[edge.source].append(edge.target)
        ready = sorted(item for item, degree in indegree.items() if degree == 0)
        layers: list[tuple[str, ...]] = []
        while ready:
            layer = tuple(ready)
            layers.append(layer)
            next_ready: list[str] = []
            for role_id in layer:
                for target in successors[role_id]:
                    indegree[target] -= 1
                    if indegree[target] == 0:
                        next_ready.append(target)
            ready = sorted(next_ready)
        return tuple(layers)

    @staticmethod
    def _descendants_in_order(
        *,
        target: str,
        layers: Sequence[Sequence[str]],
        successors: Mapping[str, list[CircuitEdge]],
        include_target: bool = True,
    ) -> tuple[str, ...]:
        affected = {target}
        queue = [target]
        while queue:
            source = queue.pop(0)
            for edge in successors[source]:
                if edge.target not in affected:
                    affected.add(edge.target)
                    queue.append(edge.target)
        return tuple(
            role_id
            for layer in layers
            for role_id in layer
            if role_id in affected and (include_target or role_id != target)
        )
