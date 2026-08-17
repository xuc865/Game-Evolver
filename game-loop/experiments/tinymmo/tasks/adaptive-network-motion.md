# Improve Tiny MMO network motion quality

Improve the experience of observing remote players and server-driven NPCs under realistic MMO latency, jitter, and short packet stalls. The current fixed-delay snapshot interpolation removes most stepping, but it holds the newest position when starved and cannot adapt its buffer delay to changing arrival variance.

Implement a production-quality, bounded improvement centered on `NetMotionSmoother` and its existing player/NPC integration.

## Required behavior

- Preserve first-sample and teleport snapping, scripted motion overrides, local-player authority, the byte-packed wire protocol, and both player and NPC synchronization routes.
- Estimate stream interval and arrival jitter with stable bounded statistics, then derive a clamped effective interpolation delay. Avoid per-frame allocations and unbounded sample history.
- When interpolation samples are briefly exhausted, use conservative velocity extrapolation for a bounded horizon, then hold. Never extrapolate teleports or across scripted-motion overrides.
- Keep the existing `push_sample(Vector2)` API. Add deterministic seams `push_sample_at(Vector2, arrival_ms: int)` and `sample_at(presentation_ms: int) -> Vector2`. `sample_at` must sample exactly the supplied presentation-timeline timestamp; the production `sample`/`_process` path applies the effective interpolation delay before delegating. Do not subtract the delay again inside `sample_at`.
- Expose `get_metrics() -> Dictionary` containing at least `sample_count`, `jitter_ms`, and `effective_delay_ms` for diagnostics. This must be observational and cheap.
- Add focused, deterministic Godot tests covering interpolation, jitter adaptation, bounded extrapolation, teleport reset, and override handoff.

## Quality bar

Do not replace the architecture or add a second networking stack. Keep the implementation compact, typed, and documented. Validate the project in Godot 4.6.3 and run the focused tests before finishing.
