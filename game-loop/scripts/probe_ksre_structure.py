#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe KSRE pXt structure")
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--min-pxt-assets", type=int, default=30)
    args = parser.parse_args()
    artifact = args.artifact.resolve()
    pxt = artifact / "game/mods/pxt"
    assets = [
        path
        for path in pxt.rglob("*")
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".ogg"}
    ] if pxt.is_dir() else []
    rpy = list((artifact / "game").glob("*.rpy"))
    passed = pxt.is_dir() and len(assets) >= args.min_pxt_assets and len(rpy) >= 20
    print(json.dumps({
        "passed": passed,
        "score": 1.0 if passed else 0.0,
        "metrics": {
            "pxt_assets": len(assets),
            "root_rpy": len(rpy),
        },
        "diagnostics": [] if passed else [f"expected at least {args.min_pxt_assets} pXt assets and 20 root rpy files"],
    }, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
