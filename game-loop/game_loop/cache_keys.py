from __future__ import annotations

import os
import secrets
import string
from collections.abc import Mapping


CACHE_KEY_PREFIXES = ("scene", "ui", "coding", "player", "reviewer", "master")
_CACHE_KEY_SUFFIX_ALPHABET = string.ascii_letters + string.digits


def build_cache_key_headers(
    *,
    env: Mapping[str, str] | None = None,
    default_key: str = "",
    default_header: str = "X-Cache-Key",
    default_mode: str = "static",
) -> dict[str, str]:
    values = os.environ if env is None else env
    header = values.get("CODEX_CACHE_KEY_HEADER", default_header).strip()
    if not header:
        return {}

    mode = values.get("CODEX_CACHE_KEY_MODE", default_mode).strip().casefold()
    if mode == "random":
        prefix = secrets.choice(CACHE_KEY_PREFIXES)
        suffix = "".join(secrets.choice(_CACHE_KEY_SUFFIX_ALPHABET) for _ in range(8))
        return {header: f"{prefix}-harness:{suffix}"}

    key = values.get("CODEX_CACHE_KEY", default_key).strip()
    return {header: key} if key else {}
