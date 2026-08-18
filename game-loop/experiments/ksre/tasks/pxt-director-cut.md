# KSRE pXt Director's Cut

Improve Katawa Shoujo: Re-Engineered as a real playable visual-novel project.

Create a new playable mod at `game/mods/pxt_director/` that can be reached from the existing real `Mods` menu. Preserve the original `game/mods/pxt/` mod unchanged enough that it still works as a baseline.

The improvement should be obvious during play, not just in code:

- Add a polished `pXt Director's Cut` menu with Start, About or Program, and a commentary/director-notes option.
- Reuse the existing bundled pXt assets under `game/mods/pxt/`; do not download external assets.
- Build a richer staged visual-novel scene with a clear opening title/program beat, multiple character entrances, music or sound cues, visible stage directions, transitions, at least one player-facing choice or branch, and a final curtain-call/payoff.
- Keep the implementation bounded to the mod. Do not rewrite global KSRE UI, do not remove accessibility settings, and do not break the original Mods menu.
- Verify with `tools/renpy . compile` or the bundled Ren'Py command before finishing.

Good changes should be traceable in code and deeply visible in actual play: the evolved game should feel more authored, theatrical, and polished than the original pXt sample.
