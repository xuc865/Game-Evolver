from __future__ import annotations

import json
import subprocess
import sys

from scripts import run_new_model_experiments as runner


def test_runner_imports_project_package_from_parent_checkout():
    completed = subprocess.run(
        [
            sys.executable,
            "game-loop/scripts/run_new_model_experiments.py",
            "--dry-run",
            "--model",
            "kimi",
        ],
        cwd=runner.ROOT.parent,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stderr
    assert "kimi_gcbench" in completed.stdout


def test_case_requires_a_real_evaluation_to_complete():
    state = {
        "status": "completed",
        "stop_reason": "L4 model call budget exhausted",
        "champion_result": {"primary_score": 0.0},
        "evaluator_queries": 0,
    }

    assert runner._classify_case(0, state) == "failed"
    state["evaluator_queries"] = 1
    assert runner._classify_case(0, state) == "completed"


def test_gdbench_no_validation_marker_is_infrastructure_failure(tmp_path):
    from game_loop.benchmarks.gdbench import GameDevBenchAdapter

    result = tmp_path / "result.json"
    result.write_text(
        json.dumps(
            {
                "validation": {
                    "success": False,
                    "message": "No validation result found in output",
                },
                "solver": {"success": True},
            }
        ),
        encoding="utf-8",
    )

    evaluation = GameDevBenchAdapter({}).parse_evaluation(result)

    assert evaluation.feasible is False
    assert evaluation.primary_score == 0.0


def test_paused_gdbench_result_without_marker_is_not_recovered(tmp_path):
    candidate = tmp_path / "generation_001" / "candidate_01"
    result = candidate / "gdbench_result" / "result.json"
    result.parent.mkdir(parents=True)
    result.write_text(
        json.dumps(
            {
                "validation": {
                    "success": False,
                    "message": "No validation result found in output",
                },
                "solver": {"success": True},
            }
        ),
        encoding="utf-8",
    )
    state = {
        "status": "paused_infrastructure",
        "stop_reason": "infrastructure failure at g001_c01",
        "model_calls": 1,
        "evaluator_queries": 0,
        "attempts": [{"candidate_dir": str(candidate)}],
    }

    recovered = runner._recover_paused_gdbench_state(tmp_path, state)

    assert recovered is None


def test_true_paused_infrastructure_retries_in_current_run_root(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    historical = runs / "new_model_awesome_kimi_gdbench-resume-old" / "run-one"
    historical.mkdir(parents=True)
    (historical / "state.json").write_text(
        json.dumps({
            "status": "paused_infrastructure",
            "attempts": [{"candidate_dir": str(historical / "candidate")}],
        }),
        encoding="utf-8",
    )
    current = runs / "new_model_awesome_kimi_gdbench-resume-new"
    current.mkdir()
    monkeypatch.setattr(runner, "RUNS", runs)

    selected, recovered = runner._select_resume_run_dir(
        "new_model_awesome_kimi", "gdbench", "run-one", current
    )

    assert selected == current / "run-one"
    assert recovered is None


def test_paused_gcbench_infrastructure_retries_in_current_run_root(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    historical = runs / "new_model_awesome_qwen_gcbench-resume-old" / "run-one"
    historical.mkdir(parents=True)
    (historical / "state.json").write_text(
        json.dumps({"status": "paused_infrastructure"}),
        encoding="utf-8",
    )
    current = runs / "new_model_awesome_qwen_gcbench-resume-new"
    current.mkdir()
    monkeypatch.setattr(runner, "RUNS", runs)

    selected, recovered = runner._select_resume_run_dir(
        "new_model_awesome_qwen", "gcbench", "run-one", current
    )

    assert selected == current / "run-one"
    assert recovered is None


def test_nonterminal_run_with_changed_config_restarts_in_current_root(
    tmp_path, monkeypatch
):
    runs = tmp_path / "runs"
    historical = runs / "new_model_awesome_qwen_gdbench-resume-old" / "run-one"
    historical.mkdir(parents=True)
    (historical / "state.json").write_text(
        json.dumps({"status": "initialized"}), encoding="utf-8"
    )
    (historical / "manifest.json").write_text(
        json.dumps({"config_fingerprint": "old-fingerprint"}), encoding="utf-8"
    )
    current = runs / "new_model_awesome_qwen_gdbench-resume-new"
    current.mkdir()
    monkeypatch.setattr(runner, "RUNS", runs)

    selected, recovered = runner._select_resume_run_dir(
        "new_model_awesome_qwen",
        "gdbench",
        "run-one",
        current,
        "new-fingerprint",
    )

    assert selected == current / "run-one"
    assert recovered is None


def test_done_ids_exclude_unevaluated_completed_cases(tmp_path):
    (tmp_path / "summary.json").write_text(
        json.dumps(
            {
                "cases": [
                    {
                        "run_id": "unevaluated",
                        "status": "completed",
                        "champion_score": 0.0,
                        "evaluator_queries": 0,
                    },
                    {
                        "run_id": "evaluated",
                        "status": "completed",
                        "champion_score": 0.0,
                        "evaluator_queries": 1,
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    assert runner.load_done_ids(tmp_path) == {"evaluated"}


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
