# Bot Foresight — why the CHUD card is always gone by the time it matters

Date: 2026-08-12. **Research and proposal only — no engine or bot changes are made by this
document.** *(Status: SHIPPED. Round 12 in `BOT-STRATEGY.md` implements P1, P2, P4, P5a and
part of P3, records what each one actually measured — including the OPSEC bait, which measured
NULL — and states why the lap-aware grace-cycle charge was cut before implementation. Read the
round for the outcome; this file is the diagnosis that preceded it and its numbers are the
pre-change baseline.)* Owner ask: *"it feels like they don't plan too far ahead and will just use cards
like the CHUD card or Inspector General instead of saving them to break final approaches …
even doing things like trying to charge as much rent as possible to someone in final approach
so they have to give up some of their sets."*

Both halves of that ask are checked below against the running bots. **The first half is
correct and the effect is larger than it feels.** The second half is correct as an intent but
the mechanism named cannot work as stated, and the measurement says why — the right version of
it is a different card played twenty turns earlier.

Everything numeric here is produced by `tools/botaudit.mjs`, over the same seeded lineup grid
`tools/simbalance.mjs` uses (every 4-subset of the five personalities × every seat, 400 games,
`finalApproach` default rules). It observes and never alters a decision, so it re-runs against
any tree for a before/after:

    node tools/botaudit.mjs --games 400          # the numbers in this document
    node tools/botaudit.mjs --games 400 --json   # scriptable before/after

Baseline verified at commit `338902b`. `simbalance --games 600 --seed r12base` at the same
tree: random 14.6 / conservative 31.9 / neutral 30.6 / aggressive 35.4 / chud 12.5, avg 33.2
turns, 0.83% stalemates, first-player advantage 28.3%.

## Contents

