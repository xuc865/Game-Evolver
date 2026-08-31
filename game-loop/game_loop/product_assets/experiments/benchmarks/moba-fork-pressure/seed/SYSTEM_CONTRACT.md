# Tri-Lane Citadel System Contract

The seed is intentionally incomplete but already split at stable integration
boundaries. Implement every module and wire them through `Main.gd`. You may refine
the APIs, but normal play and replay must execute the same production logic.

- `combat_system.gd`: attacks, abilities, cooldowns, damage, death, and respawn.
- `ai_system.gd`: autonomous state selection and movement/action intentions.
- `economy_system.gd`: rewards, purchases, upgrades, and observable stat effects.
- `objective_system.gd`: structures, neutral capture, buffs, and win/loss state.
- `hud_system.gd`: authoritative state projection and interactive controls.
- `replay_system.gd`: trace parsing, frame dispatch, coverage, and state-change evidence.

No module is complete merely because its file loads or its API returns a value.
Each must alter integrated match state and be exercised by at least one valid demo.
