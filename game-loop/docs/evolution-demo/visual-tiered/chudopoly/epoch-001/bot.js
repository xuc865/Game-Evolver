// bot.js — Bot AI engine for Chudopoly with 5 personality modes
const G = require('./game');

/* ── Randomness ─────────────────────────────────────────────────────── */
// Injectable so simulate.js can run reproducible matrices; defaults to Math.random.
let RND = Math.random;
function rnd() { return RND(); }
function setRng(fn) { RND = typeof fn === 'function' ? fn : Math.random; }

/* ── Timing ─────────────────────────────────────────────────────────── */

const DELAYS = {
  random:       { draw:[600,1500], play:[600,1800], respond:[400,1200] },
  conservative: { draw:[800,2000], play:[1000,2800], respond:[600,1600] },
  neutral:      { draw:[600,1500], play:[800,2500], respond:[500,1500] },
  aggressive:   { draw:[500,1200], play:[600,2000], respond:[400,1200] },
  chud:         { draw:[300,800],  play:[300,800],  respond:[200,600]  },
  // §3.12 — the measurement instrument, never seated in a lobby (see HUMANLIKE below).
  // Timings are cosmetic for it: it exists to be simulated, not watched.
  humanlike:    { draw:[600,1500], play:[800,2500], respond:[500,1500] },
};

function getDelay(mode, action) {
  const d = DELAYS[mode] || DELAYS.neutral;
  const range = d[action] || d.play;
  return range[0] + rnd() * (range[1] - range[0]);
}

/* ── Scheduling ─────────────────────────────────────────────────────── */

function scheduleBotAction(room, callbacks) {
  if (!room?.state || room.state.phase !== 'playing') return;
  if (room._botTimeout) return; // already scheduled

  const state = room.state;

  // Check if a bot needs to respond to a pending action
  if (state.pendingAction) {
    const botId = findRespondingBot(room, state);
    if (botId) {
      const mode = getBotMode(room, botId);
      room._botTimeout = setTimeout(() => {
        delete room._botTimeout;
        if (!room.state || room.state.phase !== 'playing') return;
        const stillNeeds = findRespondingBot(room, room.state);
        if (stillNeeds === botId) {
          botRespond(room, botId, callbacks);
        } else {
          scheduleBotAction(room, callbacks);
        }
      }, getDelay(mode, 'respond'));
      return;
    }
    return; // pending action waiting for human
  }

  // Check if it's a bot's turn
  const cp = G.currentPlayer(state);
  const botPlayer = room.players.find(p => p.id === cp.id);
  if (!botPlayer?.isBot || cp.eliminated) return;

  const mode = botPlayer.botMode || 'neutral';
  const action = state.turnPhase === 'draw' ? 'draw' : 'play';
  room._botTimeout = setTimeout(() => {
    delete room._botTimeout;
    if (!room.state || room.state.phase !== 'playing') return;
    const currentCp = G.currentPlayer(room.state);
    if (currentCp.id !== cp.id) return;
    const bp = room.players.find(p => p.id === cp.id);
    if (!bp?.isBot) return;
    botTakeTurn(room, cp.id, callbacks);
  }, getDelay(mode, action));
}

function cancelBotTimeout(room) {
  if (room._botTimeout) {
    clearTimeout(room._botTimeout);
    delete room._botTimeout;
  }
}

function getBotMode(room, botId) {
  const p = room.players.find(x => x.id === botId);
  return p?.botMode || 'neutral';
}

/* ── Find which bot needs to respond ────────────────────────────────── */

function findRespondingBot(room, state) {
  if (!state.pendingAction) return null;
  for (const pid of G.pendingResponders(state)) {
    if (room.players.find(p => p.id === pid)?.isBot) return pid;
  }
  return null;
}

/* ── Situational awareness helpers ─────────────────────────────────── */

function threatLevel(opponents) {
  // How close is any opponent to winning? Returns 0-3
  let maxSets = 0;
  for (const opp of opponents) {
    const sets = G.completedSets(opp);
    if (sets > maxSets) maxSets = sets;
  }
  return maxSets;
}

function findThreats(opponents) {
  // Find opponents with 2+ complete sets (1 away from winning)
  return opponents.filter(opp => G.completedSets(opp) >= 2);
}

/* ── §3.10 Final approach: breaking it and defending it ─────────────── */

function findArmed(players, exceptId) {
  return players.filter(p => p.finalApproach && !p.eliminated && p.id !== exceptId);
}

// Cards sitting in a zone that is exactly a complete set — the only cards whose loss
// actually costs the owner a set.
function completeSetCards(player) {
  const out = [];
  for (const [color, cards] of Object.entries(player.properties)) {
    // Must be isSetComplete, not "zone is full": under the pureSetRequired toggle a zone
    // full of nothing but wilds is NOT a set, and Inspector General refuses it. Measured:
    // 7 refused IG plays across 1,440 mdFaithful games before this.
    if (!G.isSetComplete(player, color)) continue;
    for (const card of cards) out.push({ color, card });
  }
  return out;
}

function bankValue(player) {
  return player.bank.reduce((sum, c) => sum + c.value, 0);
}

// What an armed player can hand over WITHOUT losing a set: the bank, properties sitting in
// zones that are not complete sets, and upgrades. Upgrades are payable (§3.1b) and a House
// leaving a set costs its owner rent, not the set — so they are spent before a set property
// (that is exactly the order selectPaymentCards() uses below).
//
// This, not the bank alone, is the number a charge has to beat. A demand the victim can
// settle out of loose change moves money and disarms nobody, and during a grace cycle there
// is no later turn in which that money would have mattered. Measured on the pre-fix bot:
// 51.9% of every charge aimed at an armed player was payable without touching a set.
function disposableValue(player) {
  let total = bankValue(player);
  for (const [color, cards] of Object.entries(player.properties)) {
    if (G.isSetComplete(player, color)) continue;
    for (const c of cards) total += c.value;
  }
  for (const ups of Object.values(player.upgrades || {})) {
    for (const u of ups) if (u && typeof u === 'object') total += u.value || 0;
  }
  return total;
}

// The four cards in a 106-card deck that can actually pull a card out of a complete set.
// Banking one of these while somebody is armed is never a trade worth making.
function isHardBreaker(card) {
  return card && (card.action === 'inspector_general' || card.action === 'chud');
}

// How hard each personality tries to shoot down a final approach — the gate on firing a
// counter that we know will land if it is not OPSEC'd.
// §3.12: humanlike is not asleep at the wheel — production humans fire an Inspector General
// at 56% of the decision points where an opponent is one set from winning, against 49% at a
// quiet table, so they DO lean in on a threat. The urgency roll only decides whether to look;
// HUMAN_BREAKER_FIRE below decides whether to shoot.
const BREAK_URGENCY = { aggressive: 1, chud: 1, neutral: 0.9, conservative: 0.85, random: 0.2, humanlike: 0.9 };

// How far each personality will OVERPAY for the attempt: burning a play on a speculative
// draw to dig for a counter, or on attrition that cannot disarm by itself. This is the axis
// the personalities are allowed to differ on — none of them may ignore an armed player, but
// an aggressive bot will spend its whole turn hunting and a conservative one will not.
// §3.12 humanlike: UNMEASURED. The corpus has no clean read on "did they burn a play digging
// for a counter", because a human's declined play is invisible in an event stream. Set to
// neutral's value so the instrument does not accidentally become the patient one on an axis
// nobody measured; called out as a known soft spot in the fidelity report.
const BREAK_OVERPAY = { aggressive: 0.95, chud: 0.85, neutral: 0.75, conservative: 0.55, random: 0.15, humanlike: 0.75 };

/* ── §3.10c THE BREAKER ESCROW (round 12) ───────────────────────────────────────────────
 *
 * Measured on the pre-change tree (`node tools/botaudit.mjs --games 400`, and written up in
 * docs/bot-foresight-research.md §1.1): of 1,858 hard-breaker plays across 400 four-player
 * games, **39.5% were fired at a table where nobody held 2+ sets and nobody was armed** —
 * aggressive 54.2%, neutral 46.0%, conservative 11.9%. The consequence is §1.2: by the time
 * anybody arms, 2.23 of the deck's 4 breakers are already spent, and **71.6% of armings face
 * a table where not one opponent holds a breaker at all.** `tryBreakFinalApproach` above is
 * well built and, most of the time, holding an empty gun.
 *
 * The cause is one line long: every planner asks whether a shot is LEGAL. Nothing anywhere
 * asked whether it was WORTH THE CARD.
 *
 * The two breakers need DIFFERENT bars, which is the finding that shaped this code. Of the
 * shots that land, Inspector General advances the firer's own set count 98.8% of the time —
 * it is a whole set, by construction — while THE CHUD CARD advances it only 18.0%: 652 of
 * 795 landed CHUDs took a card that completed nothing of ours. So IG's question is only
 * *when*, and CHUD's question is *whether*.
 */

// How close the shot must bring US before "it advances our own win" is reason enough on its
// own. 1 = "to setsToWin - 1 or better" — the owner's bar: it makes sense to steal a set if
// you already have one or two and are heading for a final approach.
//
// Measured before choosing it (docs §1.1a): 64.7% of the wasted shots are fired by a bot
// with NO completed set of its own, and a 0-set bot that gains one set lands at 1, which is
// below setsToWin - 1 — so those are held. At margin 1 the escrow still holds 72.4% of the
// planners' no-threat shots and passes the 27.6% that genuinely build toward a win. It is a
// bar, not a loophole. 0 tightens it to the shot that arms or wins outright, and is the dial
// to turn first if avgTurns rises.
// `let`, not `const`, ONLY so setTuning (the inert evaluation hook at the bottom of this
// file) can override and restore it; the shipped value is unchanged and simbalance is
// byte-identical to the const tree (proof in test/replayeval.test.js and the commit).
let BREAKER_SELF_MARGIN = 1;

// The personality axis is the BAR, not a coin flip — and that is a measured correction, not
// a preference. The escrow was first built with a graded per-decision patience
// (conservative 0.95 / neutral 0.8 / aggressive 0.5) and it barely worked: a bot that holds
// at p=0.8 across ten decision points fires anyway 89% of the time, and the whole mechanism
// moved the no-threat share 39.5% -> 37.5%. Deterministic, the same code moves it to 22.9%.
// A probability that is re-rolled every decision is not patience; it is a delay.
//
// Making it deterministic also costs ZERO new rnd() calls, so no personality's random stream
// gains or loses a draw — which is what keeps paired-seed before/after comparison alive.
//
//   denyAt  — how close an opponent must be to winning before DENIAL alone justifies the
//             card, counted back from setsToWin. 1 = "one set from winning" (the real
//             threat band); 2 = "holds any complete set at all", which is aggressive's
//             looser reading and the reason it still reads as the reckless one.
//   escort  — require an OPSEC in hand (or a dead OPSEC pool) before a shot may be spent on
//             ADVANCING OUR OWN WIN. See the escort clause in worthwhileBreakerShot.
//
// null = no bar at all. chud and random keep it: reckless is their whole character, they
// fire 318 of the 734 wasted shots, and disciplining them would collapse five personalities
// into one. Their behaviour here is byte-identical to the pre-change tree.
const BREAKER_BAR = {
  conservative: { denyAt: 1, escort: true },
  neutral:      { denyAt: 1, escort: true },
  aggressive:   { denyAt: 1, escort: false },
  chud:         null,
  random:       null,
  // §3.12 — the instrument carries a bar so that everything gated on `BREAKER_BAR[mode]`
  // being non-null stays ON for it (arm-turn preparation, the arming breaker, the bank veto,
  // the ordered discard). But its bar is only used for RETARGETING: `escort: false` keeps
  // worthwhileBreakerShot from vetoing on the shield, because for a real player the shield is
  // not a veto — it is a 75%-vs-44% swing in a probability. That swing lives in
  // HUMAN_BREAKER_FIRE, which is where the measurement actually points.
  humanlike:    { denyAt: 1, escort: false },
};

/* ── §3.12 HOW OFTEN A REAL PLAYER PULLS THE TRIGGER ────────────────────────────────────
 *
 * Re-derived from `scratchpad/prod/games-prod.jsonl` (91 production games, 21 distinct
 * players), at the same decision point this file's planners face: the play phase begins,
 * the card is in hand, a legal target exists on the table. "Did they use it this turn?"
 *
 *   Inspector General   51% overall (N=67)   — 49% quiet table (43),  75% holding an OPSEC
 *                                              (16) against 43% without (51)
 *   THE CHUD CARD       34% overall (N=93)   — 30% quiet table (63),  45% with a live threat
 *
 * Round 12 removed a graded patience roll from the escrow and was right to: "a probability
 * re-rolled every decision is not patience; it is a delay", and a bot holding at p=0.8 across
 * ten decision points fires anyway 89% of the time. That argument is about a PLAY-level roll.
 * It is defused here by rolling once per TURN per card (humanTurnRoll), which is the unit the
 * corpus measures — a human who decides not to fire this turn does not reconsider on play 2.
 */
const HUMAN_BREAKER_FIRE = {
  // The escort is the clause round 12 got from the owner's sentence and the corpus reproduces
  // almost exactly. It is not decoration: escorted human shots were blocked 0 times in 25,
  // unescorted 8 times in 66.
  inspector_general: { escorted: 0.75, bare: 0.43 },
  // The CHUD is the card real players sit on. They fire it at 30% against a quiet table —
  // less than a third as often as aggressive (84%) and four times as often as conservative (8%).
  chud:              { threat: 0.45, quiet: 0.30 },
};

/* One decision per TURN per card, not one per play.
 *
 * The memo hangs off `state` beside `_surgeOps` and is keyed on `turnCounter`, so it clears
 * itself the moment the turn changes and never has to be swept. It is consulted ONLY from
 * humanlike branches, so no other personality gains or loses an rnd() draw and every seeded
 * paired-seed comparison in this repo stays valid. */
function humanTurnRoll(state, bot, key, p) {
  let memo = state._hlRolls;
  if (!memo || memo.turn !== (state.turnCounter || 0)) {
    memo = state._hlRolls = { turn: state.turnCounter || 0, v: {} };
  }
  const k = bot.id + ':' + key;
  if (!(k in memo.v)) memo.v[k] = rnd() < p;
  return memo.v[k];
}

// Does this shot earn its card? Returns the best worth-it PLAY for the card at `cardIndex` —
// which may aim somewhere other than the planner chose — or null when nothing on the table
// earns it. Reads the discard pile, every table and our own hand; never an opponent's hand
// and never the deck (round 11's honest-information rule).
//
// Two cases it fixes for free, by retargeting rather than by vetoing:
//   * aggressive has no threat branch at all — `findBestIGTarget` picks the fattest set on
//     the table, so a 12M green held by a 1-set player outranks the 2M brown of the player
//     one set from winning. This moves the shot onto the threat.
//   * `tryDefensiveOffense`'s CHUD branch picks the threat's highest-value card REGARDLESS of
//     whether it sits in a complete set — a shot that disarms nobody. This moves it into one.
function worthwhileBreakerShot(state, bot, botId, cardIndex, mode) {
  const card = bot.hand[cardIndex];
  if (!isHardBreaker(card)) return null;
  const bar = BREAKER_BAR[mode];
  if (!bar) return null;                       // chud/random have no bar; nothing to retarget
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const win = G.setsToWinOf(state);
  const mine = G.completedSets(bot);
  // Either breaker is worth exactly one set to us when it lands somewhere we can use — but
  // ONLY when we can defend the shot. The owner's rule, in full: "it makes sense to steal a
  // set if you have 1-2 already and are going for final approach WHILE HOLDING OPSEC", and
  // the strategy field says the same ("wait to play the Deal Breaker until you have a Just
  // Say No for reinforcement"). The escort clause is not decoration: without it, an IG
  // almost always gains its firer a set, so the self-rule passes for any bot with one set —
  // which is most of the mid-game — and the escrow measured a 39.5% -> 30.6% move in the
  // no-threat share while leaving breakers-in-hand-at-arming at 19.5% -> 19.7%, i.e. it
  // changed WHERE the shots went without changing that the gun was empty when it mattered.
  //
  // A dead OPSEC pool counts as protection too: nothing can answer the shot either way.
  const holdsShield = bot.hand.some(c => c.action === 'opsec')
    || unseenCounts(state, bot).opsec === 0;
  const escorted = !bar.escort || holdsShield;
  // §3.10c calibration, round 12 addendum. Measured against real players at the SAME decision
  // points (a turn start holding the card with a legal target): humans fire an Inspector
  // General 51% of the time, and 49% even at a table where nobody is close to winning. The
  // first cut of this bar fired 0% at the points it refuses — it was calibrated to
  // conservative (18% at a no-threat table) when human play sits nearer old neutral (48%).
  //
  // The escort is the part humans reproduce almost exactly, so it is what the loosening hangs
  // on: they fire 75% of the time holding an OPSEC against 44% without, and it WORKS —
  // escorted human shots were blocked 0 times in 25, unescorted 8 times in 66. So an escorted
  // shot that gains us a set always clears, at any set count; the margin still governs the
  // unescorted case, which is the reckless one this whole mechanism was built to stop.
  // Holding the shield is what relaxes the set-count bar — for every personality, because
  // that is the axis real players actually condition on. Without a shield the margin governs,
  // which is the reckless unescorted shot this mechanism was built to stop.
  const selfWorth = escorted && (holdsShield || (mine + 1) >= win - BREAKER_SELF_MARGIN);

  if (card.action === 'inspector_general') {
    let best = null;
    for (const opp of opponents) {
      const denies = G.completedSets(opp) >= win - bar.denyAt;
      for (const [color, cards] of Object.entries(opp.properties)) {
        if (!G.isSetComplete(opp, color)) continue;
        // A set seized into a colour we have ALREADY completed overflows to other zones or
        // to the bank (game.js receiveProperty, §3.5 zone cap) — that shot moves cash and
        // spends the only breaker in play. No planner has ever checked this.
        const gains = !G.isSetComplete(bot, color);
        if (!denies && !(gains && selfWorth)) continue;
        const score = (gains && selfWorth ? 2 : 0) + (denies ? 1 : 0);
        const value = cards.reduce((sum, c) => sum + c.value, 0);
        if (!best || score > best.score || (score === best.score && value > best.value)) {
          best = { score, value, play: { type:'play_action', cardIndex, targetId:opp.id, targetColor:color } };
        }
      }
    }
    return best ? best.play : null;
  }

  // THE CHUD CARD takes one card, so its worth-it cases are narrower than IG's: the card
  // that finishes one of our zones, or a card out of a complete set held by a real threat.
  //
  // A completing CHUD clears the bar UNCONDITIONALLY — no margin, no escort — and the
  // asymmetry with IG below is deliberate rather than an oversight. The two opportunities
  // decay differently. An IG target is a set that is ALREADY COMPLETE on an opponent's
  // board: it is stable, it will still be there next turn, and the shot loses nothing by
  // waiting. A CHUD completion is use-it-or-lose-it — the one card that finishes our zone
  // can be paid away, rearranged into another colour, stolen by a third player, or our zone
  // can fill from hand — so a held CHUD completion is frequently a completion that never
  // happens. It also converts the card into a SET, which is the win condition, so it is
  // never the wasted shot this whole mechanism exists to prevent. Round 11 pinned this
  // behaviour in bot-cardcount.test.js and it is right to have pinned it.
  // A completing CHUD is gated by the MARGIN but not by the escort: finishing an ordinary
  // set does not make us the table's target the way arming does, so it needs no shield.
  //
  // Below the margin the card is held, and that is not a loss of tempo — MIDNIGHT
  // REQUISITION is the card for this job and it is deliberately not escrowed. It steals a
  // single property out of any zone that is not a complete set, which is precisely the
  // "finish my own colour" move, and there are three of them in the deck to CHUD's two.
  // Leaving completions to MR and reserving CHUD for complete sets is the division of labour
  // the deck was built for. Measured: letting CHUD take every completion it saw put neutral's
  // no-threat share back from 9.2% to 24.9% and cost 3.6 points of armings shot down.
  const completionWorth = (mine + 1) >= win - BREAKER_SELF_MARGIN;
  const completing = completionWorth ? findChudCompletionTarget(bot, opponents) : null;
  const completionWins = completing && (mine + 1) >= win;

  // Denial of a real threat outranks our own set-building — with one exception: a completion
  // that takes us to setsToWin ends the game, and nothing outranks that.
  if (!completionWins) {
    let best = null;
    for (const opp of opponents) {
      if (G.completedSets(opp) < win - bar.denyAt) continue;
      for (const { card: c } of completeSetCards(opp)) {
        if (!best || c.value > best.value) best = { playerId: opp.id, cardId: c.id, value: c.value };
      }
    }
    if (best) return { type:'play_action', cardIndex, targetId:best.playerId, targetCardId:best.cardId };
  }
  return completing
    ? { type:'play_action', cardIndex, targetId:completing.playerId, targetCardId:completing.cardId }
    : null;
}

// Why the card cannot rot in hand. Returns a reason or null.
function breakerEscrowRelease(state, bot, mode, cardIndex) {
  // §3.11 adjudicates on points after DECK_CYCLE_LIMIT reshuffles, and shuffleCount is
  // public (every shuffle is a table event). decideBotPlay already uses this exact window
  // for its holdback clock. Inside it there is no "later" to save the card for.
  if ((state.shuffleCount || 0) >= G.DECK_CYCLE_LIMIT - 4) return 'clock';
  // About to be discarded anyway, so spend it. Asked of chooseDiscards itself rather than
  // guessed, so this can never disagree with the comparator. Skipped for the two shuffle-
  // based modes: their comparator IS a shuffle and calling it would consume rnd().
  if (bot.hand.length > G.HAND_LIMIT && mode !== 'chud' && mode !== 'random') {
    if (chooseDiscards(bot, bot.hand.length - G.HAND_LIMIT, mode).includes(bot.hand[cardIndex].id)) {
      return 'handlimit';
    }
  }
  return null;
}

// Deterministic: a personality that has a bar holds every shot that fails it, unless a valve
// releases the card. No rnd() — see the note on BREAKER_BAR for why the roll was removed.
function escrowHoldsBreaker(state, bot, mode, cardIndex) {
  if (!BREAKER_BAR[mode]) return false;                             // chud/random: never
  return !breakerEscrowRelease(state, bot, mode, cardIndex);
}

// The one call every planner makes instead of reaching for a breaker directly.
//
// A note on shape, because it departs from this file's usual habit. The bank veto in
// decideBotPlay is a single chokepoint precisely so five personalities cannot drift apart,
// and the obvious move was to put the escrow there too. It does not work: a chokepoint can
// only CANCEL a play, and cancelling leaves the planner with nothing — recovering its
// next-best option means re-running it over a masked hand, which doubles the planner's rnd()
// consumption and kills paired-seed comparison from the first escrow onward. Gating at the
// selection site lets `tryOffensiveActions` fall through IG -> CHUD -> Midnight Requisition
// -> Finance Office by itself, for one roll and no re-plan. The POLICY still lives in one
// place; only the check is at the call sites.
//
// `legacy` is the site's own pre-escrow targeting, kept so that a failed patience roll fires
// the shot the personality would have fired before — patience is a roll, not a rule.
/* ── §3.10e BAIT THE SHIELD (round 12) ──────────────────────────────────────────────────
 *
 * Measured: 16.4% of every hard breaker fired is eaten by an OPSEC. The competitive Monopoly
 * Deal field treats drawing out the Just Say No as the core skill of the Deal Breaker — play
 * a cheap steal first, let it soak the shield, then fire the real card into an empty hand —
 * and no bot in this file has ever tried it, though it routinely holds the cards to do it.
 *
 * The belief is EXACT and built only from public facts (round 11's honest-information rule):
 * how many OPSEC are unseen, how big the unseen pool is, and how many cards the victim holds.
 * Hand SIZE is public; hand CONTENTS are not, and nothing here reads them.
 */

// P(the victim holds at least one OPSEC), hypergeometric: K shields hidden in an unseen pool
// of U cards, H of which are in the victim's hand. Sharpens as the deck drains, which is
// exactly when breakers are actually being fired.
function opsecOdds(state, bot, botId, victim) {
  const K = unseenCounts(state, bot).opsec;
  if (K <= 0) return 0;
  let U = (state.deck || []).length;
  for (const p of state.players) if (p.id !== botId) U += p.hand.length;
  const H = victim.hand.length;
  if (U <= 0 || H <= 0) return 0;
  if (H >= U) return 1;
  let miss = 1;                                  // P(no shield in those H cards)
  for (let i = 0; i < K; i++) {
    if (U - i <= 0) break;
    miss *= (U - H - i) / (U - i);
    if (miss <= 0) return 1;
  }
  return 1 - miss;
}

