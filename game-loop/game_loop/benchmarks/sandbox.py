from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SANDBOX_ROOT = (ROOT / "experiments").resolve()


def require_project_sandbox(path: Path, *, label: str) -> Path:
    """Keep all benchmark-owned mutable paths inside experiments/."""
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(SANDBOX_ROOT)
    except ValueError as exc:
        raise ValueError(
            f"{label} must be inside the project sandbox {SANDBOX_ROOT}: {resolved}"
        ) from exc
    return resolved
