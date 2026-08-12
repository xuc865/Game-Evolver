#!/usr/bin/env python3
"""
Generate all experiment config JSON files for harness-game.

Outputs:
  experiments/configs-v4/*.json        — 38 main configs
  experiments/configs-ablation/*.json  — 40 ablation configs (8 benchmark × 5 level)
"""
from __future__ import annotations

import json
import argparse
import sys
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from game_loop.config import AppConfig
from game_loop.experiment_presets import build_method_section

V4_DIR = ROOT / "experiments" / "configs-v4"
ABL_DIR = ROOT / "experiments" / "configs-ablation"

MODELS = {
    "kimi": {"CODEX_API_BASE": "http://29.116.237.135:8080/v1", "CODEX_MODEL": "Kimi-K2.7-Code"},
    "qwen3.6-27b": {
        "CODEX_API_BASE": "http://29.163.228.59:8080/v1",
        "CODEX_MODEL": "Qwen3.6-27B",
    },
    "glm5.2": {"CODEX_API_BASE": "http://29.116.237.75:8080/v1", "CODEX_MODEL": "GLM-5.2-W4AFP8-node1"},
    "deepseek_v4": {"CODEX_API_BASE": "https://api.deepseek.com", "CODEX_MODEL": "deepseek-v4-flash"},
    "claude": {
        "CODEX_API_BASE": "https://xmcode.shop/v1",
        "CODEX_MODEL": "claude-sonnet-4-6",
        "CODEX_PROVIDER": "claude",
        "ANTHROPIC_BASE_URL": "https://xmcode.shop/v1",
    },
    "gpt55": {
        "CODEX_API_BASE": "https://xmcode.shop/v1",
        "CODEX_MODEL": "gpt-5.5",
        "CODEX_PROVIDER": "gpt55",
        "OPENAI_BASE_URL": "https://xmcode.shop/v1",
    },
}

EVOLUTION_1x1 = {
    "max_generations": 1,
    "candidates_per_generation": 1,
    "max_model_calls": 3,
    "max_evaluator_queries": 3,
}
EVOLUTION_1x3 = {
    "max_generations": 1,
    "candidates_per_generation": 3,
    "max_model_calls": 3,
    "max_evaluator_queries": 3,
}

BENCH_ROOTS = {
    "gcbench": str(ROOT.parent / "gcbench"),
    "gdbench": str(ROOT.parent / "third_party" / "gamedevbench"),
    "swebench": str(ROOT),
    "nl2repo": str(ROOT),
    "terminalbench": str(ROOT),
    "weavebench": str(ROOT),
    "verigame": str(ROOT),
    "vgamegym": str(ROOT),
    "taubench": str(ROOT / "third_party" / "tau2-bench"),
}

BACKEND_CMDS = {
    "gcbench": [
        "bash",
        "scripts/run_gcbench_l4_backend.sh",
        "{candidate_workspace}",
        "{instruction_file}",
        "{artifact_path}",
        "{output_manifest}",
        "{task_id}",
        "{gcbench_root}",
        "{breakdown_path}",
    ],
    "gdbench": [
        "python3",
        "-m",
        "game_loop.benchmarks.gdbench_bridge",
        "--gdbench-root",
        "{gdbench_root}",
        "--agent-workspace",
        "{agent_workspace}",
        "--private-task-source",
        "{private_task_source}",
        "--task-name",
        "{task_name}",
        "--instruction-file",
        "{instruction_file}",
        "--output-manifest",
        "{output_manifest}",
        "--evaluator-timeout",
        "180",
    ],
    "swebench": ["python3", "-m", "game_loop.benchmarks.swebench_bridge"],
    "nl2repo": ["python3", "-m", "game_loop.benchmarks.nl2repo_bridge",
                 "--repo-root", "{repo_root}", "--task-file", "{task_file}",
                 "--official-task-root", "{official_task_root}",
                 "--project-name", "{project_name}",
                 "--output-manifest", "{output_manifest}"],
    "terminalbench": ["python3", "-m", "game_loop.benchmarks.terminalbench_bridge",
                       "--task-root", "{task_root}",
                       "--agent-workspace", "{agent_workspace}",
                       "--instruction-file", "{instruction_file}",
                       "--harness-context", "{harness_context}",
                       "--output-manifest", "{output_manifest}"],
    "weavebench": ["python3", "-m", "game_loop.benchmarks.weavebench_bridge"],
    "verigame": [
        "python3",
        "-m",
        "game_loop.benchmarks.verigame_bridge",
        "--agent-workspace",
        "{agent_workspace}",
        "--instruction-file",
        "{instruction_file}",
        "--task-root",
        "{task_root}",
        "--output-manifest",
        "{output_manifest}",
        "--worker-command-json",
        json.dumps(
            [
                "python3",
                str(ROOT / "scripts" / "ggv_contract_worker.py"),
            ]
        ),
    ],
    "vgamegym": [
        str(ROOT.parent / ".venv" / "bin" / "python"),
        "-m",
        "game_loop.benchmarks.vgamegym_bridge",
        "--agent-workspace",
        "{agent_workspace}",
        "--instruction-file",
        "{instruction_file}",
        "--task-root",
        "{task_root}",
        "--output-manifest",
        "{output_manifest}",
        "--evaluator-command-json",
        json.dumps(
            [
                str(ROOT.parent / ".venv" / "bin" / "python"),
                str(ROOT / "scripts" / "run_vgamegym_official_evaluator.py"),
                "--official-root",
                str(ROOT.parent / "third_party" / "VGameGym"),
                "--task-root",
                "{{task_root}}",
                "--artifact-dir",
                "{{artifact_dir}}",
                "--raw-output",
                "{{raw_output}}",
            ]
        ),
    ],
    "taubench": [
        "python3", "-m", "game_loop.benchmarks.taubench_bridge",
        "--tau-root", str(ROOT / "third_party" / "tau2-bench"),
        "--domain", "airline",
        "--harness-context", "{harness_context}",
        "--output-manifest", "{output_manifest}",
    ],
}

