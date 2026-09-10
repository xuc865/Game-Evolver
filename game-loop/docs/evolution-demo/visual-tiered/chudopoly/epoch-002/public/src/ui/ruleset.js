// ui/ruleset.js — what ruleset is ACTUALLY running, for the copy that describes it.
//
// §3.9's bar is "no rule may exist that the help screen doesn't state". That was
// written when there was exactly one ruleset, so the brief, the win overlay and
// the HUD all hard-coded Final Approach and the number 3. The engine now
// resolves a per-game ruleset (game.js resolveRules → RULE_PRESETS) and ships
// `winRule` + `setsToWin` on every broadcast, so a game of Blitz was being
// described to its own players as a game of Chudopoly.
//
// This module is the ONE place the client asks "which rules are we playing?".
// It reads the snapshot and nothing else, so it cannot drift from the engine.
//
// ── FIELD ORDER, and why it is defensive ──────────────────────────────────
// A concurrent engine round is adding the full resolved ruleset as one object
// (`rules: {preset, winRule, setsToWin, pureSetRequired, counterCostsPlay,
//   passGoRestartsTurn}`).
// getPlayerView today ships only the two flat aliases. So: read `rules` first
// (it will be authoritative the moment it lands and needs no client change),
// then the flat aliases that ship today, then the core/cards.js constants —
// which are only ever reached with NO game on screen (the home-screen help).

import { store } from '../state/store.js';
import { SETS_TO_WIN } from '../core/cards.js';

export const WIN_RULES = Object.freeze(['finalApproach', 'mdFaithful', 'instant']);
const DEFAULT_WIN_RULE = 'finalApproach';         // game.js DEFAULT_WIN_RULE

/**
 * @returns {{winRule:string, setsToWin:number, preset:string|null,
 *            pureSetRequired:boolean|null, counterCostsPlay:boolean|null,
 *            passGoRestartsTurn:boolean|null,
 *            live:boolean}}
 *   `live` is false when there is no game on screen — the copy then describes
 *   the DEFAULT ruleset and says so, rather than asserting a rule for a game
 *   that has not been created yet.
 */
export function activeRules() {
  const snap = store.snapshot;
  const r = (snap && typeof snap.rules === 'object' && snap.rules) || null;
  const winRule = r?.winRule ?? snap?.winRule;
  const setsToWin = r?.setsToWin ?? snap?.setsToWin;
  return {
    winRule: WIN_RULES.includes(winRule) ? winRule : DEFAULT_WIN_RULE,
    setsToWin: Number.isInteger(setsToWin) && setsToWin > 0 ? setsToWin : SETS_TO_WIN,
    preset: r?.preset ?? null,
    pureSetRequired: r ? !!r.pureSetRequired : null,
    counterCostsPlay: r ? !!r.counterCostsPlay : null,
    passGoRestartsTurn: r ? !!r.passGoRestartsTurn : null,
    suddenDeath: r?.suddenDeath ?? 'off',
    // The deck this game is ACTUALLY played with. Null with no game on screen —
    // the copy then describes the default deck and says so, rather than
    // asserting a composition for a game that does not exist yet.
    deck: r?.deck ?? null,
    live: !!snap,
  };
}

/** The number of sets this game is played to. Never write "3" anywhere. */
export function setsToWin() { return activeRules().setsToWin; }

/** The active win rule id. */
export function winRule() { return activeRules().winRule; }

/** English word for a set count, so copy reads like copy. */
export function countWord(n) {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][n] || String(n);
}