// Below this the bait is not worth a play. The arithmetic above is exact; the threshold is
// judgement, and it was swept.
//
// MEASURED, AND THE HONEST RESULT IS NULL. Over 400 four-player games the bait fires 17
// times at 0.25, 53 at 0.12 and 82 at 0.05 — and the share of breakers eaten by an OPSEC
// does not move at any of them (17.3% at both 0.12 and 0.05; paired-seed at 1200 games over
// three seeds it is 18.8/17.2/18.8 before and 19.1/17.6/18.8 after). The first sweep showed
// why 0.25 was a bad constant — the modal belief is ~0.23, so the floor sat exactly on top of
// the distribution and rejected 284 of 358 candidates — but fixing that only exposed the real
// cap, which is CARD AVAILABILITY, not belief: only 93 of 410 candidate moments had a cheap
// targeted action in hand at the same time as a breaker, with two plays left, against a live
// victim. That conjunction is simply rare in this deck.
//
// Kept anyway, at the swept value, and the reasoning is deliberate rather than sentimental:
// it costs nothing measurable (balance and turn length unmoved), it is never the wrong play
// when it does fire, and at ~1 in 7 games it is the single most LEGIBLE thing in this round —
// a human who gets poked with a Midnight Requisition, spends their OPSEC, and then loses the
// set to the Inspector General behind it has been outplayed in a way no win-rate delta
// communicates. If a future round wants it to matter in the aggregate rather than in the
// moment, the lever is availability (add TDY Orders as a third bait card, or let
// tryBreakFinalApproach bait too), NOT this number.
const BAIT_BELIEF_FLOOR = 0.12;
// Who has the temperament to spend a play setting a trap. Aggressive does not — it leads with
// the biggest card it holds, which is its whole character — and the chaotic two never do.
// A zero short-circuits the roll, so three of the five keep their exact RNG streams.
// §3.12 humanlike: 0, and that is a NULL RESULT rather than a design choice. An event stream
// records the cards a player played, never the trap they were setting, so "did this human
// lead with a cheap steal to draw the shield" is not answerable from this corpus. A zero
// short-circuits the roll, so the instrument's stream is unaffected by a mechanism nobody
// could price. Called out in the fidelity report as unmodelled.
const BAIT_PATIENCE = { conservative: 0.9, neutral: 0.65, aggressive: 0, chud: 0, random: 0, humanlike: 0 };

// The cheap card that goes first. Returns a play or null.
function maybeBaitFirst(state, bot, botId, mode, plan) {
  const weight = BAIT_PATIENCE[mode] ?? 0;
  if (weight <= 0) return null;                          // no roll for the reckless three
  if (state.playsRemaining < 2) return null;             // no play left to fire the real card
  const victim = G.getPlayer(state, plan.targetId);
  if (!victim || victim.eliminated) return null;
  if (opsecOdds(state, bot, botId, victim) < BAIT_BELIEF_FLOOR) return null;

  for (let i = 0; i < bot.hand.length; i++) {
    const c = bot.hand[i];
    // Midnight Requisition — barred from complete sets, so it can never take the set an
    // Inspector General is aimed at. Skip the exact card a CHUD is aimed at.
    if (c.action === 'midnight_requisition') {
      for (const [col, cards] of Object.entries(victim.properties)) {
        if (!G.zoneRequisitionable(victim, col)) continue;
        const pick = cards.find(x => x.id !== plan.targetCardId);
        if (pick) return { type:'play_action', cardIndex:i, targetId:victim.id, targetCardId:pick.id };
      }
    }
    // Finance Office — only when they can pay it out of loose change. A demand that forces a
    // set out is not a bait, it is the attack, and it belongs to the planner.
    if (c.action === 'finance_office' && disposableValue(victim) >= 5) {
      return { type:'play_action', cardIndex:i, targetId:victim.id };
    }
  }
  return null;
}

// §3.12 — the measured per-turn trigger rate, asked at EVERY site that can put a breaker on
// the table. It has to be every site: `tryBreakFinalApproach` fires an Inspector General at an
// armed player unconditionally and `tryGuaranteedBreaker` fires one whenever the OPSEC pool is
// dead, both of them BEFORE the planner is consulted, so gating only `planBreakerShot` left
// the instrument firing a CHUD at 69% of threat decision points against the human's 45%. A
// proxy that shoots when a person would hold is exactly the proxy that licenses a bad change.
function humanFiresBreaker(state, bot, botId, cardIndex) {
  const card = bot.hand[cardIndex];
  if (!isHardBreaker(card)) return true;
  // About to be discarded, or the deck-cycle clock has run out: no later to save it for.
  if (breakerEscrowRelease(state, bot, 'humanlike', cardIndex)) return true;
  let p;
  if (card.action === 'inspector_general') {
    const f = HUMAN_BREAKER_FIRE.inspector_general;
    p = bot.hand.some(c => c.action === 'opsec') ? f.escorted : f.bare;
  } else {
    const win = G.setsToWinOf(state);
    const live = state.players.some(o => o.id !== botId && !o.eliminated
      && (o.finalApproach || G.completedSets(o) >= win - 1));
    const f = HUMAN_BREAKER_FIRE.chud;
    p = live ? f.threat : f.quiet;
  }
  return humanTurnRoll(state, bot, 'fire:' + card.action, p);
}

function planBreakerShot(state, bot, botId, mode, cardIndex, legacy) {
  const worth = worthwhileBreakerShot(state, bot, botId, cardIndex, mode);
  // §3.12 — the instrument does not use a bar at all; it uses the measured rate. It still
  // takes the escrow's RETARGETING when the escrow found a worth-it aim, because that is a
  // better shot than the planner's legacy pick and a real player picks the better shot too
  // (leader-hit rate 72.6% human against 73-80% for the planners — targeting is NOT where
  // humans differ). What differs is how often they shoot at all.
  if (mode === 'humanlike') {
    const shot = worth || legacy();
    if (!shot) return null;
    return humanFiresBreaker(state, bot, botId, cardIndex) ? shot : null;
  }
  if (worth) return worth;
  if (escrowHoldsBreaker(state, bot, mode, cardIndex)) return null;  // hold; fall through
  return legacy();
}

// Would this shot actually raise OUR completed-set count? Read off the same rules the engine
// applies when the card lands, not guessed: a set seized into a colour we have already
// completed overflows (game.js receiveProperty), and a stolen single only completes a zone
// we are exactly one card short in.
function shotGainsUsASet(state, bot, botId, shot) {
  if (!shot || shot.type !== 'play_action') return false;
  if (shot.targetColor) return !G.isSetComplete(bot, shot.targetColor);
  const target = G.getPlayer(state, shot.targetId);
  if (!target || !shot.targetCardId) return false;
  for (const [color, cards] of Object.entries(target.properties)) {
    if (!cards.some(c => c.id === shot.targetCardId)) continue;
    const info = G.COLORS[color];
    return !!info && (bot.properties[color] || []).length === info.size - 1;
  }
  return false;
}

// §3.10g ARM-TURN PREPARATION (round 12). The play in hand that completes our WINNING set
// outranks everything the personality plan would rather do with the turn.
//
// Measured: bots arm on a mean turn of 30.8 in a ~33-turn game, so the grace cycle IS the
// endgame — and they walk into it unprepared. Aggressive would fire a CHUD with the winning
// property sitting in hand; conservative and neutral would spend the turn on a Finance
// Office. Completing the set FIRST is strictly better under every win rule: it starts the
// checkpoint clock a turn earlier under finalApproach, wins outright under mdFaithful and
// instant, and — the part that matters most — leaves the rest of the turn to tryDefendFinal-
// Approach, which banks cash and refuses to bank the OPSEC. Arming with two plays still in
// hand is how a bot arrives at its grace cycle with a cushion instead of a bare board.
//
// NOT sandbagging. Deliberately holding the winning set back a turn to prepare was considered
// and deferred: it must be off under `instant` and `mdFaithful` where delay is pure loss, a
// held property can be forced out at the hand limit, and it needs its own measurement.
function tryArmingPlay(state, bot, mode) {
  if (!BREAKER_BAR[mode]) return null;                 // planners only; chaos stays chaotic
  // Already armed: a fourth set wins nothing and tryDefendFinalApproach above owns the rest
  // of this turn. Without this the promotion would outrank banking on the one turn where
  // cash is the difference between surviving the lap and paying out of a set.
  if (bot.finalApproach) return null;
  if (G.completedSets(bot) + 1 < G.setsToWinOf(state)) return null;
  const play = findCompletingPlay(bot, bot.hand);
  // §3.12 — even the winning set is not automatic for a real player: 13 of 14 production
  // decision points took it (93%), one did not. The same memo key is read by
  // humanPropertyPlay below, so a turn that declines here cannot quietly complete the same
  // set two plays later — one decision, one turn.
  if (play && mode === 'humanlike'
      && !humanTurnRoll(state, bot, HUMAN_COMPLETE_KEY, HUMAN_COMPLETE_WINNING)) return null;
  return play;
}

// §3.10c, the owner's case as a PROMOTION rather than a gate.
//
// The escrow can only ever say no to a shot the planner already proposed — and the planners
// bury breakers. Conservative reaches its offensive branch at step 8, BEHIND building, so an
// Inspector General that would hand it the winning set lost every turn to a 1M property play.
// Neutral is at step 6, behind property, PCS Orders and rent. Nothing in this file has ever
// asked "does a card in my hand win the game right now".
//
// Deliberately narrow: only the shot that takes us to setsToWin, only through the escrow's
// own worth-it test (so it inherits the escort clause — this is the owner's "going for final
// approach while holding opsec" in full), and no rnd(), so no personality's stream moves.
function tryArmingBreaker(state, bot, botId, mode) {
  if (!BREAKER_BAR[mode]) return null;
  if (bot.finalApproach) return null;                  // see tryArmingPlay
  if (G.completedSets(bot) + 1 < G.setsToWinOf(state)) return null;
  for (let i = 0; i < bot.hand.length; i++) {
    if (!isHardBreaker(bot.hand[i])) continue;
    const shot = worthwhileBreakerShot(state, bot, botId, i, mode);
    if (!shot || !shotGainsUsASet(state, bot, botId, shot)) continue;
    // §3.12 — the arming promotion was the last unguarded door onto the table: measured, 26
    // Inspector Generals and 22 CHUDs per 200 games came through it without ever asking the
    // trigger, and that alone put the instrument 4pp over the human IG rate and 11pp over the
    // CHUD rate. It is gated on the ORDINARY trigger, not on HUMAN_COMPLETE_WINNING: the 93%
    // figure was measured on a PROPERTY that completes the winning colour, and the breaker
    // rates were measured separately over every decision point INCLUDING the winning ones, so
    // giving a winning breaker its own higher band would double-count the same turns.
    if (mode === 'humanlike' && !humanFiresBreaker(state, bot, botId, i)) return null;
    return shot;
  }
  return null;
}

// The absolute turn number at which a player converts. checkpointForecast() is the engine's
// own forecast, so this cannot drift from resolveFinalApproach() the way a reimplementation
// would. Use `.turn`, NOT `.opponents`: two players armed on the same tick have the same
// number of opponent turns left but still convert in seat order, and `.opponents` reports
// them as tied while `.turn` orders them correctly.
function checkpointTurn(state, player) {
  const f = G.checkpointForecast(state, player);
  return f ? f.turn : null;
}

// Which armed opponent do we shoot at? Not the one with the most sets — the one whose
// checkpoint arrives FIRST, because that is the one who actually wins. Sets break the tie
// only in the degenerate case where the engine cannot forecast either.
function pickArmedVictim(state, armed) {
  return armed.reduce((best, p) => {
    const a = checkpointTurn(state, p);
    const b = checkpointTurn(state, best);
    if (a == null) return best;
    if (b == null) return p;
    if (a !== b) return a < b ? p : best;
    return G.completedSets(p) > G.completedSets(best) ? p : best;
  });
}

function tryBreakFinalApproach(state, bot, botId, hand, armed, mode) {
  // If we are armed too, the only question is who converts first. When our own checkpoint
  // arrives before theirs we have already won the race and spending our counter on them is
  // pure loss — hold it and defend. When theirs arrives first, they win before we do and the
  // counter has to be spent now, armed or not.
  if (bot.finalApproach) {
    const mine = checkpointTurn(state, bot);
    if (mine != null) {
      armed = armed.filter(p => {
        const theirs = checkpointTurn(state, p);
        return theirs == null || theirs < mine;
      });
    }
  }
  if (armed.length === 0) return null;

  const victim = pickArmedVictim(state, armed);
  const theirSets = completeSetCards(victim);
  if (theirSets.length === 0) return null;
  const overpay = BREAK_OVERPAY[mode] ?? 0.75;

  // 1. Inspector General — takes the WHOLE set, permanently, and it lands on our board, so
  //    it swings two sets at once. Strictly the best counter whenever it is in hand.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'inspector_general') continue;
    if (mode === 'humanlike' && !humanFiresBreaker(state, bot, botId, i)) break;   // §3.12
    const color = theirSets[0].color;
    return { type:'play_action', cardIndex:i, targetId:victim.id, targetColor:color };
  }

  // 2. THE CHUD CARD — the only card in the deck that reaches into a complete set for a
  //    single property. Permanent, and one card is all it takes to disarm.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'chud') continue;
    if (mode === 'humanlike' && !humanFiresBreaker(state, bot, botId, i)) break;   // §3.12
    const best = theirSets.reduce((a, b) => (b.card.value > a.card.value ? b : a));
    return { type:'play_action', cardIndex:i, targetId:victim.id, targetCardId:best.card.id };
  }

  // 3. TDY Orders is NOT a break tool. §3.1 was reversed on 2026-08-06: Hasbro FAQ 926 bars
  //    Forced Deal from complete sets on BOTH sides of the swap, and game.js enforces it
  //    (playAction case 'tdy_orders'). Proposing one here would burn a play on a move the
  //    engine refuses. Midnight Requisition is barred the same way and appears far below,
  //    as attrition only — `zoneRequisitionable` confines it to zones that are NOT complete
  //    sets, so it can never reduce anybody's completedSets() count.

  // 4. Charge them past what they can pay from loose change, and a set card has to come out.
  //    §3.1c: Surge Ops doubles RENT ONLY — never Finance Office, never Roll Call — so it is
  //    only ever worth a play ahead of a rent, and only when doubling is what pushes the
  //    charge over the line. (The old code surged before Finance Office and threw the play
  //    away, at the one moment in the game when plays are worth the most.)
  const spare = disposableValue(victim);
  const surges = state._surgeOps || 0;
  const rentMult = 2 ** surges;
  const financeIdx = hand.findIndex(c => c.action === 'finance_office');
  const rollCallIdx = hand.findIndex(c => c.action === 'roll_call');
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');

  let bestRent = null;
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (card.type !== 'rent') continue;
    const color = chooseBestRentColor(bot, card);
    if (!color) continue;
    const base = G.calcRent(bot, color);
    if (bestRent === null || base > bestRent.base) bestRent = { i, color, base, card };
  }

  // The charges still firable this turn, biggest first. Round 5 asked of each one alone
  // "does this beat `disposableValue`", which threw away every hand that could only get
  // there by stacking two — a 4M rent and a 5M Finance Office cannot disarm a victim
  // holding 6M of loose change one at a time, and comfortably can together. The bar is the
  // SEQUENCE, and after the first charge lands `disposableValue` has already fallen, so this
  // branch re-runs next play and the second charge is usually clearing the bar on its own by
  // then.
  //
  // This is NOT the attrition fallback measured and removed in round 5. That one fired
  // charges the victim could pay in full, which cannot disarm anybody by definition; this
  // fires only when the charges that FIT IN THIS TURN add up to more than the victim can
  // cover without breaking a set.
  const charges = [];
  if (bestRent) charges.push({ amount: bestRent.base * rentMult, kind: 'rent' });
  if (financeIdx >= 0) charges.push({ amount: 5, kind: 'finance' });
  if (rollCallIdx >= 0) charges.push({ amount: 2, kind: 'roll' });
  charges.sort((a, b) => b.amount - a.amount);
  const firable = charges.slice(0, Math.max(0, state.playsRemaining));
  const stacked = firable.reduce((sum, c) => sum + c.amount, 0);

  // Surge first only when doubling the rent is what carries the sequence over the bar, and
  // only if a play remains to fire the rent with. §3.1c — rent only; surging ahead of a
  // Finance Office spends a play on a multiplier the engine never applies.
  if (bestRent && surgeIdx >= 0 && state.playsRemaining >= 2
    && stacked <= spare && stacked + bestRent.base * rentMult > spare) {
    return { type:'play_action', cardIndex:surgeIdx };
  }
  if (stacked > spare && firable.length > 0) {
    const first = firable[0];
    if (first.kind === 'rent') {
      if (bestRent.card.colors[0] === 'any') {
        return { type:'play_action', cardIndex:bestRent.i, targetColor:bestRent.color, targetId:victim.id };
      }
      return { type:'play_action', cardIndex:bestRent.i, targetColor:bestRent.color };
    }
    if (first.kind === 'finance') return { type:'play_action', cardIndex:financeIdx, targetId:victim.id };
    // Roll Call is only 2M and it hits the whole table, but 2M is all it takes against a
    // player who has already spent down to nothing.
    return { type:'play_action', cardIndex:rollCallIdx };
  }

  // 5. Nothing in hand can disarm them. There is no next turn to draw into — so a
  //    speculative dig beats every ordinary play we could make instead. PCS Orders is the
  //    only card that turns an empty hand into a chance, and both drawn cards are live
  //    immediately because this branch runs again on the next play.
  if (rnd() < overpay) {
    for (let i = 0; i < hand.length; i++) {
      if (hand[i].action !== 'pcs_orders') continue;
      if (state.playsRemaining < 2) break;   // no play left to fire what we draw
      return { type:'play_action', cardIndex:i };
    }
  }

  // 6. Denial, and only denial. Midnight Requisition cannot touch a complete set (§3.1), so
  //    it never disarms by itself — but it takes a card off the victim permanently, and the
  //    zone it comes out of is the one they would rebuild from if we do break a set later in
  //    the cycle. Only the personalities willing to overpay spend a play on it.
  //
  //    Deliberately NOT here: a blanket "charge them anyway" fallback. A demand they can
  //    afford cannot disarm anybody, the personality planner below already makes exactly
  //    that play when it is the right one, and forcing it through this branch would override
  //    the holdback that stops bots attacking on every single play. Measured over 1,500
  //    games per table size: including it moved conversion by 0.4–1.5 points (inside run
  //    noise) while pushing 5-player games decided on points from 8.3% to 8.9%. It bought
  //    nothing and cost variety.
  if (rnd() >= overpay) return null;
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'midnight_requisition') continue;
    for (const [color, cards] of Object.entries(victim.properties)) {
      if (!G.zoneRequisitionable(victim, color) || cards.length === 0) continue;
      return { type:'play_action', cardIndex:i, targetId:victim.id, targetCardId:cards[0].id };
    }
  }
  return null;
}

// Even the gremlin should not waste the only card that reaches into a complete set on a
// player with nothing to lose. Armed first, then whoever is closest to arming.
function biggestThreat(opponents) {
  const armed = opponents.filter(o => o.finalApproach);
  if (armed.length > 0) return armed[0];
  const ranked = opponents.filter(o => G.completedSets(o) >= 2);
  if (ranked.length === 0) return null;
  return ranked.reduce((a, b) => (G.completedSets(b) > G.completedSets(a) ? b : a));
}

function chudTargetOn(player) {
  const sets = completeSetCards(player);
  if (sets.length > 0) return { playerId: player.id, cardId: sets[0].card.id };
  for (const cards of Object.values(player.properties)) {
    if (cards.length > 0) return { playerId: player.id, cardId: cards[0].id };
  }
  return null;
}

// Armed bots stop building (they cannot win by having more sets) and start hoarding cash
// so an incoming charge does not have to be paid out of a completed set.
// §3.12 humanlike: real players do NOT spend the grace cycle hoarding. Measured on the arming
// turn itself: humans bank on 21% of them and charge rent on 42%; neutral banks on 80% and
// charges on 27%. A human uses the turn that arms them to apply pressure, so the bias is set
// low and the rest of the turn falls through to the ordinary ladder, which charges.
const ARMED_BANK_BIAS = { conservative: 0.9, neutral: 0.85, aggressive: 0.7, chud: 0.4, random: 0.2, humanlike: 0.25 };

function tryDefendFinalApproach(bot, hand, mode, othersArmed) {
  if (rnd() > (ARMED_BANK_BIAS[mode] ?? 0.8)) return null;
  let best = -1, bestIdx = -1;
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (card.type === 'property' || card.type === 'wild_property') continue;
    if (card.action === 'opsec') continue;              // the shield is worth more than the cash
    // Inspector General is the highest-value card in the deck (5M), so "bank the biggest
    // thing" used to reach for it first and quietly bury the best counter in the game under
    // a pile of cash. While anyone else is armed it is a weapon, not currency.
    if (othersArmed && isHardBreaker(card)) continue;
    if (card.value > best) { best = card.value; bestIdx = i; }
  }
  return bestIdx >= 0 ? { type:'play_money', cardIndex:bestIdx } : null;
}

/* ── Card counting (round 11, angle 1) ──────────────────────────────────
 *
 * The honest-information rule: a bot may count what is PUBLIC — the discard pile, every
 * card on every table (banks, properties, upgrades, actions played), plus its own hand.
 * The deck and opponents' hands are one undifferentiated unseen pool; nothing here reads
 * either. Recomputed from visible state on every call, so a reshuffle (which returns the
 * discard to the unseen pool) is handled by construction — the count RISES again after a
 * shuffle, which is what makes "all OPSEC accounted for" a closing window, not a latch.
 *
 * Only the three kinds angle 1 trades on are counted; scanning upgrades is skipped
 * because an upgrade zone can only ever hold upgrade/foc cards.
 */
function unseenCounts(state, observer) {
  const deck = (state.rules && state.rules.deck) || G.DECK_BASE;
  let opsec = deck.opsec, ig = deck.inspector_general, chud = deck.chud;
  const bump = (card) => {
    if (!card || card.type !== 'action') return;
    if (card.action === 'opsec') opsec--;
    else if (card.action === 'inspector_general') ig--;
    else if (card.action === 'chud') chud--;
  };
  state.discardPile.forEach(bump);
  for (const p of state.players) {
    p.bank.forEach(bump);
    for (const cards of Object.values(p.properties)) cards.forEach(bump);
  }
  observer.hand.forEach(bump);
  return {
    opsec: Math.max(0, opsec),
    breakers: Math.max(0, ig) + Math.max(0, chud),
  };
}

// How reliably each personality counts, per decision. Card awareness is a PLANNER skill:
// the three planning modes get it in graded amounts, chud mostly does not notice (reckless
// by identity) and random never does — five modes that all count cards are one mode.
// §3.12 humanlike: 0.35, and this one is JUDGEMENT, not measurement — an event stream cannot
// show whether a player was counting the discard pile. It is set low because the corpus shows
// what a card-counting bot would look like and humans do not look like it: they fire an
// unblockable-by-arithmetic Inspector General at the same 51% they fire any other one. A high
// value here would override the measured rate through tryGuaranteedBreaker, which is exactly
// the failure mode this instrument must not have.
const CARD_AWARENESS = { conservative: 1, neutral: 0.9, aggressive: 0.75, chud: 0.15, random: 0, humanlike: 0.35 };

// A hard breaker fired while every OPSEC in the deck is visible CANNOT be answered — and
// the window closes at the next reshuffle, when the discarded OPSEC re-enter the unseen
// pool. So a guaranteed shot does not wait for the personality plan's usual triggers.
// Measured before (400 four-player games): conservative sat on an unblockable Inspector
// General at 75 decision points, neutral 36 — while firing it was a free set.
// CHUD still needs a steal WORTH the card: one that completes a set of ours, or takes out
// of a complete set — a free shot at a 1M orphan is a wasted CHUD, guaranteed or not.
function tryGuaranteedBreaker(state, bot, botId) {
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const igIdx = bot.hand.findIndex(c => c.action === 'inspector_general');
  if (igIdx >= 0) {
    const target = findBestIGTarget(opponents);
    if (target) return { type: 'play_action', cardIndex: igIdx, targetId: target.id, targetColor: target.color };
  }
  const chudIdx = bot.hand.findIndex(c => c.action === 'chud');
  if (chudIdx >= 0) {
    const completing = findChudCompletionTarget(bot, opponents);
    if (completing) return { type: 'play_action', cardIndex: chudIdx, targetId: completing.playerId, targetCardId: completing.cardId };
    const threat = biggestThreat(opponents);
    const fromSet = threat ? completeSetCards(threat)[0] : null;
    if (fromSet) return { type: 'play_action', cardIndex: chudIdx, targetId: threat.id, targetCardId: fromSet.card.id };
  }
  return null;
}

