"""Delivery contract enforcement module.

Manages artifact file location auto-relocation and missing-file scaffolding.
Writes an audit log (``delivery_contract_repair.json``) recording every
relocation and scaffold operation performed during ``enforce``.
"""
from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from game_loop.utils import atomic_write_json, utc_now


# ── default scaffold templates ────────────────────────────────────────

_GODOT_PROJECT_TEMPLATE = """\
; Engine configuration file.
; It's best edited using the editor UI and not directly,
; since the parameters that go here are not all obvious.
;
; Format:
;   [section] ; section goes between []
;   param=value ; assign values to parameters

config_version=5

[application]
config/name="Generated Game"
config/description="Auto-scaffolded project"
run/main_scene="res://Main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
"""

_GODOT_MAIN_SCENE_TEMPLATE = """\
[gd_scene load_steps=1 format=3 uid="uid://auto_scaffold_main"]

[node name="Main" type="Node2D"]
"""

_GDIGNORE_TEMPLATE = ""


@dataclass
class RepairAction:
    """A single repair action recorded in the audit log."""

    action: str  # "relocate" | "scaffold" | "skip"
    filename: str
    source: str | None = None
    destination: str | None = None
    reason: str = ""
    timestamp: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "filename": self.filename,
            "source": self.source,
            "destination": self.destination,
            "reason": self.reason,
            "timestamp": self.timestamp,
        }


class DeliveryContract:
    """Enforce delivery contract on an artifact directory.

    Responsibilities:
    1. **Relocate misplaced files** — scan for key files (e.g. ``project.godot``)
       that exist in a sub-directory when they should be at the artifact root,
       and move them to the correct location.
    2. **Scaffold missing files** — for critical missing files, create a minimal
       runnable placeholder so downstream evaluation can proceed.
    3. **Audit log** — write ``delivery_contract_repair.json`` into the artifact
       directory recording every action taken.
    """

    # Files that must live at the artifact root.
    ROOT_LEVEL_FILES = frozenset({
        "project.godot",
        ".gdignore",
    })

    # Critical files that get scaffolded if missing.
    SCAFFOLDABLE: dict[str, str] = {
        "project.godot": _GODOT_PROJECT_TEMPLATE,
        "Main.tscn": _GODOT_MAIN_SCENE_TEMPLATE,
    }

    # Sub-directories where root-level files are commonly misplaced.
    COMMON_SUBDIRS = (
        "game", "project", "src", "artifact", "output", "build",
    )

    def enforce(self, artifact_dir: Path, contract: dict | None = None) -> dict[str, Any]:
        """Run delivery contract enforcement on *artifact_dir*.

        Parameters
        ----------
        artifact_dir
            The candidate artifact directory to inspect and repair.
        contract
            Optional contract dict.  Recognised keys:

            ``required_files`` : list[str]
                Filenames that must exist (after relocation).
            ``expected_root_files`` : list[str]
                Filenames expected at the directory root.
            ``scaffold_templates`` : dict[str, str]
                Override / extend the built-in scaffold templates.

        Returns
        -------
        dict
            Summary with keys ``actions``, ``relocated``, ``scaffolded``,
            ``skipped``, ``ok``.
        """
        artifact_dir = Path(artifact_dir)
        contract = contract or {}
        actions: list[RepairAction] = []

        # ── merge scaffold templates ──
        scaffold_templates = dict(self.SCAFFOLDABLE)
        scaffold_templates.update(contract.get("scaffold_templates", {}))

        # ── determine expected root files ──
        root_files = set(self.ROOT_LEVEL_FILES)
        root_files.update(contract.get("expected_root_files", []))
        root_files.update(contract.get("required_files", []))

        # ── 1. relocate misplaced root-level files ──
        for filename in sorted(root_files):
            correct_path = artifact_dir / filename
            if correct_path.is_file():
                actions.append(RepairAction(
                    action="skip", filename=filename,
                    destination=str(correct_path),
                    reason="already at correct location",
                ))
                continue

            # search sub-directories
            found = self._find_in_subdirs(artifact_dir, filename)
            if found is not None:
                target = artifact_dir / filename
                try:
                    shutil.move(str(found), str(target))
                    actions.append(RepairAction(
                        action="relocate", filename=filename,
                        source=str(found), destination=str(target),
                        reason="misplaced file moved to artifact root",
                    ))
                except (OSError, shutil.Error) as exc:
                    actions.append(RepairAction(
                        action="skip", filename=filename,
                        source=str(found), reason=f"relocate failed: {exc}",
                    ))
            # else: will be handled by scaffold step

        # ── 2. scaffold missing critical files ──
        for filename, template in scaffold_templates.items():
            target = artifact_dir / filename
            if target.is_file():
                continue
            # check if it was relocated above
            if any(a.filename == filename and a.action == "relocate" for a in actions):
                continue
            # only scaffold if it's in the required/expected list or is a known critical file
            required = set(contract.get("required_files", []))
            if filename not in required and filename not in self.SCAFFOLDABLE:
                continue
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(template, encoding="utf-8")
                actions.append(RepairAction(
                    action="scaffold", filename=filename,
                    destination=str(target),
                    reason="critical file missing — minimal placeholder created",
                ))
            except OSError as exc:
                actions.append(RepairAction(
                    action="skip", filename=filename,
                    reason=f"scaffold failed: {exc}",
                ))

        # ── 3. write audit log ──
        log_path = artifact_dir / "delivery_contract_repair.json"
        log_data = {
            "schema_version": "1.0",
            "artifact_dir": str(artifact_dir),
            "contract": contract,
            "actions": [a.to_dict() for a in actions],
            "summary": {
                "total": len(actions),
                "relocated": sum(1 for a in actions if a.action == "relocate"),
                "scaffolded": sum(1 for a in actions if a.action == "scaffold"),
                "skipped": sum(1 for a in actions if a.action == "skip"),
            },
            "created_at": utc_now(),
        }
        try:
            atomic_write_json(log_path, log_data)
        except OSError:
            pass  # audit log is best-effort

        return {
            "actions": [a.to_dict() for a in actions],
            "relocated": log_data["summary"]["relocated"],
            "scaffolded": log_data["summary"]["scaffolded"],
            "skipped": log_data["summary"]["skipped"],
            "ok": all(a.action != "skip" or "already" in a.reason for a in actions),
        }

    # ── internal helpers ──

    @staticmethod
    def _find_in_subdirs(root: Path, filename: str) -> Path | None:
        """Search one level of sub-directories for *filename*."""
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            candidate = entry / filename
            if candidate.is_file():
                return candidate
            # also check one more level deep
            for sub in sorted(entry.iterdir()):
                if not sub.is_dir() or sub.name.startswith("."):
                    continue
                deep_candidate = sub / filename
                if deep_candidate.is_file():
                    return deep_candidate
        return None
