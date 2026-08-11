from __future__ import annotations

import os
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlparse

from game_loop.runtime.credentials import select_provider_api_key


@dataclass(frozen=True)
class BackboneProviderSpec:
    provider_id: str
    base_url: str
    model: str
    credential_envs: tuple[str, ...]
    base_url_env: str
    model_env: str
    official_docs: str
    requires_credential: bool = True
    allow_http: bool = False
    fallback_base_url: str | None = None
    fallback_model: str | None = None
    fallback_credential_envs: tuple[str, ...] = ()

    def resolve(self, environment: Mapping[str, str] | None = None) -> "ResolvedBackbone":
        env = os.environ if environment is None else environment
        credential_env = next((name for name in self.credential_envs if env.get(name)), None)
        pooled_api_key = select_provider_api_key(
            self.provider_id,
            env,
            salt=str(env.get("GAME_LOOP_PROVIDER_KEY_SALT", "")),
        )
        if pooled_api_key and env.get(f"CODEX_API_KEYS_{self.provider_id.upper()}"):
            credential_env = f"CODEX_API_KEYS_{self.provider_id.upper()}"
        # Backends historically use *_API_BASE while the provider registry
        # predates that convention and stores *_BASE_URL. Prefer the explicit
        # provider-specific API setting before the generic CODEX endpoint;
        # otherwise a GLM/Kimi/Qwen HTTP endpoint can accidentally replace the
        # DeepSeek rubric judge endpoint and make the judge look unready.
        provider_prefix = self.provider_id.upper()
        provider_base = (
            env.get(self.base_url_env)
            or env.get(f"{provider_prefix}_API_BASE")
            or env.get("CODEX_API_BASE")
            or self.base_url
        )
        provider_model = (
            env.get(self.model_env)
            or env.get(f"{provider_prefix}_API_MODEL")
            or env.get(f"{provider_prefix}_MODEL")
            or env.get("CODEX_MODEL")
            or self.model
        )
        return ResolvedBackbone(
            provider_id=self.provider_id,
            # Experiment backends historically expose CODEX_API_BASE/CODEX_MODEL.
            base_url=str(provider_base).rstrip("/"),
            model=str(provider_model),
            credential_env=credential_env,
            api_key=(
                pooled_api_key
                or (None if credential_env is None else str(env[credential_env]))
            ),
            official_docs=self.official_docs,
            requires_credential=self.requires_credential,
            allow_http=self.allow_http,
            fallback_base_url=(
                None
                if self.fallback_base_url is None
                else str(env.get(f"{self.provider_id.upper()}_FALLBACK_BASE_URL", self.fallback_base_url)).rstrip("/")
            ),
            fallback_model=(
                None
                if self.fallback_model is None
                else str(env.get(f"{self.provider_id.upper()}_FALLBACK_MODEL", self.fallback_model))
            ),
            fallback_credential_env=next(
                (name for name in self.fallback_credential_envs if env.get(name)), None
            ),
            fallback_api_key=(
                None
                if not next((name for name in self.fallback_credential_envs if env.get(name)), None)
                else str(env[next(name for name in self.fallback_credential_envs if env.get(name))])
            ),
        )


@dataclass(frozen=True)
class ResolvedBackbone:
    provider_id: str
    base_url: str
    model: str
    credential_env: str | None
    api_key: str | None
    official_docs: str
    requires_credential: bool
    allow_http: bool
    fallback_base_url: str | None = None
    fallback_model: str | None = None
    fallback_credential_env: str | None = None
    fallback_api_key: str | None = None

    def doctor(self) -> dict[str, object]:
        parsed = urlparse(self.base_url)
        endpoint_valid = bool(parsed.netloc) and (
            parsed.scheme == "https" or (self.allow_http and parsed.scheme == "http")
        )
        return {
            "provider_id": self.provider_id,
            "base_url": self.base_url,
            "model": self.model,
            "credential_env": self.credential_env,
            "accepted_credential_envs": list(
                PROVIDERS[self.provider_id].credential_envs
            ),
            "credential_present": self.api_key is not None,
            "credential_required": self.requires_credential,
            "endpoint_valid": endpoint_valid,
            "openai_compatible": True,
            "official_docs": self.official_docs,
            "ready": (
                (self.api_key is not None or not self.requires_credential)
                and endpoint_valid
                and bool(self.model)
            ),
        }

    def inject(self, environment: Mapping[str, str]) -> dict[str, str]:
        if self.api_key is None and self.requires_credential:
            expected = ", ".join(PROVIDERS[self.provider_id].credential_envs)
            raise RuntimeError(
                f"{self.provider_id} credential is missing; set one of: {expected}"
            )
        env = dict(environment)
        env.update({
            "OPENAI_API_KEY": self.api_key or "EMPTY",
            "OPENAI_BASE_URL": self.base_url,
            "OPENAI_MODEL": self.model,
        })
        return env

    def fallback_inject(self, environment: Mapping[str, str]) -> dict[str, str] | None:
        if not all((self.fallback_base_url, self.fallback_model, self.fallback_api_key)):
            return None
        env = dict(environment)
        env.update({
            "OPENAI_API_KEY": self.fallback_api_key,
            "OPENAI_BASE_URL": self.fallback_base_url,
            "OPENAI_MODEL": self.fallback_model,
        })
        return env


