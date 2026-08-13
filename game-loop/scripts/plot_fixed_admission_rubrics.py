#!/usr/bin/env python3
"""Plot fixed-admission hard/soft rubric progress for formal harness epochs."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns


ROOT = Path(__file__).resolve().parents[1]
FIXED_TASKS = (
    "platformer-ink-trail",
    "roguelike-breach-tactics",
    "openworld-seasons-witch",
)
RUNS = {
    "Kimi": ROOT / "experiments/runs/gcbench-produce-kimi",
    "GLM": ROOT / "experiments/runs/gcbench-produce-glm",
}


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _task_names(plan: dict) -> tuple[str, ...]:
    return tuple(Path(item).name for item in plan.get("admission_tasks", ()))


def _score_side(case: dict, side: str) -> tuple[float, float]:
    scores = case[side]
    hard = scores["hard"]
    if not hard:
        raise ValueError(f"{case['case_id']} {side} has no hard rubrics")
    return sum(float(value) for value in hard.values()) / len(hard), float(
        scores["soft_total"]
    )


def collect() -> tuple[pd.DataFrame, pd.DataFrame]:
    case_rows: list[dict] = []
    epoch_rows: list[dict] = []
    for model, run_dir in RUNS.items():
        archive = _load_json(run_dir / "harness_archive/epochs.json")
        records = {int(item["epoch"]): item for item in archive["items"]}
        valid: list[tuple[int, dict]] = []
        for epoch, record in sorted(records.items()):
            plan_path = run_dir / f"harness_self_evolution_plan_{epoch:03d}.json"
            if not plan_path.exists():
                continue
            plan = _load_json(plan_path)
            if plan.get("admission_case_selection") != "fixed":
                continue
            if _task_names(plan) != FIXED_TASKS:
                continue
            validation = record.get("rubric_validation") or {}
            cases = validation.get("case_results") or []
            if not validation.get("infrastructure_ok") or len(cases) != 3:
                continue
            if any(
                not case.get("parent", {}).get("infrastructure_ok")
                or not case.get("candidate", {}).get("infrastructure_ok")
                for case in cases
            ):
                continue
            valid.append((epoch, record))

        if not valid:
            continue

        # The first fixed epoch evaluates the incumbent parent on all three
        # holdout cases, giving a comparable pre-mutation baseline.
        first_epoch, first_record = valid[0]
        baseline_cases = first_record["rubric_validation"]["case_results"]
        baseline_hard = []
        baseline_soft = []
        for task, case in zip(FIXED_TASKS, baseline_cases):
            hard, soft = _score_side(case, "parent")
            baseline_hard.append(hard)
            baseline_soft.append(soft)
            case_rows.append(
                {
                    "model": model,
                    "epoch": first_epoch - 1,
                    "task": task,
                    "side": "champion_baseline",
                    "accepted": True,
                    "hard_pass_rate": hard,
                    "soft_total": soft,
                }
            )
        champion_hard = sum(baseline_hard) / 3
        champion_soft = sum(baseline_soft) / 3
        epoch_rows.append(
            {
                "model": model,
                "epoch": first_epoch - 1,
                "fixed_round": 0,
                "accepted": True,
                "candidate_hard": float("nan"),
                "candidate_soft": float("nan"),
                "champion_hard": champion_hard,
                "champion_soft": champion_soft,
            }
        )

        for fixed_round, (epoch, record) in enumerate(valid, start=1):
            cases = record["rubric_validation"]["case_results"]
            candidate_hard = []
            candidate_soft = []
            for task, case in zip(FIXED_TASKS, cases):
                for side in ("parent", "candidate"):
                    hard, soft = _score_side(case, side)
                    case_rows.append(
                        {
                            "model": model,
                            "epoch": epoch,
                            "task": task,
                            "side": side,
                            "accepted": bool(record["accepted"]),
                            "hard_pass_rate": hard,
                            "soft_total": soft,
                        }
                    )
                hard, soft = _score_side(case, "candidate")
                candidate_hard.append(hard)
                candidate_soft.append(soft)

            candidate_hard_mean = sum(candidate_hard) / 3
            candidate_soft_mean = sum(candidate_soft) / 3
            if record["accepted"]:
                champion_hard = candidate_hard_mean
                champion_soft = candidate_soft_mean
            epoch_rows.append(
                {
                    "model": model,
                    "epoch": epoch,
                    "fixed_round": fixed_round,
                    "accepted": bool(record["accepted"]),
                    "candidate_hard": candidate_hard_mean,
                    "candidate_soft": candidate_soft_mean,
                    "champion_hard": champion_hard,
                    "champion_soft": champion_soft,
                }
            )
    return pd.DataFrame(case_rows), pd.DataFrame(epoch_rows)


def plot(epoch_df: pd.DataFrame, output_dir: Path) -> None:
    sns.set_theme(style="whitegrid", context="paper")
    palette = {"Kimi": "#E83E4D", "GLM": "#39799B"}
    fig, axes = plt.subplots(2, 1, figsize=(4, 3), sharex=True)
    panels = (
        ("hard", "Hard pass rate", (0.0, 1.04)),
        ("soft", "Soft total", (0.0, 1.0)),
    )
    for ax, (metric, label, limits) in zip(axes, panels):
        for model in RUNS:
            data = epoch_df[epoch_df["model"] == model].sort_values("epoch")
            if data.empty:
                continue
            sns.lineplot(
                data=data,
                x="fixed_round",
                y=f"champion_{metric}",
                drawstyle="steps-post",
                marker="o",
                markersize=3.5,
                linewidth=1.7,
                color=palette[model],
                label=model,
                ax=ax,
            )
            candidates = data[data[f"candidate_{metric}"].notna()]
            sns.scatterplot(
                data=candidates,
                x="fixed_round",
                y=f"candidate_{metric}",
                color=palette[model],
                marker="x",
                s=22,
                alpha=0.55,
                legend=False,
                ax=ax,
            )
        ax.set_ylabel(label)
        ax.set_ylim(*limits)
        ax.legend(frameon=True, fontsize=7, ncol=2, loc="lower right")
    axes[0].set_xlabel("")
    axes[1].set_xlabel("Fixed-holdout round")
    fig.suptitle("Fixed 3-case holdout", fontsize=10, fontweight="bold")
    fig.tight_layout(pad=0.6)
    output_dir.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_dir / "fixed_admission_rubric_steps.png", dpi=240)
    fig.savefig(output_dir / "fixed_admission_rubric_steps.pdf")
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "experiments/analysis/fixed-admission-rubrics",
    )
    args = parser.parse_args()
    case_df, epoch_df = collect()
    if epoch_df.empty:
        raise SystemExit("no complete formal fixed-admission epochs found")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    case_df.to_csv(args.output_dir / "fixed_admission_rubrics_by_case.csv", index=False)
    epoch_df.to_csv(args.output_dir / "fixed_admission_rubrics_by_epoch.csv", index=False)
    plot(epoch_df, args.output_dir)
    print(epoch_df.to_string(index=False))


if __name__ == "__main__":
    main()
