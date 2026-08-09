#!/usr/bin/env python3

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Optional


# Token pricing per 1M tokens (USD).
# Prices are matched by substring, in order, and reflect standard API rates.
# Sources used when updating this table on 2026-04-19:
# - OpenAI pricing: https://developers.openai.com/api/docs/pricing
# - Google Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
MODEL_PRICING = [
    # Anthropic Claude
    ("claude-sonnet-4-20250514", {"input": 3.00, "cached_input": 3.00, "output": 15.00}),
    ("claude-3-5-sonnet", {"input": 3.00, "cached_input": 3.00, "output": 15.00}),
    ("claude-3-opus", {"input": 15.00, "cached_input": 15.00, "output": 75.00}),
    ("claude-3-haiku", {"input": 0.25, "cached_input": 0.25, "output": 1.25}),
    # OpenAI Codex / GPT
    ("gpt-5.3-codex", {"input": 1.75, "cached_input": 0.175, "output": 14.00}),
    ("gpt-5.2-codex", {"input": 1.75, "cached_input": 0.175, "output": 14.00}),
    ("gpt-5.1-codex-max", {"input": 1.25, "cached_input": 0.125, "output": 10.00}),
    ("gpt-5.1-codex", {"input": 1.25, "cached_input": 0.125, "output": 10.00}),
    ("gpt-5-codex", {"input": 1.25, "cached_input": 0.125, "output": 10.00}),
    ("gpt-5.4", {"input": 2.50, "cached_input": 0.25, "output": 15.00}),
    ("gpt-5.2", {"input": 1.75, "cached_input": 0.175, "output": 14.00}),
    ("gpt-5.1", {"input": 1.25, "cached_input": 0.125, "output": 10.00}),
    ("gpt-5", {"input": 1.25, "cached_input": 0.125, "output": 10.00}),
    ("gpt-4o-mini", {"input": 0.15, "cached_input": 0.075, "output": 0.60}),
    ("gpt-4o", {"input": 2.50, "cached_input": 1.25, "output": 10.00}),
    ("gpt-4-turbo", {"input": 10.00, "cached_input": 10.00, "output": 30.00}),
    ("gpt-4", {"input": 30.00, "cached_input": 30.00, "output": 60.00}),
    ("o1-mini", {"input": 3.00, "cached_input": 3.00, "output": 12.00}),
    ("o1", {"input": 15.00, "cached_input": 15.00, "output": 60.00}),
    ("codex", {"input": 1.25, "cached_input": 0.125, "output": 10.00}),
    # Google Gemini
    ("gemini-3.1-pro-preview", {"input": 2.00, "cached_input": 0.20, "output": 12.00}),
    ("gemini-3-pro-preview", {"input": 2.00, "cached_input": 0.20, "output": 12.00}),
    ("gemini-3.1-flash-lite-preview", {"input": 0.25, "cached_input": 0.025, "output": 1.50}),
    ("gemini-3.1-flash-preview", {"input": 0.50, "cached_input": 0.05, "output": 3.00}),
    ("gemini-3-flash-preview", {"input": 0.50, "cached_input": 0.05, "output": 3.00}),
    ("gemini-2.5-pro", {"input": 1.25, "cached_input": 0.125, "output": 10.00}),
    ("gemini-2.5-flash", {"input": 0.30, "cached_input": 0.03, "output": 2.50}),
    ("gemini-2.5-flash-lite", {"input": 0.10, "cached_input": 0.01, "output": 0.40}),
    # Default fallback
    ("default", {"input": 3.00, "cached_input": 3.00, "output": 15.00}),
]


@dataclass
class TokenUsage:
    """Container for token usage statistics."""

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def calculate_cost(self, model: str) -> float:
        """Calculate cost in USD based on model pricing."""
        model_lower = model.lower()
        pricing = next(
            (rates for key, rates in MODEL_PRICING if key != "default" and key in model_lower),
            next(rates for key, rates in MODEL_PRICING if key == "default"),
        )

        cached_input_tokens = max(0, min(self.cache_read_tokens, self.input_tokens))
        uncached_input_tokens = max(0, self.input_tokens - cached_input_tokens)

        input_cost = (uncached_input_tokens / 1_000_000) * pricing["input"]
        input_cost += (cached_input_tokens / 1_000_000) * pricing["cached_input"]
        output_cost = (self.output_tokens / 1_000_000) * pricing["output"]

        return input_cost + output_cost

    def to_dict(self) -> Dict:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
        }


@dataclass
class ValidationResult:
    """Container for validation test results."""

    success: bool
    message: str
    details: Optional[Dict] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "success": self.success,
            "message": self.message,
            "details": self.details,
            "timestamp": self.timestamp,
        }

    def __str__(self) -> str:
        status = "PASSED" if self.success else "FAILED"
        return f"{status}: {self.message}"


@dataclass
class SolverResult:
    """Container for solver results with token usage tracking."""

    success: bool
    message: str
    duration_seconds: float
    stdout: str = ""
    stderr: str = ""
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    is_rate_limited: bool = False  # Flag for API quota/rate limit errors
    token_usage: Optional[TokenUsage] = None  # Token usage statistics
    model: str = ""  # Model used for this run
    cost_usd: float = 0.0  # Calculated cost in USD

    def calculate_cost(self) -> float:
        """Calculate and store the cost based on token usage."""
        if self.token_usage and self.model:
            self.cost_usd = self.token_usage.calculate_cost(self.model)
        return self.cost_usd

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        result = {
            "success": self.success,
            "message": self.message,
            "duration_seconds": self.duration_seconds,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "timestamp": self.timestamp,
            "is_rate_limited": self.is_rate_limited,
            "model": self.model,
            "cost_usd": self.cost_usd,
        }
        if self.token_usage:
            result["token_usage"] = self.token_usage.to_dict()
        return result

    def __str__(self) -> str:
        status = "COMPLETED" if self.success else "FAILED"
        token_info = ""
        if self.token_usage:
            token_info = f", tokens: {self.token_usage.total_tokens}, cost: ${self.cost_usd:.4f}"
        return f"{status}: {self.message} (took {self.duration_seconds:.2f}s{token_info})"
