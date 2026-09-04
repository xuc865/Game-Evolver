from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ContextCompactionPolicy:
    """Fixed preflight compaction thresholds for long game-evolution runs."""

    clearing_trigger_chars: int = 560_000
    clearing_target_chars: int = 430_000
    clear_at_least_chars: int = 90_000
    collapse_trigger_chars: int = 900_000
    hard_max_request_chars: int = 1_200_000
    keep_recent_messages: int = 24
    keep_recent_tool_results: int = 8
    recent_tool_result_max_chars: int = 96_000
    message_max_chars: int = 180_000


@dataclass
class ContextCompactionStats:
    enabled: bool = True
    messages_before: int = 0
    messages_after: int = 0
    tool_results_pruned: int = 0
    tool_results_folded: int = 0
    messages_folded: int = 0
    oversize_messages_pruned: int = 0
    chars_before: int = 0
    chars_after: int = 0
    chars_saved: int = 0
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "messages_before": self.messages_before,
            "messages_after": self.messages_after,
            "tool_results_pruned": self.tool_results_pruned,
            "tool_results_folded": self.tool_results_folded,
            "messages_folded": self.messages_folded,
            "oversize_messages_pruned": self.oversize_messages_pruned,
            "chars_before": self.chars_before,
            "chars_after": self.chars_after,
            "chars_saved": self.chars_saved,
            "notes": list(self.notes),
        }


def compact_messages_for_api(
    messages: list[dict[str, Any]],
    *,
    policy: ContextCompactionPolicy | None = None,
    max_history_messages: int = 0,
) -> tuple[list[dict[str, Any]], ContextCompactionStats]:
    """Compact OpenAI-compatible message history before it reaches a model.

    The policy mirrors Claude Code's practical shape without relying on model
    compliance: keep the anchors and recent work intact, clear stale tool
    results first, collapse older middle history only near the window, and use a
    hard budget pass as a last resort. Full execution history remains in local
    run/session logs; this function only bounds the model replay payload.
    """

    active_policy = policy or ContextCompactionPolicy()
    stats = ContextCompactionStats(
        messages_before=len(messages),
        chars_before=_json_size(messages),
    )
    compacted: list[dict[str, Any]] = [dict(message) for message in messages]
    compacted = _legacy_message_window(
        compacted, max_history_messages=max_history_messages
    )
    if len(compacted) != len(messages):
        stats.messages_folded += len(messages) - len(compacted)
        stats.notes.append("legacy_recent_message_window")
    compacted = _clear_old_tool_results(compacted, active_policy, stats)
    compacted = _trim_recent_oversize(compacted, active_policy, stats)
    compacted = _collapse_middle_history(compacted, active_policy, stats)
    compacted = _force_message_budget(compacted, active_policy, stats)
    stats.messages_after = len(compacted)
    stats.chars_after = _json_size(compacted)
    stats.chars_saved = stats.chars_before - stats.chars_after
    return compacted, stats


def compact_chat_payload(
    payload: dict[str, Any],
    *,
    policy: ContextCompactionPolicy | None = None,
) -> tuple[dict[str, Any], ContextCompactionStats]:
    messages = payload.get("messages")
    if not isinstance(messages, list) or not all(
        isinstance(message, dict) for message in messages
    ):
        return dict(payload), ContextCompactionStats(enabled=False)
    compacted, stats = compact_messages_for_api(messages, policy=policy)
    result = dict(payload)
    result["messages"] = compacted
    return result, stats


def _legacy_message_window(
    messages: list[dict[str, Any]],
    *,
    max_history_messages: int,
) -> list[dict[str, Any]]:
    if max_history_messages <= 0 or len(messages) <= 2 + max_history_messages:
        return messages
    head = messages[:2]
    tail = messages[2:][-max_history_messages:]
    while tail and tail[0].get("role") == "tool":
        tail = tail[1:]
    return [*head, *tail]


def _clear_old_tool_results(
    messages: list[dict[str, Any]],
    policy: ContextCompactionPolicy,
    stats: ContextCompactionStats,
) -> list[dict[str, Any]]:
    current_size = _json_size(messages)
    if current_size <= policy.clearing_trigger_chars:
        return messages
    tool_indexes = [
        index for index, message in enumerate(messages)
        if _is_tool_result_message(message)
    ]
    clearable = tool_indexes[:-policy.keep_recent_tool_results]
    if not clearable:
        return messages
    compacted = list(messages)
    saved = 0
    for index in clearable:
        if (
            current_size - saved <= policy.clearing_target_chars
            and saved >= policy.clear_at_least_chars
        ):
            break
        raw = compacted[index]
        before = _json_size(raw)
        replacement = dict(raw)
        replacement["content"] = (
            "[old tool result cleared by context compactor]\n"
            + _summarize_message(raw)
        )
        compacted[index] = replacement
        saved += max(0, before - _json_size(replacement))
        stats.tool_results_folded += 1
    return compacted


