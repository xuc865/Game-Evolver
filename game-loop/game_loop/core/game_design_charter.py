"""Small, frozen design-context helpers for game evolution and judging."""

from __future__ import annotations

from pathlib import Path


MAX_CHARTER_CHARS = 6000


def load_design_charter(path: Path | None) -> str:
    """Read a public, immutable game-design charter if one was supplied."""
    if path is None:
        return ""
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"design charter not found: {resolved}")
    return resolved.read_text(encoding="utf-8", errors="replace").strip()[:MAX_CHARTER_CHARS]


def charter_section(text: str) -> str:
    value = text.strip()
    return f"\n\n## Game design charter (frozen context)\n\n{value}" if value else ""

