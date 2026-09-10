// core/bots.js — who you are actually sitting down with.
//
// Extracted from ui/lobby.js, where it was UNREACHABLE the moment the game
// started: BOT_BLURB rendered into one <p> under the add-bot <select>, so it was
// visible only to the HOST, only in the lobby, and only for the mode currently
// selected in the dropdown — never for the bots already seated, and never at all
// once the table was live. "Which one is Reaper, and why does it never block
// anything?" had no answer on any screen.
//
// It lives in core/ because three surfaces need it now — the lobby's seat rows,
// the table's opponent boards and the in-game brief — and a fourth copy of these
// sentences is exactly how the copy in this project drifts away from bot.js.
//
// Every line is read off bot.js: the OPSEC policy in shouldPlayOpsecDecision(),
// the appetite for breaking a final approach in BREAK_URGENCY, the payment
// ordering in the selectPaymentCards() switch, and the think-time in DELAYS. If a
// line here and bot.js disagree, bot.js wins and this file is the bug.

/**
 * The wire value `chud` is the engine's and cannot move, but its LABEL could:
 * "CHUD" collided head-on with THE CHUD CARD, so a player reading "CHUD bot"
 * reasonably concluded it was the bot that plays the CHUD card. It is the chaos
 * personality, so it is labelled that way.
 */
export const BOT_LABEL = Object.freeze({
  random: 'RANDOM', conservative: 'CAUTIOUS', neutral: 'NEUTRAL',
  aggressive: 'AGGRESSIVE', chud: 'WILDCARD',
});

export const BOT_BLURB = Object.freeze({
  // decideRandom + BREAK_URGENCY.random 0.2 + OPSEC case 'random'.
  random: 'Plays almost anything and blocks almost nothing. Barely reacts to a final '
    + 'approach. The easiest seat at the table.',
  // BREAK_URGENCY 0.85, ARMED_BANK_BIAS 0.9, OPSEC case 'conservative'.
  conservative: 'Banks early, hoards OPSEC for Inspector General and CHUD, and pays with its '
    + 'cheapest cards first. Slow, and hard to break.',
  // BREAK_URGENCY 0.9, OPSEC case 'neutral' (blocks IG, CHUD, Finance Office, rent ≥ 4M).
  neutral: 'The balanced default. Blocks the big hits, waves the small ones through, and '
    + 'builds steadily.',
  // BREAK_URGENCY 1, OPSEC case 'aggressive' (guards only near-complete sets).
  aggressive: 'Attacks first and spends fast. Only guards sets it has nearly finished, so it '
    + 'is the quickest to shoot down a final approach — and the easiest to rob.',
  // DELAYS.chud is the fastest bank; OPSEC case 'chud' blocks small, lets big land;
  // decideChud ends turns early ~20%; discards at random.
  chud: 'Chaos, at speed. Blocks the small stuff, lets the big stuff land, discards at random '
    + 'and sometimes just stops mid-turn. (Nothing to do with THE CHUD CARD.)',
});

/** Presentation order: easiest first, chaos last. */
export const BOT_ORDER = Object.freeze(
  ['random', 'conservative', 'neutral', 'aggressive', 'chud']);

/** server/broadcast.js ships `botMode: x.botMode || null` on every room player,
 *  and a seat a human abandoned mid-game gets one of three modes assigned by
 *  server/handlers.js — so an unknown/absent mode is a real case, not a bug. */
export function botLabel(mode) { return BOT_LABEL[mode] || 'BOT'; }
export function botBlurb(mode) {
  return BOT_BLURB[mode]
    || 'A bot took this seat over. Its personality was picked by the server when the seat '
      + 'went quiet.';
}
