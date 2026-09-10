# VibeGame production harness in Game-Evolver

Game-Evolver now treats game production and game evolution as two distinct stages.
VibeGame produces a reviewable, AI-native Phaser vertical slice; only a validated and
human-approved slice becomes an evolution seed.

## Workflow

1. `game-loop vibegame-init` creates the project, records the user prompt and concept
   reference, and installs the eight-role VibeGame team and Phaser runtime.
2. Designer and artist checkpoints remain human-in-the-loop. The Dashboard exposes
   Chat, Design, Assets, Objects, Scenes, Play, Review, Evolution, and Settings.
3. `game-loop vibegame-validate` checks schemas, references, scripts, manifests, and
   production assets. Shared generated atlases are supported with an explicit warning.
4. The reviewer writes `reviewer.verdict`; the human separately writes
   `human.approved` in `.vibegame/review/acceptance.json` after playing the build.
5. `game-loop vibegame-promote` refuses promotion until both decisions pass, then writes
   `game-evolver-baseline.json`. That immutable manifest is the handoff to continuation
   and outer evolution.

## Provider configuration

`vibegame models list` resolves routes without printing credentials, and
`vibegame models smoke PROVIDER` performs a real minimal request. Supported native API
styles are OpenAI Responses, Anthropic Messages, Gemini generateContent, and
OpenAI-compatible Chat Completions for Qwen, DeepSeek, GLM, and internal endpoints.

Each provider accepts `<PROVIDER>_BASE_URL`, `<PROVIDER>_MODEL`,
`<PROVIDER>_API_STYLE`, and its normal credential variable. Settings only returns a
credential-presence boolean. It never returns a secret.

Image generation uses the independent `IMAGE_*` configuration. Krea2 is selected with:

```bash
IMAGE_PROVIDER=Krea2 IMAGE_MODEL=krea2 vibegame art gen image \
  --size 1536x864 --output concept.png --text "..."
```

Krea2 is not OpenAI-compatible: the provider posts JSON to `/krea2/generate`, validates
the returned binary image and content type, retries transient failures, and writes the
result atomically. Its current endpoint is text-to-image only, so visual consistency is
maintained with an approved concept board, an explicit character bible, consolidated
sprite sheets, deterministic atlas cells, and visual review.

## Reference acceptance project

`experiments/vibegame-hollow-knight` is the complete `Veil of the Warden` reference
slice created from the requested prompt. It includes original generated concept art,
arena, player/boss sheets, VFX, HUD, two boss melee skills, one ranged skill, player
basic/charged/aerial attacks, dash, jump, pause, outcomes, restart, and runtime-state
instrumentation. Its reviewer gate is accepted; the human gate intentionally remains
pending until someone approves the played build in the Review tab.

The integration preserves VibeGame's Apache-2.0 `LICENSE` and records the exact upstream
source revision in `vibegame/UPSTREAM.md`.
