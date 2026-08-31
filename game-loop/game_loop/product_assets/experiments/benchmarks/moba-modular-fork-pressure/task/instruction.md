# Tri-Lane Citadel: Tournament Operations

Extend the existing runnable Godot 4 MOBA into a tournament-grade integrated
vertical slice. This release has six required subsystem packages. They share the
same authoritative match state and must work together in normal play and replay.

The project deliberately exposes stable ownership and local-check boundaries in
`game/MODULE_CONTRACTS.md`. Preserve those boundaries. A module implementation
can be produced and checked independently; `Main.gd`, shared-interface
adaptation, whole-game integration, screenshots, and final delivery remain the
root integrator's responsibility.

## Required Packages

1. **Combat depth:** add a third selectable loadout and a production status
   system with at least burn, slow, and shield-break behavior. Every loadout must
   have two cooldown abilities, distinct targeting and hit feedback, death, and
   respawn. Statuses must affect authoritative combat rather than labels.
2. **Team strategy:** allied and enemy champions must coordinate through
   observable team signals and switch among push, defense, retreat, regroup, and
   objective contest. Add at least one real lane rotation and one objective
   handoff decision; intents must be visible and replay-observable.
3. **Economy builds:** extend the three upgrade branches with at least two
   multi-step recipes, prerequisites, prices, purchase rejection, and one legal
   sell or respec path. Owned components and derived combat stats must stay
   synchronized in authoritative state, HUD, and replay.
4. **Map operations:** retain towers, cores, inhibitors, and the neutral boss;
   add a second contested map objective with independent ownership and timer.
   Both objective families need material, time-bounded consequences that affect
   combat, economy, AI, or lane pressure.
5. **Tactical projection:** synchronize combat HUD, build state, objective
   timers and ownership, structure health, team score, AI intent, match phase,
   and tactical map. Add a compact event timeline showing real authoritative
   transitions. Title, loadout, match, pause/help, and result states must remain
   coherent at 1280x720.
6. **Replay integrity:** add deterministic state checkpoints, explicit malformed
   trace rejection, and replay evidence for every package, cross-system
   progression, both victory and defeat, and at least one full match where both
   objectives and a completed recipe affect later combat. Keep 10-12 valid
   traces, each at most 600 frames. If you include a deliberately malformed
   negative-test trace in `demo_outputs`, mark its JSON with
   `"expected_rejection": true`; accidental invalid delivery traces must remain
   rejected by the evidence gate.

## Module And Integration Gates

- Implement the required contract method in every module listed by
  `game/MODULE_CONTRACTS.md`; its capabilities must describe production behavior
  actually implemented in that module.
- Run every local check: `bash game/tools/check_module.sh <module>`.
- Run each module's local check after its final module edit, at most twice per
  module. Do not repeatedly rerun an unchanged check.
- A local check is necessary but never sufficient. All features must execute in
  normal play and through the same deterministic command and state paths used by
  replay.
- Preserve existing working behavior and module APIs until the root integrator
  adapts their consumers. Do not replace the game with demos or disconnected
  scenes.
- No feature receives credit from text, a nominal field, a disabled control, a
  pre-rendered effect, or a contract dictionary that production never uses.

## Runtime Evidence

The project must launch cleanly with:

```bash
godot --headless --path /workspace/game --quit-after 5
```

The full replay suite must exit zero, report every package, reject a malformed
trace, and derive reports from observed state changes. Use
`/workspace/tools/screenshot.sh` to inspect title, active combat, both objectives,
build/timeline UI, tactical map, and victory/defeat before finishing.

Run the full replay suite at most once after local checks pass. If it exposes a
failure, make one targeted repair and one final replay run. Do not create ad hoc
performance harnesses, repeat unchanged long tests, or spend the delivery budget
benchmarking simulation speed.

Keep pure planning under 1,000 words. Inspect the stable module contracts, then
implement and validate incrementally. The delivered game, local module checks,
whole-game replay, and visible integrated behavior are the work product.
