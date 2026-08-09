from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from game_loop.config import FixedProbeConfig, MethodConfig, ProbeFamilyConfig
from game_loop.core.models import (
    ArtifactRecord,
    AttemptRecord,
    EvaluationResult,
    ProbeSuiteResult,
)
from game_loop.utils import atomic_write_json, read_json, utc_now

from .active_probes import ProbeSelectionDecision


def _probe_id(family_id: str, gene_name: str, gene_value: int) -> str:
    return f"{family_id}__{gene_name}_{gene_value}"


def _fitness(stats: dict[str, Any]) -> float:
    trials = max(int(stats.get("trials", 0)), 1)
    return (
        int(stats.get("parent_passes", 0))
        + int(stats.get("candidate_passes", 0))
        + float(stats.get("separation_sum", 0.0))
    ) / (2 * trials)


def _materialize_probe(family: ProbeFamilyConfig, gene_value: int, probe_id: str) -> FixedProbeConfig:
    token = f"[[{family.gene.name}]]"
    command = tuple(
        part.replace(token, str(gene_value)) for part in family.template.command
    )
    return FixedProbeConfig(
        probe_id=probe_id,
        command=command,
        cwd=family.template.cwd,
        timeout_seconds=family.template.timeout_seconds,
        env=family.template.env,
        selection_mode=family.template.selection_mode,
        parser=family.template.parser,
        regression_epsilon=family.template.regression_epsilon,
        tags=family.template.tags,
    )


def _prune_archive(
    archive: dict[str, Any],
    families: dict[str, ProbeFamilyConfig],
    *,
    protect_regressions: bool,
) -> list[str]:
    pruned: list[str] = []
    specimens: dict[str, dict[str, Any]] = archive.setdefault("specimens", {})
    for family_id, family in families.items():
        active = [
            item for item in specimens.values()
            if item.get("family_id") == family_id and item.get("active")
        ]
        if len(active) <= family.archive_capacity:
            continue
        ranked = sorted(
            active,
            key=lambda item: (
                1 if protect_regressions and item.get("protected") else 0,
                float(item.get("fitness", _fitness(item.get("stats", {})))),
                item.get("probe_id", ""),
            ),
            reverse=True,
        )
        keep = {item["probe_id"] for item in ranked[: family.archive_capacity]}
        for item in active:
            if item["probe_id"] not in keep:
                item["active"] = False
                pruned.append(item["probe_id"])
    return pruned


