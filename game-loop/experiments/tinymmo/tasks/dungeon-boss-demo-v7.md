# Tiny MMO: Screenshot-Obvious Boss Encounter Upgrade

Improve the real FinalRoom Boss encounter so an ordinary mid-fight screenshot, not only a brief
transition frame, is unmistakably better than the current version. Work only through:

`dungeon.tscn FinalRoom -> RoomNode -> BossController -> boss.state -> BossEncounterHUD`

Do not add an alternate scene, fake payload, preview mode, local combat simulation, or timer-driven
Boss state. Preserve authoritative health, casts, phases, revisions, heartbeat recovery, damage,
rewards, server roles, and the byte-packed protocol.

## Required demo-visible changes

1. Make the persistent encounter HUD a professional raid-style centerpiece at 960x540: roughly
   560-680 px wide, with a health bar at least 520x24, strong Boss identity, numeric HP, and phase.
2. Phase 2 must remain visibly different after the transition animation ends. Show a persistent
   `ENRAGED` badge and change the Boss frame/HP treatment to a hotter danger palette while the
   authoritative phase is 2. Restore the normal style on a new phase-1 encounter or cleanup.
3. A real cast must produce a central, high-contrast warning banner with large readable action copy
   such as `SLAM - MOVE OUT!`, plus countdown/progress. It must clear on the newer cast-end state.
4. Keep the real one-shot Boss reveal, Phase 2 transition, and victory payoff, but ensure Tweens do
   not replay on heartbeats and do not use nonexistent Godot APIs.
5. The HUD must instantiate without runtime script errors in Godot 4.6.3. Use
   `add_theme_constant_override("outline_size", ...)` for Label outlines; do not invent theme APIs.

Keep the patch focused on the production HUD. Run Godot validation and exercise the actual HUD
construction path before finishing.