/** Ordinal, for "your third set". `countWord(n) + 'th'` printed "threeth". */
export function ordinalWord(n) {
  const words = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
  if (words[n]) return words[n];
  const rem100 = n % 100;
  const suffix = (rem100 >= 11 && rem100 <= 13) ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

export const WIN_RULE_NAMES = Object.freeze({
  finalApproach: 'Final Approach',
  mdFaithful: 'MD Faithful',
  instant: 'Blitz — instant win',
});

/* ── the LOBBY's side of the same rules (P8 picker) ────────────────────────
 *
 * Everything above answers "what are we playing?" from a broadcast. A lobby has
 * no broadcast to read — the `state` message carries no ruleset until a game
 * exists (server/broadcast.js sends code/phase/players/hostId/game and nothing
 * else), so the host's PENDING choice is client-side by necessity.
 *
 * The four rows below are a MIRROR of game.js RULE_PRESETS, pinned by
 * test/houserules.test.js:291-297. The server is still authoritative (§0.1):
 * the lobby sends a preset name or the four toggles, resolveRules() resolves
 * them, and the very first broadcast replaces this label with the server's.
 * matchPreset() below is resolveRules()'s preset-detection loop, character for
 * character, so the label the host reads never disagrees with the label the
 * table will show.
 */

export const RULE_KEYS = Object.freeze(
  ['winRule', 'setsToWin', 'pureSetRequired', 'counterCostsPlay', 'passGoRestartsTurn',
   'suddenDeath']);

/* ── the deck (§3 deck knob) ──────────────────────────────────────────────
 * game.js DECK_BASE / DECK_KIND_MAX / DECK_MIN / DECK_MAX, mirrored for the
 * picker and pinned card-for-card by test/deckconfig.test.js. The server is
 * still authoritative — validateDeck() refuses anything these numbers would
 * have allowed by mistake, and the first broadcast replaces the host's pending
 * deck with the resolved one. This mirror exists so the lobby can DISABLE an
 * illegal step instead of offering it and being refused. */
export const DECK_BASE = Object.freeze({
  inspector_general: 2, opsec: 3, midnight_requisition: 3, tdy_orders: 3,
  finance_office: 3, roll_call: 3, pcs_orders: 10, upgrade: 3, foc: 2,
  surge_ops: 2, chud: 2, wildAny: 2, wildPairs: 7,
});
export const DECK_KINDS = Object.freeze(Object.keys(DECK_BASE));
export const DECK_FIXED = 61;                 // 28 property + 20 money + 13 rent
export const DECK_MIN = 80;
export const DECK_MAX = 130;
const DECK_ACTION_MAX = 12;
const DECK_KIND_MAX = Object.freeze({ wildAny: 4, wildPairs: 9 });
export function deckKindMax(kind) {
  return DECK_KIND_MAX[kind] !== undefined ? DECK_KIND_MAX[kind] : DECK_ACTION_MAX;
}
export function deckSize(counts) {
  return DECK_KINDS.reduce((n, k) => n + (counts?.[k] ?? DECK_BASE[k]), DECK_FIXED);
}
export function normalizeDeck(raw, base = DECK_BASE) {
  const out = { ...base };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const kind of DECK_KINDS) {
      const v = raw[kind];
      if (!Number.isInteger(v)) continue;
      out[kind] = Math.max(0, Math.min(deckKindMax(kind), v));
    }
  }
  const size = deckSize(out);
  return (size < DECK_MIN || size > DECK_MAX) ? { ...base } : out;
}
export function sameDeck(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return DECK_KINDS.every(k => a[k] === b[k]);
}

/** What each editable count is CALLED, in the words on the card face. */
export const DECK_COPY = Object.freeze({
  inspector_general: 'Inspector General', chud: 'THE CHUD CARD', opsec: 'OPSEC',
  midnight_requisition: 'Midnight Requisition', tdy_orders: 'TDY Orders',
  finance_office: 'Finance Office', roll_call: 'Roll Call', pcs_orders: 'PCS Orders',
  upgrade: 'Upgrade (House)', foc: 'Full Op Capability', surge_ops: 'Surge Operations',
  wildAny: 'Wild: any colour', wildPairs: 'Wild: two-colour',
});

/** Presentation order: the cards that decide a final approach lead, because
 *  "how many set-breakers are in this deck?" is the question the knob exists
 *  for. ui/deckcensus.js groups the discard view the same way. */
export const DECK_ORDER = Object.freeze([
  'inspector_general', 'chud', 'opsec', 'midnight_requisition', 'tdy_orders',
  'wildAny', 'wildPairs',
  'finance_office', 'roll_call', 'pcs_orders', 'upgrade', 'foc', 'surge_ops',
]);

