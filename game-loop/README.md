# Game Loop

Game Loop 0.3.0 is a local, self-evolving multi-agent studio for building and
improving playable Godot games. A game-building agent (GOA) evolves alongside a
harness-proposal agent (HPA). HPA can create executable Agent Circuits with
custom roles, isolated contexts, typed handoffs, parallel branches, fan-in, and
bounded review loops; GOA admits them only through paired evidence and explicit
quality/cost gates.

## Start

Requirements:

- Python 3.11 or newer
- A `DEEPSEEK_API_KEY`
- `uv` for the one-command path (recommended)

After the package is published:

```bash
DEEPSEEK_API_KEY=... uvx game-loop studio
```

For an installed wheel or checkout:

```bash
uvx --from ./dist/game_loop-0.3.0-py3-none-any.whl game-loop studio
```

Studio opens at [http://127.0.0.1:8766](http://127.0.0.1:8766). Use a different
port with `--port 8767`, or suppress browser launch with `--no-open`.

Run the setup check without starting Studio:

```bash
game-loop doctor
game-loop doctor --json
```

Build from one terminal request without the UI:

```bash
game-loop run "Build a compact puzzle game with three escalating levels"
```

Godot is detected automatically. When it is absent, the packaged backend can
install its pinned runtime on first use. The DeepSeek Harness SDK and all Studio
assets are included as package dependencies/resources.

## Agent Evolution

An Agent Circuit is an executable graph, not a prompt that asks one model to
role-play a team. HPA may define:

- Any evidence-backed role roster, role objective, system prompt, context mode,
  model budget, and typed output contract.
- DAG control flow, parallel fan-out, fan-in integration, and bounded feedback
  edges.
- Typed summary, artifact, review, control, and feedback handoffs.
- Add, delete, modify, split, and merge topology mutations.

Each role runs as an isolated DeepSeek Harness session with its own workspace,
home, context, and budget. Required artifact contracts are validated before a
candidate can run. Circuit role count, total calls, total cost, and feedback
traversals remain configurable safety limits; these limits do not prescribe a
fixed team.

GOA may bundle several transformations that share evidence, up to the configured
transaction width. Accepted multi-action circuits enter persistent conditional
leave-one-out attribution. Infrastructure failures, incomplete sessions, and
timeouts never become formal quality results.

## Local Data And Snapshots

The packaged Studio stores projects under `~/.game-loop/projects`. Set
`GAME_LOOP_STUDIO_HOME` to choose another location. Requests, game artifacts,
evolution journals, and GOA/HPA snapshots remain local except for model-provider
traffic.

The Studio can save and load GOA and HPA snapshots independently. Loading a
snapshot verifies its content manifest, creates an automatic backup, restores
only the selected engine state, and preserves the current game and conversation.

## Development

```bash
python -m build
PYTHONPATH=. PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 pytest -q
```

The full release check also installs the wheel into a clean environment, starts
Studio from an unrelated directory, checks `/api/health`, exercises project and
snapshot APIs, runs the ten-request product pressure path, and performs browser
layout verification.
