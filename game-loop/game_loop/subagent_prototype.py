from __future__ import annotations

import hashlib
import re
from typing import Any, Mapping


_PROTOTYPE_ID = re.compile(r"[a-z][a-z0-9_]{0,63}")
_FORBIDDEN_POLICY_FIELDS = frozenset({
    "provider",
    "enableRunInBackground",
    "enable_run_in_background",
    "backgroundMode",
    "background_mode",
    "maxDepth",
    "max_depth",
    "communication",
    "inheritsParentContext",
    "inherits_parent_context",
})
_ALLOWED_FIELDS = frozenset({
    "persona",
    "tool_filter",
    "max_tokens",
    "evolved_from",
    "merged_from",
    "derived_from",
    "variant",
    "inner_tags",
})


def validate_subagent_prototype_spec(
    spec: Mapping[str, Any],
    *,
    prototype_id: str | None = None,
) -> dict[str, Any]:
    """Validate behavior-only child genes; fork mechanics are runtime policy."""

    if prototype_id is not None and _PROTOTYPE_ID.fullmatch(prototype_id) is None:
        raise ValueError(f"invalid subagent prototype id: {prototype_id!r}")
    forbidden = sorted(set(spec) & _FORBIDDEN_POLICY_FIELDS)
    if forbidden:
        raise ValueError(
            "subagent prototypes may evolve child behavior, not fork policy: "
            + ", ".join(forbidden)
        )
    unexpected = sorted(set(spec) - _ALLOWED_FIELDS)
    if unexpected:
        raise ValueError(
            "unsupported subagent prototype fields: " + ", ".join(unexpected)
        )
    persona = str(spec.get("persona", "")).strip()
    if not persona:
        raise ValueError("subagent prototype persona is required")
    if len(persona) > 12_000:
        raise ValueError("subagent prototype persona exceeds 12000 characters")
    root_ownership_claims = (
        "you are the singleton",
        "you are the root",
        "owns all artifact writes",
        "write the final artifact yourself",
        "own the final delivery",
    )
    if any(claim in persona.casefold() for claim in root_ownership_claims):
        raise ValueError(
            "subagent prototype persona is injected into a child and may not claim "
            "root workspace or final-delivery ownership"
        )

    normalized: dict[str, Any] = {"persona": persona}
    tool_filter = spec.get("tool_filter")
    if tool_filter is not None:
        if not isinstance(tool_filter, Mapping):
            raise ValueError("subagent prototype tool_filter must be an object")
        unknown_filter_keys = sorted(set(tool_filter) - {"allow", "deny"})
        if unknown_filter_keys:
            raise ValueError(
                "unsupported subagent tool_filter fields: "
                + ", ".join(unknown_filter_keys)
            )
        if "allow" in tool_filter and "deny" in tool_filter:
            raise ValueError("subagent tool_filter must use allow or deny, not both")
        normalized_filter: dict[str, list[str]] = {}
        for key in ("allow", "deny"):
            if key not in tool_filter:
                continue
            values = tool_filter[key]
            if not isinstance(values, list) or not all(
                isinstance(item, str) and item.strip() for item in values
            ):
                raise ValueError(f"subagent tool_filter.{key} must be a string list")
            normalized_filter[key] = list(dict.fromkeys(item.strip() for item in values))
        if not normalized_filter:
            raise ValueError("subagent tool_filter must contain allow or deny")
        normalized["tool_filter"] = normalized_filter

    if spec.get("max_tokens") is not None:
        max_tokens = int(spec["max_tokens"])
        if not 256 <= max_tokens <= 131_072:
            raise ValueError("subagent prototype max_tokens must be within 256..131072")
        normalized["max_tokens"] = max_tokens

    for field in (
        "evolved_from",
        "merged_from",
        "derived_from",
        "variant",
        "inner_tags",
    ):
        if field in spec:
            normalized[field] = spec[field]
    return normalized


def cordis_rows_for_subagent_prototypes(
    prototypes: tuple[dict[str, Any], ...],
) -> tuple[dict[str, Any], ...]:
    """Compile active child genomes into distinct tools on one fixed fork provider."""

    rows: list[dict[str, Any]] = []
    for prototype in prototypes:
        prototype_id = str(prototype["id"])
        spec = validate_subagent_prototype_spec(
            {
                key: value
                for key, value in prototype.items()
                if key not in {"id", "description"}
            },
            prototype_id=prototype_id,
        )
        digest = hashlib.sha256(prototype_id.encode("utf-8")).hexdigest()[:10]
        slug = prototype_id.replace("_", "-")[:32].rstrip("-")
        row_suffix = f"{slug}-{digest}"
        tool_slug = prototype_id[:40].rstrip("_")
        config: dict[str, Any] = {
            "provider": "fork",
            "toolName": f"fork_agent_{tool_slug}_{digest}",
            "enableRunInBackground": False,
            "maxDepth": 2,
            "persona": spec["persona"],
        }
        if "tool_filter" in spec:
            config["toolFilter"] = spec["tool_filter"]
        if "max_tokens" in spec:
            config["agentOptions"] = {"maxTokens": spec["max_tokens"]}
        rows.append({
            "id": f"evolved-fork-prototype-{row_suffix}",
            "name": "@deepseek-ai/dsh-tool-subagent",
            "config": config,
        })
    return tuple(rows)
