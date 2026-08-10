"""Canonical L4 method presets shared by experiment config generators."""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from game_loop.harness_element_catalog import DEFAULT_INNER_SEED_ELEMENTS, INNER_ELEMENT_CATALOG

PYTHON = "python3"
PROBE_MODULE = ["-m", "game_loop.probe_tools"]

GAME_HARNESS_MODULES = [
    {
        "id": "evidence_first",
        "instruction": "Inspect executable evidence before choosing a patch.",
        "tags": ["ImproveObjective", "functional_visuals"],
    },
    {
        "id": "gameplay_observability",
        "instruction": "Collect runtime and visual observations before accepting a candidate.",
        "tags": ["ImproveObjective", "gameplay"],
    },
    {
        "id": "mechanic_depth",
        "instruction": "Prefer changes that deepen mechanics rather than cosmetic-only edits.",
        "tags": ["ImproveObjective", "mechanics"],
    },
    {
        "id": "regression_first",
        "instruction": "Re-run preserved behavior before finishing.",
        "tags": ["RepairConstraint", "feasibility"],
    },
    {
        "id": "engine_tooling_first",
        "instruction": "Use engine tooling to inspect import/runtime state before patching.",
        "tags": ["engine_tooling", "godot"],
    },
    {
        "id": "diversity_escape",
        "instruction": "Avoid repeating a recently rejected change family.",
        "tags": ["ExploreAlternative", "exploration"],
    },
    {
        "id": "minimal_coherent_patch",
        "instruction": "Keep patches minimal and coherent with the existing project structure.",
        "tags": ["RepairConstraint", "feasibility"],
    },
]

CODE_HARNESS_MODULES = [
    {
        "id": "evidence_first",
        "instruction": "Inspect executable evidence before choosing a patch.",
        "tags": ["ImproveObjective"],
    },
    {
        "id": "test_driven",
        "instruction": "Use public tests and probes to guide the next patch.",
        "tags": ["RepairConstraint", "tests"],
    },
    {
        "id": "minimal_patch",
        "instruction": "Prefer the smallest patch that resolves the observed failure.",
        "tags": ["RepairConstraint", "feasibility"],
    },
    {
        "id": "regression_first",
        "instruction": "Re-run preserved behavior before finishing.",
        "tags": ["RepairConstraint", "feasibility"],
    },
    {
        "id": "diversity_escape",
        "instruction": "Avoid repeating a recently rejected change family.",
        "tags": ["ExploreAlternative", "exploration"],
    },
]

OUTER_HARNESS_MODULES = [
    {
        "id": "context_compiler",
        "instruction": "Compile context from task requirements, parent artifact state, and feedback signals.",
        "tags": ["context", "context_compiler"],
    },
    {
        "id": "module_strategy",
        "instruction": "Select and order modules based on task type and recent outcomes.",
        "tags": ["strategy", "module_strategy"],
    },
    {
        "id": "skill_governance",
        "instruction": "Curate skill descriptions and manage skill loading priorities.",
        "tags": ["skills", "skill_governance"],
    },
    {
        "id": "tool_interface",
        "instruction": "Manage tool interface assembly and safety scoping.",
        "tags": ["tools", "tool_interface"],
    },
    {
        "id": "feedback_synthesis",
        "instruction": "Synthesize structured feedback from evaluator outputs and probe observations.",
        "tags": ["feedback", "validation"],
    },
    {
        "id": "session_routing",
        "instruction": "Route sessions across heterogeneous agent frameworks and model backends.",
        "tags": ["routing", "recovery"],
    },
]

OUTER_TOOL_INTERFACES = [
    {
        "id": "python_runtime",
        "kind": "command_wrapper",
        "description": "Run bounded Python inspection commands in the candidate workspace.",
        "command": [PYTHON, "-c", "import os; print(os.listdir('{artifact_dir}')[:5])"],
        "safety_scope": "candidate_workspace_only",
        "tags": ["runtime", "tool_interface"],
    },
]