/* ── §3.8 free rearranging ──────────────────────────────────────────────
 *
 * Moving a wild between your own sets is FREE and does not cost a play (Hasbro FAQ 937,
 * ARCHITECTURE §3.8; the client itself got this wrong until `55a014f`). Every bot in this
 * file has ignored it since the file was written — `moveProperty` and `swapProperties` were
 * never once called from a bot decision.
 *
 * That is not a rounding error. Instrumented over 400 four-player games, sampling every
 * player's board at every turn start: on **16-21% of turn starts** a single free move would
 * have completed a set outright, and not one bot ever made it. It is the largest thing in
 * this file that was simply missing rather than wrong.
 *
 * The planner is a hill climb on a board score, and everything about it is chosen so it
 * cannot thrash or wedge:
 *
 *   - A CARD NEVER LEAVES A COMPLETE SET. Moving out of one can cost a set and can gain at
 *     most one, so the count of completed sets is monotone non-decreasing under every move
 *     the planner will make — which is both the strategy and the termination argument.
 *   - Only STRICT improvements are taken, on a deterministic score, so A→B→A is impossible.
 *   - Every precondition `moveProperty()` and `swapProperties()` check is checked here
 *     first, so the engine can never refuse a proposal. A refusal would be an infinite loop:
 *     a rejected rearrange costs no play and no budget, so `botTakeTurn` would re-decide,
 *     re-propose and reschedule forever.
 *   - At most four rearranges per turn, read off the engine's own budget rather than a
 *     counter of ours. The opportunity is one move deep in almost every case, and a bot that
 *     spends eight seconds sliding cards around is worse to sit across from than one that
 *     leaves a set unfinished.
 */

// Completed sets are the win condition, so they dominate. Below that the score is the
// SQUARE of each zone's progress, which is what makes concentration beat scatter: 2/4 in
// one colour outscores 1/3 + 1/4 across two, and a wild parked where it can never finish
// anything is worth moving to wherever it can.
function zoneScore(bot, color) {
  const info = G.COLORS[color];
  if (!info) return 0;
  const have = (bot.properties[color] || []).length;
  if (have === 0) return 0;
  if (G.isSetComplete(bot, color)) return 1000 + 10 * info.size;
  const frac = have / info.size;
  return 200 * frac * frac;
}

function boardScore(bot) {
  let total = 0;
  for (const color of Object.keys(G.COLORS)) total += zoneScore(bot, color);
  return total;
}

// Apply a move on the real arrays, score, and put everything back exactly as it was.
// Cheaper than cloning the board, and `isSetComplete` has to see the real zones because
// `pureSetRequired` makes "is this a set" depend on what else is sitting in the zone.
function scoreAfterMove(bot, card, from, to) {
  const src = bot.properties[from];
  const at = src.indexOf(card);
  if (at < 0) return -Infinity;
  const created = !bot.properties[to];
  if (created) bot.properties[to] = [];
  const dst = bot.properties[to];
  const wasPlaced = card.placedColor;
  src.splice(at, 1);
  card.placedColor = to;
  dst.push(card);
  const score = boardScore(bot);
  dst.pop();
  card.placedColor = wasPlaced;
  src.splice(at, 0, card);
  if (created) delete bot.properties[to];
  return score;
}

function scoreAfterSwap(bot, a, b) {
  const from = a.color, to = b.color;
  const ia = bot.properties[from].indexOf(a.card);
  const ib = bot.properties[to].indexOf(b.card);
  if (ia < 0 || ib < 0) return -Infinity;
  bot.properties[from].splice(ia, 1, b.card);
  bot.properties[to].splice(ib, 1, a.card);
  const pa = a.card.placedColor, pb = b.card.placedColor;
  a.card.placedColor = to; b.card.placedColor = from;
  const score = boardScore(bot);
  bot.properties[from].splice(ia, 1, a.card);
  bot.properties[to].splice(ib, 1, b.card);
  a.card.placedColor = pa; b.card.placedColor = pb;
  return score;
}

// How readily each personality tidies its board, per decision. This is the axis the trait
// lives on: the three planning modes always take a free set, the gremlin usually notices,
// and random mostly does not. Nobody is FORBIDDEN the move — it is free, and a bot that
// left a finished set on the floor forever would just read as broken.
// §3.12 humanlike: 1. Measured and matching already — free rearranges per 100 own turns are
// human 18.0, neutral 17.5, conservative 14.5, aggressive 12.5. planRearrange needs no
// human-facing correction; this is one of the few places the bots were already right.
const REARRANGE_BIAS = { conservative: 1, neutral: 1, aggressive: 1, chud: 0.3, random: 0.12, humanlike: 1 };
// Whether a personality will spend a move on mere consolidation — a wild that improves the
// board without finishing anything today. The chaotic two will not: they take the free set
// and nothing else, which keeps their boards scattered, which is their whole shape.
const REARRANGE_CONSOLIDATES = { conservative: true, neutral: true, aggressive: true, chud: false, random: false, humanlike: true };
// A completed set is worth ~1000 on the board score; anything under this is housekeeping.
const SET_DELTA = 500;

function rearrangesLeft(state) {
  const left = state?.rearrangesRemaining;
  return Number.isFinite(left) ? left : G.REARRANGE_BUDGET;
}

function planRearrange(state, bot, mode) {
  if (state.turnPhase !== 'play') return null;
  const left = rearrangesLeft(state);
  if (left <= 0) return null;
  if (G.REARRANGE_BUDGET - left >= 4) return null;   // the per-turn cap described above
  if (rnd() > (REARRANGE_BIAS[mode] ?? 1)) return null;
  const consolidates = REARRANGE_CONSOLIDATES[mode] ?? true;

  const base = boardScore(bot);
  const movable = [];
  for (const [color, cards] of Object.entries(bot.properties)) {
    if (!cards.length) continue;
    // Never out of a complete set: it can cost a set and can gain at most one.
    if (G.isSetComplete(bot, color)) continue;
    for (const card of cards) {
      if (card.type !== 'wild_property') continue;
      movable.push({ color, card });
    }
  }
  if (movable.length === 0) return null;

  let best = null;
  for (const { color: from, card } of movable) {
    for (const to of G.legalColorsFor(card)) {
      if (to === from || !G.COLORS[to] || G.zoneFull(bot, to)) continue;
      const delta = scoreAfterMove(bot, card, from, to) - base;
      if (delta <= 1e-9) continue;
      if (!best || delta > best.delta) best = { delta, plan: { type: 'rearrange', cardId: card.id, toColor: to } };
    }
  }

  // The atomic swap (§3.5 owner ruling, `d05d523`). Only reachable when NO single move
  // helps, because it costs two rearranges and a one-card move that achieves the same thing
  // is always cheaper — which is exactly the case the swap was ruled in for: two zones that
  // are each full of what the other one wants, where neither card can go first.
  if (!best && left >= G.SWAP_COST) {
    for (let i = 0; i < movable.length; i++) {
      for (let j = i + 1; j < movable.length; j++) {
        const a = movable[i], b = movable[j];
        if (a.color === b.color) continue;
        if (!G.legalColorsFor(a.card).includes(b.color)) continue;
        if (!G.legalColorsFor(b.card).includes(a.color)) continue;
        const delta = scoreAfterSwap(bot, a, b) - base;
        if (delta <= 1e-9) continue;
        if (!best || delta > best.delta) {
          best = { delta, plan: { type: 'swap', cardIdA: a.card.id, cardIdB: b.card.id } };
        }
      }
    }
  }

  if (!best) return null;
  if (!consolidates && best.delta < SET_DELTA) return null;
  return best.plan;
}

function myProgress(bot) {
  // How many sets toward each color?
  const progress = {};
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    progress[color] = { have, need: info.size, pct: have / info.size };
  }
  return progress;
}

function bestBuildingColor(bot) {
  // Which color is the bot closest to completing (but not yet complete)?
  let best = null, bestPct = 0;
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have >= info.size) continue; // already complete
    if (have === 0) continue;
    const pct = have / info.size;
    if (pct > bestPct) { bestPct = pct; best = color; }
  }
  return best;
}

/* ── Bot turn execution ─────────────────────────────────────────────── */

function botTakeTurn(room, botId, callbacks) {
  if (!room?.state || room.state.phase !== 'playing') return;
  const state = room.state;
  const cp = G.currentPlayer(state);
  if (cp.id !== botId || cp.eliminated) return;
  const mode = getBotMode(room, botId);

  // DRAW PHASE
  if (state.turnPhase === 'draw') {
    const result = G.drawCards(state);
    if (result.autoWin) callbacks.clearTimer(room);
    callbacks.broadcast(room);
    if (state.phase === 'finished') return;
    scheduleBotAction(room, callbacks);
    return;
  }

  // PLAY PHASE
  if (state.turnPhase === 'play') {
    // Chud mode: random chance to end turn early (reduced from 40% to 20%)
    if (mode === 'chud' && state.playsRemaining > 0 && state.playsRemaining < 3 && rnd() < 0.2) {
      botEndTurn(state, room, botId, mode, callbacks);
      return;
    }

    const action = decideBotPlay(state, botId, mode);
    if (action) {
      executeBotPlay(state, room, botId, action, callbacks);
      callbacks.broadcast(room);
      if (state.phase === 'finished') return;
      scheduleBotAction(room, callbacks);
      return;
    }
    botEndTurn(state, room, botId, mode, callbacks);
    return;
  }
}

/* ── Bot response to pending actions ────────────────────────────────── */

function botRespond(room, botId, callbacks) {
  if (!room?.state || room.state.phase !== 'playing') return;
  const state = room.state;
  const pa = state.pendingAction;
  if (!pa) return;

  const bot = G.getPlayer(state, botId);
  if (!bot) return;
  const mode = getBotMode(room, botId);
  // canCounter(): under `counterCostsPlay` (MD Faithful) an OPSEC played on your OWN turn
  // spends a play and is REFUSED with none left, so a bot that only checked its hand would
  // burn a response on an error and fall through to accept anyway. Asked before the
  // decision so the shape matches "no OPSEC in hand" exactly.
  const hasOpsec = bot.hand.some(c => c.action === 'opsec') && G.canCounter(state, botId);

  const shouldOpsec = hasOpsec && shouldPlayOpsecDecision(state, pa, mode, botId);

  if (shouldOpsec) {
    const result = G.respondToAction(state, botId, 'opsec');
    if (result.error) {
      acceptAction(state, bot, botId, pa, mode);
    }
    callbacks.broadcast(room);
    if (state.phase === 'finished') return;
    scheduleBotAction(room, callbacks);
    return;
  }

  acceptAction(state, bot, botId, pa, mode);
  callbacks.broadcast(room);
  if (state.phase === 'finished') return;
  scheduleBotAction(room, callbacks);
}

function amountOwed(state, pa, botId) {
  const entry = G.pendingEntryFor(state, botId);
  if (!entry || pa.type !== 'payment') return 0;
  if (botId === pa.sourceId || entry.depth % 2 === 1) return 0;  // conceding a block, not paying
  return pa.amount || 0;
}

function acceptAction(state, bot, botId, pa, mode) {
  const owed = amountOwed(state, pa, botId);

  if (owed > 0) {
    const payCards = selectPaymentCards(bot, owed, mode);
    const result = G.respondToAction(state, botId, 'accept', payCards.length > 0 ? payCards : undefined);
    if (result?.needPayment) {
      const allCards = getAllPayableCardIds(bot);
      G.respondToAction(state, botId, 'accept', allCards.length > 0 ? allCards : undefined);
    }
  } else {
    G.respondToAction(state, botId, 'accept');
  }
}

/* ── OPSEC decision — smarter per mode ────────────────────────────── */

// §3.12 — see the `humanlike` case below for the measurement each of these came from.
const HUMAN_SHIELD = {
  thefts:  { inspector_general: 0.77, chud: 0.47, midnight_requisition: 0.27, tdy_orders: 0.23 },
  charges: { finance_office: 0.10, roll_call: 0.03 },
  rent:    { big: 0.26, mid: 0.19, small: 0.02 },   // >=5M / 3-4M / <3M
  // Nothing in the corpus, so price it like the cheapest thing they ever answered rather
  // than letting it fall through to a silent `false`.
  unknown: 0.03,
};
// Being one turn from winning raises the price a real player will pay for a shield without
// making it automatic: 25% blocked while armed (5 of 20) against 18% overall.
const HUMAN_SHIELD_ARMED = 1.4;

function shouldPlayOpsecDecision(state, pa, mode, botId) {
  const bot = G.getPlayer(state, botId);
  const opsecCount = bot ? bot.hand.filter(c => c.action === 'opsec').length : 0;
  const entry = G.pendingEntryFor(state, botId);
  const isChainResponse = !!entry && entry.depth > 0;

  // §3.10 — an armed bot is one turn from winning: anything that could cost it a set is
  // worth an OPSEC. Random keeps a coin-flip's worth of incompetence.
  // §3.12 — humanlike is deliberately excluded from this branch. It is a RULE ("armed means
  // block everything"), and real players do not have it: measured over the production corpus,
  // a human holding a shield while armed blocked 25% of what came at them (5 of 20), against
  // 18% unarmed. Being one turn from winning raises the price they will pay; it does not make
  // the shield automatic. The humanlike case below applies that 1.4x as a multiplier on the
  // measured gradient instead. No other personality's condition or RNG draw changes.
  if (bot?.finalApproach && pa.sourceId !== botId && mode !== 'humanlike') {
    const forcedOutOfSets = pa.type === 'payment' && bankValue(bot) < (pa.amount || 0);
    if (pa.type !== 'payment' || forcedOutOfSets) {
      return mode === 'random' ? rnd() < 0.6 : true;
    }
  }

  // §3.10c THE ESCORT. An OPSEC in hand is the licence the escrow needs before it will spend
  // a breaker on our own win (see worthwhileBreakerShot), so for the two personalities that
  // require that licence, the shield is worth more held than spent on small change. Narrow on
  // purpose: only 2M-or-less demands, only when this is our LAST OPSEC, and never while we
  // are armed (the branch above already returns true for that and runs first). Round 5
  // measured the OPSEC-chain headroom at ~0.3 points, so this is a feel change, not a balance
  // change — it exists so a bot that is visibly saving a breaker also visibly saves its shield.
  if (bot && pa.type === 'payment' && (pa.amount || 0) <= 2
      && BREAKER_BAR[mode] && BREAKER_BAR[mode].escort
      && bot.hand.some(isHardBreaker)
      && bot.hand.filter(c => c.action === 'opsec').length === 1) {
    return false;
  }

  // Round 11, angle 1 — the OPSEC economy below prices every block against "the big one
  // that might come later", but what can still come is COUNTABLE. Once every Inspector
  // General and CHUD is accounted for (discard + tables + this hand), a big charge is the
  // top of what remains, so an aware personality blocks it instead of saving the shield
  // for a card that no longer exists. 4M is the same bar the modes already use for "big
  // rent". Measured before: aggressive declined 43 such blocks per 400 four-player games,
  // conservative 11 — each one 4M+ handed over with a dead shield in hand.
  // §3.12 — humanlike is excluded: its whole shield policy is the measured gradient below,
  // and a card-counting override on top of it would quietly make the instrument block big
  // charges more often than any real player in the corpus ever did.
  if (bot && pa.type === 'payment' && (pa.amount || 0) >= 4 && mode !== 'humanlike') {
    const aw = CARD_AWARENESS[mode] ?? 0;
    if (aw > 0 && rnd() < aw && unseenCounts(state, bot).breakers === 0) return true;
  }

  switch (mode) {
    case 'random':
      // Even random mode should have some survival instinct
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return rnd() > 0.3;
      if (pa.action === 'roll_call') return rnd() > 0.8; // rarely block small stuff
      if (pa.action === 'rent' && pa.amount <= 2) return rnd() > 0.8;
      return rnd() > 0.5;

    case 'conservative':
      // Smart defense: save OPSEC for high-value threats
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return true;
      if (pa.action === 'midnight_requisition') {
        // Only block steals from sets we're building
        const building = bestBuildingColor(bot);
        if (pa.targetColor === building) return true;
        return opsecCount > 1; // if we have spare OPSEC, block anyway
      }
      if (pa.action === 'finance_office') return pa.amount >= 5 && opsecCount > 1;
      if (pa.action === 'rent' && pa.amount >= 4) return true;
      if (pa.action === 'rent' && pa.amount >= 2 && opsecCount > 1) return true;
      if (pa.action === 'roll_call') return opsecCount > 1; // save for bigger threats
      if (isChainResponse) return true;
      return false;

    case 'neutral':
      // §3.10h (round 12, measured on 91 production games with 21 real players). Neutral was
      // the weakest seat at a human table by a wide margin — 13.9% per seat against
      // aggressive's 28.6% in the SAME games — and its shield policy is a direct cause. The
      // two lines below used to read `finance_office → true` and `rent >= 4 → true`, and they
      // burned 15 of 15 shields on Finance Office and 23 of 23 on charges of 5M or more.
      //
      // Real players do the opposite, on a clear gradient: Inspector General 82%, CHUD 47%,
      // Midnight Requisition 30%, rent 15%, Finance Office 10%, Roll Call 3% — and only 26%
      // of charges of 5M+ are blocked at all. A shield spent on cash is a shield that is not
      // there for the set-steal, and the set-steal is the only thing that cannot be earned
      // back. Aggressive's branch below already carried the right comment ("Don't waste OPSEC
      // on money demands — save for property theft"); this brings neutral into line without
      // making the two identical, because neutral still blocks a genuinely large charge and
      // still answers a chain.
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') return true;
      if (pa.action === 'midnight_requisition') return rnd() > 0.3;
      if (pa.action === 'tdy_orders') return rnd() > 0.7;   // humans block 17%; every bot was 0/19
      if (pa.action === 'finance_office') return opsecCount > 1;
      if (pa.action === 'rent' && pa.amount >= 6) return opsecCount > 1;
      if (isChainResponse) return true;
      return false;

    case 'aggressive':
      // Only protect complete/near-complete sets
      if (pa.action === 'inspector_general') return true;
      if (pa.action === 'chud') {
        // Check if the targeted card is from a near-complete set
        const mySets = G.completedSets(bot);
        return mySets >= 2 || rnd() > 0.3;
      }
      if (isChainResponse) return true;
      // Don't waste OPSEC on money demands — save for property theft
      return false;

    /* §3.12 — the shield economy of 21 real players, as a probability per incoming action
     * rather than a rule. Re-derived at the decision point "an action resolved against this
     * seat while they held an OPSEC in hand" (scratchpad/hb/corpus.js):
     *
     *   Inspector General 77% (13)   CHUD 47% (15)   Midnight Requisition 27% (22)
     *   TDY Orders 23% (13)          rent 15% (128)  Finance Office 10% (30)
     *   Roll Call 3% (58)
     *
     * and money charges by size: 2% under 3M (126), 19% at 3-4M (37), 26% at 5M+ (53).
     *
     * The shape is what matters and it is the opposite of a bot's: a smooth gradient with
     * the SET-STEAL at the top and cash at the bottom, and a real willingness to eat even a
     * 5M charge (74% of the time they let it through). Every planner in this file was, before
     * round 12, spending shields on money — neutral burned 15 of 15 on a Finance Office.
     */
    case 'humanlike': {
      const armed = bot?.finalApproach && pa.sourceId !== botId ? HUMAN_SHIELD_ARMED : 1;
      const amt = pa.amount || 0;
      let p;
      if (pa.action === 'rent') {
        p = amt >= 5 ? HUMAN_SHIELD.rent.big : amt >= 3 ? HUMAN_SHIELD.rent.mid : HUMAN_SHIELD.rent.small;
      } else if (HUMAN_SHIELD.charges[pa.action] !== undefined) {
        p = HUMAN_SHIELD.charges[pa.action];
      } else {
        p = HUMAN_SHIELD.thefts[pa.action];
      }
      // An action nobody in the corpus ever answered gets the corpus's floor, not a `false`
      // fall-through — that fall-through is exactly the bug §3.10h found in `tdy_orders`.
      if (p === undefined) p = HUMAN_SHIELD.unknown;
      return rnd() < Math.min(1, p * armed);
    }

    case 'chud':
      // Chaotic OPSEC: block small stuff, let big stuff through
      if (pa.action === 'roll_call') return rnd() > 0.3;
      if (pa.action === 'rent' && pa.amount <= 3) return rnd() > 0.4;
      if (pa.action === 'inspector_general') return rnd() > 0.6; // 40% chance to block
      if (pa.action === 'chud') return rnd() > 0.7; // 30% chance to block
      if (pa.action === 'finance_office') return rnd() > 0.5;
      if (pa.action === 'midnight_requisition') return rnd() > 0.5;
      return rnd() > 0.6;

    default:
      return false;
  }
}

/* ── Core decision engine ───────────────────────────────────────────── */


/* ── The holdback dial ────────────────────────────────────────────────────────────────
   [chance of stopping after 1 play, chance of stopping after 2]. Written as flavour —
   "sometimes don't use all 3 plays", so a bot does not read as a machine — but MEASURED, it
   is the strongest single strength lever in this file, and it is set per personality in
   exactly the order the personalities finish in:

       aggressive   0.00/0.08    production winrate 28.9%
       neutral      0.05/0.15    production winrate 13.3%
       conservative 0.08/0.25    production winrate 13.3%

   Zeroing it for neutral is worth +4.1pp against three shipped neutrals (z=5.2, replicated
   on three independent seed streams) and lifts set completion from 38.2 to 41.1 per 100
   turns. Halving it is worth about +2pp — dose-dependent, which is what makes the mechanism
   credible rather than coincidental. Five other candidates drawn from the same production
   data (contest the leader from their first set, drop the rent floor, gate PCS Orders on
   hand size, rescore placement, bank weak property plays) were measured the same way and
   NONE of them beat the null; gating PCS was significantly WORSE (-1.7pp, z=-2.1), because
   drawing into the hand limit is a filter — the discard sheds the lowest cards.

   So "conservative plays weakly" is not, mostly, a story about defensive card choice. It is
   a bot declining a quarter of the turns it is offered. HOLDBACK_SCALE is the dial: 1 keeps
   today's behaviour exactly, 0 removes the flavour entirely, and between the two it trades
   texture for strength at a rate that has been measured rather than guessed. Note chud and
   random do not benefit (chud's holdback lives in botTakeTurn), so pushing the dial to 0
   pulls chud DOWN the §3 table to 10.0% — inside the 8% floor, but not by much.

   SET TO 0.5 (owner decision, 2026-08-11). Measured at N=6000 per cell, seat-rotated, one
   seeded RNG stream per game, subject vs three copies of the shipped persona:

       persona       holdback      null     @0.5              @0
       conservative  0.08/0.25    24.12%   +2.47pp (z=3.1)   +5.28pp (z=6.7)
       neutral       0.05/0.15    24.18%   +2.17pp (z=2.7)   +4.25pp (z=5.4)
       aggressive    0/0.08       25.95%   +0.23pp (ns)      +1.12pp (ns)

   The gain tracks each persona's holdback size — aggressive barely moves because it had
   almost none — which is what makes this the mechanism rather than a correlate. */
const HOLDBACK = {
  conservative: [0.08, 0.25],
  neutral:      [0.05, 0.15],
  random:       [0.08, 0.15],
  aggressive:   [0,    0.08],
  chud:         [0,    0],      // handled in botTakeTurn
  // §3.12 — measured as plays per own turn: human 2.61, neutral 2.68, aggressive 2.81,
  // conservative 2.54. A person declines a little more of the turn than neutral and a little
  // less than conservative, and that is all the holdback is here. HOLDBACK_SCALE 0.5 applies
  // to it like everyone else.
  humanlike:    [0.06, 0.18],
};
const HOLDBACK_SCALE = 0.5;

// A seat may name its persona as `neutral@0` — same ladder, HOLDBACK_SCALE overridden for
// that seat only. That is what makes the holdback measurable: seating `neutral@0` against
// three plain `neutral`s asks "is this change stronger?" in one game, at one table, on one
// RNG stream. simbalance cannot answer that — its winrates are shares of a fixed pot, so a
// change that lifts every personality at once moves nothing. The suffix never reaches a
// lobby: server/handlers.js allowlists the five bare names.
function personaOf(mode) {
  const at = typeof mode === 'string' ? mode.indexOf('@') : -1;
  return at < 0 ? mode : mode.slice(0, at);
}
function holdScaleOf(mode) {
  const at = typeof mode === 'string' ? mode.indexOf('@') : -1;
  if (at < 0) return HOLDBACK_SCALE;
  const v = Number(mode.slice(at + 1));
  return Number.isFinite(v) ? v : HOLDBACK_SCALE;
}

