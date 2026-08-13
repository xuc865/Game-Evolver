#!/usr/bin/env python3
"""Export formal per-epoch admission rubric scores for Kimi and GLM."""

from __future__ import annotations

import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNS = {
    "Kimi": ROOT / "experiments/runs/gcbench-produce-kimi",
    "GLM": ROOT / "experiments/runs/gcbench-produce-glm",
}
OUTPUT_DIR = ROOT / "experiments/analysis/historical-admission-rubrics"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def rubric_schema(soft_keys: set[str]) -> str:
    if "public_feature_completion" in soft_keys:
        return "game_quality_v2"
    if "feature_progress_visible" in soft_keys:
        return "process_quality_v1"
    return "unknown"


def collect() -> tuple[list[dict], list[dict], list[dict]]:
    epoch_rows: list[dict] = []
    case_rows: list[dict] = []
    rubric_rows: list[dict] = []
    for model, run_dir in RUNS.items():
        archive = load_json(run_dir / "harness_archive/epochs.json")
        for record in sorted(archive["items"], key=lambda item: int(item["epoch"])):
            epoch = int(record["epoch"])
            validation = record.get("rubric_validation") or {}
            cases = validation.get("case_results") or []
            if not validation.get("infrastructure_ok") or not cases:
                continue
            plan_path = run_dir / f"harness_self_evolution_plan_{epoch:03d}.json"
            plan = load_json(plan_path) if plan_path.exists() else {}
            selection = plan.get("admission_case_selection", "epoch_sampled")

            parent_hard_values: list[float] = []
            candidate_hard_values: list[float] = []
            parent_soft_values: list[float] = []
            candidate_soft_values: list[float] = []
            hard_regressions = 0
            soft_regressions = 0
            all_soft_keys: set[str] = set()
            all_hard_keys: set[str] = set()

            task_by_case = {
                item["case_id"]: Path(item.get("task_ref", "unknown")).name
                for item in validation.get("dynamic_rubrics", [])
            }
            for case in cases:
                parent = case["parent"]
                candidate = case["candidate"]
                all_hard_keys.update(parent["hard"])
                all_soft_keys.update(parent["soft"])
                parent_hard = mean([float(value) for value in parent["hard"].values()])
                candidate_hard = mean(
                    [float(value) for value in candidate["hard"].values()]
                )
                parent_soft = float(parent["soft_total"])
                candidate_soft = float(candidate["soft_total"])
                parent_hard_values.extend(float(value) for value in parent["hard"].values())
                candidate_hard_values.extend(
                    float(value) for value in candidate["hard"].values()
                )
                parent_soft_values.append(parent_soft)
                candidate_soft_values.append(candidate_soft)
                hard_regressions += sum(
                    float(candidate["hard"][key]) < float(parent["hard"][key])
                    for key in parent["hard"]
                )
                soft_regressions += candidate_soft < parent_soft - 1e-9
                case_rows.append(
                    {
                        "model": model,
                        "epoch": epoch,
                        "selection": selection,
                        "case_id": case["case_id"],
                        "task": task_by_case.get(case["case_id"], "unknown"),
                        "accepted": bool(record["accepted"]),
                        "case_passed": bool(case["passed"]),
                        "parent_hard_pass_rate": parent_hard,
                        "candidate_hard_pass_rate": candidate_hard,
                        "parent_soft_total": parent_soft,
                        "candidate_soft_total": candidate_soft,
                        "parent_judge": parent.get("judge", ""),
                        "candidate_judge": candidate.get("judge", ""),
                        "infrastructure_ok": bool(
                            parent.get("infrastructure_ok")
                            and candidate.get("infrastructure_ok")
                        ),
                    }
                )
                for side_name, scores in (("parent", parent), ("candidate", candidate)):
                    for kind in ("hard", "soft"):
                        for rubric_id, score in scores[kind].items():
                            rubric_rows.append(
                                {
                                    "model": model,
                                    "epoch": epoch,
                                    "selection": selection,
                                    "case_id": case["case_id"],
                                    "task": task_by_case.get(case["case_id"], "unknown"),
                                    "result": "ACCEPT" if record["accepted"] else "REJECT",
                                    "side": side_name,
                                    "rubric_schema": rubric_schema(set(scores["soft"])),
                                    "rubric_kind": kind,
                                    "rubric_id": rubric_id,
                                    "score": float(score),
                                }
                            )

            epoch_rows.append(
                {
                    "model": model,
                    "epoch": epoch,
                    "result": "ACCEPT" if record["accepted"] else "REJECT",
                    "selection": selection,
                    "rubric_schema": rubric_schema(all_soft_keys),
                    "cases": len(cases),
                    "case_passes": sum(bool(case["passed"]) for case in cases),
                    "hard_items_per_case": len(all_hard_keys),
                    "parent_hard_pass_rate": mean(parent_hard_values),
                    "candidate_hard_pass_rate": mean(candidate_hard_values),
                    "hard_delta": mean(candidate_hard_values)
                    - mean(parent_hard_values),
                    "hard_regressions": hard_regressions,
                    "parent_soft_total": mean(parent_soft_values),
                    "candidate_soft_total": mean(candidate_soft_values),
                    "soft_delta": mean(candidate_soft_values)
                    - mean(parent_soft_values),
                    "soft_regressed_cases": soft_regressions,
                    "parent_harness_id": record["parent_harness_id"],
                    "candidate_harness_id": record["candidate_harness_id"],
                    "created_at": record.get("created_at", ""),
                }
            )
    return epoch_rows, case_rows, rubric_rows


def write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def write_markdown(path: Path, rows: list[dict]) -> None:
    columns = (
        "model",
        "epoch",
        "result",
        "selection",
        "rubric_schema",
        "parent_hard_pass_rate",
        "candidate_hard_pass_rate",
        "hard_delta",
        "parent_soft_total",
        "candidate_soft_total",
        "soft_delta",
        "case_passes",
    )
    labels = (
        "Model",
        "Epoch",
        "Result",
        "Selection",
        "Schema",
        "P hard",
        "C hard",
        "Delta H",
        "P soft",
        "C soft",
        "Delta S",
        "Pass",
    )
    lines = ["# Historical Admission Rubrics", "", "| " + " | ".join(labels) + " |"]
    lines.append("|" + "|".join(["---"] * len(labels)) + "|")
    for row in rows:
        values = []
        for column in columns:
            value = row[column]
            if isinstance(value, float):
                values.append(f"{value:.3f}")
            elif column == "case_passes":
                values.append(f"{value}/{row['cases']}")
            else:
                values.append(str(value))
        lines.append("| " + " | ".join(values) + " |")
    lines.extend(
        [
            "",
            "Hard is the mean pass rate over all hard items across the three cases. ",
            "Soft is the mean weighted soft_total across the three cases. ",
            "process_quality_v1 and game_quality_v2 are different rubric schemas and should not be compared as one continuous scale.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    epoch_rows, case_rows, rubric_rows = collect()
    if not epoch_rows:
        raise SystemExit("no formal rubric records found")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(OUTPUT_DIR / "historical_rubrics_by_epoch.csv", epoch_rows)
    write_csv(OUTPUT_DIR / "historical_rubrics_by_case.csv", case_rows)
    write_csv(OUTPUT_DIR / "historical_rubrics_by_item.csv", rubric_rows)
    write_markdown(OUTPUT_DIR / "historical_rubrics_by_epoch.md", epoch_rows)
    print(
        f"epochs={len(epoch_rows)} cases={len(case_rows)} "
        f"rubric_items={len(rubric_rows)}"
    )


if __name__ == "__main__":
    main()