def _trim_recent_oversize(
    messages: list[dict[str, Any]],
    policy: ContextCompactionPolicy,
    stats: ContextCompactionStats,
) -> list[dict[str, Any]]:
    compacted = []
    for raw in messages:
        message = dict(raw)
        text = _content_text(message.get("content", ""))
        if _is_tool_result_message(message) and len(text) > policy.recent_tool_result_max_chars:
            message["content"], _ = _truncate_text(
                text,
                limit=policy.recent_tool_result_max_chars,
                head=80_000,
                tail=24_000,
                label="recent tool result",
            )
            stats.tool_results_pruned += 1
        elif len(text) > policy.message_max_chars:
            message["content"], _ = _truncate_text(
                text,
                limit=policy.message_max_chars,
                head=120_000,
                tail=40_000,
                label="oversize message",
            )
            stats.oversize_messages_pruned += 1
        compacted.append(message)
    return compacted


def _collapse_middle_history(
    messages: list[dict[str, Any]],
    policy: ContextCompactionPolicy,
    stats: ContextCompactionStats,
) -> list[dict[str, Any]]:
    if (
        len(messages) <= policy.keep_recent_messages + 2
        or _json_size(messages) <= policy.collapse_trigger_chars
    ):
        return messages
    first = messages[:2]
    recent = messages[-policy.keep_recent_messages:]
    middle = messages[2:-policy.keep_recent_messages]
    stats.messages_folded += len(middle)
    summary_lines = [
        _summarize_message(message) for message in middle[-80:]
    ]
    summary = {
        "role": "system",
        "content": (
            "[conversation middle folded by context compactor]\n"
            f"folded_messages={len(middle)}; folded_chars={_json_size(middle)}; "
            "full local run history remains on disk.\n"
            + "\n".join(summary_lines)
        ),
    }
    return first + [summary] + recent


def _force_message_budget(
    messages: list[dict[str, Any]],
    policy: ContextCompactionPolicy,
    stats: ContextCompactionStats,
) -> list[dict[str, Any]]:
    if _json_size(messages) <= policy.hard_max_request_chars:
        return messages
    compacted = []
    for index, raw in enumerate(messages):
        message = dict(raw)
        keep_tail = index >= len(messages) - 8
        content = _content_text(message.get("content", ""))
        limit = 40_000 if keep_tail else 16_000
        if len(content) > limit:
            head = 24_000 if keep_tail else 8_000
            tail = 8_000 if keep_tail else 4_000
            message["content"], _ = _truncate_text(
                content,
                limit=limit,
                head=head,
                tail=tail,
                label="hard budget message",
            )
            stats.oversize_messages_pruned += 1
        compacted.append(message)
    if _json_size(compacted) <= policy.hard_max_request_chars:
        return compacted

    final = []
    for index, raw in enumerate(compacted):
        message = dict(raw)
        preserve = index < 2 or index >= len(compacted) - 4
        limit = 24_000 if preserve else 4_000
        content = _content_text(message.get("content", ""))
        if len(content) > limit:
            message["content"], _ = _truncate_text(
                content,
                limit=limit,
                head=min(limit // 2, 12_000),
                tail=min(limit // 4, 6_000),
                label="final hard budget message",
            )
            stats.oversize_messages_pruned += 1
        final.append(message)
    return final


def _is_tool_result_message(message: dict[str, Any]) -> bool:
    if message.get("role") == "tool":
        return True
    content = message.get("content")
    if isinstance(content, list):
        return any(
            isinstance(item, dict)
            and item.get("type") in {"tool-result", "tool_result"}
            for item in content
        )
    return False


def _summarize_message(message: dict[str, Any]) -> str:
    role = str(message.get("role", "unknown"))
    content = _content_text(message.get("content", ""))
    parts = [f"role={role}", f"chars={len(content)}"]
    if message.get("name"):
        parts.append(f"name={message['name']}")
    calls = message.get("tool_calls")
    if isinstance(calls, list) and calls:
        names = []
        for call in calls[:5]:
            function = call.get("function") if isinstance(call, dict) else None
            if isinstance(function, dict) and function.get("name"):
                names.append(str(function["name"]))
        if names:
            parts.append("tool_calls=" + ",".join(names))
    preview = _short_preview(content)
    if preview:
        parts.append(f"preview={preview!r}")
    return "- " + "; ".join(parts)


def _truncate_text(
    text: str,
    *,
    limit: int,
    head: int,
    tail: int,
    label: str,
) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]
    header = (
        f"[{label} compacted; sha256={digest}; original_chars={len(text)}; "
        "omitted_chars={omitted}]\n"
    )
    marker = "\n[... compacted middle omitted ...]\n"
    available = max(0, limit - len(header.format(omitted=0)) - len(marker))
    if head + tail > available:
        head_ratio = head / max(1, head + tail)
        head = min(head, int(available * head_ratio))
        tail = max(0, available - head)
    omitted = max(0, len(text) - head - tail)
    result = (
        header.format(omitted=omitted)
        + text[:head]
        + marker
        + (text[-tail:] if tail else "")
    )
    if len(result) > limit:
        result = result[:limit]
    return result, True


def _short_preview(text: str, limit: int = 240) -> str:
    collapsed = " ".join(str(text).split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[:limit] + f" ... <{len(collapsed) - limit} chars omitted>"


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False, separators=(",", ":"))


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