function decideBotPlay(state, botId, mode) {
  const variant = mode;
  mode = personaOf(mode);
  const bot = G.getPlayer(state, botId);
  if (!bot || state.playsRemaining <= 0) return null;

  // §3.8 — rearranging costs no play, so it is decided before everything that does: before
  // the personality plan, before the human-like holdback (a bot sitting on its hand should
  // still tidy its board) and before the empty-hand return below (a bot that has spent its
  // whole hand can still finish a set for free). Nothing is deferred by taking it — the
  // caller re-enters within the same turn with the same plays still in the bank.
  const tidy = planRearrange(state, bot, mode);
  if (tidy) return tidy;

  if (bot.hand.length === 0) return null;

  // §3.10 — a live final approach outranks every personality quirk, including the
  // human-like holdback below: there may be no next turn to use the card on.
  const armed = findArmed(state.players, botId);
  if (armed.length > 0 && rnd() < (BREAK_URGENCY[mode] ?? 0.8)) {
    const shot = tryBreakFinalApproach(state, bot, botId, bot.hand, armed, mode);
    if (shot) return shot;
  }
  if (bot.finalApproach) {
    const shield = tryDefendFinalApproach(bot, bot.hand, mode, armed.length > 0);
    if (shield) return shield;
  }

  // Round 11, angle 1 — a hard breaker nobody can answer does not wait. When every OPSEC
  // is visible the shot is a certainty, and the window closes at the next reshuffle, so it
  // outranks the personality plan AND the holdback below. Gated per personality by
  // CARD_AWARENESS: the planners count, chud rarely notices, random never (aw 0 also
  // means random's RNG stream is untouched — the roll is short-circuited).
  {
    const aw = CARD_AWARENESS[mode] ?? 0;
    if (aw > 0 && rnd() < aw && unseenCounts(state, bot).opsec === 0) {
      const shot = tryGuaranteedBreaker(state, bot, botId);
      // §3.12 — an unblockable shot is still a shot a person declines about half the time.
      if (shot && (mode !== 'humanlike' || humanFiresBreaker(state, bot, botId, shot.cardIndex))) return shot;
    }
  }

  // §3.10c — a breaker in hand that COMPLETES OUR WINNING SET outranks the personality plan
  // and the holdback below, for the same reason the break branch does: there may be no next
  // turn. See tryArmingBreaker for why this has to be a promotion and not a gate.
  {
    // The cheap way to arm comes first: a property already in hand costs no card and cannot
    // be OPSEC'd, so it always beats spending a breaker to reach the same set count.
    const armNow = tryArmingPlay(state, bot, mode);
    if (armNow) return armNow;
    const arming = tryArmingBreaker(state, bot, botId, mode);
    if (arming) return arming;
  }

  // Human-like holdback: sometimes don't use all 3 plays
  // Conservative: 20% chance to stop after 2 plays (save cards for defense)
  // Neutral: 10% chance to stop after 2 plays
  // Random: 25% chance to stop at any point
  // Aggressive: 5% chance (almost always uses all plays)
  // Chud: handled in botTakeTurn
  const played = 3 - state.playsRemaining;
  // Round 11, angle 2 — the deck-cycle clock. §3.11 adjudicates on points after
  // DECK_CYCLE_LIMIT reshuffles, and shuffleCount is public (every shuffle is a table
  // event). In the last quarter of that budget, holding a play back saves it for a
  // "later" the attrition cap is about to take away. Measured before the fix (500
  // five-player games): every personality passed ~90 times per 500 games inside this
  // window WITH playable cards in hand — mostly PCS Orders and rents — and random won
  // more §3.6 points endings than any planner (12 of 37). Aware planners play out;
  // chud and random keep their character (and their RNG stream — no roll is consumed
  // for a mode with zero awareness).
  let clockRunning = false;
  if (played >= 1 && state.shuffleCount >= G.DECK_CYCLE_LIMIT - 4) {
    const aw = CARD_AWARENESS[mode] ?? 0;
    clockRunning = aw > 0 && rnd() < aw;
  }
  if (played >= 1 && !clockRunning) {
    // After 1 play: small chance to stop. After 2 plays: bigger chance.
    const hb = HOLDBACK[mode] || [0, 0];
    const holdChance = (played === 1 ? hb[0] : hb[1]) * holdScaleOf(variant);
    // Don't hold back if we have 8+ cards (need to discard anyway)
    if (holdChance > 0 && bot.hand.length <= 7 && rnd() < holdChance) return null;
  }
  // Also: if only OPSEC cards remain in hand, conservative/neutral hold them.
  // §3.12 humanlike joins them: median table-turns a real player held an OPSEC before firing
  // it is 11, against 3 for a bot. They sit on the shield.
  if ((mode === 'conservative' || mode === 'neutral' || mode === 'humanlike') && played >= 1) {
    const nonOpsec = bot.hand.filter(c => c.action !== 'opsec');
    if (nonOpsec.length === 0) return null; // only OPSEC in hand — hold it
  }

  // Switched on `mode`, not on `variant`. They are the same string for every bare persona, so
  // this changes no shipped seat — but `variant` still carries any `@` suffix, so
  // `aggressive@0` fell through to `default` and quietly played as NEUTRAL. The suffix form is
  // the whole mechanism `tools/simhuman.mjs` A/Bs a candidate change with, and it was only
  // ever correct for `neutral@n` by coincidence of which persona `default` happens to be.
  const plan = (() => {
    switch (mode) {
      case 'random':       return decideRandom(state, bot, botId);
      case 'conservative': return decideConservative(state, bot, botId);
      case 'neutral':      return decideNeutral(state, bot, botId);
      case 'aggressive':   return decideAggressive(state, bot, botId);
      case 'chud':         return decideChud(state, bot, botId);
      case 'humanlike':    return decideHumanlike(state, bot, botId);
      default:             return decideNeutral(state, bot, botId);
    }
  })();

  // §3.10 last line of defence. Every personality has its own banking rules and every one of
  // them values a card by its face value, so five separate code paths could each decide to
  // bank a 5M Inspector General for cash while the player across the table is one turn from
  // winning. Vetoing it once, here, covers all five (and anything added later) instead of
  // patching the same mistake in five places. We only reach this line when the break branch
  // above already declined to fire — either the urgency roll failed or the card had no legal
  // target this instant — and in both cases holding the card is strictly better than
  // converting the only counter in the deck into money we will never get to spend.
  // §3.10c widened this from "somebody is armed" to "the escrow is holding this card".
  // Measured when the escrow first went in: aggressive's banked breakers went 20 -> 82 per
  // 400 games. It was not firing them any more, so its planner fell through to step 12 and
  // sold them for cash — the escrow had moved the leak rather than closed it. A card held
  // for a final approach that never comes is still worth more than 5M we never get to spend.
  if (plan && plan.type === 'play_money' && isHardBreaker(bot.hand[plan.cardIndex])
      && (armed.length > 0
          || (BREAKER_BAR[mode] && !breakerEscrowRelease(state, bot, mode, plan.cardIndex)))) {
    const alt = bot.hand.findIndex((c, i) => i !== plan.cardIndex && !isHardBreaker(c)
      && c.type !== 'property' && c.type !== 'wild_property' && c.action !== 'opsec');
    return alt >= 0 ? { type:'play_money', cardIndex:alt } : null;
  }

  // §3.10i — the cash floor, applied exactly where the measurement pointed. The planner wants
  // to lay another property while our bank is below what the table can charge us; humans do
  // the opposite, and it is the single clearest reason they beat this bot. It substitutes for
  // a PROPERTY play only — never for a rent, a steal, a breaker or an arming play, all of
  // which are worth more than solvency — so the bot still attacks and still builds; it just
  // stops building on an empty bank. A property laid without a bank is a property paid away.
  // Ordering pass (see findChargeBooster): the planner chose a rent, the hand holds a play
  // that raises that exact rent, and a play remains to fire the rent afterwards — the
  // booster goes first. Applied at the chokepoint so all five personalities (and anything
  // added later) get correct ordering without five separate patches; the chaotic two keep
  // their attention roll, exactly as with rearranging.
  if (plan && plan.type === 'play_action' && state.playsRemaining >= 2) {
    const chosen = bot.hand[plan.cardIndex];
    // §3.10e — the planner wants to fire a breaker and the victim probably holds a shield.
    // Spend the cheap card first and let it soak the OPSEC. Deliberately NOT applied to
    // tryArmingBreaker or tryBreakFinalApproach above: both return before this line, both
    // are the highest-stakes shots in the game, and a bait that fails to draw the shield
    // there costs the shot itself. Revisit with a measurement, not a hunch.
    if (chosen && isHardBreaker(chosen)) {
      const bait = maybeBaitFirst(state, bot, botId, mode, plan);
      if (bait && rnd() < (BAIT_PATIENCE[mode] ?? 0)) return bait;
    }
    if (chosen && chosen.type === 'rent' && rnd() < (ORDER_ATTENTION[mode] ?? 1)) {
      // §3.10d — the steal booster sits between the two round-8/9 passes. It is tried after
      // findChargeBooster because a card already in hand is unblockable and costs no steal,
      // and before findCompletingPlay because completing the CHARGED colour is worth more
      // than completing some other one. The escrow still owns whether a CHUD may be spent:
      // the callback below is worthwhileBreakerShot, so a booster CHUD has to clear the same
      // bar as any other CHUD and the two changes cannot deadlock.
      const booster = findChargeBooster(state, bot, bot.hand, plan)
        || findStealBooster(state, bot, botId, bot.hand, plan,
             () => {
               const at = bot.hand.findIndex(c => c.action === 'chud');
               // §3.12 — this callback was a third door onto the table for a CHUD, and it
               // measured: the instrument fired one at 45% of decision points against the
               // human's 34%. A booster CHUD has to clear the same trigger as any other.
               if (mode === 'humanlike') return humanFiresBreaker(state, bot, botId, at);
               return !!worthwhileBreakerShot(state, bot, botId, at, mode);
             })
        // §3.12 — the ordering pass reaches findCompletingPlay directly, which is a second
        // door into the completion the sandbag just declined. It measured a real 7pp leak.
        // It must stay a COMPLETION-only door for humanlike too: substituting the general
        // property play here would let the pass replace the planner's rent with any old
        // property, which is not what the round-9 ordering rule says at all.
        // §3.10j — the cosmetic cross-colour completion is worth 0M by measurement, so there
        // is nothing to lose by holding; and if the completion is on the CHARGED colour the
        // rent valve has already released the card, so the two rules cannot fight.
        || (mode === 'humanlike' ? humanCompletingPlay(state, bot)
                                 : findCompletingPlay(bot, bot.hand,
                                     sandbagHeld(state, bot, botId, mode)));
      if (booster) return booster;
    }
  }
  return plan;
}

/* ── RANDOM MODE — unpredictable but slightly smarter ──────────────── */

function decideRandom(state, bot, botId) {
  // A 15% per-decision pass compounded with decideBotPlay's holdback into a 2.5%
  // mixed winrate (§3 floor is 8%). 5% → 8.6%/10.0% on two seeds, 2% → 11.8%/14.1%.
  if (rnd() < 0.02) return null;

  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);

  // Shuffle indices
  const indices = hand.map((_, i) => i);
  shuffle(indices);

  // Slight bias: if we have properties, 60% chance to play them first
  if (rnd() < 0.6) {
    for (const i of indices) {
      const play = randomPropertyPlay(bot, hand[i], i);
      if (play) return play;
    }
  }

  for (const i of indices) {
    const c = hand[i];

    const propPlay = randomPropertyPlay(bot, c, i);
    if (propPlay) return propPlay;
    if (c.type === 'money') {
      return { type: 'play_money', cardIndex: i };
    }
    if (c.type === 'rent') {
      const color = randomRentColor(bot, c);
      const play = makeRentPlay(state, bot, hand, i, color, opponents, 'random');
      if (play) return play;
    }
    if (c.type === 'action') {
      const action = tryRandomAction(state, bot, botId, c, i, opponents);
      if (action) return action;
    }
  }
  return null;
}

// Random/chud placement still has to respect the zone cap (§3.5).
// Uniform-random colors scattered wilds across all ten sets and random never finished
// one (1.2% winrate); a 70% pull toward a colour already started keeps the personality
// unpredictable but lets it actually win.
function randomWildColor(bot, card) {
  const open = openColorsForWild(bot, card);
  if (open.length === 0) return null;
  const started = open.filter(color => (bot.properties[color] || []).length > 0);
  const pool = started.length > 0 && rnd() < 0.7 ? started : open;
  return pool[Math.floor(rnd() * pool.length)];
}

function randomPropertyPlay(bot, card, idx) {
  if (card.type === 'property') {
    return G.zoneFull(bot, card.color) ? null : { type: 'play_property', cardIndex: idx };
  }
  if (card.type === 'wild_property') {
    const color = randomWildColor(bot, card);
    if (!color) return null;
    return { type: 'play_property', cardIndex: idx, targetColor: color };
  }
  return null;
}

function tryRandomAction(state, bot, botId, card, idx, opponents) {
  switch (card.action) {
    case 'pcs_orders':
      return { type: 'play_action', cardIndex: idx };
    case 'roll_call':
      return anyoneCanPay(opponents) ? { type: 'play_action', cardIndex: idx } : null;
    case 'surge_ops':
      // Only if a rent can actually follow it (§3.1c — Finance Office and Roll Call are
      // never doubled). Random keeps a small chance of arming one for nothing, because
      // that is the seat's character; it used to be a coin flip, and 83% of its Surges
      // expired unused.
      if (bot.hand.some(c => c.type === 'rent' && chooseBestRentColor(bot, c)) && state.playsRemaining >= 2) {
        return { type: 'play_action', cardIndex: idx };
      }
      return rnd() < 0.2 ? { type: 'play_action', cardIndex: idx } : null;
    case 'finance_office': {
      const t = randomPayer(opponents);
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.id } : null;
    }
    case 'midnight_requisition': {
      const t = findRandomStealTarget(opponents);
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.playerId, targetCardId: t.cardId } : null;
    }
    case 'chud': {
      const t = findRandomChudTarget(opponents);
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.playerId, targetCardId: t.cardId } : null;
    }
    case 'inspector_general': {
      const t = findRandomIGTarget(opponents);
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.id, targetColor: t.color } : null;
    }
    case 'tdy_orders': {
      const t = findRandomSwapTarget(bot, opponents);
      return t ? { type: 'play_action', cardIndex: idx, targetId: t.targetPlayerId, targetCardId: t.targetCardId, myCardId: t.myCardId } : null;
    }
    case 'upgrade': {
      const color = findUpgradeableSet(bot, 'upgrade');
      return color ? { type: 'play_action', cardIndex: idx, targetColor: color } : null;
    }
    case 'foc': {
      const color = findUpgradeableSet(bot, 'foc');
      return color ? { type: 'play_action', cardIndex: idx, targetColor: color } : null;
    }
    case 'opsec':
      return null;
    default:
      return { type: 'play_money', cardIndex: idx };
  }
}

/* ── CONSERVATIVE MODE — defensive but not passive ─────────────────── */

function decideConservative(state, bot, botId) {
  const mode = 'conservative';
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const mySets = G.completedSets(bot);
  const threats = findThreats(opponents);
  const threat = threatLevel(opponents);
  const played = 3 - state.playsRemaining;

  // If opponent is about to win, go offensive FIRST (before building)
  if (threat >= 2) {
    const offensive = tryDefensiveOffense(state, bot, botId, hand, opponents, threats, mode);
    if (offensive) return offensive;
  }

  // 1. Surge before a rent — and ONLY before a rent (§3.1c; see hasChargeFollowUp).
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  const rentOnComplete = findRentOnCompleteSet(state, bot, hand, opponents, mode);
  if (surgeIdx >= 0 && !state._surgeOps && state.playsRemaining >= 2
      && (rentOnComplete || hasChargeFollowUp(bot, hand, opponents))) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 1b. A live Surge expires at end of turn, so once it is armed the rent comes next, full
  //     stop. Conservative used to arm one and then wander off to PCS Orders or a property
  //     and throw the multiplier away — 89 of its 145 Surges were followed by something
  //     other than a charge, and 64% expired unused.
  if (state._surgeOps) {
    const surged = rentOnComplete || findBestRent(state, bot, hand, 0, opponents, mode);
    if (surged) return surged;
  }

  // 2. Rent on complete sets — good income, low risk
  if (rentOnComplete) return rentOnComplete;

  // 3. PCS Orders — draw more cards (sometimes first, sometimes after property)
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0 && (played === 0 || rnd() < 0.5)) {
    return { type: 'play_action', cardIndex: pcsIdx };
  }

  // 4. Properties — build toward completion. §3.10j threads the sandbag's skip set through:
  //    a held completer is skipped, so this falls through to the colour it is NOT hiding.
  const propPlay = findBestPropertyPlay(bot, hand, sandbagHeld(state, bot, botId, mode));
  if (propPlay) return propPlay;

  // 5. PCS if we skipped it above
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 6. Upgrade/FOC on complete sets
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'upgrade') {
      const color = findUpgradeableSet(bot, 'upgrade');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
    if (hand[i].action === 'foc') {
      const color = findUpgradeableSet(bot, 'foc');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
  }

  // 7. Rent — any color with rent >= 2
  const decentRent = findBestRent(state, bot, hand, 2, opponents, mode);
  if (decentRent) return decentRent;

  // 8. If WE are close to winning (2 sets), get offensive
  if (mySets >= 2) {
    const offensive = tryOffensiveActions(state, bot, botId, hand, opponents, mode);
    if (offensive) return offensive;
  }

  // 9. Roll Call if multiple opponents — but only if someone can pay the 2M.
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0 && opponents.length >= 2 && anyoneCanPay(opponents)) {
    return { type: 'play_action', cardIndex: rcIdx };
  }

  // 10. Finance Office — drain a bank that can actually pay (conservative uses it now)
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = findFinanceTarget(opponents, state);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // 11. Bank money cards
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'money') return { type: 'play_money', cardIndex: i };
  }

  // 12. Bank rent cards we can't use
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'rent' && !chooseBestRentColor(bot, hand[i])) {
      return { type: 'play_money', cardIndex: i };
    }
  }

  return null; // hold remaining cards (don't bank useful actions)
}

/* ── NEUTRAL MODE — balanced with threat awareness ─────────────────── */

function decideNeutral(state, bot, botId) {
  const mode = 'neutral';
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const threat = threatLevel(opponents);
  const mySets = G.completedSets(bot);
  const played = 3 - state.playsRemaining;

  // If someone's about to win — go aggressive to stop them FIRST
  if (threat >= 2) {
    const threats = findThreats(opponents);
    const defensive = tryDefensiveOffense(state, bot, botId, hand, opponents, threats, mode);
    if (defensive) return defensive;
  }

  // 1. Surge Ops → charge combo (rent, Finance Office or Roll Call — §3.3)
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  if (surgeIdx >= 0 && !state._surgeOps && state.playsRemaining >= 2
      && hasChargeFollowUp(bot, hand, opponents)) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 2. Rent if surged, or high-value rent (>= 3)
  if (state._surgeOps) {
    const rentPlay = findBestRent(state, bot, hand, 0, opponents, mode);
    if (rentPlay) return rentPlay;
  }

  // 3. Vary opening play — don't always lead with property
  const roll = rnd();
  if (played === 0) {
    if (roll < 0.35) {
      // 35% chance: lead with rent if decent
      const highRent = findBestRent(state, bot, hand, 2, opponents, mode);
      if (highRent) return highRent;
    } else if (roll < 0.50) {
      // 15% chance: lead with PCS Orders
      const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
      if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };
    }
    // Otherwise fall through to property
  }

  // 4. Properties — smart placement (§3.10j skip set; see decideConservative)
  const propPlay = findBestPropertyPlay(bot, hand, sandbagHeld(state, bot, botId, mode));
  if (propPlay) return propPlay;

  // 5. PCS Orders (if not played above)
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 5. Medium rent (>= 2)
  const rentPlay = findBestRent(state, bot, hand, 2, opponents, mode);
  if (rentPlay) return rentPlay;

  // 6. Offensive actions
  const offensive = tryOffensiveActions(state, bot, botId, hand, opponents, mode);
  if (offensive) return offensive;

  // 7. Upgrade/FOC
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'upgrade') {
      const color = findUpgradeableSet(bot, 'upgrade');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
    if (hand[i].action === 'foc') {
      const color = findUpgradeableSet(bot, 'foc');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
  }

  // 8. Any rent (>= 1)
  const lowRent = findBestRent(state, bot, hand, 1, opponents, mode);
  if (lowRent) return lowRent;

  // 9. Bank money
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'money') return { type: 'play_money', cardIndex: i };
  }

  // 10. Bank unusable rent
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'rent' && !chooseBestRentColor(bot, hand[i])) {
      return { type: 'play_money', cardIndex: i };
    }
  }

  return null; // hold remaining (OPSEC, usable actions)
}

/* ── AGGRESSIVE MODE — attack-first but not suicidal ───────────────── */

function decideAggressive(state, bot, botId) {
  const mode = 'aggressive';
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const mySets = G.completedSets(bot);
  const played = 3 - state.playsRemaining;

  // If we have 0 sets and 0 properties, build first (need sets to win)
  if (mySets === 0 && Object.values(bot.properties).every(c => c.length === 0) && played === 0) {
    // §3.10j inert at weight 0 — wired for symmetry so a future weight change is one constant.
    const propPlay = findBestPropertyPlay(bot, hand, sandbagHeld(state, bot, botId, mode));
    if (propPlay) return propPlay;
  }

  // 1. Surge Ops first (before any charge — §3.3)
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  if (surgeIdx >= 0 && !state._surgeOps && state.playsRemaining >= 2
      && hasChargeFollowUp(bot, hand, opponents)) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 2. Rent — any color with properties, maximize damage
  const rentPlay = findBestRent(state, bot, hand, 0, opponents, mode);
  if (rentPlay) return rentPlay;

  // 3. CHUD — target strategically, through the §3.10c escrow. Aggressive is the mode this
  //    matters most for: it has NO threat branch at all, so before the escrow it fired 54.2%
  //    of its breakers at tables where nobody held two sets. At BREAKER_PATIENCE 0.5 it stays
  //    the trigger-happy one — it just stops emptying the gun at nothing.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'chud') continue;
    const play = planBreakerShot(state, bot, botId, mode, i, () => {
      const target = findAggressiveChudTarget(state, bot, botId, opponents);
      return target ? { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId } : null;
    });
    if (play) return play;
  }

  // 4. Inspector General — same gate. `findBestIGTarget` picks the FATTEST set on the table
  //    and never looks at who is close to winning or at whether we can even use the colour,
  //    so the escrow's retarget is doing most of the work here even when it lets the shot go.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'inspector_general') continue;
    const play = planBreakerShot(state, bot, botId, mode, i, () => {
      const target = findBestIGTarget(opponents);
      return target ? { type: 'play_action', cardIndex: i, targetId: target.id, targetColor: target.color } : null;
    });
    if (play) return play;
  }

  // 5. Finance Office — drain a bank that can actually pay
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = findFinanceTarget(opponents, state);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // 6. Roll Call — only if someone can pay the 2M
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0 && anyoneCanPay(opponents)) return { type: 'play_action', cardIndex: rcIdx };

  // 7. Midnight Requisition — steal what we need
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'midnight_requisition') {
      const target = findSmartStealTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 8. TDY Orders — trade up
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'tdy_orders') {
      const target = findAggressiveSwapTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.targetPlayerId, targetCardId: target.targetCardId, myCardId: target.myCardId };
    }
  }

  // 9. Properties — still need to build sets to win (§3.10j inert at weight 0)
  const propPlay = findBestPropertyPlay(bot, hand, sandbagHeld(state, bot, botId, mode));
  if (propPlay) return propPlay;

  // 10. PCS Orders (draw more ammo)
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 11. Upgrade/FOC
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'upgrade') {
      const color = findUpgradeableSet(bot, 'upgrade');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
    if (hand[i].action === 'foc') {
      const color = findUpgradeableSet(bot, 'foc');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
  }

  // 12. Bank — only when nothing better to do
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.action === 'opsec') continue;
    if (c.type === 'money') return { type: 'play_money', cardIndex: i };
    if (c.type === 'rent') return { type: 'play_money', cardIndex: i };
    if (c.type === 'action') return { type: 'play_money', cardIndex: i };
  }

  return null;
}

/* ── CHUD MODE — chaotic gremlin, but actually plays the game ──────── */