class CoevolutionEngine:
    def __init__(
        self,
        run_dir: Path,
        method: MethodConfig,
        *,
        allow_offspring: bool = True,
        protect_regressions: bool = True,
    ):
        self.root = run_dir / "coevolution"
        self.method = method
        self.allow_offspring = allow_offspring
        self.protect_regressions = protect_regressions
        self.families = {family.family_id: family for family in method.probe_families}

    @property
    def probe_archive_path(self) -> Path:
        return self.root / "probe_archive.json"

    @property
    def game_archive_path(self) -> Path:
        return self.root / "game_archive.json"

    @property
    def interaction_matrix_path(self) -> Path:
        return self.root / "interaction_matrix.json"

    def initialize(self, *, seed: ArtifactRecord, evaluation: EvaluationResult) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        specimens: dict[str, dict[str, Any]] = {}
        for family in self.method.probe_families:
            probe_id = _probe_id(family.family_id, family.gene.name, family.gene.initial)
            specimens[probe_id] = {
                "probe_id": probe_id,
                "family_id": family.family_id,
                "gene_name": family.gene.name,
                "gene_value": family.gene.initial,
                "parent_probe_id": None,
                "birth_attempt": "seed",
                "active": True,
                "protected": False,
                "fitness": 0.0,
                "stats": {
                    "trials": 0,
                    "parent_passes": 0,
                    "candidate_passes": 0,
                    "regressions_found": 0,
                    "separation_sum": 0.0,
                    "last_attempt": None,
                },
                "created_at": utc_now(),
            }
        atomic_write_json(self.probe_archive_path, {
            "schema_version": "1.0",
            "policy": "bounded-parameter-coevolution-v1",
            "policy_options": {
                "allow_offspring": self.allow_offspring,
                "protect_regressions_during_pruning": self.protect_regressions,
            },
            "specimens": specimens,
            "events": [],
            "processed_attempts": [],
            "updated_at": utc_now(),
        })
        atomic_write_json(self.game_archive_path, {
            "schema_version": "1.0",
            "games": {
                seed.artifact_id: {
                    "artifact_id": seed.artifact_id,
                    "parent_artifact_id": None,
                    "latest_status": "seed",
                    "accepted": True,
                    "latest_primary_score": evaluation.primary_score,
                    "feasible": evaluation.feasible,
                    "payload_hash": seed.payload_hash,
                    "component_hashes": dict(seed.component_hashes),
                    "file_count": seed.file_count,
                    "total_bytes": seed.total_bytes,
                    "appearances": [{
                        "attempt_id": "seed",
                        "parent_artifact_id": None,
                        "status": "seed",
                        "accepted": True,
                        "primary_score": evaluation.primary_score,
                    }],
                    "created_at": utc_now(),
                }
            },
            "processed_attempts": [],
            "updated_at": utc_now(),
        })
        atomic_write_json(self.interaction_matrix_path, {
            "schema_version": "1.0",
            "games": {},
            "pair_events": [],
            "processed_attempts": [],
            "updated_at": utc_now(),
        })

    def active_catalog(self) -> tuple[FixedProbeConfig, ...]:
        archive = read_json(self.probe_archive_path)
        probes = list(self.method.fixed_probes)
        for specimen in archive.get("specimens", {}).values():
            if not specimen.get("active"):
                continue
            family = self.families.get(str(specimen.get("family_id", "")))
            if family is None:
                continue
            probes.append(
                _materialize_probe(
                    family,
                    int(specimen["gene_value"]),
                    str(specimen["probe_id"]),
                )
            )
        return tuple(probes)

    def record_attempt(
        self,
        *,
        attempt: AttemptRecord,
        artifact: ArtifactRecord | None,
        evaluation: EvaluationResult | None,
        parent_probes: ProbeSuiteResult | None,
        candidate_probes: ProbeSuiteResult | None,
        decision: ProbeSelectionDecision | None,
    ) -> None:
        event_key = f"{attempt.attempt_id}:{attempt.artifact_id or 'none'}"
        probe_archive = read_json(self.probe_archive_path)
        if event_key in probe_archive.setdefault("processed_attempts", []):
            return

        self._record_game(attempt, artifact, evaluation)
        self._record_interactions(attempt, decision, parent_probes, candidate_probes)
        offspring = self._update_probe_stats(
            probe_archive,
            attempt=attempt,
            decision=decision,
            parent_probes=parent_probes,
            candidate_probes=candidate_probes,
        )
        pruned = _prune_archive(
            probe_archive,
            self.families,
            protect_regressions=self.protect_regressions,
        )
        probe_archive.setdefault("events", []).append({
            "event_key": event_key,
            "attempt_id": attempt.attempt_id,
            "selected_probe_ids": list(decision.selected_probe_ids) if decision else [],
            "offspring": offspring,
            "pruned": pruned,
            "created_at": utc_now(),
        })
        probe_archive["processed_attempts"].append(event_key)
        probe_archive["updated_at"] = utc_now()
        atomic_write_json(self.probe_archive_path, probe_archive)

    def _record_game(
        self,
        attempt: AttemptRecord,
        artifact: ArtifactRecord | None,
        evaluation: EvaluationResult | None,
    ) -> None:
        if artifact is None:
            return
        archive = read_json(self.game_archive_path)
        games = archive.setdefault("games", {})
        entry = games.setdefault(artifact.artifact_id, {
            "artifact_id": artifact.artifact_id,
            "parent_artifact_id": attempt.parent_artifact_id,
            "latest_status": attempt.status,
            "accepted": attempt.accepted,
            "latest_primary_score": attempt.primary_score,
            "feasible": bool(evaluation.feasible) if evaluation else False,
            "payload_hash": artifact.payload_hash,
            "component_hashes": dict(artifact.component_hashes),
            "file_count": artifact.file_count,
            "total_bytes": artifact.total_bytes,
            "appearances": [],
            "created_at": utc_now(),
        })
        entry["latest_status"] = attempt.status
        entry["accepted"] = attempt.accepted
        entry["latest_primary_score"] = attempt.primary_score
        if evaluation is not None:
            entry["feasible"] = evaluation.feasible
        entry.setdefault("appearances", []).append({
            "attempt_id": attempt.attempt_id,
            "parent_artifact_id": attempt.parent_artifact_id,
            "status": attempt.status,
            "accepted": attempt.accepted,
            "primary_score": attempt.primary_score,
        })
        archive.setdefault("processed_attempts", []).append(
            f"{attempt.attempt_id}:{artifact.artifact_id}"
        )
        archive["updated_at"] = utc_now()
        atomic_write_json(self.game_archive_path, archive)

    def _record_interactions(
        self,
        attempt: AttemptRecord,
        decision: ProbeSelectionDecision | None,
        parent_probes: ProbeSuiteResult | None,
        candidate_probes: ProbeSuiteResult | None,
    ) -> None:
        matrix = read_json(self.interaction_matrix_path)
        probe_ids = list(decision.selected_probe_ids) if decision else []
        matrix.setdefault("pair_events", []).append({
            "attempt_id": attempt.attempt_id,
            "parent_artifact_id": attempt.parent_artifact_id,
            "candidate_artifact_id": attempt.artifact_id,
            "probe_ids": probe_ids,
        })
        games = matrix.setdefault("games", {})
        artifact_ids = [attempt.parent_artifact_id]
        if attempt.artifact_id is not None:
            artifact_ids.append(attempt.artifact_id)
        for artifact_id in dict.fromkeys(artifact_ids):
            game = games.setdefault(artifact_id, {"probes": {}})
            probes = game.setdefault("probes", {})
            for suite in (parent_probes, candidate_probes):
                if suite is None:
                    continue
                for result in suite.results:
                    probes.setdefault(result.probe_id, []).append({
                        "attempt_id": attempt.attempt_id,
                        "phase": suite.phase,
                        "status": result.status,
                        "passed": result.passed,
                        "score": result.score,
                    })
        matrix.setdefault("processed_attempts", []).append(
            f"{attempt.attempt_id}:{attempt.artifact_id or 'none'}"
        )
        matrix["updated_at"] = utc_now()
        atomic_write_json(self.interaction_matrix_path, matrix)

    def _update_probe_stats(
        self,
        archive: dict[str, Any],
        *,
        attempt: AttemptRecord,
        decision: ProbeSelectionDecision | None,
        parent_probes: ProbeSuiteResult | None,
        candidate_probes: ProbeSuiteResult | None,
    ) -> list[str]:
        specimens: dict[str, dict[str, Any]] = archive.setdefault("specimens", {})
        selected = set(decision.selected_probe_ids) if decision else set()
        parent_by_id = {
            item.probe_id: item for item in (parent_probes.results if parent_probes else [])
        }
        candidate_by_id = {
            item.probe_id: item for item in (candidate_probes.results if candidate_probes else [])
        }
        offspring: list[str] = []
        for probe_id in selected:
            specimen = specimens.get(probe_id)
            if specimen is None:
                continue
            stats = specimen.setdefault("stats", {})
            stats["trials"] = int(stats.get("trials", 0)) + 1
            stats["last_attempt"] = attempt.attempt_id
            before = parent_by_id.get(probe_id)
            after = candidate_by_id.get(probe_id)
            if before is not None and before.passed is True:
                stats["parent_passes"] = int(stats.get("parent_passes", 0)) + 1
            if after is not None and after.passed is True:
                stats["candidate_passes"] = int(stats.get("candidate_passes", 0)) + 1
            if (
                before is not None
                and after is not None
                and before.passed is True
                and after.passed is not True
            ):
                stats["regressions_found"] = int(stats.get("regressions_found", 0)) + 1
                if self.protect_regressions:
                    specimen["protected"] = True
            if before is not None and after is not None:
                separation = 0.0
                if before.passed is not True and after.passed is True:
                    separation = 1.0
                elif before.score is not None and after.score is not None:
                    separation = max(0.0, after.score - before.score)
                stats["separation_sum"] = float(stats.get("separation_sum", 0.0)) + separation
            specimen["fitness"] = _fitness(stats)
            if self.allow_offspring:
                created = self._create_offspring(archive, specimen, attempt.attempt_id)
                if created is not None:
                    offspring.append(created)
        return offspring

    def _create_offspring(
        self,
        archive: dict[str, Any],
        parent: dict[str, Any],
        attempt_id: str,
    ) -> str | None:
        family = self.families.get(str(parent.get("family_id", "")))
        if family is None:
            return None
        gene = family.gene
        current = int(parent.get("gene_value", gene.initial))
        if gene.difficulty_direction == "increasing":
            nxt = current + gene.step
            if nxt > gene.maximum:
                return None
        else:
            nxt = current - gene.step
            if nxt < gene.minimum:
                return None
        probe_id = _probe_id(family.family_id, gene.name, nxt)
        specimens = archive.setdefault("specimens", {})
        if probe_id in specimens:
            return None
        specimens[probe_id] = {
            "probe_id": probe_id,
            "family_id": family.family_id,
            "gene_name": gene.name,
            "gene_value": nxt,
            "parent_probe_id": parent["probe_id"],
            "birth_attempt": attempt_id,
            "active": True,
            "protected": False,
            "fitness": 0.0,
            "stats": {
                "trials": 0,
                "parent_passes": 0,
                "candidate_passes": 0,
                "regressions_found": 0,
                "separation_sum": 0.0,
                "last_attempt": None,
            },
            "created_at": utc_now(),
        }
        return probe_id
