from __future__ import annotations

import copy
import shutil
from pathlib import Path
from typing import Protocol, Sequence

from game_loop.artifacts import ArtifactStore
from game_loop.backends.command import CommandBackend
from game_loop.benchmarks.base import BenchmarkAdapter
from game_loop.config import AppConfig, FixedProbeConfig
from game_loop.probes import FixedCommandProbeRunner, ProbeRunner
from game_loop.utils import RunLock, atomic_write_json, read_json, utc_now

from .active_probes import (
    ActiveProbeSelector,
    ProbeSelectionDecision,
    UniformProbeSelector,
    selected_probes,
)
from .coevolution import CoevolutionEngine
from .feedback import compile_feedback, compile_neutral_feedback
from .harness import HarnessEvolutionEngine, HarnessProfile
from .mutation import L0MutationPolicy
from .models import (
    AttemptContext,
    AttemptRecord,
    BackendExecution,
    EvaluationResult,
    GateResult,
    MutationIntent,
    ProbeResult,
    ProbeSuiteResult,
    RunState,
)


class Backend(Protocol):
    def run(self, prepared, candidate_dir: Path) -> BackendExecution: ...


class LoopController:
    def __init__(
        self,
        *,
        run_dir: Path,
        config: AppConfig,
        adapter: BenchmarkAdapter,
        backend: Backend | None = None,
        mutation_policy: L0MutationPolicy | None = None,
        probe_runner: ProbeRunner | None = None,
        active_probe_selector: ActiveProbeSelector | None = None,
    ):
        self.run_dir = run_dir.resolve()
        self.config = config
        self.adapter = adapter
        self.store = ArtifactStore(self.run_dir / "artifacts", adapter.artifact_descriptor)
        self.backend = backend or CommandBackend(config.backend)
        self.mutation_policy = mutation_policy or L0MutationPolicy()
        self.probe_runner = probe_runner or FixedCommandProbeRunner()
        self.active_probe_selector = active_probe_selector or ActiveProbeSelector()
        self.uniform_probe_selector = UniformProbeSelector()
        self.coevolution = (
            CoevolutionEngine(
                self.run_dir,
                config.method,
                allow_offspring=config.experiment.arm != "L3_no_evolve",
                protect_regressions=config.experiment.arm != "L3_no_protect",
            )
            if config.method.level in {"L3", "L4"}
            else None
        )
        self.harness_evolution = (
            HarnessEvolutionEngine(
                self.run_dir,
                config.method.harness_evolution,
                allow_mutation=not config.experiment.freezes_harness_outer_loop,
            )
            if config.method.level == "L4" and config.method.harness_evolution is not None
            else None
        )

    @classmethod
    def initialize(
        cls,
        *,
        run_dir: Path,
        task_source: Path,
        seed_artifact: Path,
        seed_evaluation: EvaluationResult,
        config: AppConfig,
        adapter: BenchmarkAdapter,
        run_id: str | None = None,
        expected_seed_artifact_id: str | None = None,
        seed_registry_id: str | None = None,
        seed_evaluation_fingerprint: str | None = None,
        initial_harness_profile: HarnessProfile | None = None,
    ) -> "LoopController":
        run_dir = run_dir.resolve()
        if run_dir.exists() and any(run_dir.iterdir()):
            raise FileExistsError(f"run directory is not empty: {run_dir}")
        run_dir.mkdir(parents=True, exist_ok=True)
        adapter.validate_capabilities()
        controller = cls(run_dir=run_dir, config=config, adapter=adapter)
        stage = run_dir / ".seed_stage"
        try:
            adapter.stage_artifact(seed_artifact.resolve(), stage)
            gate = adapter.validate(stage, config.gates)
            atomic_write_json(run_dir / "seed_gate.json", gate.to_dict())
            if not gate.passed:
                raise ValueError(f"seed failed gates: {gate.errors}")
            seed = controller.store.snapshot(stage)
            if expected_seed_artifact_id and seed.artifact_id != expected_seed_artifact_id:
                raise ValueError("seed artifact differs from the frozen registry record")
        finally:
            if stage.exists():
                shutil.rmtree(stage)
        if controller.coevolution is not None:
            controller.coevolution.initialize(seed=seed, evaluation=seed_evaluation)
        seed_harness = (
            controller.harness_evolution.initialize(initial_harness_profile)
            if controller.harness_evolution is not None
            else None
        )
        actual_id = run_id or run_dir.name
        atomic_write_json(run_dir / "manifest.json", {
            "schema_version": "2.0",
            "run_id": actual_id,
            "benchmark_id": adapter.adapter_id,
            "benchmark_capabilities": adapter.capabilities,
            "experiment": {
                "arm": config.experiment.arm,
                "neutral_agent_feedback": config.experiment.arm in {"retry3", "parent_only"},
                "seed_parent_for_every_attempt": (
                    config.experiment.freezes_artifact_parent
                ),
                "artifact_lineage_is_tested": (
                    not config.experiment.freezes_artifact_parent
                ),
                "uniform_probe_selection": config.experiment.arm == "L2_uniform",
                "probe_offspring_enabled": (
                    config.experiment.arm != "L3_no_evolve"
                    if config.method.level in {"L3", "L4"} else None
                ),
                "probe_regression_protection_enabled": (
                    config.experiment.arm != "L3_no_protect"
                    if config.method.level in {"L3", "L4"} else None
                ),
            },
            "reliability": {
                "pause_on_infrastructure_failure": (
                    config.reliability.pause_on_infrastructure_failure
                ),
                "infrastructure_attempts_consume_scientific_budget": (
                    config.reliability.count_infrastructure_attempts_in_evaluator_budget
                ),
            },
            "budgets": {
                "model_calls": config.evolution.effective_max_model_calls,
                "evaluator_queries": config.evolution.effective_max_evaluator_queries,
                "probe_calls": config.method.max_probe_calls,
            },
            "method": {
                "level": config.method.level,
                "observation_contract": config.method.observation_contract,
                "search_oracle": {
                    "L0": "benchmark evaluator",
                    "L1": "benchmark evaluator + configuration-frozen fixed probes",
                    "L2": "benchmark evaluator + actively selected frozen probe catalog",
                    "L3": "benchmark evaluator + coevolving bounded probe archive",
                    "L4": "benchmark evaluator + coevolving probe archive + episode-frozen Agent/engine harness",
                }[config.method.level],
                "probe_fitness_oracle": (
                    "paired failure discovery over game archive"
                    if config.method.level in {"L3", "L4"}
                    else None
                ),
                "report_oracle": "benchmark evaluator",
                "seed_evaluation_counted_in_budget": False,
                "probe_catalog_ids": [probe.probe_id for probe in config.method.fixed_probes],
                "max_probe_calls": config.method.max_probe_calls,
                "active_selection": (
                    None
                    if config.method.active_selection is None
                    else {
                        "policy_version": (
                            UniformProbeSelector.policy_version
                            if config.experiment.arm == "L2_uniform"
                            else ActiveProbeSelector.policy_version
                        ),
                        "max_selected_probes": config.method.active_selection.max_selected_probes,
                        "min_observations_per_probe": (
                            config.method.active_selection.min_observations_per_probe
                        ),
                    }
                ),
                "probe_family_ids": [
                    family.family_id for family in config.method.probe_families
                ],
                "harness_evolution": (
                    None
                    if config.method.harness_evolution is None
                    else {
                        "policy_version": HarnessEvolutionEngine.policy_version,
                        "module_ids": [
                            module.module_id
                            for module in config.method.harness_evolution.modules
                        ],
                        "tool_interface_ids": [
                            interface.interface_id
                            for interface in (
                                config.method.harness_evolution.tool_interfaces
                            )
                        ],
                        "max_active_modules": (
                            config.method.harness_evolution.max_active_modules
                        ),
                        "max_active_tool_interfaces": (
                            config.method.harness_evolution.max_active_tool_interfaces
                        ),
                        "mutation_width": config.method.harness_evolution.mutation_width,
                        "timescale": "outer_epoch_only",
                        "replay_min_cases": config.method.harness_evolution.replay_min_cases,
                        "promotion_delta_min": (
                            config.method.harness_evolution.promotion_delta_min
                        ),
                        "max_case_regression": (
                            config.method.harness_evolution.max_case_regression
                        ),
                        "paired_replay_promotion": True,
                    }
                ),
            },
            "task_source": str(task_source.resolve()),
            "config_fingerprint": config.fingerprint,
            "seed_artifact_id": seed.artifact_id,
            "seed_registry_id": seed_registry_id,
            "seed_evaluation_fingerprint": seed_evaluation_fingerprint,
            "frozen_agent": config.method.level != "L4",
            "harness_frozen_within_episode": config.method.level == "L4",
            "harness_updates_allowed_between_episodes": config.method.level == "L4",
            "artifact_parent_frozen_to_seed": config.experiment.freezes_artifact_parent,
            "frozen_evaluator": True,
            "created_at": utc_now(),
        })
        atomic_write_json(run_dir / "seed_evaluation.json", seed_evaluation.to_dict())
        state = RunState(
            schema_version="2.0",
            run_id=actual_id,
            benchmark_id=adapter.adapter_id,
            status="initialized",
            seed_artifact_id=seed.artifact_id,
            champion_artifact_id=seed.artifact_id,
            champion_evaluation=seed_evaluation.to_dict(),
            seed_harness_id=(None if seed_harness is None else seed_harness.harness_id),
            champion_harness_id=(None if seed_harness is None else seed_harness.harness_id),
        )
        atomic_write_json(run_dir / "state.json", state.to_dict())
        return controller

    def load_state(self) -> RunState:
        return RunState.from_dict(read_json(self.run_dir / "state.json"))

    def evolve(self) -> RunState:
        manifest = read_json(self.run_dir / "manifest.json")
        if manifest.get("config_fingerprint") != self.config.fingerprint:
            raise ValueError("configuration changed since initialization; start a new comparable run")
        if manifest.get("benchmark_id") != self.adapter.adapter_id:
            raise ValueError("benchmark adapter differs from initialized run")
        task_source = Path(str(manifest["task_source"]))
        with RunLock(self.run_dir):
            state = self.load_state()
            if self.coevolution is not None:
                seed = self.store.get(state.seed_artifact_id)
                seed_evaluation = EvaluationResult.from_dict(
                    read_json(self.run_dir / "seed_evaluation.json")
                )
                self.coevolution.ensure_initialized(
                    seed=seed,
                    evaluation=seed_evaluation,
                )
            if state.status == "completed":
                return state
            if state.status == "paused_infrastructure":
                return state
            if self.config.evolution.stop_on_terminal_success and state.champion_result.terminal_success:
                state.status = "completed"
                state.stop_reason = "seed or current champion already satisfies terminal benchmark condition"
                self._save(state)
                self.write_report(state)
                return state
            budget_reason = self._budget_stop_reason(state)
            if budget_reason:
                state.status = "completed"
                state.stop_reason = budget_reason
                self._save(state)
                self.write_report(state)
                return state
            state.status = "running"
            state.stop_reason = None
            self._save(state)

            while state.next_generation <= self.config.evolution.max_generations:
                budget_reason = self._budget_stop_reason(state)
                if budget_reason:
                    state.status = "completed"
                    state.stop_reason = budget_reason
                    self._save(state)
                    self.write_report(state)
                    return state
                if state.consecutive_rejections >= self.config.evolution.stop_after_rejections:
                    state.status = "stagnated"
                    state.stop_reason = f"{state.consecutive_rejections} consecutive quality rejections"
                    self._save(state)
                    self.write_report(state)
                    return state
                generation = state.next_generation
                candidate_index = state.next_candidate
                parent_id, parent_evaluation = self._attempt_parent(state)
                history = [AttemptRecord.from_dict(item) for item in state.attempts]
                if self.config.experiment.arm in {"retry3", "parent_only"}:
                    intent = MutationIntent(
                        "ImproveArtifact",
                        None,
                        "Make one coherent improvement using only the task and parent artifact.",
                    )
                else:
                    intent = self.mutation_policy.select(
                        parent=parent_evaluation,
                        history=history,
                        generation=generation,
                        candidate_index=candidate_index,
                        capabilities=self.adapter.capabilities,
                    )
                harness_profile: HarnessProfile | None = None
                attempt_probes, probe_decision = self._select_attempt_probes(
                    history=history,
                    intent=intent,
                    generation=generation,
                    candidate_index=candidate_index,
                )
                required_probe_calls = 2 * len(attempt_probes)
                if state.probe_calls + required_probe_calls > self.config.method.max_probe_calls:
                    state.status = "completed"
                    state.stop_reason = f"{self.config.method.level} probe pair budget exhausted"
                    self._save(state)
                    self.write_report(state)
                    return state
                candidate_dir = _next_candidate_dir(
                    self.run_dir / f"generation_{generation:03d}" / f"candidate_{candidate_index:02d}"
                )
                candidate_dir.mkdir(parents=True)
                if probe_decision is not None:
                    atomic_write_json(
                        candidate_dir / "probe_selection.json",
                        probe_decision.to_dict(),
                    )
                parent_probes = self._run_probe_suite(
                    state=state,
                    probes=attempt_probes,
                    artifact=self.store.path(parent_id),
                    task_source=task_source,
                    candidate_dir=candidate_dir,
                    phase="parent",
                )
                if parent_probes is not None and not parent_probes.infrastructure_ok:
                    attempt = self._pre_agent_probe_failure(
                        parent_id=parent_id,
                        intent=intent,
                        candidate_dir=candidate_dir,
                        generation=generation,
                        candidate_index=candidate_index,
                        suite=parent_probes,
                        probe_decision=probe_decision,
                    )
                    state.attempts.append(attempt.to_dict())
                    self._record_coevolution(
                        attempt=attempt,
                        evaluation=None,
                        parent_probes=parent_probes,
                        candidate_probes=None,
                        probe_decision=probe_decision,
                    )
                    if self._register_infrastructure_failure(state, attempt):
                        return state
                    self._advance(state, candidate_index)
                    self._save(state)
                    continue
                if self.harness_evolution is not None:
                    if state.champion_harness_id is None:
                        raise RuntimeError("L4 episode is missing its frozen harness")
                    # L4 changes harnesses only between complete benchmark
                    # episodes. Every attempt in this run therefore receives
                    # the exact same content-addressed profile.
                    harness_profile = self.harness_evolution.get(
                        state.champion_harness_id
                    )
                if self.config.experiment.arm in {"retry3", "parent_only"}:
                    feedback = compile_neutral_feedback(
                        run_id=state.run_id,
                        generation=generation,
                        candidate_index=candidate_index,
                        parent_artifact_id=parent_id,
                        intent=intent,
                    )
                else:
                    feedback = compile_feedback(
                        run_id=state.run_id,
                        generation=generation,
                        candidate_index=candidate_index,
                        parent_artifact_id=parent_id,
                        parent=parent_evaluation,
                        history=history,
                        intent=intent,
                        disclosure_level=self.config.evolution.feedback_disclosure,
                        method_level=self.config.method.level,
                        fixed_probe_observations=_probe_feedback(parent_probes),
                        active_probe_selection=(
                            probe_decision.to_dict() if probe_decision is not None else None
                        ),
                        agent_harness=(
                            None
                            if harness_profile is None
                            else {
                                **harness_profile.to_dict(),
                                "rendered_instruction": self.harness_evolution.render(
                                    harness_profile
                                ),
                            }
                        ),
                        context_compiler=(
                            None
                            if harness_profile is None
                            else harness_profile.context_compiler.to_dict()
                        ),
                    )
                context = AttemptContext(state.run_id, generation, candidate_index)
                prepared, result = self._execute_agent_call(
                    state=state,
                    task_source=task_source,
                    parent_id=parent_id,
                    feedback=feedback,
                    candidate_dir=candidate_dir,
                    context=context,
                )
                recovery_events: list[dict] = []
                recovery_limit = (
                    0
                    if harness_profile is None
                    else harness_profile.recovery_policy.infrastructure_retries
                )
                while (
                    self._is_infrastructure_result(result)
                    and len(recovery_events) < recovery_limit
                    and state.model_calls
                    < self.config.evolution.effective_max_model_calls
                ):
                    retry_number = len(recovery_events) + 1
                    recovery_dir = candidate_dir / f"recovery_{retry_number:02d}"
                    recovery_dir.mkdir(parents=True, exist_ok=True)
                    retry_feedback = copy.deepcopy(feedback)
                    retry_feedback["runtime_recovery"] = {
                        "event": "infrastructure_failure",
                        "attempt": retry_number,
                        "maximum": recovery_limit,
                        "previous_error": result.error or "missing normalized evaluation",
                        "policy_frozen_before_episode": True,
                    }
                    prepared, result = self._execute_agent_call(
                        state=state,
                        task_source=task_source,
                        parent_id=parent_id,
                        feedback=retry_feedback,
                        candidate_dir=recovery_dir,
                        context=context,
                    )
                    recovery_events.append({
                        "retry": retry_number,
                        "result_error": result.error,
                        "evaluation_present": result.evaluation is not None,
                        "directory": str(recovery_dir),
                    })
                if recovery_events:
                    atomic_write_json(candidate_dir / "recovery.json", {
                        "policy": harness_profile.recovery_policy.to_dict(),
                        "events": recovery_events,
                        "final_infrastructure_failure": self._is_infrastructure_result(result),
                    })
                gate, candidate_probes = self._validate_candidate_result(
                    state=state,
                    result=result,
                    probes=attempt_probes,
                    task_source=task_source,
                    output_dir=candidate_dir,
                )
                validation_events: list[dict] = []
                validation_policy = (
                    None if harness_profile is None else harness_profile.validation_policy
                )
                validation_failure = self._validation_failure(
                    validation_policy,
                    gate=gate,
                    parent_probes=parent_probes,
                    candidate_probes=candidate_probes,
                    attempt_probes=attempt_probes,
                )
                while (
                    validation_policy is not None
                    and validation_failure is not None
                    and len(validation_events) < validation_policy.repair_attempts
                    and state.model_calls < self.config.evolution.effective_max_model_calls
                    and state.evaluator_queries
                    < self.config.evolution.effective_max_evaluator_queries
                    and state.probe_calls + len(attempt_probes)
                    <= self.config.method.max_probe_calls
                ):
                    repair_number = len(validation_events) + 1
                    repair_dir = candidate_dir / f"validation_repair_{repair_number:02d}"
                    repair_dir.mkdir(parents=True, exist_ok=True)
                    repair_feedback = copy.deepcopy(feedback)
                    repair_feedback["runtime_validation_repair"] = {
                        "failure": validation_failure,
                        "attempt": repair_number,
                        "maximum": validation_policy.repair_attempts,
                        "policy_frozen_before_episode": True,
                    }
                    prepared, result = self._execute_agent_call(
                        state=state,
                        task_source=task_source,
                        parent_id=parent_id,
                        feedback=repair_feedback,
                        candidate_dir=repair_dir,
                        context=context,
                    )
                    gate, candidate_probes = self._validate_candidate_result(
                        state=state,
                        result=result,
                        probes=attempt_probes,
                        task_source=task_source,
                        output_dir=repair_dir,
                    )
                    validation_events.append({
                        "repair": repair_number,
                        "trigger": validation_failure,
                        "directory": str(repair_dir),
                    })
                    validation_failure = self._validation_failure(
                        validation_policy,
                        gate=gate,
                        parent_probes=parent_probes,
                        candidate_probes=candidate_probes,
                        attempt_probes=attempt_probes,
                    )
                if validation_events:
                    atomic_write_json(candidate_dir / "validation_recovery.json", {
                        "policy": validation_policy.to_dict(),
                        "events": validation_events,
                        "remaining_failure": validation_failure,
                    })
                attempt = self._process(
                    state=state,
                    parent_id=parent_id,
                    baseline=state.champion_result,
                    intent=intent,
                    candidate_dir=candidate_dir,
                    generation=generation,
                    candidate_index=candidate_index,
                    result=result,
                    gate=gate,
                    parent_probes=parent_probes,
                    candidate_probes=candidate_probes,
                    attempt_probes=attempt_probes,
                    probe_decision=probe_decision,
                )
                if harness_profile is not None:
                    attempt.parent_harness_id = harness_profile.parent_harness_id
                    attempt.harness_id = harness_profile.harness_id
                    attempt.harness_modules = list(harness_profile.active_modules)
                    atomic_write_json(candidate_dir / "selection.json", attempt.to_dict())
                state.attempts.append(attempt.to_dict())
                self._record_coevolution(
                    attempt=attempt,
                    evaluation=result.evaluation,
                    parent_probes=parent_probes,
                    candidate_probes=candidate_probes,
                    probe_decision=probe_decision,
                )
                if (
                    attempt.status == "infra_failed"
                    and self._register_infrastructure_failure(state, attempt)
                ):
                    return state
                if attempt.accepted:
                    assert attempt.artifact_id and result.evaluation
                    state.champion_artifact_id = attempt.artifact_id
                    state.champion_evaluation = result.evaluation.to_dict()
                    state.consecutive_rejections = 0
                elif attempt.status != "infra_failed":
                    state.consecutive_rejections += 1

                if attempt.accepted and result.evaluation and result.evaluation.terminal_success and self.config.evolution.stop_on_terminal_success:
                    state.status = "completed"
                    state.stop_reason = "benchmark terminal success reached"
                    self._advance(state, candidate_index)
                    self._save(state)
                    self.write_report(state)
                    return state
                self._advance(state, candidate_index)
                self._save(state)

            state.status = "completed"
            state.stop_reason = "generation budget exhausted"
            self._save(state)
            self.write_report(state)
            return state

    def _execute_agent_call(
        self,
        *,
        state: RunState,
        task_source: Path,
        parent_id: str,
        feedback: dict,
        candidate_dir: Path,
        context: AttemptContext,
    ):
        atomic_write_json(candidate_dir / "feedback.json", feedback)
        prepared = self.adapter.prepare(
            task_source=task_source,
            parent_artifact=self.store.path(parent_id),
            feedback=feedback,
            candidate_dir=candidate_dir,
            context=context,
        )
        # Reserve the call before starting the external process. A crash cannot
        # silently grant either the main path or a recovery branch an extra call.
        state.model_calls += 1
        self._save(state)
        execution = self.backend.run(prepared, candidate_dir)
        result = self.adapter.collect(prepared, execution)
        if result.evaluator_queries:
            state.evaluator_attempts += result.evaluator_queries
            if result.error is None and result.evaluation is not None:
                state.evaluator_queries += result.evaluator_queries
            self._save(state)
        return prepared, result

    @staticmethod
    def _is_infrastructure_result(result) -> bool:
        return bool(
            result.error
            or result.artifact_dir is None
            or result.evaluation is None
        )

    def _validate_candidate_result(
        self,
        *,
        state: RunState,
        result,
        probes: Sequence[FixedProbeConfig],
        task_source: Path,
        output_dir: Path,
    ) -> tuple[GateResult | None, ProbeSuiteResult | None]:
        if result.artifact_dir is None:
            return None, None
        gate = self.adapter.validate(result.artifact_dir, self.config.gates)
        atomic_write_json(output_dir / "gate.json", gate.to_dict())
        candidate_probes = None
        if gate.passed:
            candidate_probes = self._run_probe_suite(
                state=state,
                probes=probes,
                artifact=result.artifact_dir,
                task_source=task_source,
                candidate_dir=output_dir,
                phase="candidate",
            )
        return gate, candidate_probes

    @staticmethod
    def _validation_failure(
        policy,
        *,
        gate: GateResult | None,
        parent_probes: ProbeSuiteResult | None,
        candidate_probes: ProbeSuiteResult | None,
        attempt_probes: Sequence[FixedProbeConfig],
    ) -> dict | None:
        if policy is None or gate is None:
            return None
        if not gate.passed and policy.repair_on_gate_failure:
            return {"kind": "gate_failure", "diagnostics": list(gate.errors)}
        if gate.passed and policy.repair_on_probe_failure:
            if candidate_probes is not None and not candidate_probes.infrastructure_ok:
                return None
            reasons = _probe_selection_reasons(
                attempt_probes,
                parent_probes,
                candidate_probes,
            )
            if reasons:
                return {"kind": "probe_failure", "diagnostics": reasons}
        return None

    def _process(
        self,
        *,
        state: RunState,
        parent_id: str,
        baseline: EvaluationResult,
        intent,
        candidate_dir: Path,
        generation: int,
        candidate_index: int,
        result,
        gate: GateResult | None,
        parent_probes: ProbeSuiteResult | None,
        candidate_probes: ProbeSuiteResult | None,
        attempt_probes: Sequence[FixedProbeConfig],
        probe_decision: ProbeSelectionDecision | None,
    ) -> AttemptRecord:
        attempt_id = f"g{generation:03d}_c{candidate_index:02d}"
        if result.error or result.artifact_dir is None:
            attempt = AttemptRecord(
                attempt_id=attempt_id,
                generation=generation,
                candidate_index=candidate_index,
                parent_artifact_id=parent_id,
                artifact_id=None,
                status="infra_failed",
                primary_score=None,
                score_delta=None,
                intent_kind=intent.kind,
                accepted=False,
                reasons=[result.error or "candidate artifact missing"],
                objectives={},
                diagnostics=[],
                candidate_dir=str(candidate_dir),
                mutation_intent=intent.to_dict(),
                probe_summary=_probe_summary(
                    parent_probes, candidate_probes, probe_decision
                ),
            )
            atomic_write_json(candidate_dir / "selection.json", attempt.to_dict())
            return attempt
        if gate is None:
            raise RuntimeError("candidate gate result is missing")
        artifact = self.store.snapshot(result.artifact_dir)
        evaluation = result.evaluation
        if evaluation:
            atomic_write_json(candidate_dir / "evaluation.json", evaluation.to_dict())
        accepted = False
        status = "rejected"
        delta = None
        reasons: list[str] = []
        probe_reasons: list[str] = []
        if not gate.passed:
            status = "gate_failed"
            reasons.extend(gate.errors)
        elif evaluation is None:
            status = "infra_failed"
            reasons.append("benchmark produced no normalized evaluation")
        elif candidate_probes is not None and not candidate_probes.infrastructure_ok:
            status = "infra_failed"
            reasons.extend(_probe_infrastructure_errors(candidate_probes))
        elif not evaluation.feasible:
            reasons.append("candidate is infeasible")
        elif evaluation.primary_score is None or baseline.primary_score is None:
            reasons.append("candidate or baseline primary score is missing")
        else:
            delta = evaluation.primary_score - baseline.primary_score
            threshold = 0.0 if self.config.experiment.arm == "retry3" else self.config.evolution.delta_min
            regressions = (
                []
                if self.config.experiment.arm == "retry3"
                else _objective_regressions(
                    baseline,
                    evaluation,
                    self.config.evolution.objective_regression_epsilon,
                )
            )
            reasons.extend(regressions)
            probe_reasons = _probe_selection_reasons(
                attempt_probes,
                parent_probes,
                candidate_probes,
            )
            reasons.extend(probe_reasons)
            if probe_reasons:
                status = "probe_failed"
            if delta < threshold:
                reasons.append(f"primary delta {delta:.6f} below {threshold:.6f}")
            if delta >= threshold and not regressions and not probe_reasons:
                accepted = True
                status = "accepted"
                reasons.append(
                    "candidate is the best feasible independent retry so far"
                    if self.config.experiment.arm == "retry3"
                    else "candidate exceeds the current champion under selection policy"
                )
        attempt = AttemptRecord(
            attempt_id=attempt_id,
            generation=generation,
            candidate_index=candidate_index,
            parent_artifact_id=parent_id,
            artifact_id=artifact.artifact_id,
            status=status,
            primary_score=evaluation.primary_score if evaluation else None,
            score_delta=delta,
            intent_kind=intent.kind,
            accepted=accepted,
            reasons=reasons,
            objectives=evaluation.objectives if evaluation else {},
            diagnostics=evaluation.diagnostics if evaluation else [],
            candidate_dir=str(candidate_dir),
            mutation_intent=intent.to_dict(),
            probe_summary=_probe_summary(parent_probes, candidate_probes, probe_decision),
        )
        atomic_write_json(candidate_dir / "selection.json", attempt.to_dict())
        return attempt

    def _evaluation_for(self, state: RunState, artifact_id: str) -> EvaluationResult:
        if artifact_id == state.champion_artifact_id:
            return state.champion_result
        for raw in reversed(state.attempts):
            if raw.get("artifact_id") == artifact_id:
                path = Path(str(raw["candidate_dir"])) / "evaluation.json"
                if path.is_file():
                    return EvaluationResult.from_dict(read_json(path))
        if artifact_id == state.seed_artifact_id:
            return EvaluationResult.from_dict(read_json(self.run_dir / "seed_evaluation.json"))
        raise KeyError(f"evaluation missing for artifact {artifact_id}")

    def _attempt_parent(self, state: RunState) -> tuple[str, EvaluationResult]:
        if self.config.experiment.freezes_artifact_parent:
            return (
                state.seed_artifact_id,
                EvaluationResult.from_dict(read_json(self.run_dir / "seed_evaluation.json")),
            )
        if self.config.experiment.arm == "parent_only":
            return state.champion_artifact_id, state.champion_result
        if state.generation_parent_artifact_id is None:
            state.generation_parent_artifact_id = state.champion_artifact_id
            self._save(state)
        parent_id = state.generation_parent_artifact_id
        return parent_id, self._evaluation_for(state, parent_id)

    def _advance(self, state: RunState, candidate_index: int) -> None:
        if candidate_index >= self.config.evolution.candidates_per_generation:
            state.next_generation += 1
            state.next_candidate = 1
            state.generation_parent_artifact_id = None
        else:
            state.next_candidate += 1

    def _save(self, state: RunState) -> None:
        state.updated_at = utc_now()
        atomic_write_json(self.run_dir / "state.json", state.to_dict())

    def _register_infrastructure_failure(
        self, state: RunState, attempt: AttemptRecord
    ) -> bool:
        state.infrastructure_failures += 1
        if not self.config.reliability.pause_on_infrastructure_failure:
            self._save(state)
            return False
        state.status = "paused_infrastructure"
        state.stop_reason = (
            f"infrastructure failure at {attempt.attempt_id}; artifact/evidence retained "
            "for evaluator-only recovery"
        )
        self._save(state)
        self.write_report(state)
        return True

    def _select_attempt_probes(
        self,
        *,
        history: Sequence[AttemptRecord],
        intent,
        generation: int,
        candidate_index: int,
    ) -> tuple[tuple[FixedProbeConfig, ...], ProbeSelectionDecision | None]:
        catalog = self.config.method.fixed_probes
        if self.config.method.level not in {"L2", "L3", "L4"}:
            return catalog, None
        if self.config.method.level in {"L3", "L4"}:
            if self.coevolution is None:
                raise RuntimeError(f"{self.config.method.level} coevolution engine is missing")
            catalog = self.coevolution.active_catalog()
        policy = self.config.method.active_selection
        if policy is None:
            raise RuntimeError(f"{self.config.method.level} active-selection policy is missing")
        selector = (
            self.uniform_probe_selector
            if self.config.experiment.arm == "L2_uniform"
            else self.active_probe_selector
        )
        decision = selector.select(
            catalog=catalog,
            policy=policy,
            history=history,
            intent=intent,
            generation=generation,
            candidate_index=candidate_index,
        )
        return selected_probes(catalog, decision), decision

    def _record_coevolution(
        self,
        *,
        attempt: AttemptRecord,
        evaluation: EvaluationResult | None,
        parent_probes: ProbeSuiteResult | None,
        candidate_probes: ProbeSuiteResult | None,
        probe_decision: ProbeSelectionDecision | None,
    ) -> None:
        if self.coevolution is None:
            return
        artifact = (
            None if attempt.artifact_id is None else self.store.get(attempt.artifact_id)
        )
        self.coevolution.record_attempt(
            attempt=attempt,
            artifact=artifact,
            evaluation=evaluation,
            parent_probes=parent_probes,
            candidate_probes=candidate_probes,
            decision=probe_decision,
        )

    def _run_probe_suite(
        self,
        *,
        state: RunState,
        probes: Sequence[FixedProbeConfig],
        artifact: Path,
        task_source: Path,
        candidate_dir: Path,
        phase: str,
    ) -> ProbeSuiteResult | None:
        if not probes:
            return None
        stage = candidate_dir / "probe_work" / phase / "artifact"
        output = candidate_dir / "probes" / phase
        try:
            self.adapter.stage_artifact(artifact, stage)
        except Exception as exc:
            results = [
                ProbeResult(
                    probe_id=probe.probe_id,
                    status="stage_failed",
                    passed=None,
                    score=None,
                    return_code=None,
                    duration_seconds=0.0,
                    log_path="",
                    diagnostics=[f"probe artifact staging failed: {exc}"],
                )
                for probe in probes
            ]
            suite = ProbeSuiteResult(phase=phase, results=results, calls=0)
            atomic_write_json(output / "suite.json", suite.to_dict())
            return suite
        context = {
            **self.adapter.probe_context(task_source=task_source),
            "artifact_dir": str(stage.resolve()),
            "candidate_dir": str(candidate_dir.resolve()),
            "phase": phase,
            "run_dir": str(self.run_dir),
        }
        suite = self.probe_runner.run_suite(
            probes,
            context=context,
            output_dir=output,
            phase=phase,
        )
        state.probe_calls += suite.calls
        self._save(state)
        return suite

    def _pre_agent_probe_failure(
        self,
        *,
        parent_id: str,
        intent,
        candidate_dir: Path,
        generation: int,
        candidate_index: int,
        suite: ProbeSuiteResult,
        probe_decision: ProbeSelectionDecision | None,
    ) -> AttemptRecord:
        attempt = AttemptRecord(
            attempt_id=f"g{generation:03d}_c{candidate_index:02d}",
            generation=generation,
            candidate_index=candidate_index,
            parent_artifact_id=parent_id,
            artifact_id=None,
            status="infra_failed",
            primary_score=None,
            score_delta=None,
            intent_kind=intent.kind,
            accepted=False,
            reasons=_probe_infrastructure_errors(suite),
            objectives={},
            diagnostics=[],
            candidate_dir=str(candidate_dir),
            mutation_intent=intent.to_dict(),
            probe_summary=_probe_summary(suite, None, probe_decision),
        )
        atomic_write_json(candidate_dir / "selection.json", attempt.to_dict())
        return attempt

    def _budget_stop_reason(self, state: RunState) -> str | None:
        if state.model_calls >= self.config.evolution.effective_max_model_calls:
            return f"{self.config.method.level} model call budget exhausted"
        required_queries = int(
            self.adapter.capabilities.get("max_evaluator_queries_per_candidate", 1)
        )
        if (
            state.evaluator_queries + required_queries
            > self.config.evolution.effective_max_evaluator_queries
        ):
            return f"{self.config.method.level} evaluator query budget exhausted"
        if self.config.method.level == "L1":
            required_probe_calls = 2 * len(self.config.method.fixed_probes)
            if state.probe_calls + required_probe_calls > self.config.method.max_probe_calls:
                return "L1 fixed probe budget exhausted"
        return None

    def write_report(self, state: RunState | None = None) -> Path:
        state = state or self.load_state()
        seed = EvaluationResult.from_dict(read_json(self.run_dir / "seed_evaluation.json"))
        champion = state.champion_result
        lines = [
            f"# Game Loop report: {state.run_id}", "",
            f"- Benchmark adapter: `{state.benchmark_id}`",
            f"- Experiment arm: `{self.config.experiment.arm}`",
            f"- Status: `{state.status}`",
            f"- Stop reason: {state.stop_reason or '-'}",
            f"- Seed score: {_fmt(seed.primary_score)}",
            f"- Champion score: {_fmt(champion.primary_score)}",
            f"- Terminal success: `{champion.terminal_success}`",
            f"- Attempts: {len(state.attempts)}",
            f"- Model calls: {state.model_calls}/{self.config.evolution.effective_max_model_calls}",
            f"- Evaluator queries: {state.evaluator_queries}/{self.config.evolution.effective_max_evaluator_queries}",
            f"- Physical evaluator attempts: {state.evaluator_attempts}",
            f"- Infrastructure failures: {state.infrastructure_failures}",
            f"- Probe calls: {state.probe_calls}/{self.config.method.max_probe_calls}",
            f"- Artifact parent frozen to seed: `{self.config.experiment.freezes_artifact_parent}`",
            f"- In-episode Harness mutations: {state.harness_mutations} (must remain 0)",
            f"- Episode Harness: `{state.champion_harness_id or '-'}`",
            "", "## Attempts", "",
            "| Attempt | Status | Intent | Harness | Score | Delta |",
            "|---|---|---|---|---:|---:|",
        ]
        for raw in state.attempts:
            attempt = AttemptRecord.from_dict(raw)
            lines.append(
                f"| `{attempt.attempt_id}` | {attempt.status} | {attempt.intent_kind} | "
                f"`{attempt.harness_id or '-'}` | {_fmt(attempt.primary_score)} | "
                f"{_fmt(attempt.score_delta)} |"
            )
        if self.coevolution is not None and self.coevolution.probe_archive_path.is_file():
            probe_archive = read_json(self.coevolution.probe_archive_path)
            game_archive = read_json(self.coevolution.game_archive_path)
            specimens = list(probe_archive.get("specimens", {}).values())
            lines += [
                "", "## Coevolution archives", "",
                f"- Games: {len(game_archive.get('games', {}))}",
                f"- Probe specimens: {len(specimens)}",
                f"- Active probe specimens: {sum(bool(item.get('active')) for item in specimens)}",
                f"- Regression-protected specimens: {sum(bool(item.get('protected')) for item in specimens)}",
            ]
        if self.harness_evolution is not None and state.champion_harness_id:
            profile = self.harness_evolution.get(state.champion_harness_id)
            lines += [
                "", "## Episode-frozen Agent Harness", "",
                f"- Harness id: `{profile.harness_id}`",
                f"- Parent harness: `{profile.parent_harness_id or '-'}`",
                f"- Active modules: {', '.join(profile.active_modules) or '-'}",
                f"- Context compiler: `{profile.context_compiler.to_dict()}`",
                f"- Recovery policy: `{profile.recovery_policy.to_dict()}`",
                f"- Validation policy: `{profile.validation_policy.to_dict()}`",
            ]
        lines += ["", "## Champion objectives", ""]
        lines.extend(f"- {name}: {score:.4f}" for name, score in sorted(champion.objectives.items()))
        report = self.run_dir / "report.md"
        report.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return report