function decideChud(state, bot, botId) {
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);

  // Chud still plays chaotically, but now actually builds sets
  // Priority: harass opponents > build own empire > bank

  // 0. Coin-flip: sometimes slam a property down before the harassment starts.
  //    Pure harass-first left chud with 1.4 sets at game end (5.2% vs 3 neutral).
  if (rnd() < 0.45) {
    for (let i = 0; i < hand.length; i++) {
      const play = randomPropertyPlay(bot, hand[i], i);
      if (play) return play;
    }
  }

  // 1. CHUD card — play it immediately for maximum chaos
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'chud') {
      // Spraying CHUD at whoever left chud unable to answer a final approach later:
      // 53.8% of approaches converted against an all-chud field vs 47.6% vs aggressive.
      const threat = biggestThreat(opponents);
      const target = (threat && chudTargetOn(threat)) || findChudChudTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 2. Inspector General — seize sets chaotically (target random complete set)
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'inspector_general') {
      const threat = biggestThreat(opponents);
      if (threat) {
        const sets = completeSetCards(threat);
        if (sets.length > 0) return { type: 'play_action', cardIndex: i, targetId: threat.id, targetColor: sets[0].color };
      }
      const target = findRandomIGTarget(opponents) || findBestIGTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id, targetColor: target.color };
    }
  }

  // 3. Midnight Requisition — steal from whoever
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'midnight_requisition') {
      const target = findRandomStealTarget(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // 4. Finance Office — a random victim, but one who can actually pay
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = randomPayer(opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // 5. Roll Call — only if someone can pay the 2M
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0 && anyoneCanPay(opponents)) return { type: 'play_action', cardIndex: rcIdx };

  // 6. TDY Orders — swap randomly
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'tdy_orders') {
      const target = findRandomSwapTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.targetPlayerId, targetCardId: target.targetCardId, myCardId: target.myCardId };
    }
  }

  // 7. Surge Ops. Chud still burns it carelessly — but only when a rent can follow, or on a
  //    quarter-chance for the noise. 126 of chud's 185 Surges were armed with no rent in
  //    hand at all, and a multiplier that cannot fire is not chaos, it is a lost play.
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  if (surgeIdx >= 0 && !state._surgeOps && state.playsRemaining >= 2
      && (hasChargeFollowUp(bot, hand, opponents) || rnd() < 0.25)) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }

  // 8. Rent — actually charge it now (chaotically pick a color)
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'rent') {
      const color = randomRentColor(bot, c);
      const play = makeRentPlay(state, bot, hand, i, color, opponents, 'chud');
      if (play) return play;
    }
  }

  // 9. Properties — play them but on random/suboptimal colors
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'property') {
      if (G.zoneFull(bot, c.color)) continue;
      return { type: 'play_property', cardIndex: i };
    }
    if (c.type === 'wild_property') {
      const open = openColorsForWild(bot, c);
      if (open.length === 0) continue;
      // 50% chance to pick worst color, 50% chance random
      const color = rnd() > 0.5
        ? chooseBestColorForWild(bot, c)
        : open[Math.floor(rnd() * open.length)];
      if (color) return { type: 'play_property', cardIndex: i, targetColor: color };
    }
  }

  // 10. PCS Orders
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // 11. Bank money
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'money') return { type: 'play_money', cardIndex: i };
  }

  // 12. Bank remaining actions (even OPSEC — chud doesn't care about defense)
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type === 'action') return { type: 'play_money', cardIndex: i };
  }

  return null;
}



/* ── §3.12 HUMANLIKE — the measurement instrument ────────────────────────────────────────
 *
 * NOT A PRODUCT. It is absent from `BOT_MODES` in simulate.js and from the five-name
 * allowlist in server/handlers.js (`handlers.js:501`), so no lobby can seat it and
 * `tools/simbalance.mjs`'s §3 grid is untouched. It exists so that "is this change stronger
 * against a PERSON?" becomes a runnable question — `tools/simhuman.mjs` seats a subject
 * personality against three of these.
 *
 * WHY IT HAD TO EXIST. simbalance measures bots against bots in a fixed pot, so a change that
 * helps against people is invisible in it — and that gap has already cost this project a good
 * idea. Round 12b measured that humans lose HALF as much property to payments as neutral
 * does, implemented the cash floor three ways, priced the cost each time (+1.6 to +2.2 turns
 * per game, 4.3 points of chud's §3 headroom) and rejected it, because the cost was
 * measurable and the benefit was not. This file is the missing half of that trade.
 *
 * WHAT IT IS BUILT FROM. 91 production games with >= 10 turns, 21 distinct real players,
 * mostly 4-seat finalApproach/setsToWin 3, 50 of them a perfectly paired
 * {human, aggressive, conservative, neutral} table. Every constant below is a rate measured
 * at a DECISION POINT — "the play phase began, they held this card, a legal target existed;
 * what fraction of the time did they use it" — not a per-game frequency. The replay that
 * reconstructs those hands was re-verified before use: it reproduces the final board exactly
 * for 84 of 84 non-truncated records.
 *
 * WHAT IT IS NOT. It is not a strong bot and it must never be tuned to become one. Its job is
 * to be WRONG IN THE SAME PLACES A PERSON IS — it declines to finish sets, it holds property
 * in hand, it lets a 5M charge through with a shield in its hand, and it is worse than every
 * planner here at following a Surge with a rent. A proxy tuned for strength would license
 * exactly the changes it exists to prevent.
 *
 * THE FOUR THINGS THAT ACTUALLY SEPARATE A PERSON FROM THIS FILE'S PLANNERS, in the order the
 * corpus ranks them, and where each one lives:
 *
 *   1. CASH SOLVENCY. Per 100 own turns humans bank 174M and lose 34.7 property cards to
 *      payments; neutral banks 106M and loses 66.1, and 51% of neutral's payments cannot be
 *      covered by its bank against the human's 28%. Humans lead a turn with a money card 20%
 *      of the time against the bots' 3-4%, and carry 0.87 money cards at turn start against
 *      1.5-1.7. Neutral lays the most property of any seat and pays it straight back out.
 *      -> HUMAN_BANK_FLOOR and HUMAN_CASH_BEFORE_PROPERTY, steps D and G below.
 *   2. SANDBAGGING. At a turn start holding a card that completes a colour they are one short
 *      of, humans play it 56% of the time (93% when it is their winning set, 52% otherwise);
 *      neutral 96%, aggressive 91%. Controlled for: 66% of the declines laid a DIFFERENT
 *      colour the same turn, and none of the declined cards were paid away or banked. A card
 *      in hand cannot be stolen, seized, or taken as payment (payableCards, game.js).
 *      -> HUMAN_COMPLETE_*, HUMAN_LAYS_SCATTER, humanPropertyPlay.
 *   3. THE SHIELD IS PRICED, NOT RULED. -> HUMAN_SHIELD, above.
 *   4. BREAKERS FIRE ON A RATE, NOT A BAR. -> HUMAN_BREAKER_FIRE, above.
 *
 * And two non-differences worth not re-deriving: leader-targeting (72.6% human against
 * 73-80% for the planners) and rent SIZE (3.32M against 3.45-3.81M) are the same. Rent
 * VOLUME is not — 33.5 rents per 100 turns against aggressive 35.9, neutral 25.7,
 * conservative 21.9 — which is why the ladder below reaches a rent early.
 */

// Below this much in the bank, cash comes before laying more property.
//
// This is the §3.10i cash floor that round 12b measured, priced and REJECTED for the shipped
// personalities — correctly, because it cost +2.2 turns and 4.3 points of chud's §3 headroom
// for a benefit no instrument could price. Here it is not a strength change; it is what the
// data says a person does, and it costs the product nothing because this bot is not a product.
//
// CALIBRATED ON A MEASURED QUANTITY rather than picked: the mean bank a player was holding at
// the moment a demand landed on them is 8.84M for a human, 8.45M for aggressive, 6.02M for
// conservative and 5.54M for neutral. At 9 the instrument realises 7.8M — the closest this
// ladder gets without pushing past the human figure, which is the bound that stops this
// constant from being a strength dial. It also reproduces both surface tells on its own, with
// no separate rule: 23% of its turns open with a money card (humans 20.3%, bots 2.7-4.2%) and
// it carries 0.74 money cards at turn start (humans 0.86, bots 1.5-1.7).
const HUMAN_BANK_FLOOR = 9;

// WHEN the cash goes in, relative to laying property. Measured on mixed turns — turns that
// contain both a property and a money play — humans put every property down before any money
// on 52% of them (N=227); every bot in the corpus did it on 100% of 244 mixed turns, without
// one exception. Mechanically the order changes nothing (all three plays resolve inside the
// turn), so this is a FEEL difference — but it is also the cleanest single tell that the
// instrument is not just a planner wearing a hat, and it is free to reproduce.
const HUMAN_CASH_BEFORE_PROPERTY = 0.48;

// 93% (13 of 14) when the completion is the winning set; 52% (65 of 125) when it is not.
const HUMAN_COMPLETE_WINNING = 0.93;
const HUMAN_COMPLETE_ORDINARY = 0.52;
// One key, so tryArmingPlay and humanPropertyPlay cannot disagree inside a single turn.
const HUMAN_COMPLETE_KEY = 'complete';

// Given they declined the completion, 66% laid a different colour on the same turn anyway.
// The decline is not "I had nothing to do with the play" — it is a choice about WHICH card.
const HUMAN_DECLINE_LAYS_ELSEWHERE = 0.66;

// Given a Surge is live, how often the next play is actually the rent it was armed for.
// Humans 60% (N=35); every planner here is at 85-90%. The bots are BETTER at this and the
// instrument has to be worse, or it will over-reward a change that improves rent sequencing.
const HUMAN_SURGE_FOLLOW = 0.60;

// Humans lay 92.6 property cards per 100 own turns; neutral lays 118.1 and pays 66.1 of them
// straight back out. The completer sandbag above accounts for only ~15% of turns, so it
// cannot by itself produce the other half of the picture: a real player carries 1.91 property
// cards in hand at turn start against every bot's 1.07-1.32, and the gap WIDENS through the
// game (turn 30+: human 1.52, aggressive 0.65, neutral 0.38).
//
// What the corpus indicts specifically is the SCATTER play — a card laid into a colour we own
// nothing in, which starts a third or fourth pile that will be paid away before it is ever
// finished. This is calibrated on props-laid-per-100-own-turns, which is measured; the choice
// of the scatter play as the one to decline is round 12b's, and it is a judgement.
const HUMAN_LAYS_SCATTER = 0.78;

// A property play that finishes nothing — used when the sandbag declines the completer, so a
// declined set cannot be completed by the fall-through two lines later.
function nonCompletingPropertyPlay(bot, hand) {
  const completing = new Set();
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type !== 'property' && c.type !== 'wild_property') continue;
    for (const color of G.legalColorsFor(c)) {
      if (!G.COLORS[color] || G.zoneFull(bot, color)) continue;
      const zone = bot.properties[color] || (bot.properties[color] = []);
      zone.push(c);
      const done = G.isSetComplete(bot, color);
      zone.pop();
      if (done) { completing.add(i); break; }
    }
  }
  if (completing.size === 0) return findBestPropertyPlay(bot, hand);
  const masked = hand.filter((_, i) => !completing.has(i));
  const play = findBestPropertyPlay(bot, masked);
  if (!play) return null;
  // findBestPropertyPlay indexes into the array it was handed; translate back.
  const card = masked[play.cardIndex];
  return { ...play, cardIndex: hand.indexOf(card) };
}

// The sandbag, at the one place a property reaches the table.
function humanPropertyPlay(state, bot, hand) {
  const completer = findCompletingPlay(bot, hand);
  if (!completer) return humanScatterGate(state, bot, findBestPropertyPlay(bot, hand));
  const winning = G.completedSets(bot) + 1 >= G.setsToWinOf(state) && !bot.finalApproach;
  const p = winning ? HUMAN_COMPLETE_WINNING : HUMAN_COMPLETE_ORDINARY;
  // The winning case shares tryArmingPlay's key, so if the arming promotion already declined
  // this turn the same decision is read back here rather than re-rolled.
  const key = winning ? HUMAN_COMPLETE_KEY : HUMAN_COMPLETE_KEY + ':ordinary';
  if (humanTurnRoll(state, bot, key, p)) return completer;
  if (humanTurnRoll(state, bot, 'elsewhere', HUMAN_DECLINE_LAYS_ELSEWHERE)) {
    return humanScatterGate(state, bot, nonCompletingPropertyPlay(bot, hand));
  }
  return null;                       // hold the hand; the ladder below spends the play
}

// Refuse a share of the plays that open a brand-new colour. See HUMAN_LAYS_SCATTER.
function humanScatterGate(state, bot, play) {
  if (!play) return null;
  const card = bot.hand[play.cardIndex];
  const color = play.targetColor || card.color;
  if ((bot.properties[color] || []).length > 0) return play;   // building, not scattering
  return humanTurnRoll(state, bot, 'scatter', HUMAN_LAYS_SCATTER) ? play : null;
}

// The completion half of humanPropertyPlay, for the ordering pass — which may only ever
// substitute a play that FINISHES a set, never an ordinary property.
function humanCompletingPlay(state, bot) {
  if (!findCompletingPlay(bot, bot.hand)) return null;
  const play = humanPropertyPlay(state, bot, bot.hand);
  if (!play) return null;
  const card = bot.hand[play.cardIndex];
  const color = play.targetColor || card.color;
  const zone = bot.properties[color] || (bot.properties[color] = []);
  zone.push(card);
  const completes = G.isSetComplete(bot, color);
  zone.pop();
  return completes ? play : null;
}

// The highest money card in hand. Not a measurement — the corpus cannot show WHICH money card
// a player chose to bank, only that they banked one — but it is the choice that reaches
// HUMAN_BANK_FLOOR in the fewest plays, which is the behaviour that was measured.
function bankOneMoney(hand) {
  let best = -1, bestIdx = -1;
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type !== 'money') continue;
    if (hand[i].value > best) { best = hand[i].value; bestIdx = i; }
  }
  return bestIdx >= 0 ? { type: 'play_money', cardIndex: bestIdx } : null;
}

function decideHumanlike(state, bot, botId) {
  const mode = 'humanlike';
  const hand = bot.hand;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const threat = threatLevel(opponents);
  const played = 3 - state.playsRemaining;

  // A. Somebody is one set from winning. Humans hit the leader as reliably as any planner
  //    (72.6% of targeted attacks), so this reuses tryDefensiveOffense unchanged — and the
  //    breakers inside it come through planBreakerShot, which applies the measured fire rate.
  if (threat >= 2) {
    const shot = tryDefensiveOffense(state, bot, botId, hand, opponents, findThreats(opponents), mode);
    if (shot) return shot;
  }

  // B. Surge, then the charge it was armed for — but only 60% of the time, because that is
  //    how often a real player actually follows through (the planners follow at 85-90%).
  const surgeIdx = hand.findIndex(c => c.action === 'surge_ops');
  if (surgeIdx >= 0 && !state._surgeOps && state.playsRemaining >= 2
      && hasChargeFollowUp(bot, hand, opponents)) {
    return { type: 'play_action', cardIndex: surgeIdx };
  }
  // The follow-through is decided once per turn, and a turn that declines it must not fire a
  // rent two steps lower down — that would undo the decline and put the rate back at 85%.
  const surgeSpent = !!state._surgeOps
    && !humanTurnRoll(state, bot, 'surgefollow', HUMAN_SURGE_FOLLOW);
  if (state._surgeOps && !surgeSpent) {
    const surged = findBestRent(state, bot, hand, 0, opponents, mode);
    if (surged) return surged;
  }

  // C. Rent off a finished set. Rent VOLUME is a real human strength (33.5 per 100 turns,
  //    second only to aggressive), and this is where most of it comes from.
  const rentOnComplete = surgeSpent ? null : findRentOnCompleteSet(state, bot, hand, opponents, mode);
  if (rentOnComplete) return rentOnComplete;

  // D. THE CASH FLOOR. A property laid off an empty bank is a property paid away — the
  //    treadmill that makes neutral the weakest seat at a human table. See HUMAN_BANK_FLOOR.
  //    Decided ONCE per turn whether it goes before or after the property, because that
  //    ordering is itself measured (HUMAN_CASH_BEFORE_PROPERTY).
  const cashFirst = humanTurnRoll(state, bot, 'cashfirst', HUMAN_CASH_BEFORE_PROPERTY);
  const belowFloor = bankValue(bot) < HUMAN_BANK_FLOOR;
  if (cashFirst && belowFloor) {
    const cash = bankOneMoney(hand);
    if (cash) return cash;
  }

  // E. Offence. Humans open a turn with an action card 42.6% of the time against 37.1% with a
  //    property, so offence sits AHEAD of the ordinary rent. It has to: buried behind the
  //    rent, the instrument only reached an Inspector General on 40% of the turns it held one
  //    at a quiet table, against the measured 49% — the ladder position, not the constant,
  //    was setting the trigger rate.
  const offensive = tryOffensiveActions(state, bot, botId, hand, opponents, mode);
  if (offensive) return offensive;

  // F. Property, through the sandbag.
  const prop = humanPropertyPlay(state, bot, hand);
  if (prop) return prop;

  // G. ...and the other half of the turns bank after the board is built.
  if (!cashFirst && belowFloor) {
    const cash = bankOneMoney(hand);
    if (cash) return cash;
  }

  // H. Rent. VOLUME is one of the two places a real player out-plays neutral outright — 33.5
  //    rents per 100 own turns against neutral's 25.7 and conservative's 21.9 — while the
  //    SIZE of the charge is not (3.32M against the bots' 3.45-3.81M). So the floor is 1, not
  //    the 2 the cautious planners use: humans charge small rents often.
  const decentRent = surgeSpent ? null : findBestRent(state, bot, hand, 1, opponents, mode);
  if (decentRent) return decentRent;

  // I. PCS Orders. Round 11 measured that gating this on hand size is significantly WORSE
  //    (-1.7pp, z=-2.1) because drawing into the hand limit is a filter, so it is ungated.
  const pcsIdx = hand.findIndex(c => c.action === 'pcs_orders');
  if (pcsIdx >= 0) return { type: 'play_action', cardIndex: pcsIdx };

  // J. Upgrades on a finished set.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'upgrade') {
      const color = findUpgradeableSet(bot, 'upgrade');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
    if (hand[i].action === 'foc') {
      const color = findUpgradeableSet(bot, 'foc');
      if (color) return { type: 'play_action', cardIndex: i, targetColor: color };
    }
  }

  // K. Any rent at all.
  const lowRent = surgeSpent ? null : findBestRent(state, bot, hand, 1, opponents, mode);
  if (lowRent) return lowRent;

  // L. Bank. Reached often, and on purpose: money in hand is dead weight and real players
  //    know it — payableCards excludes the hand, so a carried money card can neither pay a
  //    debt nor threaten anybody, and it is first out at the hand limit.
  const cash = bankOneMoney(hand);
  if (cash) return cash;
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].type === 'rent' && !chooseBestRentColor(bot, hand[i])) {
      return { type: 'play_money', cardIndex: i };
    }
  }
  return null;   // hold the rest: the shield, the breaker, and any property being sandbagged
}

/* ── §3.10j SANDBAGGING — the completer that stays in hand ──────────────────────────────
 *
 * MEASURED, on 91 production games (21 distinct players, mostly 4-seat,
 * finalApproach/setsToWin 3), at a turn start holding a card that completes a colour the
 * player is one short of: humans lay it 56% of the time, neutral 96%, aggressive 91%. And it
 * splits — 93% when the completion is their FINAL, WINNING set, 52% otherwise. Three controls
 * survived: 66% of the declines laid a DIFFERENT colour that same turn (so this is building
 * elsewhere, not sitting still); restricted to plain non-wild completers humans declined 16 of
 * 55 against aggressive's 1 of 19 and neutral's 0 of 18; and NONE of the declined cards was
 * later paid away or banked.
 *
 * WHY IT WORKS. `payableCards()` (game.js) is bank + properties + upgrades. The hand is not in
 * it. A card in hand cannot be paid away, cannot be taken by Midnight Requisition or TDY
 * Orders (they read `zoneRequisitionable`, which reads `player.properties`), cannot be taken by
 * THE CHUD CARD, and cannot be seized by an Inspector General — and a completed set is the only
 * thing an Inspector General can take at all. Holding the last card of a set converts a
 * stealable asset into an unstealable one, at the price of the rent that set would have earned,
 * the tempo of the play not made, and — at adjudication — everything `endInStalemate` counts,
 * which is `completedSets` then `playerNetWorth`, neither of which sees a hand card.
 *
 * THE OUTCOME EFFECT IS UNMEASURED AND NOTHING HERE CLAIMS IT. Humans who declined >= 50% won
 * 7 of 15; those who did not won 3 of 6. Two groups of fifteen and six support no conclusion.
 * So this ships behind SANDBAG_ENABLED = false and is priced by tools/simhuman.mjs first; the
 * enabling and kill criteria are pre-registered in scratchpad/spec-sandbag.md §9. What IS
 * measured is that humans do it and bots never do.
 */
const SANDBAG = {
  // 0.52 is the measured ordinary-completion rate, unmodified: humanlike's whole brief is to
  // reproduce the corpus. Note that decideHumanlike does NOT route through the hold below — it
  // shipped its own sandbag (humanPropertyPlay / HUMAN_COMPLETE_ORDINARY, §3.12) against the
  // same measurement and keyed per turn the same way. This entry is what makes the discard
  // tier below apply to it, and it is where the two would be reconciled if they ever merge.
  humanlike:    0.52,
  // Asset protection is conservative's whole identity — the highest HOLDBACK, escort: true —
  // so it takes the largest legacy dose. NOT 0.52: it already carries two patience axes, and
  // round 12b's cash floor is the warning that stacking passivity on conservative buys +2.2
  // turns per game.
  conservative: 0.35,
  // The lobby default, and the seat that measured worst against real players (10.7% against a
  // 25% fair share) by laying the most property of any seat and paying it straight back out.
  // A small dose aimed at exactly that. Small, because neutral's turn budget is what most
  // directly sets game length.
  neutral:      0.20,
  // escort: false, leads with the biggest card it holds, already ranks best against humans, and
  // already matches the measured completion rate (91%). Holding is the negation of its
  // character, and the zero is the distinctness gate: 0.35 / 0.20 / 0 reads left to right.
  aggressive:   0,
  // A zero short-circuits before any rnd() call, so the chaotic two keep byte-identical RNG
  // streams and paired-seed before/after comparison stays alive — the same reasoning that gives
  // them BAIT_PATIENCE 0, CUSHION_PRESSURE 0 and BREAKER_BAR null. Belt and braces: the call
  // sites are inside the three PLANNER selectors, so decideChud and decideRandom never reach
  // this code at all.
  chud:         0,
  random:       0,
};
const SANDBAG_DEFAULTS = { ...SANDBAG };
let SANDBAG_ENABLED = false;      // THE FLAG. OFF until tools/simhuman.mjs prices it.
const SANDBAG_BANK_FLOOR = 5;     // at or above this bank a charge is paid in cash, so the set
                                  // is not what pays and there is nothing to hide from.
const SANDBAG_WILDS = false;      // v1 holds PLAIN properties only.
const SANDBAG_MAX_HELD = 1;       // at most one colour hidden at a time.
const SANDBAG_TIEBREAK = 'value'; // which of two completers to hide. Lowest-confidence
                                  // constant in the file; alternative 'rent'. Sweep it if the
                                  // feature survives §9.

// A setter, not a mutable export: SANDBAG_ENABLED is a module `let`, so assigning to
// Bot._internal.SANDBAG_ENABLED would not rebind it. Same shape as setRng. `weights` is merged
// over the shipped defaults so a caller can name one personality; setSandbag(null) restores.
function setSandbag(opts) {
  if (!opts) {
    SANDBAG_ENABLED = false;
    for (const k of Object.keys(SANDBAG)) delete SANDBAG[k];
    Object.assign(SANDBAG, SANDBAG_DEFAULTS);
    return;
  }
  if ('enabled' in opts) SANDBAG_ENABLED = !!opts.enabled;
  if (opts.weights) Object.assign(SANDBAG, opts.weights);
}
function sandbagConfig() { return { enabled: SANDBAG_ENABLED, weights: { ...SANDBAG } }; }

// Pure, no state: would this card finish a zone right now? chooseDiscards needs it and has
// only `bot`, so it cannot be phrased as a play the way findCompletingPlay is. Restores
// bot.properties exactly, including the absence of a key.
function completingColorOf(bot, card) {
  if (!card || (card.type !== 'property' && card.type !== 'wild_property')) return null;
  const props = bot.properties || (bot.properties = {});
  for (const color of G.legalColorsFor(card)) {
    if (!G.COLORS[color] || G.zoneFull(bot, color)) continue;
    const had = Object.prototype.hasOwnProperty.call(props, color);
    const prev = props[color];
    props[color] = (prev || []).concat([card]);
    const done = G.isSetComplete(bot, color);
    if (had) props[color] = prev; else delete props[color];
    if (done) return color;
  }
  return null;
}
function completesASet(bot, card) { return completingColorOf(bot, card) !== null; }

// What the completed set would be worth to lose — the tiebreak in §5.1. The rent valve has
// already removed any colour that could earn this turn, so the remaining question is purely
// "which is more expensive to have seized".
function sandbagHoldValue(bot, card) {
  const color = completingColorOf(bot, card);
  if (!color) return 0;
  if (SANDBAG_TIEBREAK === 'rent') {
    const props = bot.properties, had = Object.prototype.hasOwnProperty.call(props, color);
    const prev = props[color];
    props[color] = (prev || []).concat([card]);
    const r = G.calcRent(bot, color);
    if (had) props[color] = prev; else delete props[color];
    return r;
  }
  return (bot.properties[color] || []).reduce((s, c) => s + c.value, 0) + card.value;
}