ABLATION_HARNESS_MODULES = [
    {
        "id": "context_compiler",
        "instruction": "Compile context from task requirements, parent artifact state, and feedback signals.",
        "tags": ["context"],
    },
    {
        "id": "module_strategy",
        "instruction": "Select and order modules based on task type and recent outcomes.",
        "tags": ["strategy"],
    },
    {
        "id": "skill_governance",
        "instruction": "Curate skill descriptions and manage skill loading priorities.",
        "tags": ["skills"],
    },
    {
        "id": "tool_interface",
        "instruction": "Manage tool interface assembly and safety scoping.",
        "tags": ["tools"],
    },
    {
        "id": "probe_governance",
        "instruction": "Select and parameterise probes based on coverage and regression signals.",
        "tags": ["probes"],
    },
    {
        "id": "feedback_synthesis",
        "instruction": "Synthesize structured feedback from evaluator outputs and probe observations.",
        "tags": ["feedback"],
    },
    {
        "id": "artifact_persistence",
        "instruction": "Manage artifact snapshots, delivery contracts, and rollback points.",
        "tags": ["persistence"],
    },
    {
        "id": "session_routing",
        "instruction": "Route sessions across heterogeneous agent frameworks and model backends.",
        "tags": ["routing"],
    },
]

GAME_TOOL_INTERFACES = [
    {
        "id": "godot_cli_runtime",
        "kind": "engine_probe",
        "description": "Run Godot import/runtime checks against the candidate workspace.",
        "command": [PYTHON, *PROBE_MODULE, "godot-playtest", "--artifact", "{artifact_dir}"],
        "safety_scope": "candidate_workspace_only",
        "tags": ["engine_tooling", "godot"],
    },
    {
        "id": "godot_mcp_screenshot",
        "kind": "mcp_server",
        "description": "Capture engine/runtime screenshots through a bounded MCP wrapper.",
        "command": [PYTHON, *PROBE_MODULE, "godot-playtest", "--artifact", "{artifact_dir}", "--frames", "120"],
        "safety_scope": "candidate_workspace_only",
        "tags": ["engine_tooling", "visual"],
    },
]

CODE_TOOL_INTERFACES = [
    {
        "id": "python_runtime",
        "kind": "command_wrapper",
        "description": "Run bounded Python commands inside the candidate workspace.",
        "command": [PYTHON, "-c", "import os; print(os.listdir('{artifact_dir}')[:5])"],
        "safety_scope": "candidate_workspace_only",
        "tags": ["runtime"],
    },
    {
        "id": "shell_tool",
        "kind": "command_wrapper",
        "description": "Run bounded shell inspection commands in the candidate workspace.",
        "command": ["bash", "-lc", "ls -la '{artifact_dir}' | head"],
        "safety_scope": "candidate_workspace_only",
        "tags": ["runtime"],
    },
]

VERIGAME_TOOL_INTERFACES = [
    {
        "id": "node_build_tool",
        "kind": "command_wrapper",
        "description": "Build the candidate web game with npm.",
        "command": [PYTHON, *PROBE_MODULE, "verigame-build", "--artifact", "{artifact_dir}"],
        "safety_scope": "candidate_workspace_only",
        "tags": ["build"],
    },
    {
        "id": "playwright_screenshot",
        "kind": "engine_probe",
        "description": "Verify build artifacts exist before screenshot-based checks.",
        "command": [PYTHON, *PROBE_MODULE, "verigame-screenshot", "--artifact", "{artifact_dir}"],
        "safety_scope": "candidate_workspace_only",
        "tags": ["visual"],
    },
]

ARTIFACT_EXISTS_PROBE = {
    "id": "artifact_exists",
    "command": [
        PYTHON,
        "-c",
        (
            "import json,sys,os; a=sys.argv[1]; "
            "ok=os.path.isdir(a) and len(os.listdir(a))>0; "
            "print(json.dumps({'passed': ok}))"
        ),
        "{artifact_dir}",
    ],
    "cwd": ".",
    "parser": "json_stdout",
    "selection_mode": "required",
    "timeout_seconds": 30,
}

ARTIFACT_FILE_COUNT_FAMILY = {
    "id": "artifact_file_count",
    "gene": {
        "name": "min_files",
        "initial": 1,
        "minimum": 1,
        "maximum": 20,
        "step": 1,
        "difficulty_direction": "increasing",
    },
    "probe": {
        "cwd": ".",
        "command": [
            PYTHON,
            "-c",
            (
                "import json,sys,os; a=sys.argv[1]; n=int(sys.argv[2]); "
                "c=len(os.listdir(a)) if os.path.isdir(a) else 0; "
                "print(json.dumps({'passed': c>=n, 'file_count': c, 'min_files': n}))"
            ),
            "{artifact_dir}",
            "[[min_files]]",
        ],
        "timeout_seconds": 30,
        "selection_mode": "regression_anchor",
        "parser": "json_stdout",
        "tags": ["ImproveObjective", "coverage"],
    },
    "archive_capacity": 8,
}