TIMEOUTS = {
    "gcbench": 1800,
    "gdbench": 300,
    "swebench": 1800,
    "nl2repo": 1800,
    "terminalbench": 1800,
    "weavebench": 1800,
    "verigame": 600,
    "vgamegym": 600,
    "taubench": 3600,
}

ALL_BENCHMARKS = [
    "gcbench",
    "gdbench",
    "swebench",
    "nl2repo",
    "terminalbench",
    "weavebench",
    "verigame",
    "vgamegym",
    "taubench",
]

ABLATION_LADDER = {
    "L0": {
        "arm": "L4_agent_no_harness_evolve",
        "profile": {
            "enable_long_term_memory": False,
            "allowed_element_categories": ["context", "protocol"],
            "enable_tool_interface_mutation": False,
            "enable_executable_policy_mutation": False,
        },
    },
    "L1": {
        "arm": "L4_agent",
        "profile": {
            "enable_long_term_memory": False,
            "allowed_element_categories": ["context", "protocol"],
            "enable_tool_interface_mutation": False,
            "enable_executable_policy_mutation": False,
        },
    },
    "L2": {
        "arm": "L4_agent",
        "profile": {
            "enable_long_term_memory": False,
            "allowed_element_categories": [
                "skill", "mcp", "tool", "context", "protocol", "workflow",
            ],
            "enable_tool_interface_mutation": True,
            "enable_executable_policy_mutation": True,
        },
    },
    "L3": {
        "arm": "L4_agent",
        "profile": {
            "enable_long_term_memory": True,
            "allowed_element_categories": [
                "skill", "mcp", "tool", "context", "protocol", "workflow",
            ],
            "enable_tool_interface_mutation": True,
            "enable_executable_policy_mutation": True,
        },
    },
}


