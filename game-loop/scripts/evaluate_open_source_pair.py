#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import urllib.request
from pathlib import Path


def _godot_health(project: Path, godot: str) -> dict:
    proc = subprocess.run(
        [godot, "--headless", "--editor", "--path", str(project), "--quit"],
        capture_output=True, text=True, timeout=180, check=False,
    )
    errors = [line for line in proc.stdout.splitlines()
              if "SCRIPT ERROR:" in line or "Parse Error:" in line or "Compile Error:" in line]
    return {"ok": proc.returncode == 0 and not errors, "errors": errors[:8]}


def _latest_image(project: Path) -> Path | None:
    images = [p for p in project.rglob("*.png") if "screenshot" in p.as_posix().casefold()]
    return max(images, key=lambda p: p.stat().st_mtime_ns) if images else None


def _qwen_pair(parent: Path, candidate: Path, task: str) -> dict:
    diff = subprocess.run(
        ["git", "diff", "--no-index", "--stat", str(parent), str(candidate)],
        capture_output=True, text=True, timeout=60, check=False,
    ).stdout[-12000:]
    content: list[dict] = [{
        "type": "text",
        "text": (
            "Compare a parent and candidate open-source game under the same design charter. "
            "Score each 0-100 for coherent gameplay, usability, visual hierarchy, reliability, "
            "and fit to the charter. A feature pile-up, clipped/overlapping UI, misplaced panels, "
            "weather/particles/tints that obscure the player, hazards, dialogue, or playfield, "
            "or broken flow is a hard regression. Full-screen effects must preserve gameplay "
            "contrast at their maximum intensity. Return JSON only with parent_score, "
            "candidate_score, hard_regression, reasons.\n\nCHARTER:\n" + task[-8000:] +
            "\n\nCHANGE SUMMARY:\n" + diff
        ),
    }]
    for label, project in (("parent", parent), ("candidate", candidate)):
        image = _latest_image(project)
        if image:
            encoded = base64.b64encode(image.read_bytes()).decode("ascii")
            content.extend([
                {"type": "text", "text": f"{label} screenshot:"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{encoded}"}},
            ])
    payload = {
        "model": os.environ.get("QWEN_MODEL", "Qwen3.8-27B-node1"),
        "temperature": 0.1,
        "max_tokens": 1200,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": content}],
    }
    request = urllib.request.Request(
        os.environ.get("QWEN_BASE_URL", "http://29.116.237.141:8080/v1").rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        answer = json.loads(response.read().decode())
    text = answer["choices"][0]["message"]["content"]
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start:end + 1])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--task", type=Path, required=True)
    parser.add_argument("--kind", choices=("tinymmo", "godot"), required=True)
    parser.add_argument("--godot", default="/Applications/Godot.app/Contents/MacOS/Godot")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    try:
        if args.kind == "tinymmo":
            from evaluate_tinymmo import evaluate
            parent = evaluate(args.parent, godot_bin=args.godot)
            candidate = evaluate(args.candidate, godot_bin=args.godot)
            parent_score = parent["primary_score"]
            candidate_score = candidate["primary_score"]
            hard_regression = any(
                parent["constraints"].get(key) and not candidate["constraints"].get(key)
                for key in parent["constraints"]
            )
            reasons = candidate.get("diagnostics", [])[:8]
        else:
            parent_health = _godot_health(args.parent, args.godot)
            candidate_health = _godot_health(args.candidate, args.godot)
            judged = _qwen_pair(
                args.parent, args.candidate, args.task.read_text(encoding="utf-8")
            )
            parent_score = float(judged["parent_score"]) / 100.0
            candidate_score = float(judged["candidate_score"]) / 100.0
            hard_regression = bool(judged.get("hard_regression")) or (
                parent_health["ok"] and not candidate_health["ok"]
            )
            reasons = list(judged.get("reasons", [])) + candidate_health["errors"]
        result = {
            "infrastructure_ok": True,
            "passed": not hard_regression and candidate_score > parent_score,
            "parent_score": parent_score,
            "candidate_score": candidate_score,
            "hard_regression": hard_regression,
            "reasons": reasons,
        }
    except Exception as exc:
        result = {"infrastructure_ok": False, "passed": False, "error": repr(exc)}
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0 if result["infrastructure_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
