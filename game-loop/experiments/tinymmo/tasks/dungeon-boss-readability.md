# Tiny MMO: Production Dungeon Boss Readability

Improve the **real final-room dungeon boss encounter** in this Tiny MMO project. This is not a
standalone demo and not a mock scene. The result must be visible while playing the existing
`source/common/gameplay/maps/maps/dungeon/dungeon.tscn` through the normal
master/gateway/world/client stack.

## Problem

The final-room boss already has a server-authoritative slam and enrage, but the encounter is hard
to read in normal play:

- there is no persistent boss HUD showing name, health, phase, or the ability currently winding up;
- the body's ordinary melee attack displays its red circle in the same server tick that damage is
  resolved, so that circle describes a hit that already happened rather than a dodge opportunity;
- the slam, ordinary attack, phase transition, cancellation, and death do not expose one coherent
  encounter state to the client.

## Required production improvement

1. Add a real boss encounter HUD to the existing client HUD. It must appear when a dungeon boss
   encounter starts, show boss name and authoritative current/max health, distinguish phase 1 from
   enrage/phase 2, show the current cast with progress or remaining time, and clear on death,
   encounter abort, instance change, or disconnect.
2. Make the dungeon boss's ordinary close-range attack genuinely telegraphed. The server must lock
   the strike center/radius, announce the windup, wait a configurable positive interval, then apply
   damage only to valid targets still inside the locked area. The existing instant melee behavior
   for ordinary non-boss mobs must remain unchanged.
3. Keep the current slam authoritative and ensure every danger shape uses the exact center, radius,
   and timing used by server damage. A cancelled cast or dead/despawned boss must never deal delayed
   damage or leave stale HUD/telegraph state.
4. Preserve the existing RoomNode -> BossController production path, final-room map, replicated
   property transport, byte-packed protocol, combat mitigation, dungeon rewards, and all four
   application roles.
5. Put deterministic timing/geometry logic behind a project-local seam that accepts explicit
   timestamps. Add focused tests or a callable test API for: warning before damage, exact deadline,
   locked geometry, boundary inclusion, cancellation, and stale-token rejection.

## Observable play result

In the real final dungeon room a player should be able to answer, without reading logs:

- Which enemy is the boss and how much health remains?
- Is it phase 1 or phase 2?
- Which attack is coming, where will it land, and when?
- Did the attack land, whiff, or get cancelled?

Use the project's existing visual language and assets. Do not replace the game with a test harness,
change server damage to satisfy a visual check, or add evaluator-specific shortcuts.
