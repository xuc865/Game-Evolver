# Tiny MMO: Finish the Central Boss Cast Banner

Make one focused production change in
`source/client/ui/hud/boss_encounter_hud.gd` only. Do not add tests, scenes, scripts, assets, or
change any server/combat/network file.

The existing real Boss HUD already has a 640 px encounter frame, 560x28 HP bar, persistent
authoritative Phase 2 ENRAGED styling, reveal/victory states, and a central cast banner. Finish the
demo presentation by making the central real-cast action label at least 40 px so
`SLAM - MOVE OUT!` is unmistakable at the 960x540 viewport. Keep the 520 px warning panel,
countdown, progress, cast-end cleanup, revision gate, and heartbeat behavior intact.

Use only valid Godot 4.6.3 APIs and run headless editor validation. Do not create a preview payload
or alternate scene. The final diff must remain limited to the existing production HUD file.
