from __future__ import annotations

import os
import re
import zlib
from typing import Mapping


def provider_api_keys(
    provider: str,
    environment: Mapping[str, str] | None = None,
) -> list[str]:
    env = os.environ if environment is None else environment
    provider = provider.casefold()
    if provider in {"gpt55", "gpt-5.5"}:
        primary = env.get("CODEX_API_KEY_GPT55", "") or env.get("OPENAI_API_KEY", "")
        raw_pool = env.get("CODEX_API_KEYS_GPT55", "")
    elif provider == "claude":
        primary = (
            env.get("CODEX_API_KEY_CLAUDE", "")
            or env.get("ANTHROPIC_AUTH_TOKEN", "")
            or env.get("ANTHROPIC_API_KEY", "")
        )
        raw_pool = env.get("CODEX_API_KEYS_CLAUDE", "")
    else:
        return []

    keys: list[str] = []
    for candidate in [primary, *re.split(r"[,\s]+", raw_pool.strip())]:
        if candidate and candidate not in keys:
            keys.append(candidate)
    return keys


def provider_key_start_index(
    provider: str,
    keys: list[str],
    *,
    salt: str = "",
    environment: Mapping[str, str] | None = None,
) -> int:
    if not keys:
        return 0
    env = os.environ if environment is None else environment
    explicit = env.get("GAME_LOOP_CHAT_API_KEY_OFFSET", "").strip()
    if explicit:
        try:
            return int(explicit) % len(keys)
        except ValueError:
            pass
    identity = f"{provider.casefold()}:{os.getpid()}:{salt}".encode("utf-8")
    return zlib.crc32(identity) % len(keys)


def select_provider_api_key(
    provider: str,
    environment: Mapping[str, str] | None = None,
    *,
    salt: str = "",
) -> str:
    keys = provider_api_keys(provider, environment)
    return keys[provider_key_start_index(provider, keys, salt=salt, environment=environment)] if keys else ""