// A hidden set earns nothing, so release the card the moment the colour could actually be
// CHARGED this turn. Determined from the engine's own numbers rather than guessed: rentYield
// caps by what the victims can hand over, which is the same test makeRentPlay uses to refuse a
// charge that collects nothing — so this valve cannot release the card for a rent the planner
// would then decline to fire. Roll-free for the planner modes (chooseRentTarget only rolls for
// chud and random, whose weight is 0).
function sandbagRentFirable(state, bot, botId, card, mode) {
  if (state.playsRemaining < 2) return false;   // a play must be left to fire the rent after
  const color = completingColorOf(bot, card);
  if (!color) return false;
  const rents = bot.hand.filter(c => c.type === 'rent'
    && (c.colors[0] === 'any' || c.colors.includes(color)));
  if (rents.length === 0) return false;
  const opponents = state.players.filter(p => p.id !== botId && !p.eliminated);
  const props = bot.properties, had = Object.prototype.hasOwnProperty.call(props, color);
  const prev = props[color];
  props[color] = (prev || []).concat([card]);
  let firable = false;
  if (G.calcRent(bot, color) > 0) {
    for (const c of rents) {
      if (rentYield(state, bot, c, color, opponents, mode).value > 0) { firable = true; break; }
    }
  }
  if (had) props[color] = prev; else delete props[color];
  return firable;
}

// Composing with round 12's escrow. tryArmingBreaker opens only at
// completedSets + 1 >= setsToWin, so sandbagging our SECOND set keeps that gate shut and
// leaves the bot sitting on the property that would have loaded the gun. A regression found by
// reading the escrow rather than by running it. The sandbag steps aside.
function sandbagArmingUnlock(state, bot, botId, mode) {
  if (G.completedSets(bot) + 1 < G.setsToWinOf(state) - 1) return false;
  if (state.playsRemaining < 2) return false;
  for (let i = 0; i < bot.hand.length; i++) {
    if (!isHardBreaker(bot.hand[i])) continue;
    const shot = worthwhileBreakerShot(state, bot, botId, i, mode);
    if (shotGainsUsASet(state, bot, botId, shot)) return true;
  }
  return false;
}

// The gate, in order. Everything before the roll is deterministic, so a bot that will not
// sandbag consumes no randomness. Returns { valve, pick }: `valve` is the name of the release
// that fired (telemetry, and it keeps the tests from asserting on behaviour with three possible
// causes), `pick` is the single card that would be held if the roll agrees.
function sandbagGate(state, bot, botId, mode) {
  const no = (valve) => ({ valve, pick: null });
  if (!SANDBAG_ENABLED) return no('flag');
  const w = SANDBAG[mode] ?? 0;
  if (!(w > 0)) return no('flag');                 // no rnd() for a zero
  // Read from state, never assumed. Under `instant` the set wins the moment it completes from
  // any call site including off-turn; under `mdFaithful` a set completed on our own turn wins
  // on the spot, the preset ships chud: 0 so half the seizure threat does not exist,
  // counterCostsPlay changes the tempo arithmetic the 52% was measured under, and
  // pureSetRequired changes what "completes a set" even means for a wild zone.
  if (state.winRule === 'instant' || state.winRule === 'mdFaithful') return no('winrule');
  if (bot.finalApproach) return no('armed');
  const win = G.setsToWinOf(state);                // per-room; the longGame preset ships 5
  // THE WINNING SET, which is the 93% leg. This is tryArmingPlay's territory (round 12 already
  // shipped the half of sandbagging that must never be sandbagged) and the gate is doubled here.
  if (G.completedSets(bot) + 1 >= win) return no('winningset');
  // --- release valves, table-wide ---
  // §3.11 adjudicates on points after DECK_CYCLE_LIMIT reshuffles, and inside that window there
  // is no "later" to save the card for. decideBotPlay's holdback clock uses the same window.
  if ((state.shuffleCount || 0) >= G.DECK_CYCLE_LIMIT - 4) return no('clock');
  // shuffleCount does NOT cover the idle-turn ending: endTurn also ends the game when
  // _idleTurns >= activeCount with deck AND discard empty, and a bot that plays nothing is a
  // bot that FEEDS that counter. (The third ending, contestLaps, is covered by 'race' below,
  // because a contested approach means an opponent already at setsToWin.)
  if (state.deck.length === 0 && state.discardPile.length === 0) return no('dry');
  // >= not >: at exactly HAND_LIMIT a hold guarantees a discard decision next turn over a hand
  // containing the completer, and laying it now costs nothing.
  if (bot.hand.length >= G.HAND_LIMIT) return no('handlimit');
  if (state.players.some(p => p.id !== botId && !p.eliminated && G.completedSets(p) >= win - 1))
    return no('race');
  // --- "holding is only safer when …" — two different threats ---
  // SEIZURE: only an Inspector General or THE CHUD CARD can reach a completed set. If none can
  // come, a completed set is safe on the table. Honest information only (round 11).
  if (unseenCounts(state, bot).breakers === 0) return no('nobreakers');
  // The mirror image of round 12's escort clause: a shield in hand means the seizure can be
  // answered, so the zone is not exposed and the set should be earning.
  if (bot.hand.some(c => c.action === 'opsec')) return no('shield');
  // PAYMENT: if the bank can absorb an ordinary charge the property is not what pays; if it
  // cannot, the property is exactly what pays. This is NOT the rejected cash floor — that
  // substituted a bank play for a property play across the board and cost +2.2 turns per game.
  // This substitutes nothing; it is a condition on an already-narrow branch.
  if (bankValue(bot) >= SANDBAG_BANK_FLOOR) return no('bank');
  // --- candidates ---
  let cands = bot.hand.filter(c =>
    (c.type === 'property' || (SANDBAG_WILDS && c.type === 'wild_property'))
    && completesASet(bot, c));
  if (cands.length === 0) return no(null);
  // Structurally impossible for plain properties in the shipped deck (buildDeck emits exactly
  // COLORS[c].size plain cards per colour, and the property block is non-editable), but it
  // becomes reachable the moment SANDBAG_WILDS flips.
  const byColor = {};
  for (const c of cands) {
    const col = completingColorOf(bot, c);
    byColor[col] = (byColor[col] || 0) + 1;
  }
  const perCard = {};
  cands = cands.filter(c => {
    if (byColor[completingColorOf(bot, c)] > 1) { perCard[c.id] = 'dupe'; return false; }
    if (sandbagRentFirable(state, bot, botId, c, mode)) { perCard[c.id] = 'rent'; return false; }
    return true;
  });
  if (cands.length === 0) return { valve: null, pick: null, perCard };
  if (sandbagArmingUnlock(state, bot, botId, mode)) return no('armingunlock');
  // The idle valve. Control 1 of the measurement is that 66% of declines laid a DIFFERENT
  // colour the same turn — the behaviour is "build elsewhere", never "pass". An OPSEC is not
  // "something else to do": conservative, neutral and humanlike hold their shields by rule, so
  // a hand of [completer, OPSEC] is an idle turn too. This is an approximation and the residual
  // is a wasted turn at probability <= w: sandbagGate is called from inside the planner and
  // cannot see the planner's fall-through without re-running it, which is the rnd()-doubling
  // round 12 forbade.
  const heldSet = new Set(cands.map(c => c.id));
  const somethingElse = bot.hand.some(c => !heldSet.has(c.id) && c.action !== 'opsec');
  if (!somethingElse) return no('idle');
  // SANDBAG_MAX_HELD = 1. Holding two completers doubles the tempo cost, reproduces neither the
  // measurement nor control 1, and would cost a second roll.
  let pick = cands[0];
  for (const c of cands) {
    if (sandbagHoldValue(bot, c) > sandbagHoldValue(bot, pick)) pick = c;
  }
  return { valve: null, pick: SANDBAG_MAX_HELD > 0 ? pick : null, perCard };
}

/* The roll is taken ONCE PER TURN, not once per decision. Round 12, in its own words: "a
 * probability re-rolled every decision is not patience; it is a delay" — decideBotPlay is
 * called once per play, so a naive per-decision rnd() < 0.52 holds a card across a whole turn
 * only 14% of the time.
 *
 * Keyed on `state`, not a module global: state is per-room and a server runs many rooms.
 * `_`-prefixed and transient, like _surgeOps / _contestedSince / _idleTurns, and never read by
 * getPlayerView. Only the ROLL is cached — every deterministic valve above is re-evaluated on
 * every call, because the hand shrinks, the bank grows and an opponent can arm mid-turn, and
 * all three must be able to release the card inside the turn. Because the roll is retaken next
 * turn a hold decays geometrically: at w = 0.52 the expected hold is ~2.1 turns. */
function sandbagRoll(state, botId, mode, card) {
  const key = (state.turnCounter || 0) + ':' + botId;
  let cache = state._sandbagRoll;
  if (!cache || cache.key !== key) cache = state._sandbagRoll = { key, byCard: {} };
  if (!(card.id in cache.byCard)) cache.byCard[card.id] = rnd() < (SANDBAG[mode] ?? 0);
  return cache.byCard[card.id];
}

// The array of card ids held THIS TURN. At most one, and at most one rnd() draw.
function sandbagHeld(state, bot, botId, mode) {
  mode = personaOf(mode);
  const { pick } = sandbagGate(state, bot, botId, mode);
  if (!pick) return [];
  return sandbagRoll(state, botId, mode, pick) ? [pick.id] : [];
}

// Which valve released `card` — for telemetry (tools/botaudit.mjs needs to report which valve
// is doing the work) and so a test never has to assert on behaviour with three possible causes.
// null means nothing released it: either it is being held, or it was never a candidate.
function sandbagRelease(state, bot, botId, mode, card) {
  mode = personaOf(mode);
  const { valve, perCard } = sandbagGate(state, bot, botId, mode);
  if (valve) return valve;
  if (!card) return null;
  return (perCard && perCard[card.id]) || null;
}

/* ── Smart property placement ──────────────────────────────────────── */

// `held` is the sandbag's skip set (§3.10j). Round 12 established that a chokepoint veto in
// decideBotPlay is the wrong shape — a chokepoint can only cancel, and recovering the planner's
// next-best option means re-running it over a masked hand, which doubles rnd() consumption and
// kills paired-seed comparison. So the skip is threaded into the two pure, roll-free selectors
// instead: the held card is SKIPPED, never spliced, so cardIndex stays correct, and a planner
// that finds nothing falls through to its own next step with zero extra rolls. That
// fall-through is not a side effect — it is the mechanism that reproduces control 1 of the
// measurement (66% of declines laid a different colour that same turn).
function findBestPropertyPlay(bot, hand, held) {
  // Play properties that advance our best sets first
  const progress = myProgress(bot);
  let bestPlay = null, bestScore = -1;

  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (held && held.length && held.includes(c.id)) continue;   // §3.10j
    if (c.type === 'property') {
      if (G.zoneFull(bot, c.color)) continue;
      const pct = progress[c.color]?.pct || 0;
      // Prefer colors we're already building + smaller sets (easier to complete)
      const sizeBonus = (5 - G.COLORS[c.color].size) * 0.1;
      const score = pct + sizeBonus + (progress[c.color]?.have > 0 ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; bestPlay = { type: 'play_property', cardIndex: i }; }
    }
    if (c.type === 'wild_property') {
      const color = chooseBestColorForWild(bot, c);
      if (!color) continue;
      const pct = progress[color]?.pct || 0;
      const score = pct + 0.3; // bonus for flexibility
      if (score > bestScore) { bestScore = score; bestPlay = { type: 'play_property', cardIndex: i, targetColor: color }; }
    }
  }
  return bestPlay;
}

/* ── Defensive offense (target threats specifically) ───────────────── */

function tryDefensiveOffense(state, bot, botId, hand, opponents, threats, mode) {
  if (threats.length === 0) return tryOffensiveActions(state, bot, botId, hand, opponents, mode);

  // Round 11, angle 4 — findThreats() returns SEAT order, so with two 2-set threats every
  // loop below hit whoever sat first. Rank by who is actually in front: sets, then total
  // payable value (the same tiebreak the leader metric uses).
  threats = threats.slice().sort((a, b) =>
    G.completedSets(b) - G.completedSets(a) || G.playerTotalValue(b) - G.playerTotalValue(a));

  // Inspector General — seize a set from the biggest threat.
  // §3.10c: through the escrow, which retargets onto the set that denies a real threat or
  // completes our own win before it falls back to this branch's seat-ordered scan.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'inspector_general') continue;
    const play = planBreakerShot(state, bot, botId, mode, i, () => {
      for (const threat of threats) {
        for (const [color] of Object.entries(threat.properties)) {
          if (G.isSetComplete(threat, color)) {
            return { type: 'play_action', cardIndex: i, targetId: threat.id, targetColor: color };
          }
        }
      }
      return null;
    });
    if (play) return play;
  }

  // CHUD — steal from threat's best set. The legacy fallback below picks the threat's
  // highest-value card REGARDLESS of whether it sits in a complete set, which disarms
  // nobody; the escrow's retarget moves it into one whenever a worth-it target exists.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'chud') continue;
    const play = planBreakerShot(state, bot, botId, mode, i, () => {
      for (const threat of threats) {
        let bestCard = null;
        for (const cards of Object.values(threat.properties)) {
          for (const c of cards) {
            if (!bestCard || c.value > bestCard.value) bestCard = { playerId: threat.id, cardId: c.id, value: c.value };
          }
        }
        if (bestCard) return { type: 'play_action', cardIndex: i, targetId: bestCard.playerId, targetCardId: bestCard.cardId };
      }
      return null;
    });
    if (play) return play;
  }

  // Midnight Requisition — steal from threat's incomplete sets (best card, not cards[0])
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'midnight_requisition') {
      for (const threat of threats) {
        let best = null;
        for (const [col, cards] of Object.entries(threat.properties)) {
          if (G.isSetComplete(threat, col)) continue;
          for (const c of cards) if (!best || c.value > best.value) best = c;
        }
        if (best) return { type: 'play_action', cardIndex: i, targetId: threat.id, targetCardId: best.id };
      }
    }
  }

  // Finance Office — drain threat's bank. `canPay` is the round-10 wasted-charge rule, and
  // this was the one Finance Office call site of five that never got it: the other four go
  // through findFinanceTarget or randomPayer, which both filter, while this branch returned
  // the first threat unconditionally. A threat usually has value by construction — two
  // complete sets — but not always: the rainbow wilds are worth 0M, so a player whose sets
  // are built out of them is a threat with a total value of zero, and this fired a play at
  // them for nothing. Rare, but it is a strict blunder and it costs a play at exactly the
  // moment plays are worth the most.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      for (const threat of threats) {
        if (!canPay(threat)) continue;
        return { type: 'play_action', cardIndex: i, targetId: threat.id };
      }
    }
  }

  // Fall back to general offense
  return tryOffensiveActions(state, bot, botId, hand, opponents, mode);
}

/* ── Shared offensive action helpers ────────────────────────────────── */

function tryOffensiveActions(state, bot, botId, hand, opponents, mode) {
  // Inspector General — §3.10c escrow. When the shot earns neither denial nor a set of ours,
  // a patient personality holds the card and this loop falls through to the CHUD below, then
  // to Midnight Requisition and Finance Office. That fall-through is the whole reason the
  // gate lives here rather than at decideBotPlay's chokepoint.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'inspector_general') continue;
    const play = planBreakerShot(state, bot, botId, mode, i, () => {
      const target = findBestIGTarget(opponents);
      return target ? { type: 'play_action', cardIndex: i, targetId: target.id, targetColor: target.color } : null;
    });
    if (play) return play;
  }

  // CHUD — §3.10c escrow. Its bar is the strict one: 82% of landed CHUDs completed nothing
  // of ours on the pre-change tree, so it must finish one of our zones or come out of a real
  // threat's complete set.
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action !== 'chud') continue;
    const play = planBreakerShot(state, bot, botId, mode, i, () => {
      const target = findSmartChudTarget(bot, opponents);
      return target ? { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId } : null;
    });
    if (play) return play;
  }

  // Midnight Requisition
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'midnight_requisition') {
      const target = findSmartStealTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.playerId, targetCardId: target.cardId };
    }
  }

  // Finance Office — only against a bank that can pay
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'finance_office') {
      const target = findFinanceTarget(opponents, state);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.id };
    }
  }

  // Roll Call — only if someone can pay the 2M
  const rcIdx = hand.findIndex(c => c.action === 'roll_call');
  if (rcIdx >= 0 && anyoneCanPay(opponents)) return { type: 'play_action', cardIndex: rcIdx };

  // TDY Orders
  for (let i = 0; i < hand.length; i++) {
    if (hand[i].action === 'tdy_orders') {
      const target = findSmartSwapTarget(bot, opponents);
      if (target) return { type: 'play_action', cardIndex: i, targetId: target.targetPlayerId, targetCardId: target.targetCardId, myCardId: target.myCardId };
    }
  }

  return null;
}

/* ── Execute bot play ───────────────────────────────────────────────── */

// The ONE place a bot decision becomes an engine call. Exported (`_internal.applyBotAction`)
// because every harness that drives bots — simulate.js, the test suite, anything an agent
// writes next — otherwise reimplements this switch, and the day a new action type appears
// each copy silently stops executing it and spins the turn loop instead. That is exactly
// what happened when §3.8's free rearrange was added.
function applyBotAction(state, botId, action) {
  switch (action.type) {
    case 'play_property':
      return G.playProperty(state, botId, action.cardIndex, action.targetColor);
    case 'play_money':
      return G.playAsMoney(state, botId, action.cardIndex);
    case 'play_action':
      return G.playAction(state, botId, action.cardIndex, {
        targetId: action.targetId,
        targetColor: action.targetColor,
        targetCardId: action.targetCardId,
        myCardId: action.myCardId,
      });
    // §3.8 — free, and it does NOT spend a play. planRearrange() re-checks every
    // precondition these two enforce, so a refusal here would be a bug rather than a
    // rejected gamble: the turn would neither advance nor end.
    case 'rearrange':
      return G.moveProperty(state, botId, action.cardId, action.toColor);
    case 'swap':
      return G.swapProperties(state, botId, action.cardIdA, action.cardIdB);
    default:
      return { error: 'Unknown bot action ' + action.type };
  }
}

function executeBotPlay(state, room, botId, action, callbacks) {
  const result = applyBotAction(state, botId, action);
  if (result?.error) {
    console.log(`[BOT] ${botId} play error: ${result.error}`);
  }
  if (state.phase === 'finished') callbacks.clearTimer(room);
}

/* ── End turn ───────────────────────────────────────────────────────── */

function botEndTurn(state, room, botId, mode, callbacks) {
  const bot = G.getPlayer(state, botId);
  if (!bot) return;

  let discardIds;
  if (bot.hand.length > 7) {
    discardIds = chooseDiscards(bot, bot.hand.length - 7, mode);
  }

  const result = G.endTurn(state, botId, discardIds);
  // Blind `(idx+1) % len` skipped beginTurn() and could hand the turn to an eliminated
  // seat; forceEndTurn() advances to the next ACTIVE seat and runs the turn-start hooks.
  if (result.error) G.forceEndTurn(state);
  callbacks.startTimer(room);
  callbacks.broadcast(room);
  scheduleBotAction(room, callbacks);
}

/* ── Target selection helpers ───────────────────────────────────────── */

function findLeader(opponents) {
  if (opponents.length === 0) return null;
  return opponents.reduce((best, p) => {
    const bSets = G.completedSets(best);
    const pSets = G.completedSets(p);
    if (pSets > bSets) return p;
    if (pSets === bSets && totalProps(p) > totalProps(best)) return p;
    return best;
  });
}

function findPoorestPlayer(opponents) {
  if (opponents.length === 0) return null;
  return opponents.reduce((worst, p) =>
    G.playerTotalValue(p) < G.playerTotalValue(worst) ? p : worst);
}

function findRichestPlayer(opponents) {
  if (opponents.length === 0) return null;
  return opponents.reduce((best, p) => {
    const bBank = p.bank.reduce((s, c) => s + c.value, 0);
    const bestBank = best.bank.reduce((s, c) => s + c.value, 0);
    return bBank > bestBank ? p : best;
  });
}

// Finance Office demands 5M. It is worth a play only against someone who can hand something
// over — draining a bank is best (cash leaves without breaking a board), so prefer the
// richest BANK among players who can pay at all, falling back to whoever owns the most.
// Returns null when the whole table is broke (owner report: no charge into an empty table).
function findFinanceTarget(opponents, state) {
  const pool = opponents.filter(canPay);
  if (pool.length === 0) return null;
  // §3.10f — a fixed 5M demand is worth most against the thinnest cushion at setsToWin - 1,
  // not against the fattest bank. Before this, aggressive routed every Finance Office through
  // the bank-size test below and demanded 5M from a 19M bank while a 4M cushion sat next to it.
  if (state) {
    const leaders = pool.filter(p => preArmedLeader(state, p));
    if (leaders.length > 0) {
      return leaders.reduce((best, p) => (disposableValue(p) < disposableValue(best) ? p : best));
    }
  }
  return pool.reduce((best, p) => {
    const pb = bankValue(p), bb = bankValue(best);
    if (pb !== bb) return pb > bb ? p : best;
    return G.playerTotalValue(p) > G.playerTotalValue(best) ? p : best;
  });
}

// A random victim who can actually pay — the chaotic seats' Finance Office / demand target.
function randomPayer(opponents) {
  const pool = opponents.filter(canPay);
  return pool.length > 0 ? pool[Math.floor(rnd() * pool.length)] : null;
}

function findMostPropertyPlayer(opponents) {
  if (opponents.length === 0) return null;
  return opponents.reduce((best, p) => totalProps(p) > totalProps(best) ? p : best);
}

function totalProps(player) {
  let count = 0;
  for (const cards of Object.values(player.properties)) count += cards.length;
  return count;
}

/* ── Wild card color selection ──────────────────────────────────────── */

// §3.5 — a zone that already holds a full set is not a legal destination.
function openColorsForWild(bot, card) {
  const all = card.colors[0] === 'any' ? Object.keys(G.COLORS) : card.colors;
  return all.filter(color => G.COLORS[color] && !G.zoneFull(bot, color));
}

function chooseBestColorForWild(bot, card) {
  const validColors = openColorsForWild(bot, card);
  if (validColors.length === 0) return null;
  let best = validColors[0];
  let bestScore = -1;
  for (const color of validColors) {
    const info = G.COLORS[color];
    if (!info) continue;
    const have = (bot.properties[color] || []).length;
    // Score: progress toward completion + bonus for smaller sets
    const score = (have / info.size) + (have > 0 ? 0.3 : 0) + ((5 - info.size) * 0.05);
    if (score > bestScore) { bestScore = score; best = color; }
  }
  return best;
}

/* ── Rent helpers ───────────────────────────────────────────────────── */

// §3.2 — the wild ("any") rent card must name a single victim.
function isWildRent(card) { return card.type === 'rent' && card.colors[0] === 'any'; }

// What a charge of `face` is actually worth against this opponent. Two corrections to
// "the rent number on the card":
//   - it is capped by what they can hand over. A 7M rent aimed at a player holding 2M
//     collects 2M, and aiming it at somebody solvent instead is free money.
//   - anything above their BANK has to come off the board, and a property leaving their
//     board is worth more than the same millions in cash — that is the denial half of a
//     rent, and it is why bleeding a player past their cash is not the same as taxing them.
function collectableFrom(opp, face) {
  const got = Math.min(face, G.playerTotalValue(opp));
  return got + (got > bankValue(opp) ? 1.5 : 0);
}

// Opponents who can actually hand over something. A charge aimed outside this set collects
// nothing and, since playerTotalValue 0 means the player owns nothing of value, denies
// nothing either — it is a lost play, which is the owner's "charge rent when all players
// have nothing." Used to gate every charge below.
function canPay(o) { return !o.eliminated && G.playerTotalValue(o) > 0; }
function anyoneCanPay(opponents) { return opponents.some(canPay); }

/* ── §3.10f CUSHION PRESSURE (round 12) ─────────────────────────────────────────────────
 *
 * The owner asked for bots that "charge as much rent as possible to someone in final approach
 * so they have to give up some of their sets". Measured (docs §4), the grace cycle is the
 * wrong window by a wide margin: an armed player's disposable value is a MEDIAN OF 24M while
 * the best stacked charge an opponent can fire is a median of 2M, and only 2.5% of
 * grace-cycle turns could any charge sequence exceed the cushion. You cannot bankrupt someone
 * during Final Approach.
 *
 * But the leader's bank is a median of 4M at one set and 8M at two — and 13M plus 9M of loose
 * property the moment they arm. THE LEVERAGE IS SPENT BETWEEN THE SECOND SET AND THE THIRD,
 * and the bots have never distinguished that player from any other payer: the scorer below
 * ranked by what a charge COLLECTS, which actively prefers rich targets, and a rich target is
 * by definition the one a charge cannot hurt.
 *
 * So against a player at setsToWin - 1, score by the FRACTION OF THEIR CUSHION the charge
 * removes rather than by what it banks for us. 3M off a 2-set leader with 4M of slack beats
 * 5M off a one-set player sitting on 15M.
 */

