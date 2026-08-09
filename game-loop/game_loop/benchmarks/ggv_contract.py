from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, Sequence


class GGVInfrastructureError(RuntimeError):
    """The paper-compatible verification substrate did not complete."""


class GGVWorker(Protocol):
    """Pluggable local-reasoning worker for the GameGen-Verifier paper contract."""

    def invoke(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]: ...


@dataclass(frozen=True)
class CommandGGVWorker:
    command: tuple[str, ...]
    cwd: Path
    timeout_seconds: int = 600

    def invoke(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.command:
            raise GGVInfrastructureError("GGV worker command is not configured")
        request = {"schema_version": "ggv-worker-v1", "operation": operation, **payload}
        try:
            process = subprocess.run(
                self.command,
                cwd=self.cwd,
                input=json.dumps(request, ensure_ascii=False),
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise GGVInfrastructureError(f"GGV worker {operation} failed: {exc}") from exc
        if process.returncode != 0:
            detail = (process.stderr or process.stdout).strip()[-1000:]
            raise GGVInfrastructureError(
                f"GGV worker {operation} exited {process.returncode}: {detail}"
            )
        try:
            value = json.loads(process.stdout)
        except json.JSONDecodeError as exc:
            raise GGVInfrastructureError(
                f"GGV worker {operation} returned invalid JSON"
            ) from exc
        if not isinstance(value, dict):
            raise GGVInfrastructureError(f"GGV worker {operation} must return a JSON object")
        return value


def run_paper_compatible_ggv(
    *,
    specification_path: Path,
    artifact_dir: Path,
    work_dir: Path,
    worker: GGVWorker,
) -> dict[str, Any]:
    """Execute the paper's keypoint -> injected state -> bounded check contract.

    This is deliberately an interoperability harness, not a claim that the
    unreleased official GGV implementation is bundled in this repository.
    """

    work_dir.mkdir(parents=True, exist_ok=True)
    base = {
        "specification_path": str(specification_path.resolve()),
        "artifact_dir": str(artifact_dir.resolve()),
    }
    try:
        extraction = worker.invoke("extract_keypoints", base)
        elements = _object_list(extraction, "specification_elements")
        keypoints = _object_list(extraction, "keypoints")
        _validate_elements(elements)
        _validate_keypoints(keypoints, {str(item["id"]) for item in elements})

        grounding = worker.invoke(
            "ground_units",
            {**base, "specification_elements": elements, "keypoints": keypoints},
        )
        units = _object_list(grounding, "verification_units")
        _validate_units(units, {str(item["id"]) for item in keypoints})

        verdicts: list[dict[str, Any]] = []
        for index, unit in enumerate(units):
            unit_id = str(unit["id"])
            runtime_dir = work_dir / f"unit_{index:04d}_{_safe_name(unit_id)}"
            runtime_dir.mkdir(parents=True, exist_ok=False)
            evidence = worker.invoke(
                "execute_unit",
                {**base, "verification_unit": unit, "runtime_dir": str(runtime_dir)},
            )
            _validate_evidence(evidence, unit_id)
            judged = worker.invoke(
                "judge_evidence",
                {
                    **base,
                    "verification_unit": unit,
                    "evidence": evidence,
                    "runtime_dir": str(runtime_dir),
                },
            )
            verdicts.append(_validate_verdict(judged, unit_id, evidence))

        return _aggregate(elements, keypoints, units, verdicts)
    except GGVInfrastructureError as exc:
        return _infrastructure_failure(str(exc))
    except (KeyError, TypeError, ValueError) as exc:
        return _infrastructure_failure(f"invalid GGV worker contract: {exc}")


def _object_list(value: dict[str, Any], field: str) -> list[dict[str, Any]]:
    items = value.get(field)
    if not isinstance(items, list) or not items or not all(isinstance(item, dict) for item in items):
        raise GGVInfrastructureError(f"{field} must be a non-empty object list")
    return [dict(item) for item in items]


def _validate_elements(elements: Sequence[dict[str, Any]]) -> None:
    ids = [str(item.get("id", "")).strip() for item in elements]
    if any(not item for item in ids) or len(ids) != len(set(ids)):
        raise GGVInfrastructureError("specification element ids must be non-empty and unique")
    for item in elements:
        if not str(item.get("text", "")).strip():
            raise GGVInfrastructureError("each specification element requires text")


def _validate_keypoints(keypoints: Sequence[dict[str, Any]], element_ids: set[str]) -> None:
    ids: set[str] = set()
    for item in keypoints:
        keypoint_id = str(item.get("id", "")).strip()
        covered = item.get("specification_element_ids")
        if not keypoint_id or keypoint_id in ids:
            raise GGVInfrastructureError("keypoint ids must be non-empty and unique")
        ids.add(keypoint_id)
        if not isinstance(covered, list) or not covered or not set(map(str, covered)) <= element_ids:
            raise GGVInfrastructureError(f"keypoint {keypoint_id} has invalid element attribution")
        for field in ("precondition", "bounded_interaction", "postcondition"):
            if not str(item.get(field, "")).strip():
                raise GGVInfrastructureError(f"keypoint {keypoint_id} requires {field}")


def _validate_units(units: Sequence[dict[str, Any]], keypoint_ids: set[str]) -> None:
    ids: set[str] = set()
    grounded: set[str] = set()
    for item in units:
        unit_id = str(item.get("id", "")).strip()
        keypoint_id = str(item.get("keypoint_id", "")).strip()
        if not unit_id or unit_id in ids or keypoint_id not in keypoint_ids:
            raise GGVInfrastructureError("verification unit ids/attribution are invalid")
        ids.add(unit_id)
        grounded.add(keypoint_id)
        state = item.get("injected_state")
        interaction = item.get("bounded_interaction")
        expected = item.get("expected_outcome")
        if not isinstance(state, dict) or not state:
            raise GGVInfrastructureError(f"unit {unit_id} requires a non-empty injected_state")
        if not isinstance(interaction, (dict, list)) or not interaction:
            raise GGVInfrastructureError(f"unit {unit_id} requires a bounded interaction")
        if not isinstance(expected, (dict, str)) or not expected:
            raise GGVInfrastructureError(f"unit {unit_id} requires an expected outcome")
    if grounded != keypoint_ids:
        raise GGVInfrastructureError("every keypoint must be grounded by at least one unit")


def _validate_evidence(evidence: dict[str, Any], unit_id: str) -> None:
    if str(evidence.get("unit_id", "")) != unit_id:
        raise GGVInfrastructureError(f"unit {unit_id} evidence attribution mismatch")
    if not bool(evidence.get("state_injection_succeeded", False)):
        raise GGVInfrastructureError(f"unit {unit_id} state injection did not complete")
    if not bool(evidence.get("interaction_succeeded", False)):
        raise GGVInfrastructureError(f"unit {unit_id} bounded interaction did not complete")
    refs = evidence.get("evidence_refs")
    if not isinstance(refs, list) or not refs or not all(str(item).strip() for item in refs):
        raise GGVInfrastructureError(f"unit {unit_id} requires runtime evidence")


def _validate_verdict(
    judged: dict[str, Any], unit_id: str, evidence: dict[str, Any]
) -> dict[str, Any]:
    if str(judged.get("unit_id", "")) != unit_id:
        raise GGVInfrastructureError(f"unit {unit_id} judge attribution mismatch")
    verdict = str(judged.get("verdict", "")).lower()
    if verdict not in {"pass", "fail"}:
        raise GGVInfrastructureError(f"unit {unit_id} judge must return pass or fail")
    rationale = str(judged.get("rationale", "")).strip()
    if not rationale:
        raise GGVInfrastructureError(f"unit {unit_id} judge requires a rationale")
    return {
        "unit_id": unit_id,
        "verdict": verdict,
        "rationale": rationale,
        "evidence_refs": [str(item) for item in evidence["evidence_refs"]],
    }


def _aggregate(
    elements: Sequence[dict[str, Any]],
    keypoints: Sequence[dict[str, Any]],
    units: Sequence[dict[str, Any]],
    verdicts: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    unit_by_keypoint: dict[str, list[str]] = {}
    for unit in units:
        unit_by_keypoint.setdefault(str(unit["keypoint_id"]), []).append(str(unit["id"]))
    verdict_by_unit = {str(item["unit_id"]): str(item["verdict"]) for item in verdicts}
    keypoint_results = []
    failed_elements: set[str] = set()
    for keypoint in keypoints:
        keypoint_id = str(keypoint["id"])
        unit_ids = unit_by_keypoint[keypoint_id]
        verdict = "pass" if all(verdict_by_unit[item] == "pass" for item in unit_ids) else "fail"
        covered = [str(item) for item in keypoint["specification_element_ids"]]
        if verdict == "fail":
            failed_elements.update(covered)
        keypoint_results.append({
            "keypoint_id": keypoint_id,
            "verdict": verdict,
            "specification_element_ids": covered,
            "unit_ids": unit_ids,
        })
    element_results = [
        {"element_id": str(item["id"]), "verdict": "fail" if str(item["id"]) in failed_elements else "pass"}
        for item in elements
    ]
    element_score = sum(item["verdict"] == "pass" for item in element_results) / len(element_results)
    keypoint_score = sum(item["verdict"] == "pass" for item in keypoint_results) / len(keypoint_results)
    evidence_refs = sorted({ref for item in verdicts for ref in item["evidence_refs"]})
    return {
        "schema_version": "ggv-paper-compatible-v1",
        "implementation": "paper-compatible-plugin-contract-not-official-code",
        "status": "completed",
        "primary_score": element_score,
        "objectives": {
            "specification_element_pass_rate": element_score,
            "keypoint_pass_rate": keypoint_score,
        },
        "constraints": {
            "keypoints_complete": True,
            "state_injection_complete": True,
            "bounded_interactions_complete": True,
            "judge_complete": True,
        },
        "specification_elements": list(elements),
        "keypoint_results": keypoint_results,
        "unit_verdicts": list(verdicts),
        "specification_element_results": element_results,
        "evidence_refs": evidence_refs,
        "diagnostics": [],
    }


def _infrastructure_failure(message: str) -> dict[str, Any]:
    return {
        "schema_version": "ggv-paper-compatible-v1",
        "implementation": "paper-compatible-plugin-contract-not-official-code",
        "status": "infrastructure_failure",
        "primary_score": None,
        "objectives": {},
        "constraints": {
            "keypoints_complete": False,
            "state_injection_complete": False,
            "bounded_interactions_complete": False,
            "judge_complete": False,
        },
        "evidence_refs": [],
        "diagnostics": [message],
    }


def _safe_name(value: str) -> str:
    return "".join(character if character.isalnum() or character in "-_" else "_" for character in value)[:80]
