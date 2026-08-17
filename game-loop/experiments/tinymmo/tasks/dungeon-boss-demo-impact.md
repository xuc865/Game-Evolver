# Tiny MMO: High-Impact Production Boss Presentation

Make one bounded but visually unmistakable improvement to the real Tiny MMO final-room Boss
encounter. A side-by-side screenshot or short recording must make the evolved version obviously
better than the current production Boss HUD without explanatory text.

Work through the existing production path only:

`dungeon.tscn FinalRoom -> RoomNode -> BossController -> boss.state -> BossEncounterHUD`

Do not create an alternate main scene, standalone showcase, fake Boss, hard-coded preview payload,
or local-only simulation. Preserve the existing authoritative health, phase, cast timing, revision,
late-subscriber heartbeat, combat damage, rewards, server roles, and byte-packed protocol.

## Required visible presentation

Implement the presentation primarily in the existing `BossEncounterHUD`:

1. **Persistent encounter frame.** Make the live Boss name, numeric HP, health bar, and phase badge
   visually dominant and readable at the 960x540 base viewport. It should look like an encounter
   centerpiece rather than a small debug panel.
2. **Boss reveal.** When a new authoritative encounter id first becomes active, show a brief,
   non-blocking Boss-introduction reveal driven by that real payload. It must not replay on every
   heartbeat or duplicate revision.
3. **Cast danger state.** During a real cast, make the HUD clearly communicate urgency with a
   high-contrast warning such as `SLAM - MOVE OUT`, a progress/countdown treatment, and a restrained
   pulse or color change. It must clear when the authoritative cast ends.
4. **Phase transition.** When the authoritative phase changes from 1 to 2, show a conspicuous but
   brief enrage/phase transition treatment. It must trigger only on an actual newer phase update.
5. **Victory/end feedback.** A normal Boss death (`active=false`, not aborted) should briefly show a
   victory/defeated state before cleanup. Abort, instance change, disconnect, or gateway return must
   still reset immediately.

Use stable responsive dimensions and existing Godot Controls/Tweens. Do not obscure gameplay for
more than a brief reveal, and do not add expensive per-frame node creation. Keep all state ordering,
late-subscriber recovery, and cross-process cast timing correct.

Run full Godot headless editor validation before finishing. Make a focused, production-quality
change rather than a generic UI framework.
