"""Broad, engine-agnostic harness element libraries (skills, MCPs, tools, ...)."""

INNER_ELEMENT_CATALOG = [
    # ── skill ──
    {
        "id": "skill_runtime_smoke",
        "category": "skill",
        "description": "Run bounded runtime smoke on the candidate entrypoint.",
        "spec": {"mode": "runtime_smoke", "timeout_seconds": 30},
        "tags": ["runtime", "smoke", "universal"],
    },
    {
        "id": "skill_regression_suite",
        "category": "skill",
        "description": "Run preserved regression probes before accepting edits.",
        "spec": {"mode": "regression_first"},
        "tags": ["regression", "repair", "universal"],
    },
    {
        "id": "skill_entrypoint_probe",
        "category": "skill",
        "description": "Discover and validate the primary game entrypoint.",
        "spec": {"mode": "entrypoint_probe"},
        "tags": ["runtime", "inspection", "universal"],
    },
    {
        "id": "skill_file_structure_audit",
        "category": "skill",
        "description": "Audit project layout for missing gameplay assets and scripts.",
        "spec": {"mode": "structure_audit"},
        "tags": ["inspection", "universal"],
    },
    {
        "id": "skill_visual_snapshot",
        "category": "skill",
        "description": "Capture visual/runtime snapshots for gameplay evidence.",
        "spec": {"mode": "visual_snapshot", "frames": 60},
        "tags": ["visual", "runtime", "universal"],
    },
    {
        "id": "skill_demo_replay_audit",
        "category": "skill",
        "description": "Audit demo replay artifacts for gameplay evidence.",
        "spec": {"probe": "gcbench-demo-evidence"},
        "tags": ["demo", "evidence", "replay"],
    },
    {
        "id": "skill_pygame_smoke_loop",
        "category": "skill",
        "description": "Execute pygame entrypoint for bounded smoke runtime.",
        "spec": {"probe": "pygame-runtime", "run_seconds": 8},
        "tags": ["pygame", "runtime"],
    },
    {
        "id": "skill_godot_headless_playtest",
        "category": "skill",
        "description": "Replay real gcbench input traces through the Godot game, inspect state progression and runtime logs, then use the evidence to drive edits.",
        "spec": {"probe": "official-gcbench-demo-replay", "requires_input_events": True, "requires_runtime_logs": True, "min_traces": 1},
        "tags": ["godot", "runtime", "interaction", "state_transition", "evidence"],
    },
    {
        "id": "skill_web_build_verify",
        "category": "skill",
        "description": "Build web game bundle and verify dist artifacts.",
        "spec": {"probe": "verigame-build"},
        "tags": ["web", "build"],
    },
    # ── mcp ──
    {
        "id": "mcp_runtime_screenshot",
        "category": "mcp",
        "description": "Capture bounded runtime screenshots through MCP wrapper.",
        "spec": {"interface": "runtime_screenshot", "frames": 60},
        "tags": ["visual", "runtime", "universal"],
    },
    {
        "id": "mcp_file_tree_inspect",
        "category": "mcp",
        "description": "Inspect candidate file tree and highlight gameplay-relevant paths.",
        "spec": {"interface": "file_tree_inspect"},
        "tags": ["inspection", "universal"],
    },
    {
        "id": "mcp_godot_screenshot",
        "category": "mcp",
        "description": "Capture bounded Godot runtime screenshots through MCP wrapper.",
        "spec": {"interface": "godot_mcp_screenshot", "frames": 120},
        "tags": ["godot", "visual"],
    },
    {
        "id": "mcp_godot_scene_tree",
        "category": "mcp",
        "description": "Inspect Godot scene tree and node state via MCP.",
        "spec": {"interface": "godot_scene_tree"},
        "tags": ["godot", "introspection"],
    },
    # ── tool ──
    {
        "id": "tool_artifact_inventory",
        "category": "tool",
        "description": "Inventory candidate files to detect missing gameplay assets.",
        "spec": {"command": "artifact_inventory"},
        "tags": ["inspection", "universal"],
    },
    {
        "id": "tool_entrypoint_discover",
        "category": "tool",
        "description": "Locate runnable entry scripts or project manifests.",
        "spec": {"command": "entrypoint_discover"},
        "tags": ["runtime", "inspection", "universal"],
    },
    {
        "id": "tool_dependency_check",
        "category": "tool",
        "description": "Validate declared dependencies before gameplay edits.",
        "spec": {"command": "dependency_check"},
        "tags": ["build", "universal"],
    },
    {
        "id": "tool_pygame_runtime_probe",
        "category": "tool",
        "description": "Invoke pygame runtime probe on candidate workspace.",
        "spec": {"command": "pygame-runtime"},
        "tags": ["pygame", "runtime"],
    },
    {
        "id": "tool_godot_import_check",
        "category": "tool",
        "description": "Run Godot import validation before gameplay edits.",
        "spec": {"command": "godot-import"},
        "tags": ["godot", "build"],
    },
    # ── context ──
    {
        "id": "ctx_task_spec_anchor",
        "category": "context",
        "description": "Keep public task spec anchor always in compiled context.",
        "spec": {"window": "task_spec", "priority": 1.0},
        "tags": ["context", "universal"],
    },
    {
        "id": "ctx_probe_digest",
        "category": "context",
        "description": "Summarize latest deep probe outputs for the next edit.",
        "spec": {"window": "probe_summaries", "limit": 5},
        "tags": ["context", "runtime", "universal"],
    },
    {
        "id": "ctx_recent_failures",
        "category": "context",
        "description": "Include recent failed attempts with probe stderr excerpts.",
        "spec": {"window": "failures", "limit": 3},
        "tags": ["context", "repair", "universal"],
    },
    {
        "id": "ctx_edit_history",
        "category": "context",
        "description": "Track recent patch summaries to avoid repeated dead ends.",
        "spec": {"window": "edit_history", "limit": 4},
        "tags": ["context", "repair"],
    },
    {
        "id": "ctx_engine_hints",
        "category": "context",
        "description": "Include engine-specific hints inferred from workspace layout.",
        "spec": {"window": "engine_hints", "priority": 0.6},
        "tags": ["context", "runtime"],
    },
    # ── protocol ──
    {
        "id": "proto_workspace_boundary",
        "category": "protocol",
        "description": "Forbid edits outside candidate workspace and public task files.",
        "spec": {"scope": "candidate_workspace_only"},
        "tags": ["protocol", "safety", "universal"],
    },
    {
        "id": "proto_edit_verify_handoff",
        "category": "protocol",
        "description": "Require explicit edit→verify handoff before candidate acceptance.",
        "spec": {"phases": ["plan", "edit", "verify"]},
        "tags": ["protocol", "universal"],
    },
    {
        "id": "proto_probe_before_accept",
        "category": "protocol",
        "description": "Block acceptance until at least one deep probe succeeds.",
        "spec": {"gate": "deep_probe_pass"},
        "tags": ["protocol", "runtime", "universal"],
    },
    # ── workflow ──
    {
        "id": "wf_probe_first",
        "category": "workflow",
        "description": "Run deep probes before proposing gameplay patches.",
        "spec": {"steps": ["probe", "diagnose", "patch"]},
        "tags": ["workflow", "runtime", "universal"],
    },
    {
        "id": "wf_plan_patch_verify",
        "category": "workflow",
        "description": "Standard workflow: plan, patch, run deep probes, verify.",
        "spec": {"steps": ["plan", "patch", "probe", "verify"]},
        "tags": ["workflow", "universal"],
    },
    {
        "id": "wf_checkpoint_rollback",
        "category": "workflow",
        "description": "Checkpoint artifact then rollback on hard regression.",
        "spec": {"steps": ["checkpoint", "patch", "verify", "rollback_on_fail"]},
        "tags": ["workflow", "recovery", "universal"],
    },
    {
        "id": "wf_diagnose_then_patch",
        "category": "workflow",
        "description": "Diagnose failures from evidence, then apply a minimal patch.",
        "spec": {"steps": ["collect_evidence", "diagnose", "patch", "verify"]},
        "tags": ["workflow", "repair", "universal"],
    },
]

