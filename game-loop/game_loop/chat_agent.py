"""LocalChatAgent — directly calls an LLM ``/v1/chat/completions`` API.

Reads configuration from environment variables:
  CODEX_API_BASE    — API base URL (e.g. http://29.116.237.135:8080/v1)
  CODEX_MODEL       — model name (e.g. Kimi-K2.7-Code)
  CODEX_API_KEY     — API key
  CODEX_THINKING    — "on"/"off"/"medium"/"high" (controls thinking parameter)
  GAME_LOOP_SKILLS_INDEX — path to awesome-gamedev-skills-index.txt

Supports tool calling (function calling), skill index loading, extra
instructions, and evolution directives.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

_BASE_SYSTEM_PROMPT = """\
You are an expert game development AI agent working inside a game-loop harness.
Your job is to follow instructions precisely, use available tools to inspect and
modify the workspace, and produce a complete, runnable game artifact.

## Workspace
You are operating inside a candidate workspace directory. All file paths are
relative to this workspace unless otherwise stated.

## Tool Use
You have access to tools that let you read files, write files, run commands,
and inspect the project. Always use tools when you need to interact with the
filesystem. When you receive a tool result, study it carefully before deciding
your next action.

## Best Practices
- Start by understanding the task requirements and the current workspace state.
- Make incremental, well-reasoned changes.
- Verify your work by running appropriate checks.
- If something fails, diagnose the error and fix it before proceeding.
- Deliver a complete, self-contained artifact.
"""


class LocalChatAgent:
    """Agent that directly calls an OpenAI-compatible ``/v1/chat/completions`` API."""

    def __init__(self) -> None:
        self.api_base = os.environ.get("CODEX_API_BASE", "").rstrip("/")
        self.model = os.environ.get("CODEX_MODEL", "")
        self.api_key = os.environ.get("CODEX_API_KEY", "")
        self.thinking_mode = os.environ.get("CODEX_THINKING", "").strip().lower()

        if not self.api_base:
            raise ValueError("CODEX_API_BASE environment variable is required")
        if not self.model:
            raise ValueError("CODEX_MODEL environment variable is required")

        self.system_prompt = self._build_system_prompt()

    # ── system prompt assembly ──

    def _build_system_prompt(self) -> str:
        parts: list[str] = [_BASE_SYSTEM_PROMPT]

        # ── load skill index ──
        skills_index_path = os.environ.get("GAME_LOOP_SKILLS_INDEX", "")
        if skills_index_path:
            try:
                content = Path(skills_index_path).read_text(encoding="utf-8")
                parts.append("\n## Awesome Gamedev Skills Index\n")
                parts.append("The following skills are available. Reference them when relevant:\n\n")
                parts.append(content)
            except OSError:
                pass

        # ── load extra instructions ──
        extra_instruction_path = os.environ.get("EXTRA_INSTRUCTION_PATH", "")
        if extra_instruction_path:
            try:
                content = Path(extra_instruction_path).read_text(encoding="utf-8")
                parts.append("\n## Extra Instructions\n\n")
                parts.append(content)
            except OSError:
                pass

        # ── load evolution directive ──
        directive_path = os.environ.get("EVOLUTION_DIRECTIVE_PATH", "evolution_directive.md")
        directive_file = Path(directive_path)
        if directive_file.is_file():
            try:
                content = directive_file.read_text(encoding="utf-8")
                parts.append("\n## Evolution Directive\n\n")
                parts.append(content)
            except OSError:
                pass

        return "\n".join(parts)

    # ── thinking parameter ──

    def _build_extra_body(self) -> dict[str, Any]:
        """Build extra_body for thinking/reasoning parameters."""
        extra: dict[str, Any] = {}
        if self.thinking_mode and self.thinking_mode not in ("off", "0", "false", "no"):
            if self.thinking_mode in ("on", "1", "true", "yes"):
                extra["thinking"] = {"type": "on"}
            elif self.thinking_mode in ("medium", "high", "low"):
                extra["thinking"] = {"type": "on"}
                extra["reasoning_effort"] = self.thinking_mode
            else:
                extra["thinking"] = {"type": "on"}
        elif self.thinking_mode in ("off", "0", "false", "no"):
            extra["thinking"] = {"type": "off"}
        return extra

    # ── API call ──

    def _call_api(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Make a single /v1/chat/completions API call."""
        url = f"{self.api_base}/chat/completions"
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.6,
            "max_tokens": 16384,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        extra = self._build_extra_body()
        if extra:
            payload["extra_body"] = extra
            # also merge at top level for compatibility
            payload.update(extra)

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")

        max_retries = 3
        for attempt in range(max_retries):
            try:
                with urllib.request.urlopen(req, timeout=300) as resp:
                    body = resp.read().decode("utf-8")
                    return json.loads(body)
            except urllib.error.HTTPError as exc:
                error_body = ""
                try:
                    error_body = exc.read().decode("utf-8")
                except Exception:
                    pass
                if attempt < max_retries - 1 and exc.code in (429, 500, 502, 503, 504):
                    wait = 2 ** (attempt + 1)
                    print(f"[chat_agent] API error {exc.code}, retrying in {wait}s: {error_body[:200]}",
                          file=sys.stderr)
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"API error {exc.code}: {error_body[:500]}") from exc
            except urllib.error.URLError as exc:
                if attempt < max_retries - 1:
                    wait = 2 ** (attempt + 1)
                    print(f"[chat_agent] URL error, retrying in {wait}s: {exc}",
                          file=sys.stderr)
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"connection error: {exc}") from exc

        raise RuntimeError("API call failed after max retries")

    # ── tool execution ──

    def _execute_tool(
        self,
        tool_call: dict[str, Any],
        workspace: Path,
        tool_definitions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Execute a single tool call and return the result."""
        function = tool_call.get("function", {})
        name = function.get("name", "")
        try:
            arguments = json.loads(function.get("arguments", "{}"))
        except json.JSONDecodeError:
            arguments = {}

        result = self._dispatch_tool(name, arguments, workspace)
        return {
            "tool_call_id": tool_call.get("id", ""),
            "role": "tool",
            "content": json.dumps(result, ensure_ascii=False),
        }

    def _dispatch_tool(
        self,
        name: str,
        args: dict[str, Any],
        workspace: Path,
    ) -> dict[str, Any]:
        """Dispatch a tool call to the appropriate handler."""
        ws = Path(workspace)

        if name == "read_file":
            path = ws / args.get("path", "")
            try:
                content = path.read_text(encoding="utf-8")
                return {"ok": True, "content": content[:8000]}
            except OSError as exc:
                return {"ok": False, "error": str(exc)}

        elif name == "write_file":
            path = ws / args.get("path", "")
            content = args.get("content", "")
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
                return {"ok": True, "path": str(path)}
            except OSError as exc:
                return {"ok": False, "error": str(exc)}

        elif name == "list_dir":
            path = ws / args.get("path", ".")
            try:
                entries = []
                for entry in sorted(path.iterdir()):
                    entries.append({
                        "name": entry.name,
                        "type": "dir" if entry.is_dir() else "file",
                        "size": entry.stat().st_size if entry.is_file() else 0,
                    })
                return {"ok": True, "entries": entries}
            except OSError as exc:
                return {"ok": False, "error": str(exc)}

        elif name == "run_command":
            import subprocess
            command = args.get("command", "")
            cwd = ws / args.get("cwd", ".")
            timeout = int(args.get("timeout", 120))
            try:
                proc = subprocess.run(
                    command, shell=True, cwd=str(cwd),
                    capture_output=True, text=True, timeout=timeout,
                )
                return {
                    "ok": True,
                    "return_code": proc.returncode,
                    "stdout": proc.stdout[:8000],
                    "stderr": proc.stderr[:4000],
                }
            except subprocess.TimeoutExpired:
                return {"ok": False, "error": f"command timed out after {timeout}s"}
            except OSError as exc:
                return {"ok": False, "error": str(exc)}

        return {"ok": False, "error": f"unknown tool: {name}"}

    # ── main entry point ──

    def run(
        self,
        instruction: str,
        workspace: Path,
        tools: list[dict[str, Any]] | None = None,
        max_turns: int = 30,
    ) -> dict[str, Any]:
        """Run the agent on *instruction* within *workspace*.

        Parameters
        ----------
        instruction
            The task instruction / prompt.
        workspace
            Path to the candidate workspace directory.
        tools
            Optional list of tool definitions (OpenAI function-calling format).
            If None, a default tool set is used.
        max_turns
            Maximum number of API round-trips.

        Returns
        -------
        dict
            ``{"messages": [...], "final_text": str, "turns": int, "tool_calls": int}``
        """
        workspace = Path(workspace)
        if tools is None:
            tools = self._default_tools()

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": instruction},
        ]

        total_tool_calls = 0
        final_text = ""
        turns = 0

        for turn in range(max_turns):
            turns = turn + 1
            print(f"[chat_agent] turn {turns}/{max_turns}")

            response = self._call_api(messages, tools)
            choice = response.get("choices", [{}])[0]
            message = choice.get("message", {})

            # ── append assistant message ──
            messages.append(message)

            # ── extract text ──
            if message.get("content"):
                final_text = message["content"]

            # ── handle tool calls ──
            tool_calls = message.get("tool_calls", [])
            if not tool_calls:
                finish_reason = choice.get("finish_reason", "stop")
                print(f"[chat_agent] finished: {finish_reason}")
                break

            for tc in tool_calls:
                total_tool_calls += 1
                fn_name = tc.get("function", {}).get("name", "")
                print(f"[chat_agent] tool_call: {fn_name}")
                result = self._execute_tool(tc, workspace, tools)
                messages.append(result)

        return {
            "messages": messages,
            "final_text": final_text,
            "turns": turns,
            "tool_calls": total_tool_calls,
        }

    # ── default tool set ──

    @staticmethod
    def _default_tools() -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read the contents of a file in the workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Relative path to the file."},
                        },
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Write content to a file in the workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Relative path to the file."},
                            "content": {"type": "string", "description": "Content to write."},
                        },
                        "required": ["path", "content"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "list_dir",
                    "description": "List directory contents in the workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Relative directory path. Defaults to '.'."},
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "run_command",
                    "description": "Run a shell command in the workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": {"type": "string", "description": "Shell command to execute."},
                            "cwd": {"type": "string", "description": "Working directory. Defaults to '.'."},
                            "timeout": {"type": "integer", "description": "Timeout in seconds. Defaults to 120."},
                        },
                        "required": ["command"],
                    },
                },
            },
        ]


# ── CLI entry point ──

def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="game_loop.chat_agent")
    parser.add_argument("--instruction", required=True, help="Task instruction")
    parser.add_argument("--workspace", type=Path, required=True, help="Workspace directory")
    parser.add_argument("--max-turns", type=int, default=30)
    args = parser.parse_args()

    agent = LocalChatAgent()
    result = agent.run(
        instruction=args.instruction,
        workspace=args.workspace,
        max_turns=args.max_turns,
    )
    print(json.dumps({
        "turns": result["turns"],
        "tool_calls": result["tool_calls"],
        "final_text": result["final_text"][:2000],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
