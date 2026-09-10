"""Model provider diagnostics for the VibeGame harness."""

from __future__ import annotations

import json

import typer

from model_gateway import ModelGateway, ModelRequest, ProviderConfig


model_app = typer.Typer(no_args_is_help=True, help="Inspect and smoke-test model providers")
PROVIDER_IDS = ("openai", "anthropic", "gemini", "deepseek", "glm", "qwen")


def _masked(value: str) -> str:
    return "configured" if value else "missing"


@model_app.command("list")
def list_models() -> None:
    """Print resolved routes without revealing credentials."""
    rows = []
    for provider in PROVIDER_IDS:
        cfg = ProviderConfig.from_env(provider)
        rows.append({
            "provider": provider,
            "api_style": cfg.api_style,
            "base_url": cfg.base_url,
            "model": cfg.model,
            "credential": _masked(cfg.api_key),
        })
    print(json.dumps(rows, ensure_ascii=False, indent=2))


@model_app.command("smoke")
def smoke(
    provider: str = typer.Argument(..., help=f"One of: {', '.join(PROVIDER_IDS)}"),
) -> None:
    """Make one minimal real request to a configured provider."""
    provider = provider.casefold()
    if provider not in PROVIDER_IDS:
        raise typer.BadParameter(f"expected one of {', '.join(PROVIDER_IDS)}")
    cfg = ProviderConfig.from_env(provider)
    if not cfg.api_key and provider not in {"glm", "qwen"}:
        print(json.dumps({"ok": False, "provider": provider, "error": "credential missing"}))
        raise typer.Exit(2)
    # Reasoning-capable OpenAI-compatible deployments may consume their first
    # few dozen tokens in a separate reasoning field before emitting content.
    result = ModelGateway(cfg).generate(ModelRequest("Reply with exactly OK.", max_output_tokens=128))
    print(json.dumps({
        "ok": result.ok,
        "provider": provider,
        "model": cfg.model,
        "text": result.text[:120],
        "error": result.error[:500],
        "request_id": result.request_id,
        "elapsed": round(result.elapsed, 3),
    }, ensure_ascii=False))
    raise typer.Exit(0 if result.ok else 1)


@model_app.command("ask")
def ask(
    provider: str = typer.Argument(..., help=f"One of: {', '.join(PROVIDER_IDS)}"),
    prompt: str = typer.Option(..., "--prompt", help="Question for the advisory model"),
) -> None:
    """Ask one configured advisory model and print only its response text."""
    provider = provider.casefold()
    if provider not in PROVIDER_IDS:
        raise typer.BadParameter(f"expected one of: {', '.join(PROVIDER_IDS)}")
    result = ModelGateway(ProviderConfig.from_env(provider)).generate(
        ModelRequest(prompt, max_output_tokens=2048)
    )
    if not result.ok:
        print(result.error)
        raise typer.Exit(1)
    print(result.text)
