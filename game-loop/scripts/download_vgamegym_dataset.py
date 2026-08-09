#!/usr/bin/env python3
"""Download the pinned official V-GameGym dataset without exposing credentials.

Authentication, when needed, is read only from ``HF_TOKEN``.  Tokens are never
accepted as command-line arguments, embedded in URLs, or written to output.
The currently published dataset is public, so anonymous download also works.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import urllib.request
from pathlib import Path


REPO_ID = "alibabagroup/SKYLENAGE-GameCodeGym"
DEFAULT_REVISION = "f675345c7f134ebde0fa63205e81771601ed41f9"
DATA_FILE = "pygame_seeds_2500_filtered.jsonl"
EXPECTED_SHA256 = "cb10c6943410e31c993573410e4834af35b7a86ba62f27bc74781b5b79047e69"


def download(*, output_dir: Path, revision: str = DEFAULT_REVISION) -> Path:
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / DATA_FILE
    url = f"https://huggingface.co/datasets/{REPO_ID}/resolve/{revision}/{DATA_FILE}"
    headers = {"User-Agent": "harness-game-vgamegym-downloader/1"}
    token = os.environ.get("HF_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    digest = hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=output_dir, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    handle.write(chunk)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    actual = digest.hexdigest()
    if revision == DEFAULT_REVISION and actual != EXPECTED_SHA256:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"dataset checksum mismatch: expected {EXPECTED_SHA256}, got {actual}")
    temporary.replace(target)
    provenance = {
        "repo_id": REPO_ID,
        "repo_type": "dataset",
        "revision": revision,
        "file": DATA_FILE,
        "sha256": actual,
        "credential_source": "HF_TOKEN environment or anonymous",
    }
    (output_dir / "provenance.json").write_text(
        json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("third_party/SKYLENAGE-GameCodeGym/gamegym_testset"),
    )
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    args = parser.parse_args(argv)
    path = download(output_dir=args.output_dir, revision=args.revision)
    print(f"Downloaded {REPO_ID}@{args.revision} to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
