#!/usr/bin/env python3
"""Record a generated Pygame game without importing OpenCV."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-file", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--duration", type=int, default=10)
    parser.add_argument("--game-id", required=True)
    args = parser.parse_args(argv)
    output = args.output_dir.resolve() / str(args.game_id)
    shots = output / "screenshots"
    videos = output / "videos"
    shots.mkdir(parents=True, exist_ok=True)
    videos.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"vgg_local_{args.game_id}_") as temp:
        frame_dir = Path(temp) / "frames"
        frame_dir.mkdir()
        capture = Path(temp) / "capture.py"
        source = args.game_file.resolve().read_text(encoding="utf-8")
        source = "\n".join(
            line for line in source.splitlines()
            if not line.startswith("from __future__ import ")
        )
        source = source.replace("import pygame", "import pygame", 1)
        prelude = f'''\nimport pygame as _vgg_pygame\nimport time as _vgg_time\nimport threading as _vgg_threading\n_vgg_frame_dir = r"{frame_dir}"\n_vgg_start = _vgg_time.time()\n_vgg_next_shot = 0\n_vgg_frame_index = 0\n_vgg_orig_flip = _vgg_pygame.display.flip\n_vgg_orig_update = _vgg_pygame.display.update\ndef _vgg_capture():\n    global _vgg_next_shot, _vgg_frame_index\n    try:\n        surface = _vgg_pygame.display.get_surface()\n        if surface is None: return\n        now = _vgg_time.time() - _vgg_start\n        if now >= _vgg_next_shot:\n            _vgg_pygame.image.save(surface, str(_vgg_frame_dir / f"frame_{{_vgg_frame_index:04d}}.png"))\n            _vgg_frame_index += 1\n            _vgg_next_shot += 1 / 3\n        while _vgg_next_shot <= now: _vgg_next_shot += 1 / 3\n    except Exception: pass\ndef _vgg_flip():\n    result = _vgg_orig_flip()\n    _vgg_capture()\n    return result\ndef _vgg_update(*args, **kwargs):\n    result = _vgg_orig_update(*args, **kwargs)\n    _vgg_capture()\n    return result\n_vgg_pygame.display.flip = _vgg_flip\n_vgg_pygame.display.update = _vgg_update\ndef _vgg_quit():\n    _vgg_time.sleep({int(args.duration) + 1})\n    try: _vgg_pygame.event.post(_vgg_pygame.event.Event(_vgg_pygame.QUIT))\n    except Exception: pass\n_vgg_threading.Thread(target=_vgg_quit, daemon=True).start()\n'''
        prelude = prelude.replace(
            "import pygame as _vgg_pygame",
            "from pathlib import Path\nimport pygame as _vgg_pygame",
            1,
        )
        prelude = prelude.replace(
            f'_vgg_frame_dir = r"{frame_dir}"',
            f'_vgg_frame_dir = Path(r"{frame_dir}")',
            1,
        )
        prelude = prelude.replace(
            "def _vgg_quit():",
            "def _vgg_capture_loop():\n    while _vgg_time.time() - _vgg_start < "
            + str(int(args.duration) + 2)
            + ":\n        _vgg_capture()\n        _vgg_time.sleep(1 / 3)\n_vgg_threading.Thread(target=_vgg_capture_loop, daemon=True).start()\ndef _vgg_quit():"
        )
        prelude = "from __future__ import annotations\n" + prelude.lstrip("\\n")
        prelude = prelude.replace(
            "import threading as _vgg_threading",
            "import threading as _vgg_threading\nimport sys as _vgg_sys\nfrom pathlib import Path as _vgg_Path\n_vgg_artifact_dir = _vgg_Path(r\"" + str(args.game_file.resolve().parent) + "\")\nif str(_vgg_artifact_dir) not in _vgg_sys.path:\n    _vgg_sys.path.insert(0, str(_vgg_artifact_dir))",
            1,
        )
        capture.write_text(prelude + "\n" + source, encoding="utf-8")
        env = os.environ.copy()
        env.setdefault("SDL_VIDEODRIVER", "dummy")
        env.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
        completed = subprocess.run(
            [sys.executable, str(capture)], capture_output=True, text=True,
            timeout=args.duration + 30, env=env,
            cwd=str(args.game_file.resolve().parent), check=False,
        )
        frames = sorted(frame_dir.glob("frame_*.png"))
        for index, frame in enumerate(frames[:20]):
            subprocess.run(["/opt/homebrew/bin/ffmpeg", "-loglevel", "error", "-y", "-i", str(frame), "-frames:v", "1", str(shots / f"time_{index:02d}s.jpg")], check=False)
        video = videos / "gameplay.mp4"
        if frames:
            subprocess.run(["/opt/homebrew/bin/ffmpeg", "-loglevel", "error", "-y", "-framerate", "3", "-pattern_type", "glob", "-i", str(frame_dir / "frame_*.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)], check=False)
    result = {"success": completed.returncode == 0 and bool(frames), "returncode": completed.returncode, "stdout": completed.stdout[-500:], "stderr": completed.stderr[-500:], "screenshots": [str(p) for p in sorted(shots.glob("*.jpg"))], "video_path": str(video) if video.is_file() else None, "video_exists": video.is_file()}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["success"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
