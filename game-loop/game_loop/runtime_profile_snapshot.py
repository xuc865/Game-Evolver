from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any, Mapping

from game_loop.utils import atomic_write_json, sha256_json
from game_loop.subagent_prototype import (
    cordis_rows_for_subagent_prototypes,
    validate_subagent_prototype_spec,
)

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
    _validated_subagent_prototypes(captured)
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
            if field == "cordis":
                seed_target = asset_root / f"cordis_seed{''.join(source.suffixes)}"
                shutil.copy2(source, seed_target)
                snapshot["cordis_seed"] = str(seed_target)
        snapshot[field] = str(target)
    active_rows = _validated_cordis_plugins(snapshot)
    prototypes = _validated_subagent_prototypes(snapshot)
    prototype_rows = cordis_rows_for_subagent_prototypes(prototypes)
    if prototype_rows and "fork_context_subagent" not in set(
        snapshot.get("active_cordis_plugins", [])
    ):
        raise ValueError(
            "active_subagent_prototypes requires fork_context_subagent"
        )
    if active_rows or prototype_rows:
        cordis = snapshot.get("cordis")
        if cordis is None:
            raise ValueError("active_cordis_plugins requires a cordis seed asset")
        cordis_path = Path(str(cordis))
        if prototypes:
            _remove_legacy_subagent_tool_rows(cordis_path)
        _append_cordis_rows(cordis_path, (*active_rows, *prototype_rows))
        snapshot["effective_cordis_sha256"] = hash_path(cordis_path)
    snapshot_hash = sha256_json(snapshot)
    snapshot_path = root / f"profile-{snapshot_hash}.json"
    atomic_write_json(snapshot_path, snapshot)
    return snapshot_path, snapshot_hash


def materialize_role_cordis(
    *,
    seed: Path,
    destination: Path,
    plugin_catalog: Mapping[str, Any],
    active_plugins: tuple[str, ...],
) -> tuple[Path, str]:
    """Build one role-local Cordis from an immutable seed and audited catalog."""

    rows = _validated_cordis_plugins(
        {
            "cordis_plugin_catalog": plugin_catalog,
            "active_cordis_plugins": list(active_plugins),
        }
    )
    source = seed.expanduser().resolve()
    if not source.is_file():
        raise ValueError(f"role Cordis seed does not exist: {source}")
    target = destination.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    shutil.copy2(source, target)
    if rows:
        _append_cordis_rows(target, rows)
    return target, hash_path(target)


def _append_cordis_rows(
    cordis_path: Path,
    rows: tuple[dict[str, Any], ...],
) -> None:
    with cordis_path.open("a", encoding="utf-8") as handle:
        handle.write("\n# Content-addressed DSH plugin evolution overlay.\n")
        for row in rows:
            handle.write(f"- id: {json.dumps(row['id'])}\n")
            handle.write(f"  name: {json.dumps(row['name'])}\n")
            if row.get("config") is not None:
                config_json = json.dumps(
                    row["config"], sort_keys=True, separators=(",", ":")
                )
                handle.write(f"  config: {config_json}\n")


def _remove_legacy_subagent_tool_rows(cordis_path: Path) -> None:
    """Hide generic model-facing delegation when evolved targets are active."""

    lines = cordis_path.read_text(encoding="utf-8").splitlines(keepends=True)
    blocks: list[list[str]] = []
    prefix: list[str] = []
    current: list[str] | None = None
    for line in lines:
        if line.startswith("- id:"):
            if current is not None:
                blocks.append(current)
            current = [line]
        elif current is None:
            prefix.append(line)
        else:
            current.append(line)
    if current is not None:
        blocks.append(current)

    retained: list[list[str]] = []
    for block in blocks:
        text = "".join(block)
        if "@deepseek-ai/dsh-tool-subagent" in text:
            continue
        retained.append(block)
    cordis_path.write_text(
        "".join((*prefix, *(line for block in retained for line in block))),
        encoding="utf-8",
    )


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


def _validated_subagent_prototypes(
    profile: Mapping[str, Any],
) -> tuple[dict[str, Any], ...]:
    raw = profile.get("active_subagent_prototypes", [])
    if not isinstance(raw, list):
        raise ValueError("active_subagent_prototypes must be an object list")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, Mapping):
            raise ValueError("active_subagent_prototypes must be an object list")
        unexpected = sorted(
            set(item)
            - {
                "id",
                "description",
                "persona",
                "tool_filter",
                "max_tokens",
                "evolved_from",
                "merged_from",
                "derived_from",
                "variant",
                "inner_tags",
            }
        )
        if unexpected:
            raise ValueError(
                "unsupported active_subagent_prototype fields: "
                + ", ".join(unexpected)
            )
        prototype_id = str(item.get("id", "")).strip()
        if prototype_id in seen:
            raise ValueError(f"duplicate subagent prototype id: {prototype_id}")
        description = str(item.get("description", "")).strip()
        if not description:
            raise ValueError(
                f"subagent prototype {prototype_id!r} requires a description"
            )
        spec = validate_subagent_prototype_spec(
            {key: value for key, value in item.items() if key not in {"id", "description"}},
            prototype_id=prototype_id,
        )
        normalized.append({"id": prototype_id, "description": description, **spec})
        seen.add(prototype_id)
    return tuple(normalized)


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