- [1. What the measurements say](#1-what-the-measurements-say)
- [2. What competitive Monopoly Deal play says](#2-what-competitive-monopoly-deal-play-says)
- [3. Proposals, ranked](#3-proposals-ranked)
- [4. The one that cannot work as asked, and its replacement](#4-the-one-that-cannot-work-as-asked-and-its-replacement)
- [5. Implementation constraints this file must not break](#5-implementation-constraints-this-file-must-not-break)
- [6. Sources](#6-sources)

---

## 1. What the measurements say

### 1.1 The ammunition is spent before the fight starts

1,858 hard-breaker plays (Inspector General + THE CHUD CARD) across 400 games — 4.64 per game
against a deck that contains 4 of them, so each one is fired, reshuffled and fired again.

**When they get fired, measured by the best set count anybody else has on the table at that
instant:**

| Table state when the breaker is fired | Shots | Share |
|---|---:|---:|
| Nobody has a single complete set | 152 | 8.2% |
| Best opponent has 1 set | 582 | 31.3% |
| Best opponent has 2 sets — the real threat band | 658 | 35.4% |
| Somebody is on FINAL APPROACH | 466 | 25.1% |
| **Nobody at 2+ sets and nobody armed** | **734** | **39.5%** |

**Two out of every five breakers are fired at a table where nobody is within one set of
winning.** By personality:

| Mode | Breakers fired | Fired at a no-threat table | Banked for cash |
|---|---:|---:|---:|
| aggressive | 369 | 200 (**54.2%**) | 20 |
| neutral | 383 | 176 (**46.0%**) | 11 |
| chud | 400 | 183 (45.8%) | 2 |
| random | 371 | 135 (36.4%) | 3 |
| conservative | 335 | 40 (11.9%) | 7 |

Conservative is already doing roughly the right thing. **The complaint is specifically about
neutral and aggressive**, and they are the two personalities a human meets most often.

23.0% of all shots took a card that was neither in a complete set nor one we needed to finish
our own — a 1M orphan grab with the strongest card in the deck.

**And 41% of every breaker that lands gains the firing bot nothing at all.** Only 14.9% of
landed shots take the firer to `setsToWin` — roughly one breaker in seven is a shot that wins
or arms the shooter. The split is entirely by card type:

| | shots that landed | of which advanced our own set count |
|---|---:|---:|
| Inspector General | 811 | **98.8%** — it is a whole set, by construction |
| THE CHUD CARD | 795 | **18.0%** |

652 of 795 landed CHUDs take a card that completes nothing of ours. `findSmartChudTarget`
(`bot.js:2159`) is optimising pure denial. **This means IG and CHUD need different worth-it
bars, not one shared bar** — IG's question is only *when*, because the set is always a gain;
CHUD's question is *whether*, because four times in five it is not.

### 1.1a Who is firing the wasted shots — and why the "it advances our own win" rule is a bar

The escrow proposed in §3 lets a breaker through when it gains us a set *and* lands us at
`setsToWin - 1` or better. The obvious objection is that at `setsToWin = 3` this opens the gate
at one completed set, i.e. most of the mid-game — a loophole rather than a bar. Measured on the
734 no-threat shots, by the FIRER's own completed-set count at that instant:

| Firer's own sets | No-threat shots | Share | of which the shot would gain us a set |
|---|---:|---:|---:|
| **0** | **475** | **64.7%** | 261 |
| 1 | 175 | 23.8% | 114 |
| 2 | 79 | 10.8% | 51 |
| 3+ | 5 | 0.7% | 4 |

**Two thirds of the wasted shots are fired by a bot with no completed set of its own** — which
is precisely the "why did that bot play Inspector General on turn 2" complaint, and it is
self-limiting under the rule: a 0-set bot that gains one set lands at 1, below `setsToWin - 1`,
so the shot is held. Restricted to the three planning personalities (416 of the 734 shots):

- would still fire at `BREAKER_SELF_MARGIN = 1`: **115, 27.6%**
- would still fire at the stricter `= 0` (only a shot that outright wins or arms us): 46, 11.1%
- **held by the escrow at margin 1: 301, 72.4%**

Margin 1 is therefore a bar. It is kept as a named constant so the stricter setting is one edit
away if the balance run says otherwise.

**A target correction while we are here.** §3's P1 named "under 15%" for the no-threat share.
That is unreachable table-wide and chasing it would cost personality distinctness: chud and
random fire 318 of the 734 shots (43%) and must keep doing so — reckless is their identity.
**The metric is the PLANNER no-threat share**, and the table-wide number is reported alongside
it as a health check, not a target.

### 1.2 The consequence: the break branch is a branch that mostly cannot fire

`tryBreakFinalApproach()` in `bot.js:196` is well built — it picks the victim by
`checkpointForecast` rather than by set count, it knows Surge doubles rent only, it stacks
charges. It is also, most of the time, holding an empty gun:

- At the moment a player arms, **2.23 of the deck's 4 hard breakers are already in a bank or
  the discard pile.**
- **71.6% of armings (444 of 620 first-armings) face a table where not one opponent holds a
  breaker in hand.**
- Across every opponent turn taken while somebody is armed, only **19.5%** had a breaker
  available to the acting bot.

44.2% of armings do get shot down (392 of 886 arming events), so the machinery works when it
is loaded. The problem is upstream of it: the personality planners at `bot.js:1305` (aggressive
step 3–4) and `bot.js:1628` (`tryOffensiveActions`, used by neutral and conservative) fire
IG/CHUD as soon as `findBestIGTarget` / `findSmartChudTarget` returns *any* legal target. There
is no test anywhere asking whether the shot is **worth the card** — only whether it is **legal**.

The single existing guard is the veto at `bot.js:971`, which stops a bot *banking* a breaker
while somebody is armed. It fires far too late: by then the card is usually gone.

### 1.3 They also walk into the shield

16.4% of fired breakers are eaten by an OPSEC. No bot has ever tried to draw the shield out
first, though it holds cheap actions that would do it.

*(Corrected 2026-08-12: this section first read 14.7%, counted with an end-of-game
`state.events.filter(...)`. `EVENT_LOG_MAX` is 400 and the log is spliced off the FRONT
(`game.js:526`), so any long game silently drops its early blocks. `tools/botaudit.mjs`
counts against a sequence watermark instead and prints both figures.)*

### 1.4 Armed players arm naked

At the moment a bot completes its winning set:

- bank: **median 13M**, mean 16.0M
- loose (non-set) property: median 9M, mean 9.7M
- holding an OPSEC to defend the lap it just invited: **22.2%**

Mean arming turn is 30.7 of a ~33-turn game, so the arm is nearly always the last thing that
happens — the grace cycle *is* the endgame, and bots enter it unprepared 78% of the time.

---

## 2. What competitive Monopoly Deal play says

Chudopoly's IG is Deal Breaker, CHUD is a Deal Breaker that reaches single cards, OPSEC is Just
Say No, Midnight Requisition is Sly Deal, TDY Orders is Forced Deal, Finance Office is Debt
Collector, Roll Call is It's My Birthday, Surge Ops is Double The Rent. The strategy field is
unanimous on five points, and the bots implement one and a half of them.

| Principle in the field | Chudopoly translation | Bot status |
|---|---|---|
| Deal Breaker is a **reactive** card. Hold it for the moment an opponent can win; stealing a complete set reverses the game instantly. | Hold IG/CHUD until somebody is at `setsToWin - 1` or armed | **absent** — 39.5% fired at no-threat tables |
| **Bait the Just Say No** with a cheaper steal, then fire the Deal Breaker into an empty shield. | Midnight Requisition / TDY first, then IG/CHUD | **absent** — 16.4% of breakers blocked |
| **Escort** the Deal Breaker with your own Just Say No so the steal cannot be answered. | Hold an OPSEC when firing a breaker | **absent** |
| Fire at players **who cannot answer** — empty or thin hands. | Prefer victims with small hands / a dead OPSEC pool | **half** — `tryGuaranteedBreaker` covers the "whole pool visible" case only |
| Attack the **property-rich, bank-poor** player. Debt Collector is an early/mid card: it does most damage before reserves build. | Charge selection weighted by the target's *cushion*, not by what it collects | **inverted** — `rentYield` picks by collectable value, which prefers rich targets |
| **Do not complete your final set until you can defend it.** A completed set is a Deal Breaker target; keep the last card in hand. | Arming discipline under §3.10 | **absent** |
| **Steal the card that completes your set, then charge rent on it the same turn.** | CHUD/MR → rent sequencing | **absent** — `findChargeBooster` sequences upgrades and hand properties before a rent, but never a steal |
| Target the leader. | leader-first targeting | **present** (round 11, angle 4) |
| Bank before you build. | bank-first opening | **present-ish** |

The two things the field treats as the *whole skill* of the card — reactive timing and shield
management — are exactly the two the bots have none of. That is what "doesn't plan ahead"
feels like from the other side of the table.

---

## 3. Proposals, ranked

Ranked by (visible improvement in feel) × (confidence it works), divided by risk. Each carries
the number it should be measured against, because §3 does not accept a change that only sounds
right.

### P1 — Breaker escrow. **Highest impact, and it is the owner's exact complaint.**

One chokepoint, in the shape of the existing `bot.js:971` veto rather than five patches:
before any personality plan is allowed to return an IG/CHUD play, the shot must clear a
worth-it bar, not just a legality bar.

Fire immediately when any of these hold — these are the shots that are already correct:

- the target is **armed** (`tryBreakFinalApproach` already owns this and runs first)
- the steal **completes our own set** *and* that set is our `setsToWin`-th — it wins or arms us
- the target is at **`setsToWin - 1` or more sets** and the shot comes out of a complete set
- `unseenCounts().opsec === 0` — the guaranteed-shot branch at `bot.js:422`, unchanged

Otherwise **hold**, with three pressure valves so the card cannot rot in hand:

- **Release when the reserve is deep.** `unseenCounts().breakers >= 2` means another will come;
  hold loosely. Holding the *last* live breaker is where the discipline should be absolute.
- **Release on the deck clock.** `state.shuffleCount >= G.DECK_CYCLE_LIMIT - 4` — §3.11 is about
  to end the game on points and there is no "later" to save for. This concept already exists in
  `decideBotPlay`'s `clockRunning`.
- **Release at the hand limit.** If the card is about to be discarded anyway, spend it.

Per-personality, because five modes that all count cards are one mode:
`BREAKER_PATIENCE = { conservative: 0.95, neutral: 0.8, aggressive: 0.5, chud: 0.15, random: 0 }`.
Aggressive stays trigger-happy — that is its identity — but even at 0.5 it stops firing at
0-set tables, which is where 200 of its 369 shots go today.

**Dependency, and it is a real one:** `chooseDiscards` (`bot.js:2524`) sorts
`inspector_general` and `chud` to the *front* of conservative's discard pile. Tell conservative
to hold a breaker and it will hold it right up to the hand limit and then throw it away. Both
kinds have to move behind money in that comparator, or P1 makes conservative worse.

**Measure:** the PLANNER no-threat share (see §1.1a — table-wide is floored near 23% by chud
and random, who keep their recklessness by design); breakers live in hand at arming
(target: 71.6% of armings facing none → under 45%); and — the number BOT-STRATEGY warns about —
`pointsRate` and `avgTurns` from `simbalance`, because every break-rate buff so far has
lengthened games. §3 bounds (8%–60% win rate) are the hard gate.

### P2 — Bait the shield

When a bot holds a breaker **and** a cheap targeted action (Midnight Requisition, TDY Orders,
Finance Office) **and** ≥2 plays remain **and** the intended victim plausibly holds OPSEC
(`unseenCounts().opsec > 0 && victim.hand.length >= 4` is the honest public-information proxy —
no peeking at hands), play the cheap card at that victim *first*. If it draws the OPSEC, the
breaker lands clean; if it does not, we made a steal we wanted anyway.

This is the single most **legible** change on the list. A human who watches a bot poke them
with a Midnight Requisition, eat the OPSEC, and then take their whole set will feel outplayed
in a way no win-rate delta communicates.

Patience axis again: conservative and neutral bait, aggressive does not have the temperament,
chud and random never.

**Measure:** breaker block rate (16.4% → target under 10%), and plays-per-breaker-landed, which
must not blow up — the bait costs a play and that is the whole risk.

### P3 — Cushion warfare: attack the wallet *before* the arm

See §4 — this is the correct form of the owner's rent idea, and it is a mid-game posture, not
an endgame reflex.

### P4 — Steal → rent sequencing

`findChargeBooster` (`bot.js:2003`) already runs a dependency pass so an Upgrade or a hand
property lands *before* the rent that it raises. It does not consider a **steal** as a booster.
A CHUD or Midnight Requisition that takes the card completing our colour, followed by rent on
that now-complete set, is the largest single-turn swing available in the deck — and it gives
the escrowed breaker of P1 a high-value use, which is what makes holding it feel like patience
rather than paralysis.

Note for whoever implements it: `simulate.js`'s combo tracker counts `stealAfterRent`. That is
the *wrong order* and it is why this gap has never shown up in a report — the valuable combo is
steal-then-rent.

**Measure:** add a `stealThenRent` combo counter, and rent collected per rent card played.

### P5 — Arming discipline

Two versions, and the cheap one should ship first.

**P5a, safe — prepare the arm turn.** `finalApproach` is set the instant `syncSets` sees the
third set (`game.js:704`), so `tryDefendFinalApproach` already gets the rest of that turn. What
it does not do is *plan* for it: on the play that will complete the winning set, the bot should
already know its remaining plays are worth more as bank than as attacks, and that its OPSEC is
now the most valuable card it owns. Today it arms holding an OPSEC 22.2% of the time.

**P5b, risky — sandbag the third set.** The field is unanimous ("avoid creating full sets
unless you have at least one Just Say No"), and under §3.10 the cost of arming early is
unusually high because arming *announces you* and buys the table a full lap. A planner that
would complete its winning set while holding no OPSEC, with live breakers unseen, and a thin
bank, could hold the property one turn and spend the turn banking instead.

This is the deepest "plans ahead" change available and also the one most likely to backfire: a
held property can be forced out at the hand limit, and a lap of delay is a lap the table gets
for free. **It must also be off under `instant` and `mdFaithful`**, where delaying a set is pure
loss — there is no lap to survive. Measure before believing.

### P6 — Grace-cycle charges should count the whole lap, not one turn

`tryBreakFinalApproach` step 4 requires this turn's stacked charges to exceed the victim's
disposable value. §4 shows that is true on 2.5% of grace-cycle turns, so the branch is close to
dead. But an armed player in a 4-player game faces **three** opponent turns, and each bot can
reason about that without any collusion: test `stacked > spare / opponentTurnsRemainingInLap`
instead of `stacked > spare`.

Flagged carefully: round 5 measured and **removed** a blanket "charge them anyway" fallback
because charges the victim can afford disarm nobody. This is not that — it is a claim that a
charge which contributes to a *lap-length* strip is worth a play even when it cannot finish the
job alone. It is the least certain proposal here and it should be measured last, after P1 and
P3 have changed the cushion distribution it depends on.

### P7 — Keep the escort

If a bot holds both a breaker and an OPSEC, the OPSEC should be reserved to protect the
breaker's shot, not spent on an incoming 2M rent. `shouldPlayOpsecDecision` (`bot.js:723`)
already ranks threats; adding "am I about to fire a breaker" to that ranking is small. Round 5
measured OPSEC-chain headroom at ~0.3 points, so this is a feel change, not a balance change —
but it is the third of the field's five principles and it is nearly free.

---

## 4. The one that cannot work as asked, and its replacement

> *"trying to charge as much rent as possible to someone in final approach so they have to give
> up some of their sets"*

The intent is right and it is exactly what a strong human does. The measurement says the window
named is the wrong one.

Sampled at every opponent turn taken while somebody was armed (2,010 samples over 400 games):

| | median | mean |
|---|---:|---:|
| Armed player's disposable value — everything they can pay with *before* a set breaks | **24M** | 26.1M |
| Best single charge the acting opponent could fire | 2M | 2.7M |
| Best *stacked* charge (rent + Finance Office + Roll Call, surge applied) | 2M | 3.1M |

**Turns on which any charge sequence could exceed the cushion: 50 of 2,010 — 2.5%.**

And of the charges that did land on an armed player, **88.2% were payable out of loose change**
and cost the victim nothing that mattered. `disposableValue` (`bot.js:144`) is correct and the
gate that uses it is correct; the problem is that by the time a player arms they are sitting on
a 13M bank plus 9M of loose property, and no single lap of charges gets through 22M.

**You cannot bankrupt someone in the grace cycle. You have to have bankrupted them before it.**

That is P3, and the numbers give it a precise window:

| Leader's state | Their bank (median) |
|---|---:|
| 1 complete set | 4M |
| 2 complete sets | 8M |
| the moment they arm | 13M (+9M loose property) |

A player at 2 sets with an 8M bank is two focused charges from being unable to pay a rent
without breaking a set. The same player 3 turns later is unreachable. **The leverage is spent
between the second set and the third**, and the bots do not currently distinguish that player
from any other payer — `chooseRentTarget`/`rentYield` (`bot.js:1843`, `bot.js:1877`) pick by
what a charge *collects*, which actively prefers the rich, and a rich target is by definition
the one a charge cannot hurt.

The change P3 asks for:

1. **A cushion-pressure term in charge targeting.** Against a player at `setsToWin - 1`, score
   a charge by how much of their *cushion* it removes, not by what it banks for us. 3M off a
   2-set leader beats 5M off a player with one set.
2. **A tempo preference.** For the planners, a charge aimed at the pre-armed leader should
   outrank ordinary board-building while that player sits at `setsToWin - 1`. This is the
   "Debt Collector is an early-game card" principle: it is worth the most before reserves build.
3. **Then, and only then, P6 has something to work with** — because an opponent who arms with a
   4M cushion instead of a 22M one is genuinely breakable by charges in a single lap, and the
   owner's original picture becomes true.

**Risk, stated plainly:** this is leader-bashing, and leader-bashing lengthens games and invites
kingmaking. It must be measured against `pointsRate`, `avgTurns` and the §3 8–60% band, and the
per-personality weights are the dial — conservative and neutral should do this, aggressive
already attacks everything, and the chaotic two should not learn it at all.

---

## 5. Implementation constraints this file must not break

- **Seeded-RNG discipline.** Every new `rnd()` call shifts the whole downstream stream and
  invalidates paired-seed comparisons. Follow the existing pattern: short-circuit the roll for
  any personality whose weight is 0 (`CARD_AWARENESS` does this deliberately), so chud and
  random keep their exact current behaviour and their exact current stream.
- **Distinctness is a gate, not a nicety.** BOT-STRATEGY §"Distinctness, checked not assumed"
  requires the action-mix and targeting spreads to survive. Every proposal above is a *graded*
  axis for that reason. Five patient card-counting bots are one bot.
- **§3 bounds.** No personality above 60% or below 8% in the 4-player mixed matrix.
- **Games must not get slower.** The standing warning in BOT-STRATEGY's "Lever finding" section
  is that every break-rate buff so far has lengthened games. P1 raises the break rate by
  construction. `avgTurns` and `pointsRate` are the counterweight numbers and they are the ones
  most likely to fail.
- **Honest information only.** The card-counting rule established in round 11 stands: bots may
  read the discard pile, every table, and their own hand. Hand size is public; hand *contents*
  are not. P2's OPSEC proxy is built on hand size for that reason.
- **Test-first, per §8.** Every positive assertion proven red on the pre-change tree.

---

## 6. Sources

External strategy references, all live 2026-08-12:

- Deal Breaker timing, baiting, banking and holding —
  <https://monopolydealstrategy.com/index.php?page=dealbreaker>
- Property protection, delayed set completion, offensive Just Say No —
  <https://monopolydealstrategy.com/index.php?page=protection>
- Hiding property and wildcard concealment —
  <https://monopolydealstrategy.com/index.php?page=hideproperty>
- Winning-strategy index (steal-then-rent, targeting bank-poor players) —
  <https://monopolydealstrategy.com/>
- Christine H. Zhang, *Monopoly Deal Strategies* (move restraint, Just Say No prioritisation,
  Debt Collector timing) — <https://medium.com/@christinehzhang/monopoly-deal-strategies-b3f37a10df8e>
- Rules baseline for card equivalences — `docs/rules-research.md` in this repo, and Hasbro FAQ
  a_id/926 and a_id/928 cited there.

Internal:

- `BOT-STRATEGY.md` — rounds 5, 7, 10 and 11 in particular. Round 11's closing section
  ("Lever finding, not forced: breaker timing") predicted this exact request and named the
  gate to build; §3.10 machinery is round 5's.
- `bot.js` — `tryBreakFinalApproach` (196), `tryGuaranteedBreaker` (422), the bank veto (971),
  `tryOffensiveActions` (1628), `findChargeBooster` (2003), `chooseDiscards` (2524).