def make_config(
    bench: str,
    *,
    model_key: str | None = None,
    arm: str = "L4_agent",
    evolution: dict | None = None,
    allowed_niches: list[str] | None = None,
    ablation: bool = False,
    ablation_level: str | None = None,
    ablation_profile: dict | None = None,
) -> dict:
    # Runtime secrets belong to the launcher environment.  Keeping a placeholder
    # here can mask a real value and used to make keyless internal providers look
    # like stub runs.
    env: dict[str, str] = {}
    if model_key and model_key in MODELS:
        env.update(MODELS[model_key])
        env["GAME_LOOP_BACKBONE_PROVIDER"] = {
            "kimi": "kimi",
            "qwen3.6-27b": "qwen",
            "glm5.2": "glm",
            "deepseek_v4": "deepseek",
            "claude": "claude",
            "gpt55": "gpt55",
        }[model_key]
    if bench == "vgamegym":
        env.setdefault(
            "VGAMEGYM_VL_BASE_URL",
            "http://29.116.237.141:8080/v1",
        )
        env.setdefault(
            "VGAMEGYM_TEXT_BASE_URL",
            "http://29.116.237.135:8080/v1",
        )
        env.setdefault("VGAMEGYM_TEXT_MODEL", "Kimi-K2.7-Code")

    method = build_method_section(
        bench,
        allowed_niches=allowed_niches,
        ablation=ablation,
        ablation_profile=ablation_profile,
    )

    config = {
        "benchmark": {
            "adapter": bench,
            "options": {"root": BENCH_ROOTS[bench]},
        },
        "backend": {
            "command": BACKEND_CMDS[bench],
            "cwd": ".",
            "timeout_seconds": TIMEOUTS[bench],
            "env": env,
        },
        "method": method,
        "evolution": evolution or deepcopy(EVOLUTION_1x1),
        "reliability": {"pause_on_infrastructure_failure": True},
        "gates": {"max_files": 5000, "max_total_bytes": 1073741824},
        "experiment": {"arm": arm},
    }
    if ablation_level is not None:
        config["experiment"]["ablation_level"] = ablation_level
    # These values are supplied by the backend runner and are intentionally
    # not model-specific config fields.  Keeping them in the command template
    # makes every prepared task, including epoch-0 baselines, use the same
    # bridge contract.
    return config


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def validate_configs(paths: list[Path]) -> int:
    errors = 0
    previous = Path.cwd()
    try:
        import os

        os.chdir(ROOT)
        for path in paths:
            try:
                AppConfig.load(path)
            except Exception as exc:
                print(f"  INVALID: {path.name}: {exc}")
                errors += 1
    finally:
        import os

        os.chdir(previous)
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--ablation-only",
        action="store_true",
        help="regenerate and validate only the current L0-L3 ablation configs",
    )
    args = parser.parse_args()
    written: list[Path] = []
    model_keys = ["kimi", "qwen3.6-27b", "glm5.2", "deepseek_v4", "claude", "gpt55"]

    if not args.ablation_only:
        for mk in model_keys:
            write_json(V4_DIR / f"gcbench-L4_{mk}.json", make_config("gcbench", model_key=mk))
            written.append(V4_DIR / f"gcbench-L4_{mk}.json")

        write_json(
            V4_DIR / "gcbench-L4_agent_no_harness_evolve.json",
            make_config("gcbench", model_key="kimi", arm="L4_agent_no_harness_evolve"),
        )
        written.append(V4_DIR / "gcbench-L4_agent_no_harness_evolve.json")
        write_json(V4_DIR / "gcbench-L4_agent.json", make_config("gcbench", model_key="kimi", arm="L4_agent"))
        written.append(V4_DIR / "gcbench-L4_agent.json")
        write_json(V4_DIR / "gcbench-L4_champion.json", make_config("gcbench", model_key="kimi", arm="L4_agent"))
        written.append(V4_DIR / "gcbench-L4_champion.json")
        write_json(
            V4_DIR / "gcbench-L4_retry3.json",
            {
                **make_config("gcbench", model_key="kimi", evolution=EVOLUTION_1x3),
                "method": {"level": "L0"},
                "experiment": {"arm": "retry3"},
            },
        )
        written.append(V4_DIR / "gcbench-L4_retry3.json")

        for mk in model_keys:
            write_json(V4_DIR / f"gdbench-L4_{mk}.json", make_config("gdbench", model_key=mk))
            written.append(V4_DIR / f"gdbench-L4_{mk}.json")

        for bench in ["swebench", "nl2repo", "terminalbench", "weavebench", "taubench"]:
            for mk in model_keys:
                path = V4_DIR / f"{bench}-L4_{mk}.json"
                write_json(path, make_config(bench, model_key=mk))
                written.append(path)

        for bench in ["verigame", "vgamegym"]:
            for mk in model_keys:
                path = V4_DIR / f"{bench}-L4_{mk}.json"
                write_json(path, make_config(bench, model_key=mk))
                written.append(path)
            path = V4_DIR / f"{bench}-L4_agent_no_harness_evolve.json"
            write_json(
                path,
                make_config(bench, model_key="kimi", arm="L4_agent_no_harness_evolve"),
            )
            written.append(path)

        written = sorted(set(written))

    for bench in ALL_BENCHMARKS:
        for level, cfg_spec in ABLATION_LADDER.items():
            path = ABL_DIR / f"{bench}-{level}_ablation_kimi.json"
            write_json(
                path,
                make_config(
                    bench,
                    model_key="kimi",
                    arm=cfg_spec["arm"],
                    ablation=True,
                    ablation_level=level,
                    ablation_profile=cfg_spec["profile"],
                ),
            )

    expected_ablation_files = {
        ABL_DIR / f"{bench}-{level}_ablation_kimi.json"
        for bench in ALL_BENCHMARKS
        for level in ABLATION_LADDER
    }
    for stale in ABL_DIR.glob("*_ablation_kimi.json"):
        if stale not in expected_ablation_files:
            stale.unlink()

    abl_files = sorted(ABL_DIR.glob("*.json"))
    v4_files = sorted(V4_DIR.glob("*.json"))
    print(f"configs-v4: {len(v4_files)} files")
    print(f"configs-ablation: {len(abl_files)} files")
    print(f"total: {len(v4_files) + len(abl_files)} files")

    validation_paths = abl_files if args.ablation_only else written + abl_files
    errors = validate_configs(validation_paths)
    print(f"validation errors: {errors}")
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