// Scale of the cushion term relative to the plain "what does this collect" score. The primary
// dial: raise it and the planners tunnel on the leader, which lengthens games and invites
// kingmaking; lower it and the change does nothing.
let CUSHION_GAIN = 10;   // `let` only for setTuning (inert eval hook); shipped value unchanged
// Who plays this way. The chaotic two must NOT learn it — target choice is where their
// character is most visible, and a zero here keeps their RNG streams untouched.
// §3.12 humanlike: 1. Target selection is NOT what separates a person from a planner —
// share of targeted attacks aimed at the table leader is human 72.6% (N=496) against
// aggressive 73.4%, neutral 73.4%, conservative 80.1% and ~32% for random. Do not "fix" it.
const CUSHION_PRESSURE = { conservative: 1, neutral: 1, aggressive: 0.7, chud: 0, random: 0, humanlike: 1 };

// Is this player one set from winning but not yet armed — the window where a charge can still
// reach them? setsToWin is a per-room rule (3/4/5), so it is read from state, never assumed.
function preArmedLeader(state, p) {
  return !p.eliminated && !p.finalApproach && G.completedSets(p) >= G.setsToWinOf(state) - 1;
}

function chooseRentTarget(state, opponents, mode, face = Infinity) {
  const live = opponents.filter(o => !o.eliminated);
  if (live.length === 0) return null;
  // §3.10 — bleed the armed player first, and when two are armed pick the one further along.
  const armed = live.filter(o => o.finalApproach);
  if (armed.length > 0) {
    return armed.reduce((best, p) => (G.completedSets(p) > G.completedSets(best) ? p : best));
  }
  // The chaotic seats still roll for a victim — but among players who can PAY, so a wild rent
  // never lands on someone with nothing while a solvent opponent sits there. Random target,
  // not random-including-the-broke-one, is the character; firing at a pauper is just waste.
  if (mode === 'chud' || mode === 'random') {
    const pool = live.filter(canPay);
    return pool.length > 0 ? pool[Math.floor(rnd() * pool.length)] : null;
  }
  // Hit whoever the charge actually hurts most, with the leader worth two millions a set —
  // so a rent goes to the player in front unless they are too broke to feel it. §3.10f adds
  // the cushion term on top: against a player one set from winning, what counts is not what
  // we collect but how much of the slack between them and a broken set we take away.
  const press = CUSHION_PRESSURE[mode] ?? 0;
  const score = (p) => {
    const take = collectableFrom(p, face);
    let v = take + 2 * G.completedSets(p);
    if (press > 0 && take > 0 && preArmedLeader(state, p)) {
      const cushion = Math.max(1, disposableValue(p));
      v += press * CUSHION_GAIN * Math.min(1, take / cushion);
    }
    return v;
  };
  return live.reduce((best, p) => (score(p) > score(best) ? p : best));
}

// §3.1c — Surge Ops applies to RENT ONLY, and it STACKS. This is the multiplier a rent
// played right now would be charged at.
function surgeMultiplier(state) { return 2 ** (state?._surgeOps || 0); }

// What a rent card is worth THIS INSTANT, in millions actually collected.
//
// The old ranking compared `calcRent` across cards and took the biggest number, which is the
// wrong comparison in two ways at once. A COLOUR rent hits every opponent (only §3.2's wild
// "any" rent names a single victim), so a 2M charge on a colour collects 6M at a four-handed
// table while a 4M wild rent collects 4M — and either is capped by what the victims own.
// Measured before this: conservative captured 91.7% of the millions its own hand could have
// collected and neutral 96.4%, the whole gap being wild-versus-colour and target choice.
function rentYield(state, bot, card, color, opponents, mode) {
  const face = G.calcRent(bot, color) * surgeMultiplier(state);
  if (face <= 0 || opponents.length === 0) return { face, value: 0, target: null };
  if (isWildRent(card)) {
    const target = chooseRentTarget(state, opponents, mode, face);
    return { face, value: target ? collectableFrom(target, face) : 0, target };
  }
  let total = 0;
  for (const o of opponents) total += collectableFrom(o, face);
  return { face, value: total, target: null };
}

function makeRentPlay(state, bot, hand, cardIndex, color, opponents, mode) {
  const card = hand[cardIndex];
  if (!card || !color) return null;
  // Never fire a charge that collects nothing (owner report). rentYield caps by what the
  // victims actually own, so a 0 here means the table — or, for a wild rent, every payable
  // target — has nothing to give. The chaotic seats hit this gate too: it removes waste
  // without touching their random colour/victim choice among payers.
  const { value, target } = rentYield(state, bot, card, color, opponents, mode);
  if (value <= 0) return null;
  const play = { type: 'play_action', cardIndex, targetColor: color };
  if (isWildRent(card)) {
    if (!target) return null;
    play.targetId = target.id;
  }
  return play;
}

// `minRent` still gates on the card's FACE value — that is the "is this rent worth a play
// at all" question every personality tunes — but the choice between cards that clear the
// gate is made on what they actually collect.
function findBestRent(state, bot, hand, minRent, opponents, mode) {
  let bestRent = null;
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type !== 'rent') continue;
    const color = chooseBestRentColor(bot, c);
    if (!color) continue;
    if (G.calcRent(bot, color) < minRent) continue;
    const { value } = rentYield(state, bot, c, color, opponents, mode);
    if (value <= 0) continue;   // a rent that collects nothing is never worth a play
    if (!bestRent || value > bestRent.value) bestRent = { cardIndex: i, color, value };
  }
  if (!bestRent) return null;
  return makeRentPlay(state, bot, hand, bestRent.cardIndex, bestRent.color, opponents, mode);
}

function chooseBestRentColor(bot, card) {
  const validColors = card.colors[0] === 'any'
    ? Object.keys(bot.properties).filter(c => (bot.properties[c] || []).length > 0)
    : card.colors.filter(c => (bot.properties[c] || []).length > 0);
  if (validColors.length === 0) return null;
  return validColors.reduce((best, col) =>
    G.calcRent(bot, col) > G.calcRent(bot, best) ? col : best);
}

function randomRentColor(bot, card) {
  const validColors = card.colors[0] === 'any'
    ? Object.keys(bot.properties).filter(c => (bot.properties[c] || []).length > 0)
    : card.colors.filter(c => (bot.properties[c] || []).length > 0);
  return validColors.length > 0 ? validColors[Math.floor(rnd() * validColors.length)] : null;
}

// The BEST rent on a complete set, not the first one the hand happens to hold.
/* ── Play ordering: boosters before the charge they raise ──────────────
 *
 * Owner report (2026-08-07, round 8): "right now they will do things like charge rent and
 * then add houses/upgrades — they should play their cards in the correct order."
 *
 * The structural cause: decideBotPlay() returns ONE play at a time and the caller
 * re-enters, so there is no turn plan in which "the House goes before the rent" could be
 * expressed — each call independently scores the best single play, and if the rent scores
 * higher on this call it goes first. The ordering was an accident of scoring.
 *
 * Measured over 400 four-player games before the fix: a rent was followed in the SAME turn
 * by an upgrade/FOC on the charged colour, or by a property into the charged colour, on
 * 1.1–4.0% of rents — 0.08–0.51M forfeited per bot per game. Small next to the overpay
 * round (7.6–8.8M), and the fix is priced accordingly: a dependency pass, not a turn
 * planner. A full planner would replace scoring logic that is measured and working, for a
 * half-million per game; rejected.
 *
 * The rule: when the planner has chosen a rent and the hand holds a play that RAISES that
 * rent — an Upgrade/FOC on the charged colour (+3/+4 on every payer), or a property that
 * climbs the colour's rent ladder — and a play remains to fire the rent afterwards, the
 * booster goes first. This runs at the chokepoint AFTER the personality plan, so it cannot
 * change WHAT a personality decided to do, only the order it does it in — whether a bot
 * builds before it charges is personality; playing both backwards is nobody's strategy.
 * The §3.10 break branch returns before this pass and is deliberately not subject to it:
 * its charges are sized against disposableValue by logic that is separately measured.
 *
 * Wilds are only redirected here when the rent colour is where chooseBestColorForWild()
 * would have sent them anyway — a wild destined to complete a different set must not be
 * pulled onto the rent pile for a one-off ladder step.
 *
 * Termination: each booster leaves the hand when played, and the pass requires
 * playsRemaining >= 2, so it can fire at most twice per turn ahead of a final rent.
 */
// §3.12 humanlike: 1. The one sequencing pass humans run MORE than bots is steal -> rent on
// the newly-taken colour (human 22% of steals, N=206; aggressive 13%, neutral 8%), and that
// pass is §3.10d, reached through this table.
const ORDER_ATTENTION = { conservative: 1, neutral: 1, aggressive: 1, chud: 0.3, random: 0.12, humanlike: 1 };

// A play from this hand that would COMPLETE a set right now. Used by the ordering pass:
// the owner's round-9 report — "if bots are going to finish a set that turn, have them
// finish the set before they play any rent cards" — names the CROSS-colour case, which is
// worth zero millions (verified: OPSEC responses never consume plays, completing our set
// changes nothing about how a payer answers, and armedAtTurn is the turnCounter, identical
// at play 1 and play 3 of the same turn) but is the order a human expects to see. A wild is
// allowed onto any colour it completes — finishing a set is never a bad wild placement.
function findCompletingPlay(bot, hand, held) {
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (held && held.length && held.includes(c.id)) continue;   // §3.10j
    if (c.type !== 'property' && c.type !== 'wild_property') continue;
    for (const color of G.legalColorsFor(c)) {
      if (!G.COLORS[color] || G.zoneFull(bot, color)) continue;
      const zone = bot.properties[color] || (bot.properties[color] = []);
      zone.push(c);
      const completes = G.isSetComplete(bot, color);
      zone.pop();
      if (!completes) continue;
      return c.type === 'property'
        ? { type: 'play_property', cardIndex: i }
        : { type: 'play_property', cardIndex: i, targetColor: color };
    }
  }
  return null;
}

function findChargeBooster(state, bot, hand, rentPlay) {
  const color = rentPlay.targetColor;
  if (!color || !G.COLORS[color]) return null;
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.action === 'upgrade' && G.isSetComplete(bot, color)
        && !G.upgradeKinds(bot, color).includes('house')) {
      return { type: 'play_action', cardIndex: i, targetColor: color };
    }
    if (c.action === 'foc' && G.isSetComplete(bot, color)
        && G.upgradeKinds(bot, color).includes('house')
        && !G.upgradeKinds(bot, color).includes('hotel')) {
      return { type: 'play_action', cardIndex: i, targetColor: color };
    }
  }
  if (!G.zoneFull(bot, color)) {
    for (let i = 0; i < hand.length; i++) {
      const c = hand[i];
      if (c.type === 'property' && c.color === color) {
        return { type: 'play_property', cardIndex: i };
      }
      if (c.type === 'wild_property' && G.legalColorsFor(c).includes(color)
          && chooseBestColorForWild(bot, c) === color) {
        return { type: 'play_property', cardIndex: i, targetColor: color };
      }
    }
  }
  return null;
}

// §3.10d STEAL -> RENT (round 12). findChargeBooster above is round 8's dependency pass: the
// planner picked a rent, and anything in HAND that raises that exact rent goes first. It never
// considered a STEAL as a booster, and a steal that completes the charged colour is the
// largest single-turn swing in the deck — a 3M rent becomes an 8M rent on a finished set.
//
// Three engine preconditions are re-checked here so the play can never be refused (a refused
// play burns the turn — see the planRearrange note above):
//   1. Midnight Requisition may not take out of a complete set (§3.1, Hasbro FAQ 926).
//   2. Our destination zone must have room, or receiveProperty banks the card instead.
//   3. The card must ALREADY sit in the charged colour. game.js resolves a steal through
//      `receiveProperty(..., card.placedColor || card.color || col)`, so a green/darkblue
//      wild parked in their GREEN zone lands in OUR green zone — it raises the darkblue rent
//      by exactly nothing. This is the one that is easy to miss.
//
// Prefers Midnight Requisition over THE CHUD CARD whenever both reach the card: spending the
// strongest card in the deck on a job a 3M action does is the mistake §3.10c exists to stop.
function findStealBooster(state, bot, botId, hand, rentPlay, allowBreaker) {
  const color = rentPlay.targetColor;
  if (!color || !G.COLORS[color]) return null;
  const zone = bot.properties[color];
  if (!zone || zone.length === 0) return null;
  if (G.isSetComplete(bot, color)) return null;   // the ladder is already at the top
  if (G.zoneFull(bot, color)) return null;

  const mrIdx = hand.findIndex(c => c.action === 'midnight_requisition');
  const chudIdx = hand.findIndex(c => c.action === 'chud');
  if (mrIdx < 0 && chudIdx < 0) return null;

  const rank = (c) => (c.requisitionable && mrIdx >= 0 ? 1000 : 0) + 10 * c.sets + c.value;
  let best = null;
  for (const opp of state.players) {
    if (opp.id === botId || opp.eliminated) continue;
    for (const [col, cards] of Object.entries(opp.properties)) {
      for (const c of cards) {
        if ((c.placedColor || c.color) !== color) continue;
        const was = c.placedColor;
        zone.push(c); c.placedColor = color;
        const completes = G.isSetComplete(bot, color);
        zone.pop(); c.placedColor = was;
        if (!completes) continue;
        const cand = {
          oppId: opp.id, cardId: c.id, value: c.value,
          sets: G.completedSets(opp),
          requisitionable: G.zoneRequisitionable(opp, col),
        };
        if (!best || rank(cand) > rank(best)) best = cand;
      }
    }
  }
  if (!best) return null;

  if (best.requisitionable && mrIdx >= 0) {
    return { type: 'play_action', cardIndex: mrIdx, targetId: best.oppId, targetCardId: best.cardId };
  }
  if (chudIdx < 0) return null;
  const shot = { type: 'play_action', cardIndex: chudIdx, targetId: best.oppId, targetCardId: best.cardId };
  return (typeof allowBreaker === 'function' && !allowBreaker(shot)) ? null : shot;
}

function findRentOnCompleteSet(state, bot, hand, opponents, mode) {
  let best = null;
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.type !== 'rent') continue;
    const validColors = c.colors[0] === 'any' ? Object.keys(bot.properties) : c.colors;
    for (const color of validColors) {
      if (!G.isSetComplete(bot, color)) continue;
      const { value } = rentYield(state, bot, c, color, opponents, mode);
      if (value <= 0) continue;   // a complete-set rent still needs a payer at the table
      if (!best || value > best.value) best = { i, color, value };
    }
  }
  if (!best) return null;
  return makeRentPlay(state, bot, hand, best.i, best.color, opponents, mode);
}

// Surge Ops is only worth a play if a RENT can follow it this turn.
//
// §3.1c: Surge follows Double The Rent — it applies to rent ONLY, never Finance Office and
// never Roll Call, and `game.js` proves it, because those two call `chargeAmount()` with no
// `surgeable` flag and their multiplier is always 1. This function used to answer yes to
// either of them, so all three planning modes routinely spent a play arming a multiplier
// that could not fire. Round 5 fixed exactly this inside `tryBreakFinalApproach()` and left
// the personality planners — which is where nearly all the Surges are played — still wrong.
// Measured over 400 four-player games before the fix: 39% of neutral's and aggressive's
// Surges expired unused, 64% of conservative's, and 77-85% of the chaotic two's.
function hasChargeFollowUp(bot, hand, opponents) {
  if (opponents.length === 0) return false;
  // Doubling a charge nobody can pay is still nothing — do not spend a play arming a Surge
  // over a broke table (part of the same wasted-charge defect as makeRentPlay's gate).
  if (!anyoneCanPay(opponents)) return false;
  for (const c of hand) {
    if (c.type === 'rent' && chooseBestRentColor(bot, c)) return true;
  }
  return false;
}

/* ── Inspector General targets ──────────────────────────────────────── */

function findBestIGTarget(opponents) {
  let best = null;
  let bestValue = -1;
  for (const opp of opponents) {
    for (const [color, cards] of Object.entries(opp.properties)) {
      if (!G.isSetComplete(opp, color)) continue;
      const value = cards.reduce((s, c) => s + c.value, 0);
      if (value > bestValue) { bestValue = value; best = { id: opp.id, color }; }
    }
  }
  return best;
}

function findRandomIGTarget(opponents) {
  const targets = [];
  for (const opp of opponents) {
    for (const [color] of Object.entries(opp.properties)) {
      if (G.isSetComplete(opp, color)) targets.push({ id: opp.id, color });
    }
  }
  return targets.length > 0 ? targets[Math.floor(rnd() * targets.length)] : null;
}

function findCheapestIGTarget(opponents) {
  let worst = null;
  let worstValue = Infinity;
  for (const opp of opponents) {
    for (const [color, cards] of Object.entries(opp.properties)) {
      if (!G.isSetComplete(opp, color)) continue;
      const value = cards.reduce((s, c) => s + c.value, 0);
      if (value < worstValue) { worstValue = value; worst = { id: opp.id, color }; }
    }
  }
  return worst;
}

/* ── CHUD / steal targets ───────────────────────────────────────────── */

// A steal that would COMPLETE one of our sets outright (we sit at size-1 and an opponent
// holds a card of that colour, wilds included). The one CHUD target that is always worth
// the card — used by the guaranteed-shot branch, which must not burn a CHUD on an orphan
// just because nobody can block it.
function findChudCompletionTarget(bot, opponents) {
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have !== info.size - 1) continue;
    // Round 11, angle 4: when several cards complete the same zone, take the best one from
    // the player in front — not whichever card happens to sit at index 0. This used to
    // return cards[0], which is a 0M rainbow wild as often as not; it was invisible because
    // only the guaranteed-shot branch called it, and §3.10c now routes every CHUD here.
    const candidates = [];
    for (const opp of opponents) {
      for (const c of (opp.properties[color] || [])) {
        candidates.push({ playerId: opp.id, cardId: c.id, value: c.value, sets: G.completedSets(opp) });
      }
    }
    if (candidates.length > 0) return pickStealCandidate(candidates);
  }
  return null;
}

// Round 11, angle 4 — when several opponents offer the SAME steal, take it from the
// player in front, and take the best card in the zone, not cards[0]. The colour choice
// (what advances our board) is unchanged; only the victim and the copy sharpen. Measured
// before: 22/29/46 steals per 400 games (conservative/neutral/aggressive) took the colour
// from a non-leader while the leader offered it legally — the steal-order was seat order.
function pickStealCandidate(candidates) {
  return candidates.reduce((a, b) => {
    if (b.sets !== a.sets) return b.sets > a.sets ? b : a;
    return b.value > a.value ? b : a;
  });
}

// The "advance one of our colours" steal, shared by the smart/aggressive CHUD finders.
// `skipCompleteZones` is the Midnight Requisition rule (§3.1 bars it from complete sets);
// CHUD reaches anywhere.
function findBuildingSteal(bot, opponents, skipCompleteZones) {
  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have === 0 || have >= info.size) continue;
    const candidates = [];
    for (const opp of opponents) {
      if (skipCompleteZones && G.isSetComplete(opp, color)) continue;
      for (const c of (opp.properties[color] || [])) {
        candidates.push({ playerId: opp.id, cardId: c.id, value: c.value, sets: G.completedSets(opp) });
      }
    }
    if (candidates.length > 0) return pickStealCandidate(candidates);
  }
  return null;
}

function findSmartChudTarget(bot, opponents) {
  // First: property that advances one of our colours — from the leader when tied
  const building = findBuildingSteal(bot, opponents, false);
  if (building) return building;
  // Fallback: highest value property from leader
  const leader = findLeader(opponents);
  if (!leader) return null;
  let best = null;
  for (const cards of Object.values(leader.properties)) {
    for (const c of cards) {
      if (!best || c.value > best.value) best = { playerId: leader.id, cardId: c.id, value: c.value };
    }
  }
  return best;
}

function findAggressiveChudTarget(state, bot, botId, opponents) {
  // Target what helps us most, then target leader's best
  const building = findBuildingSteal(bot, opponents, false);
  if (building) return building;
  const leader = findLeader(opponents);
  if (!leader) return null;
  let best = null;
  for (const cards of Object.values(leader.properties)) {
    for (const c of cards) {
      if (!best || c.value > best.value) best = { playerId: leader.id, cardId: c.id, value: c.value };
    }
  }
  return best;
}

function findChudChudTarget(opponents) {
  // Chaotic: pick random player, random property
  const all = [];
  for (const opp of opponents) {
    for (const cards of Object.values(opp.properties)) {
      for (const c of cards) all.push({ playerId: opp.id, cardId: c.id });
    }
  }
  return all.length > 0 ? all[Math.floor(rnd() * all.length)] : null;
}

function findRandomChudTarget(opponents) {
  const all = [];
  for (const opp of opponents) {
    for (const cards of Object.values(opp.properties)) {
      for (const c of cards) all.push({ playerId: opp.id, cardId: c.id });
    }
  }
  return all.length > 0 ? all[Math.floor(rnd() * all.length)] : null;
}

/* ── Steal targets (Midnight Requisition) ───────────────────────────── */

function findSmartStealTarget(bot, opponents) {
  // Prefer cards that advance our sets — from the player in front when several offer one
  const building = findBuildingSteal(bot, opponents, true);
  if (building) return building;
  // Fallback: most valuable stealable property
  let best = null;
  for (const opp of opponents) {
    for (const [col, cards] of Object.entries(opp.properties)) {
      if (G.isSetComplete(opp, col)) continue;
      for (const c of cards) {
        if (!best || c.value > best.value) best = { playerId: opp.id, cardId: c.id, value: c.value };
      }
    }
  }
  return best;
}

function findCheapestStealTarget(opponents) {
  let cheapest = null;
  for (const opp of opponents) {
    for (const [col, cards] of Object.entries(opp.properties)) {
      if (G.isSetComplete(opp, col)) continue;
      for (const c of cards) {
        if (!cheapest || c.value < cheapest.value) cheapest = { playerId: opp.id, cardId: c.id, value: c.value };
      }
    }
  }
  return cheapest;
}

function findRandomStealTarget(opponents) {
  const all = [];
  for (const opp of opponents) {
    for (const [col, cards] of Object.entries(opp.properties)) {
      if (G.isSetComplete(opp, col)) continue;
      for (const c of cards) all.push({ playerId: opp.id, cardId: c.id });
    }
  }
  return all.length > 0 ? all[Math.floor(rnd() * all.length)] : null;
}

/* ── Swap targets (TDY Orders) ──────────────────────────────────────── */

// §3.1 (reversed 2026-08-06, Hasbro FAQ 926) — TDY Orders may not take a card OUT of a
// complete set nor give one out of yours. Every swap finder filters both sides through
// this; without it the bot proposes a move playAction() refuses and burns its turn.
function swappableCards(player) {
  const out = [];
  for (const [color, cards] of Object.entries(player.properties || {})) {
    if (!G.zoneRequisitionable(player, color)) continue;
    for (const card of cards) out.push({ color, card });
  }
  return out;
}

function findSmartSwapTarget(bot, opponents) {
  let myWorst = null;
  for (const { color: col, card: c } of swappableCards(bot)) {
    if ((bot.properties[col] || []).length !== 1) continue;
    if (!myWorst || c.value < myWorst.value) myWorst = { cardId: c.id, value: c.value, color: col };
  }
  if (!myWorst) return null;

  for (const [color, info] of Object.entries(G.COLORS)) {
    const have = (bot.properties[color] || []).length;
    if (have > 0 && have < info.size && color !== myWorst.color) {
      for (const opp of opponents) {
        if (!G.zoneRequisitionable(opp, color)) continue;
        for (const c of (opp.properties[color] || [])) {
          return { targetPlayerId: opp.id, targetCardId: c.id, myCardId: myWorst.cardId };
        }
      }
    }
  }
  return null;
}

function findAggressiveSwapTarget(bot, opponents) {
  let myWorst = null;
  for (const { card: c } of swappableCards(bot)) {
    if (!myWorst || c.value < myWorst.value) myWorst = { cardId: c.id, value: c.value };
  }
  if (!myWorst) return null;

  let theirBest = null;
  for (const opp of opponents) {
    for (const { card: c } of swappableCards(opp)) {
      if (c.value > myWorst.value && (!theirBest || c.value > theirBest.value)) {
        theirBest = { targetPlayerId: opp.id, targetCardId: c.id, myCardId: myWorst.cardId, value: c.value };
      }
    }
  }
  return theirBest;
}

function findRandomSwapTarget(bot, opponents) {
  const myCards = swappableCards(bot).map(e => e.card.id);
  if (myCards.length === 0) return null;

  const theirCards = [];
  for (const opp of opponents) {
    for (const { card: c } of swappableCards(opp)) theirCards.push({ playerId: opp.id, cardId: c.id });
  }
  if (theirCards.length === 0) return null;

  const my = myCards[Math.floor(rnd() * myCards.length)];
  const their = theirCards[Math.floor(rnd() * theirCards.length)];
  return { targetPlayerId: their.playerId, targetCardId: their.cardId, myCardId: my };
}