/* ── §3.10b sudden death ──────────────────────────────────────────────── */
export const SUDDEN_DEATH_RULES = Object.freeze(['off', 'oneLap', 'escalate', 'points']);
export const SUDDEN_DEATH_COPY = Object.freeze({
  off: { label: 'Turn order decides', line: 'If two players are armed at once, whoever\u2019s turn comes first wins. The default.' },
  oneLap: { label: 'One extra lap', line: 'A contested approach suspends the win for one full round, then turn order decides.' },
  // 'escalate' follows the engine's LAP-CAP FALLBACK, which the old copy
  // ("pull ahead or nobody converts") denied: game.js contestBar() (809-814)
  // drops the bar back to setsToWin once contestLaps >= CONTEST_LAP_CAP (= 2,
  // game.js:72), and contestBlocks() (824-831) then returns null with the
  // contest still open \u2014 so turn order resolves it after all. "Two full rounds"
  // is that constant in words; test/ui-clarity2.test.js pins the two together.
  escalate: { label: 'The bar rises', line: 'While two players are armed, winning takes one MORE set \u2014 for two full rounds. After that the bar drops back and turn order decides.' },
  points: { label: 'Nobody converts', line: 'A contested approach never converts. After two rounds the game is decided on points.' },
});

export const PRESETS = Object.freeze({
  chudopoly:  Object.freeze({ winRule: 'finalApproach', setsToWin: 3, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: false, suddenDeath: 'off', deck: DECK_BASE }),
  // MD Faithful's deck IS the official Monopoly Deal deck: no CHUD (it has no MD
  // equivalent) and the two wilds we were short restored. Still 106 — the two
  // changes cancel. game.js RULE_PRESETS carries the full derivation.
  mdFaithful: Object.freeze({ winRule: 'mdFaithful',    setsToWin: 3, pureSetRequired: true,  counterCostsPlay: true,  passGoRestartsTurn: false, suddenDeath: 'off', deck: Object.freeze({ ...DECK_BASE, chud: 0, wildPairs: 9 }) }),
  blitz:      Object.freeze({ winRule: 'instant',       setsToWin: 3, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: true,  suddenDeath: 'off', deck: DECK_BASE }),
  longGame:   Object.freeze({ winRule: 'finalApproach', setsToWin: 5, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: false, suddenDeath: 'off', deck: DECK_BASE }),
});
/** Presentation order. Default first — it is the one most tables want. */
export const PRESET_ORDER = Object.freeze(['chudopoly', 'mdFaithful', 'blitz', 'longGame']);
export const SETS_TO_WIN_CHOICES = Object.freeze([3, 4, 5]);   // server/protocol.js SETS_TO_WIN

/**
 * `length` is MEASURED, not guessed: mean turns per game over the balance sim
 * (simulate.js, 4-player mixed bots). Chudopoly 34.5 · MD Faithful 23.7 ·
 * Blitz 25.1 · Long Game 66.8. MD Faithful was 35.1 until 2026-08-08, when its
 * win rule stopped deferring own-turn completions by a full lap (ARCHITECTURE
 * §3.10); re-measured over 360 games at 3/4/5 seats, it now lands on Blitz's
 * pace rather than the default's, and the card says so. Blitz is 27% shorter
 * than the default; Long Game is 1.94× it and 6.8% of those games run the deck
 * out and are decided on points instead of a win (§3.6 stalemate end), which is
 * a real thing to know before you pick it, so it is on the card rather than in
 * the help screen.
 */
