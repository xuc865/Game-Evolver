#!/usr/bin/env python3
"""Process-isolated wrapper for the official V-GameGym recorder."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-root", type=Path, required=True)
    parser.add_argument("--dataset-item", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    official = args.official_root.resolve()
    # Patch only the generated recorder module copy. Its child script imports
    # the same modules; loading Pygame first avoids macOS SDL symbol clashes.
    source_path = official / "screenshot_recorder.py"
    patched_dir = Path(tempfile.mkdtemp(prefix="vgg-recorder-module-"))
    patched_module = patched_dir / "screenshot_recorder.py"
    source = source_path.read_text(encoding="utf-8")
    source = source.replace(
        "import cv2\nimport numpy as np\nfrom PIL import Image\nimport pygame",
        "import pygame\nimport cv2\nimport numpy as np\nfrom PIL import Image",
    )
    patched_module.write_text(source, encoding="utf-8")
    sys.path.insert(0, str(patched_dir))
    sys.path.insert(1, str(official))
    # Load Pygame's SDL before the recorder imports OpenCV. On macOS the two
    # wheels bundle SDL2 symbols with the same Objective-C class names.
    from screenshot_recorder import task_worker  # type: ignore

    item = json.loads(args.dataset_item.read_text(encoding="utf-8"))
    result = task_worker({
        "dataset_item": item,
        "output_dir": str(args.output_dir.resolve()),
        "record_duration": int(item.get("record_duration", 10)),
        "video_fps": 3,
        "screenshot_format": "jpg",
        "async_io": True,
    })
    print(json.dumps(result, ensure_ascii=False), flush=True)
    execution = result.get("execution_result", {}) if isinstance(result, dict) else {}
    return 0 if isinstance(execution, dict) and execution.get("success") else 2


if __name__ == "__main__":
    raise SystemExit(main())