def _objective_regressions(parent: EvaluationResult, candidate: EvaluationResult, epsilon: float) -> list[str]:
    reasons = []
    for name, score in parent.objectives.items():
        if name in candidate.objectives and score - candidate.objectives[name] > epsilon:
            reasons.append(f"objective {name} regressed by {score - candidate.objectives[name]:.6f}")
    return reasons


def _probe_feedback(suite: ProbeSuiteResult | None) -> list[dict] | None:
    if suite is None:
        return None
    return [
        {
            "probe_id": result.probe_id,
            "status": result.status,
            "passed": result.passed,
            "score": result.score,
            "diagnostics": result.diagnostics[:3],
        }
        for result in suite.results
    ]


def _probe_summary(
    parent: ProbeSuiteResult | None,
    candidate: ProbeSuiteResult | None,
    decision: ProbeSelectionDecision | None = None,
) -> dict:
    def compact(suite: ProbeSuiteResult | None) -> list[dict]:
        if suite is None:
            return []
        return [
            {
                "probe_id": item.probe_id,
                "status": item.status,
                "passed": item.passed,
                "score": item.score,
            }
            for item in suite.results
        ]

    return {
        "selected_probe_ids": (
            [item.probe_id for item in parent.results]
            if decision is None and parent is not None
            else [] if decision is None else list(decision.selected_probe_ids)
        ),
        "selection_policy": None if decision is None else decision.policy_version,
        "parent": compact(parent),
        "candidate": compact(candidate),
    }