export const PRESET_COPY = Object.freeze({
  chudopoly: Object.freeze({
    name: 'Chudopoly',
    tag: 'Default',
    turns: '≈35 turns',
    line: 'Three sets, then every other player gets one full turn to shoot you down.',
  }),
  mdFaithful: Object.freeze({
    name: 'MD Faithful',
    tag: 'By the book',
    turns: '≈24 turns',
    line: 'Monopoly Deal as written: your own turn wins on the spot, and rainbow wilds '
      + 'cannot finish a set alone.',
  }),
  blitz: Object.freeze({
    name: 'Blitz',
    tag: 'Fastest',
    turns: '≈25 turns',
    line: 'The third set wins the instant it lands, on anyone\'s turn, and PCS Orders hands '
      + 'your whole turn back. About a third shorter.',
  }),
  longGame: Object.freeze({
    name: 'Long Game',
    tag: 'Longest',
    turns: '≈67 turns',
    line: 'Five sets — nearly twice the length, and about 1 game in 15 runs the deck out and '
      + 'is decided on points.',
  }),
});

/** The label for a resolved preset id, including the server's 'custom'. */
export function presetLabel(name) {
  return PRESET_COPY[name]?.name || 'Custom';
}

/**
 * One sentence per win rule, for the picker. The help screen carries the
 * detail (ui/help.js pageGoal branches on all three); this is the choosing
 * copy, and the only claim it makes that is not about our engine is a
 * provenance claim, which is checked:
 *
 * Monopoly Deal's two rulebook editions disagree with each other. The classic
 * sheet carries "if you realize you've won during someone else's turn, you
 * must wait until it's your turn to say it"; the modern E3113 foldout, and the
 * 2025 FIFA and Harry Potter cuts, drop that sentence entirely and print "the
 * game ends when one player collects 3 complete Property sets in different
 * colors". So `instant` is how the CURRENT rulebook reads, `mdFaithful` is how
 * the ORIGINAL reads — and note what the original sentence actually says: the
 * wait is CONDITIONAL on realising off-turn. Completing on your own turn wins
 * on the spot under both editions, which is why mdFaithful no longer defers it
 * (corrected 2026-08-08; it used to, and that was Final Approach in disguise).
 * Final Approach is ours (ARCHITECTURE §3.10) — strictly the most generous of
 * the three to the defenders.
 */
export const WIN_RULE_LINE = Object.freeze({
  instant: 'You win the moment your last set lands, on anybody\'s turn — how the current '
    + 'Hasbro rulebook reads.',
  mdFaithful: 'Your own turn wins on the spot; only a set handed to you off-turn waits '
    + 'for your next own turn.',
  finalApproach: 'Every other player gets one full turn to break you first — ours, and the '
    + 'only one of the three that guarantees a reply.',
});

/** The three independent toggles, in the words a host chooses them by. */
export const TOGGLE_COPY = Object.freeze({
  pureSetRequired: Object.freeze({
    label: 'Rainbow wilds alone cannot finish a set',
    // game.js zoneIsSet(): a full zone of nothing but rainbow ("any") wilds is not a set.
    // Two-colour wilds are untouched — Hasbro's 2025 card faces say a set may be made of
    // those alone, and name the every-colour wild as the one that may not.
    line: 'A full colour only counts if one card in it is not a rainbow wild.',
  }),
  counterCostsPlay: Object.freeze({
    label: 'OPSEC costs a play on your own turn',
    // game.js respondToAction(): counterSpendsPlay() → one of the current seat's three.
    line: 'Countering on your own turn spends one of your three plays — and with none left '
      + 'you cannot counter at all.',
  }),
  passGoRestartsTurn: Object.freeze({
    label: 'PCS Orders restarts your turn',
    // game.js playAction 'pcs_orders': restart → state.playsRemaining = 3.
    line: 'Playing it draws 2 and hands back all three plays. The popular speed house rule.',
  }),
});

/** True when `value` is a legal value for that rule key (server/protocol.js). */
function legal(key, value) {
  switch (key) {
    case 'winRule': return WIN_RULES.includes(value);
    case 'setsToWin': return SETS_TO_WIN_CHOICES.includes(value);
    // §3.10b is refused with 'instant' by game.js normalizeSuddenDeath, so the
    // picker never offers it there; sending it anyway resolves to 'off'.
    case 'suddenDeath': return SUDDEN_DEATH_RULES.includes(value);
    default: return typeof value === 'boolean';
  }
}

