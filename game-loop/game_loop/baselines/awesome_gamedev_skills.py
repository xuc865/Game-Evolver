"""Integration helpers for the awesome-gamedev-agent-skills comparison arm."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path
from typing import Any


AWESOME_GAMEDEV_SKILLS_SOURCE_URL = (
    "https://github.com/gamedev-skills/awesome-gamedev-agent-skills.git"
)


def inspect_skills_source(source: Path) -> list[dict[str, str]]:
    """Return a deterministic catalog for an Agent Skills-compatible checkout."""

    source = source.expanduser().resolve()
    router = source / "router" / "SKILL.md"
    catalog = source / "skills"
    if not router.is_file() or not catalog.is_dir():
        raise ValueError(
            "awesome-gamedev-agent-skills source must contain router/SKILL.md "
            "and skills/**/SKILL.md"
        )

    paths = [router, *sorted(catalog.rglob("SKILL.md"))]
    entries: list[dict[str, str]] = []
    names: set[str] = set()
    for path in paths:
        metadata = _skill_metadata(path)
        name = metadata["name"]
        if name in names:
            raise ValueError(f"duplicate awesome skill name: {name}")
        names.add(name)
        entries.append(
            {
                "name": name,
                "description": metadata["description"],
                "path": path.relative_to(source).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    return entries


def materialize_skills_source(source: Path, destination: Path) -> list[dict[str, str]]:
    """Copy the official nested checkout into a flat Agent Skills root.

    The upstream repository groups skills by category, while Agent Skills
    consumers expect each skill directory directly below their configured
    skills root. The router is a peer of the 67 catalog skills.
    """

    source = source.expanduser().resolve()
    destination = destination.expanduser().resolve()
    entries = inspect_skills_source(source)
    if destination.exists() and any(destination.iterdir()):
        raise ValueError(f"skills destination must be empty: {destination}")
    destination.mkdir(parents=True, exist_ok=True)

    copied: set[str] = set()
    for entry in entries:
        skill_dir = source / entry["path"]
        skill_dir = skill_dir.parent
        name = entry["name"]
        if name in copied:
            raise ValueError(f"duplicate materialized skill name: {name}")
        copied.add(name)
        shutil.copytree(skill_dir, destination / name)
    return entries


def build_skills_index(source: Path) -> str:
    """Build the concise, deterministic catalog injected into LocalChatAgent."""

    entries = inspect_skills_source(source)
    lines = [
        "# awesome-gamedev-agent-skills",
        "",
        "This is a pinned comparison baseline. Load only the relevant skill file "
        "from the configured skills root before applying its guidance.",
        "",
    ]
    for entry in entries:
        lines.extend(
            [
                f"## {entry['name']}",
                entry["description"],
                f"path: {entry['path']}",
                "",
            ]
        )
    return "\n".join(lines)


def _skill_metadata(path: Path) -> dict[str, str]:
    content = path.read_text(encoding="utf-8")
    if not content.startswith("---\n"):
        raise ValueError(f"skill has no frontmatter: {path}")
    end = content.find("\n---", 4)
    if end < 0:
        raise ValueError(f"skill has unterminated frontmatter: {path}")
    values: dict[str, str] = {}
    lines = content[4:end].splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        key, sep, value = line.partition(":")
        if not sep or line.startswith((" ", "\t")):
            index += 1
            continue
        key = key.strip()
        value = value.strip()
        if value in {">", "|"}:
            continuation: list[str] = []
            index += 1
            while index < len(lines) and lines[index].startswith((" ", "\t")):
                continuation.append(lines[index].strip())
                index += 1
            values[key] = " ".join(continuation)
            continue
        values[key] = value.strip("\"'")
        index += 1
    name = values.get("name", "")
    description = values.get("description", "")
    if not name or not description:
        raise ValueError(f"skill is missing name or description: {path}")
    return {"name": name, "description": description}