/* ── Upgrade helpers ────────────────────────────────────────────────── */

function findUpgradeableSet(bot, type) {
  for (const [color] of Object.entries(bot.properties)) {
    if (!G.isSetComplete(bot, color)) continue;
    const ups = G.upgradeKinds(bot, color);
    if (type === 'upgrade' && !ups.includes('house')) return color;
    if (type === 'foc' && ups.includes('house') && !ups.includes('hotel')) return color;
  }
  return null;
}

/* ── Payment selection ──────────────────────────────────────────────── */

// Bank first, then upgrades, then properties: a House costs rent, a property can cost a set.
const PAY_RANK = { bank: 0, upgrade: 1, prop: 2 };
const bySource = (a, b) => PAY_RANK[a.source] - PAY_RANK[b.source];

function selectPaymentCards(bot, amount, mode) {
  const cards = [];
  bot.bank.forEach(c => cards.push({ id: c.id, value: c.value, source: 'bank' }));
  for (const [color, propCards] of Object.entries(bot.properties)) {
    const setProgress = (propCards.length || 0) / (G.COLORS[color]?.size || 99);
    propCards.forEach(c => cards.push({ id: c.id, value: c.value, source: 'prop', color, setProgress }));
  }
  // §3.1b — upgrades are payable. Spent after the bank but before properties: handing over
  // a House costs rent, handing over a property can cost a whole set.
  for (const [color, ups] of Object.entries(bot.upgrades || {})) {
    for (const u of ups) {
      if (u && typeof u === 'object') cards.push({ id: u.id, value: u.value, source: 'upgrade', color });
    }
  }
  if (cards.length === 0) return [];

  switch (mode) {
    case 'chud':
      // Chaotic order, but the bank goes first — feeding properties to the table while
      // sitting on cash was worth ~3 points of chud winrate.
      shuffle(cards);
      cards.sort(bySource);
      break;

    case 'conservative':
      // Bank first (smallest), protect near-complete sets
      cards.sort((a, b) => {
        if (a.source !== b.source) return bySource(a, b);
        if (a.source === 'prop') return (a.setProgress || 0) - (b.setProgress || 0);
        return a.value - b.value;
      });
      break;

    case 'aggressive':
      // Bank first, then isolated properties, protect near-complete sets
      cards.sort((a, b) => {
        if (a.source === 'bank' && b.source === 'prop') return -1;
        if (a.source === 'prop' && b.source === 'bank') return 1;
        if (a.source === 'prop' && b.source === 'prop') return (a.setProgress || 0) - (b.setProgress || 0);
        return a.value - b.value;
      });
      break;

    case 'random':
      // Random order *within* each pool, but cash before property: paying with random
      // properties while holding cash cost random ~2 points of winrate (4.5% → 6.6%).
      shuffle(cards);
      cards.sort(bySource);
      break;

    // §3.12 — humanlike deliberately has NO case of its own and lands here, and the reason is
    // worth writing down because it looks like an omission. Real players surrendered property
    // on 28.3% of their payments against neutral's 50.6%, but the whole of that gap is that
    // they HAD cash when the demand landed (HUMAN_BANK_FLOOR), not that they chose different
    // cards once it had. And measured: since round 9's minimal-cover rewrite this sort is very
    // nearly inert — `payWeight`'s tier gaps are wider than the largest card in the deck, so
    // four of the five comparators return identical selections at every amount, and only
    // random's shuffle ever breaks a tie differently. A sixth copy of this comparator would be
    // code no test could pin.
    default: // neutral, and humanlike
      cards.sort((a, b) => {
        if (a.source !== b.source) return bySource(a, b);
        if (a.source === 'prop') return (a.setProgress || 0) - (b.setProgress || 0);
        return a.value - b.value;
      });
      break;
  }

  // §3.10 — never volunteer a card out of a completed set while armed; it disarms us.
  if (bot.finalApproach) {
    const complete = new Set(completeSetCards(bot).map(entry => entry.card.id));
    cards.sort((a, b) => (complete.has(a.id) ? 1 : 0) - (complete.has(b.id) ? 1 : 0));
  }

  return minimalCover(cards, amount);
}

/* ── Minimal-overpay cover ──────────────────────────────────────────────
 *
 * selectPaymentCards() used to close with a greedy walk in sorted order that stopped the
 * moment it had ENOUGH and never asked whether a different combination got CLOSER. A bank
 * of [1, 10] paying a 5M charge took the 1 (total 1 < 5), then the 10 (total 11 >= 5), and
 * handed over 11M for a 5M debt.
 *
 * Measured at HEAD over 400 four-player games, on every payment the payer could actually
 * afford: every personality handed over 28-32% more than it owed — 7.6-8.8M per bot per
 * game — and 56-61% of all solvent payments overpaid at all. That is the owner's report
 * ("bots just pay or give way extra") as a number.
 *
 * THE ORDER ABOVE IS NOT OVERRIDDEN — it is re-expressed as a cost, so the search runs
 * INSIDE it instead of over it. Every card carries a weight: bank 0, upgrade 1, property
 * 4 + how complete its set is. The weights are separated by more than the largest card in
 * the deck (10M), so no amount of overpay saving can ever promote a worse tier: a property
 * is spent only when the bank and the upgrades genuinely cannot cover the debt, exactly as
 * the sort already decided. That ordering is measured, not arbitrary (a House costs rent, a
 * property can cost a set; getting it wrong cost chud ~3 points and random ~2), and §3.10's
 * rule that an armed bot never volunteers a card out of a completed set survives as the
 * heaviest weight of all.
 *
 * What the search actually buys, in order: the cheapest TIER MIX first, then the smallest
 * overpay reachable with that mix, then the fewest cards. So within the bank it makes exact
 * change instead of stopping at the first card that clears the bar, and when it does have to
 * reach for property it takes the fewest cards out of the least-complete sets rather than
 * whichever ones the walk happened to touch first.
 *
 * Zero-value cards are dropped from the search: they cannot move the total, so including one
 * is pure loss. §3.4 still makes them surrenderable — an insolvent payer hands over
 * everything through acceptAction()'s fallback, zero-value wilds included.
 *
 * COST: the pool is every payable card (rarely more than ~25) and the totals are small
 * integers capped at `amount + 10`, so this is a few hundred operations per payment. Timed
 * over a 10,000-game matrix it is inside run-to-run noise.
 */

// Tier weights. The gaps are wider than the largest card value in the deck, which is what
// makes the tier order lexicographic rather than merely preferred.
function payWeight(c) {
  if (c.source === 'bank') return 0;
  if (c.source === 'upgrade') return 1;
  return 4 + (c.setProgress || 0);   // property: near-complete sets cost more to break up
}

function minimalCover(cards, amount) {
  const pool = [];
  let poolTotal = 0;
  for (let i = 0; i < cards.length; i++) {
    poolTotal += cards[i].value;
    if (cards[i].value > 0) pool.push({ ...cards[i], rank: i, w: cards[i].weight ?? payWeight(cards[i]) });
  }
  // Insolvent — hand over everything and let the engine's "surrender every card you own"
  // branch (§3.4) take it, zero-value wilds included.
  if (poolTotal < amount || pool.length === 0) return cards.map(c => c.id);

  let maxVal = 0;
  for (const c of pool) if (c.value > maxVal) maxVal = c.value;
  const cap = amount + maxVal;

  // dp[t] = cheapest (weight, then card count) way to reach EXACTLY t. `layers` keeps one
  // snapshot per item so the winning selection can be walked back out.
  let dp = new Array(cap + 1).fill(null);
  dp[0] = { w: 0, count: 0, take: -1, from: 0 };
  const layers = [dp];
  for (let i = 0; i < pool.length; i++) {
    const v = pool[i].value;
    const next = dp.slice();
    for (let t = 0; t + v <= cap; t++) {
      const cur = dp[t];
      if (!cur) continue;
      const cand = { w: cur.w + pool[i].w, count: cur.count + 1, take: i, from: t };
      const old = next[t + v];
      if (!old || cand.w < old.w - 1e-9
        || (Math.abs(cand.w - old.w) < 1e-9 && cand.count < old.count)) next[t + v] = cand;
    }
    dp = next;
    layers.push(dp);
  }

  // Cheapest tier mix first, then the smallest overpay it can make, then the fewest cards.
  // Scanning t upward from `amount` makes the overpay tie-break implicit: the first total
  // that reaches a given weight is the least it can overshoot by at that weight.
  let best = -1;
  for (let t = amount; t <= cap; t++) {
    const n = dp[t];
    if (!n) continue;
    if (best < 0) { best = t; continue; }
    const b = dp[best];
    if (n.w < b.w - 1e-9) best = t;
  }
  if (best < 0) return cards.map(c => c.id);   // unreachable: poolTotal >= amount above

  const out = [];
  let layer = layers.length - 1, t = best;
  while (t > 0) {
    const node = layers[layer][t];
    if (!node || node.take < 0) break;
    out.push(pool[node.take].id);
    layer = node.take;
    t = node.from;
  }
  return out;
}

// Must mirror G.payableCards() exactly. §3.1b made upgrades payable, and the engine only
// accepts a short payment when EVERY payable card is surrendered — omitting the upgrades
// here made the "pay with everything" fallback fail forever (measured: 82k refusals and
// 7/400 games that never reached an ending).
function getAllPayableCardIds(bot) {
  return G.payableCards(bot).map(c => c.id);
}

/* ── Discard selection ──────────────────────────────────────────────── */

// THE CHUD CARD IS NEVER DISCARDED (owner directive, 2026-08-12).
//
// This is an absolute rule, not a sort weight, and the distinction is the whole point. The
// comparators below rank cards, so a hand with nothing cheap in it will still surrender its
// best card — and the card the escrow (§3.10c) is asking every planner to sit on is exactly
// the card most likely to be left holding the bag at the hand limit. A ranking says "discard
// this last"; the owner asked for "never", so the card is removed from the candidate pool
// before any personality's comparator sees it.
//
// It applies to EVERY personality including the chaotic two, whose discard is a `shuffle`.
// That does cost `chud` a sliver of its randomness, and it is worth it twice over: a mode
// named after the card should not be the one that throws it away, and a shuffle cannot be
// asked politely to spare something.
//
// The only escape is arithmetic. If the hand is so full of protected cards that the required
// number cannot be met without one, the protection yields rather than returning a short list
// — `endTurn` would refuse it and the turn would wedge. Protection is a preference over the
// rest of the hand, never a licence to break the hand limit.
function isNeverDiscarded(card) {
  return !!card && card.action === 'chud';
}

/* §3.10j THE DISCARD TIER — and it is an escrow-class bug that is live in every planner
 * comparator TODAY, sandbag or no sandbag. Verified by running them, with a brown zone one
 * short and a hand forced to choose between properties:
 *
 *   hand: brown/1M(completes) green/4M darkblue/4M yellow/3M red/3M green/4M darkblue/4M yellow/3M
 *   humanlike LOST THE COMPLETER · neutral LOST · conservative LOST · aggressive LOST
 *
 * Each leaks for its own reason. Neutral sorts OPSEC last, hard breakers next, then purely
 * `a.value - b.value` — and brown, lightblue and intel properties print 1M, so a completer is
 * the FIRST card out of the hand. Conservative and humanlike sort properties late as a GROUP
 * but fall through to face value between two of them, so the cheap completer goes before an
 * expensive orphan. Aggressive sorts `a.type === 'action'` after property, so a completer is
 * discarded ahead of any ordinary action card. Told to hold a card, a bot holds it to the hand
 * limit and then throws it away — the same trap that bit round 12's escrow twice.
 *
 * THE FIX IS A TIER, NOT POOL REMOVAL, and the distinction is deliberate. isNeverDiscarded
 * removes THE CHUD CARD from the candidate pool before any comparator sees it because the
 * owner said "never". A completer must not get that treatment: pool removal can make the
 * required count unmeetable, and a second protected class multiplies the ways the arithmetic
 * escape is reached. A tier can always yield. INVARIANT: chooseDiscards(...).length === excess,
 * always — endTurn refuses a short list and the turn wedges.
 *
 * TWO STRENGTHS, and only the weaker one is unconditional:
 *
 *   narrow (ALWAYS ON, for the four planner comparators)  — among PROPERTIES only, a card that
 *     finishes one of our zones ranks behind one that does not. Throwing away the card that
 *     finishes your own set to keep a property you do not need is wrong whether or not
 *     sandbagging ever ships, so it is not gated on the flag. It is confined to
 *     property-vs-property because that is the comparison where the bug is unambiguous and
 *     because it is the narrowest change that fixes it.
 *   absolute (behind SANDBAG_ENABLED) — the full tier from the spec: completer last of all,
 *     behind the shield, because the shield defends one card once and the completer is a third
 *     of the win condition. Gated on the FLAG rather than on sandbagHeld()'s per-turn output:
 *     if it were gated on the live hold, a card released mid-turn by the hand-limit valve would
 *     be unprotected at endTurn, which is precisely the hole that would let a bot hold a card
 *     for four turns and then throw it away.
 *
 * Both are gated OFF for chud and random (BREAKER_BAR null, SANDBAG weight 0), whose discard is
 * a `shuffle` — a shuffle cannot be asked politely to spare something, and their byte-identical
 * streams are what keeps paired-seed comparison alive.
 *
 * Applied OUTSIDE the switch, so a personality added later cannot miss it. Array.prototype.sort
 * has been stable since ES2019, and the narrow pass reorders only the property SUBSEQUENCE in
 * place, so every non-property slot keeps the position its comparator gave it.
 */
function applyCompleterTier(bot, hand, mode) {
  const absolute = SANDBAG_ENABLED && (SANDBAG[mode] ?? 0) > 0;
  if (absolute) {
    hand.sort((a, b) => (completesASet(bot, a) ? 1 : 0) - (completesASet(bot, b) ? 1 : 0));
    return;
  }
  if (!BREAKER_BAR[mode]) return;                 // chud and random keep a pure shuffle
  const at = [];
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c && (c.type === 'property' || c.type === 'wild_property')) at.push(i);
  }
  if (at.length < 2) return;
  const props = at.map(i => hand[i]);
  const ordered = props.filter(c => !completesASet(bot, c))
    .concat(props.filter(c => completesASet(bot, c)));
  at.forEach((idx, k) => { hand[idx] = ordered[k]; });
}

function chooseDiscards(bot, excess, mode) {
  mode = personaOf(mode);
  const protectedCards = bot.hand.filter(isNeverDiscarded);
  const pool = bot.hand.filter(c => !isNeverDiscarded(c));
  // Enough ordinary cards to cover the excess: the CHUD never enters the running.
  const hand = pool.length >= excess ? [...pool] : [...bot.hand];
  // ...and when it is not enough, the protected cards go LAST, so the ordinary cards are
  // still spent first and only the overflow reaches a CHUD.
  if (pool.length < excess) {
    hand.length = 0;
    hand.push(...pool, ...protectedCards);
    return hand.slice(0, excess).map(c => c.id);
  }

  switch (mode) {
    case 'chud':
      // Discard randomly — true chaos
      shuffle(hand);
      break;

    case 'conservative':
      // Keep OPSEC, properties, rent. Discard offensive actions and low-value stuff.
      //
      // §3.10c: the two HARD breakers are pulled out of the "offensive actions" group and
      // sorted to the very back, behind everything except OPSEC. Without this the escrow
      // makes conservative WORSE, not better: told to hold an Inspector General, it held it
      // to the hand limit and then threw it away ahead of a 1M — the comparator below listed
      // `inspector_general` and `chud` first among the offensive actions, so they were the
      // first cards out of the hand.
      hand.sort((a, b) => {
        if (a.action === 'opsec') return 1;
        if (b.action === 'opsec') return -1;
        if (isHardBreaker(a) && !isHardBreaker(b)) return 1;
        if (isHardBreaker(b) && !isHardBreaker(a)) return -1;
        if ((a.type === 'property' || a.type === 'wild_property') &&
            b.type !== 'property' && b.type !== 'wild_property') return 1;
        if ((b.type === 'property' || b.type === 'wild_property') &&
            a.type !== 'property' && a.type !== 'wild_property') return -1;
        const offA = ['midnight_requisition','tdy_orders'].includes(a.action);
        const offB = ['midnight_requisition','tdy_orders'].includes(b.action);
        if (offA && !offB) return -1;
        if (offB && !offA) return 1;
        return a.value - b.value;
      });
      break;

    case 'aggressive':
      // Keep action cards and properties, discard money and low-value stuff. §3.10c: hard
      // breakers last of all — aggressive's comparator ranks purely by value below, so a 4M
      // CHUD went out ahead of a 5M money card on the turn it was being saved for.
      hand.sort((a, b) => {
        // §3.10c — OPSEC last of all. Aggressive ranked two action cards by face value, so on
        // the exact turn it armed it threw a 4M OPSEC to keep a 5M Inspector General: it
        // discarded the shield and kept the sword one turn before the whole table shot at it.
        if (a.action === 'opsec') return 1;
        if (b.action === 'opsec') return -1;
        if (isHardBreaker(a) && !isHardBreaker(b)) return 1;
        if (isHardBreaker(b) && !isHardBreaker(a)) return -1;
        if (a.type === 'money' && b.type !== 'money') return -1;
        if (b.type === 'money' && a.type !== 'money') return 1;
        if (a.type === 'action' && b.type !== 'action') return 1;
        if (b.type === 'action' && a.type !== 'action') return -1;
        return a.value - b.value;
      });
      break;

    case 'random':
      shuffle(hand);
      break;

    // §3.12 — a real player reaches the hand limit far less often than a bot (2.6% of turns
    // end over it against conservative's 7.7%), because they bank their money instead of
    // carrying it. When they do get there the order follows what the corpus shows them
    // protecting: the shield (held a median of 11 table-turns before firing, against 3 for a
    // bot), then the breakers, then PROPERTY — which for this personality is not incidental,
    // it is the sandbag: a card held back on purpose must not be thrown away by the same turn
    // loop that is holding it. That last clause is the trap round 12 hit with the escrow, in
    // mirror image, and it is why this case cannot just borrow neutral's comparator.
    case 'humanlike':
      hand.sort((a, b) => {
        if (a.action === 'opsec') return 1;
        if (b.action === 'opsec') return -1;
        if (isHardBreaker(a) !== isHardBreaker(b)) return isHardBreaker(a) ? 1 : -1;
        const pa = a.type === 'property' || a.type === 'wild_property';
        const pb = b.type === 'property' || b.type === 'wild_property';
        if (pa !== pb) return pa ? 1 : -1;
        return a.value - b.value;
      });
      break;

    default: // neutral
      // §3.10c: breakers behind OPSEC but ahead of everything else. Neutral sorted purely by
      // face value, so a 10M money card outranked the 5M Inspector General it was escrowing.
      hand.sort((a, b) => {
        if (a.action === 'opsec') return 1;
        if (b.action === 'opsec') return -1;
        if (isHardBreaker(a) && !isHardBreaker(b)) return 1;
        if (isHardBreaker(b) && !isHardBreaker(a)) return -1;
        return a.value - b.value;
      });
      break;
  }

  applyCompleterTier(bot, hand, mode);

  return hand.slice(0, excess).map(c => c.id);
}

/* ── Utility ────────────────────────────────────────────────────────── */

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── setTuning — the inert parameter-override hook (setSandbag's mold) ──────────────────
 *
 * Exists so tools/replayeval can price a CONSTANT change at production decision points
 * without a live code change. Defaults are the shipped values; setTuning(null) restores
 * them exactly; nothing in the live server ever calls this. The hook covers the
 * personality TABLES (mutated in place — their declarations are untouched) plus the two
 * scalars whose declarations moved const->let above. It deliberately does NOT cover the
 * shield-economy switch in shouldPlayOpsecDecision or the inline "rent >= 4"-style
 * charge-timing bars: those are branch literals, and hooking them would mean rewriting
 * live decision code — the one thing an inert hook must not do.
 */
const TUNING_TABLES = {
  BREAK_URGENCY, BREAK_OVERPAY, BREAKER_BAR, CARD_AWARENESS, BAIT_PATIENCE,
  ARMED_BANK_BIAS, ORDER_ATTENTION, CUSHION_PRESSURE, HOLDBACK, REARRANGE_BIAS,
};
const TUNING_TABLE_DEFAULTS = JSON.parse(JSON.stringify(TUNING_TABLES));
const TUNING_SCALAR_DEFAULTS = { CUSHION_GAIN, BREAKER_SELF_MARGIN };

function setTuning(opts) {
  if (!opts) {
    for (const [name, table] of Object.entries(TUNING_TABLES)) {
      for (const k of Object.keys(table)) delete table[k];
      Object.assign(table, JSON.parse(JSON.stringify(TUNING_TABLE_DEFAULTS[name])));
    }
    CUSHION_GAIN = TUNING_SCALAR_DEFAULTS.CUSHION_GAIN;
    BREAKER_SELF_MARGIN = TUNING_SCALAR_DEFAULTS.BREAKER_SELF_MARGIN;
    return;
  }
  for (const [name, perPersona] of Object.entries(opts.tables || {})) {
    const table = TUNING_TABLES[name];
    if (!table) throw new Error('setTuning: unknown table ' + name);
    for (const [persona, value] of Object.entries(perPersona)) {
      table[persona] = (value && typeof value === 'object' && table[persona]
        && typeof table[persona] === 'object')
        ? { ...table[persona], ...value }
        : value;
    }
  }
  if (opts.CUSHION_GAIN !== undefined) CUSHION_GAIN = opts.CUSHION_GAIN;
  if (opts.BREAKER_SELF_MARGIN !== undefined) BREAKER_SELF_MARGIN = opts.BREAKER_SELF_MARGIN;
}

function tuningConfig() {
  return {
    tables: JSON.parse(JSON.stringify(TUNING_TABLES)),
    CUSHION_GAIN, BREAKER_SELF_MARGIN,
  };
}

module.exports = {
  scheduleBotAction, cancelBotTimeout,
  // Exported for simulation harness
  _internal: {
    decideBotPlay, shouldPlayOpsecDecision, selectPaymentCards, setRng, rnd,
    planRearrange, boardScore, minimalCover, applyBotAction,
    unseenCounts, CARD_AWARENESS, tryGuaranteedBreaker, findChudCompletionTarget,
    REARRANGE_BIAS, REARRANGE_CONSOLIDATES, payWeight, ORDER_ATTENTION, findChargeBooster, findCompletingPlay,
    BREAK_URGENCY, BREAK_OVERPAY, disposableValue, tryBreakFinalApproach,
    BREAKER_BAR, BREAKER_SELF_MARGIN, worthwhileBreakerShot, escrowHoldsBreaker,
    breakerEscrowRelease, tryArmingBreaker, shotGainsUsASet, planBreakerShot,
    findStealBooster, opsecOdds, tryArmingPlay, preArmedLeader, CUSHION_PRESSURE, CUSHION_GAIN, maybeBaitFirst, BAIT_PATIENCE, BAIT_BELIEF_FLOOR,
    // §3.12 the humanlike instrument (tools/simhuman.mjs, test/bot-humanlike.test.js).
    HUMAN_BREAKER_FIRE, HUMAN_SHIELD, HUMAN_SHIELD_ARMED, HUMAN_BANK_FLOOR,
    HUMAN_COMPLETE_WINNING, HUMAN_COMPLETE_ORDINARY, HUMAN_DECLINE_LAYS_ELSEWHERE,
    HUMAN_SURGE_FOLLOW, HUMAN_CASH_BEFORE_PROPERTY, HUMAN_LAYS_SCATTER, humanFiresBreaker,
    humanCompletingPlay, ARMED_BANK_BIAS, HOLDBACK, HOLDBACK_SCALE, DELAYS,
    decideHumanlike, humanPropertyPlay, nonCompletingPropertyPlay, bankOneMoney, humanTurnRoll,
    // §3.10j the sandbag (scratchpad/spec-sandbag.md, test/bot-sandbag.test.js) and the
    // always-on completer discard tier (test/bot-discard-completer.test.js).
    SANDBAG, setSandbag, sandbagConfig, sandbagHeld, sandbagRelease, completesASet,
    // The inert parameter-override hook (see its header above module.exports).
    setTuning, tuningConfig,
    getAllPayableCardIds, chooseDiscards, isNeverDiscarded, findResponder: function(state) {
      return G.pendingResponders(state)[0] || null;
    },
    botRespondSync: function(state, botId, mode) {
      mode = personaOf(mode);
      const pa = state.pendingAction;
      if (!pa) return;
      const bot = G.getPlayer(state, botId);
      if (!bot) return;
      const hasOpsec = bot.hand.some(c => c.action === 'opsec') && G.canCounter(state, botId);
      if (hasOpsec && shouldPlayOpsecDecision(state, pa, mode, botId)) {
        const result = G.respondToAction(state, botId, 'opsec');
        if (!result.error) return;
      }
      acceptAction(state, bot, botId, pa, mode);
    },
  },
};