GCBENCH_FIXED_PROBES = [
    {
        "id": "godot_public_import",
        "command": [PYTHON, *PROBE_MODULE, "godot-import", "--artifact", "{artifact_dir}"],
        "cwd": ".",
        "parser": "json_stdout",
        "selection_mode": "required",
        "timeout_seconds": 180,
        "tags": ["RepairConstraint", "godot"],
    },
    {
        "id": "gcbench_demo_evidence",
        "command": [
            PYTHON,
            *PROBE_MODULE,
            "gcbench-demo-evidence",
            "--artifact",
            "{artifact_dir}",
            "--max-demos",
            "10",
            "--max-frames",
            "600",
        ],
        "cwd": ".",
        "parser": "json_stdout",
        "selection_mode": "required",
        "timeout_seconds": 30,
        "tags": ["ImproveObjective", "behavior_evidence"],
    },
    {
        "id": "godot_public_runtime",
        "command": [
            PYTHON,
            *PROBE_MODULE,
            "godot-playtest",
            "--artifact",
            "{artifact_dir}",
            "--frames",
            "600",
        ],
        "cwd": ".",
        "parser": "json_stdout",
        "selection_mode": "required",
        "timeout_seconds": 600,
        "tags": ["ImproveObjective", "runtime"],
    },
    {
        "id": "godot_quality_inventory",
        "command": [PYTHON, *PROBE_MODULE, "godot-quality-inventory", "--artifact", "{artifact_dir}"],
        "cwd": ".",
        "parser": "json_stdout",
        "selection_mode": "required",
        "timeout_seconds": 30,
        "tags": ["coverage", "godot"],
    },
]

GCBENCH_PROBE_FAMILY = {
    "id": "godot_runtime_horizon",
    "gene": {
        "name": "frames",
        "initial": 600,
        "minimum": 100,
        "maximum": 1800,
        "step": 100,
        "difficulty_direction": "increasing",
    },
    "probe": {
        "cwd": ".",
        "command": [
            PYTHON,
            *PROBE_MODULE,
            "godot-playtest",
            "--artifact",
            "{artifact_dir}",
            "--frames",
            "[[frames]]",
        ],
        "timeout_seconds": 1800,
        "selection_mode": "regression_anchor",
        "parser": "json_stdout",
        "tags": ["ImproveObjective", "runtime"],
    },
    "archive_capacity": 8,
}

GDBENCH_FIXED_PROBES = [
    item
    for item in GCBENCH_FIXED_PROBES
    if item["id"] in {"godot_public_import", "godot_public_runtime"}
] + [
    {
        "id": "gdbench_official_validation",
        "command": [
            PYTHON,
            *PROBE_MODULE,
            "gdbench-validation",
            "--artifact",
            "{artifact_dir}",
            "--task-source",
            "{task_source}",
        ],
        "cwd": ".",
        "parser": "json_stdout",
        "selection_mode": "required",
        "timeout_seconds": 600,
        "tags": ["RepairConstraint", "validation"],
    },
]

CODE_BENCH_PRESET = {
    "fixed_probes": [ARTIFACT_EXISTS_PROBE],
    "probe_families": [ARTIFACT_FILE_COUNT_FAMILY],
    "max_selected_probes": 2,
    "harness_modules": CODE_HARNESS_MODULES,
    "tool_interfaces": CODE_TOOL_INTERFACES,
    "seed_modules": ["evidence_first", "test_driven", "regression_first"],
}

