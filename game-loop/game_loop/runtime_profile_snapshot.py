from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any, Mapping

from game_loop.utils import atomic_write_json, sha256_json

ASSET_FIELDS = ("cordis", "skills_source", "system_prompt_path", "runtime_bin")
MATERIALIZED_FIELDS = {"cordis", "skills_source", "system_prompt_path"}
_PLUGIN_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
_PACKAGE_NAME = re.compile(r"@deepseek-ai/dsh-[a-z0-9][a-z0-9-]*")


def capture_runtime_profile(
    path: Path,
) -> tuple[dict[str, Any], str, dict[str, dict[str, str]]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("backend.runtime_profile must contain a JSON object")
    captured = dict(value)
    _validated_cordis_plugins(captured)
    assets: dict[str, dict[str, str]] = {}
    for field in ASSET_FIELDS:
        raw = captured.get(field)
        if raw is None:
            continue
        asset = Path(str(raw)).expanduser()
        if not asset.is_absolute():
            asset = path.parent / asset
        asset = asset.resolve()
        if not asset.exists():
            raise ValueError(f"runtime profile {field} does not exist: {asset}")
        captured[field] = str(asset)
        assets[field] = {"path": str(asset), "sha256": hash_path(asset)}
    fingerprint_profile = dict(captured)
    for field, metadata in assets.items():
        fingerprint_profile[field] = {"sha256": metadata["sha256"]}
    bundle_hash = sha256_json({"profile": fingerprint_profile})
    return captured, bundle_hash, assets


def materialize_runtime_profile(
    *,
    profile: Mapping[str, Any],
    assets: Mapping[str, Mapping[str, str]],
    destination: Path,
) -> tuple[Path, str]:
    root = destination.resolve()
    root.mkdir(parents=True, exist_ok=False)
    snapshot = dict(profile)
    asset_root = root / "assets"
    for field, metadata in assets.items():
        source = Path(metadata["path"])
        actual = hash_path(source)
        if actual != metadata["sha256"]:
            raise RuntimeError(
                f"runtime profile asset changed after configuration load: {field} ({source})"
            )
        if field not in MATERIALIZED_FIELDS:
            continue
        target = asset_root / (
            field if source.is_dir() else f"{field}{''.join(source.suffixes)}"
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
        snapshot[field] = str(target)
    active_rows = _validated_cordis_plugins(snapshot)
    if active_rows:
        cordis = snapshot.get("cordis")
        if cordis is None:
            raise ValueError("active_cordis_plugins requires a cordis seed asset")
        cordis_path = Path(str(cordis))
        with cordis_path.open("a", encoding="utf-8") as handle:
            handle.write("\n# Content-addressed DSH plugin evolution overlay.\n")
            for row in active_rows:
                handle.write(f"- id: {json.dumps(row['id'])}\n")
                handle.write(f"  name: {json.dumps(row['name'])}\n")
                if row.get("config") is not None:
                    config_json = json.dumps(
                        row["config"], sort_keys=True, separators=(",", ":")
                    )
                    handle.write(f"  config: {config_json}\n")
        snapshot["effective_cordis_sha256"] = hash_path(cordis_path)
    snapshot_hash = sha256_json(snapshot)
    snapshot_path = root / f"profile-{snapshot_hash}.json"
    atomic_write_json(snapshot_path, snapshot)
    return snapshot_path, snapshot_hash


def _validated_cordis_plugins(profile: Mapping[str, Any]) -> tuple[dict[str, Any], ...]:
    raw_catalog = profile.get("cordis_plugin_catalog", {})
    raw_active = profile.get("active_cordis_plugins", [])
    if not isinstance(raw_catalog, Mapping):
        raise ValueError("cordis_plugin_catalog must be an object")
    if not isinstance(raw_active, list) or not all(
        isinstance(item, str) for item in raw_active
    ):
        raise ValueError("active_cordis_plugins must be a string list")
    active = tuple(dict.fromkeys(item.strip() for item in raw_active if item.strip()))
    unknown = sorted(set(active) - {str(key) for key in raw_catalog})
    if unknown:
        raise ValueError(f"active_cordis_plugins references unknown plugins: {unknown}")

    rows: list[dict[str, Any]] = []
    seen_row_ids: set[str] = set()
    for plugin_id in active:
        if _PLUGIN_ID.fullmatch(plugin_id) is None:
            raise ValueError(f"invalid Cordis plugin feature id: {plugin_id!r}")
        raw_rows = raw_catalog[plugin_id]
        if not isinstance(raw_rows, list) or not raw_rows:
            raise ValueError(f"Cordis plugin feature {plugin_id!r} must contain rows")
        for raw_row in raw_rows:
            if not isinstance(raw_row, Mapping):
                raise ValueError(f"Cordis plugin feature {plugin_id!r} row must be an object")
            unexpected = sorted(set(raw_row) - {"id", "name", "config"})
            if unexpected:
                raise ValueError(
                    f"Cordis plugin feature {plugin_id!r} has unsupported row keys: {unexpected}"
                )
            row_id = str(raw_row.get("id", ""))
            package = str(raw_row.get("name", ""))
            if not row_id.startswith("evolved-") or _PLUGIN_ID.fullmatch(row_id) is None:
                raise ValueError(
                    f"Cordis plugin row id must use the evolved- namespace: {row_id!r}"
                )
            if _PACKAGE_NAME.fullmatch(package) is None:
                raise ValueError(f"unsupported Cordis plugin package: {package!r}")
            if row_id in seen_row_ids:
                raise ValueError(f"duplicate active Cordis plugin row id: {row_id}")
            config = raw_row.get("config")
            if config is not None and not isinstance(config, Mapping):
                raise ValueError(f"Cordis plugin row {row_id!r} config must be an object")
            normalized = {"id": row_id, "name": package}
            if config is not None:
                normalized["config"] = dict(config)
            # Reject non-JSON types before they can reach YAML generation.
            json.dumps(normalized, sort_keys=True, allow_nan=False)
            rows.append(normalized)
            seen_row_ids.add(row_id)
    return tuple(rows)


def hash_path(path: Path) -> str:
    digest = hashlib.sha256()
    paths = [path] if path.is_file() else sorted(path.rglob("*"))
    for item in paths:
        relative = Path(item.name) if path.is_file() else item.relative_to(path)
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        if item.is_symlink():
            digest.update(b"link\0")
            digest.update(str(item.readlink()).encode("utf-8"))
            resolved = item.resolve()
            if resolved.is_dir():
                raise ValueError(
                    f"runtime profile assets cannot contain directory symlinks: {item}"
                )
            if resolved.is_file():
                with resolved.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
        elif item.is_file():
            with item.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        elif item.is_dir():
            digest.update(b"dir")
        digest.update(b"\0")
    return digest.hexdigest()