def _probe_infrastructure_errors(suite: ProbeSuiteResult) -> list[str]:
    reasons = []
    for result in suite.results:
        if result.status != "completed":
            detail = result.diagnostics[0] if result.diagnostics else result.status
            reasons.append(f"fixed probe {result.probe_id} infrastructure failure: {detail}")
    return reasons or ["fixed probe suite infrastructure failure"]


def _probe_selection_reasons(
    configs: Sequence[FixedProbeConfig],
    parent: ProbeSuiteResult | None,
    candidate: ProbeSuiteResult | None,
) -> list[str]:
    if not configs:
        return []
    if parent is None or candidate is None:
        return ["fixed probe pair is incomplete"]
    parent_by_id = {result.probe_id: result for result in parent.results}
    candidate_by_id = {result.probe_id: result for result in candidate.results}
    reasons: list[str] = []
    for config in configs:
        before = parent_by_id.get(config.probe_id)
        after = candidate_by_id.get(config.probe_id)
        if before is None or after is None:
            reasons.append(f"fixed probe {config.probe_id} missing from paired comparison")
            continue
        if config.selection_mode == "required":
            if after.passed is not True:
                reasons.append(f"required fixed probe {config.probe_id} did not pass")
            continue
        if before.passed is True and after.passed is not True:
            reasons.append(f"fixed probe {config.probe_id} regressed from pass to fail")
            continue
        if (
            before.score is not None
            and after.score is not None
            and before.score - after.score > config.regression_epsilon
        ):
            reasons.append(
                f"fixed probe {config.probe_id} score regressed by "
                f"{before.score - after.score:.6f}"
            )
    return reasons


def _next_candidate_dir(preferred: Path) -> Path:
    if not preferred.exists():
        return preferred
    index = 1
    while preferred.with_name(f"{preferred.name}_retry_{index:02d}").exists():
        index += 1
    return preferred.with_name(f"{preferred.name}_retry_{index:02d}")


def _fmt(value: float | None) -> str:
    return "-" if value is None else f"{value:.4f}"
