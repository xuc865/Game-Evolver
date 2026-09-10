# replayeval — pricing bot policies against recorded games

`tools/replayeval.mjs` is the instrument BOT-STRATEGY round 12b names as missing. The two
instruments that existed could not answer "does this change make a bot stronger against
the games people actually play?": `simbalance` divides a fixed pot among bots, so a change
that strengthens every seat moves nothing in it, and production A/B at ~100 games/week
cannot resolve a 3–5pp effect inside a season. This tool rebuilds the exact engine states
recorded games passed through and prices a candidate policy with paired rollouts from
those states. On the current production corpus that is **13,828 real decision points**
from 153 games, and a full-corpus pricing run takes under a minute.

## What it does

1. **Reconstruction.** A gamelog record's event stream is replayed through the real
   engine — every command re-issued via `game.js` itself (`playAsMoney`, `playAction`,
   `respondToAction`, `endTurn`, …), nothing re-implemented. Draws are "rigged" so the
   deck yields the recorded cards: directly on the deck top, or — when the record shows a
   reshuffle — via a planned Fisher–Yates permutation handed to the engine's own RNG, so
   the engine still performs its own shuffle, event and cycle-count included. Every
   emitted event is compared field-by-field against the record as it happens, and the
   final boards, winner, end reason and turn count are compared at the end. **A game is
   reconstructed exactly or rejected — never approximated.**

2. **Decision points.** At every play-phase choice of a focus seat (its turn, no pending
   action), the full state is snapshotted along with the action actually taken.

3. **Determinized paired rollouts.** From a decision point the only unknown is the deck
   order: hands are known (the retained event stream is unredacted), and the deck's
   multiset is `buildDeck(rules.deck)` minus every visible card. Each rollout samples a
   fresh uniform order of exactly that multiset — the true conditional distribution given
   uniform shuffles — and both arms share the determinization seed and the bot-RNG seed,
   so a delta is measured inside matched worlds.

4. **Aggregation.** Mean win-probability delta per evaluated point, with a 95% cluster
   bootstrap CI resampling **games** (decision points inside one game share a trajectory
   and are not independent).

## How to run it

```sh
# The reconstruction gate (exits nonzero on any inexact game):
node tools/replayeval.mjs --log logs/production-games.jsonl --verify

# Price a candidate at the neutral bot's real production decision points:
node tools/replayeval.mjs --log logs/production-games.jsonl \
  --subject cashfloor:neutral --baseline neutral --focus neutral --rollouts 24

# One-step deviation against what the human actually played:
node tools/replayeval.mjs --log logs/production-games.jsonl \
  --subject neutral --baseline recorded --focus human --rollouts 16
```

Policies: the five lobby personas plus `humanlike`, `persona@scale` variants, and
evaluation-only wrappers (defined inside `tools/lib/replay.js`; **bot.js live behavior is
untouched** — a test asserts it). `--baseline recorded` compares the subject's first
action against the recorded one with both arms continuing under identical policies
(isolates the decision); a policy baseline rolls each arm's seat under its own policy for
the whole continuation (prices a persistent change).

* `cashfloor:<mode>` — round 12b's rejected cash floor: substitute a bank play for a
  NON-COMPLETING property play while the bank cannot cover the largest charge the table
  can print at us (max opponent rent, floor 5M for Finance Office).
* `nocompleter:<mode>` — deliberately lobotomized (refuses set completions); exists to
  prove the instrument discriminates.
