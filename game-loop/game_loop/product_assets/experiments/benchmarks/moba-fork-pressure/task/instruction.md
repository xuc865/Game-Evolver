# Tri-Lane Citadel

Build **Tri-Lane Citadel**, a polished top-down 2D micro-MOBA in Godot 4 at
`/workspace/game/`. This is a complete vertical slice, not a menu mock-up or a
single-mechanic prototype. All six required systems below must work together in
normal play and remain independently observable in deterministic replay.

## Match

The player and an allied AI champion defend a blue core against two enemy AI
champions and recurring minion waves. Three lanes connect the two bases. The
player can move, basic-attack, and cast at least two cooldown abilities. Units
select targets, take damage, die, and respawn where appropriate. Destroying the
enemy core wins; losing the allied core loses.

## Required Systems

1. **Combat:** movement, targetable attacks, two distinct abilities, cooldowns,
   damage feedback, death, and champion respawn must be functional.
2. **Autonomous AI:** allied and enemy champions plus minion waves must navigate,
   select targets, fight, push lanes, and react to nearby threats without player
   input. At least two AI behavior states must be visibly distinguishable.
3. **Economy and progression:** combat awards currency or experience. The player
   can spend earned resources on at least two persistent match upgrades whose
   effects are observable in combat.
4. **Map objectives:** each side has lane defenses and a core. Add one contested
   neutral objective that grants a temporary team advantage. Objective ownership
   must materially affect the match.
5. **Synchronized UI:** the HUD must continuously reflect authoritative gameplay
   state for health, resources, ability cooldowns, upgrades, objective ownership,
   structures, score, and match phase. Title, active match, pause/help, and result
   states must be coherent and navigable.
6. **Full replay verification:** ship deterministic input traces that exercise
   every system above and visibly change state. A trace that merely waits, opens a
   static screen, or claims coverage without causing observable change is invalid.

No required system may be represented only by text, a disabled control, a
pre-rendered animation, a manifest entry, or a scenario-specific fake. Named
scenarios may establish deterministic starting state, but replayed input must
exercise the same production logic used in normal play.

## Execution Discipline

Keep pure planning under 1,000 words. After at most five inspection calls, use
workspace tools to write a runnable gameplay baseline, then implement and verify
the remaining systems incrementally. Do not spend an entire model response
describing architecture or drafting code only inside reasoning; delivered files
and executable evidence are the work product.

The seed includes `SYSTEM_CONTRACT.md` and six incomplete modules under
`scripts/`. Treat those boundaries as a starting point, not completed features:
implement and integrate them one at a time, keeping the project runnable between
changes. A loading file, placeholder return, TODO, or isolated demo is not a
completed subsystem.

## Presentation

Use a readable battlefield with clearly differentiated teams, lanes, structures,
projectiles, ability effects, selection and hit feedback, animated units, and a
professionally composed HUD. The player should understand the live tactical state
without reading implementation notes.

## Runtime And Evidence

The project must launch cleanly with:

```bash
godot --headless --path /workspace/game --quit-after 5
```

Create 6-10 valid traces in `/workspace/game/demo_outputs/`. Together they must
cover title-to-match flow, live combat and abilities, autonomous lane behavior,
economy/upgrades, the neutral objective, structure/core resolution, HUD state
changes, and both a meaningful match progression and result transition. Replay
duration is capped at 600 frames per trace.

Trace schema:

```json
{
  "scenario": "combat",
  "duration_frames": 360,
  "events": [
    {"frame": 30, "type": "key_press", "keycode": "Q"},
    {"frame": 120, "type": "mouse_click", "button": "left", "x": 700, "y": 360}
  ]
}
```

Supported events are `mouse_click`, `mouse_down`, `mouse_up`, `mouse_move`,
`key_press`, `key_down`, `key_up`, and `wait`. Supported keycodes include letters,
digits, arrows, `SPACE`, `ENTER`, `ESCAPE`, `TAB`, `SHIFT`, and `CTRL`.

The screenshot helper is available at `/workspace/tools/screenshot.sh`; use it to
inspect actual title, gameplay, objective, upgrade, and result frames before
finishing. Engine flags must precede `--`; scenario arguments follow it:

```bash
/workspace/tools/screenshot.sh --path /workspace/game \
  -- --out /workspace/combat.png --frames 180 --scenario combat
```
