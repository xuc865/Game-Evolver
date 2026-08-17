# Tiny MMO: Fix the Real HUD Centering

Fix one production runtime-layout defect in
`source/client/ui/hud/boss_encounter_hud.gd` only. Do not add or edit any other file.

In the real 960x540 client, the 640px Boss encounter frame is currently clipped off the left edge
because it uses `PRESET_CENTER_TOP` plus a negative `position` under the persistent HUD parent.
Make the root Control span the viewport width at the top, then center the frame with explicit
anchors and offsets:

- `_frame.anchor_left = 0.5`, `_frame.anchor_right = 0.5`
- `_frame.offset_left = -320.0`, `_frame.offset_right = 320.0`
- preserve its 640px width and 140px height

Center the 520px real-cast banner the same way:

- `_cast_banner.anchor_left = 0.5`, `_cast_banner.anchor_right = 0.5`
- `_cast_banner.offset_left = -260.0`, `_cast_banner.offset_right = 260.0`
- preserve the 44px `SLAM - MOVE OUT!` text and 88px banner height

Remove the conflicting `position`-based centering. Preserve all authoritative Boss state,
revisions, heartbeat, countdown, Phase 2 styling, reveal, victory, and cleanup behavior. Run Godot
4.6.3 headless editor validation. The final diff must remain limited to this HUD file.
