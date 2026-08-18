# KSRE pXt Director's Cut

Implement immediately. Create the directory `game/mods/pxt_director/` and add the Ren'Py files needed for a new playable mod. Do not spend many turns only inspecting; use the existing `game/mods/pxt/` files as the pattern.

Goal: improve Katawa Shoujo: Re-Engineered as a real playable visual-novel project.

The new mod must be reachable from the existing real `Mods` menu:

- Register `mods["pxt_director"] = "pXt Director's Cut"`.
- Register `mods_with_menus["pxt_director"] = True`.
- Provide `screen pxt_director`.
- Provide `label pxt_director_start`.

The improvement should be obvious during play:

- Add a polished `pXt Director's Cut` menu with Start, Program/About, and a commentary/director-notes option.
- Reuse existing bundled pXt assets under `game/mods/pxt/`; do not download external assets.
- Build a richer staged visual-novel scene with an opening title/program beat, multiple character entrances, music or sound cues, readable stage directions, transitions, at least one player-facing choice or branch, and a final curtain-call/payoff.
- Preserve the original `game/mods/pxt/` mod and the global KSRE UI.
- Verify with `tools/renpy . compile` or the bundled Ren'Py command before finishing.

Good changes should be traceable in code and deeply visible in actual play: the evolved game should feel more authored, theatrical, and polished than the original pXt sample.
