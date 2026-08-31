# Tournament Module Contracts

The production game is composed through `Main.gd`, but each subsystem owns one
stable implementation boundary. A subsystem change may be implemented and
locally checked without editing another subsystem or `Main.gd`; the root
integrator owns shared-interface adaptation and whole-game verification.

| Module | Owned file | Required contract method | Local check |
| --- | --- | --- | --- |
| combat | `scripts/combat_system.gd` | `contract_status_effects()` | `bash game/tools/check_module.sh combat` |
| ai | `scripts/ai_system.gd` | `contract_team_strategy()` | `bash game/tools/check_module.sh ai` |
| economy | `scripts/economy_system.gd` | `contract_build_recipes()` | `bash game/tools/check_module.sh economy` |
| objectives | `scripts/objective_system.gd` | `contract_map_objectives()` | `bash game/tools/check_module.sh objectives` |
| hud | `scripts/hud_system.gd` | `contract_tactical_projection()` | `bash game/tools/check_module.sh hud` |
| replay | `scripts/replay_system.gd` and `demo_outputs/*.json` | `contract_replay_integrity()` | `bash game/tools/check_module.sh replay` |

Every contract method returns a dictionary with:

- `contract`: the exact module name from the table.
- `version`: integer `2`.
- `capabilities`: at least three non-empty capability identifiers implemented
  by production code in that owned module.
- `local_checks`: at least one non-empty check identifier exercised by the
  module's implementation or its deterministic traces.

The contract dictionary is an introspection surface, not feature evidence by
itself. Full credit still requires normal play and replay to exercise the same
production paths and authoritative state.

## Ownership

- A module owner may change only its owned file(s).
- Existing shared state keys and callable methods remain compatible until the
  root integrator explicitly adapts consumers.
- The root integrator owns `Main.gd`, scenes, cross-module state wiring,
  integration fixes, full replay, screenshots, and final delivery.
- A local module check proves parseability and the declared API only. It never
  replaces the whole-game launch, replay, or visual checks.
