#!/usr/bin/env python3
"""Minimal ggv-worker-v1 adapter for VeriGame bridge smoke and local evaluation."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def _read_request() -> dict[str, Any]:
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("request must be a JSON object")
    return value


def _write_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def _extract_keypoints(payload: dict[str, Any]) -> dict[str, Any]:
    spec_path = Path(str(payload["specification_path"]))
    text = spec_path.read_text(encoding="utf-8").strip()
    paragraphs = [part.strip() for part in text.split("\n\n") if part.strip()]
    if not paragraphs:
        paragraphs = [text]
    elements = [
        {"id": f"elem-{index + 1:02d}", "text": paragraph}
        for index, paragraph in enumerate(paragraphs[:3])
    ]
    keypoints = []
    for element in elements:
        keypoints.append({
            "id": f"kp-{element['id']}",
            "specification_element_ids": [element["id"]],
            "precondition": "Game bootstraps with a visible canvas and controllable state.",
            "bounded_interaction": {"action": "start_game", "max_steps": 3},
            "postcondition": "Core mechanic described in the specification is observable.",
        })
    return {"specification_elements": elements, "keypoints": keypoints}


def _ground_units(payload: dict[str, Any]) -> dict[str, Any]:
    keypoints = payload["keypoints"]
    units = []
    for keypoint in keypoints:
        units.append({
            "id": f"unit-{keypoint['id']}",
            "keypoint_id": keypoint["id"],
            "injected_state": {"seed": keypoint["id"], "mode": "smoke"},
            "bounded_interaction": keypoint["bounded_interaction"],
            "expected_outcome": {"status": "observable"},
        })
    return {"verification_units": units}


def _execute_unit(payload: dict[str, Any]) -> dict[str, Any]:
    unit = payload["verification_unit"]
    runtime_dir = Path(str(payload["runtime_dir"]))
    runtime_dir.mkdir(parents=True, exist_ok=True)
    artifact = Path(str(payload["artifact_dir"]))
    marker = runtime_dir / "interaction.json"
    marker.write_text(
        json.dumps({"artifact": str(artifact), "unit_id": unit["id"]}, indent=2) + "\n",
        encoding="utf-8",
    )
    return {
        "unit_id": unit["id"],
        "state_injection_succeeded": True,
        "interaction_succeeded": True,
        "evidence_refs": [str(marker)],
    }


def _judge_evidence(payload: dict[str, Any]) -> dict[str, Any]:
    unit = payload["verification_unit"]
    evidence = payload["evidence"]
    artifact = Path(str(payload["artifact_dir"]))
    ok = evidence.get("interaction_succeeded") and any(Path(ref).is_file() for ref in evidence.get("evidence_refs", []))
    if ok and (artifact / "index.html").is_file() or (artifact / "game.html").is_file() or (artifact / "package.json").is_file():
        verdict = "pass"
    else:
        verdict = "fail"
    return {
        "unit_id": unit["id"],
        "verdict": verdict,
        "rationale": "Smoke worker validated artifact presence and bounded interaction evidence.",
    }


def main() -> int:
    request = _read_request()
    operation = str(request.get("operation", ""))
    handlers = {
        "extract_keypoints": _extract_keypoints,
        "ground_units": _ground_units,
        "execute_unit": _execute_unit,
        "judge_evidence": _judge_evidence,
    }
    handler = handlers.get(operation)
    if handler is None:
        raise ValueError(f"unsupported operation: {operation}")
    _write_response(handler(request))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
