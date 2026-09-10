"""Small, typed model gateway used by the VibeGame agent harness.

The gateway keeps native OpenAI Responses, Anthropic Messages, Gemini
generateContent, and OpenAI-compatible chat routes separate. This prevents a
provider-specific payload from leaking into another API while presenting one
result contract to the orchestrator.
"""

from __future__ import annotations

import base64
import mimetypes
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import requests


@dataclass(frozen=True)
class ProviderConfig:
    provider: str
    base_url: str
    model: str
    api_key: str = ""
    api_style: str = "openai_chat"
    timeout_seconds: int = 180

    @classmethod
    def from_env(cls, provider: str, env: Mapping[str, str] | None = None) -> "ProviderConfig":
        values = os.environ if env is None else env
        key = provider.upper().replace("-", "_")
        defaults = {
            "openai": ("https://api.openai.com/v1", "gpt-5.5", "responses", "OPENAI_API_KEY"),
            "anthropic": ("https://api.anthropic.com/v1", "claude-sonnet-4-6", "anthropic", "ANTHROPIC_API_KEY"),
            "gemini": ("https://generativelanguage.googleapis.com/v1beta", "gemini-2.5-pro", "gemini", "GEMINI_API_KEY"),
            "deepseek": ("https://api.deepseek.com/v1", "deepseek-chat", "openai_chat", "DEEPSEEK_API_KEY"),
            "glm": ("http://11.213.4.72:80/v1", "GLM-5.3-Flash-node1", "openai_chat", "GLM_API_KEY"),
            "qwen": ("http://29.116.237.141:8080/v1", "Qwen3.8-27B-node1", "openai_chat", "DASHSCOPE_API_KEY"),
        }
        if provider not in defaults:
            raise ValueError(f"unsupported model provider {provider!r}")
        base, model, style, credential = defaults[provider]
        return cls(
            provider=provider,
            base_url=values.get(f"{key}_BASE_URL", base).rstrip("/"),
            model=values.get(f"{key}_MODEL", model),
            api_key=values.get(credential, values.get(f"{key}_API_KEY", "")),
            api_style=values.get(f"{key}_API_STYLE", style),
            timeout_seconds=int(values.get(f"{key}_TIMEOUT_SECONDS", "180")),
        )


@dataclass(frozen=True)
class ModelRequest:
    prompt: str
    instructions: str = ""
    images: tuple[str, ...] = ()
    max_output_tokens: int = 4096
    temperature: float | None = None
    response_schema: dict[str, Any] | None = None


@dataclass(frozen=True)
class ModelResult:
    ok: bool
    text: str = ""
    error: str = ""
    request_id: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    elapsed: float = 0.0
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


def _data_url(path: str) -> str:
    value = Path(path)
    mime = mimetypes.guess_type(value.name)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(value.read_bytes()).decode()}"


def _openai_content(request: ModelRequest) -> str | list[dict[str, Any]]:
    if not request.images:
        return request.prompt
    content: list[dict[str, Any]] = [{"type": "input_text", "text": request.prompt}]
    content.extend({"type": "input_image", "image_url": _data_url(path)} for path in request.images)
    return content


