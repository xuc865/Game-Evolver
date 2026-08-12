#!/usr/bin/env python3
"""Generate ablation configs via the shared experiment preset catalog."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    generator = Path(__file__).resolve().parents[1] / "experiments" / "generate_all_configs.py"
    completed = subprocess.run(
        [sys.executable, str(generator), "--ablation-only"],
        check=False,
    )
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
