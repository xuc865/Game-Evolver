# Tri-Lane Citadel: Convergence

Extend the existing, runnable **Tri-Lane Citadel** Godot 4 project at
`/workspace/game/` into a substantially deeper MOBA vertical slice. Preserve
all working baseline behavior. This is an integration release over a real
codebase, not a rewrite, menu mock-up, or collection of disconnected demos.

The release has six independently testable work packages. Every package is
required, and normal play plus deterministic replay must prove that they work
together through the same production state and command paths.

## Required Work Packages

1. **Combat loadouts:** add at least two selectable player loadouts with
   meaningfully different attack or ability behavior. Each loadout needs two
   cooldown abilities, readable targeting and hit feedback, death, and respawn.
   Switching loadout must change actual combat state rather than labels alone.
2. **Strategic team AI:** allied and enemy champions must choose among lane push,
   defense, retreat, regroup, and objective contest based on observable threats
   and team state. At least three states must be visibly distinguishable, and AI
   must be able to change lanes or objectives during a match.
3. **Economy and build progression:** add periodic or objective income, a shop
   with at least three persistent upgrade branches, prices and purchase
   rejection, and combat-visible stat effects. The HUD and replay evidence must
   agree with the authoritative balance and owned upgrades.
4. **Map strategy:** retain lane defenses and both cores, then add an inhibitor
   or equivalent lane objective plus a contested boss or neutral objective. Each
   objective must have a material, time-bounded gameplay consequence and affect
   AI decisions, combat, economy, or minion pressure.
5. **Synchronized tactical UI:** provide a readable combat HUD, shop state,
   objective timers and ownership, structure health, team score, AI intent, and
   match phase. Add a compact tactical map or equivalent whole-field status view.
   Title, active match, pause/help, loadout selection, and result states must be
   coherent and navigable.
6. **Whole-scene replay verification:** preserve deterministic command routing
   and add replay evidence for every work package, cross-system progression, and
   both victory and defeat. Reports must be derived from observed state changes;
   a manifest claim, scenario-only fake, or trace that merely waits is invalid.

## Integration Contract

- Keep the existing project runnable while extending it. Do not replace working
  subsystems with smaller placeholders or disable baseline behavior.
- Work-package boundaries are ownership boundaries, not isolated mini-games.
  Their outputs must integrate through the authoritative match state.
- Shared-state changes need explicit compatibility checks at their consumers.
- No feature receives credit from text, a disabled control, a pre-rendered
  animation, a nominal JSON field, or code that normal play never executes.
- A clean headless launch is necessary but not sufficient. Parse errors, ignored
  input, unchanged probe state, or missing result transitions fail verification.

## Execution Discipline

Keep pure planning under 1,000 words. Inspect enough of the existing code to
identify stable ownership boundaries, then implement and validate incrementally.
Do not spend an entire response only describing architecture. Delivered files,
observable gameplay, and executable evidence are the work product.

## Presentation

Retain the readable top-down battlefield and improve its visual hierarchy. Teams,
lanes, structures, projectiles, ability effects, objective zones, selection and
damage feedback, AI intent, tactical overview, and HUD state must remain legible
at a glance. New systems should make the game visibly richer without obscuring
live combat.

## Runtime And Evidence

The project must launch cleanly with:

```bash
godot --headless --path /workspace/game --quit-after 5
```

Create 8-12 valid traces in `/workspace/game/demo_outputs/`. Together they must
exercise both loadouts, all strategic AI states, purchases and rejection,
objective capture and expiry, inhibitor or lane-pressure effects, tactical UI
state, cross-system match progression, and both victory and defeat. Replay
duration is capped at 600 frames per trace.

Trace schema:

```json
{
  "scenario": "loadout_objective",
  "duration_frames": 480,
  "events": [
    {"frame": 20, "type": "key_press", "keycode": "2"},
    {"frame": 80, "type": "mouse_click", "button": "left", "x": 700, "y": 360},
    {"frame": 120, "type": "key_press", "keycode": "Q"}
  ]
}
```

Supported events are `mouse_click`, `mouse_down`, `mouse_up`, `mouse_move`,
`key_press`, `key_down`, `key_up`, and `wait`. Supported keycodes include letters,
digits, arrows, `SPACE`, `ENTER`, `ESCAPE`, `TAB`, `SHIFT`, and `CTRL`.

Use `/workspace/tools/screenshot.sh` to inspect actual title, gameplay, tactical
UI, objective, shop, and result frames before finishing. Engine flags precede
`--`; scenario arguments follow it:

```bash
/workspace/tools/screenshot.sh --path /workspace/game \
  -- --out /workspace/convergence.png --frames 240 --scenario loadout_objective
```
