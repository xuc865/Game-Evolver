# Tiny MMO: Production Dungeon Boss HUD

Implement one bounded improvement in the existing Tiny MMO production game: a persistent boss
encounter HUD for the real final-room dungeon boss.

Do not create a demo project, alternate main scene, mock boss, or local-only preview. The feature
must run through the existing `RoomNode -> BossController -> WorldServer data_push -> client HUD`
path while playing `source/common/gameplay/maps/maps/dungeon/dungeon.tscn` through the normal
master/gateway/world/client stack.

## Server state

Have `BossController` publish a `boss.state` encounter payload to players in its instance. It must
contain a stable encounter/boss id, display name, authoritative current and maximum health, phase
(phase 1 versus enraged phase 2), current cast name, cast start/deadline timestamps, and an explicit
active/ended state. Include a monotonically increasing per-encounter revision so clients can reject
out-of-order packets. Cast countdown must not assume the client and server `Time.get_ticks_msec()`
clocks share an epoch: include server-now, remaining duration, or another explicit synchronization
basis. Publish at encounter start, meaningful health changes, cast start/end,
phase transition, death, and abort/removal. Avoid an unbounded every-frame reliable RPC stream.
While an encounter is active, also resend the authoritative state on a bounded low-frequency
heartbeat every 1-2 seconds. This lets clients that subscribe after the boss's initial spawn push
recover without waiting for damage or a cast. Event-driven updates and encounter-end updates must
remain immediate. Do not send a reliable `boss.state` RPC every frame.

## Client HUD

Integrate a `BossEncounterHUD` into the existing production HUD. It must visibly show boss name,
health bar plus numeric current/max health, phase, and current cast with progress or remaining time.
Use existing theme conventions and keep it readable at the project's 960x540 base viewport.
Ignore stale encounter updates. Hide and reset on boss death/end, instance change, disconnect, or
return to gateway. Do not infer authoritative health or phase client-side.

## Boundaries and verification

Preserve the final dungeon scene, RoomNode/BossController ownership, all server roles, combat
damage, rewards, replicated-property transport, and byte-packed protocol. Run full Godot headless
editor validation. Add a focused project-local test only if it does not break normal project import.

Deliver the minimal end-to-end slice first: server payload, client subscription, visible HUD. Do not
spend the session building a generic combat framework before those three pieces compile.