PROVIDERS: dict[str, BackboneProviderSpec] = {
    "deepseek": BackboneProviderSpec(
        "deepseek", "https://api.deepseek.com", "deepseek-v4-flash",
        ("DEEPSEEK_API_KEY",), "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
        "https://api-docs.deepseek.com/quick_start/pricing",
    ),
    "kimi": BackboneProviderSpec(
        "kimi", "http://29.116.237.135:8080/v1", "Kimi-K2.7-Code",
        ("MOONSHOT_API_KEY", "KIMI_API_KEY"), "KIMI_BASE_URL", "KIMI_MODEL",
        "deployment-provided OpenAI-compatible endpoint", False, True,
    ),
    "glm": BackboneProviderSpec(
        "glm", "http://11.213.4.72:80/v1", "GLM-5.2-W4AFP8",
        ("ZAI_API_KEY", "GLM_API_KEY", "BIGMODEL_API_KEY"), "GLM_BASE_URL", "GLM_MODEL",
        "deployment-provided OpenAI-compatible endpoint", False, True,
        "https://openrouter.ai/api/v1", "z-ai/glm-5.2", ("OPENROUTER_API_KEY",),
    ),
    "qwen": BackboneProviderSpec(
        "qwen", "http://29.163.228.59:8080/v1", "Qwen3.6-27B",
        ("DASHSCOPE_API_KEY", "QWEN_API_KEY"), "QWEN_BASE_URL", "QWEN_MODEL",
        "deployment-provided OpenAI-compatible endpoint", False, True,
        "https://openrouter.ai/api/v1", "qwen/qwen3.6-27b", ("OPENROUTER_API_KEY",),
    ),
    "claude": BackboneProviderSpec(
        "claude", "https://xmcode.shop/v1", "claude-sonnet-4-6",
        ("CODEX_API_KEY_CLAUDE", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"),
        "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
        "xmcode.shop Anthropic-compatible endpoint",
        True,
        False,
    ),
    "gpt55": BackboneProviderSpec(
        "gpt55", "https://xmcode.shop/v1", "gpt-5.5",
        ("CODEX_API_KEY_GPT55", "OPENAI_API_KEY"), "OPENAI_BASE_URL", "OPENAI_MODEL",
        "xmcode.shop OpenAI-compatible endpoint",
        True,
        False,
    ),
}


def load_provider(provider_id: str) -> BackboneProviderSpec:
    try:
        return PROVIDERS[provider_id.casefold()]
    except KeyError as exc:
        raise ValueError(
            f"unsupported backbone provider {provider_id!r}; expected one of {sorted(PROVIDERS)}"
        ) from exc


def doctor_all_providers(environment: Mapping[str, str] | None = None) -> list[dict[str, object]]:
    return [spec.resolve(environment).doctor() for spec in PROVIDERS.values()]


def smoke_provider(provider_id: str, *, timeout_seconds: int = 60) -> dict[str, object]:
    """Make one real, minimal Chat Completions request. Never returns the credential."""

    resolved = load_provider(provider_id).resolve()
    doctor = resolved.doctor()
    if not doctor["ready"]:
        return {**doctor, "real_request": False, "ok": False, "error": "provider is not ready"}
    payload_body: dict[str, object] = {
        "model": resolved.model,
        "messages": [{"role": "user", "content": "Reply with exactly OK."}],
        "max_tokens": 32,
        "stream": False,
    }
    if "qwen" in resolved.model.casefold() or "glm" in resolved.model.casefold():
        payload_body["chat_template_kwargs"] = {"enable_thinking": False}
    payload = json.dumps(payload_body).encode("utf-8")
    request = urllib.request.Request(
        resolved.base_url + "/chat/completions",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {resolved.api_key or 'EMPTY'}",
            "Content-Type": "application/json",
            "User-Agent": "game-loop/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            status = int(response.status)
            value = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {
            **doctor,
            "real_request": True,
            "ok": False,
            "error": str(exc),
        }
    choices = value.get("choices", []) if isinstance(value, dict) else []
    content = ""
    if choices and isinstance(choices[0], dict):
        message = choices[0].get("message", {})
        if isinstance(message, dict):
            # Reasoning deployments may spend a very small smoke budget before
            # emitting normal content. Keep the diagnostic useful without
            # interpreting a null value as the literal string "None".
            raw_content = message.get("content") or message.get("reasoning_content") or ""
            content = str(raw_content)
    return {
        **doctor,
        "real_request": True,
        "ok": status == 200 and bool(choices),
        "http_status": status,
        "response_id": value.get("id") if isinstance(value, dict) else None,
        "response_model": value.get("model") if isinstance(value, dict) else None,
        "response_text": content[:200],
    }
