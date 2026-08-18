# KSRE pXt Longform Director's Cut

Implement immediately. Create or extend `game/mods/pxt_director/` as a real playable KSRE mod. Do not spend many turns only inspecting; use the existing `game/mods/pxt/` files as the pattern.

Goal: produce a noticeably longer and richer playable visual-novel episode, not a short staging vignette.

The new mod must be reachable from the existing real `Mods` menu:

- Register `mods["pxt_director"] = "pXt Director's Cut"`.
- Register `mods_with_menus["pxt_director"] = True`.
- Provide `screen pxt_director`.
- Provide `label pxt_director_start`.

The improvement should be obvious during actual play:

- Add a polished `pXt Director's Cut` menu with Start, Program/About, and a commentary/director-notes option.
- Reuse existing bundled pXt assets under `game/mods/pxt/`; do not download external assets.
- Build a complete episode with at least three distinct scene beats: setup, complication/rehearsal failure, player-directed staging choice, payoff, and curtain-call epilogue.
- Include multiple reachable branches or presentation choices. The choices should change dialogue, staging, or final payoff, not only set a cosmetic flag.
- Prefer at least 120 authored dialogue/stage-direction lines, 10+ labels, 3+ custom screens, rich transitions, and sustained music/sound cue pacing.
- Make the post-evolution build feel meaningfully longer than the seed pXt sample when played from the Mods menu.
- Preserve the original `game/mods/pxt/` mod and the global KSRE UI.
- Verify with `tools/renpy . compile` or the bundled Ren'Py command before finishing.

Good changes should be traceable in code and deeply visible in play: the evolved game should feel like a small polished VN episode with choices, callbacks, and a finale.