BENCHMARK_PRESETS: dict[str, dict[str, Any]] = {
    "gcbench": {
        "fixed_probes": GCBENCH_FIXED_PROBES,
        "probe_families": [GCBENCH_PROBE_FAMILY],
        "max_selected_probes": 5,
        "harness_modules": GAME_HARNESS_MODULES,
        "tool_interfaces": GAME_TOOL_INTERFACES,
        "seed_modules": [
            "evidence_first",
            "regression_first",
            "engine_tooling_first",
        ],
    },
    "gdbench": {
        "fixed_probes": GDBENCH_FIXED_PROBES,
        "probe_families": [GCBENCH_PROBE_FAMILY],
        "max_selected_probes": 4,
        "harness_modules": GAME_HARNESS_MODULES,
        "tool_interfaces": GAME_TOOL_INTERFACES,
        "seed_modules": [
            "evidence_first",
            "regression_first",
            "engine_tooling_first",
        ],
    },
    "swebench": CODE_BENCH_PRESET,
    "nl2repo": CODE_BENCH_PRESET,
    "terminalbench": CODE_BENCH_PRESET,
    "weavebench": CODE_BENCH_PRESET,
    "verigame": {
        "fixed_probes": [
            {
                "id": "verigame_build",
                "command": [PYTHON, *PROBE_MODULE, "verigame-build", "--artifact", "{artifact_dir}"],
                "cwd": ".",
                "parser": "json_stdout",
                "selection_mode": "required",
                "timeout_seconds": 600,
                "tags": ["RepairConstraint", "build"],
            },
        ],
        "probe_families": [
            {
                "id": "verigame_screenshot_horizon",
                "gene": {
                    "name": "wait_ms",
                    "initial": 1000,
                    "minimum": 500,
                    "maximum": 5000,
                    "step": 500,
                    "difficulty_direction": "decreasing",
                },
                "probe": {
                    "cwd": ".",
                    "command": [
                        PYTHON,
                        *PROBE_MODULE,
                        "verigame-screenshot",
                        "--artifact",
                        "{artifact_dir}",
                        "--wait-ms",
                        "[[wait_ms]]",
                    ],
                    "timeout_seconds": 120,
                    "selection_mode": "regression_anchor",
                    "parser": "json_stdout",
                    "tags": ["ImproveObjective", "visual"],
                },
                "archive_capacity": 8,
            },
        ],
        "max_selected_probes": 2,
        "harness_modules": GAME_HARNESS_MODULES,
        "tool_interfaces": VERIGAME_TOOL_INTERFACES,
        "seed_modules": ["evidence_first", "regression_first", "engine_tooling_first"],
    },
    "vgamegym": {
        "fixed_probes": [
            {
                "id": "pygame_runtime",
                "command": [
                    PYTHON,
                    *PROBE_MODULE,
                    "pygame-runtime",
                    "--artifact",
                    "{artifact_dir}",
                    "--run-seconds",
                    "8",
                ],
                "cwd": ".",
                "parser": "json_stdout",
                "selection_mode": "required",
                "timeout_seconds": 60,
                "tags": ["ImproveObjective", "runtime"],
            },
        ],
        "probe_families": [
            {
                "id": "pygame_runtime_horizon",
                "gene": {
                    "name": "run_seconds",
                    "initial": 8,
                    "minimum": 4,
                    "maximum": 60,
                    "step": 4,
                    "difficulty_direction": "increasing",
                },
                "probe": {
                    "cwd": ".",
                    "command": [
                        PYTHON,
                        *PROBE_MODULE,
                        "pygame-runtime",
                        "--artifact",
                        "{artifact_dir}",
                        "--run-seconds",
                        "[[run_seconds]]",
                    ],
                    "timeout_seconds": 120,
                    "selection_mode": "regression_anchor",
                    "parser": "json_stdout",
                    "tags": ["ImproveObjective", "runtime"],
                },
                "archive_capacity": 8,
            },
        ],
        "max_selected_probes": 2,
        "harness_modules": GAME_HARNESS_MODULES,
        "tool_interfaces": GAME_TOOL_INTERFACES,
        "seed_modules": ["evidence_first", "regression_first", "gameplay_observability"],
    },
}


