#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--min-gdscript-files", type=int, required=True)
    args = parser.parse_args()
    count = len(list(args.artifact.resolve().rglob("*.gd")))
    required = (
        "source/client",
        "source/server/gateway",
        "source/server/master",
        "source/server/world",
        "source/common/network/wire_codec.gd",
    )
    missing = [item for item in required if not (args.artifact / item).exists()]
    passed = count >= args.min_gdscript_files and not missing
    print(json.dumps({
        "passed": passed,
        "score": min(1.0, count / max(1, args.min_gdscript_files)),
        "diagnostics": [
            *[f"missing architecture path: {item}" for item in missing],
            *([] if count >= args.min_gdscript_files else [
                f"GDScript coverage {count} is below {args.min_gdscript_files}"
            ]),
        ],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
