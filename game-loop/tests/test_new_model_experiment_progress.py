from __future__ import annotations

import json

from scripts import run_new_model_experiments as runner


def test_progress_notice_deduplicates_tasks_and_averages_failed_as_zero(
    tmp_path, monkeypatch
):
    runs = tmp_path / "runs"
    progress = tmp_path / "progress.txt"
    first = runs / "new_model_awesome_kimi_gcbench-resume-1"
    second = runs / "new_model_awesome_kimi_gcbench-resume-2"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    (first / "summary.json").write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "run_id": "task-a",
                        "status": "failed",
                        "champion_score": 0.0,
                        "completed_at": "2026-08-11T10:00:00+0800",
                    },
                    {
                        "run_id": "task-b",
                        "status": "failed",
                        "champion_score": None,
                        "completed_at": "2026-08-11T10:01:00+0800",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    (second / "summary.json").write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "run_id": "task-a",
                        "status": "completed",
                        "champion_score": 0.8,
                        "completed_at": "2026-08-11T10:02:00+0800",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(runner, "RUNS", runs)
    monkeypatch.setattr(runner, "PROGRESS_FILE", progress)

    item = {
        "run_id": "task-c",
        "task_name": "task-c",
        "model": "kimi",
        "bench": "gcbench",
        "status": "completed",
        "champion_score": 0.7,
        "completed_at": "2026-08-11T10:03:00+0800",
    }
    runner.append_progress_notice("new_model_awesome_kimi", item)

    notice = progress.read_text(encoding="utf-8")
    assert "task=task-c model=kimi bench=gcbench status=completed" in notice
    assert "score=0.700000" in notice
    assert "cumulative_accuracy=50.0000%" in notice
    assert "mean_score=0.500000" in notice
    assert "unique_tasks=3" in notice