def _harness_evolution(
    *,
    modules: list[dict[str, Any]],
    tool_interfaces: list[dict[str, Any]],
    seed_modules: list[str],
    allowed_niches: list[str] | None = None,
    loop_role: str = "inner",
    max_active_modules: int | None = None,
    max_active_tool_interfaces: int | None = None,
    replay_min_cases: int | None = None,
    rubric_validation_sample_size: int | None = None,
    promotion_delta_min: float | None = None,
    max_case_regression: float | None = None,
    require_rubric_validation: bool = True,
    element_catalog: list[dict[str, Any]] | None = None,
    seed_elements: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    active_modules = max(1, len(seed_modules)) if max_active_modules is None else max_active_modules
    active_tools = (
        min(2, len(tool_interfaces))
        if max_active_tool_interfaces is None
        else max_active_tool_interfaces
    )
    if loop_role == "outer":
        sample_size = rubric_validation_sample_size or 2
        replay_cases = replay_min_cases or 2
    else:
        sample_size = rubric_validation_sample_size or 3
        replay_cases = replay_min_cases or 3
    del promotion_delta_min, max_case_regression
    payload: dict[str, Any] = {
        "modules": deepcopy(modules),
        "tool_interfaces": deepcopy(tool_interfaces),
        "seed_modules": list(seed_modules),
        "max_active_modules": active_modules,
        "max_active_tool_interfaces": active_tools,
        "mutation_width": 1,
        "replay_min_cases": replay_cases,
        "rubric_validation_sample_size": sample_size,
        "loop_role": loop_role,
        "require_rubric_validation": require_rubric_validation,
        "dynamic_rubric_generation": True,
        "enable_usage_driven_mutation": loop_role == "inner",
        "rubric_provider": "deepseek",
        "element_mutation_policy": {
            "removal_min_usage": 5,
            "removal_min_usage_share": 0.25,
            "removal_max_accuracy": 0.35,
            "merge_min_similarity": 0.55,
        },
    }
    if element_catalog is not None:
        payload["element_catalog"] = deepcopy(element_catalog)
    if seed_elements is not None:
        payload["seed_elements"] = deepcopy(seed_elements)
    if allowed_niches is not None:
        payload["allowed_niches"] = list(allowed_niches)
    return payload


def build_inner_harness_evolution(bench: str) -> dict[str, Any]:
    preset = BENCHMARK_PRESETS[bench]
    seed_modules = list(preset["seed_modules"])
    modules = deepcopy(preset["harness_modules"])
    tool_interfaces = deepcopy(preset["tool_interfaces"])
    if bench in {"gdbench", "gcbench"}:
        tool_interfaces = deepcopy(GAME_TOOL_INTERFACES)
    return _harness_evolution(
        modules=modules,
        tool_interfaces=tool_interfaces,
        seed_modules=seed_modules,
        loop_role="inner",
        max_active_modules=min(5, len(modules)),
        max_active_tool_interfaces=min(4, max(2, len(tool_interfaces))),
        replay_min_cases=3,
        rubric_validation_sample_size=3,
        element_catalog=deepcopy(INNER_ELEMENT_CATALOG),
        seed_elements=deepcopy(DEFAULT_INNER_SEED_ELEMENTS),
    )


def build_outer_harness_evolution() -> dict[str, Any]:
    seed_modules = ["context_compiler", "module_strategy"]
    return _harness_evolution(
        modules=deepcopy(OUTER_HARNESS_MODULES),
        tool_interfaces=deepcopy(OUTER_TOOL_INTERFACES),
        seed_modules=seed_modules,
        allowed_niches=[
            "context_compiler",
            "module_strategy",
            "skill_governance",
            "tool_interface",
            "feedback_synthesis",
            "session_routing",
        ],
        loop_role="outer",
        max_active_modules=2,
        max_active_tool_interfaces=1,
        replay_min_cases=2,
        rubric_validation_sample_size=2,
        promotion_delta_min=0.05,
        max_case_regression=0.05,
    )


def build_method_section(
    bench: str,
    *,
    allowed_niches: list[str] | None = None,
    ablation: bool = False,
) -> dict[str, Any]:
    preset = BENCHMARK_PRESETS[bench]
    if ablation:
        modules = deepcopy(ABLATION_HARNESS_MODULES)
        seed_modules = (
            list(allowed_niches)[:2]
            if allowed_niches
            else ["context_compiler", "module_strategy"]
        )
        tool_interfaces: list[dict[str, Any]] = []
    else:
        modules = deepcopy(preset["harness_modules"])
        seed_modules = list(preset["seed_modules"])
        tool_interfaces = deepcopy(preset["tool_interfaces"])
        if bench in {"gdbench", "gcbench"}:
            tool_interfaces = deepcopy(GAME_TOOL_INTERFACES)

    max_selected = int(preset["max_selected_probes"])
    harness_payload = _harness_evolution(
        modules=modules,
        tool_interfaces=tool_interfaces,
        seed_modules=seed_modules,
        allowed_niches=allowed_niches if ablation else None,
        loop_role="outer" if ablation else "inner",
        max_active_modules=2 if ablation else min(5, len(modules)),
        max_active_tool_interfaces=1 if ablation else min(4, len(tool_interfaces) or 1),
        replay_min_cases=2 if ablation else 3,
        rubric_validation_sample_size=2 if ablation else 3,
        element_catalog=None if ablation else deepcopy(INNER_ELEMENT_CATALOG),
        seed_elements=None if ablation else deepcopy(DEFAULT_INNER_SEED_ELEMENTS),
    )
    return {
        "level": "L4",
        "fixed_probes": deepcopy(preset["fixed_probes"]),
        "probe_families": deepcopy(preset["probe_families"]),
        "max_probe_calls": 6 * max_selected,
        "active_selection": {
            "max_selected_probes": max_selected,
            "min_observations_per_probe": 1,
        },
        "harness_evolution": harness_payload,
    }
