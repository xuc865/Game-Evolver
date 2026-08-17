# Tiny MMO: Give the Dynamic Boss HUD a Real Viewport Width

Edit only `source/client/ui/hud/boss_encounter_hud.gd`.

The dynamically-created BossEncounterHUD still has near-zero runtime width because assigning
`anchors_preset = PRESET_TOP_WIDE` does not establish the needed anchors in this construction path.
In `_build_ui()`, replace the preset-based root layout with explicit full-width top anchors:

- `anchor_left = 0.0`
- `anchor_right = 1.0`
- `anchor_top = 0.0`
- `anchor_bottom = 0.0`
- `offset_left = 0.0`
- `offset_right = 0.0`
- `offset_top = 0.0`
- `offset_bottom = FRAME_HEIGHT + 140.0`
- use horizontal grow-both and vertical grow-end where appropriate

Keep the already-correct centered frame and cast-banner anchors/offsets, 640px frame, 560x28 HP
bar, persistent ENRAGED styling, 44px action label, and all authoritative state logic unchanged.
Do not add files or touch combat/network/server code. Run Godot 4.6.3 headless validation.
