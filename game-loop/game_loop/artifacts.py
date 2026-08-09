from __future__ import annotations

import fnmatch
import hashlib
import os
import shutil
import tempfile
from pathlib import Path

from game_loop.core.models import ArtifactDescriptor, ArtifactRecord

from .utils import atomic_write_json, read_json, sha256_json


def _matches_pattern(relative: str, pattern: str) -> bool:
    if "**" in pattern:
        return fnmatch.fnmatch(relative, pattern)
    return fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(
        relative, f"**/{pattern}"
    )


def _ignored(relative: str, patterns: tuple[str, ...]) -> bool:
    return any(_matches_pattern(relative, pattern) for pattern in patterns)


def _iter_files(root: Path, ignore_patterns: tuple[str, ...]) -> list[tuple[str, bytes]]:
    entries: list[tuple[str, bytes]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if _ignored(relative, ignore_patterns):
            continue
        entries.append((relative, path.read_bytes()))
    return entries


def compute_hashes(
    source: Path,
    descriptor: ArtifactDescriptor,
) -> tuple[str, str, dict[str, str], int, int]:
    source = source.resolve()
    entries = _iter_files(source, descriptor.ignore_patterns)
    manifest = [{"path": relative, "hash": hashlib.sha256(data).hexdigest()} for relative, data in entries]
    payload_hash = sha256_json(manifest)
    total_bytes = sum(len(data) for _, data in entries)
    component_hashes: dict[str, str] = {}
    for name, patterns in descriptor.component_patterns.items():
        component_manifest = [
            {"path": relative, "hash": hashlib.sha256(data).hexdigest()}
            for relative, data in entries
            if any(_matches_pattern(relative, pattern) for pattern in patterns)
        ]
        component_hashes[name] = sha256_json(component_manifest)
    artifact_hash = sha256_json({
        "artifact_kind": descriptor.kind,
        "payload_hash": payload_hash,
        "component_hashes": component_hashes,
    })
    return artifact_hash, payload_hash, component_hashes, len(entries), total_bytes


def copy_artifact(source: Path, target: Path, descriptor: ArtifactDescriptor) -> Path:
    source = source.resolve()
    target = target.resolve()
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for relative, data in _iter_files(source, descriptor.ignore_patterns):
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    return target


class ArtifactStore:
    def __init__(self, root: Path, descriptor: ArtifactDescriptor):
        self.root = root.resolve()
        self.descriptor = descriptor
        self.root.mkdir(parents=True, exist_ok=True)

    def snapshot(self, source: Path) -> ArtifactRecord:
        artifact_hash, payload_hash, components, files, total = compute_hashes(
            source, self.descriptor
        )
        target = self.root / artifact_hash
        record_path = target / "record.json"
        if record_path.is_file():
            return ArtifactRecord.from_dict(read_json(record_path))
        temporary_root = self.root / ".tmp"
        temporary_root.mkdir(exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix=artifact_hash[:12], dir=temporary_root))
        try:
            copy_artifact(source, temporary / "artifact", self.descriptor)
            record = ArtifactRecord(
                artifact_id=artifact_hash,
                artifact_hash=artifact_hash,
                payload_hash=payload_hash,
                component_hashes=components,
                artifact_kind=self.descriptor.kind,
                file_count=files,
                total_bytes=total,
                relative_path=f"artifacts/{artifact_hash}/artifact",
            )
            atomic_write_json(temporary / "record.json", record.to_dict())
            try:
                os.replace(temporary, target)
            except FileExistsError:
                return ArtifactRecord.from_dict(read_json(record_path))
            return record
        finally:
            if temporary.exists():
                shutil.rmtree(temporary, ignore_errors=True)

    def path(self, artifact_id: str) -> Path:
        return (self.root / artifact_id / "artifact").resolve()

    def get(self, artifact_id: str) -> ArtifactRecord:
        return ArtifactRecord.from_dict(read_json(self.root / artifact_id / "record.json"))