class ModelGateway:
    def __init__(self, config: ProviderConfig, session: requests.Session | None = None):
        self.config = config
        self.session = session or requests.Session()

    def generate(self, request: ModelRequest) -> ModelResult:
        started = time.monotonic()
        try:
            if self.config.api_style == "responses":
                response = self._responses(request)
            elif self.config.api_style == "anthropic":
                response = self._anthropic(request)
            elif self.config.api_style == "gemini":
                response = self._gemini(request)
            elif self.config.api_style == "openai_chat":
                response = self._openai_chat(request)
            else:
                raise ValueError(f"unsupported API style {self.config.api_style!r}")
            elapsed = time.monotonic() - started
            if response.status_code >= 400:
                return ModelResult(
                    False,
                    error=f"HTTP {response.status_code}: {response.text[:800]}",
                    request_id=response.headers.get("x-request-id", ""),
                    elapsed=elapsed,
                )
            data = response.json()
            text = self._extract(data)
            if not text:
                return ModelResult(False, error="provider returned no text", elapsed=elapsed, raw=data)
            return ModelResult(
                True,
                text=text,
                request_id=response.headers.get("x-request-id", ""),
                usage=data.get("usage", {}) if isinstance(data, dict) else {},
                elapsed=elapsed,
                raw=data,
            )
        except (OSError, ValueError, requests.RequestException) as exc:
            return ModelResult(False, error=str(exc), elapsed=time.monotonic() - started)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.config.api_key or 'EMPTY'}",
            "Content-Type": "application/json",
            "User-Agent": "game-evolver-vibegame/1.0",
        }

    def _responses(self, request: ModelRequest):
        payload: dict[str, Any] = {
            "model": self.config.model,
            "input": [{"role": "user", "content": _openai_content(request)}],
            "max_output_tokens": request.max_output_tokens,
        }
        if request.instructions:
            payload["instructions"] = request.instructions
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.response_schema:
            payload["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "vibegame_result",
                    "strict": True,
                    "schema": request.response_schema,
                }
            }
        return self.session.post(
            f"{self.config.base_url}/responses",
            headers=self._headers(), json=payload, timeout=self.config.timeout_seconds,
        )

    def _openai_chat(self, request: ModelRequest):
        messages: list[dict[str, Any]] = []
        if request.instructions:
            messages.append({"role": "system", "content": request.instructions})
        content: Any = request.prompt
        if request.images:
            content = [{"type": "text", "text": request.prompt}]
            content.extend(
                {"type": "image_url", "image_url": {"url": _data_url(path)}}
                for path in request.images
            )
        messages.append({"role": "user", "content": content})
        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "max_tokens": request.max_output_tokens,
            "stream": False,
        }
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.response_schema:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "vibegame_result", "strict": True, "schema": request.response_schema},
            }
        return self.session.post(
            f"{self.config.base_url}/chat/completions",
            headers=self._headers(), json=payload, timeout=self.config.timeout_seconds,
        )

    def _anthropic(self, request: ModelRequest):
        content: list[dict[str, Any]] = []
        for path in request.images:
            value = Path(path)
            mime = mimetypes.guess_type(value.name)[0] or "image/png"
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(value.read_bytes()).decode()},
            })
        content.append({"type": "text", "text": request.prompt})
        payload: dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": request.max_output_tokens,
            "messages": [{"role": "user", "content": content}],
        }
        if request.instructions:
            payload["system"] = request.instructions
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        headers = {
            "x-api-key": self.config.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            "User-Agent": "game-evolver-vibegame/1.0",
        }
        return self.session.post(
            f"{self.config.base_url}/messages",
            headers=headers, json=payload, timeout=self.config.timeout_seconds,
        )

    def _gemini(self, request: ModelRequest):
        parts: list[dict[str, Any]] = [{"text": request.prompt}]
        for path in request.images:
            value = Path(path)
            parts.append({"inline_data": {
                "mime_type": mimetypes.guess_type(value.name)[0] or "image/png",
                "data": base64.b64encode(value.read_bytes()).decode(),
            }})
        payload: dict[str, Any] = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"maxOutputTokens": request.max_output_tokens},
        }
        if request.instructions:
            payload["systemInstruction"] = {"parts": [{"text": request.instructions}]}
        if request.temperature is not None:
            payload["generationConfig"]["temperature"] = request.temperature
        return self.session.post(
            f"{self.config.base_url}/models/{self.config.model}:generateContent",
            params={"key": self.config.api_key},
            headers={"Content-Type": "application/json", "User-Agent": "game-evolver-vibegame/1.0"},
            json=payload,
            timeout=self.config.timeout_seconds,
        )

    def _extract(self, data: dict[str, Any]) -> str:
        style = self.config.api_style
        if style == "responses":
            if isinstance(data.get("output_text"), str):
                return data["output_text"]
            texts = []
            for item in data.get("output", []):
                for content in item.get("content", []):
                    if content.get("type") == "output_text":
                        texts.append(content.get("text", ""))
            return "\n".join(filter(None, texts))
        if style == "anthropic":
            return "\n".join(
                item.get("text", "") for item in data.get("content", []) if item.get("type") == "text"
            )
        if style == "gemini":
            candidates = data.get("candidates", [])
            if not candidates:
                return ""
            return "\n".join(part.get("text", "") for part in candidates[0].get("content", {}).get("parts", []))
        choices = data.get("choices", [])
        return str(choices[0].get("message", {}).get("content") or "") if choices else ""
