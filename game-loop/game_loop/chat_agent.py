"""LocalChatAgent — directly calls an LLM ``/v1/chat/completions`` API.

Reads configuration from environment variables:
  CODEX_API_BASE    — API base URL (e.g. http://29.116.237.135:8080/v1)
  CODEX_MODEL       — model name (e.g. Kimi-K2.7-Code)
  CODEX_API_KEY     — API key
  CODEX_THINKING    — "on"/"off"/"medium"/"high" (controls thinking parameter)
  GAME_LOOP_SKILLS_INDEX — path to awesome-gamedev-skills-index.txt
  GAME_LOOP_SKILLS_ROOT — optional checkout root for loading selected skill bodies

Supports tool calling (function calling), skill index loading, extra
instructions, and evolution directives.
"""
from __future__ import annotations

import json
import http.client
import os
import re
import signal
import socket
import subprocess
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
- Read `RUNTIME_PATHS.md` when present; runtime paths are preconfigured.
- Use the provided Godot wrapper at `tools/godot` — never run `find /` to locate Godot.
- Make incremental, well-reasoned changes.
- Verify your work by running appropriate checks.
- If something fails, diagnose the error and fix it before proceeding.
- Deliver a complete, self-contained artifact.

## GameCraftBench deliverables (required)
- Keep `project.godot` and a runnable main scene (`Main.tscn` or documented entry).
- Build the playable core before asset polish: replace the scaffold with working
  gameplay code and at least 3 deterministic demos within the first 10 turns.
  Do not spend more than 3 turns browsing/generating assets before that playable
  baseline exists. Return to art, audio, and presentation after the core runs.
- Create **at least 3** demo input traces under `demo_outputs/*.json` before you stop.
  Each file is JSON with `duration_frames` and an `events` array (see `_example_trace.json`).