* `sandbag@<weight>:<mode>` — §3.10j sandbagging through **bot.js's own shelved
  implementation** (`setSandbag`/`sandbagGate`/the once-per-turn cached roll), not a
  re-derivation. The module-global flag is arm-scoped: enabled immediately before each
  `decide()`/`chooseDiscards()` this policy makes and restored to defaults after, so it
  cannot leak into the other arm or a continuation seat. Leak-proofed by a gate:
  `sandbag@0` vs the bare persona is EXACTLY zero (a zero weight consumes no rnd() by
  `sandbagGate`'s own design), and the flag is asserted off after a whole evaluation.
* `rentlev:<mode>` — round 12's closing note (§3.10f direction) as a policy. EXACT
  definition: when the base policy chose a build/bank play (`play_money`, or a
  `play_property` that does not complete a set) AND an opponent is in the window —
  non-eliminated, not on final approach, holding exactly `setsToWin - 1` completed sets,
  bank ≤ 9M, at least one payable card (round 10: never a charge that collects
  nothing) — substitute the best collectible charge in hand aimed at them: wild rent at
  our highest-rent color (rent > 0) > Finance Office > color rent (rent > 0; the window
  seat is in every color rent's blast) > Roll Call. Everything else the base chose —
  its own charges, completions, breaker shots, defense, rearranges, passes — is
  untouched. Deterministic; consumes no rnd().

## Validation (2026-08-20, this corpus)

* **Exactness:** 118/118 loadable dev-corpus records reconstruct exactly; 153/153
  production records reconstruct exactly. The 115 dev records with seeds ALSO replay from
  bare `(seed, rules, seats)` with every drawn card matching the record — proving both
  record fidelity and the command inference, independently of the rigging.
* **Mutation-proved:** a tampered draw or tampered final board is rejected
  (`test/replayeval.test.js`).
* **Null:** identical subject and baseline return a delta of **exactly zero** — and this
  gate caught a real defect on first run (per-arm decide() RNG streams manufactured
  divergence between identical policies; both arms now share the stream).
* **Discrimination:** a policy lobotomized to refuse set completions prices −33pp against
  its base; `random` prices −14.0pp [−16.1, −12.8] against `aggressive` at human decision
  points. Wrapper knobs are asserted to have fired before any delta is believed
  (round 13's identical-numbers-means-broken-harness lesson).
* **Known ordering reproduced from real data:** `aggressive` prices **+3.23pp
  [+1.46, +4.94]** over `neutral` at neutral's production decision points — the same
  ordering the production win rates show (28.6% vs 10.7% in round 12b's paired tables).

## First real use: the cash floor, re-priced

Round 12b measured the strongest human-behavior finding in the corpus — humans bank up
and lose half as much board to payments as neutral does — implemented a cash floor three
ways, found a real cost in bot-vs-bot play and an unmeasurable benefit, and rejected it
pending "the missing instrument". With the instrument:

> **cashfloor:neutral vs neutral**, at neutral's 831 divergent production decision
> points, 24 paired rollouts each: **−6.67pp, 95% CI [−7.97, −5.48]**.

The floor is not an unpriceable trade-off; it is measurably worse at the very states
production neutral actually faced. The rejection stands, now with a number on it.
(The wrapper re-derives round 12b's first cut — "bank while the bank cannot cover the
largest charge the table can print at you", completions exempt — from its description;
the original experimental diff was never committed.)

## Second use: the two remaining shelved ideas, re-priced (2026-08-20)

All runs on the production corpus at the subject mode's own decision points (neutral:
3,236 points / 153 games; aggressive: 2,035), `--rollouts 24` divergence-gated and
`--rollouts 12` whole-trajectory (`--at all`), cluster bootstrap CIs by game.

**Sandbagging (§3.10j), priced through its own shelved implementation:**

| run | divergent pts | delta | 95% CI |
|---|---:|---:|---|
| sandbag@0.20:neutral (gated) | 2 / 3,236 | +4.17pp | [−8.33, +16.67] |
| sandbag@0.52:neutral (gated) | 3 / 3,236 | +4.17pp | [0, +8.33] |
| sandbag@0.90:neutral (gated) | 4 / 3,236 | +0.00pp | [−6.25, +8.33] |
| sandbag@0.52:aggressive (gated) | 4 / 2,035 | +1.04pp | [0, +3.12] |
| **sandbag@0.52:neutral, whole-trajectory, all 3,236 points** | held 624× | **+0.05pp** | **[0.00, +0.10]** |

The structural finding is the divergence column: **the sandbag gate almost never opens
at real production states** — 71 of the 153 games play `instant`/`mdFaithful`, which the
winrule valve refuses outright, and the bank/shield/hand-limit/no-breakers valves close
most of the rest. Applied persistently across every real neutral decision point it is
**flat (+0.05pp)** — round 13's simhuman null, confirmed at real states by a second
independent instrument. Twice measured, twice null: `SANDBAG_ENABLED = false` stands.

**Rent-leverage window (round 12's closing note), per the wrapper definition above:**

| run | divergent pts | delta | 95% CI |
|---|---:|---:|---|
| rentlev:neutral (gated) | 17 / 3,236 | −1.72pp | [−5.28, +3.47] |
| rentlev:aggressive (gated) | 2 / 2,035 | −2.08pp | [−4.17, 0] |
| **rentlev:neutral, whole-trajectory** | fired 5,561× | **+0.73pp** | **[+0.57, +0.88]** |
| **rentlev:aggressive, whole-trajectory** | fired 1,666× | **+0.33pp** | **[+0.20, +0.48]** |

A real effect, and an instructive one: single substituted moves price as noise (the
window is rare at any one decision, and the base plan already fires the profitable
charges — the wrapper's surface is the marginal 1–2M charge the plan declines), but the
policy applied **persistently** is worth a small, CI-clean positive for both personas.
Read with the standing caveat — deltas under bot continuation play rank policies, and
+0.7pp is far below the +3.0pp pre-registered bar §3.10j set for shipping a behavior
change. This is "directionally right, not yet worth a live code change" — exactly what
the round-12 note predicted ("§3.10f is the first move in that direction and it is a
small one; the real version needs a charge to reach a player through something other
than a wild rent").

Runtimes: divergence-gated runs 0.6–1.1s each; whole-trajectory runs 31–42s each.

## Limits — read before quoting numbers

* **Deltas are priced under bot continuation play.** Human seats are continued by
  `humanlike` (round 13's instrument: a good behaviour clone, a poor strength clone), bot
  seats by their recorded modes. Like `simhuman`, this **ranks** policies; it does not
  certify difficulty against a live human. A CI excluding zero is a real ordering at real
  states; the magnitude is a proxy.
* **Records must be complete.** A stream truncated by the engine's 400-event retention
  cap has lost its opening deals and is skipped (11 of the current production file), as
  are pre-`779b1a1` legacy walkovers whose ending was never written as an event (1).
* **A blocked steal never reveals its named target card**; the replay substitutes a legal
  one. The post-block state is identical either way; only the transient pendingAction
  differs, and no decision point is captured while a pending action is live.
* **Response decisions** (OPSEC, payment composition) are replayed exactly but not yet
  offered as evaluation points — play-phase decisions only.
* Rollouts cap at 300 turns; an unfinished rollout counts as a non-win for the seat.

## Cost

Reconstruction of the full production corpus: ~0.6s. Pricing: roughly
`evaluated-points × 2 × rollouts` playouts; the cash-floor run above (831 × 48 ≈ 40k
playouts) took 26s. `--max-points` and `--rollouts` trade power for time; `--at all`
evaluates non-divergent points too (they contribute exact zeros under a shared seed —
variance reduction, at playout cost).