DEFAULT_INNER_SEED_ELEMENTS = {
    "skill": [
        "skill_runtime_smoke",
        "skill_regression_suite",
        "skill_demo_replay_audit",
    ],
    "mcp": ["mcp_runtime_screenshot"],
    "tool": ["tool_artifact_inventory", "tool_entrypoint_discover"],
    "context": ["ctx_task_spec_anchor", "ctx_probe_digest", "ctx_recent_failures"],
    "protocol": ["proto_workspace_boundary", "proto_edit_verify_handoff"],
    "workflow": ["wf_probe_first", "wf_plan_patch_verify"],
}


OUTER_ELEMENT_CATALOG = [
    {
        "id": "ctx_inner_rejection_memory",
        "category": "context",
        "description": "Summarize rejected inner harness proposals before proposing a new element-library change.",
        "spec": {
            "window": "inner_rejection_experience",
            "inner_tags": ["diversity_escape", "workflow"],
        },
        "tags": ["context", "inner_harness", "rejection_memory", "universal"],
    },
    {
        "id": "ctx_element_usage_accuracy_digest",
        "category": "context",
        "description": "Expose per-element usage and accuracy trends to the harness-generation agent.",
        "spec": {
            "window": "element_stats",
            "inner_tags": ["usage_driven"],
        },
        "tags": ["context", "element_stats", "usage_driven", "universal"],
    },
    {
        "id": "skill_failure_to_element_mapping",
        "category": "skill",
        "description": "Map inner-loop failure families to reusable harness element categories and tags.",
        "spec": {
            "mode": "failure_to_element_mapping",
            "inner_tags": ["skill", "tool", "context"],
        },
        "tags": ["skill", "failure_analysis", "element_library", "universal"],
    },
    {
        "id": "skill_harness_gap_analysis",
        "category": "skill",
        "description": "Identify missing reusable harness-generation experience from recent game-agent traces.",
        "spec": {
            "mode": "harness_gap_analysis",
            "inner_tags": ["element_add", "usage_driven"],
        },
        "tags": ["skill", "gap_analysis", "element_add", "universal"],
    },
    {
        "id": "tool_outer_stats_inspector",
        "category": "tool",
        "description": "Inspect outer element usage/accuracy stats before changing the outer library.",
        "spec": {
            "command": "outer_element_stats_digest",
            "inner_tags": ["usage_driven"],
        },
        "tags": ["tool", "stats", "accuracy", "universal"],
    },
    {
        "id": "protocol_element_library_only",
        "category": "protocol",
        "description": "Constrain outer evolution to reusable element-library management, not hard module forcing.",
        "spec": {
            "scope": "element_library_management_only",
            "inner_tags": ["usage_driven"],
        },
        "tags": ["protocol", "library_only", "safety", "universal"],
    },
    {
        "id": "workflow_prune_merge_replace",
        "category": "workflow",
        "description": "Prune, merge, or replace low-accuracy harness-generation elements using recorded outcomes.",
        "spec": {
            "steps": ["inspect_stats", "select_category", "prune_or_merge", "record_change"],
            "inner_tags": ["element_merge", "usage_driven"],
        },
        "tags": ["workflow", "stats_driven", "merge", "repair", "universal"],
    },
    {
        "id": "workflow_targeted_element_addition",
        "category": "workflow",
        "description": "Add one targeted reusable harness-generation element for a repeated inner-loop failure mode.",
        "spec": {
            "steps": ["classify_failure", "choose_category", "add_element", "track_accuracy"],
            "inner_tags": ["element_add", "usage_driven"],
        },
        "tags": ["workflow", "element_add", "failure_analysis", "universal"],
    },
]

DEFAULT_OUTER_SEED_ELEMENTS = {
    "context": [
        "ctx_inner_rejection_memory",
        "ctx_element_usage_accuracy_digest",
    ],
    "skill": ["skill_failure_to_element_mapping"],
    "tool": ["tool_outer_stats_inspector"],
    "protocol": ["protocol_element_library_only"],
    "workflow": ["workflow_targeted_element_addition"],
}