- Run `tools/godot --headless --path . --quit-after 5` to verify the project builds.
- Finish gameplay scripts/scenes and demos in one session; do not stop after asset planning only.
"""

_BLOCKED_COMMAND_PATTERNS = (
    re.compile(r"(?:^|[;&|]\s*)find\s+/"),
    re.compile(r"(?:^|[;&|]\s*)find\s+\/\S+"),
    re.compile(r"\blocate\b"),
)


class LocalChatAgent:
    """Agent that directly calls an OpenAI-compatible ``/v1/chat/completions`` API."""

    def __init__(self) -> None:
        self.api_base = os.environ.get("CODEX_API_BASE", "").rstrip("/")
        self.model = os.environ.get("CODEX_MODEL", "")
        self.provider = os.environ.get("CODEX_PROVIDER", "").strip().casefold()
        self.api_key = self._resolve_api_key(self.provider)
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
        skills_root = os.environ.get("GAME_LOOP_SKILLS_ROOT", "").strip()
        if skills_root:
            parts.append("\n## Skills Source\n")
            parts.append(
                "The indexed skills are available at "
                f"`{skills_root}`. Before applying an indexed skill, read its "
                "`SKILL.md` with a workspace command using the listed relative path. "
                "Use only the skills relevant to the current task.\n"
            )

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

        godot = os.environ.get("GODOT_EXEC_PATH", "").strip() or os.environ.get("GODOT_BIN", "").strip()
        if godot:
            parts.append("\n## Runtime\n\n")
            parts.append(f"- Godot binary: `{godot}`\n")
            parts.append("- Godot command: `tools/godot` from the workspace root\n")
            parts.append("- Do not run `find /` or search the host filesystem for Godot.\n")

        return "\n".join(parts)

    @staticmethod
    def _resolve_api_key(provider: str) -> str:
        if provider == "claude":
            return (
                os.environ.get("CODEX_API_KEY_CLAUDE", "")
                or os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
                or os.environ.get("ANTHROPIC_API_KEY", "")
            )
        if provider in {"gpt55", "gpt-5.5"}:
            return (
                os.environ.get("CODEX_API_KEY_GPT55", "")
                or os.environ.get("OPENAI_API_KEY", "")
            )
        return (
            os.environ.get("CODEX_API_KEY", "")
            or os.environ.get("OPENAI_API_KEY", "")
            or os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
            or os.environ.get("ANTHROPIC_API_KEY", "")
        )

    @staticmethod
    def _demo_trace_count(workspace: Path) -> int:
        candidates = (Path(workspace) / "game" / "demo_outputs", Path(workspace) / "demo_outputs")
        traces: set[Path] = set()
        for directory in candidates:
            if directory.is_dir():
                traces.update(path.resolve() for path in directory.glob("*.json") if path.is_file())
        return len(traces)

    @staticmethod
    def _demo_gate_message(count: int) -> dict[str, str]:
        return {
            "role": "user",
            "content": (
                f"GameCraftBench deliverable gate: only {count} demo trace(s) exist, "
                "but at least 3 deterministic demo_outputs/*.json files are required. "
                "Before editing any more gameplay scripts, your next tool calls MUST "
                "write the missing demo_outputs/demo_*.json files with valid "
                "duration_frames and events, then read them back to validate JSON. "
                "After that, continue completing and testing the playable game. Do not stop yet."
            ),
        }

    @staticmethod
    def _is_demo_write_tool_call(tool_call: dict[str, Any]) -> bool:
        function = tool_call.get("function", {})
        if function.get("name") != "write_file":
            return False
        try:
            arguments = json.loads(function.get("arguments", "{}"))
        except (json.JSONDecodeError, TypeError):
            return False
        path = Path(str(arguments.get("path", "")))
        return path.suffix.casefold() == ".json" and "demo_outputs" in path.parts

    @staticmethod
    def _demo_gate_tool_error(tool_call: dict[str, Any], count: int) -> dict[str, str]:
        return {
            "tool_call_id": str(tool_call.get("id", "")),
            "role": "tool",
            "content": json.dumps({
                "ok": False,
                "error": (
                    f"deliverable gate active ({count}/3 demos): this tool is temporarily "
                    "blocked; write a valid demo_outputs/*.json trace first"
                ),
            }),
        }

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
        api_messages = self._bounded_messages_for_api(messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": api_messages,
            # Paired harness replay must not be dominated by sampler variance.
            # Production evolution sets this to zero; exploratory callers can
            # opt back into stochastic generation explicitly.
            "temperature": float(os.environ.get("GAME_LOOP_CHAT_TEMPERATURE", "0")),
            "max_tokens": int(os.environ.get("GAME_LOOP_CHAT_MAX_OUTPUT_TOKENS", "8192")),
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        model_name = self.model.casefold()
        if "qwen" in model_name or "glm" in model_name:
            # These deployments otherwise spend the response budget in hidden
            # reasoning and frequently time out before returning tool calls.
            # The flag is supported by the production OpenAI-compatible
            # endpoints used for Qwen3.6 and GLM-5.2.
            payload["chat_template_kwargs"] = {"enable_thinking": False}

        extra = self._build_extra_body()
        if extra:
            payload["extra_body"] = extra
            # also merge at top level for compatibility
            payload.update(extra)

        headers = {
            "Content-Type": "application/json",
            # xmcode.shop's Cloudflare policy rejects urllib's default
            # Python signature with error 1010. Use an explicit client UA.
            "User-Agent": "game-loop/1.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        max_retries = max(1, int(os.environ.get("GAME_LOOP_CHAT_API_MAX_RETRIES", "8")))
        api_timeout = max(10, int(os.environ.get("GAME_LOOP_CHAT_API_TIMEOUT_SECONDS", "180")))
        for attempt in range(max_retries):
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=api_timeout) as resp:
                    body = resp.read().decode("utf-8")
                    return json.loads(body)
            except (
                http.client.IncompleteRead,
                ConnectionResetError,
                TimeoutError,
                socket.timeout,
            ) as exc:
                if attempt < max_retries - 1:
                    self._tighten_unstable_provider_payload(payload)
                    wait = min(30, 2 ** (attempt + 1))
                    print(
                        f"[chat_agent] stream/read error, retrying in {wait}s: {exc}",
                        file=sys.stderr,
                    )
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"API stream error: {exc}") from exc
            except urllib.error.HTTPError as exc:
                error_body = ""
                try:
                    error_body = exc.read().decode("utf-8")
                except Exception:
                    pass
                if attempt < max_retries - 1 and exc.code in (429, 500, 502, 503, 504):
                    self._tighten_unstable_provider_payload(payload)
                    wait = min(30, 2 ** (attempt + 1))
                    print(f"[chat_agent] API error {exc.code}, retrying in {wait}s: {error_body[:200]}",
                          file=sys.stderr)
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"API error {exc.code}: {error_body[:500]}") from exc
            except urllib.error.URLError as exc:
                if attempt < max_retries - 1:
                    self._tighten_unstable_provider_payload(payload)
                    wait = min(30, 2 ** (attempt + 1))
                    print(f"[chat_agent] URL error, retrying in {wait}s: {exc}",
                          file=sys.stderr)
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"connection error: {exc}") from exc

        raise RuntimeError("API call failed after max retries")

    # ── tool execution ──

    def _tighten_unstable_provider_payload(self, payload: dict[str, Any]) -> None:
        """Conservatively reduce retry size for flaky local provider deployments."""

        model_name = self.model.casefold()
        if "qwen" not in model_name and "glm" not in model_name:
            return
        fallback = self._env_int("GAME_LOOP_CHAT_RETRY_MAX_OUTPUT_TOKENS", 512)
        current = int(payload.get("max_tokens", fallback))
        if current > fallback:
            payload["max_tokens"] = fallback

    @classmethod
    def _bounded_messages_for_api(cls, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Return a provider-sized replay window while preserving valid tool pairs.

        Smaller OpenAI-compatible deployments can become unstable when every
        prior tool call and tool result is replayed for dozens of turns.  The
        workspace is the source of truth for files already written, so Qwen-like
        profiles can opt into a bounded recent history without changing the
        executed tools or verifier contract.
        """

        max_history = cls._env_int("GAME_LOOP_CHAT_MAX_HISTORY_MESSAGES", 0)
        if max_history <= 0 or len(messages) <= 2 + max_history:
            return messages
        head = messages[:2]
        tail = messages[2:][-max_history:]
        while tail and tail[0].get("role") == "tool":
            tail = tail[1:]
        return [*head, *tail]

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

        if "_tool_argument_error" in arguments:
            result = {
                "ok": False,
                "error": str(arguments["_tool_argument_error"]),
                "instruction": "Retry this tool call with one complete valid JSON arguments object.",
            }
            return {
                "tool_call_id": tool_call.get("id", ""),
                "role": "tool",
                "content": json.dumps(result, ensure_ascii=False),
            }

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
                return {
                    "ok": True,
                    "content": content[: self._env_int("GAME_LOOP_TOOL_READ_MAX_CHARS", 8000)],
                }
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
            command = args.get("command", "")
            blocked = self._blocked_command_reason(command)
            if blocked:
                return {"ok": False, "error": blocked}
            cwd = ws / args.get("cwd", ".")
            timeout = int(args.get("timeout", 120))
            env = os.environ.copy()
            godot = env.get("GODOT_EXEC_PATH", "").strip() or env.get("GODOT_BIN", "").strip()
            if godot:
                env["GODOT_EXEC_PATH"] = godot
                env["GODOT_BIN"] = godot
            tools_dir = ws / "tools"
            if tools_dir.is_dir():
                env["PATH"] = f"{tools_dir}:{env.get('PATH', '')}"
            try:
                proc = subprocess.Popen(
                    command, shell=True, cwd=str(cwd),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                    env=env, start_new_session=True,
                )
                stdout, stderr = proc.communicate(timeout=timeout)
                return {
                    "ok": True,
                    "return_code": proc.returncode,
                    "stdout": stdout[: self._env_int("GAME_LOOP_TOOL_STDOUT_MAX_CHARS", 8000)],
                    "stderr": stderr[: self._env_int("GAME_LOOP_TOOL_STDERR_MAX_CHARS", 4000)],
                }
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                    try:
                        proc.communicate(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.communicate(timeout=2)
                except ProcessLookupError:
                    pass
                return {"ok": False, "error": f"command timed out after {timeout}s"}
            except OSError as exc:
                return {"ok": False, "error": str(exc)}

        return {"ok": False, "error": f"unknown tool: {name}"}

    @staticmethod
    def _env_int(name: str, default: int) -> int:
        try:
            return max(0, int(os.environ.get(name, str(default))))
        except ValueError:
            return default

    @staticmethod
    def _blocked_command_reason(command: str) -> str | None:
        normalized = command.strip()
        if not normalized:
            return "empty command"
        for pattern in _BLOCKED_COMMAND_PATTERNS:
            if pattern.search(normalized):
                return (
                    "blocked command: use the preconfigured Godot wrapper at tools/godot "
                    "or GODOT_EXEC_PATH; do not scan the filesystem with find/locate"
                )
        return None

    @staticmethod
    def _normalize_assistant_message(message: dict[str, Any]) -> dict[str, Any]:
        """Make nested tool arguments valid before replaying model history.

        Some OpenAI-compatible deployments can emit a truncated JSON string in
        ``tool_calls[].function.arguments``.  Re-sending it verbatim causes
        those servers to reject the entire next request with HTTP 400.  Keep a
        bounded diagnostic, but always replay syntactically valid arguments so
        the model can receive the tool error and retry the call.
        """

        normalized = dict(message)
        calls: list[dict[str, Any]] = []
        for original in message.get("tool_calls", []) or []:
            tool_call = dict(original)
            function = dict(tool_call.get("function", {}))
            raw = function.get("arguments", "{}")
            if not isinstance(raw, str):
                raw = json.dumps(raw, ensure_ascii=False)
            try:
                json.loads(raw)
            except (json.JSONDecodeError, TypeError) as exc:
                function["arguments"] = json.dumps(
                    {
                        "_tool_argument_error": (
                            f"model emitted incomplete/invalid JSON arguments: {exc}"
                        ),
                        "_raw_arguments_prefix": raw[:500],
                    },
                    ensure_ascii=False,
                )
            else:
                function["arguments"] = raw
            tool_call["function"] = function
            calls.append(tool_call)
        if "tool_calls" in message:
            normalized["tool_calls"] = calls
        return normalized

    @classmethod
    def _compact_assistant_message_for_history(cls, message: dict[str, Any]) -> dict[str, Any]:
        """Trim bulky tool arguments before sending history back to the model.

        Tool calls are executed from the original message, but the replayed
        assistant message does not need to carry full file bodies forever.  Long
        ``write_file.content`` arguments otherwise dominate every subsequent API
        request and cause smaller OpenAI-compatible deployments to 502/timeout.
        The tool result still records success, and the model can call
        ``read_file`` if it needs to inspect what was written.
        """

        compact = dict(message)
        calls: list[dict[str, Any]] = []
        max_chars = cls._env_int("GAME_LOOP_TOOL_CALL_HISTORY_CONTENT_CHARS", 512)
        for original in message.get("tool_calls", []) or []:
            tool_call = dict(original)
            function = dict(tool_call.get("function", {}))
            raw = function.get("arguments", "{}")
            if not isinstance(raw, str):
                raw = json.dumps(raw, ensure_ascii=False)
            try:
                arguments = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                function["arguments"] = raw
            else:
                if (
                    function.get("name") == "write_file"
                    and isinstance(arguments.get("content"), str)
                    and len(arguments["content"]) > max_chars
                ):
                    content = arguments["content"]
                    arguments["content"] = (
                        content[:max_chars]
                        + f"\n...[omitted {len(content) - max_chars} chars from chat history; "
                        + "file was written by the tool, use read_file if needed]..."
                    )
                    arguments["_content_chars"] = len(content)
                    arguments["_content_history_compacted"] = True
                    function["arguments"] = json.dumps(arguments, ensure_ascii=False)
                else:
                    function["arguments"] = raw
            tool_call["function"] = function
            calls.append(tool_call)
        if "tool_calls" in message:
            compact["tool_calls"] = calls
        return compact

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
        raw_demo_gate = os.environ.get("GAME_LOOP_REQUIRE_GCB_DEMOS")
        require_gcbench_demos = (
            "demo_outputs" in instruction
            if raw_demo_gate is None
            else raw_demo_gate.strip().lower() in {"1", "true", "yes", "on"}
        )
        # Early reminders allow normal implementation work; from turn 45 on,
        # repeat the gate every turn so the session cannot silently spend its
        # entire remaining budget while omitting benchmark deliverables.
        demo_gate_turns = {10, 25, *range(45, 60)}

        for turn in range(max_turns):
            turns = turn + 1
            print(f"[chat_agent] turn {turns}/{max_turns}")

            response = self._call_api(messages, tools)
            choice = response.get("choices", [{}])[0]
            message = self._normalize_assistant_message(choice.get("message", {}))

            # ── extract text ──
            if message.get("content"):
                final_text = message["content"]

            # ── handle tool calls ──
            tool_calls = message.get("tool_calls", [])
            if not tool_calls:
                messages.append(message)
                finish_reason = choice.get("finish_reason", "stop")
                if finish_reason in {"length", "max_tokens"} and turns < max_turns:
                    # A truncated planning/code response is not task completion.
                    # Preserve the partial assistant content and explicitly ask
                    # the model to resume tool use; otherwise long game builds
                    # silently stop halfway through an edit.
                    print("[chat_agent] response truncated; continuing")
                    messages.append({
                        "role": "user",
                        "content": (
                            "Your previous response was truncated by the token limit. "
                            "Continue from exactly where you stopped. Use the tools to "
                            "finish the game implementation and required verification; "
                            "do not merely describe the remaining work."
                        ),
                    })
                    continue
                if require_gcbench_demos and turns < max_turns:
                    demo_count = self._demo_trace_count(workspace)
                    if demo_count < 3:
                        print(
                            f"[chat_agent] deliverable gate: demos={demo_count}/3; continuing"
                        )
                        messages.append(self._demo_gate_message(demo_count))
                        continue
                print(f"[chat_agent] finished: {finish_reason}")
                break

            # ── append compacted assistant message for replay ──
            messages.append(self._compact_assistant_message_for_history(message))

            for tc in tool_calls:
                total_tool_calls += 1
                fn_name = tc.get("function", {}).get("name", "")
                print(f"[chat_agent] tool_call: {fn_name}")
                demo_count = self._demo_trace_count(workspace) if require_gcbench_demos else 3
                if (
                    require_gcbench_demos
                    and turns >= 45
                    and demo_count < 3
                    and not self._is_demo_write_tool_call(tc)
                ):
                    print(
                        f"[chat_agent] deliverable gate blocked tool={fn_name} demos={demo_count}/3"
                    )
                    result = self._demo_gate_tool_error(tc, demo_count)
                else:
                    result = self._execute_tool(tc, workspace, tools)
                messages.append(result)

            if require_gcbench_demos and turns in demo_gate_turns:
                demo_count = self._demo_trace_count(workspace)
                if demo_count < 3:
                    print(f"[chat_agent] deliverable milestone: demos={demo_count}/3")
                    messages.append(self._demo_gate_message(demo_count))
            if require_gcbench_demos and self._should_stop_after_demo_delivery(turns, workspace):
                final_text = (
                    final_text
                    or "Required GameCraftBench demo traces are present; stopping for verifier."
                )
                print("[chat_agent] deliverable gate satisfied; stopping for verifier")
                break

        return {
            "messages": messages,
            "final_text": final_text,
            "turns": turns,
            "tool_calls": total_tool_calls,
        }

    # ── default tool set ──

    def _should_stop_after_demo_delivery(self, turns: int, workspace: Path) -> bool:
        threshold = self._env_int("GAME_LOOP_STOP_AFTER_GCB_DEMOS_TURN", 0)
        if threshold <= 0 or turns < threshold:
            return False
        return self._demo_trace_count(workspace) >= 3

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
                    "description": (
                        "Run a shell command in the workspace. Godot is available as "
                        "`tools/godot`; do not search the filesystem for binaries."
                    ),
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
    parser.add_argument("--max-turns", type=int, default=int(os.environ.get("GAME_LOOP_CHAT_MAX_TURNS", "30")))
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