/** Any object → a complete, legal toggle set. Unknown/illegal fields fall back
 *  to the Chudopoly default rather than being sent for the server to reject. */
export function normalizeRules(raw) {
  const out = { ...PRESETS.chudopoly, deck: { ...PRESETS.chudopoly.deck } };
  if (raw && typeof raw === 'object') {
    for (const key of RULE_KEYS) if (legal(key, raw[key])) out[key] = raw[key];
    if (raw.deck !== undefined) out.deck = normalizeDeck(raw.deck, out.deck);
  }
  // game.js normalizeSuddenDeath: nothing is ever armed under 'instant', so a
  // contested approach cannot exist and the control is forced off rather than
  // offered as a switch wired to nothing.
  if (out.winRule === 'instant') out.suddenDeath = 'off';
  return out;
}

/**
 * The preset a toggle set IS, or 'custom'. Identical to game.js resolveRules()'s
 * final `PRESET_NAMES.find(...)`, so flipping a toggle back onto a preset's
 * exact values re-labels it as that preset — the same way the server would.
 */
export function matchPreset(rules) {
  const r = normalizeRules(rules);
  return PRESET_ORDER.find(name => RULE_KEYS.every(key => PRESETS[name][key] === r[key])
    && sameDeck(PRESETS[name].deck, r.deck)) || 'custom';
}

/**
 * What to put on the wire. A named preset goes as a preset — one field, and the
 * server resolves it — because sending four toggles that happen to add up to
 * Blitz would never exercise the preset path at all. 'custom' has no wire value
 * (server/protocol.js RULE_PRESETS rejects it), so it goes as its four toggles,
 * which resolveRules() resolves to exactly the same thing.
 */
export function rulesPayload(rules) {
  const r = normalizeRules(rules);
  const preset = matchPreset(r);
  // A named preset goes as ONE field so the preset path is actually exercised;
  // 'custom' goes as every toggle INCLUDING the deck, which resolveRules()
  // resolves to exactly the same ruleset. The deck must ride along or a host who
  // changed only the deck would send a payload identical to Chudopoly's.
  return preset === 'custom' ? r : { preset };
}

/* ── persistence ──────────────────────────────────────────────────────────
 * A host who has chosen Blitz once is asked again on every new room and every
 * rematch-into-a-new-lobby otherwise. Same shape as ui/home.js's call-sign key
 * and audio/engine.js's mix key: one JSON blob, every read re-validated
 * through normalizeRules() so a hand-edited or stale value cannot put an
 * illegal ruleset on the wire. */
const RULES_KEY = 'chud.lobbyRules.v1';

export function loadHostRules() {
  try { return normalizeRules(JSON.parse(localStorage.getItem(RULES_KEY) || 'null')); }
  catch { return { ...PRESETS.chudopoly }; }
}

export function saveHostRules(rules) {
  try { localStorage.setItem(RULES_KEY, JSON.stringify(normalizeRules(rules))); }
  catch { /* private mode */ }
}

/** One sentence: what ending this game is playing to. */
export function winRuleSummary(rules = activeRules()) {
  const n = rules.setsToWin;
  switch (rules.winRule) {
    // game.js syncSets(): winRule 'instant' → finishGame the moment the count lands.
    case 'instant':
      return `Completing your ${ordinalWord(n)} set wins the game on the spot, `
        + 'on anyone\'s turn. There is no grace window and nothing is ever armed.';
    // game.js syncSets(): 'mdFaithful' finishes inline on an own-turn completion and arms
    // only off-turn; checkpointThreshold() → 1, i.e. your very next own turn start.
    case 'mdFaithful':
      return `Completing your ${ordinalWord(n)} set on YOUR turn wins on the spot. A set `
        + 'handed to you during someone else\'s turn instead arms you, and you declare at '
        + 'your next own turn start — the literal Monopoly Deal sentence.';
    // checkpointThreshold(): activeCount(state) — a whole cycle of turns.
    default:
      return `Holding ${countWord(n)} complete sets arms your FINAL APPROACH. Every other `
        + 'player gets a full turn to break you; you win at your own turn start after that.';
  }
}
