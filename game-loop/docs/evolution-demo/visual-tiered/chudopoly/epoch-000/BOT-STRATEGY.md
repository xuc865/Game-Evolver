# Bot Strategy: How We Built the AI

This document covers the research, simulation pipeline, data analysis, and iterative tuning process behind the AI opponents in Chudopoly. The goal was to create bots that play strategically and feel human — not by guessing at good play, but by running hundreds of simulated games and analyzing what actually wins.

## Table of Contents

- [Starting Point](#starting-point)
- [Building the Simulation Pipeline](#building-the-simulation-pipeline)
- [Baseline Analysis: 500 Games](#baseline-analysis-500-games)
- [Key Findings: What Felt Robotic](#key-findings-what-felt-robotic)
- [Tuning Iterations](#tuning-iterations)
- [Early, Mid & Late Game Analysis](#early-mid--late-game-analysis)
- [Combo Detection & Sequencing](#combo-detection--sequencing)
- [OPSEC Economy](#opsec-economy)
- [Targeting Patterns](#targeting-patterns)
- [Final Bot Behavior Summary](#final-bot-behavior-summary)
- [Results: Before vs After](#results-before-vs-after)

## Starting Point

The initial bot implementation used five personality modes — Random, Conservative, Neutral, Aggressive, and Chud — with distinct decision priorities. Conservative played properties and banked everything else. Aggressive led with rent and attacks. Chud was an "anti-strategy" that banked all money first, played properties last, and targeted the weakest players.

This produced bots that were functional but deeply flawed:

| Mode | Initial Win Rate | Problem |
|---|---|---|
| Aggressive | 55% | Dominated everything |
| Neutral | 40% | Only other viable strategy |
| Conservative | 3% | Never attacked, just hoarded |
| Random | 1% | Too passive |
| Chud | 0% | Self-sabotaging, 0 wins in 100 games |

The game was a two-horse race between Aggressive and Neutral. Conservative and Chud were useless.

## Building the Simulation Pipeline

We built a headless simulation system (`simulate.js`) that runs bot-only games without the network layer:

**How it works:**
- Bypasses `scheduleBotAction()` — the server-side function uses `setTimeout` for realistic delays. Instead, we call `decideBotPlay()` directly in a synchronous loop
- Runs through the same `game.js` engine — decisions are executed through identical game rule enforcement
- Captures per-turn decision records — each bot decision is logged with game phase, action type, board state, and targeting information
- Tracks combos, play ordering, OPSEC usage, banking decisions, and set progression curves

The simulation script supports configurable game counts:

```bash
node simulate.js 500    # Run 500 games
```

**What we track per game:**

| Category | Metrics |
|---|---|
| Game phase splits | Early (turns 1-15), Mid (16-40), Late (41+) action distributions |
| Play sequencing | What's played 1st/2nd/3rd each turn, plays-per-turn distribution |
| Combos | Surge+Rent, PCS+followup, Steal-after-Rent sequences |
| Targeting | Who gets targeted, leader-targeting %, target-by-mode breakdown |
| OPSEC | Times held, times played, efficiency (% used on high-value threats) |
| Banking | Money vs action cards vs rent cards banked |
| Set progression | Average completed sets at turns 5, 10, 15, 20, 25, 30 |
| End state | Completed sets, bank value, property count, colors used |

## Baseline Analysis: 500 Games

The initial 500-game simulation revealed the core problems quantitatively:

**Win Rates:**
```
aggressive      275 wins (55.0%)  ██████████████████████
neutral         200 wins (40.0%)  ████████████████
conservative     15 wins ( 3.0%)  █
random            5 wins ( 1.0%)
chud              0 wins ( 0.0%)
```

**Per-Mode Averages (per game):**
```
Mode           Props  Bank  Rent  Draw  OPSEC  Sets
random           4.4   2.4   1.8  14.8    0.5   0.1
conservative     8.0  10.0   0.3  15.9    1.0   0.3
neutral          7.8   4.3   2.6  15.6    0.8   1.7
aggressive       7.0   3.1   4.5  14.6    0.5   2.0
chud             0.5   5.7   0.6  12.9    0.3   0.0
```

## Key Findings: What Felt Robotic

### 1. Conservative Never Attacked

Conservative banked 10 cards/game but charged only 0.3 rent. It played 0 CHUD cards, 1 Finance Office, 0 Roll Calls, and 1 Midnight Requisition across 100 games combined. The mode's strategy was "build sets and bank money" with no offensive element at all.

The root cause: conservative only used offensive actions when it had 2+ completed sets, but it averaged only 0.3 sets per game. The offensive threshold was effectively unreachable.

### 2. Chud Was Self-Destructive

Chud banked all money and rent first (5.7 bank plays/game), played only 0.5 properties, and built 0.01 completed sets on average. The "anti-strategy" was so extreme that Chud never won a single game.

The root cause: Chud's priority list started with "bank money" and "bank rent," wasting all 3 plays per turn on banking. Properties came last, and by then there were no plays remaining.

### 3. All Modes Played 3 Cards Every Turn

Every mode except Chud used all 3 plays 94-96% of turns. Real humans don't always use all their plays — sometimes you hold action cards for later, or you only have OPSEC and properties that don't help right now.

### 4. Predictable First Plays

Conservative and Neutral always played a property card first (66-67% of turns). This made their opening completely predictable.

### 5. OPSEC Wasted on Small Threats

Conservative played OPSEC on everything (100 plays), including 2M Roll Calls. Random played OPSEC randomly (24% efficiency — 76% wasted on small threats). Only Aggressive and Neutral used OPSEC selectively.

### 6. No Threat Detection

No mode checked whether an opponent was close to winning. If someone had 2 completed sets (1 away from victory), no bot adjusted its strategy to stop them.

### 7. No Combo Awareness

Surge+Rent was played as a combo only ~0.05 times per game. Bots played Surge Operations and then ended their turn or played a property, wasting the double-rent effect.

## Tuning Iterations

### Round 1: Fix Conservative and Chud

**Conservative overhaul:**
- Moved offensive actions earlier in priority — now attacks when any opponent has 2+ completed sets (threat detection)
- Added rent charging on any set with rent >= 2 (not just complete sets)
- Added Roll Call usage when 2+ opponents exist
- Added Finance Office targeting richest player
- Stopped banking action cards — holds them for later use

**Chud overhaul:**
- Reorganized priority: offensive actions first (CHUD card, Inspector General, steals), then rent, then properties, then banking
- Now actually charges rent and plays properties
- Reduced early-end chance from 40% to 20%
- Changed from "always target poorest" to random targeting (more chaotic)

**Results after Round 1:**
```
neutral         35 wins (35.0%)  ██████████████
conservative    31 wins (31.0%)  ████████████
aggressive      27 wins (27.0%)  ███████████
chud             5 wins ( 5.0%)  ██
random           2 wins ( 2.0%)  █
```

Conservative jumped from 3% to 31%. Chud went from 0% to 5%.

### Round 2: OPSEC Economy

**Conservative OPSEC:** Changed from "always play" to threat-based:
- Always block Inspector General, CHUD, high-rent (>= 4)
- Only block Midnight Requisition if targeting a set we're building, or we have spare OPSEC
- Skip Roll Call and low-rent unless we have 2+ OPSEC cards

**Random OPSEC:** Added basic survival instinct:
- Always block Inspector General
- 70% chance to block CHUD
- Only 20% chance to block Roll Call or low rent

**Neutral OPSEC:** Added Midnight Requisition blocking (70% chance).

**Results:** OPSEC efficiency improved from 24% to 41% for Random, from N/A to 87% for Conservative.

### Round 3: Smart Property Placement

Replaced simple "play first property in hand" with `findBestPropertyPlay()`:
- Scores each property by: progress toward set completion + smaller set bonus + "already building this color" bonus
- Wild cards score with a flexibility bonus
- Prefers colors we already have cards in (builds toward completion instead of scattering)

**Impact:** Average colors used dropped from 4.5 to 4.2 for Neutral (more focused building), and set completion curves improved across all modes.

### Round 4: Play Count Variability

Added holdback mechanics to avoid the "always plays 3" robot pattern:

| Mode | After 1 play | After 2 plays | Condition |
|---|---|---|---|
| Conservative | 8% stop | 25% stop | Only if hand <= 7 cards |
| Neutral | 5% stop | 15% stop | Only if hand <= 7 cards |
| Random | 12% stop | 25% stop | Only if hand <= 7 cards |
| Aggressive | 0% stop | 8% stop | Only if hand <= 7 cards |

Additionally: Conservative and Neutral never play their last OPSEC card if it's all they have left.

**Results:** 3-play turn rate dropped from 96% to 64% for Conservative, 95% to 76% for Neutral.

### Round 5: Threat-First Decision Making

Moved threat detection to the top of the decision chain for Conservative and Neutral. If any opponent has 2+ completed sets:
1. Inspector General — seize a set from the biggest threat
2. CHUD — steal from threat's best property
3. Midnight Requisition — steal from threat's incomplete sets
4. Finance Office — drain threat's bank
5. Fall back to normal play

### Round 6: Varied Opening Play

Fixed the "always lead with property" predictability:

**Conservative:**
- 24% chance to lead with PCS Orders (was 14%)
- 5% chance to lead with rent
- Rest: property first

**Neutral:**
- 35% chance: lead with rent if decent (>= 2)
- 15% chance: lead with PCS Orders
- 50% chance: property first

**Aggressive:**
- If 0 properties on board, build first (need sets to win)
- Otherwise: lead with Surge/Rent combo or attacks as before

## Early, Mid & Late Game Analysis

### Early Game (Turns 1-15)

| Action | Random | Conservative | Neutral | Aggressive | Chud |
|---|---|---|---|---|---|
| property | 56% | 55% | 54% | 50% | 48% |
| pcs_orders | 8% | 15% | 13% | 9% | 7% |
| rent | 4% | 6% | 9% | 12% | 14% |
| bank | 17% | 15% | 9% | 8% | 5% |

All modes focus on property placement in the early game (48-56%). Conservative and Neutral prioritize PCS Orders for card advantage. Aggressive leads with rent more often. Chud harasses immediately (14% rent, 5% steals).

### Mid Game (Turns 16-40)

| Action | Random | Conservative | Neutral | Aggressive | Chud |
|---|---|---|---|---|---|
| property | 43% | 33% | 30% | 32% | 41% |
| rent | 8% | 12% | 14% | 13% | 15% |
| bank | 19% | 19% | 17% | 22% | 10% |
| offensive* | 11% | 16% | 15% | 11% | 12% |

*Offensive = chud + finance_office + inspector_general + midnight_requisition + tdy_orders*

Mid game shifts toward income generation (rent) and offensive actions. Conservative becomes more aggressive as threats emerge. Property placement drops as players have fewer unplayed properties.

### Late Game (Turns 41+)

Small sample size (44-52 actions total) but shows interesting patterns:
- Conservative shifts to PCS Orders (23%) to find missing pieces
- Neutral focuses on rent (13%) and offensive cards
- Aggressive goes heavily offensive (17% CHUD, 8% IG)
- Chud goes for Midnight Requisition (29%) — last-ditch property theft

## Combo Detection & Sequencing

We tracked three specific card combos:

| Combo | How it works | Neutral | Aggressive |
|---|---|---|---|
| Surge + Rent | Play Surge Operations, then charge rent (doubled) | 0.14/game | 0.12/game |
| PCS + Followup | Draw 2 cards, then immediately play one | 0.37/game | 0.34/game |
| Steal after Rent | Charge rent to drain bank, then steal property | 0.07/game | 0.09/game |

Combo rates improved significantly after reordering decision priorities. Surge+Rent went from 0.05 to 0.14 for Neutral after moving the Surge check before property plays.

## OPSEC Economy

OPSEC (counter cards) are a limited resource — the deck has only 3 copies. Using them wisely is critical.

| Mode | Times Held | Times Played | On Big Threats | Efficiency |
|---|---|---|---|---|
| Random | 299 | 201 | 83 | 41% |
| Conservative | 541 | 178 | 155 | 87% |
| Neutral | 358 | 196 | 167 | 85% |
| Aggressive | 448 | 91 | 79 | 87% |
| Chud | 111 | 187 | 27 | 14% |

**Conservative holds OPSEC the most** (541 turns with OPSEC in hand) but uses it selectively. **Aggressive holds OPSEC but rarely plays it** (91 times) — saves it for Inspector General and CHUD only. **Chud wastes OPSEC** on small threats (14% efficiency) — intentionally chaotic.

"Big threats" are defined as: Inspector General, CHUD, Finance Office, or rent >= 4M.

## Targeting Patterns

We tracked who each mode targets with offensive actions:

| Attacker → Target | Conservative | Neutral | Aggressive | Chud |
|---|---|---|---|---|
| → random | 21% | 20% | 24% | 13% |
| → conservative | — | 38% | 30% | 20% |
| → neutral | 31% | — | 35% | 29% |
| → aggressive | 34% | 24% | — | 37% |
| → chud | 14% | 18% | 11% | — |
| **Targets leader** | **81%** | **79%** | **77%** | **72%** |

All modes preferentially target the leader (77-81%). Chud is less leader-focused (72%) due to random targeting. Notably, Chud is targeted least often (11-18%) by most modes because it's rarely the leader.

## Final Bot Behavior Summary

### Random
- Shuffles hand and plays in random order
- 60% chance to try properties first, otherwise random
- 15% chance to end turn early (reduced from 30%)
- OPSEC: blocks IG always, CHUD 70%, small stuff 20%
- Designed to be unpredictable but weak

### Conservative
- **Build first, attack when threatened**
- Prioritizes: threat response → surge+rent combo → rent on complete sets → PCS → properties → upgrades → decent rent → banking
- Holds action cards for later (never banks them)
- 25% chance to stop after 2 plays (saves hand for defense)
- OPSEC: saves for big threats (87% efficiency)
- Goes offensive when any opponent has 2+ sets

### Neutral
- **Balanced play with threat awareness**
- Varies opening play: 35% rent-first, 15% PCS-first, 50% property-first
- Prioritizes: threat response → surge+rent → properties → PCS → rent → offense → upgrades → banking
- 15% chance to stop after 2 plays
- OPSEC: selective (85% efficiency)
- Combo-aware: plays Surge before Rent when both in hand

### Aggressive
- **Attack-first, build second**
- Leads with rent (any amount) and offensive actions
- Plays properties after attacks (still needs sets to win)
- 8% chance to stop after 2 plays (almost always uses all plays)
- OPSEC: only blocks IG and CHUD (87% efficiency)
- Targets leader's most valuable properties

### Chud
- **Chaotic gremlin**
- Leads with CHUD card and Inspector General
- Targets random players (not strategic)
- Charges rent on random colors
- Places wild properties on random or wrong colors (50/50)
- 20% chance to end turn early after first play
- OPSEC: blocks small stuff, lets big attacks through (14% efficiency — intentional)
- Banks OPSEC cards — doesn't care about defense

## Results: Before vs After

### Win Rate Balance

| Mode | Before | After (6 rounds) |
|---|---|---|
| Aggressive | 55% | **27%** |
| Neutral | 40% | **37%** |
| Conservative | 3% | **28%** |
| Random | 1% | **2%** |
| Chud | 0% | **5%** |

From a 55/40 two-horse race to a balanced 37/28/27 three-way competition.

### Play Variability

| Metric | Before | After |
|---|---|---|
| 3-play turns (conservative) | 96% | **64%** |
| 3-play turns (neutral) | 95% | **76%** |
| First play predictability (conservative) | 66% property | **46% property** |
| First play predictability (neutral) | 67% property | **57% property** |

### OPSEC Usage

| Mode | Before Efficiency | After Efficiency |
|---|---|---|
| Random | 24% | **41%** |
| Conservative | N/A (always played) | **87%** |
| Neutral | N/A | **85%** |
| Aggressive | N/A | **87%** |

### Combos

| Combo | Before (neutral) | After (neutral) |
|---|---|---|
| Surge + Rent | 0.05/game | **0.14/game** |
| PCS + Followup | N/A | **0.37/game** |

### Game Health

| Metric | Before | After |
|---|---|---|
| Average game length | 38 turns | **26 turns** |
| Stalemates | 1% | **0%** |
| Modes with >1% win rate | 2 | **5** |

### Set Completion Curve

| Turn | Conservative Before | Conservative After |
|---|---|---|
| 10 | 0.03 | **0.10** |
| 15 | 0.06 | **0.25** |
| 20 | 0.08 | **0.40** |
| 25 | 0.10 | **0.59** |

## Methodology Notes

### Why Headless Simulation?

Running 500+ games through the actual WebSocket server would take hours due to artificial bot delays (600-2800ms per action). By calling `decideBotPlay()` directly in a synchronous loop, we can run 500 games in under 5 seconds.

### Simulation Limitations

Bot-vs-bot games feature 5 equally skilled opponents with different strategies. Real games feature 2-5 human players with varying skill levels. Our simulations validate that modes are differentiated and balanced against each other — real-world balance may differ since humans exploit different weaknesses.

### Iterative Process

The tuning was not a one-shot process. Each round of changes was validated through 500-game simulations, and results revealed secondary effects (e.g., fixing Conservative's banking caused it to hold too many action cards, requiring the holdback mechanic). The final parameters represent 6 rounds of tuning with simulation verification after each.

## P1 Card-Table Revamp — Rules Rebalance and Re-tune

The ARCHITECTURE §3 rebalance changed the rules under the bots (CHUD lost its 2M rider,
the wild rent became single-target, Surge Ops doubles any charge, colour zones are capped
at set size, insolvency now forces zero-value wilds out). Every personality was re-checked
against the §3 bounds: **no personality above 60% or below 8% in a 4-player mixed game.**

### New measurement harness

`simulate.js` grew a programmatic API next to the CLI:

```js
const { runMatches } = require('./simulate');
runMatches({ players:['chud','neutral','neutral','neutral'], games:500, seed:'x' });
// → { winrates, seatWinrates, firstPlayerWin, avgTurns, medianTurns, stalemates, ... }
```

`node simulate.js matrix <games> <seed>` prints the balance matrix. Every personality plays
**every seat of every 4-subset of the roster**, so seat order cannot masquerade as strength.
Runs are reproducible: the engine takes `{seed}` and the bot RNG is injected
(`Bot._internal.setRng`) rather than reading `Math.random` directly.

### 4-player mixed, 4000 games (3200 per personality)

| Personality | Before rebalance (5p, 500 games) | After (4p mixed, 4000 games) |
|---|---|---|
| Aggressive | 28.4% | **36.7%** |
| Neutral | 35.0% | **35.5%** |
| Conservative | 29.6% | **27.3%** |
| Chud | 5.8% ✗ | **13.2%** |
| Random | 1.2% ✗ | **12.4%** |

First-player advantage: **24.5%** against a 25.0% fair share — turn order is worth nothing
measurable. Average game 27.7 turns, 0 stalemates in 4000 games, 4000/4000 decided.

Each personality against three neutrals (4000 games each): random 9.6%, chud 10.8%,
conservative 19.8%, aggressive 20.4%, neutral 23.1%.

### What moved random and chud off the floor

Both were below the 8% floor *before* the rebalance too (1.2% and 5.8%), so this was a bot
fix, not a rules fix. Three changes, each measured:

| Change | Effect |
|---|---|
| Random's per-decision "do nothing" chance 15% → 5% → 2% | 2.5% → 8.6% → 12.4% |
| Random/chud pay from the **bank before properties** (still random order within each) | random 4.5% → 6.6%, chud +3 points |
| Random's wild colours pull 70% toward a colour it has already started | random 2.5% → 4.5% |
| Chud plays a property first on a 45% coin-flip instead of always harassing first | chud 6.0% → 12.3% |

Random still shuffles its hand, still targets at random, still discards blind — it is
unpredictable rather than absent. Chud still leads with theft, banks OPSEC and discards
chaotically; it just stopped refusing to build.

### Rules the bots had to learn

- **Wild rent needs a victim.** `makeRentPlay()` attaches a `targetId` for `Rent: any`;
  smart modes pick the leader (ties broken on who can actually pay), random/chud roll.
- **Zone cap.** `openColorsForWild()` and `randomPropertyPlay()` refuse a colour that
  already holds a full set, so no personality wastes a play on an illegal placement
  (soak: 45,396 decisions across 300 games, 0 rejected plays).
- **Surge Ops doubles any charge.** All three planning modes now play Surge when a rent,
  Finance Office *or* Roll Call can follow it (`hasChargeFollowUp()`).
- **No CHUD rider.** The follow-up payment branch is gone from the response logic.

## Final Approach (owner directive, ARCHITECTURE §3.10)

Reaching three sets no longer wins — it *arms*. The armed player wins only if they still hold
three sets when their own next turn begins, so every opponent gets one turn to shoot them down.
Bots had to learn both halves of that.

### Breaking someone else's approach

`tryBreakFinalApproach()` runs **before** every personality's own plan and before the
human-like holdback (there may not be another turn to spend the card on). It walks the
options in order of how reliably they cost the victim a set:

1. **Inspector General** — takes the whole set, and it lands on our board.
2. **THE CHUD CARD** — the only single-property steal that reaches into a complete set.
3. **TDY Orders** — a swap is not a steal, so the complete-set guard does not apply to it.
4. **Midnight Requisition** — only useful against an *overflowed* zone (length ≠ set size).
5. **Charge them past their bank** — Finance Office or a rent aimed at the armed player when
   their bank cannot cover it, so the payment has to come out of a set. Surge Ops first when
   doubling would push the charge past their cash.

Rent targeting (`chooseRentTarget`) now prefers an armed opponent over the leader, and chud's
CHUD/Inspector General targeting became threat-aware — spraying those cards at whoever left
chud with nothing to answer a late approach with (53.8% of approaches converted against an
all-chud field; 48.1% after the fix).

**Shot-taken rate** — an opponent is armed, a breaking card is in hand, does the bot fire at
them on the first play of its turn? (200 games, all lineups)

| Personality | Takes the shot |
|---|---|
| chud | **98.7%** |
| aggressive | **94.4%** |
| neutral | 88.0% |
| conservative | 86.4% |
| random | **38.5%** |

That is the intended spread: chud and aggressive are the enforcers, random mostly does not
notice. `BREAK_URGENCY` gates the attempt per personality, but the roll turns out to matter
far less than card availability — softening it (1.0/0.9/0.85/0.2 → 0.9/0.75/0.7/0.15) moved
conversion by 0.2 points, so the original values stayed.

### Defending your own approach

An armed bot stops building (more sets cannot help it) and starts protecting:

- **Hoards cash** (`tryDefendFinalApproach`) so an incoming charge never has to be paid out of
  a completed set. Bias per personality: conservative 0.9 … chud 0.4, random 0.2.
- **Pays complete-set cards last**, regardless of personality — `selectPaymentCards` sorts them
  to the back of the queue whenever the payer is armed.
- **OPSECs anything that could cost a set**: any property attack, or a payment demand larger
  than its bank. Random still flips a coin about it.

Measured effect: across 250 mixed games, **every** broken approach was broken by an opponent —
zero self-inflicted breaks. The defensive rules work.

### The checkpoint is a full turn cycle

The win checkpoint is the armed player's own turn start **with at least `active players`
turns elapsed since arming**, so every opponent is guaranteed a response turn no matter when
the arming happened. It matters because 5.2% of armings happen on somebody else's turn (a
payment or a swap completing your third set); those used to get a truncated grace period.
Conversion by arming position, 240 games: armed on your own turn **38.9%**, armed off-turn
**25.0%** — the strict rule costs an off-turn armer real equity, which is the point.

### Balance after the change (4000 games, seat-balanced)

| Personality | Before §3.10 | After §3.10 |
|---|---|---|
| random | 12.4% | **12.7%** |
| conservative | 27.3% | **25.8%** |
| neutral | 35.5% | **33.1%** |
| aggressive | 36.7% | **40.5%** |
| chud | 13.2% | **13.0%** |

§3 bounds still hold. First-player advantage 21.1% against a 25.0% fair share. Games got
longer, as expected: **27.7 → 41.3 average turns**, 2.61 armings per game, **56.8% of
approaches shot down / 43.2% converted** — the grace cycle is a real fight, not theater.
Conversion falls hard with table size (2p 86.2%, 3p 65.0%, 5p 31.4%): more opponents, more
guns pointed at you.

### The tail, and the attrition cap

The grace cycle has a cost: every break scatters a finished set, so 5-player games grew a long
tail. Measured over 300 five-player games:

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| before §3.10 | 27 | 44 | 63 | 73 |
| after §3.10 | 42 | 114 | 387 | 401 |

Not livelock — every game still ended — but a p99 of 387 turns is unplayable with live turn
timers. The separator is deck cycles: healthy games reshuffle 1.9 times (p90 5), tail games
22.8 (max 56). So the game now ends on points (most sets, net worth breaks the tie — the same
resolution §3.6 already used) once the deck has been cycled `DECK_CYCLE_LIMIT` times.

| Limit | max turns (5p) | 5p games decided on points |
|---|---|---|
| 8 | 99 | 17% |
| 12 | 129 | 11.7% |
| **16** | **152** | **7%** |

16 was chosen: it bounds the tail at ~30 turns per player and never fires at all in 2/3/4-player
games (0 of 450 sampled). Max turns across the 4000-game matrix: 167.

## Final Approach, round 2 — the §3.1 reversal had quietly gutted the counters

Owner report, 2026-08-07: *"when playing against bots, if someone is on final approach I want
to make sure that the bots will always do everything they can to try to stop them."*

The section above claims **56.8% of approaches shot down**. Re-measured at HEAD before
touching anything: **40.1%**. The regression was not in the bots — it was §3.1's reversal on
2026-08-06. TDY Orders was counter #3 in `tryBreakFinalApproach()`, and Hasbro FAQ 926 took it
away. The break list still *contained* the move; the engine just refused it. The numbers in
the previous section predate that reversal and were never re-measured.

That leaves exactly **four** cards in 106 that can pull a card out of a complete set — 2×
Inspector General, 2× THE CHUD CARD — against 3× OPSEC. Everything else has to come from
forcing a payment the victim cannot cover.

### Baseline: where the shots were actually going

Instrumented over 400 mixed games, on every decision taken while an opponent was armed:

| | before | after |
|---|---|---|
| hard breaker (IG/CHUD) in hand | 7.6% | **10.4%** |
| fired it | 7.5% | **10.4%** |
| fired a charge at the armed player | 10.5% | 6.8% |
| …of those, charges the victim could pay **without touching a set** | **51.9%** | 42.5% |
| banked a hard breaker while someone was armed | 2 | **0** |
| had nothing usable, but held PCS Orders | 12.6% | **5.9%** |

So the bots were *already* firing a counter 99.4% of the times they held one. The failure was
never nerve — it was that half the charges were theatre, the bot gave up instead of digging,
and it would occasionally bank the counter as cash.

### The shape of the change: a pre-emptive branch, not a weight

`tryBreakFinalApproach()` stays a branch that short-circuits ahead of every personality plan
and ahead of the holdback. A weight would be wrong: scoring compares plays by marginal value,
and a live final approach is not a bigger number, it is a **terminal condition** — every other
play on the board is worth zero if the armed player converts. Only a short-circuit expresses
that. What changed is what the branch knows.

**`disposableValue()` replaces "their bank".** What an armed player can hand over without
losing a set is bank + properties in zones that are *not* complete sets + upgrades (payable
per §3.1b; a House leaving a set costs rent, not the set — the same order `selectPaymentCards`
uses). A charge disarms only if it beats *that*. Charging less moves money, and during a grace
cycle there is no later turn in which that money mattered.

**Ranked by what actually disarms, verified against `game.js` rather than card text:**

| | why here |
|---|---|
| 1. Inspector General | takes the whole set, permanently, and it lands on *our* board — a two-set swing |
| 2. THE CHUD CARD | the only card that reaches into a complete set for a single property |
| 3. a charge sized above `disposableValue` | forces a set card out; Surge Ops first **only ahead of a rent** |
| 4. PCS Orders as a dig | holds no counter → a speculative draw beats any ordinary play, because there is no next turn |
| 5. Midnight Requisition | denial only — `zoneRequisitionable` bars it from complete sets, so it can never disarm |
| — | **TDY Orders: not a counter.** §3.1/FAQ 926 bars it from complete sets on *both* sides |

**Surge Ops was being burned on Finance Office.** §3.1c makes Surge rent-only, and
`finance_office` calls `chargeAmount()` with no `surgeable` flag — the multiplier is always 1.
The old break code spent a play surging it anyway, at the one moment in the game when plays
are worth the most. Surge now fires only when doubling a *rent* is what pushes it over
`disposableValue` and a play remains to fire the rent with.

**Roll Call joined the list.** 2M and it hits the table, but 2M is enough against a player who
has spent down to nothing. It was never considered before.

**Spend now, not later — in code, not in the report.** Two additions. The dig (a bot with no
counter plays PCS Orders rather than building, because the counter can only come from the
deck). And a veto in `decideBotPlay()`: while anyone is armed, no plan may bank an Inspector
General or CHUD as money. IG is the highest-value card in the deck at 5M, so *every*
personality's "bank the biggest thing" rule reached for it first — including
`tryDefendFinalApproach`, which is how an armed bot could bury the best counter in the game
under a pile of cash. Vetoing once at the chokepoint covers all five personalities instead of
patching the same mistake in five planners.

**Multiple armed opponents, and being armed yourself.** The victim is whoever converts
**first**, not whoever has the most sets, read off the engine's own `checkpointForecast().turn`
so it cannot drift from `resolveFinalApproach()`. (Use `.turn`, not `.opponents`: two players
armed on the same tick have the same opponent count left but still convert in seat order.) An
armed bot filters the list to rivals whose checkpoint lands **before** its own — if we convert
first we have already won the race and spending the counter is pure loss, so it defends
instead. If theirs lands first, it fires regardless of being armed.

### Personalities survived — that was checked, not assumed

`BREAK_URGENCY` (fire a counter you hold) is unchanged. A second table, `BREAK_OVERPAY`
(aggressive .95, chud .85, neutral .75, conservative .55, random .15), gates only the
*speculative* spending — the PCS dig and the denial play. That is the axis the personalities
are allowed to differ on: how much you overpay for the attempt. None of them may ignore an
armed player.

Shot-taken rate — opponent armed, breaker in hand, first play of the turn (2,000 games):

| | before | after |
|---|---|---|
| conservative / neutral / aggressive / chud | 100% | **100%** |
| random | 36.8% | **35.7%** |

Random stays the easy seat. Everyone else was already perfect and stayed perfect; what rose is
how often they *have* a card — 543/443/303/360 chances after vs 529/351/266/298 before, bought
by the dig and by no longer banking the thing.

Seats filled after a disconnect (`server/handlers.js` picks
conservative/neutral/aggressive) all sit in the 100% group, and an unknown mode falls through
to neutral. Pinned in `test/bot-finalapproach.test.js`.

### OPSEC: measured, and already at its ceiling

Of 426 IG/CHUD shots blocked by an armed player, the attacker held a spare OPSEC in only
**17.4%** — and already fought back through the chain in **82.4%** of those. Total headroom
from a smarter chain response is ~0.3 points, so nothing was changed. The existing
`isChainResponse` handling is sufficient; the binding constraint is card availability, which
is a property of the deck, not of the bots.

### Balance after (10,000-game matrix, 500 per lineup, every seat × every 4-subset)

| Personality | before | after |
|---|---|---|
| random | 13.6% | **13.3%** |
| conservative | 27.2% | **26.1%** |
| neutral | 33.6% | **33.6%** |
| aggressive | 36.5% | **38.2%** |
| chud | 14.1% | **13.8%** |

§3 bounds hold (8–60%). First-player advantage 22.7% → **23.1%** against a 25.0% fair share.
**Approaches shot down 40.1% → 45.6%; converted 59.9% → 54.4%.** Average game **34.6 → 35.6
turns** (+2.9%), 10,000/10,000 decided.

Aggressive gained 1.7 points and conservative lost 1.1. That is the expected direction — the
change rewards holding and spending a counter at the right moment, which is aggressive's game
— and both stay comfortably inside the bounds.

### Conversion by table size, and the honest cost

1,500 games per table size:

| | 2p | 3p | 4p | 5p |
|---|---|---|---|---|
| converted before | 88.8% | 75.2% | 59.5% | 44.3% |
| converted **after** | 88.5% | 74.8% | **54.3%** | **36.9%** |
| p90 turns before → after | 30 → 30 | 37 → 38 | 49 → 51 | **74 → 93** |
| decided on points (§3.6) before → after | 0% | 0% | 0.0% → 0.2% | **2.8% → 8.3%** |

The change bites where there are more guns pointed at the armed player, which is the right
shape. **The cost is real and it lands at 5 players**: p90 grows 74 → 93 turns and 8.3% of
5-player games now end on the deck-cycle points rule instead of a declared Final Approach, up
from 2.8%. That is inside the envelope `DECK_CYCLE_LIMIT = 16` was chosen for (7% of 5p games
on points), and max turns did not move (146 → 149, and 1500/1500 still decided — this is the
bounded points ending, never a livelock), but it is a one-in-twelve chance that a five-handed
game ends on a technicality rather than a landing. Worth watching if 5-player becomes common.

An attrition fallback — "charge them anyway even though it cannot disarm" — was built, measured
and **removed**: across 1,500 games per table size it moved conversion 0.4–1.5 points (inside
run noise) while pushing 5p points-endings from 8.3% to 8.9%, and it overrode the holdback that
keeps bots from attacking on every single play. It bought nothing and cost variety.

### Verdict

Roughly a coin flip: **45.6% of final approaches are now shot down, 54.4% land.** At a 4-player
table the armed player is favoured but not safe, and at 5 players they are underdogs. Not
hollow — the table demonstrably fights, and it fires a counter 100% of the times it holds one.
Not futile — the majority of approaches still convert. The remaining ceiling is the deck: four
set-breaking cards in 106, against three OPSEC. Raising the break rate further would take a
rules change, not a bot change.

---

## Round 6 (2026-08-07) — the deck knob, the contested approach, and the table nobody measured

Round 5 closed with a hypothesis: *"The remaining ceiling is the deck: four set-breaking cards
in 106 against three OPSEC. Getting materially above ~46% would take a rules change."*

The deck is now a **rule** (game.js `DECK_BASE`, thirteen editable counts), so that hypothesis
became measurable rather than arguable. It is **confirmed as a mechanism and rejected as a
change**, and the reason is the cost the round-5 verdict had already flagged.

### The matrices

`simulate.js lineupsFor()` was generalised from the 4-player drop-one loop to **every k-subset
of the 5-personality roster × every rotation** — the k=4 case reproduces the old loop lineup
for lineup (asserted in `test/deckconfig.test.js`), and 3- and 5-player matrices exist for the
first time. 10,000 games per variant per seat count; ≥333 per matchup at every count.

**4 players** (the Quick Play default since this round):

| variant | size | shot down | avg turns | p90 | points% |
|---|---|---|---|---|---|
| **baseline** | 106 | **45.8%** | **35.7** | **53** | **0.29%** |
| +1 IG | 107 | 52.4% | 37.3 | 56 | 0.68% |
| +1 Chud | 107 | 52.5% | 38.4 | 59 | 0.78% |
| +1 each | 108 | 59.0% | 40.6 | 63 | 1.41% |
| +2 wilds (9→11) | 108 | 41.7% | 33.8 | 48 | 0.15% |
| +1 each, +1 OPSEC | 109 | 57.5% | 40.5 | 63 | 0.94% |
| +1 IG, −1 PCS (size-neutral) | 106 | 53.3% | 37.7 | 56 | 0.80% |
| mdFaithful deck | 106 | 24.8% | 30.4 | 42 | 0.00% |

**5 players**, where round 5 said the cost lives — and it does:

| variant | shot down | avg turns | p90 | points% |
|---|---|---|---|---|
| **baseline** | **62.6%** | **47.9** | **96** | **8.39%** |
| +1 IG | 69.5% | 53.9 | 112 | **13.12%** |
| +1 Chud | 68.6% | 55.3 | 115 | **14.35%** |
| +1 each | 74.0% | 61.8 | 125 | **19.12%** |
| +2 wilds | 59.9% | 44.2 | **81** | **5.93%** |
| mdFaithful deck | 41.5% | 35.1 | 52 | 0.76% |

### What the numbers say

1. **The hypothesis was right about the mechanism.** One more Inspector General really does
   move the shot-down rate (45.8% → 52.4% at four seats). The **size-neutral control**
   (+1 IG, −1 PCS Orders, still 106 cards) reaches 53.3%, so the effect is the *breaker*, not
   the bigger deck. The deck was genuinely the ceiling.

2. **And it is still not worth shipping.** Every breaker addition pushes 5-player
   points-endings from 8.4% to 13–19% and p90 past 110. The bar was "not materially past ~8%
   and ~100 turns". Every one of them fails it. **Baseline is fine; the bots just got better.**

3. **The surprise: restoring the two missing wilds goes the other way and is the only deck
   change that pays.** It *lowers* the shot-down rate (approaches convert more, because sets
   are easier to rebuild) but improves every cost at once: 5-player p90 96 → 81, points 8.39%
   → 5.93%, average turns 47.9 → 44.2. Wilds are a *tail* fix, not a breaker fix.

4. **CHUD is doing most of the set-breaking work.** The MD-faithful deck — the official
   Monopoly Deal deck exactly, which is our deck minus CHUD plus the two wilds — shoots down
   **24.8%** at four seats against our 45.8%. That is the honest price of fidelity, and it is
   why MD needs no grace cycle: it has instant win instead.

### §3.10b — the contested approach

A contested approach (two or more seats armed at the same turn start) is **not rare**:
**8.1% of 3-player games, 16.7% at 4 players, 26.1% at 5.** At the new default it is roughly
one game in six, so this is a real part of the game rather than a curiosity.

The owner's rule as stated does not terminate, so each mode carries its own bound. 10,000
games per mode:

| mode | 4p shot down | 4p p90 | 4p points% | 5p p90 | 5p points% |
|---|---|---|---|---|---|
| **off** (default) | 45.3% | 53 | 0.35% | 96 | 8.52% |
| oneLap | 50.9% | 55 | 0.75% | 104 | 12.02% |
| **escalate** | **55.1%** | 57 | 1.18% | 105 | 13.27% |
| points | 58.6% | 59 | **4.95%** | 107 | **15.68%** |

`escalate` buys **+9.8 points of shot-down at four seats — more than any deck change, at
lower cost.** `points` is rejected outright: it converts one 4-player game in twenty into a
technical ending, which is the failure mode the whole exercise exists to avoid.

### The combination that actually pays for itself

`escalate` lengthens games; restored wilds shorten them. Together (12,000 games, independent
confirming seed, `suddenDeath: 'escalate'` + `wildPairs: 9, wildAny: 4` = 110 cards):

| | 3p | 4p | 5p |
|---|---|---|---|
| shot down | 22.6 → **23.5%** | 45.4 → **46.8%** | 62.5 → **64.1%** |
| avg turns | 28.2 → **25.8** | 35.6 → **32.3** | 47.7 → **41.3** |
| p90 turns | 38 → **36** | 53 → **47** | 95 → **76** |
| max turns | 78 → **61** | 145 → **131** | 147 → **142** |
| decided on points | 0.00% | 0.31 → 0.50% | 8.08 → **6.16%** |
| contested approaches | 8.3 → 14.4% | 16.1 → 21.1% | 26.0 → 29.5% |

**Better or equal on every axis at every seat count**, §3 personality bounds green throughout
(8–60% at 3, 4 and 5 players). It directly repairs the 5-player cost round 5 shipped —
p90 96 → 76 and points 8.4% → 6.2% — while adding the drama the owner asked for.

Sensitivity on the rainbow wilds, which are the part that pays (5 players):

| wilds | 5p p90 | 5p points% |
|---|---|---|
| 11 (MD exactly) | 99 | 10.21% |
| 12 | 86 | 7.47% |
| 13 | 75 | 6.10% |

Eleven wilds — the MD-faithful count — is **not** enough to pay for `escalate` at five seats.
Twelve is. So the combination that works is a deliberate departure from MD, not a return to it.

### Quick Play was measuring the wrong table

Quick Play seated **two** bots, so the configuration the owner actually played was 3-player —
the one configuration these matrices had never covered. Every number this document quotes
described a table nobody was sitting at.

| | 3p (old default) | 4p (new default) |
|---|---|---|
| seat-0 win rate | 31.9% | 21.5% |
| avg / median turns | 24.8 / 25 | 32.4 / 30 |
| **SD of turn count** | **6.5** | **13.0** |
| final approaches shot down | **19.5%** | **47.5%** |
| contested approaches | 8.0% | 19.7% |

Three players is not a shorter game, it is a **thinner** one: four of every five final
approaches simply convert, so the mechanic the whole win rule is built around barely
functions. And the turn count is nearly constant — which is exactly the owner's complaint
that *"every game is 20-25ish points."* **That number is the turn counter** (median 25, p10
17, p90 33), not net worth, which sits at a median of 9M. Four seats doubles the spread.

Bench chosen by measurement: `neutral + aggressive + conservative` gave the highest shot-down
rate (47.5%, against 43.9% seating `chud` and 42.4% seating `random`) and the most contested
approaches, and `random` measurably softens the table (seat 0 wins 26.8%).

### Verdict

**Ship nothing to the stock deck.** Round 5's hypothesis was correct about the mechanism and
wrong about the remedy: the breakers work, and every way of adding them costs more at five
seats than the shot-down rate is worth. A null result, and it is the real one.

**Ship the configurability**, which makes the question cheap to re-ask, and makes MD Faithful
genuinely faithful for the first time. **`escalate` + 12–13 wilds is the one variant measured
that improves every axis at every seat count** — it is offered rather than defaulted, because
defaulting a rule that changes the deck is a bigger decision than a balance round should make
alone, and because the case for it rests on the tail rather than on the shot-down rate.

---

## Round 7 (2026-08-07) — the money the bots were giving away, and the free move nobody made

Owner report: *"ive noticed sometimes bots just pay or give way extra causing players to win
more also their decisions as a whole they should be smarter use rent cards better and also
move wilds around etc to protect resources … in general I want our bots to be smarter
players."*

Four defects, all found by instrumenting a live-ish game and counting rather than by reading
the code. Three of them are things the file did *wrong*; one is a rule it had never once
used. Instrumentation ran over 400 four-player games (every rotation of every 4-subset,
the same lineups the matrix uses), logging every payment, every rent decision, every Surge
and the whole board at every turn start.

### The baseline, in numbers

| measured at HEAD, per personality | random | conservative | neutral | aggressive | chud |
|---|---|---|---|---|---|
| **millions handed over per million owed** | 1.29 | 1.32 | 1.28 | 1.30 | 1.29 |
| overpay, M per bot per game | 8.4 | 8.8 | 7.8 | 7.6 | 8.0 |
| solvent payments that overpaid | 60% | 60% | 57% | 56% | 61% |
| **turn starts where one free wild move would have completed a set** | 21% | 18% | 16% | 18% | 21% |
| …of which any bot took | **0** | **0** | **0** | **0** | **0** |
| Surges that expired unused | 85% | 67% | 39% | 39% | 77% |
| millions a rent collected, as a share of the best the hand could have collected | 77% | 92% | 97% | 98% | 81% |
| property placement, same share | 63% | 98% | 98% | 98% | 66% |

Property placement was already at its ceiling for the three planning modes and was left
alone — the intuitive guess would have been to rewrite it, and it was worth nothing.

### 1. Payment: the greedy walk that stopped at "enough" instead of "closest"

`selectPaymentCards()` ended with a walk down the priority order that broke the moment the
running total reached the debt. A bank of `[1, 10]` paying a 5M charge took the 1 (1 < 5),
then the 10 (11 ≥ 5), and **handed over 11M for a 5M debt**. Across every personality that
is ~30% of every million that ever changed hands, and it is exactly the owner's report.

**The fix does not touch the order.** The sort above it is measured — bank before upgrades
before properties (a House costs rent, a property can cost a set), near-complete sets
protected, §3.10's complete-set-last rule for an armed payer — and getting it wrong
previously cost chud ~3 points and random ~2. So the ordering was re-expressed as a **cost**
and the search runs inside it: bank 0, upgrade 1, property 4 + how complete its set is, with
gaps wider than the largest card in the deck (10M) so that **no amount of overpay saving can
ever promote a worse tier**. A small exact DP over card values then picks the cheapest tier
mix, then the smallest overpay reachable with that mix, then the fewest cards. Zero-value
cards are dropped (they cannot move a total), and an insolvent payer still surrenders
everything under §3.4.

| | before | after |
|---|---|---|
| M handed / M owed (neutral) | 1.28 | **1.13** |
| M overpaid per bot per game | 7.6–8.8 | **4.2–5.5** |
| solvent payments that overpay at all | 56–61% | **31–42%** |

The residual is the denomination problem plus the tier order, and it is deliberate: a bot
holding a single 10M note and a spare 4M property still hands over the 10M for a 4M debt,
because the measured ordering says cash before board. An unrestricted search that ignored
tiers would remove a further 13–19% of the debt in overpay — that is the price of the
priority ordering, stated so the next round can argue with it on numbers.

**This fix on its own made 5-player games longer**: turns 48.2 → 54.3, p90 97 → 106, and
§3.6 points-endings 8.44% → 11.6%. Less money moving is a tighter economy and fewer forced
set-breaks. Fix 2 paid all of it back and more.

### 2. §3.8 free rearranging: a rule no bot had ever used

`moveProperty` and `swapProperties` were never called from a bot decision. Rearranging is
free, does not cost a play (Hasbro FAQ 937; the client itself got this wrong until
`55a014f`), and **on 16–21% of turn starts a single free move would have completed a set
outright**. It is the largest thing in `bot.js` that was simply *missing* rather than wrong.

`planRearrange()` is a hill climb on a board score where a completed set is worth ~1000 and
an incomplete zone is worth `200 × (have/size)²` — the **square** is what makes concentration
beat scatter, so a wild parked where it can never finish anything moves to where it can.
Everything about it is chosen so it cannot thrash or wedge:

- **A card never leaves a complete set.** Moving out of one can cost a set and can gain at
  most one, so `completedSets` is monotone non-decreasing under every move the planner makes
  — which is both the strategy and the termination argument.
- Only **strict** improvements on a deterministic score, so A→B→A cannot happen.
- Every precondition `moveProperty`/`swapProperties` enforce is re-checked first. A refused
  rearrange is not a wasted turn, it is an **infinite loop** — it costs no play and no budget,
  so `botTakeTurn` would re-decide, re-propose and reschedule forever. Fuzzed over 300 random
  boards in `test/bot-economy.test.js`; the engine never refuses one.
- **At most four per turn**, read off the engine's own budget. Measured over 1,500 games:
  89% of rearranging turns make exactly one move, 4 happened 7 times in 1,500 games.

Measured effect, 400 games: 380–426 rearranges per personality per 400 games for the three
planning modes, of which ~1 in 3 completes a set outright.

**The atomic swap (`d05d523`) is wired in and never fires.** Zero `swapProperties` calls in
400 games. It is only reachable when *no* single move helps — which is the deadlock it was
ruled in for — and a bot's board effectively never reaches that shape, because the planner
keeps the board tidy enough that one-card moves are always available first. Kept, because
mid-game takeover from an arbitrary human-played board is exactly where that shape *would*
appear, and it costs nothing to hold.

### 3. §3.1c: Surge Ops was being armed ahead of charges the engine never doubles

`hasChargeFollowUp()` answered **yes** to Finance Office and Roll Call. §3.1c makes Surge
rent-only, and `game.js` proves it — both call `chargeAmount()` with no `surgeable` flag, so
their multiplier is always 1. Round 5 fixed exactly this inside `tryBreakFinalApproach()` and
left the personality planners, which is where nearly all Surges are played, still wrong.
Conservative additionally armed a Surge and then wandered off to PCS Orders or a property:
89 of its 145 Surges were followed by something other than a charge.

| Surges that expired unused | before | after |
|---|---|---|
| aggressive | 39% | **3%** |
| neutral | 39% | **8%** |
| conservative | 67% | **12%** |
| chud | 77% | 52% |
| random | 85% | 66% |

Random and chud keep a small chance of arming one for nothing — that is the seat's character
— but they no longer burn a play on a multiplier with no rent in hand at all.

### 4. Rent is worth what it collects, not what it prints

Two corrections, both of which the old ranking got wrong in the same direction:

- **A colour rent charges the whole table.** Only §3.2's wild "any" rent names one victim. A
  2M charge on a colour collects 6M at a four-handed table while a 4M wild rent collects 4M.
  The old code compared face values across cards and systematically preferred the wild.
- **A charge is capped by what the victim can hand over,** and anything above their *bank*
  has to come off the board — which is denial, and worth more than the same millions in cash.
  `collectableFrom()` prices both. A wild rent now goes to whoever the charge actually hurts,
  with the leader worth two millions a set, so it still hits the player in front unless they
  are too broke to feel it.

| millions collected as a share of the hand's best | before | after |
|---|---|---|
| aggressive | 97.7% | **99.9%** |
| neutral | 96.4% | **99.8%** |
| conservative | 91.7% | **98.1%** |
| chud | 81.3% | 81.0% |
| random | 76.8% | 74.9% |

Chud and random are unchanged **on purpose** — they still roll for colour and victim, and
that gap is now the clearest single expression of the personality split.

### 5. A fifth change, small: charges that only disarm when stacked

Round 5's break branch asked of each charge alone *"does this beat `disposableValue`"*, which
threw away every hand that could only clear the bar by stacking two — a 4M rent and a 5M
Finance Office cannot disarm a victim holding 6M of loose change one at a time and
comfortably can together. The bar is now the **sequence that fits in this turn**. Worth +0.35
points of shot-down at four seats and +0.4 at five. This is *not* the attrition fallback
round 5 measured and removed: that one fired charges the victim could pay in full, which
cannot disarm anybody by definition.

### What each personality got

| | payment | rearrange | Surge | rent |
|---|---|---|---|---|
| **conservative** | full | always, incl. consolidation | rent-only, and fires it immediately | full |
| **neutral** | full | always, incl. consolidation | rent-only | full |
| **aggressive** | full | always, incl. consolidation | rent-only | full |
| **chud** | full | 30%/decision, **set-completing moves only** | rent-only, 25% chaos burn | unchanged (random colour + victim) |
| **random** | full | 12%/decision, **set-completing moves only** | rent-only, 20% chaos burn | unchanged (random colour + victim) |

The payment fix is universal and deliberately so: it is the thing the owner complained about,
and a personality expressed as "hands the human free money" is not a personality. The axis the
chaotic two keep is *attention* — they do not notice a free set most of the time, they never
consolidate, and their rent still goes wherever it lands.

### Balance (paired seed, ≥500 games per matchup, every seat × every k-subset)

| | 3 players (15,000) | 4 players (10,000) | 5 players (2,500) |
|---|---|---|---|
| random | 20.3 → **21.1** | 13.3 → **13.6** | 10.6 → **11.8** |
| conservative | 36.7 → **37.4** | 26.6 → **27.6** | 20.2 → **19.7** |
| neutral | 44.9 → **42.6** | 32.8 → **32.1** | 23.4 → **24.1** |
| aggressive | 44.9 → **43.9** | 38.4 → **37.1** | 34.0 → **31.3** |
| chud | 19.8 → **21.5** | 13.8 → **14.7** | 11.8 → **13.1** |
| first-player advantage | 33.8 → 33.3 | 24.2 → 22.9 | 17.8 → 15.5 |
| avg turns | 28.1 → **26.6** | 35.6 → **33.8** | 48.2 → **45.6** |
| p90 turns | 38 → **35** | 53 → **49** | 97 → **88** |
| max turns | 85 → **61** | 125 → **118** | 155 → **134** |
| final approaches shot down | 22.7 → 21.6 | 45.6 → **44.5** | 62.8 → **65.4** |
| armings per game | 1.46 → 1.48 | 2.14 → 2.18 | 2.87 → **3.25** |
| **decided on §3.6 points** | 0 → **0** | 0.29 → **0.11** | **8.44 → 7.88** |
| contested approaches | 8.2 → 9.2% | 15.7 → **18.9%** | 25.2 → **33.0%** |

§3 bounds hold at every seat count. Every game decided. Reproduced on an independent
confirming seed, every figure within 1 point.

**The canary is green.** Five-player §3.6 points-endings go 8.44% → 7.88% (7.04% on the
confirming seed) against the 8.4% watch line, and p90 drops 97 → 88 — the payment fix alone
pushed those to 11.6% and 106, and the rearranger paid all of it back and then some.

**The one thing that got worse: four-player shot-down, 45.6% → 44.5%.** The cause is the
payment fix — an armed player who no longer overpays keeps more loose change, so
`disposableValue` is higher and a charge disarms less often. Real (≈3 standard errors over
22,000 armings), and priced honestly: it buys a 5% shorter game, a lower points-rate, and a
5-player shot-down that goes the other way (+2.6). Contested approaches rose sharply at every
seat count, which is the drama the mechanic exists for.

### The honest difficulty number

Bot-only matrices cannot answer *"is this harder for the human"*, because every seat improves
at once. So the bot as it shipped at HEAD was frozen as a fixed opponent and seated at the
Quick Play bench (`neutral + aggressive + conservative`) against the old table and the new
one — 3,000 games per cell, fair share 25.0%.

| seat-0 policy (frozen) | vs OLD table | vs NEW table | delta |
|---|---|---|---|
| old bot, neutral | 20.9% | **13.2%** | −7.7 |
| old bot, aggressive | 21.3% | **14.1%** | −7.2 |
| old bot, conservative | 19.9% | **10.4%** | −9.5 |
| old bot **+ the payment fix only**, neutral | 27.0% | **16.7%** | −10.3 |
| new bot (plays to the same standard), neutral | 31.2% | **19.9%** | −11.3 |

Read the rows, not the deltas. **The bots are meaningfully harder** — a player who plays like
the old bot loses 7–9 points of winrate. But note the second column of row 2: *simply not
overpaying* is worth +6 points to whoever does it, and a human already does not hand over 11M
for a 5M debt. And row 3: a player at the new standard sits at 19.9% against the new table,
essentially where the old bot sat against the old table (20.9%). **The difficulty increase
falls almost entirely on careless play**, which is the right place for it, but it is real and
the owner may want some of it back.

If he does, the dial is `REARRANGE_BIAS` (exported on `Bot._internal`), and it is honest
about how little it buys:

| planner bias | fixed old neutral bot's winrate |
|---|---|
| 1.0 (shipped) | 13.2% |
| 0.7 | 14.0% |
| 0.5 | 13.9% |
| 0.0 (rearranging off) | 15.1% |

Turning the rearranger off entirely returns **1.9 of the 7.7 points**. The rest is the
payment, rent and Surge fixes — which is to say, the rest is the thing that was asked for.
There is no version of "stop giving the human free money" that is also easier.

### Things measured that did not change, and why

- **Property placement.** 98% of the achievable board-score gain, for all three planning
  modes, before any change. The obvious rewrite was worth nothing.
- **The OPSEC chain.** Round 5 measured its headroom at ~0.3 points and nothing moved it.
- **The atomic swap.** Wired, correct, and fires zero times in 400 games (see §2 above).
- **Discarding.** Neutral discards by value and will throw a 1M property before a 2M money
  card; aggressive discards money first. Both look wrong on inspection and neither showed up
  as material in 400 games — hand-limit discards are rare enough that this is the next
  round's problem, not this one's.

### A structural note for whoever comes next

`Bot._internal.applyBotAction(state, playerId, action)` is now the canonical place a bot
decision becomes an engine call. `executeBotPlay` and the test suite go through it;
`simulate.js` keeps its own switch only because it records per-case telemetry around each
call, and its cases are kept in step deliberately. Every driver used to reimplement the
switch privately, and the day §3.8's rearrange was added `test/protocol.test.js` silently
stopped executing bot decisions and spun its turn loop to the step cap — a passing-looking
harness driving a game that never ended. If a new decision type is ever added, add it to
`applyBotAction` first, and check `simulate.js` and any new harness against it.

---

## Round 8 (2026-08-07) — play the House before the rent, not after

Owner report, watching live play on `c881960`: *"right now they will do things like charge
rent and then add houses/upgrades they should play their cards in the correct order
(depending on bot type)."*

### The structural cause

`decideBotPlay()` returns **one play at a time** and the caller re-enters for the next.
There is no turn-level plan, so there was no place where "the Upgrade goes before the rent"
could live — each call independently scores the best single play, and if the rent scored
higher on this call it went first. The ordering was an accident of scoring, not a decision.

### The measurement first, as always

Instrumented over 400 four-player games (same lineups as the matrix), counting every turn in
which a rent on colour C was followed **in the same turn** by an Upgrade/FOC on C or by a
property played into C, with the forfeited millions computed against each payer's actual
wealth at charge time:

| per personality | random | conservative | neutral | aggressive | chud |
|---|---|---|---|---|---|
| mis-ordered turns per game | 0.02 | 0.04 | 0.06 | **0.10** | 0.04 |
| mis-orders per 100 rents | 1.1 | 2.2 | 2.8 | **4.0** | 2.1 |
| **M forfeited per bot per game** | 0.08 | 0.22 | 0.28 | **0.51** | 0.12 |

**The honest number: this is an order of magnitude smaller than the overpay round**
(0.08–0.51M vs 7.6–8.8M per bot per game). It was never going to move a winrate. What it
was doing is showing the owner a visibly wrong play every few games — at a Quick Play bench
of three planning bots misordering ~2–4% of their rents, one backwards sequence surfaces
roughly every four games. The fix is priced to match the size of the defect.

### The shape: a dependency pass, not a turn planner

**Rejected: a full turn planner.** Three plays over a large branching factor would replace
personality scoring that is measured and working, to recover half a million per game — all
risk, no case. **Chosen: one rule at the existing chokepoint.** After the personality plan
comes back, if it chose a **rent** and the hand holds a play that raises that exact rent —
an Upgrade/FOC on the charged colour (+3/+4 per payer), or a property that climbs the
colour's rent ladder — and `playsRemaining >= 2` so the rent still fires afterwards, the
booster goes first (`findChargeBooster`).

Because the pass runs *after* the plan, it cannot change **what** a personality decided to
do, only the order it does it in — which is exactly the owner's parenthetical read back to
him: *whether* a bot builds before it charges is personality; playing both backwards is
nobody's strategy. Guards, each pinned in `test/bot-economy.test.js`:

- **Never on the last play.** A booster with no play left for the rent would trade the
  charge for a building — worse than the mis-order it fixes.
- **Wilds are not hijacked.** A wild is redirected onto the rent colour only when
  `chooseBestColorForWild()` was sending it there anyway; a wild that completes a
  different set keeps going there.
- **The §3.10 break branch is exempt.** It returns before the pass, and its charges are
  sized against `disposableValue` by logic that is separately measured.
- **Surge composes.** Surge → booster → rent all fit (the booster check runs at the rent,
  after the Surge has spent its play), so the doubled rent is the boosted one.
- **Termination.** Each booster leaves the hand when played and the pass needs two plays,
  so it fires at most twice ahead of one final rent.

`ORDER_ATTENTION` (exported on `Bot._internal`) carries the personality: the three planning
modes always order correctly; chud notices 30% of the time and random 12% — the same
attention axis as `REARRANGE_BIAS`, so the chaotic seats keep visibly imperfect ordering as
part of their character.

### After

| per personality | random | conservative | neutral | aggressive | chud |
|---|---|---|---|---|---|
| M forfeited per bot per game | 0.14 | **0.09** | **0.09** | **0.09** | 0.11 |
| mis-orders per 100 rents | 1.5 | 0.7 | 0.5 | **0.3** | 1.5 |

The planners' residual is chains the pass cannot see one play ahead of: an Upgrade drawn by
PCS Orders *after* the rent, or a set that only became complete after the charge. Random and
chud keep their gap by design.

### Balance (paired seed against round 7, ≥500 games per matchup)

3p and 4p: every personality within ±1 point of round 7, first-player advantage, turns, p90,
shot-down and points-rate all within noise. 5p (2,500 games, 5 lineups) showed random
11.8 → 9.5, which a 5,000-game confirming seed resolved as sampling noise (random 10.2,
conservative 22.3, neutral 22.7, aggressive 33.5, chud 11.4 — all inside 8–60%). **The §3.6
canary improved: 5-player points-endings 7.88% → 6.76–6.78% on both seeds** (watch line
~8.4%), p90 88 → 82.

Human-seat check (fixed pre-round-7 bot at the Quick Play bench, 3,000 games/cell): the old
bot wins 14.7/12.5/10.9% against the new table vs 13.2/14.1/10.4% against round 7's —
within noise. **Round 8 did not move the difficulty**; it removed an eyesore.

### Test subset

Reported against the bot-relevant subset (`bot-economy`, `bot-finalapproach`, `game`,
`protocol`, `winrule`, `property-swap`, `wild-rearrange`, `deckconfig`,
`finalapproach-race`): **155/155** (151 baseline + 4 new ordering tests; the two positive
ones fail on `c881960`, the two guards pin the last-play and wild-hijack invariants). The
full-suite total is noisy this hour from another agent's mid-edit work in `server/icon.js` /
`server/raster.js`, which is outside bot ownership.

---

## Round 9 (2026-08-07) — finish the set first: one case already fixed, one worth four lines, one measured and rejected

Owner, watching the round-8 build: *"if bots are going to finish a set that turn (have them
finish the set before they play any rent cards as long as its in hand)."*

The request splits into three different questions, and they got three different answers.

### Same colour: already covered, with the measurement to say so

A completing property IS the biggest ladder climb there is, so round 8's `findChargeBooster`
already takes it before the rent. Measured over 400 four-player games: rents fired with a
same-colour completing play still in hand are 0.13% (neutral) and 0.29% (conservative) of all
rents — extinct for the planners, residual entirely the deliberate last-play guard and the
chaos seats' attention roll.

### Cross colour: worth zero millions — and shipped anyway, priced as an eyesore

What the owner actually saw is the cross-colour case (1.2–4.0% of rents fire with a
completing play of a *different* colour in hand). Before building anything, the three
mechanisms that could make the order matter were each checked against the engine:

- **OPSEC chains never consume plays** — `respondToAction` does not touch `playsRemaining`,
  so a blocked rent cannot cost the bot the play the property needed.
- **Completing our set changes nothing about how a payer answers** — §3.1's protections are
  the payer's, evaluated on the payer's board.
- **Arming is turn-granular** — `armedAtTurn` is the `turnCounter`, identical at play 1 and
  play 3 of the same turn, so completing earlier in the turn starts no earlier clock.

**Cross-colour ordering is worth zero millions.** It is, however, exactly the kind of
visible wrongness round 8 existed to remove, and the fix reuses that machinery: when the
plan is a rent and `findChargeBooster` finds nothing on the rent's own colour,
`findCompletingPlay` puts any set-completing property (or a wild onto any colour it
completes — finishing a set is never a bad wild placement) down first. Same guards: never on
the last play, §3.10 break branch exempt, `ORDER_ATTENTION` keeps chud at 30% and random at
12%. Measured after: neutral's cross-colour rents-before-completion went 9 → **0** per 400
games, aggressive 39 → 9, conservative 21 → 7 (the residue is the last-play guard, which is
correct — the planner's chosen charge outranks tidiness when only one play remains).

Note what the guard test enshrines: at one play left, *aggressive* fires the rent — but
*neutral* plays the property, because neutral's own priorities put building before charging.
That is the personality split working as designed, not a gap in the pass.

### Completion as a strategy: measured, and rejected

The genuinely separate question — is finishing a set worth prioritising above rent and
attacks for §3.10 reasons, not ladder reasons? Frequency first: the planners already play a
held completing card the same turn **86–96%** of the time, and a *third*-set completer is
left in hand only 0.02–0.10 times per bot per game. Then the A/B anyway, since it is cheap:
a temporary variant in which any completing play outranks the whole personality plan for
the three planning modes, 10,000 games against a same-seed control at 4 players:

| | control | completion-first |
|---|---|---|
| neutral | 31.76 | 32.96 (+1.2) |
| aggressive | 36.96 | **36.21 (−0.75)** |
| conservative | 28.38 | 28.43 |
| random / chud | 13.55 / 14.35 | 13.25 / 14.15 |

No net gain, borderline significance on both movers — and the sign on aggressive says
forcing build-before-charge *hurts* the personality whose style is to charge first, which is
the owner's own parenthetical ("depending on bot type") read back as data. There is also a
real §3.10 reason not to force it: a completed third set can be broken during the grace
cycle; a hand card cannot be stolen at all. **Not shipped.** The variant was a temporary
patch, measured and reverted; nothing of it remains in `bot.js`.

### Validation

Paired-seed matrices vs round 8 (≥500/matchup): every personality within ±1 point at 3, 4
and 5 players, all inside 8–60%; turns, p90, shot-down flat; **canary 6.76% → 6.84%** at 5
players (watch line ~8.4%); 100% decided. Quick Play bench seat-0 unchanged (±0.3). Fixed
pre-round-7 bot vs the new table: 21.1/22.3/19.0% — same envelope as rounds 7–8, difficulty
not moved. Bot-relevant test subset **157/157** (21 in `bot-economy` — the cross-colour
positive fails on `8ea52aa`, and a guard pins that the completing play never eats the last
play the charge needed). A transient red reported in `bot-economy` against the full tree
was another agent's mid-edit churn: the file was green in isolation and the full suite reads
417/417 at this tree.

---

## Round 10 (2026-08-08) — the charge that collects nothing, and the defensive rearrange that was already happening

Owner report: *"bots play better and smarter — simulate games but sometimes they charge rent
when all players have nothing, don't play cards in correct order etc and don't move cards
around as much to protect sets in general."* Three named defects; each got measured before
it was touched, and they got three different verdicts.

### 1. Wasted charges — a strict blunder, fixed universally

`findBestRent()` and `findRentOnCompleteSet()` ranked rent candidates by the millions they
COLLECT (`rentYield().value`, already capped by what the victims own) but never GATED on it,
so a bot holding a 4M complete-set rent fired it into a table holding 0M and collected
nothing. `playerTotalValue` 0 means the player owns nothing of value, so there is nothing to
force out either — it is a lost play with no denial. Finance Office (targeted by
`findRichestPlayer`, which reads BANK only) and Roll Call (played unconditionally) had the
same hole. This is the owner's *"charge rent when all players have nothing."*

Instrumented over 800 four-player games (every rotation of every 4-subset, same lineups the
matrix uses), classifying each rent/Finance Office/Roll Call by its collectable value BEFORE
it was applied:

| wasted charges per bot per game | random | conservative | neutral | aggressive | chud |
|---|---|---|---|---|---|
| **before** | 0.139 | 0.070 | 0.050 | 0.228 | 0.247 |
| **after** | **0.000** | **0.000** | **0.000** | **0.000** | **0.000** |

Table-wide: **470 / 13,692 charges wasted (3.43%) → 0 / 13,631 (0.00%)** on the identical
seed. A charge that collects nothing helps no personality's style, so the gate is universal:
`makeRentPlay` refuses a rent whose `rentYield` is 0; `findFinanceTarget` returns null when
no opponent can pay and prefers draining an actual bank otherwise; Roll Call and Surge-arming
(`hasChargeFollowUp`) both gate on `anyoneCanPay`. The chaotic seats keep their random colour
and random victim — `chooseRentTarget`/`randomPayer` just draw that victim from the players
who can PAY, so a wild rent never lands on a pauper while a solvent seat sits there. Firing at
someone who has nothing was never chaos, only waste.

**Balance (paired seed, 2000 games/seed, every seat × every 4-subset):**

| | seed `balance` before→after | seed `balance2` before→after |
|---|---|---|
| random | 12.3 → 12.2 | 12.8 → 12.4 |
| conservative | 29.8 → 27.7 | 28.4 → 27.8 |
| neutral | 32.1 → 31.2 | 31.8 → 29.9 |
| aggressive | 35.9 → **38.5** | 39.0 → **41.1** |
| chud | 14.9 → 15.4 | 13.1 → 13.8 |
| first-player adv. | 21.0 → 24.9 | 23.3 → 26.4 |
| avg turns | 33.2 → 33.1 | 33.4 → 33.4 |

§3 bounds hold (8–60%) at both seeds, 100% decided, turn length flat (the fix is about which
plays are wasted, not how many are made). The consistent movement is **aggressive +2.1/+2.6**,
which is the correct behavioural consequence: aggressive charges most, so sharpening its
charges rewards it most, and it stays well under the 60% ceiling. Conservative/neutral give
back ~1–2 points to it. **Distinctness preserved** — the winrate spread stays wide
(random ~12, chud ~14, conservative ~28, neutral ~30, aggressive ~39–41) and the chaotic seats
keep every visibly-imperfect trait (see §3 below and the ordering residual: chud fires a rent
with a set-completer still in hand 4.2% of the time, random 2.4%, against the planners' 0.1–1.1%).

### 2. Play ordering — already fixed in rounds 8–9; residual is at the designed floor

The owner's *"don't play cards in correct order"* was rounds 8–9's territory
(`findChargeBooster`, `findCompletingPlay`). Re-measured at this HEAD: a rent fired with a
set-completing property still in hand is **neutral 0.1%, conservative 1.0%, aggressive 1.1%**
of all rents — the residual is exactly the deliberate last-play guard (round 9: at one play
left, aggressive fires the charge its plan chose, which is personality, not a gap). Random
(2.4%) and chud (4.2%) keep their `ORDER_ATTENTION` gap by design. **No change** — round 9
already measured that forcing completion-first *hurts* aggressive, and the numbers say the
planners are at the floor.

### 3. Defensive rearranging — measured, and it turns out the offensive rearranger already does it

The owner's *"don't move cards around as much to protect sets"* was the subtle one the task
flagged as a possible lever. It is a **null result**, and the reason is structural: the only
rearrange that protects a set is **completing it** — Midnight Requisition and TDY are both
barred from complete sets (`zoneRequisitionable`), so moving a wild in to finish a set is the
one move that takes its cards out of steal reach. IG (whole complete set) and CHUD (best single
card, from anywhere) cannot be dodged by any legal rearrange at all: you cannot move a card out
of a complete set to save it (that loses the set), and every incomplete zone is equally
reachable, so a wild that *cannot* complete a set has no safer home to move to.

And the planners are already taking the completing move. Measured over 600 games, sampling
every non-armed turn start for a free move that would complete a set (= shield it), and
checking whether it survived to end-of-turn unfixed:

| per game | random | conservative | neutral | aggressive | chud |
|---|---|---|---|---|---|
| rearranges made (§3.8) | 0.31 | 1.26 | 1.28 | 1.46 | 0.43 |
| shield-by-completion left **unfixed** | 0.440 | **0.004** | **0.000** | **0.004** | 0.154 |

The planning modes leave a shieldable set unprotected **0.4% of the time or less** — the
offensive concentration hill-climb from round 7 *is* the defensive tool. The only unfixed
shields belong to the chaotic seats (`REARRANGE_BIAS` 0.12/0.3), which is their entire
character. A dedicated "defensive rearrange" would have nothing left to do but relocate
un-completable wilds, which protects nothing and would only churn the board and lengthen games.
**Recommendation: do not add one.** The perception that bots "don't move cards around" is
answered by the usage number — planners rearrange 1.3–1.5×/game — not by new code. (Because
nothing was added here, the §3.6 turn-length risk the task warned about never materialised;
avg turns held at 33.1.)

### Tests and gates

Five new assertions in `test/bot-economy.test.js` (§8 — the four positive ones proven red on
committed HEAD first, the fifth a guard that a solvent table is still charged so the gate does
not over-fire): a complete-set rent is not fired into a broke table (all 5 modes), a rent IS
fired the moment one opponent can pay, a wild rent points at a payer even for the chaotic
seats, Finance Office and Roll Call are not played against a table that can pay nothing. One
existing Surge test was given a solvent opponent so *"a rent can actually follow it"* means a
rent that collects — the new `hasChargeFollowUp` gate correctly refused to arm a multiplier
over an empty table. **Full suite 496/496**, `node tools/verify.mjs` **exit 0** (all 17 gates
green including simbalance, playtest, touchtest, screenshot, checkContrast, audiotest).

### What did not work / was rejected

- **A dedicated defensive rearranger** (moving wilds to "protect" sets): rejected on the
  measurement above — the offensive rearranger already captures the only protection that
  exists, and there is no safe destination for an un-completable wild.
- **Gating chaotic wild-rent on the specifically-chosen target instead of the payer pool**
  would have made chud/random skip a wild rent whenever their random roll hit a broke seat
  even though a payer existed — erasing charges rather than retargeting them. Drawing the
  random victim from the payer pool keeps the charge and the chaos both.

---

## Round 11 (2026-08-08) — card awareness: counting the cards in play and unseen

Owner directive: bots that reason about cards they cannot see — the discard pile, the deck
composition, and how many counter-cards remain live — under a hard honesty rule: **a bot may
count how many copies of a kind remain unseen, but the deck and opponents' hands are one
undifferentiated pool. Peeking is a bug, not an optimization.** `unseenCounts()` reads the
discard pile, every table and the bot's own hand, and is recomputed from visible state on
every call — so a reshuffle, which returns the discard to the unseen pool, honestly REOPENS
the window (the count rises again). Pinned in `test/bot-cardcount.test.js`: swapping an
opponent's hidden hand for entirely different cards must not move any number the counter
produces.

Four angles, measured first over 400 four-player games (seed `aware-base`, every rotation of
every 4-subset) and 500 five-player games (seed `aware-base5`). Two shipped, one shipped
small, one measured and REJECTED. The new personality axis is `CARD_AWARENESS`
(conservative 1, neutral .9, aggressive .75, chud .15, random 0): awareness is a planner
skill, the gremlin rarely notices, random never does — and a zero-awareness mode consumes no
RNG roll, so RANDOM's stream is untouched. (Chud, at 0.15, does consume its awareness rolls —
the QA pass caught this section originally claiming both chaotic seats' streams were
untouched, which was true only of random. Chud's balance is unmoved; the record is what
needed correcting.)

### Angle 1 — counting the counter-cards (shipped)

The deck holds 3 OPSEC against 4 hard breakers (2 IG + 2 CHUD), all of it countable once
played. Two blind spots, measured at HEAD:

| per 400 4p games | random | conservative | neutral | aggressive | chud |
|---|---|---|---|---|---|
| held a GUARANTEED breaker (0 OPSEC unseen, target live) — decision points | 146 | **75** | 36 | 22 | 11 |
| declined to OPSEC a ≥4M charge with ZERO breakers unseen | 20 | 11 | 3 | **43** | 8 |

The fixes, both gated by `CARD_AWARENESS`:

- **A guaranteed breaker fires now.** Every OPSEC visible → the shot cannot be answered, and
  the window closes at the next reshuffle. `tryGuaranteedBreaker()` runs ahead of the
  personality plan and the holdback. CHUD still requires a steal worth the card — completes
  one of our sets or takes from a complete set — a free shot at a 1M orphan is a wasted CHUD.
- **A dead shield blocks.** When every IG and CHUD is accounted for, a ≥4M charge IS the top
  of the remaining threat ladder, so an aware personality blocks it instead of saving the
  shield for a card that no longer exists. (Aggressive's "never OPSEC money demands" keeps
  its character everywhere else — this is the one countable exception.)

After: held-guaranteed cons 75→**19** (IG residual **0**; the rest is the deliberate
CHUD-orphan guard), neut 36→**10**, aggr 22→**3**; aggressive's dead-pool ≥4M declines
43→**20** (the residual is property attacks, deliberately untouched — MR/TDY cannot reach a
complete set). simbalance 2000 games × seeds `balance`/`balance2`: PASS both, every delta vs
the round-10 pairs ≤2.4 points, avg turns 33.2 flat, FPA 25.2/25.8.

### Angle 2 — the deck-cycle clock (shipped)

`shuffleCount` is public (every shuffle is a table event) and §3.11 adjudicates on points at
16 reshuffles. **A correction first, for the record:** the first version of this measurement
counted end-of-turn nulls (playsRemaining 0) as "passes" and read ~100 per mode; the honest
metric slices on plays still remaining. So corrected: in the last quarter of the cycle budget
(shuffle ≥ 12), real holdback passes with plays left, per 500 5p games:

| | random | conservative | neutral | aggressive | chud |
|---|---|---|---|---|---|
| before | 19 | **28** | 17 | 6 | 0 |
| after | 17 | **2** | 5 | 2 | 0 |

The endgame tail is not card-starved — passers held PCS Orders (~1.7 per pass), usable rents
and even unbanked money; they were saving plays for a "later" the attrition cap was about to
adjudicate away. And nobody played the points game: random won 12 of 37 points endings, more
than any planner. Fix: an aware planner skips the human-like holdback while the clock is
running (`shuffleCount >= DECK_CYCLE_LIMIT - 4`). Chud and random keep their character.
After: random's points wins 12/37 → 6/38. 5p canary (paired 2500-game matrix, seed
`aware-5p`): p90 83→82, points 6.56%→6.84%, avg turns 44.1→44.2 — flat. At 4 seats the
window is effectively unreachable (0.3% of games), so the 4p matrix is untouched.

### Angle 3 — rent-leverage set building (measured and REJECTED)

The hypothesis: prefer building colours whose rent cards are still live (held, or unseen and
drawable); 4.5–7.9% of planner set completions were "dead" (no matching rent in hand, none
unseen). Built: a leverage tiebreak (+0.2 max against 0.33 per real progress step) in
`findBestPropertyPlay()` and the wild colour choice, graded by awareness, tests proven red
then green. **It moved nothing, on two seeds:**

- Seed A (400 games): dead completions cons 6.8→6.9%, neut 4.5→4.8%; rent income cons +5.9M/400g.
- Seed B (800 games): dead% "improved" — **equally in random and chud, which do not have the
  change** (7.9→5.8 and 10.3→6.6): table-level noise, not the fix. Rent income for
  conservative flipped sign (−2.9M).

The mechanism explains it: a "dead" completion is usually decided by rents SPENT after the
colour was committed — placement-time leverage cannot foresee it, and the completion itself
is still correct (a set is a third of the win regardless of rent). Reverted per the round-9
precedent; nothing of it remains in `bot.js`. Raising the weight was rejected without
measurement: past 0.33 it stops being a tiebreak and starts distorting placement, which is
the measured-and-working part.

### Angle 4 — target focus (shipped, with a priced trade)

Verified first, as the task demanded: rent (`chooseRentTarget`), Finance Office
(`findFinanceTarget`) and the §3.10 break branch were ALREADY leader- and payability-aware
(round 7) — planners chose the leader on 63–72% of targeted plays at HEAD. The measured blind
spot was the STEAL finders: the "advance our set" loop walked opponents in **seat order** and
took `cards[0]`, and `tryDefensiveOffense` iterated `findThreats()` in seat order too.

Fix: `findBuildingSteal()` collects every candidate for the colour and picks by completed
sets (leader denial), then card value (never the 0M rainbow wild over a 3M card, which
`cards[0]` regularly was); `tryDefensiveOffense` ranks threats by sets then payable value and
its MR pick takes the best requisitionable card. Colour choice and the chud/random finders
are untouched.

| non-leader steals with a legal leader alternative, per 400 4p games | cons | neut | aggr |
|---|---|---|---|
| before | 22 | 29 | 46 |
| after | **5** | **9** | **20** |

(The residual is equal-sets ties decided on card value, which is a coin's difference.)
Leader-targeting spread preserved: random 48.5 / chud 56.8 / aggr 66.1 / neut 73.6 / cons
78.8. simbalance 2000 × both seeds: PASS, avg turns 33.4/33.7, FPA 26.3/27.0.

**The honest cost, and its attribution.** At five seats, sharper leader denial breaks more
approaches, and round 5 already taught what that buys: a longer tail. Paired 2500-game 5p
matrices: seed `aware-5p` points-endings 6.84→8.28%, p90 82→90; seed `aware-5p2` 8.04→9.04%,
p90 87→88 (break rate +1.4/+2.0). An attribution experiment (threat-sort surgically disabled
at c9ea0c0, same seed) splits the change: **the threat-sort carries the entire 5p cost**
(9.04→7.24 points, p90 88→81) — but also carries the conservative/neutral fix (without it
their defect reads 26/24, i.e. unfixed, because their steals flow through
`tryDefensiveOffense`). `findBuildingSteal` alone is cost-free and fixes aggressive. Kept
whole, per the round-5/round-7 precedent of shipping a named trade: the cost lands only at 5
seats, inside the round-5 envelope (8.3% shipped then), and the dial is explicit — drop the
threat-sort to trade cons/neut steal focus for ~1–2 points of 5p points-endings, or seat the
round-6 `escalate` + 12–13 wilds variant, which remains the one measured remedy that improves
every 5p axis at once. Worth watching if 5-player becomes common, same as round 5 said.

### Lever finding, not forced: breaker timing

60–72% of all IG/CHUD shots are fired while ≥2 OPSEC remain unseen — gambles, in counting
terms. Not changed, deliberately: holding breakers until the pool thins would slow the tempo
the whole table is balanced around, round 5 measured the OPSEC-chain headroom at ~0.3 points,
and the guaranteed-shot branch already harvests the clean end of this lever (shots fired at a
dead pool rose ~35→50 per 400 games). If an owner ever wants cagier breaker play, gate the
personality plans' IG/CHUD priorities on `unseenCounts().opsec >= 2` — but measure the §3.6
cost first; it will lengthen games the same way every break-rate buff has.

### Distinctness, checked not assumed

Action-mix shares moved <1.5 points everywhere across the round; every personality gap
survives: rearranges/decision (chaotic 1.3–2.1% vs planners 5.4–6.0%), chud banking 11.7% vs
planners' 16–18%, leader-targeting 48.5/56.8 chaotic vs 66–79 planners, random's holdback and
blind OPSEC untouched. The graded `CARD_AWARENESS` axis is the round's contribution to the
split, not a convergence: five modes that all count cards would be one mode, so two of them
mostly don't.

### What did not work / for the record

- **Rent-leverage placement** (angle 3): measured on two seeds, rejected as pure noise — see
  above. The measurement scripts live in the session scratchpad; the dead-completion
  classifier is worth rebuilding if this is ever re-attempted with a different mechanism
  (e.g. leverage-aware DISCARD choice, which nobody has measured).
- **The first angle-2 metric** counted end-of-turn nulls as holdback passes (~100/mode,
  off by 10×). Slice on `playsRemaining > 0`.
- **Guaranteed-CHUD without a value guard** would fire at 1M orphans; the orphan guard is
  test-pinned (`bot-cardcount.test.js`).

Tests: 508/508 at this tree (496 at round 10 + 12 new in `test/bot-cardcount.test.js`, every
positive proven red on the pre-fix commit first, per §8). `npm run check` green. Full
`node tools/verify.mjs` run recorded in the round's closing commit.

---

## Round 12 (2026-08-12) — the breaker economy: bots that save the CHUD card for the fight

Owner report: *"it feels like they don't plan too far ahead and will just use cards like the
CHUD card or Inspector General instead of saving them to break final approaches … obviously it
makes sense to steal a set if you have 1-2 already and are going for final approach while
holding opsec, but it seems bots don't play that way."*

Both halves were checked before anything was written. Both were right, and the second sentence
turned out to contain the fix for the first. The research pass is `docs/bot-foresight-research.md`;
the measurement tool it produced is `tools/botaudit.mjs`, which is committed precisely so this
round's numbers can be re-run against any future tree.

### The defect, in one line

Every planner asked whether a breaker shot was **legal**. Nothing anywhere asked whether it was
**worth the card**.

### Baseline (`node tools/botaudit.mjs --games 1200`, three seeds, paired)

- **37.8 / 39.5 / 40.8% of all 1,858 hard-breaker plays were fired at a table where nobody held
  2+ sets and nobody was armed.** Per personality at 400 games: aggressive 54.2%, neutral 46.0%,
  chud 45.8%, random 36.4%, conservative 11.9%.
- **21–23% of shots were orphan grabs** — neither out of a complete set nor completing one of ours.
- By the time anybody armed, **2.23 of the deck's 4 breakers were already dead**, and **72–73% of
  armings faced a table where not one opponent held a breaker.** `tryBreakFinalApproach` was a
  well-built branch holding an empty gun.
- **41% of landed breakers gained the firer nothing**, and it splits entirely by card: Inspector
  General advances its firer 98.8% of the time (it is a whole set, by construction), THE CHUD
  CARD only 18.0%. **The two cards needed different bars, not one shared bar.**
- 64.7% of the wasted shots came from a bot with **no completed set of its own** — the literal
  "why did it play Inspector General on turn 2" complaint.

### The change

**§3.10c the escrow.** `worthwhileBreakerShot()` retargets-or-refuses every breaker at the
selection sites (`tryOffensiveActions`, `tryDefensiveOffense`, `decideAggressive` 3–4). A shot
clears the bar on DENIAL (out of a complete set held by a player at `setsToWin - 1`) or on SELF
(it hands us a set and lands us at `setsToWin - 1` or better). Retargeting is half the value on
its own: aggressive had no threat branch at all, so `findBestIGTarget` sent it at the fattest set
on the table rather than at the player about to win, and `tryDefensiveOffense`'s CHUD branch
picked the threat's most valuable card *regardless of whether it sat in a complete set* — a shot
that disarmed nobody.

**The escort clause is what made it work, and it came from the owner's sentence.** The first
build gated only on set counts and moved the headline 39.5% → 30.6% while leaving
breakers-in-hand-at-arming at 19.5% → 19.7% — it changed where the shots went without changing
that the gun was empty when it mattered. Requiring an OPSEC in hand (or a dead OPSEC pool) before
a shot may be justified by advancing our own win is the difference. It is also what the strategy
field says: *wait to play the Deal Breaker until you have a Just Say No for reinforcement.*

**The patience roll was measured and removed.** The escrow was first built with a graded
per-decision probability (conservative 0.95 / neutral 0.8 / aggressive 0.5). It barely worked —
a bot holding at p=0.8 across ten decision points fires anyway 89% of the time — and moved the
no-threat share by 2pp. **A probability re-rolled every decision is not patience; it is a delay.**
The personality axis became the BAR instead:

```
BREAKER_BAR = { conservative:{denyAt:1,escort:true}, neutral:{denyAt:1,escort:true},
                aggressive:{denyAt:1,escort:false}, chud:null, random:null }
```

Deterministic, so it costs zero new `rnd()` calls and paired-seed comparison stays alive. chud
and random keep `null` — reckless is their character, they fire 43% of the wasted shots, and
disciplining them would collapse five personalities into one.

**Two leaks had to be closed or the escrow just moved the waste.** Aggressive's banked breakers
went 20 → 82 per 400 games once it stopped firing them: it fell through to its step-12 "bank
anything" branch and sold them for cash. The bank veto was widened from "somebody is armed" to
"the escrow is holding this card". And `chooseDiscards` sorted `inspector_general`/`chud` to the
**front** of conservative's discard list — told to hold a breaker it would hold it to the hand
limit and then throw it away ahead of a 1M. All three comparators now keep OPSEC last, then hard
breakers. (Aggressive was separately discarding its 4M OPSEC to keep a 5M Inspector General on
the exact turn it armed — the shield thrown away one turn before the whole table shot at it.)

**§3.10c promotion.** The escrow can only say no to a shot the planner proposed, and the planners
bury breakers — conservative reaches its offensive branch at step 8, *behind* building, so an
Inspector General that would hand it the winning set lost every turn to a 1M property play.
`tryArmingBreaker` and `tryArmingPlay` ask, before the personality plan and before the holdback,
"does a card in my hand win the game right now". Nothing in this file had ever asked that.

**§3.10d steal → rent.** Round 8's dependency pass never considered a steal as a booster. A steal
that completes the charged colour turns a 3M rent into an 8M rent on a finished set. Three engine
preconditions are re-checked so the play cannot be refused; the third is the subtle one — the
card must ALREADY sit in the charged colour, because `game.js` resolves a steal through
`receiveProperty(..., card.placedColor || card.color)`, so a green/darkblue wild parked in their
*green* zone lands in our *green* zone and raises the darkblue rent by nothing.

**§3.10f cushion pressure.** See "what did not move" below.

### After (1200 games, three seeds, paired against `338902b`)

| metric | before | after | delta |
|---|---|---|---|
| fired at a no-threat table | 37.8 / 39.5 / 40.8% | 28.3 / 30.3 / 30.1% | **−9.8pp** |
| orphan grabs | 21.3 / 22.7 / 22.0% | 9.7 / 10.1 / 10.3% | **−11.9pp** |
| shot advanced our own set count | 59.1 / 59.1 / 57.7% | 64.0 / 64.0 / 62.8% | **+4.3pp** |
| armings facing no breaker in any hand | 73.1 / 73.2 / 72.3% | 65.3 / 65.9 / 67.0% | **−6.8pp** |
| **armings shot down** | 47.9 / 43.9 / 44.8% | 49.9 / 47.4 / 48.8% | **+3.2pp** |
| breaker in hand during a grace cycle | ~19% | 21.8 / 20.6 / 21.4% | +2pp |
| CHUD shots that advance the firer | 18.0% | 28.1% | +10pp |

Per personality (400 games): conservative 11.9% → 10.8%, neutral 46.0% → **18.3%**, aggressive
54.2% → **32.7%**, chud and random unmoved by design.

### Balance (900 games, seed r12base, paired)

| | random | conservative | neutral | aggressive | chud | avg turns | stalemates |
|---|---|---|---|---|---|---|---|
| before | 14.2 | 30.7 | 32.8 | 35.1 | 12.2 | 32.8 | 0.67% |
| after | 12.4 | 28.2 | 31.4 | **39.4** | 13.6 | 33.1 | 0.22% |

All inside §3's 8–60%. Aggressive gains 4.3pp, and the mechanism is legible: it is the one
personality with `escort: false`, so it converts breakers into its own sets while the patient two
wait for a shield. The standing warning that every break-rate buff lengthens games came in at
+0.3 turns, the smallest cost any of them has had.

### What did not work / for the record

- **§3.10e the OPSEC bait: shipped, and it measures NULL on the aggregate.** The share of
  breakers eaten by an OPSEC is 18.8/17.2/18.8% before and 19.1/17.6/18.8% after — flat. The
  first belief threshold (0.25) was a bad constant, sitting exactly on top of a modal belief of
  ~0.23 and rejecting 284 of 358 candidates; fixing it to 0.12 tripled the firing rate and moved
  the block rate by nothing, which exposed the real cap. **It is card availability, not belief:**
  only 93 of 410 candidate moments held a cheap targeted action at the same time as a breaker,
  with two plays left, against a live victim. That conjunction is rare in this deck. Kept at the
  swept value because it costs nothing measurable and is the most legible thing in the round
  (~1 game in 7), but nobody should believe it is doing aggregate work. The lever for a future
  round is availability — add TDY Orders as a third bait card, or let `tryBreakFinalApproach`
  bait — **not** the threshold.
- **§3.10f cushion pressure measured small, and the reason is structural.** Charging the
  pre-armed leader by how much of their *cushion* a charge removes rather than by what it
  collects is correct — the old scorer preferred rich targets, and a rich target is by definition
  the one a charge cannot hurt. But only WILD rents route through `chooseRentTarget` at all; a
  two-colour rent charges every opponent by rule (§3.1). So the change bites on 3 rent cards plus
  Finance Office, and the leader's median bank at 2 sets did not move (8M → 9M). Shipped as
  correct targeting, not as a result.
- **The lap-aware grace-cycle charge was designed and then cut before implementation.** The
  proposal was to relax `tryBreakFinalApproach`'s `stacked > spare` test to
  `stacked > spare / opponentTurnsRemainingInLap`. It shares the two properties that killed
  round 5's blanket fallback — it widens a branch that runs *before* the holdback, and the
  charges it adds are still charges the victim can afford (91% of charges landing on an armed
  player are payable from loose change). Round 5's version bought nothing and cost variety.
- **Sandbagging the third set** — deliberately holding the winning property back a turn to bank
  and find an OPSEC first — was scoped and deferred, not rejected. It must be off under `instant`
  and `mdFaithful` where delay is pure loss, a held property can be forced out at the hand limit,
  and it needs its own measurement. `tryArmingPlay` is the safe half of it.
- **A chokepoint veto in `decideBotPlay` was tried and abandoned.** It is this file's usual shape
  and it is wrong here: a chokepoint can only CANCEL a play, and recovering the planner's
  next-best option means re-running it over a masked hand, which doubles `rnd()` consumption and
  kills paired-seed comparison from the first escrow onward. Gating at the selection site lets
  `tryOffensiveActions` fall through IG → CHUD → Midnight Requisition by itself, for no roll and
  no re-plan. The policy still lives in one function; only the check is at the call sites.
- **A measurement bug in the research doc, found by rebuilding the tool.** `state.events` is
  capped at `EVENT_LOG_MAX = 400` and spliced off the FRONT (`game.js:526`), so the throwaway
  script that counted OPSEC blocks with an end-of-game `state.events.filter(...)` silently
  dropped every block from a long game's early turns. It understated the block rate by ~1pp and
  the armings-shot-down rate by ~2pp. `tools/botaudit.mjs` counts against a sequence watermark
  and prints both figures with a warning when they disagree.

### The game log IS real play — and the trap that made it look otherwise

Round 12 was asked to learn from real human games in `logs/games.jsonl` (1,746 records). The
first pass got this WRONG in a way worth recording, because the trap is still there for the
next reader.

**The corpus is real.** Filter to `turns >= 10` and you get **120 genuine human games** — the
owner playing their own game across several days, one human seat plus two bots, 3-seat,
`finalApproach`/setsToWin 3, mean 29.8 turns. The other ~1,620 records have <= 1 turn and are
test fixtures (`test/server-hardening.test.js`'s scoop-out, `rules-wire.test.js`'s ALPHA/BRAVO);
exclude them and nothing else needs excluding.

**The trap: 116 of those 120 games share the seed `1337#1`,** which reads exactly like one CI
fixture replayed and was reported as such. It is not. `server/handlers.js:304` builds
`options.seed = \`${seedBase}#${room.gameCount}\`` from `seedFromEnv()`, which refuses
`CHUD_SEED` **only** when `NODE_ENV === 'production'` — a variable Railway does not set by
default. So the determinism hook leaked into the deployment and handed *every real room the
same seed*. The `#1` is `gameCount`, i.e. the first game in each fresh room.

Two consequences, and the second is a live bug:

1. **The seed carries no provenance information in this log.** Do not use it to tell a harness
   run from a real game. The discriminator that does work is wall-clock spacing between
   records: median gap 368s across 111 consecutive games, only 4 of 119 gaps under 30s, 43 over
   ten minutes. A harness loops in seconds; a person plays sessions.
2. **Every production game was dealt the same deck order.** That is a gameplay defect in its own
   right — identical cards in identical sequence, session after session — and it also means any
   frequency measured over this corpus is a frequency over ONE deck, not over the deck's
   distribution. Prefer per-decision-point rates (given they held card X, what did they do)
   over per-game rates when reading anything measured here.

Two other signals were also mistaken for automation and are actually findings about how a good
player plays: the human seat OPSEC'd thefts but never money charges (0 blocks in 451
opportunities holding a shield) — that is correct shield discipline, not a scripted branch; and
it played low-hand-index cards almost always — but `public/src/state/selectors.js` `myHand()`
returns raw server order and the client renders it directly, so tapping left-to-right through
the fan produces that by construction. Neither is evidence of anything except play.

**Nothing in round 12 was tuned on this corpus** — every number in the sections above comes from
`tools/botaudit.mjs` over bot-vs-bot simulation. The human corpus is being analysed separately;
whatever it says about breaker timing is a check on §3.10c, not its source.

**One genuine bot defect came out of the audit that went with it.** A report that bots kept
charging a seat which could not pay did not survive the log — of the 9 insolvencies in the game
concerned, 5 came from multi-target rents and 3 from Roll Call, both of which hit every opponent
BY RULE rather than by choice, leaving one targeted charge. But checking it meant auditing all
five Finance Office call sites, and `tryDefensiveOffense`'s is the only one round 10's
wasted-charge rule never reached: it returns the first threat with no `canPay` test. Unreachable
in the default deck — the rainbow wilds are the only 0M cards and there are two, so nobody can
build two complete sets worth nothing — but `wildAny` is a host knob and `DECK_KIND_MAX` allows
4, at which point brown and intel can both be filled with 0M wilds and a threat is worth exactly
nothing to charge. Fixed, and pinned by a test that builds that legal room.

### Round 12b — what 91 real production games changed, and what they did not

After the round above shipped, the production game log was pulled off the Railway volume: **91
games with >= 10 turns, 21 distinct real players, varied decks** (the `CHUD_SEED` leak described
above is fixed in production — every record has `seed: null`), 55 of them 4-seat, two rulesets
in live use (finalApproach/sets3 x71, mdFaithful/sets3 x24), and **21 games with two or more
humans**. Fifty of them are a perfectly paired 4-seat {human, aggressive, conservative, neutral}
table, which makes seat-for-seat comparison inside the same games possible.

**The headline is that bot-vs-bot balance does not predict human-facing difficulty.**

| seat | win rate, same games | fair share |
|---|---:|---:|
| human | 42% | 25% |
| aggressive | 28.6% | 25% |
| conservative | 16.1% | 25% |
| **neutral** | **10.7%** | 25% |

A single human beats a table of bots at 1.7x fair share in 4-player and 2.1x in 5-player. In
`simbalance` those three planners sit within a few points of one another; against a person they
are 2.7x apart, and **the weakest of them is the lobby default**. Every number in the round
above came from bots playing bots, and this is the limit of that instrument.

**Shipped from it:**

* **§3.10h — neutral's shield economy.** `finance_office → true` and `rent >= 4 → true` burned
  15 of 15 shields on Finance Office and 23 of 23 on charges of 5M+. Real players run a
  gradient — Inspector General 82%, CHUD 47%, Midnight Requisition 30%, rent 15%, Finance
  Office 10%, Roll Call 3%, and only 26% of charges at 5M or above blocked at all. Neutral now
  reserves its LAST shield for the steal and answers money only with a spare. Aggressive's
  branch already carried the right comment; this brings neutral into line without merging them.
  Also `tdy_orders` fell through to `false` for every personality (bots 0/19, humans 17%).
  Cost: none measurable — avg turns and every §3 winrate unmoved when isolated.
* **§3.10c calibration.** The escrow's first cut fired **0%** at the decision points it refused;
  measured at the same points, humans fire an Inspector General **51%** of the time and **49%**
  even at a no-threat table. It was calibrated to conservative (18%) when human play sits nearer
  old neutral (48%). Holding a shield now relaxes the set-count bar for every personality — and
  the escort is the one part of §3.10c that real play reproduces exactly: humans fire 75%
  holding an OPSEC against 44% without, and it works, with escorted human shots blocked 0 times
  in 25 against 8 in 66 unescorted. Cost: none measurable when isolated.

**Measured and REJECTED — the cash floor.** The strongest finding in the corpus is that humans
lose half as much property to payments as neutral does. Per 100 own turns: humans bank 174M and
lose 34.7 property cards; neutral banks 106M and loses 66.1, and 51.2% of its payments cannot be
covered by its bank against the human's 27.6%. Neutral lays the most property of any seat (118
cards per 100 turns) and pays it straight back out — a treadmill — and completes 29.3 sets per
100 turns against the human's 41.2. So: bank up to the largest charge the table can print at you
before laying more property.

It was implemented three ways and priced each time. Substituting a bank play for any property
play cost **+2.2 turns per game and 4.3 points of chud's §3 headroom** (chud 13.1% → 8.8%
against an 8% floor). Restricting it to properties that SCATTER — a colour we own nothing in,
which is the play the measurement actually indicts — recovered none of it. Dropping the dose to
a third still cost +1.6 turns and left chud at 9.9%. Isolation confirmed the cash floor was the
sole cause: with it off, 32.9 turns and chud 13.1%; the other two changes cost nothing.

**It was rejected on a principle worth stating, because the next person will find this
measurement again and want to ship it.** The cost is measurable and the benefit is not.
`simbalance` is a fixed pot among bots, so "stronger against a human" cannot appear in it, and
no instrument in this repo can currently price it. Shipping a measured cost for an unmeasurable
benefit is not a trade this project makes. The way to land it properly is to build the missing
instrument first — a human-facing benchmark, or replay-based evaluation against the production
corpus — and then re-price it. The code is a ~40-line revert away in this file's history.

**Also confirmed, and worth not re-deriving:** the long-game collapse seen in the dev log is not
real (production single-human tables win 53/50/35/50% across the 10-19/20-29/30-39/40-49 turn
bands, above fair share in every one); Final Approach is close to a win at 14.9% of 161 armings
ever broken, rising to 38.5% when an opponent actually holds a breaker; target selection is NOT
what separates the seats (leader-hit rate 72.6% human, 73.4% aggressive, 73.4% neutral, 80.1%
conservative, against ~32% for random); and steal→rent is the one sequencing pass humans run
more than bots (22% against 8-16%), which is precisely §3.10d above, so this corpus is its clean
pre-change baseline.

**The largest unshipped finding is sandbagging.** At a turn start holding a card that completes
a colour they are one short of, humans play it 56% of the time; neutral 96% and aggressive 91%.
Humans complete 93% when it is their final, winning set and 52% otherwise — a deliberate policy,
controlled for: 66% of the declines laid a DIFFERENT colour the same turn, and none of the
declined cards were paid away or banked. A card in hand cannot be stolen, seized, or taken as
payment (`payableCards`, game.js:1128). No bot has any concept of it. It is unshipped because
the outcome effect is unmeasured (7/15 vs 3/6 — N far too small) and it would need the same
missing instrument as the cash floor.

### A note for whoever comes next

The owner's second ask — *charge as much rent as possible to someone in final approach so they
have to give up some of their sets* — is measured in `docs/bot-foresight-research.md` §4 and
**cannot work in the window it names.** An armed player's disposable value is a median of 24M
against a best stacked charge of 2M; only 2.5–3.2% of grace-cycle turns could any charge sequence
exceed the cushion. The leverage is spent between the second set and the third, where the
leader's bank is still 4–9M. §3.10f is the first move in that direction and it is a small one;
the real version needs a charge to reach a player through something other than a wild rent.

---

## Round 13 (2026-08-12) — the instrument, and the first thing it killed

Round 12b ended by rejecting a good idea for an unmeasurable benefit: `simbalance` measures bots
against bots in a fixed pot, so "stronger against a human" cannot appear in it. This round builds
the missing instrument and then uses it.

### §3.12 `humanlike` — a personality whose constants are the measured human

Built from the 91-game production corpus (21 real players), re-derived from the event stream
rather than taken on trust — which immediately corrected the brief it was built from: **the
decision point is the start of the PLAY phase, not `turn_start`.** Measured before the turn's
draws, human Inspector General opportunities are N=47 at 43%; after, N=67 at 51%. Two other
figures moved: "44.9% play properties before money" was the COMPLEMENT (humans do it 52% of the
time, bots 98-99%), and OPSEC-on-IG is 77%, not 82%.

It is deliberately NOT in `BOT_MODES` or the lobby allowlist: it is an instrument, not a product,
and a test pins that. `tools/simhuman.mjs` seats a subject against N-1 of them, seat-rotated and
seeded, with Wilson intervals.

**Fidelity: a good BEHAVIOUR clone and a poor STRENGTH clone, and the second half is the limit.**
IG fire rate 51% vs 52%, escort split 75/43 vs 80/42, completer rate 56% vs 56% exact,
money-in-hand 0.86 vs 0.74, leads-with-money 20% vs 23% against the bots' 4-5%, all-properties-
before-money 52% vs 50% against the bots' 98%. But the human seat WON 42% of those games and
`humanlike` wins ~21-25%.

That gap is not a bug to tune out, and understanding why is the whole point: `sets/100` and
`property-lost/100` are **consequences of winning**, not behaviours. A seat that wins completes
more sets and loses less board by construction. Matching them would mean making the proxy
stronger — which is exactly the tuning an instrument must not have. So:

> **`simhuman` RANKS changes. It does not certify difficulty.** Use it paired
> (`--subject X` against `--subject X@n`, same seed), never as an absolute reading. A real
> person is materially harder than `humanlike`, so its absolute winrates are optimistic.

Baseline against 3 `humanlike` opponents (4000 games, 4 seats, fair share 25%): aggressive
**34.6%** [31.4, 38.0], conservative 29.4%, neutral 29.1%, random 13.5%, chud 10.8%. The ORDERING
matches production — aggressive is the hardest seat for a person and it is not the lobby default
— but production had those three 2.7x apart (28.6 / 16.1 / 10.7) where the proxy has them inside
5pp. That gap is the proxy's strength shortfall, stated rather than hidden.

Three constants are unmeasurable from an event stream and are labelled so in the code:
`BREAK_OVERPAY` (a stream cannot show a declined play), `BAIT_PATIENCE` (nor a trap being set),
`CARD_AWARENESS` (nor someone counting the discard pile). Several others rest on 13-20
observations — the escort split on N=16, the winning-set rate on N=14.

### §3.10j sandbagging — implemented, measured, and left OFF

Holding a set-completing property in hand instead of laying it. `payableCards` is bank +
properties + upgrades, so a card in hand cannot be stolen, seized, or paid away. Measured:
humans lay a completer 56% of the time (93% when it is the winning set, 52% otherwise); neutral
96%, aggressive 91%.

**It fails its own pre-registered bar and stays behind `SANDBAG_ENABLED = false`.** Subject
against 3 `humanlike` opponents, paired seeds, 2000 games per arm:

| neutral weight | delta | 95% CI | turns |
|---|---|---|---|
| 0.20 (shipped) | +0.25pp | [-2.52, +3.02] | +0.05 |
| 0.52 (the human rate) | +0.00pp | [-2.77, +2.77] | +0.13 |
| 0.90 | +0.00pp | [-2.77, +2.77] | +0.08 |

Flat, **not dose-dependent**, inside noise, against a bar of >= +3.0pp with the interval
excluding zero. And the null is stronger than it looks, because the known confound runs in
sandbagging's FAVOUR: every threat heuristic in this file counts `completedSets`, so a
sandbagging bot is invisible to six of them and `humanlike` opponents run those same heuristics.
With that tailwind, still nothing.

Worth recording for whoever revisits it: the first sweep returned byte-identical numbers at all
three doses, which is not a null but a broken harness — `setSandbag` takes `{weights: {...}}` and
a top-level key is silently ignored. Three identical results across three doses should always be
read as an instrumentation failure first. The corrected script asserts the weight took effect
before running.

### The completer discard defect — found, fixed, and live regardless

While checking a reported bug, a real one turned up that is broader than the report: **forced to
choose between properties, EVERY personality discarded the cheapest, and the cheapest is very
often the set-completer** (brown and intel are 2-card sets at 1M). Verified on a discriminating
fixture — eight properties, no money or actions, so every comparator falls through to
`a.value - b.value`:

    brown/1M(completes) green/4M darkblue/4M yellow/3M red/3M green/4M darkblue/4M yellow/3M
    before: humanlike LOST · neutral LOST · conservative LOST · aggressive LOST
    after:  all six personalities keep it

Fixed as a TIER applied outside the `switch` in `chooseDiscards`, so a personality added later
cannot miss it, and live with the sandbag flag OFF — a bot should never throw away the card that
finishes its set, whatever else is true. Instrumented to prove it is not inert: on the pinned
seed it is reached 225 times and reorders 20 but never reaches the discard boundary (which is
why `simbalance` is byte-identical), and across 9,000 games on three other seeds it changes the
discarded card 14 times, every one a completer saved.

### Two bugs found by building the instrument

- **`decideBotPlay` dispatched its planner on `variant`, not `mode`.** `neutral@0` worked only by
  coincidence — `default` IS neutral — so **`aggressive@0` silently played as neutral**, and so
  would every other suffixed seat. That is the exact A/B mechanism the holdback round introduced
  and this round depends on, quietly broken since. No bare name is affected.
- **A test that could not discriminate, twice over.** `it steps aside when laying the property is
  what loads the escrow gun` stayed green with its valve deleted: the fixture satisfied §3.10c's
  escort clause with a shield IN HAND, which trips an earlier valve. Draining the OPSEC pool
  instead trips `tryGuaranteedBreaker`, which fires the IG outright. There is no third way to
  satisfy the escort, so no end-to-end fixture can isolate that valve for an escort-bearing
  personality; it is now asserted at the valve and mutation-proved red. **A test that looks
  end-to-end and proves nothing is worse than a narrower one that bites.**

### Verification

618 tests passing (`--test-concurrency=1`; the suite has pre-existing port contention in
parallel that produces phantom failures). `simbalance --games 900 --seed r12base` byte-identical
to the pre-round tree: 14.2 / 28.2 / 31.7 / 37.9 / 13.1, avg 33.0 turns, stalemates 0.11%.
