// game.js — Card definitions, deck builder, and all game rules for Chudopoly

const COLORS = {
  brown:     { name:'Drone Ops',       bg:'#8B4513', fg:'#fff', size:2, rent:[1,2] },
  lightblue: { name:'Training',        bg:'#87CEEB', fg:'#000', size:3, rent:[1,2,3] },
  pink:      { name:'Space Force',     bg:'#FF69B4', fg:'#000', size:3, rent:[1,2,4] },
  orange:    { name:'Test & Eval',     bg:'#FF8C00', fg:'#000', size:3, rent:[1,3,5] },
  red:       { name:'Fighters',        bg:'#DC143C', fg:'#fff', size:3, rent:[2,3,6] },
  yellow:    { name:'Mobility',        bg:'#FFD700', fg:'#000', size:3, rent:[2,4,6] },
  green:     { name:'Elite Programs',  bg:'#228B22', fg:'#fff', size:3, rent:[2,4,7] },
  darkblue:  { name:'Command',         bg:'#00308F', fg:'#fff', size:2, rent:[3,8] },
  base:      { name:'Overseas Bases',  bg:'#2F4F4F', fg:'#fff', size:4, rent:[1,2,3,4] },
  intel:     { name:'Intelligence',    bg:'#708090', fg:'#fff', size:2, rent:[1,2] },
};

const HAND_LIMIT = 7;
const SETS_TO_WIN = 3;
// §3.10 win-rule toggle (owner directive 2026-08-06), chosen per room in the lobby.
//   finalApproach — DEFAULT, the house identity. Strict full-cycle checkpoint: the win
//                   resolves at the armed player's first own-turn start that is a FULL
//                   turn cycle after arming, so every opponent is guaranteed a response
//                   turn no matter when the third set landed.
//   mdFaithful    — the rulebook read literally, which means read CONDITIONALLY. The 2008
//                   sheet says "if you realize you've won during someone else's turn, you
//                   must wait until it's your turn to say it" — the wait is the EXCEPTION.
//                   So completing your third set on your OWN turn wins on the spot, and
//                   only a set that lands off-turn waits, converting at your very next own
//                   turn start while you still hold 3+. (Corrected 2026-08-08: this used to
//                   make every arming wait a full lap, which is Final Approach with a
//                   different name and matched no edition of the rulebook. Every Hasbro
//                   printing since 2017 — E3113, and the 2025 FIFA and Harry Potter cuts —
//                   drops even the exception and says the game simply ends.)
//   instant       — classic quick game. The third completed set wins the moment it
//                   completes, wherever and whenever — including on an opponent's turn
//                   through a payment, steal or swap. Nothing is ever armed.
const WIN_RULES = ['finalApproach', 'mdFaithful', 'instant'];
const DEFAULT_WIN_RULE = 'finalApproach';
function normalizeWinRule(value) {
  return WIN_RULES.includes(value) ? value : DEFAULT_WIN_RULE;
}

/* ── §3.10b CONTESTED APPROACH (owner directive 2026-08-07) ────────────────
 *
 * The owner's ask: "if someone is on final approach but another person is able to also hit
 * 3 sets before their turn comes back around then it shouldn't end until they are stopped."
 *
 * Today a contested race resolves by turn order — A arms, B arms, A's turn comes first, A
 * wins — which is §3.10's own reading of the Hasbro rule and needs no tiebreak. This makes
 * the contest SUSPEND the win instead.
 *
 * THE PROBLEM THAT HAD TO BE SOLVED BEFORE ANY OF IT COULD BE MEASURED: as asked, it does
 * not terminate. Two armed players who both hold their sets and neither of whom draws a
 * breaker never resolve, and they are by construction the two strongest seats at the table —
 * the ones most able to defend. §3.6 and §3.11 exist because this project does not ship
 * non-terminating states, so every mode below carries its own bound and none of them relies
 * on the deck running out to end the game.
 *
 *   off      — DEFAULT. Turn order decides, exactly as §3.10 has always done.
 *   oneLap   — the current behaviour delayed by exactly one lap. While contested nobody
 *              converts; after one full turn cycle of contest the turn-order rule resolves
 *              it. The smallest possible version of the owner's ask.
 *   escalate — while contested the bar rises to setsToWin + 1, so the contest is broken by
 *              PULLING AHEAD rather than by waiting. Bounded at CONTEST_LAP_CAP laps, after
 *              which turn order resolves it, because nobody is guaranteed to find a fourth
 *              set either.
 *   points   — the purest reading: nobody converts while contested, and after
 *              CONTEST_LAP_CAP laps the game ends on §3.6 points (most sets, then net
 *              worth). Terminating, but it ends the biggest game of the night on a count.
 *
 * Measured cost per mode at 3, 4 and 5 players is in BOT-STRATEGY.md; the recommendation and
 * the reason `off` is still the default are there too.
 */
const SUDDEN_DEATH_RULES = ['off', 'oneLap', 'escalate', 'points'];
const DEFAULT_SUDDEN_DEATH = 'off';
// Laps of contest before `escalate` and `points` stop waiting. Two, not one: one lap is a
// single turn each and a table that has just been forced into a contest has had no real
// chance to break it, while three measurably drags (see BOT-STRATEGY.md).
const CONTEST_LAP_CAP = 2;
function normalizeSuddenDeath(value, winRule) {
  const v = SUDDEN_DEATH_RULES.includes(value) ? value : DEFAULT_SUDDEN_DEATH;
  // FORBIDDEN COMBINATION, refused here rather than in the lobby. Under 'instant' nothing is
  // ever armed (syncSets finishes the game the moment the count lands), so there is no such
  // thing as a contested approach and the control would be a switch wired to nothing —
  // which is worse than not offering it, because a host would believe they had chosen
  // something. It composes with 'mdFaithful' mechanically and is allowed to; that ruleset
  // simply stops being "by the book" and resolveRules() labels it 'custom', which is true.
  return winRule === 'instant' ? 'off' : v;
}

/* ── Rule presets and toggles (§3, owner directive 2026-08-06) ────────── */

const SETS_TO_WIN_CHOICES = [3, 4, 5];
function normalizeSetsToWin(value) {
  const n = Number(value);
  return SETS_TO_WIN_CHOICES.includes(n) ? n : SETS_TO_WIN;
}

/* ── Deck composition (§3 deck knob, owner directive 2026-08-07) ──────────
 *
 * WHAT IS EDITABLE, AND WHY EXACTLY THESE THIRTEEN.
 *
 * The deck has five families. Three of them are not free parameters and are deliberately
 * NOT exposed:
 *   * property (28) — COLORS[c].size IS the number of cards of that colour in the deck, and
 *     the same number is simultaneously the §3.5 zone cap and the set-completion test.
 *     Fewer copies makes a colour uncompletable without spending a wild on it; more breaks
 *     the cap validateState() asserts. A property count is a consequence of the colour
 *     table, not a knob.
 *   * money (20) — the economy's SCALE. Change it and every rent, every demand and every
 *     payment move together, so nothing measured over it is interpretable as being about
 *     any one card.
 *   * rent (13) — same argument. Thirteen rents against ten colours is the ladder itself.
 * The other two families are free — every count in them is legal at every value, and they
 * are the two the balance question is actually about:
 *   * the eleven ACTION kinds — the cards that decide tempo and interaction
 *   * the WILD properties, split into the rainbow ("any") wilds and the ordered two-colour
 *     list, because those are two different cards that share one name.
 *
 * A count is a COUNT, never a card list: the host chooses how many, the engine chooses
 * which, so no lobby input can ever name a card that does not exist.
 */

// The two-colour wilds, IN DECK ORDER. `wildPairs: n` takes the first n, so the baseline
// (7) is byte-identical to the deck this game shipped with and every id is unchanged.
// Entries 8 and 9 restore Monopoly Deal's second Orange/Pink and second Red/Yellow — the
// only two cards our deck is missing against the official 110 (see mdFaithful below).
const WILD_PAIRS = [
  { colors: ['brown', 'lightblue'], name: 'Wild: Drone/Training', value: 1 },
  { colors: ['pink', 'orange'], name: 'Wild: Space/Test', value: 2 },
  { colors: ['red', 'yellow'], name: 'Wild: Fighter/Mobility', value: 3 },
  { colors: ['green', 'darkblue'], name: 'Wild: Elite/Command', value: 4 },
  { colors: ['base', 'intel'], name: 'Wild: Bases/Intel', value: 2 },
  { colors: ['base', 'green'], name: 'Wild: Bases/Elite', value: 4 },
  { colors: ['lightblue', 'brown'], name: 'Wild: Training/Drone', value: 1 },
  { colors: ['pink', 'orange'], name: 'Wild: Space/Test', value: 2 },
  { colors: ['red', 'yellow'], name: 'Wild: Fighter/Mobility', value: 3 },
];

// The shipped deck, as counts. Sums to 45; the fixed families sum to 61; 45 + 61 = 106.
const DECK_BASE = Object.freeze({
  inspector_general: 2, opsec: 3, midnight_requisition: 3, tdy_orders: 3,
  finance_office: 3, roll_call: 3, pcs_orders: 10, upgrade: 3, foc: 2,
  surge_ops: 2, chud: 2,
  wildAny: 2, wildPairs: 7,
});
const DECK_KINDS = Object.keys(DECK_BASE);
// The eleven action kinds, in buildDeck() emission order. `chud` is last because it is
// emitted in its own block AFTER the rents, and that order is what fixes the card ids.
const DECK_ACTION_KINDS = DECK_KINDS.filter(k => !k.startsWith('wild'));
// 28 property + 20 money + 13 rent. Not editable (see above), so it is a constant here and
// checked against buildDeck() in test/deckconfig.test.js.
const DECK_FIXED = 61;

// Per-kind ceiling. 12 for an action kind because PCS Orders already ships 10 and a host may
// legitimately want more of it; the ceiling exists to stop "sixty CHUDs", not to referee
// taste. Wilds are capped by what exists: two rainbow wilds is what MD has and four is
// already double, and the pair list is nine cards long.
const DECK_KIND_MAX = Object.freeze({ wildAny: 4, wildPairs: WILD_PAIRS.length });
const DECK_ACTION_MAX = 12;
function deckKindMax(kind) {
  return DECK_KIND_MAX[kind] !== undefined ? DECK_KIND_MAX[kind] : DECK_ACTION_MAX;
}

// TOTAL deck size bounds, and an honest account of what they do and do not buy.
//
// MEASURED 2026-08-07 (simulate.js mixedMatrix, 2000 games per point, 5 players — the seat
// count where the tail lives), scaling the whole editable block and holding its shape:
//
//   size   property share   avg turns   p90   max   decided on §3.6/§3.11 points   cycles
//     61        45.9%          33.2      44    54            58.6%                  5.99
//     76        40.8%          44.4      61    81            57.8%                 10.24
//     86        37.2%          47.8      75    99            33.8%                  6.48
//     96        36.5%          52.6      93   121            26.4%                  4.45
//    106        34.9%          47.5      94   144             8.5%                  2.13
//    116        33.6%          42.9      68   157             1.4%                  1.18
//    126        31.7%          46.4      73   200             0.9%                  0.88
//    146        28.1%          51.6      78   244             0.3%                  0.60
//
// Two things fall out, and the second one is the reason this comment is longer than the
// constants it explains.
//
//   * The ceiling is the TAIL. Max turns climbs monotonically with size — 144 at 106, 200 at
//     126, 244 at 146 — because a bigger deck reaches §3.11's 16-cycle cap later. 130 is
//     where the worst game is still inside twice the p90.
//   * The floor is where the points ending stops being a safety net. Below ~100 cards the
//     deck runs dry faster than three sets can be assembled and §3.6 becomes the NORMAL
//     ending: a quarter of 5-player games at 96, a third at 86, most of them at 76.
//
// AND THE BOUNDS ARE NOT A BALANCE GUARANTEE. A second sweep holding the wilds at baseline
// and scaling only the actions produced 35.5% points-endings at size 86 but 11.4% at 92 and
// 6.6% at 96 — non-monotonic in size, because what actually drives the ending mix is WHICH
// cards were removed (OPSEC and PCS Orders dominate) and not how many. So these two numbers
// bracket the region the game has been measured in; they do not promise that every deck
// inside them plays well, and no bound on a single scalar could. What they DO guarantee is
// that the game still ends — §3.6 and §3.11 terminate every reachable deck, and
// test/deckconfig.test.js proves it at both extremes rather than asserting it here.
const DECK_MIN = 80;
const DECK_MAX = 130;

function deckSize(counts) {
  let n = DECK_FIXED;
  for (const kind of DECK_KINDS) n += counts[kind];
  return n;
}

/**
 * Any input → a COMPLETE, legal count map. Total, like normalizeWinRule: unknown keys are
 * ignored, non-integers fall back to `base`, integers are clamped to the kind's range. If
 * the result still lands outside [DECK_MIN, DECK_MAX] the whole override is REFUSED and
 * `base` is returned — a size that far off is not a typo in one field, it is a different
 * request, and half-honouring it would run the table on a deck nobody chose.
 *
 * The strict door is validateDeck() (server/protocol.js), which refuses the same inputs out
 * loud so a real client gets an error instead of a silent substitution.
 */
function normalizeDeck(raw, base = DECK_BASE) {
  const out = { ...base };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const kind of DECK_KINDS) {
      const v = raw[kind];
      if (v === undefined) continue;
      if (!Number.isInteger(v)) continue;
      out[kind] = Math.max(0, Math.min(deckKindMax(kind), v));
    }
  }
  const size = deckSize(out);
  return (size < DECK_MIN || size > DECK_MAX) ? { ...base } : out;
}

/** Strict validation for the wire. Returns an error string, or null when `raw` is legal. */
function validateDeck(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'Deck composition must be an object';
  const keys = Object.keys(raw);
  if (keys.length > DECK_KINDS.length) return 'Deck composition has too many fields';
  for (const key of keys) {
    if (!DECK_KINDS.includes(key)) return `Unknown deck card "${key}"`;
    const v = raw[key];
    if (!Number.isInteger(v) || v < 0 || v > deckKindMax(key)) {
      return `Invalid count for "${key}" (0–${deckKindMax(key)})`;
    }
  }
  const size = deckSize({ ...DECK_BASE, ...raw });
  if (size < DECK_MIN || size > DECK_MAX) {
    return `Deck must hold ${DECK_MIN}–${DECK_MAX} cards (that one holds ${size})`;
  }
  return null;
}

function sameDeck(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return DECK_KINDS.every(kind => a[kind] === b[kind]);
}

/* ── Rule presets ────────────────────────────────────────────────────── */

// Four one-tap lobby presets. Resolved SERVER-SIDE so a preset is never a client illusion.
//
// mdFaithful's deck is not a flavour choice, it is the arithmetic. Official Monopoly Deal
// (monopolydealrules.com, cross-checked against Geeky Hobbies) is 110 cards = 4 rule cards
// + 106 playable: 28 property, 11 property wilds, 13 rent, 20 money, and 34 action —
// Deal Breaker 2, Just Say No 3, Sly Deal 3, Forced Deal 3, Debt Collector 3, It's My
// Birthday 3, Double The Rent 2, House 3, Hotel 2, Pass Go 10. Our shipped deck already
// matches every one of those counts; the only two differences in the whole deck are the two
// CHUD cards (our invention, no MD equivalent) and the two wilds we were short. Dropping
// CHUD and restoring the wilds therefore lands on the official deck EXACTLY, card category
// for card category — and it stays 106, because the two changes cancel. Pinned by
// test/deckconfig.test.js against the published counts.
const RULE_PRESETS = {
  chudopoly: { winRule: 'finalApproach', setsToWin: 3, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: false, suddenDeath: 'off', deck: { ...DECK_BASE } },
  mdFaithful: { winRule: 'mdFaithful', setsToWin: 3, pureSetRequired: true, counterCostsPlay: true, passGoRestartsTurn: false, suddenDeath: 'off', deck: { ...DECK_BASE, chud: 0, wildPairs: 9 } },
  blitz: { winRule: 'instant', setsToWin: 3, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: true, suddenDeath: 'off', deck: { ...DECK_BASE } },
  longGame: { winRule: 'finalApproach', setsToWin: 5, pureSetRequired: false, counterCostsPlay: false, passGoRestartsTurn: false, suddenDeath: 'off', deck: { ...DECK_BASE } },
};
const PRESET_NAMES = Object.keys(RULE_PRESETS);
const DEFAULT_PRESET = 'chudopoly';
// The SCALAR rule keys. `deck` is deliberately not in here: every consumer of this list
// compares with ===, which is exactly wrong for an object, so the deck is compared through
// sameDeck() next to every use instead of silently comparing references.
const RULE_KEYS = ['winRule', 'setsToWin', 'pureSetRequired', 'counterCostsPlay', 'passGoRestartsTurn', 'suddenDeath'];

// opts → the resolved ruleset. A named preset supplies the base; any individual toggle the
// lobby also sent overrides it. `preset` in the result is the preset the resolved values
// actually match, or 'custom' — so the client can never label a mixed ruleset as a preset.
//
// `deck` merges over the PRESET's deck rather than over DECK_BASE, so
// {preset:'mdFaithful', deck:{inspector_general:3}} means "the MD deck, with a third Deal
// Breaker" — the same additive reading the scalar toggles already have.
function resolveRules(opts = {}) {
  const named = RULE_PRESETS[opts && opts.preset] ? opts.preset : DEFAULT_PRESET;
  const rules = { ...RULE_PRESETS[named], deck: { ...RULE_PRESETS[named].deck } };
  if (opts && opts.winRule !== undefined) rules.winRule = normalizeWinRule(opts.winRule);
  if (opts && opts.setsToWin !== undefined) rules.setsToWin = normalizeSetsToWin(opts.setsToWin);
  if (opts && opts.pureSetRequired !== undefined) rules.pureSetRequired = !!opts.pureSetRequired;
  if (opts && opts.counterCostsPlay !== undefined) rules.counterCostsPlay = !!opts.counterCostsPlay;
  if (opts && opts.passGoRestartsTurn !== undefined) rules.passGoRestartsTurn = !!opts.passGoRestartsTurn;
  if (opts && opts.suddenDeath !== undefined) rules.suddenDeath = opts.suddenDeath;
  if (opts && opts.deck !== undefined) rules.deck = normalizeDeck(opts.deck, rules.deck);
  // LAST, and after winRule is settled: the legal values depend on it (see
  // normalizeSuddenDeath), so this cannot be folded into the line above.
  rules.suddenDeath = normalizeSuddenDeath(rules.suddenDeath, rules.winRule);
  const match = PRESET_NAMES.find(name =>
    RULE_KEYS.every(key => RULE_PRESETS[name][key] === rules[key])
    && sameDeck(RULE_PRESETS[name].deck, rules.deck));
  return { preset: match || 'custom', ...rules };
}

const DEFAULT_RULES = resolveRules({});

// Set-completion rules are per-game, but completedSets()/isSetComplete() are called with a
// player and nothing else from bot.js and simulate.js in ~30 places. Rather than churn every
// signature, createGame stamps the resolved ruleset on each player as a NON-ENUMERABLE
// property — the same trick state._rng uses, so it can never reach a broadcast or a JSON
// snapshot.
function rulesOf(player) {
  return (player && player._rules) || DEFAULT_RULES;
}
function rulesFor(state) {
  return (state && state.rules) || DEFAULT_RULES;
}
function setsToWinOf(state) {
  return rulesFor(state).setsToWin;
}
const EVENT_TAIL = 120;          // broadcast tail size (ARCHITECTURE §4)
// Attrition cap. The §3.10 grace cycle stretched 5-player bot games from p99 63 turns to
// p99 387 (max 401) because every break scatters a finished set. Ending the game on points
// after N deck cycles bounds it: N=8 → max 99 turns but 17% of 5p games decided on points;
// N=16 → max 152 turns and only 7%. Normal games spend 1.9 cycles (p90 5).
const DECK_CYCLE_LIMIT = 16;
const EVENT_LOG_MAX = 400;       // retained in state; never grows unbounded
// state.log used to be uncapped. moveProperty costs no play, so 5,000 calls inside one
// turn grew it to 217KB (~44 B/line) and it was never freed while the room lived.
// 400 lines ≈ 18KB and still covers ~55 turns of a 5-player table (measured 7 lines/turn).
const LOG_MAX = 400;
const LOG_TAIL = 40;             // sent in getPlayerView; 20 lost a 5-player Roll Call turn in <3 turns

// §3.8 — rearranging your own wilds (and, per §3.1b, your Upgrades) is FREE: it costs no
// play, and that freedom is a real part of the game, because a wild is only worth what the
// board lets it become. "Free" was implemented as "unlimited", and an ACCEPTED command that
// fans a full room state to every seat for a 62-byte request is an amplifier no wire rate
// limit can see. Measured on a solo room: 60 moves in 9.0s returned 785,471 B to one seat
// (85 KB/s, ~x211 per request) with playsRemaining and turnNumber both untouched, and five
// concurrent flooders pulled 1.5 MB in 3.5s. It was also a turn-holding grief — 184 moves
// sprayed 184 forced card-flight animations across every client while the turn never moved.
//
// Every guard added before this one sat on a REJECTED or COOLED path, so none of them saw a
// command the engine happily accepts. This is the accepted-path bound: a per-turn budget,
// refilled by beginTurn exactly like playsRemaining. It cannot be felt in normal play — one
// seat can hold at most 10 wilds, so moving every one of them and still having budget left
// is the ordinary case — and it is finite under abuse: 12 fan-outs per turn, after which the
// command costs a ~60-byte error instead of a ~13 KB state, and the abuser must actually end
// their turn (or run out their turn clock) to get more.
const REARRANGE_BUDGET = 12;

// §3.5's atomic swap moves TWO cards, so it draws TWO from the same budget — see the long
// note over swapProperties(). Named rather than inlined because the client mirrors it
// (state/selectors.js canSwap) and test/property-swap.test.js pins the two against each other.
const SWAP_COST = 2;

/* ── Card definitions ────────────────────────────────────────────────── */

/**
 * @param {object} [deck] a count map (sparse or complete) — see normalizeDeck(). Absent
 *   means the shipped 106-card deck, and with the baseline counts every card comes out in
 *   the same order with the same id as before this parameter existed
 *   (test/deckconfig.test.js pins it), so a recorded game replays unchanged.
 */
function buildDeck(deck) {
  const n = normalizeDeck(deck);
  let id = 0;
  const cards = [];
  const c = (props) => { cards.push({ id: id++, ...props }); };

  /* Property cards */
  const props = [
    ['brown','Creech AFB',1],['brown','Cannon AFB',1],
    ['lightblue','Lackland AFB (BMT)',1],['lightblue','Keesler AFB',1],['lightblue','Goodfellow AFB',1],
    ['pink','Peterson SFB',2],['pink','Schriever SFB',2],['pink','Buckley SFB',2],
    ['orange','Nellis AFB',2],['orange','Eglin AFB',2],['orange','Edwards AFB',2],
    ['red','F-22 Raptor',3],['red','F-35 Lightning II',3],['red','F-15 Eagle',3],
    ['yellow','KC-135 Stratotanker',3],['yellow','C-17 Globemaster III',3],['yellow','C-130 Hercules',3],
    ['green','Thunderbirds',4],['green','Weapons School',4],['green','Red Flag',4],
    ['darkblue','The Pentagon',4],['darkblue','Air Force One',4],
    ['base','Ramstein AB',2],['base','Kadena AB',2],['base','Osan AB',2],['base','Thule AB',2],
    ['intel','PAVE PAWS Radar',1],['intel','GPS Constellation',1],
  ];
  props.forEach(([color,name,value]) => c({ type:'property', color, name, value }));

  /* Wild property cards */
  for (let i=0;i<n.wildAny;i++) c({ type:'wild_property', colors:['any'], name:'Wild Property', value:0 });
  for (const w of WILD_PAIRS.slice(0, n.wildPairs)) {
    c({ type:'wild_property', colors:[...w.colors], name:w.name, value:w.value });
  }

  /* Money cards */
  for(let i=0;i<6;i++) c({ type:'money', name:'1M', value:1 });
  for(let i=0;i<5;i++) c({ type:'money', name:'2M', value:2 });
  for(let i=0;i<3;i++) c({ type:'money', name:'3M', value:3 });
  for(let i=0;i<3;i++) c({ type:'money', name:'4M', value:4 });
  for(let i=0;i<2;i++) c({ type:'money', name:'5M', value:5 });
  c({ type:'money', name:'10M', value:10 });

  /* Action cards — the QUANTITY now comes from the resolved deck, never from this table. */
  const actions = [
    ['inspector_general','Inspector General',5,'Steal a complete property set from any player. OPSEC can block it.'],
    ['opsec','OPSEC',4,'Counter any action card played against you. Can itself be countered by another OPSEC.'],
    ['midnight_requisition','Midnight Requisition',3,'Steal a single property from any player. Cannot touch a complete set.'],
    ['tdy_orders','TDY Orders',3,'Swap one of your properties for one of another player\'s. Neither card may come from a complete set.'],
    ['finance_office','Finance Office',3,'Collect 5M from any one player'],
    ['roll_call','Roll Call',2,'All other players pay you 2M each'],
    ['pcs_orders','PCS Orders',1,'Draw 2 extra cards from the deck'],
    ['upgrade','Upgrade (House)',3,'Add to a complete set: +3M rent'],
    ['foc','Full Operational Capability (Hotel)',4,'Add to a complete set with Upgrade: +4M rent'],
    // §3.1c — chargeAmount() passes surgeable:true from the RENT branch only, and
    // playAction 'surge_ops' increments a counter, so it stacks. The old wire text
    // ("rent or any demand") described the pre-reversal rule; core/cards.js
    // ACTION_RULES carries the long form and this one-liner must not contradict it.
    ['surge_ops','Surge Operations',1,'Double your next RENT this turn — rent only, never a demand. Stacks.'],
  ];
  actions.forEach(([action,name,value,desc]) => {
    for(let i=0;i<n[action];i++) c({ type:'action', action, name, value, description:desc });
  });

  /* Rent cards */
  const rents = [
    [['brown','lightblue'],1,2],
    [['pink','orange'],1,2],
    [['red','yellow'],1,2],
    [['green','darkblue'],1,2],
    [['base','intel'],1,2],
    [['any'],3,3],
  ];
  rents.forEach(([colors,value,qty]) => {
    for(let i=0;i<qty;i++) c({ type:'rent', colors, name:'Rent: '+colors.join('/'), value });
  });

  /* THE CHUD CARD — 2 copies by default, 0 under mdFaithful (it has no MD equivalent).
     The 2M tax rider is gone (§3.1); the steal is the whole card.
     Face value stays 4M: a 4000-game mixed matrix at value 5 moved no personality by more
     than 0.1 point (conservative 27.3% → 27.2%, all others identical), so §3.1's
     "raise the face value if it still dominates" has nothing to fix. */
  const CHUD_TEXT = 'Commandeer Hardware Under Directive — Steal ANY property from any player, even out of a complete set. OPSEC can block it.';
  for (let i=0;i<n.chud;i++) {
    c({ type:'action', action:'chud', name:'THE CHUD CARD', value:4, description:CHUD_TEXT });
  }

  return cards;
}

/* ── Seeded RNG (ARCHITECTURE §0.7) ──────────────────────────────────── */

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function sfc32(a, b, c, d) {
  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// makeRng(undefined) === Math.random, so the unseeded path is byte-identical to before.
function makeRng(seed) {
  if (seed === undefined || seed === null || seed === '') return Math.random;
  const h = xmur3(String(seed));
  const rand = sfc32(h(), h(), h(), h());
  for (let i = 0; i < 15; i++) rand();
  return rand;
}

function shuffle(arr, rand = Math.random) {
  for (let i=arr.length-1; i>0; i--) {
    const j=Math.floor(rand()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

function rngOf(state) {
  return typeof state?._rng === 'function' ? state._rng : Math.random;
}

/* ── Structured event channel (ARCHITECTURE §4) ──────────────────────── */

function publicCard(card) {
  if (!card) return null;
  const out = { id: card.id, type: card.type, name: card.name, value: card.value };
  if (card.color) out.color = card.color;
  if (card.colors) out.colors = card.colors;
  if (card.action) out.action = card.action;
  if (card.description) out.description = card.description;
  if (card.placedColor) out.placedColor = card.placedColor;
  if (card.upgradeType) out.upgradeType = card.upgradeType;
  return out;
}

// The single append point for the prose Mission Log. Bounded (see LOG_MAX).
function logLine(state, text) {
  if (!state.log) state.log = [];
  state.log.push(text);
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  return text;
}

function emit(state, t, payload) {
  if (!state.events) { state.events = []; state.eventSeq = state.eventSeq || 0; }
  const ev = { seq: ++state.eventSeq, t, ...payload };
  state.events.push(ev);
  if (state.events.length > EVENT_LOG_MAX) state.events.splice(0, state.events.length - EVENT_LOG_MAX);
  return ev;
}

// Events must leak nothing getPlayerView hides (§10). Only draw/deal carry hand cards.
function redactEvent(ev, playerId) {
  if ((ev.t === 'draw' || ev.t === 'deal') && ev.cards && ev.to !== playerId) {
    const { cards, ...rest } = ev;
    return rest;
  }
  return ev;
}

/* ── Game state ──────────────────────────────────────────────────────── */

function createGame(players, opts = {}) {
  const seed = opts && opts.seed !== undefined ? opts.seed : undefined;
  const rand = makeRng(seed);
  // Rules FIRST: the deck is one of them now, so it cannot be built before they resolve.
  const rules = resolveRules(opts);
  const deck = shuffle(buildDeck(rules.deck), rand);
  // OWNER 2026-08-07: "randomize the starting player / lobby positions so turn
  // order isn't always the same." Opt-in, not default: simulate.js seats
  // personalities deliberately (simbalance's first-player-advantage number IS
  // a measurement of seat order), and tests pin explicit orders. The server
  // passes shuffleSeats for real rooms; drawing from the game's own rng keeps
  // the order reproducible from the logged seed.
  if (opts.shuffleSeats && players.length > 1) players = shuffle(players.slice(), rand);
  const state = {
    phase: 'playing',
    turnPhase: 'draw',
    currentPlayerIndex: 0,
    playsRemaining: 3,
    rearrangesRemaining: REARRANGE_BUDGET,
    deck,
    discardPile: [],
    players: players.map(p => ({
      id: p.id, name: p.name,
      hand: [], bank: [],
      properties: {},
      upgrades: {},
      finalApproach: false,
    })),
    pendingAction: null,
    winner: null,
    endReason: null,
    cardTotal: deck.length,
    shuffleCount: 0,
    turnCounter: 0,
    rules,
    winRule: rules.winRule,          // alias kept: already shipped to the client agents
    seed: seed === undefined ? null : seed,
    events: [],
    eventSeq: 0,
    stats: {
      turns: 1,
      cardsPlayed: {},
      payments: { count: 0, total: 0, biggest: 0 },
      propertiesStolen: {},
    },
    log: ['Game started! ' + players.map(p=>p.name).join(', ') + ' are playing.'],
  };
  // Non-enumerable: the RNG must never end up in a broadcast or a JSON snapshot.
  Object.defineProperty(state, '_rng', { value: rand, enumerable: false, writable: true });
  // Non-enumerable, so set-completion rules travel with the player without ever serializing.
  for (const p of state.players) {
    Object.defineProperty(p, '_rules', { value: rules, enumerable: false, writable: true });
  }

  emit(state, 'game_start', {
    order: state.players.map(p => p.id),
    names: Object.fromEntries(state.players.map(p => [p.id, p.name])),
    winRule: state.winRule,
    setsToWin: rules.setsToWin,
    rules,
  });

  state.players.forEach(p => {
    const dealt = [];
    for (let i=0; i<5; i++) {
      if (state.deck.length) { const card = state.deck.pop(); p.hand.push(card); dealt.push(card); }
    }
    emit(state, 'deal', { to: p.id, count: dealt.length, cards: dealt.map(publicCard) });
  });

  state._handSnapshot = totalHandCards(state);
  state._idleTurns = 0;
  emit(state, 'turn_start', { actor: currentPlayer(state).id, plays: state.playsRemaining, finalApproach: false });
  drawCards(state);   // turn 1 auto-draws like every other turn (see beginTurn)

  return state;
}

function currentPlayer(state) {
  return state.players[state.currentPlayerIndex];
}

function getPlayer(state, id) {
  return state.players.find(p => p.id === id);
}

// The RAINBOW wild — the zero-value "any" wild. It is the one card Hasbro's current
// printings single out by name, so it gets a name here rather than an inline colours test.
function isRainbowWild(card) {
  return !!card && card.type === 'wild_property' && !!card.colors && card.colors[0] === 'any';
}

// `pureSetRequired` (lobby toggle, ON in the MD Faithful preset): a full zone only counts as
// a SET if at least one card in it is NOT a rainbow wild. Our 2-card zones make an all-rainbow
// set otherwise trivial. It is only ever a completeness question — the zone cap is unchanged.
//
// NARROWED 2026-08-08 by research. It used to demand a real `type:'property'` card, which
// also outlawed a zone filled with two-colour wilds — stricter than any edition of the
// source. Hasbro's 2025 printings split the two cards by name: two-colour wild — "You may
// make a complete player set using only these cards"; every-colour wild — "You may not make
// a complete player set using only these cards" (Monopoly Deal FIFA G3239; the Harry Potter
// cut G0717 prints the same pair). The book bans exactly one shape, and now so do we.
function zoneIsSet(player, color, cards) {
  const info = COLORS[color];
  if (!info || !cards || cards.length < info.size) return false;
  if (rulesOf(player).pureSetRequired && !cards.some(c => !isRainbowWild(c))) return false;
  return true;
}

function completedSets(player) {
  return completedColors(player).size;
}

function completedColors(player) {
  const set = new Set();
  for (const [color, cards] of Object.entries(player.properties)) {
    if (zoneIsSet(player, color, cards)) set.add(color);
  }
  return set;
}

// §3.10 FINAL APPROACH — reaching 3 sets does not win, it arms. Every set-count change
// runs through here so a player can never be armed (or un-armed) by accident.
// `byId` is whoever caused the change; null when the player did it to themselves.
function syncSets(state, player, before, byId = null) {
  const after = completedColors(player);
  // set_completed used to emit an event with no prose line, so the Mission Log could never
  // tell you an opponent had finished a set — you only found out when they hit 3.
  for (const color of after) {
    if (before.has(color)) continue;
    logLine(state, player.name + ' completed the ' + COLORS[color].name + ' set — '
      + after.size + ' of ' + setsToWinOf(state) + '.');
    emit(state, 'set_completed', { actor: player.id, color, total: after.size });
  }

  if (state.phase !== 'playing') return;
  const sets = after.size;

  // §3.10 'instant': the third set wins the moment it completes. syncSets is called from
  // every path that can change a set count — playProperty, moveProperty, payment, both
  // steals and swap — so this covers "wherever and whenever", including off-turn.
  // Nothing is ever armed, so no final_approach / final_approach_broken event can be
  // emitted and no HUD countdown can be rendered.
  if (state.winRule === 'instant') {
    if (sets >= setsToWinOf(state) && !player.eliminated) {
      finishGame(state, player.id, 'sets',
        player.name + ' wins with ' + sets + ' complete sets!');
    }
    return;
  }

  // §3.10 'mdFaithful' — win where you stand when the set completes on your OWN turn.
  // Same call sites as 'instant' above; the only difference is the seat test, which is
  // exactly the rulebook's condition. A set handed to you off-turn (a payment, a swap,
  // an opponent's steal breaking their own zone) still falls through and arms below.
  if (state.winRule === 'mdFaithful' && sets >= setsToWinOf(state) && !player.eliminated
      && currentPlayer(state).id === player.id) {
    finishGame(state, player.id, 'sets',
      player.name + ' wins with ' + sets + ' complete sets!');
    return;
  }

  if (sets >= setsToWinOf(state) && !player.finalApproach && !player.eliminated) {
    player.finalApproach = true;
    player.armedAtTurn = state.turnCounter || 0;
    const onOwnTurn = currentPlayer(state).id === player.id;
    const forecast = checkpointForecast(state, player);
    const opponents = forecast ? forecast.opponents : activeCount(state) - 1;
    logLine(state, player.name + ' is on FINAL APPROACH with ' + sets + ' sets — '
      + opponents + ' opponent turn' + (opponents === 1 ? '' : 's')
      + ' left to break it before ' + player.name + ' wins!');
    emit(state, 'final_approach', {
      actor: player.id, sets, onOwnTurn,
      turnsToCheckpoint: checkpointThreshold(state),         // deprecated, see checkpointForecast
      winRule: state.winRule,
      opponentTurnsRemaining: opponents,
      checkpointTurn: forecast ? forecast.turn : null,
    });
  } else if (sets < setsToWinOf(state) && player.finalApproach) {
    player.finalApproach = false;
    delete player.armedAtTurn;
    const by = byId && byId !== player.id ? byId : null;
    logLine(state, player.name + '\'s final approach is broken' +
      (by ? ' by ' + (getPlayer(state, by)?.name || '?') : '') + '!');
    emit(state, 'final_approach_broken', { actor: player.id, by });
  }
  // Every arming and every break can open or close a contest, so the clock is re-derived
  // here rather than at any one call site — the same reason syncSets exists at all.
  syncContest(state);
}

function activeCount(state) {
  return state.players.filter(p => !p.eliminated).length;
}

// §3.10 strict reading: a full turn cycle must pass, so every opponent gets at least one
// response turn no matter when the arming happened (mid-payment on the seat before you
// used to hand out a one-turn grace period). Re-arming resets the clock.
function turnsSinceArming(state, player) {
  if (!player || !player.finalApproach) return 0;
  return (state.turnCounter || 0) - (player.armedAtTurn || 0);
}

// How many turn ticks must pass after arming before the win can be claimed at the armed
// player's own turn start. finalApproach demands a whole cycle; mdFaithful demands only
// that this is a LATER own turn than the one the arming happened on — and under mdFaithful
// only OFF-TURN armings ever get here at all, because syncSets() finishes an own-turn
// completion where it stands.
function checkpointThreshold(state) {
  return state.winRule === 'mdFaithful' ? 1 : activeCount(state);
}

function checkpointReached(state, player) {
  return turnsSinceArming(state, player) >= checkpointThreshold(state);
}

// DEPRECATED — kept only so nothing that already reads `finalApproachIn` breaks. It counts
// raw turn ticks including the armed player's own turns and clamps at 0, so it over-reports
// by one right after an own-turn arming (says 4 when 3 opponent turns actually follow) and
// reads 0 for a whole cycle after an off-turn arming while the win is still 2 own-turns away.
// Use opponentTurnsRemaining()/checkpointTurn() instead.
function turnsUntilCheckpoint(state, player) {
  if (state.winRule === 'instant') return null;
  if (!player || !player.finalApproach) return null;
  return Math.max(0, checkpointThreshold(state) - turnsSinceArming(state, player));
}

// Honest countdown. Walks the real seat rotation forward from the current turn to the first
// own-turn start at which checkpointReached() will be true, and reports:
//   turn      — the absolute state.turnNumber of that converting turn
//   opponents — how many turns by OTHER players happen before it
// Returns null when the player is not armed. `opponents === 0` means the next turn to start
// is the armed player's own converting turn.
function checkpointForecast(state, player) {
  if (state.winRule === 'instant') return null;    // there is no checkpoint to forecast
  if (!player || !player.finalApproach || player.eliminated) return null;
  const active = state.players.filter(p => !p.eliminated);
  const n = active.length;
  if (n === 0) return null;
  const seat = active.findIndex(p => p.id === player.id);
  if (seat < 0) return null;
  const cur = Math.max(0, active.findIndex(p => p.id === currentPlayer(state).id));
  const armedAt = player.armedAtTurn || 0;
  const now = state.turnCounter || 0;
  const need = checkpointThreshold(state);

  // Steps ahead (in turns) at which this player's own turns start. 0 would be the turn that
  // is already running and has already been evaluated, so start the search after it.
  let step = (seat - cur + n) % n;
  if (step === 0) step = n;
  for (let own = 0; own < n + 2; own++, step += n) {
    if (now + step - armedAt >= need) {
      return { turn: now + step, opponents: step - (own + 1) };
    }
  }
  return null;
}

function opponentTurnsRemaining(state, player) {
  const f = checkpointForecast(state, player);
  return f ? f.opponents : null;
}

function armedPlayers(state) {
  return state.players.filter(p => p.finalApproach && !p.eliminated).map(p => p.id);
}

/* ── §3.10b contested approach ───────────────────────────────────────── */

function suddenDeathOf(state) {
  return rulesFor(state).suddenDeath || DEFAULT_SUDDEN_DEATH;
}

// The contest clock. Stamped the first time TWO seats are armed at once, and cleared the
// moment the field drops back to one — so re-contesting restarts the count exactly the way
// re-arming restarts armedAtTurn. Called from syncSets (a set changed hands) and beginTurn
// (a turn ticked), which are the only two ways the answer can change.
function syncContest(state) {
  if (suddenDeathOf(state) === 'off') return;
  if (state.phase !== 'playing') return;
  const armed = armedPlayers(state);
  if (armed.length >= 2) {
    if (state._contestedSince === undefined) {
      state._contestedSince = state.turnCounter || 0;
      logLine(state, 'CONTESTED FINAL APPROACH — ' + armed.length + ' players are armed. '
        + 'Nobody converts while the approach is contested.');
      emit(state, 'contest_open', {
        actors: armed, mode: suddenDeathOf(state),
        lapCap: CONTEST_LAP_CAP, bar: contestBar(state),
      });
    }
  } else if (state._contestedSince !== undefined) {
    delete state._contestedSince;
    logLine(state, 'The final approach is no longer contested.');
    emit(state, 'contest_closed', { actors: armed });
  }
}

function contestOpen(state) {
  return state._contestedSince !== undefined;
}

// Turns spent contested, expressed in LAPS so it means the same thing at every seat count —
// one lap is one turn for every active player.
function contestLaps(state) {
  if (!contestOpen(state)) return 0;
  return ((state.turnCounter || 0) - state._contestedSince) / Math.max(1, activeCount(state));
}

// The number of sets a CONVERSION needs right now. Only 'escalate' moves it, and only while
// the contest is live and inside its lap cap — once the cap expires the bar drops back so
// the fall-through to turn order can actually fire.
function contestBar(state) {
  const base = setsToWinOf(state);
  if (suddenDeathOf(state) !== 'escalate') return base;
  if (!contestOpen(state) || contestLaps(state) >= CONTEST_LAP_CAP) return base;
  return base + 1;
}

/**
 * Is `player`'s checkpoint suspended by a contested approach?
 * @returns {null|{reason:string, bar:number, laps:number}} null means convert normally.
 */
function contestBlocks(state, player) {
  const mode = suddenDeathOf(state);
  if (mode === 'off' || !contestOpen(state)) return null;
  const laps = contestLaps(state);
  if (mode === 'escalate') {
    // Pulling ahead beats waiting: reach the raised bar ALONE and the contest is over.
    const bar = contestBar(state);
    const sets = completedSets(player);
    if (sets >= bar && !state.players.some(p =>
      p.id !== player.id && !p.eliminated && completedSets(p) >= bar)) return null;
    if (laps >= CONTEST_LAP_CAP) return null;      // cap expired — turn order resolves it
    return { reason: 'escalate', bar, laps };
  }
  if (mode === 'oneLap') {
    if (laps >= 1) return null;                    // one lap served — turn order resolves it
    return { reason: 'oneLap', bar: setsToWinOf(state), laps };
  }
  // 'points' — never resolves by turn order; endTurn() ends the game on §3.6 at the cap.
  return { reason: 'points', bar: setsToWinOf(state), laps };
}

// The one and only win-by-sets resolution point: the armed player's own turn start.
function resolveFinalApproach(state, player) {
  if (state.phase !== 'playing') return false;
  if (state.winRule === 'instant') return false;   // nothing is ever armed under 'instant'
  if (!player || player.eliminated || !player.finalApproach) return false;
  const sets = completedSets(player);
  if (sets < setsToWinOf(state)) { player.finalApproach = false; delete player.armedAtTurn; return false; }
  if (!checkpointReached(state, player)) {
    // The table has not answered yet. This is the exact moment a real player reported as
    // "I had 3 sets, I finished my turn, and someone else won" — an off-turn arming under
    // the strict full-cycle rule does NOT convert at your very next own turn. Say so out
    // loud instead of starting the turn in silence.
    //
    // ANNOUNCED AT MOST ONCE PER TURN, PER SEAT. This function is a QUERY that anything may
    // ask (checkWin() is literally an alias for it), but the sentence and the event are a
    // NARRATION, and a narration that fires per call is a narration that lies about how many
    // times the thing happened. Measured: beginTurn() resolves at turn start and then
    // drawCards() asks again through checkWin() — two `final_approach_pending` events and two
    // identical log lines for one checkpoint, doubled in the live feed and in the journal.
    // Gating on turnCounter keeps the safety-net call harmless for every caller, present and
    // future, instead of making the invariant "nobody may ask twice".
    const stamp = (state.turnCounter || 0) + ':' + player.id;
    if (state._faPendingStamp === stamp) return false;
    state._faPendingStamp = stamp;
    const forecast = checkpointForecast(state, player);
    logLine(state, player.name + ' is still on FINAL APPROACH — the win locks in at the'
      + ' start of their turn on turn ' + (forecast ? forecast.turn : '?')
      + ', not this one.');
    emit(state, 'final_approach_pending', {
      actor: player.id,
      sets,
      checkpointTurn: forecast ? forecast.turn : null,
      opponentTurnsRemaining: forecast ? forecast.opponents : null,
    });
    return false;
  }
  // §3.10b — the checkpoint is reached, but the approach may be CONTESTED. Announced at
  // most once per turn per seat for exactly the reason the pending narration above is:
  // this function is a query anything may ask, and a narration that fires per call lies
  // about how many times the thing happened.
  const blocked = contestBlocks(state, player);
  if (blocked) {
    const stamp = 'c' + (state.turnCounter || 0) + ':' + player.id;
    if (state._faContestStamp !== stamp) {
      state._faContestStamp = stamp;
      logLine(state, player.name + ' reached the checkpoint, but the final approach is '
        + 'CONTESTED — ' + (blocked.reason === 'escalate'
          ? 'the bar is now ' + blocked.bar + ' sets.'
          : 'nobody converts until one approach is broken.'));
      emit(state, 'contest_held', {
        actor: player.id, sets, reason: blocked.reason, bar: blocked.bar,
        laps: Math.floor(blocked.laps), lapCap: CONTEST_LAP_CAP,
      });
    }
    return false;
  }
  return finishGame(state, player.id, 'sets',
    player.name + ' held the final approach and wins with ' + sets + ' complete sets!');
}

// Owner directive 2026-08-06: the turn draw is AUTOMATIC. The engine performs it here, at
// turn start, for every seat — human, bot or absent — so no client command is needed and no
// client can desync on it. drawCards() is unchanged (2 cards, or 5 on an empty hand) and
// still emits the `draw` event in the same position, right after `turn_start`.
//
// turnPhase 'draw' is NOT removed: it is the guard that makes drawCards() idempotent, and
// every draw-phase check in the engine/server still reads it. It now exists only for the
// instant between `turn_start` and the automatic draw *inside this same synchronous call*,
// so it is never observable in a broadcast (a turn is always broadcast as 'play').
function beginTurn(state) {
  state.turnCounter = (state.turnCounter || 0) + 1;
  state.turnPhase = 'draw';
  state.playsRemaining = 3;
  state.rearrangesRemaining = REARRANGE_BUDGET;
  const p = currentPlayer(state);
  emit(state, 'turn_start', { actor: p.id, plays: state.playsRemaining, finalApproach: !!p.finalApproach });
  // The contest clock is measured in turns, so a turn ticking is the other way its answer
  // can change. Re-derived BEFORE the checkpoint is evaluated, or a lap cap that expired on
  // this very turn would not be seen until the next one.
  syncContest(state);
  if (resolveFinalApproach(state, p)) return true;   // won at the checkpoint; no draw
  drawCards(state);
  return false;
}

function finishGame(state, winnerId, reason, endLine) {
  if (state.phase !== 'playing') return false;
  state.phase = 'finished';
  state.winner = winnerId;
  state.endReason = reason;
  state.turnPhase = 'finished';
  state.pendingAction = null;
  logLine(state, endLine);
  const winner = winnerId ? getPlayer(state, winnerId) : null;
  const sets = winner ? completedSets(winner) : 0;
  if (reason === 'stalemate') {
    emit(state, 'stalemate', {
      winner: winnerId, sets,
      reason: state._stalemateReason || 'deck_dry',
      basis: state._stalemateBasis || null,   // 'sets' | 'net_worth' | 'turn_order' | 'unopposed'
    });
  }
  else emit(state, 'win', { actor: winnerId, sets, reason, winRule: state.winRule });
  return true;
}

// Kept as the public name for "does this player win right now?" — under §3.10 that is
// only ever true at their own turn start while still armed.
function checkWin(state, playerId) {
  if (state.phase !== 'playing') return state.winner === playerId;
  return resolveFinalApproach(state, getPlayer(state, playerId));
}

function isSetComplete(player, color) {
  return zoneIsSet(player, color, player.properties[color] || []);
}

// §3.5 — a color zone holds at most `set size` property cards.
function zoneCount(player, color) { return (player.properties[color] || []).length; }
function zoneFull(player, color) {
  const info = COLORS[color];
  return !info || zoneCount(player, color) >= info.size;
}

// Midnight Requisition and TDY Orders may not touch a complete SET (their own card text).
// Expressed as "not a set" rather than `n < size` so it stays correct under
// pureSetRequired, where a full zone of nothing but wilds is not a set and IS fair game.
function zoneRequisitionable(player, color) {
  if (!COLORS[color]) return false;
  return zoneCount(player, color) > 0 && !isSetComplete(player, color);
}

function legalColorsFor(card) {
  if (card.type === 'property') return [card.color];
  if (!card.colors) return [];
  return card.colors[0] === 'any' ? Object.keys(COLORS) : card.colors;
}

// Involuntary transfer (payment / steal / swap). §3.5 says a colour zone never holds more
// than `set size` cards, so this is the ONLY door into player.properties for a card the
// player did not choose to play, and it must never overflow a zone.
//
// It used to fall back to `ordered[0]` when every legal zone was full, which overflowed a
// zone in 549 of 400 measured bot games (1.4/game). That made zoneRequisitionable()'s
// `n !== size` test true for an overfull *complete* set, so Midnight Requisition could
// steal out of a complete set — contradicting its own card text — and it gave overfull
// zones free armour. When no legal zone has room the card is banked instead: its value is
// preserved and payable, but it stops being a property. Returns the destination zone, or
// the string 'bank'.
const BANK_ZONE = 'bank';

// Frees one slot in the first of `ordered` that holds a relocatable wild. Returns the
// colour that now has room, or null. Never changes any zone's completeness: the wild
// leaves the zone the incoming card is about to fill.
function shiftWildToMakeRoom(state, player, ordered) {
  for (const color of ordered) {
    if (!COLORS[color]) continue;
    const zone = player.properties[color] || [];
    for (let i = 0; i < zone.length; i++) {
      const occupant = zone[i];
      if (occupant.type !== 'wild_property') continue;
      const alt = legalColorsFor(occupant)
        .find(c => c !== color && COLORS[c] && !zoneFull(player, c));
      if (!alt) continue;
      zone.splice(i, 1);
      if (!player.properties[alt]) player.properties[alt] = [];
      occupant.placedColor = alt;
      player.properties[alt].push(occupant);
      logLine(state, player.name + ' shifts ' + occupant.name + ' to ' + COLORS[alt].name + ' to make room.');
      emit(state, 'move_property', {
        actor: player.id, card: publicCard(occupant), from: color, to: alt, forced: true,
      });
      return color;
    }
  }
  return null;
}

function receiveProperty(state, player, card, preferredColor) {
  const legal = legalColorsFor(card);
  const ordered = [];
  if (preferredColor && legal.includes(preferredColor)) ordered.push(preferredColor);
  for (const color of legal.slice().sort((a, b) => zoneCount(player, b) - zoneCount(player, a))) {
    if (!ordered.includes(color)) ordered.push(color);
  }
  let dest = ordered.find(color => COLORS[color] && !zoneFull(player, color));
  // Before giving up on a zone, try the rearrange the owner could legally make themselves
  // (§3.8): a wild parked in a full zone often has another colour it can sit in. Sliding it
  // over leaves the zone count unchanged, so it breaks nothing, and it keeps the incoming
  // card a property. Without this step the bank fallback fired 0.9x/game and pushed the
  // stalemate rate from 0.54% to 1.79% over 2,400 games.
  if (!dest) dest = shiftWildToMakeRoom(state, player, ordered);
  if (!dest) {
    delete card.placedColor;
    player.bank.push(card);
    logLine(state, player.name + ' has no room for ' + card.name + ' — it is banked as ' + card.value + 'M.');
    emit(state, 'banked_property', { actor: player.id, card: publicCard(card) });
    return BANK_ZONE;
  }
  if (!player.properties[dest]) player.properties[dest] = [];
  card.placedColor = dest;
  player.properties[dest].push(card);
  return dest;
}

function calcRent(player, color) {
  const info = COLORS[color];
  if (!info) return 0;
  const count = (player.properties[color] || []).length;
  if (count === 0) return 0;
  let rent = info.rent[Math.min(count, info.rent.length) - 1];
  const upgrades = upgradeKinds(player, color);
  if (upgrades.includes('house')) rent += 3;
  if (upgrades.includes('hotel')) rent += 4;
  return rent;
}

// Value a player can actually hand over. Upgrades are never payable (§3.7).
// §3.1b (2026-08-06) — upgrades ARE payable now ("all cards except the 2 Wild Property
// cards have cash value and may be used to pay debts"). This supersedes §3.7's "off-limits
// as payment" half and closes the HUD lie: net worth used to count upgrade value while
// payableCards() excluded it, so the panel showed money that could not be spent.
function playerTotalValue(player) {
  let total = 0;
  player.bank.forEach(c => total += c.value);
  for (const cards of Object.values(player.properties))
    cards.forEach(c => total += c.value);
  total += playerUpgradeValue(player);
  return total;
}

function playerUpgradeValue(player) {
  let total = 0;
  for (const upgrades of Object.values(player.upgrades || {}))
    for (const u of upgrades) total += (u && typeof u === 'object' ? u.value : 0) || 0;
  return total;
}

// Net worth and payable value are now the same number, by design.
function playerNetWorth(player) {
  return playerTotalValue(player);
}

function payableCards(player) {
  const out = [];
  player.bank.forEach(c => out.push(c));
  for (const cards of Object.values(player.properties)) cards.forEach(c => out.push(c));
  for (const upgrades of Object.values(player.upgrades || {})) {
    for (const u of upgrades) if (u && typeof u === 'object') out.push(u);
  }
  return out;
}

function totalHandCards(state) {
  return state.players.reduce((sum, p) => sum + p.hand.length, 0);
}

function ensurePlaying(state) {
  return state?.phase === 'playing' ? null : { error: 'Game is already finished' };
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function findProperty(player, cardId) {
  for (const [color, cards] of Object.entries(player.properties || {})) {
    const index = cards.findIndex(c => c.id === cardId);
    if (index >= 0) return { color, index, card: cards[index] };
  }
  return null;
}

// The OPSEC-block line used to read "Action blocked by OPSEC — X is safe.", naming neither
// the attacker nor what was blocked; in a Roll Call chain a player could not tell which of
// three demands died.
const ACTION_LABELS = {
  inspector_general: 'Inspector General',
  midnight_requisition: 'Midnight Requisition',
  tdy_orders: 'TDY Orders',
  finance_office: 'Finance Office',
  roll_call: 'Roll Call',
  chud: 'THE CHUD CARD',
  rent: 'rent charge',
  upgrade: 'Upgrade',
  foc: 'Full Operational Capability',
  surge_ops: 'Surge Operations',
  pcs_orders: 'PCS Orders',
};
function actionLabel(action) { return ACTION_LABELS[action] || action || 'action'; }

function upgradeKinds(player, color) {
  return (player.upgrades[color] || []).map(upgrade =>
    typeof upgrade === 'string' ? upgrade : upgrade.upgradeType
  );
}

// A set carries at most one Upgrade and one FOC. Seizing an upgraded set used to concatenate
// blindly, producing ["house","house","hotel"] in 0.5% of 6,000 games — calcRent counts each
// kind once, so the surplus was dead value AND a second "house" permanently blocked FOC.
// Surplus is BANKED to the seizing player via bankUpgradeCard() below (§3.1b — an upgrade
// that leaves a set goes to a bank, never the discard); card conservation is preserved.
function mergeUpgrades(state, player, color, incoming) {
  const list = player.upgrades[color] || (player.upgrades[color] = []);
  for (const upgrade of incoming || []) {
    const kind = typeof upgrade === 'string' ? upgrade : upgrade?.upgradeType;
    if (upgradeKinds(player, color).includes(kind)) {
      bankUpgradeCard(state, player, upgrade, color);
      continue;
    }
    list.push(upgrade);
  }
  if (list.length === 0) delete player.upgrades[color];
}

// §3.1b — an upgrade that leaves a set goes to the OWNER'S BANK, never the discard
// (Hasbro CS: "those houses and hotels have to go into your bank").
//
// The trap: a banked upgrade still carries `upgradeType`, and publicCard() copies it — the
// client would render a house sitting in a bank. Both tags are stripped on the way out, so
// what lands in the bank is an ordinary action card worth its face value.
function bankUpgradeCard(state, player, upgrade, color) {
  if (!upgrade || typeof upgrade !== 'object') return null;
  delete upgrade.upgradeType;
  delete upgrade.placedColor;
  player.bank.push(upgrade);
  emit(state, 'upgrade_banked', {
    actor: player.id, color, card: publicCard(upgrade),
  });
  return upgrade;
}

function bankUpgrades(state, player, color) {
  const upgrades = player.upgrades[color] || [];
  if (upgrades.length) {
    for (const upgrade of upgrades) bankUpgradeCard(state, player, upgrade, color);
    logLine(state, player.name + '\'s ' + (COLORS[color]?.name || color)
      + ' set broke — its upgrades go to the bank.');
  }
  delete player.upgrades[color];
}

// FOC may not stand without an Upgrade beneath it. Called after anything removes an
// upgrade from a set so a lone hotel can never keep paying +4M rent.
//
// THIS COSTS THE PLAYER RENT AND IT USED TO DO IT IN SILENCE. Measured: a complete Command
// set carrying Upgrade + FOC charges 15M; pay a 2M Roll Call with the Upgrade alone and the
// FOC follows it off the set, into your own bank — the set is still complete, but rent is
// 8M. Two cards left the board for a 2M demand and nothing said so. bankUpgradeCard() emits
// `upgrade_banked`, but bankUpgrades() (the set-broke path) was the only one that also wrote
// a LINE, so the log read "paid 3M" and stopped. It says it now, and the client's payment
// prompt warns BEFORE the tap (ui/prompt.js focWarning) — the only moment it can be avoided.
function normalizeUpgrades(state, player, color) {
  const kinds = upgradeKinds(player, color);
  if (!kinds.includes('hotel') || kinds.includes('house')) return;
  const list = player.upgrades[color] || [];
  let banked = 0;
  for (const upgrade of list.slice()) {
    if ((upgrade?.upgradeType) !== 'hotel') continue;
    list.splice(list.indexOf(upgrade), 1);
    bankUpgradeCard(state, player, upgrade, color);
    banked++;
  }
  if (banked) {
    logLine(state, player.name + '\'s ' + (COLORS[color]?.name || color)
      + ' FOC lost the Upgrade under it and goes to the bank — the set keeps standing, '
      + 'the rent does not.');
  }
  if (list.length === 0) delete player.upgrades[color];
}

function recordCardPlay(state, playerId) {
  state.stats.cardsPlayed[playerId] = (state.stats.cardsPlayed[playerId] || 0) + 1;
}

function recordStolenProperties(state, playerId, count) {
  state.stats.propertiesStolen[playerId] = (state.stats.propertiesStolen[playerId] || 0) + count;
}

function validateState(state) {
  const ids = [];
  const addCards = cards => {
    for (const card of cards || []) {
      if (card && Number.isInteger(card.id)) ids.push(card.id);
    }
  };
  addCards(state.deck);
  addCards(state.discardPile);
  for (const player of state.players || []) {
    addCards(player.hand);
    addCards(player.bank);
    for (const cards of Object.values(player.properties || {})) addCards(cards);
    for (const upgrades of Object.values(player.upgrades || {})) addCards(upgrades);
  }
  if (hasDuplicates(ids)) return { error: 'Duplicate card IDs detected' };
  if (Number.isInteger(state.cardTotal) && ids.length !== state.cardTotal) {
    return { error: `Card conservation failed: expected ${state.cardTotal}, found ${ids.length}` };
  }
  if (state.pendingAction && state.turnPhase !== 'action_response') {
    return { error: 'Pending action requires action_response phase' };
  }
  // §3.5 zone cap as a hard invariant. steal_set used to bypass receiveProperty() and
  // 59.8% of 600 bot games ended up with an over-cap zone (worst: base 7/4), which in turn
  // made a complete set requisitionable. Asserting it here means it cannot regress silently.
  for (const player of state.players || []) {
    for (const [color, cards] of Object.entries(player.properties || {})) {
      const info = COLORS[color];
      if (!info) return { error: `Unknown property zone "${color}"` };
      if ((cards || []).length > info.size) {
        return { error: `Zone cap exceeded: ${player.name}'s ${color} holds ${cards.length}/${info.size}` };
      }
    }
    for (const [color, upgrades] of Object.entries(player.upgrades || {})) {
      const kinds = (upgrades || []).map(u => (typeof u === 'string' ? u : u?.upgradeType));
      if (new Set(kinds).size !== kinds.length) {
        return { error: `Duplicate upgrades on ${player.name}'s ${color}: ${kinds.join(',')}` };
      }
    }
  }
  return { ok: true };
}

/* ── Draw phase ──────────────────────────────────────────────────────── */

function reshuffleDiscard(state) {
  if (state.discardPile.length === 0) return false;
  state.deck = shuffle([...state.deck, ...state.discardPile], rngOf(state));
  state.discardPile = [];
  state.shuffleCount = (state.shuffleCount || 0) + 1;
  logLine(state, 'Deck reshuffled from discard pile.');
  emit(state, 'shuffle', { deckCount: state.deck.length, cycle: state.shuffleCount });
  return true;
}

// `playerId` is optional so the bot/sim callers keep working, but when it is supplied the
// turn is checked here. These guards used to live only in server/handlers.js ('draw' case);
// any other caller could set turnPhase='play' on top of a live pendingAction, which is the
// exact orphan state server/broadcast.js treats as fatal and stops the game for.
function drawCards(state, playerId) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = currentPlayer(state);
  if (playerId !== undefined && p.id !== playerId) return { error: 'Not your turn' };
  if (p.eliminated) return { error: 'Eliminated players cannot draw' };
  if (state.pendingAction) return { error: 'Resolve pending action first' };
  // The turn draw is automatic (see beginTurn), so a `draw` command from an old client or a
  // reconnect race always lands here. `alreadyDrawn` lets the handler treat it as a silent
  // no-op instead of an error, and makes a second draw impossible.
  if (state.turnPhase !== 'draw') return { error: 'Not draw phase', alreadyDrawn: true };

  // SAFETY NET, not the resolution point. beginTurn() calls resolveFinalApproach() before it
  // calls this function, and startGame()'s turn-1 draw runs before syncSets() can arm anybody,
  // so every path into drawCards() has already resolved. It is kept because `autoWin` is still
  // part of this function's contract (server/handlers.js 'draw' reads it to stop the turn
  // clock) and because a future caller that draws without begining a turn would otherwise skip
  // the checkpoint entirely. It can no longer DOUBLE-NARRATE: resolveFinalApproach() stamps
  // its "still on final approach" announcement with the turn, so asking twice is silent.
  if (checkWin(state, p.id)) return { ok: true, autoWin: true };

  const count = p.hand.length === 0 ? 5 : 2;

  if (state.deck.length < count) reshuffleDiscard(state);

  const drawn = [];
  for (let i = 0; i < count && state.deck.length > 0; i++) {
    const card = state.deck.pop();
    p.hand.push(card);
    drawn.push(card);
  }
  state.turnPhase = 'play';
  state.playsRemaining = 3;
  state._handSnapshot = totalHandCards(state);
  logLine(state, p.name + ' drew ' + drawn.length + ' cards.');
  emit(state, 'draw', { to: p.id, count: drawn.length, cards: drawn.map(publicCard) });
  return drawn;
}

/* ── Play card actions ───────────────────────────────────────────────── */

function playAsMoney(state, playerId, cardIndex) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase !== 'play') return { error: 'Cannot play now' };
  if (state.playsRemaining <= 0) return { error: 'No plays remaining' };
  if (cardIndex < 0 || cardIndex >= p.hand.length) return { error: 'Invalid card' };
  const card = p.hand[cardIndex];
  if (card.type === 'property' || card.type === 'wild_property') return { error: 'Properties cannot be banked' };

  p.hand.splice(cardIndex, 1);
  p.bank.push(card);
  state.playsRemaining--;
  recordCardPlay(state, playerId);
  logLine(state, p.name + ' banked ' + card.name + ' (' + card.value + 'M)');
  emit(state, 'play_money', { actor: playerId, card: publicCard(card) });
  return { ok: true, card };
}

function playProperty(state, playerId, cardIndex, targetColor) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase !== 'play') return { error: 'Cannot play now' };
  if (state.playsRemaining <= 0) return { error: 'No plays remaining' };

  const card = p.hand[cardIndex];
  if (!card) return { error: 'Invalid card' };
  if (card.type !== 'property' && card.type !== 'wild_property') return { error: 'Not a property card' };

  let color;
  if (card.type === 'property') {
    color = card.color;
  } else {
    if (!targetColor) return { error: 'Choose a color for the wild property' };
    if (!COLORS[targetColor]) return { error: 'Invalid property color' };
    if (card.colors[0] !== 'any' && !card.colors.includes(targetColor))
      return { error: 'Wild cannot be placed on ' + targetColor };
    color = targetColor;
  }
  if (zoneFull(p, color))
    return { error: COLORS[color].name + ' already holds a full set (' + COLORS[color].size + ')' };

  const before = completedColors(p);
  p.hand.splice(cardIndex, 1);
  if (!p.properties[color]) p.properties[color] = [];
  const placed = { ...card, placedColor: color };
  p.properties[color].push(placed);
  state.playsRemaining--;
  recordCardPlay(state, playerId);
  logLine(state, p.name + ' played ' + card.name + ' on ' + COLORS[color].name);
  emit(state, 'play_property', { actor: playerId, card: publicCard(placed), color });
  syncSets(state, p, before);
  return { ok: true, card: placed };
}

function startPending(state, base, targetIds) {
  state.pendingAction = {
    ...base,
    targetId: targetIds.length === 1 ? targetIds[0] : undefined,
    targets: targetIds.map(id => ({ id, depth: 0, responderId: id })),
  };
  state.turnPhase = 'action_response';
  return state.pendingAction;
}

// §3.3 — Surge Ops doubles the NEXT charge of any kind this turn.
// §3.1c — Surge Ops follows Double The Rent: it STACKS (two copies = x4, spending two of
// your three plays) and applies to RENT ONLY. Both were backwards: it was a single boolean
// and it doubled Finance Office and Roll Call too. `state._surgeOps` is now a counter and
// only the rent branch passes surgeable:true.
function chargeAmount(state, base, { surgeable = false } = {}) {
  const stack = state._surgeOps || 0;
  if (!surgeable || stack <= 0) return { amount: base, doubled: false, multiplier: 1, surges: 0 };
  delete state._surgeOps;
  const multiplier = 2 ** stack;
  return { amount: base * multiplier, doubled: true, multiplier, surges: stack };
}

function playAction(state, playerId, cardIndex, opts) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase !== 'play') return { error: 'Cannot play now' };
  if (state.playsRemaining <= 0) return { error: 'No plays remaining' };

  const card = p.hand[cardIndex];
  if (!card) return { error: 'Invalid card' };
  if (card.type !== 'action' && card.type !== 'rent') return { error: 'Not an action/rent card' };

  const action = card.action || 'rent';
  const targetId = opts?.targetId;
  const targetColor = opts?.targetColor;
  const targetCardId = opts?.targetCardId;

  const spend = () => {
    p.hand.splice(cardIndex, 1);
    state.playsRemaining--;
    recordCardPlay(state, playerId);
    emit(state, 'play_action', { actor: playerId, card: publicCard(card), action });
  };
  const discardAndSpend = () => { spend(); state.discardPile.push(card); };

  switch (action) {
    case 'pcs_orders': {
      discardAndSpend();
      if (state.deck.length < 2) reshuffleDiscard(state);
      const drawn = [];
      for (let i=0; i<2 && state.deck.length > 0; i++) {
        const d = state.deck.pop(); p.hand.push(d); drawn.push(d);
      }
      state._handSnapshot = totalHandCards(state);
      // `passGoRestartsTurn` (lobby toggle, ON in the Blitz preset): the popular speed house
      // rule — PCS Orders draws 2 AND hands back a full set of three plays.
      const restart = rulesFor(state).passGoRestartsTurn;
      if (restart) state.playsRemaining = 3;
      logLine(state, p.name + ' played PCS Orders — drew ' + drawn.length + ' cards'
        + (restart ? ' and restarts the turn with 3 plays!' : ''));
      emit(state, 'draw', { to: playerId, count: drawn.length, cards: drawn.map(publicCard) });
      if (restart) emit(state, 'turn_restart', { actor: playerId, plays: state.playsRemaining });
      return { ok: true, card, drawn };
    }

    case 'finance_office': {
      if (!targetId) return { error: 'Choose a player to collect from' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      discardAndSpend();
      // §3.1c: never surgeable, so `multiplier` here is always 1 — which is exactly what the
      // client needs to be TOLD, rather than left to infer from a bare `doubled:false`.
      const { amount, doubled, multiplier } = chargeAmount(state, 5);
      startPending(state, {
        type: 'payment', action: 'finance_office',
        sourceId: p.id, amount, doubled, multiplier,
      }, [target.id]);
      logLine(state, p.name + ' demands ' + amount + 'M from ' + target.name + ' (Finance Office)'
        + (doubled ? ' — SURGED x' + multiplier : ''));
      emit(state, 'demand', {
        actor: p.id, target: target.id, amount, reason: 'finance_office', doubled, multiplier,
      });
      return { ok: true, card, pending: true };
    }

    case 'roll_call': {
      discardAndSpend();
      const targets = state.players.filter(x => x.id !== p.id && !x.eliminated);
      const { amount, doubled, multiplier } = chargeAmount(state, 2);   // §3.1c: never surgeable
      startPending(state, {
        type: 'payment', action: 'roll_call',
        sourceId: p.id, amount, doubled, multiplier,
      }, targets.map(t => t.id));
      logLine(state, p.name + ' calls Roll Call — everyone pays ' + amount + 'M!');
      for (const t of targets) {
        emit(state, 'demand', {
          actor: p.id, target: t.id, amount, reason: 'roll_call', doubled, multiplier,
        });
      }
      return { ok: true, card, pending: true };
    }

    case 'inspector_general': {
      if (!targetId || !targetColor) return { error: 'Choose a player and a complete set to seize' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      if (!isSetComplete(target, targetColor)) return { error: 'That set is not complete' };
      discardAndSpend();
      startPending(state, {
        type: 'steal_set', action: 'inspector_general',
        sourceId: p.id, color: targetColor,
      }, [target.id]);
      logLine(state, p.name + ' plays Inspector General on ' + target.name + '\'s ' + COLORS[targetColor].name + ' set!');
      return { ok: true, card, pending: true };
    }

    case 'midnight_requisition': {
      if (!targetId || targetCardId == null) return { error: 'Choose a player and a property to requisition' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      let foundColor = null;
      for (const [col, cards] of Object.entries(target.properties)) {
        if (!zoneRequisitionable(target, col)) continue;
        if (cards.some(c => c.id === targetCardId)) { foundColor = col; break; }
      }
      if (!foundColor) return { error: 'Cannot steal from a complete set or card not found' };
      const stolenCard = target.properties[foundColor].find(c => c.id === targetCardId);
      discardAndSpend();
      startPending(state, {
        type: 'steal_property', action: 'midnight_requisition',
        sourceId: p.id, targetCardId, targetColor: foundColor,
      }, [target.id]);
      logLine(state, p.name + ' plays Midnight Requisition on ' + target.name + '\'s ' + stolenCard.name);
      return { ok: true, card, pending: true };
    }

    case 'tdy_orders': {
      if (!targetId || targetCardId == null || opts?.myCardId == null)
        return { error: 'Choose your property and a target property to swap' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      const mine = findProperty(p, opts.myCardId);
      const theirs = findProperty(target, targetCardId);
      if (!mine || !theirs) return { error: 'Selected property is no longer available' };
      // §3.1 REVERSED 2026-08-06: Hasbro FAQ answer 926 bars Forced Deal (and Sly Deal)
      // from complete sets, on BOTH sides of the trade. Leaving this unguarded gave us
      // three set-breaking cards where MD has one.
      if (!zoneRequisitionable(p, mine.color))
        return { error: 'You cannot trade a card out of one of your complete sets' };
      if (!zoneRequisitionable(target, theirs.color))
        return { error: 'TDY Orders cannot touch a complete set' };
      discardAndSpend();
      startPending(state, {
        type: 'swap', action: 'tdy_orders',
        sourceId: p.id, myCardId: opts.myCardId, targetCardId,
      }, [target.id]);
      logLine(state, p.name + ' plays TDY Orders on ' + target.name + ' — property swap!');
      return { ok: true, card, pending: true };
    }

    case 'upgrade': {
      if (!targetColor) return { error: 'Choose a complete set to upgrade' };
      if (!isSetComplete(p, targetColor)) return { error: 'Set must be complete to add Upgrade' };
      if (upgradeKinds(p, targetColor).includes('house'))
        return { error: 'Set already has an Upgrade' };
      spend();
      if (!p.upgrades[targetColor]) p.upgrades[targetColor] = [];
      const placed = { ...card, upgradeType: 'house' };
      p.upgrades[targetColor].push(placed);
      logLine(state, p.name + ' upgraded ' + COLORS[targetColor].name + ' (+3M rent)');
      emit(state, 'upgrade', { actor: playerId, color: targetColor, card: publicCard(placed) });
      return { ok: true, card };
    }

    case 'foc': {
      if (!targetColor) return { error: 'Choose a set for FOC' };
      if (!isSetComplete(p, targetColor)) return { error: 'Set must be complete' };
      if (!upgradeKinds(p, targetColor).includes('house'))
        return { error: 'Must have Upgrade before FOC' };
      if (upgradeKinds(p, targetColor).includes('hotel'))
        return { error: 'Already at FOC' };
      spend();
      const placed = { ...card, upgradeType: 'hotel' };
      p.upgrades[targetColor].push(placed);
      logLine(state, p.name + ' achieves FOC on ' + COLORS[targetColor].name + ' (+4M rent)');
      emit(state, 'upgrade', { actor: playerId, color: targetColor, card: publicCard(placed) });
      return { ok: true, card };
    }

    case 'surge_ops': {
      discardAndSpend();
      state._surgeOps = (state._surgeOps || 0) + 1;
      logLine(state, p.name + ' activates Surge Operations — the next RENT this turn is x'
        + (2 ** state._surgeOps) + '!');
      return { ok: true, card };
    }

    case 'chud': {
      if (!targetId || targetCardId == null) return { error: 'Choose a player and ANY property to commandeer' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      let chudColor = null;
      for (const [col, cards] of Object.entries(target.properties)) {
        if (cards.some(c => c.id === targetCardId)) { chudColor = col; break; }
      }
      if (!chudColor) return { error: 'Property not found on target' };
      const stolenCard = target.properties[chudColor].find(c => c.id === targetCardId);
      discardAndSpend();
      startPending(state, {
        type: 'steal_property', action: 'chud',
        sourceId: p.id, targetCardId, targetColor: chudColor,
      }, [target.id]);
      logLine(state, p.name + ' plays THE CHUD CARD on ' + target.name + '\'s ' + stolenCard.name + '!');
      return { ok: true, card, pending: true };
    }

    case 'opsec':
      return { error: 'OPSEC can only be played in response to an action' };

    default: break;
  }

  // Rent card
  if (card.type === 'rent') {
    if (!targetColor) return { error: 'Choose a color to charge rent for' };
    if (!COLORS[targetColor]) return { error: 'Invalid property color' };
    const isWildRent = card.colors[0] === 'any';
    if (!isWildRent && !card.colors.includes(targetColor))
      return { error: 'This rent card cannot be used for ' + targetColor };
    const count = (p.properties[targetColor] || []).length;
    if (count === 0) return { error: 'You have no properties of that color' };

    // §3.2 — the wild ("any") rent hits ONE chosen player; colour rents hit the table.
    let targets;
    if (isWildRent) {
      if (!targetId) return { error: 'Choose a player to charge' };
      const target = getPlayer(state, targetId);
      if (!target || target.id === p.id || target.eliminated) return { error: 'Invalid target' };
      targets = [target];
    } else {
      targets = state.players.filter(x => x.id !== p.id && !x.eliminated);
    }
    if (targets.length === 0) return { error: 'No one to charge' };

    discardAndSpend();
    const { amount, doubled, multiplier } = chargeAmount(state, calcRent(p, targetColor), { surgeable: true });
    // `multiplier` travels with the charge, on the pendingAction AND on the event. Without it
    // the only thing on the wire was `doubled`, so a x4 or x8 surge reached the client as a
    // boolean and every surface printed "x2"/"(DOUBLED)" one line under the engine's own
    // "SURGED x4" log line. 2**stack is not derivable client-side after the fact: endTurn()
    // deletes the counter, and a reconnect never saw it at all.
    startPending(state, {
      type: 'payment', action: 'rent',
      sourceId: p.id, amount, color: targetColor, doubled, multiplier, wild: isWildRent,
    }, targets.map(t => t.id));
    logLine(state, p.name + ' charges ' + amount + 'M rent on ' + COLORS[targetColor].name
      + (isWildRent ? ' from ' + targets[0].name : '')
      + (doubled ? ' — SURGED x' + multiplier : ''));
    emit(state, 'rent_charged', {
      actor: p.id, color: targetColor, amount,
      targets: targets.map(t => t.id), doubled, multiplier,
    });
    return { ok: true, card, pending: true };
  }

  return { error: 'Unknown action' };
}

/* ── Respond to action (single OPSEC mechanism) ──────────────────────── */

// Every pending action carries `targets: [{ id, depth, responderId }]`.
// depth 0  → the target must answer; accepting suffers the action.
// depth odd→ the source must answer; accepting means OPSEC stood and the action is blocked.
// depth even>0 → the target answers again (counter-counter-OPSEC), accepting suffers.
function pendingResponders(state) {
  const pa = state?.pendingAction;
  if (!pa || !pa.targets) return [];
  return pa.targets.map(t => t.responderId).filter(Boolean);
}

function pendingEntryFor(state, playerId) {
  const pa = state?.pendingAction;
  if (!pa || !pa.targets) return null;
  return pa.targets.find(t => t.responderId === playerId) || null;
}

function finishEntry(state, pa, entry) {
  if (state.pendingAction !== pa) return { ok: true };  // game ended mid-resolution
  pa.targets = pa.targets.filter(t => t !== entry);
  if (pa.targets.length === 0) {
    state.pendingAction = null;
    if (state.phase === 'playing') state.turnPhase = 'play';
    return { ok: true };
  }
  return { ok: true, morePending: true };
}

// `counterCostsPlay` (lobby toggle, ON in the MD Faithful preset). Monopoly Deal's modern
// printings charge the counter: FIFA Deal's RED CARD (G3239, the Just Say No of that cut)
// prints "If you add this card to your Bank as points OR PLAY IT AS AN ACTION CARD, it
// counts as one of the three cards you may play on your turn." Only the seat whose turn it
// is has a play budget at all, so only that seat ever pays — a defender answering on
// somebody else's turn counters for free, exactly as the card says. The bite is on the
// attacker's counter-counter, which is where OPSEC chains actually spiral.
function counterSpendsPlay(state, playerId) {
  return !!rulesFor(state).counterCostsPlay && currentPlayer(state).id === playerId;
}
function canCounter(state, playerId) {
  if (!state || !playerId) return false;
  if (!counterSpendsPlay(state, playerId)) return true;
  return (state.playsRemaining || 0) > 0;
}

function respondToAction(state, playerId, response, paymentCards) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const pa = state.pendingAction;
  if (!pa) return { error: 'No pending action' };
  const entry = pendingEntryFor(state, playerId);
  if (!entry) return { error: 'Not your turn to respond' };
  const responder = getPlayer(state, playerId);
  if (!responder) return { error: 'Player not found' };

  if (response === 'opsec') {
    const idx = responder.hand.findIndex(c => c.action === 'opsec');
    if (idx < 0) return { error: 'No OPSEC card in hand' };
    // REFUSED, not silently discounted: under `counterCostsPlay` a counter you cannot pay
    // for is not a legal answer, and the whole point of the rule is that spending your
    // third card on an attack leaves you nothing to defend the attack with.
    if (!canCounter(state, playerId)) {
      return { error: 'No plays left this turn to counter with OPSEC' };
    }
    const spendsPlay = counterSpendsPlay(state, playerId);
    const opsecCard = responder.hand.splice(idx, 1)[0];
    state.discardPile.push(opsecCard);
    if (spendsPlay) state.playsRemaining = Math.max(0, (state.playsRemaining || 0) - 1);
    entry.depth++;
    const against = playerId === pa.sourceId ? entry.id : pa.sourceId;
    entry.responderId = against;
    logLine(state, responder.name + ' plays OPSEC!'
      + (spendsPlay ? ' (one of their three plays)' : '')
      + ' ' + (getPlayer(state, against)?.name || '?') + ' can counter...');
    emit(state, 'opsec', {
      actor: playerId, against, depth: entry.depth,
      target: entry.id, action: pa.action, card: publicCard(opsecCard),
      spentPlay: spendsPlay, playsRemaining: state.playsRemaining,
    });
    return { ok: true, opsec: true, morePending: true };
  }

  if (response !== 'accept') return { error: 'Invalid response' };

  if (entry.depth % 2 === 1) {
    // The source conceded: the defender's OPSEC stands.
    const targetName = getPlayer(state, entry.id)?.name || '?';
    const sourceName = getPlayer(state, pa.sourceId)?.name || '?';
    logLine(state, targetName + '\'s OPSEC stands — ' + sourceName + '\'s '
      + actionLabel(pa.action) + ' is blocked.');
    emit(state, 'action_blocked', {
      source: pa.sourceId, target: entry.id, action: pa.action, depth: entry.depth,
    });
    return finishEntry(state, pa, entry);
  }

  return executeEntry(state, pa, entry, paymentCards);
}

function executeEntry(state, pa, entry, paymentCards) {
  const source = getPlayer(state, pa.sourceId);
  const target = getPlayer(state, entry.id);
  if (!source || !target) return finishEntry(state, pa, entry);

  switch (pa.type) {
    case 'payment': {
      const result = processPayment(state, pa, target, source, paymentCards);
      if (result.needPayment) return result;
      return finishEntry(state, pa, entry);
    }

    case 'steal_set': {
      const col = pa.color;
      const beforeSource = completedColors(source);
      const beforeTarget = completedColors(target);
      const stolen = (target.properties[col] || []).slice();
      target.properties[col] = [];
      // Route every card through receiveProperty so the §3.5 zone cap holds. Pushing
      // straight into source.properties[col] produced an over-cap zone in 36% of the
      // 549 overflow events measured across 400 bot games (worst seen: base 7/4).
      for (const card of stolen) receiveProperty(state, source, card, col);
      if (target.upgrades[col]) {
        mergeUpgrades(state, source, col, target.upgrades[col]);
        delete target.upgrades[col];
      }
      logLine(state, source.name + ' seized ' + target.name + '\'s ' + COLORS[col].name + ' set!');
      emit(state, 'set_stolen', {
        actor: source.id, from: target.id, color: col, cards: stolen.map(publicCard),
      });
      recordStolenProperties(state, source.id, stolen.length);
      syncSets(state, target, beforeTarget, source.id);
      syncSets(state, source, beforeSource);
      return finishEntry(state, pa, entry);
    }

    case 'steal_property': {
      const col = pa.targetColor;
      const beforeSource = completedColors(source);
      const beforeTarget = completedColors(target);
      const idx = (target.properties[col] || []).findIndex(c => c.id === pa.targetCardId);
      if (idx >= 0) {
        const card = target.properties[col].splice(idx, 1)[0];
        const destColor = receiveProperty(state, source, card, card.placedColor || card.color || col);
        logLine(state, source.name + (pa.action === 'chud' ? ' commandeered ' : ' requisitioned ')
          + card.name + ' from ' + target.name + (pa.action === 'chud' ? '!' : ''));
        emit(state, 'steal', {
          actor: source.id, from: target.id, card: publicCard(card),
          toColor: destColor, action: pa.action,
        });
        if (!isSetComplete(target, col)) bankUpgrades(state, target, col);
        recordStolenProperties(state, source.id, 1);
        syncSets(state, target, beforeTarget, source.id);
        syncSets(state, source, beforeSource);
      }
      return finishEntry(state, pa, entry);
    }

    case 'swap': {
      const beforeSource = completedColors(source);
      const beforeTarget = completedColors(target);
      let myCard=null, myColor=null, theirCard=null, theirColor=null;
      for (const [col, cards] of Object.entries(source.properties)) {
        const i = cards.findIndex(c => c.id === pa.myCardId);
        if (i >= 0) { myCard = cards.splice(i, 1)[0]; myColor = col; break; }
      }
      for (const [col, cards] of Object.entries(target.properties)) {
        const i = cards.findIndex(c => c.id === pa.targetCardId);
        if (i >= 0) { theirCard = cards.splice(i, 1)[0]; theirColor = col; break; }
      }
      if (myCard && theirCard) {
        const gotColor = receiveProperty(state, source, theirCard, theirCard.placedColor || theirColor);
        const gaveColor = receiveProperty(state, target, myCard, myCard.placedColor || myColor);
        logLine(state, source.name + ' swapped properties with ' + target.name);
        emit(state, 'swap', {
          actor: source.id, target: target.id,
          gave: publicCard(myCard), took: publicCard(theirCard),
          gaveColor, tookColor: gotColor,
        });
        if (!isSetComplete(source, myColor)) bankUpgrades(state, source, myColor);
        if (!isSetComplete(target, theirColor)) bankUpgrades(state, target, theirColor);
        syncSets(state, source, beforeSource, target.id);
        syncSets(state, target, beforeTarget, source.id);
      } else {
        // Restore anything we pulled out before discovering the other side was gone.
        if (myCard) receiveProperty(state, source, myCard, myColor);
        if (theirCard) receiveProperty(state, target, theirCard, theirColor);
      }
      return finishEntry(state, pa, entry);
    }
  }
  return finishEntry(state, pa, entry);
}

function processPayment(state, pa, payer, payee, selectedCardIds) {
  const payable = payableCards(payer);

  if (!selectedCardIds || !Array.isArray(selectedCardIds) || selectedCardIds.length === 0) {
    // §3.4 — "nothing to pay with" means no cards at all, not merely no *value*.
    if (payable.length === 0) {
      logLine(state, payer.name + ' has nothing to pay!');
      emit(state, 'insolvent', { from: payer.id, to: payee.id, amount: pa.amount });
      return { ok: true };
    }
    return { error: 'Select cards to pay with', needPayment: true, amount: pa.amount };
  }
  if (hasDuplicates(selectedCardIds)) {
    return { error: 'Payment cards must be unique', needPayment: true, amount: pa.amount };
  }

  let totalValue = 0;
  const bankCards = [];
  const propCards = [];
  const upgradeCards = [];   // §3.1b — upgrades are payable, so this is a third lookup

  for (const cid of selectedCardIds) {
    let found = false;
    const bi = payer.bank.findIndex(c => c.id === cid);
    if (bi >= 0) { bankCards.push({ idx: bi, card: payer.bank[bi] }); totalValue += payer.bank[bi].value; found = true; }
    if (!found) {
      for (const [col, cards] of Object.entries(payer.properties)) {
        const pi = cards.findIndex(c => c.id === cid);
        if (pi >= 0) { propCards.push({ color: col, idx: pi, card: cards[pi] }); totalValue += cards[pi].value; found = true; break; }
      }
    }
    if (!found) {
      for (const [col, upgrades] of Object.entries(payer.upgrades || {})) {
        const ui = upgrades.findIndex(c => c && c.id === cid);
        if (ui >= 0) { upgradeCards.push({ color: col, card: upgrades[ui] }); totalValue += upgrades[ui].value; found = true; break; }
      }
    }
  }
  if (bankCards.length + propCards.length + upgradeCards.length !== selectedCardIds.length) {
    return { error: 'Payment selection contains an invalid card', needPayment: true, amount: pa.amount };
  }

  // Short payments are only legal when the payer surrenders every card they own —
  // zero-value wilds included (§3.4).
  if (totalValue < pa.amount && selectedCardIds.length < payable.length) {
    return {
      error: 'You must pay at least ' + pa.amount + 'M (or surrender every card you have)',
      needPayment: true, amount: pa.amount,
    };
  }

  const beforePayee = completedColors(payee);
  const beforePayer = completedColors(payer);
  const paid = [];

  bankCards.sort((a,b) => b.idx - a.idx);
  bankCards.forEach(({ idx, card }) => {
    payer.bank.splice(idx, 1);
    payee.bank.push(card);
    paid.push(card);
  });

  // Upgrades leave first: they stop being upgrades the moment they change hands, so both
  // tags are stripped and they land in the payee's bank as ordinary cards.
  //
  // The WHOLE selection is removed before any normalisation runs, and that ordering is the
  // fix for a silent under-payment. normalizeUpgrades() used to be called per card, inside
  // this loop: paying with an Upgrade AND its FOC together removed the Upgrade, at which
  // point normalising saw a lone FOC and banked it back to the PAYER — and the FOC's own
  // iteration then found nothing (`ui < 0`) and returned. totalValue said 7M, the payee
  // received 3M, and the payer kept the card they had nominally spent. Reachable only since
  // §3.1b made upgrades payable, and only in the order Upgrade-then-FOC, which is why a
  // normal single-upgrade payment always looked correct.
  const touchedColors = new Set();
  upgradeCards.forEach(({ color, card }) => {
    const list = payer.upgrades[color] || [];
    const ui = list.findIndex(c => c && c.id === card.id);
    if (ui < 0) return;
    list.splice(ui, 1);
    if (list.length === 0) delete payer.upgrades[color];
    delete card.upgradeType;
    delete card.placedColor;
    payee.bank.push(card);
    paid.push(card);
    touchedColors.add(color);
  });
  // An FOC may not outlive its Upgrade — settled once per colour, after the whole selection
  // has been resolved, so it can only ever strand an FOC the payer actually kept.
  for (const color of touchedColors) normalizeUpgrades(state, payer, color);

  propCards.forEach(({ color, card }) => {
    const ci = payer.properties[color].findIndex(c => c.id === card.id);
    if (ci >= 0) {
      payer.properties[color].splice(ci, 1);
      receiveProperty(state, payee, card, card.placedColor || card.color || color);
      paid.push(card);
    }
    if (!isSetComplete(payer, color)) bankUpgrades(state, payer, color);
  });

  logLine(state, payer.name + ' paid ' + totalValue + 'M to ' + payee.name);
  emit(state, 'payment', {
    from: payer.id, to: payee.id, total: totalValue,
    cards: paid.map(publicCard), reason: pa.action,
  });
  state.stats.payments.count++;
  state.stats.payments.total += totalValue;
  state.stats.payments.biggest = Math.max(state.stats.payments.biggest, totalValue);
  syncSets(state, payee, beforePayee);
  syncSets(state, payer, beforePayer, payee.id);
  return { ok: true };
}

/* ── Move property (free rearrange) ─────────────────────────────────── */

function findUpgrade(player, cardId) {
  for (const [color, upgrades] of Object.entries(player.upgrades || {})) {
    const index = (upgrades || []).findIndex(u => u && u.id === cardId);
    if (index >= 0) return { color, index, card: upgrades[index] };
  }
  return null;
}

// Relocating a House/FOC between two of your own complete sets. Costs no play, like the
// wild rearrange. Refuses anything that would leave an FOC without its Upgrade.
function moveUpgrade(state, p, hit, toColor) {
  const { color: fromColor, index, card } = hit;
  const kind = card.upgradeType;
  if (fromColor === toColor) return { error: 'Already on that set' };
  if (!isSetComplete(p, toColor)) return { error: COLORS[toColor].name + ' is not a complete set' };
  if (upgradeKinds(p, toColor).includes(kind))
    return { error: COLORS[toColor].name + ' already has ' + (kind === 'hotel' ? 'an FOC' : 'an Upgrade') };
  if (kind === 'hotel' && !upgradeKinds(p, toColor).includes('house'))
    return { error: 'FOC needs an Upgrade on that set first' };
  if (kind === 'house' && upgradeKinds(p, fromColor).includes('hotel'))
    return { error: 'Move the FOC off that set first' };

  const before = completedColors(p);
  (p.upgrades[fromColor] || []).splice(index, 1);
  if ((p.upgrades[fromColor] || []).length === 0) delete p.upgrades[fromColor];
  if (!p.upgrades[toColor]) p.upgrades[toColor] = [];
  p.upgrades[toColor].push(card);

  logLine(state, p.name + ' moved ' + card.name + ' to ' + COLORS[toColor].name);
  emit(state, 'move_upgrade', {
    actor: p.id, card: publicCard(card), from: fromColor, to: toColor, upgradeType: kind,
  });
  syncSets(state, p, before);
  return { ok: true };
}

// How many free rearranges this turn still has. Missing/absent (a hand-built fixture, a
// state created before this field existed) reads as a full budget, never as zero.
function rearrangesLeft(state) {
  const left = state?.rearrangesRemaining;
  return Number.isFinite(left) ? left : REARRANGE_BUDGET;
}

function spendRearrange(state, n = 1) {
  state.rearrangesRemaining = rearrangesLeft(state) - n;
}

function moveProperty(state, playerId, cardId, toColor) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase !== 'play') return { error: 'Cannot rearrange now' };
  if (!COLORS[toColor]) return { error: 'Invalid color' };
  // The budget is checked BEFORE anything is inspected and spent only when the board
  // actually changed, so a rejected move (wrong colour, full zone, "already there") is free
  // — a player fumbling a drag never loses a rearrange, and the refusal itself is one small
  // error frame rather than a full state fan-out.
  if (rearrangesLeft(state) <= 0) {
    return { error: 'No free rearranges left this turn — end your turn to reset them' };
  }

  // §3.1b — upgrades may be moved between complete sets on your turn. Handled through the
  // same free-rearrange command so the wire protocol stays unchanged.
  const upgradeHit = findUpgrade(p, cardId);
  if (upgradeHit) {
    const upgradeRes = moveUpgrade(state, p, upgradeHit, toColor);
    if (upgradeRes.ok) spendRearrange(state);
    return upgradeRes;
  }

  // Find the card in player's properties
  let card = null, fromColor = null, fromIdx = -1;
  for (const [col, cards] of Object.entries(p.properties)) {
    const idx = cards.findIndex(c => c.id === cardId);
    if (idx >= 0) { card = cards[idx]; fromColor = col; fromIdx = idx; break; }
  }
  if (!card) return { error: 'Card not found in your properties' };
  if (fromColor === toColor) return { error: 'Already in that set' };

  // Only wild_property cards can be moved
  if (card.type !== 'wild_property') return { error: 'Only wild properties can be moved between sets' };

  // Validate the target color is valid for this wild
  if (card.colors[0] !== 'any' && !card.colors.includes(toColor))
    return { error: 'This wild cannot go on ' + COLORS[toColor].name };
  if (zoneFull(p, toColor))
    return { error: COLORS[toColor].name + ' already holds a full set (' + COLORS[toColor].size + ')' };

  const before = completedColors(p);
  p.properties[fromColor].splice(fromIdx, 1);
  if (!p.properties[toColor]) p.properties[toColor] = [];
  card.placedColor = toColor;
  p.properties[toColor].push(card);

  // Clean up upgrades if the source set is no longer complete
  if (!isSetComplete(p, fromColor)) bankUpgrades(state, p, fromColor);

  spendRearrange(state);
  logLine(state, p.name + ' moved ' + card.name + ' to ' + COLORS[toColor].name);
  emit(state, 'move_property', { actor: playerId, card: publicCard(card), from: fromColor, to: toColor });
  syncSets(state, p, before);
  return { ok: true };
}

/* ── Swap two of your own properties (§3.5 owner ruling, 2026-08-07) ──────────
 *
 * §3.5 caps a colour zone at `set size`, and that cap makes a TRUE SWAP
 * IMPOSSIBLE — not hard, impossible, in both directions. Darkblue 2/2 holding a
 * green/darkblue wild and green 3/3 holding a rainbow: each card is legal in the
 * other's zone and neither can go first, because the first move would have to
 * transit through a 3/2 or 4/3 zone that validateState() rejects outright.
 * Measured against the engine before this function existed, both orderings:
 *   moveProperty(p1, rainbow, 'darkblue') → 'Command already holds a full set (2)'
 *   moveProperty(p1, pairWild, 'green')   → 'Drone Ops already holds a full set (3)'
 *
 * The owner's ruling rejected the two cheaper fixes — a transient overfull state
 * (the invariant is worth having precisely because it holds CONTINUOUSLY) and
 * MD's second-set rule (a cross-cutting rewrite that reopens the armour exploit
 * §3.5 was added to kill) — in favour of adding the missing move: one command,
 * two cards, applied together or not at all.
 *
 * TWO PROPERTIES OF THIS OPERATION ARE WORTH STATING, because both of them are
 * why it is safe rather than why it is convenient:
 *
 *   1. NO ZONE'S COUNT CHANGES. Each zone loses one card and gains one, so the
 *      §3.5 cap is preserved BY CONSTRUCTION — there is no ordering, no
 *      intermediate, and no snapshot in which a zone is over cap, because the
 *      only state that ever exists is before and after.
 *   2. NO SET'S COMPLETION CHANGES. A swap is necessarily wild-for-wild (see
 *      below), counts are fixed, and swapping a wild for a wild cannot turn an
 *      all-wild zone into a mixed one, so `pureSetRequired` cannot flip either.
 *      syncSets() and bankUpgrades() are still called — they are the contract
 *      every board mutation honours, and a rule change that broke property 2
 *      must not silently strand an FOC — but on today's rules they are no-ops.
 *      test/property-swap.test.js asserts both properties over a matrix rather
 *      than trusting this comment.
 *
 * WILDS-ONLY, AND NOT BY FIAT. The rule below is the general one — each card
 * must be legal in the other's destination — and it COLLAPSES to wilds-only,
 * because legalColorsFor() gives a fixed property exactly one colour and that
 * colour is the zone it is already sitting in. So a fixed property is never
 * legal in another zone and can never be either half of a swap. Checked, not
 * assumed: the general predicate is what runs, and the test suite proves the
 * collapse over every fixed property in the deck.
 *
 * UPGRADES ARE OUT OF SCOPE and refused explicitly. They move under §3.1b's
 * separate rules (moveUpgrade), and no deadlock exists for them to relieve: two
 * Upgrades of the same kind are interchangeable, so trading them changes nothing
 * observable, and House↔FOC is refused on its own merits (a destination that
 * already has that kind, or an FOC left with no Upgrade beneath it).
 *
 * COST: TWO rearranges, not one. See the note over REARRANGE_BUDGET — the budget
 * bounds ACCEPTED BOARD CHANGES per turn, and this command makes two of them. At
 * one, a swap would be a half-price way to do what two moveProperty() calls do
 * whenever both orderings happen to be legal, which doubles the ceiling the
 * budget exists to impose. At two, the swap is never cheaper and never more
 * permissive than doing it in two steps — it only adds the case where NO
 * ordering exists, which is the entire reason it was ruled in.
 */
function swapProperties(state, playerId, cardIdA, cardIdB) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase !== 'play') return { error: 'Cannot rearrange now' };
  // Checked BEFORE anything is inspected and spent only when the board actually
  // changed, exactly like moveProperty(): a refused swap costs nothing.
  const left = rearrangesLeft(state);
  if (left < SWAP_COST) {
    return left <= 0
      ? { error: 'No free rearranges left this turn — end your turn to reset them' }
      : { error: 'A swap costs two free rearranges and you have one left — end your turn to reset them' };
  }

  if (cardIdA === cardIdB) return { error: 'Pick two different cards' };
  if (findUpgrade(p, cardIdA) || findUpgrade(p, cardIdB)) {
    return { error: 'An Upgrade moves on its own — it cannot trade places with a property' };
  }

  const a = findProperty(p, cardIdA);
  const b = findProperty(p, cardIdB);
  if (!a || !b) return { error: 'Card not found in your properties' };
  if (a.color === b.color) return { error: 'Those cards are already in the same set' };

  const fits = (hit, color) => {
    const card = hit.card;
    if (card.type !== 'wild_property') {
      return 'Only wild properties can move between sets';
    }
    if (!legalColorsFor(card).includes(color)) {
      return card.name + ' cannot go on ' + COLORS[color].name;
    }
    return null;
  };
  // BOTH halves are checked before EITHER is applied. That is the whole of
  // "atomic": there is no path through this function that moves one card.
  const whyA = fits(a, b.color);
  if (whyA) return { error: whyA };
  const whyB = fits(b, a.color);
  if (whyB) return { error: whyB };

  const before = completedColors(p);
  p.properties[a.color].splice(a.index, 1);
  // b's index was read before a was spliced out, and a splice in a DIFFERENT
  // array cannot move it — a.color !== b.color is guaranteed above. Re-finding
  // it here anyway would be the same answer at the cost of hiding that fact.
  p.properties[b.color].splice(b.index, 1);
  a.card.placedColor = b.color;
  b.card.placedColor = a.color;
  p.properties[b.color].push(a.card);
  p.properties[a.color].push(b.card);

  // Belt and braces (property 2 above): completion cannot change under today's
  // rules, so neither of these can fire. They are here so a future rule that
  // breaks that assumption cannot strand an FOC on a broken set in silence.
  if (!isSetComplete(p, a.color)) bankUpgrades(state, p, a.color);
  if (!isSetComplete(p, b.color)) bankUpgrades(state, p, b.color);

  spendRearrange(state, SWAP_COST);
  logLine(state, p.name + ' swapped ' + a.card.name + ' and ' + b.card.name
    + ' between ' + COLORS[a.color].name + ' and ' + COLORS[b.color].name);

  // §4: TWO `move_property` events, not a new verb — the choreographer, the sfx
  // map, the journal and the feed all already render that row, and a swap really
  // is two cards moving. `swapWith` and `swapHalf` tag them as ONE BEAT so a
  // consumer that cares can fly them together (opposite arcs, the way the `swap`
  // TDY case already does) instead of as two unrelated moves; a consumer that
  // does not care renders exactly what it rendered before, which is why both
  // cards fly under FLIP (§0.4) with no motion-agent change required.
  emit(state, 'move_property', {
    actor: playerId, card: publicCard(a.card), from: a.color, to: b.color,
    swapWith: b.card.id, swapHalf: 0,
  });
  emit(state, 'move_property', {
    actor: playerId, card: publicCard(b.card), from: b.color, to: a.color,
    swapWith: a.card.id, swapHalf: 1,
  });
  syncSets(state, p, before);
  return { ok: true };
}

/* ── Scoop (forfeit) ─────────────────────────────────────────────────── */

function scoop(state, playerId) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p) return { error: 'Player not found' };
  if (p.eliminated) return { error: 'Already eliminated' };

  const beforeScoop = completedColors(p);
  // Scooping discards EVERYTHING, so upgrades go to the discard here rather than through
  // bankUpgrades() — the bank has already been emptied and would resurrect them.
  for (const upgrades of Object.values(p.upgrades || {})) {
    for (const upgrade of upgrades) {
      if (upgrade && typeof upgrade === 'object') state.discardPile.push(upgrade);
    }
  }
  p.upgrades = {};
  while (p.hand.length > 0) state.discardPile.push(p.hand.pop());
  while (p.bank.length > 0) state.discardPile.push(p.bank.pop());
  for (const cards of Object.values(p.properties)) {
    while (cards.length > 0) state.discardPile.push(cards.pop());
  }
  p.properties = {};
  syncSets(state, p, beforeScoop);
  p.eliminated = true;

  logLine(state, p.name + ' scooped! All cards discarded.');
  emit(state, 'scoop', { actor: playerId });
  state._handSnapshot = totalHandCards(state);

  // Unwind any pending action this player is part of.
  const pa = state.pendingAction;
  if (pa) {
    if (pa.sourceId === playerId) {
      state.pendingAction = null;
      state.turnPhase = 'play';
    } else {
      pa.targets = pa.targets.filter(t => t.id !== playerId);
      if (pa.targets.length === 0) {
        state.pendingAction = null;
        state.turnPhase = 'play';
      }
    }
  }

  const wasMyTurn = currentPlayer(state).id === playerId;
  if (wasMyTurn) {
    delete state._surgeOps;
    state.pendingAction = null;
    state.turnPhase = 'draw';
    state.playsRemaining = 3;
  }

  const activePlayers = state.players.filter(x => !x.eliminated);
  if (activePlayers.length <= 1) {
    if (activePlayers.length === 1) {
      finishGame(state, activePlayers[0].id, 'last_standing',
        activePlayers[0].name + ' wins — all other players scooped!');
    }
    return { ok: true };
  }

  if (wasMyTurn) {
    advanceToNextActive(state);
    emit(state, 'turn_end', { actor: playerId });
    logLine(state, currentPlayer(state).name + '\'s turn');
    beginTurn(state);
  }

  return { ok: true };
}

function advanceToNextActive(state) {
  const n = state.players.length;
  for (let i = 0; i < n; i++) {
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % n;
    if (!state.players[state.currentPlayerIndex].eliminated) return;
  }
}

/* ── End turn ────────────────────────────────────────────────────────── */

// §3.6 — the table is dead when deck and discard are empty and a full round passes
// with no card leaving any hand. Most sets wins; net worth breaks the tie.
// Tiebreak order, stated so the log can never credit a criterion that did not decide it:
//   1. most completed sets   2. highest net worth   3. earliest seat in the turn order.
// The old line always said "wins on completed sets and net worth", which was a lie for the
// 3-way 0-sets/0M ties that seat order actually settled.
function endInStalemate(state, why = 'deck_dry') {
  const active = state.players.filter(p => !p.eliminated);
  const seatOf = new Map(state.players.map((p, i) => [p.id, i]));
  const ranked = active.slice().sort((a, b) => {
    const sets = completedSets(b) - completedSets(a);
    if (sets !== 0) return sets;
    const worth = playerNetWorth(b) - playerNetWorth(a);
    if (worth !== 0) return worth;
    return seatOf.get(a.id) - seatOf.get(b.id);
  });
  const winner = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  const cause = why === 'deck_cycles'
    ? 'The deck has been through ' + DECK_CYCLE_LIMIT + ' cycles with no one closing — '
    : why === 'contested'
      ? 'The final approach stayed contested for ' + CONTEST_LAP_CAP + ' full rounds — '
      : 'Deck and discard are empty and nobody can move — ';

  let basis = 'unopposed';
  if (winner && runnerUp) {
    const ws = completedSets(winner), rs = completedSets(runnerUp);
    const wn = playerNetWorth(winner), rn = playerNetWorth(runnerUp);
    if (ws !== rs) basis = 'sets';
    else if (wn !== rn) basis = 'net_worth';
    else basis = 'turn_order';
  }
  const phrase = {
    sets: winner ? ' wins on completed sets (' + completedSets(winner) + ').' : '',
    net_worth: winner ? ' wins on net worth (' + playerNetWorth(winner) + 'M) after tying on '
      + completedSets(winner) + ' set' + (completedSets(winner) === 1 ? '' : 's') + '.' : '',
    turn_order: winner ? ' wins on turn order — the table tied on sets AND net worth, so the'
      + ' earliest seat takes it.' : '',
    unopposed: winner ? ' wins unopposed.' : '',
  }[basis];

  state._stalemateReason = why;
  state._stalemateBasis = basis;
  finishGame(state, winner ? winner.id : null, 'stalemate',
    cause + (winner ? winner.name + phrase : 'the game is a draw.'));
}

// Recovery path for server/timers.js, server/absent.js and bot.js when endTurn() refuses
// (impossible discard, wedged phase). Those three each did their own
// `currentPlayerIndex = (i+1) % len`, which can hand the turn to an ELIMINATED seat and
// skips beginTurn(), so a final approach parked at its checkpoint would never resolve.
function forceEndTurn(state) {
  if (state.phase !== 'playing') return { error: 'Game is already finished' };
  const from = currentPlayer(state).id;
  // An orphaned pendingAction with turnPhase 'draw' is the state broadcast treats as fatal.
  if (state.pendingAction) {
    state.pendingAction = null;
    logLine(state, 'Unresolved action discarded so the table can move on.');
  }
  delete state._surgeOps;
  advanceToNextActive(state);
  state.stats.turns++;
  emit(state, 'turn_end', { actor: from });
  logLine(state, currentPlayer(state).name + '\'s turn');
  const won = beginTurn(state);
  return won ? { ok: true, win: true } : { ok: true };
}

function endTurn(state, playerId, discardIds) {
  const phaseError = ensurePlaying(state);
  if (phaseError) return phaseError;
  const p = getPlayer(state, playerId);
  if (!p || p.id !== currentPlayer(state).id) return { error: 'Not your turn' };
  if (state.turnPhase === 'action_response') return { error: 'Resolve pending action first' };

  if (p.hand.length > HAND_LIMIT) {
    const excess = p.hand.length - HAND_LIMIT;
    if (!discardIds || !Array.isArray(discardIds))
      return { error: 'Must discard to ' + HAND_LIMIT + ' cards', needDiscard: true, excess };
    if (discardIds.length !== excess)
      return { error: 'Discard exactly ' + excess + ' cards' };
    if (hasDuplicates(discardIds)) return { error: 'Discarded cards must be unique' };
    const toDiscard = discardIds.map(id => p.hand.findIndex(c => c.id === id));
    if (toDiscard.some(i => i < 0)) return { error: 'Discard selection contains an invalid card' };
    toDiscard.sort((a,b) => b-a);
    const discarded = [];
    toDiscard.forEach(idx => {
      const card = p.hand.splice(idx, 1)[0];
      state.discardPile.push(card);
      discarded.push(card);
    });
    emit(state, 'discard', { actor: playerId, cards: discarded.map(publicCard) });
  }

  delete state._surgeOps;

  const handsNow = totalHandCards(state);
  const dry = state.deck.length === 0 && state.discardPile.length === 0;
  if (dry && handsNow === state._handSnapshot) state._idleTurns = (state._idleTurns || 0) + 1;
  else state._idleTurns = 0;
  state._handSnapshot = handsNow;

  emit(state, 'turn_end', { actor: playerId });

  const activeCount = state.players.filter(x => !x.eliminated).length;
  if ((state._idleTurns || 0) >= activeCount) {
    endInStalemate(state);
    return { ok: true, stalemate: true };
  }
  if ((state.shuffleCount || 0) >= DECK_CYCLE_LIMIT) {
    endInStalemate(state, 'deck_cycles');
    return { ok: true, stalemate: true };
  }
  // §3.10b 'points' mode's bound. It sits beside §3.11's for the same reason: a rule that
  // can suspend the win indefinitely must carry its own terminator, and the terminator must
  // be checked where every turn ends rather than trusted to some other rule firing first.
  if (suddenDeathOf(state) === 'points' && contestOpen(state)
      && contestLaps(state) >= CONTEST_LAP_CAP) {
    endInStalemate(state, 'contested');
    return { ok: true, stalemate: true };
  }

  advanceToNextActive(state);
  state.stats.turns++;
  logLine(state, currentPlayer(state).name + '\'s turn');
  const won = beginTurn(state);
  return won ? { ok: true, win: true } : { ok: true };
}

/* ── Player view (hides other hands) ─────────────────────────────────── */

function getPlayerView(state, playerId) {
  const tail = (state.events || []).slice(-EVENT_TAIL).map(ev => redactEvent(ev, playerId));
  return {
    phase: state.phase,
    turnPhase: state.turnPhase,
    currentPlayerId: currentPlayer(state).id,
    playsRemaining: state.playsRemaining,
    // Free rearranges left this turn (§3.8). On the wire so the client can say why a drag
    // was refused instead of showing a card that silently snaps back.
    rearrangesRemaining: rearrangesLeft(state),
    rearrangeBudget: REARRANGE_BUDGET,
    deckCount: state.deck.length,
    discardTop: state.discardPile.length > 0 ? state.discardPile[state.discardPile.length-1] : null,
    discardPile: [...state.discardPile].reverse(),
    pendingAction: state.pendingAction,
    responders: pendingResponders(state),
    winner: state.winner,
    endReason: state.endReason || null,
    armedIds: armedPlayers(state),
    // Now a COUNT of stacked Surge Ops (0 = none), still truthy when active.
    surgeOps: state._surgeOps || 0,
    surgeMultiplier: 2 ** (state._surgeOps || 0),
    handLimit: HAND_LIMIT,
    // The whole resolved ruleset, so the client can render the lobby picker and the help
    // can describe the ACTIVE rules rather than the defaults.
    rules: { ...rulesFor(state) },
    setsToWin: setsToWinOf(state),
    // 'finalApproach' (default, grace cycle) | 'instant' (third set wins immediately).
    // Under 'instant' armedIds is always [] and every per-player countdown field is null.
    winRule: state.winRule || DEFAULT_WIN_RULE,
    deckCycle: state.shuffleCount || 0,
    deckCycleLimit: DECK_CYCLE_LIMIT,
    // §3.10b. `contestBar` is what a conversion needs RIGHT NOW, which under 'escalate' is
    // not setsToWin — the HUD must never tell a player they need three when they need four.
    contested: contestOpen(state),
    contestLaps: Math.floor(contestLaps(state)),
    contestLapCap: CONTEST_LAP_CAP,
    contestBar: contestBar(state),
    turnNumber: state.turnCounter || 0,
    stats: state.stats,
    log: state.log.slice(-LOG_TAIL),
    stalemateBasis: state._stalemateBasis || null,
    events: tail,
    eventSeq: state.eventSeq || 0,
    players: state.players.map(p => ({
      id: p.id, name: p.name,
      handCount: p.hand.length,
      hand: p.id === playerId ? p.hand : undefined,
      bank: p.bank,
      properties: p.properties,
      upgrades: p.upgrades,
      completedSets: completedSets(p),
      eliminated: !!p.eliminated,
      finalApproach: !!p.finalApproach,
      finalApproachIn: turnsUntilCheckpoint(state, p),        // DEPRECATED, over/under-counts
      // Honest §3.10 countdown for the HUD. null unless this player is armed.
      // opponentTurnsRemaining: turns by OTHER players before this player's converting turn.
      //   0 => the very next turn to start is theirs and they win at its start.
      // checkpointTurn: the absolute `turnNumber` of that converting turn.
      opponentTurnsRemaining: opponentTurnsRemaining(state, p),
      checkpointTurn: (checkpointForecast(state, p) || {}).turn ?? null,
      bankValue: p.bank.reduce((s, c) => s + c.value, 0),
      propertyValue: Object.values(p.properties).reduce(
        (s, cards) => s + cards.reduce((t, c) => t + c.value, 0), 0),
      upgradeValue: playerUpgradeValue(p),
      payableValue: playerTotalValue(p),
      netWorth: playerNetWorth(p),
    })),
  };
}

module.exports = {
  COLORS, HAND_LIMIT, SETS_TO_WIN, EVENT_TAIL, DECK_CYCLE_LIMIT, REARRANGE_BUDGET, SWAP_COST,
  buildDeck, shuffle, makeRng, createGame, currentPlayer, getPlayer,
  completedSets, checkWin, isSetComplete, isRainbowWild, calcRent, playerTotalValue, playerNetWorth,
  playerUpgradeValue, payableCards, zoneFull, zoneCount, zoneRequisitionable, legalColorsFor,
  drawCards, playAsMoney, playProperty, playAction, respondToAction,
  moveProperty, swapProperties, scoop, endTurn, getPlayerView, validateState, upgradeKinds,
  pendingResponders, pendingEntryFor, publicCard, armedPlayers, canCounter,
  turnsUntilCheckpoint, checkpointReached,
  WIN_RULES, DEFAULT_WIN_RULE, normalizeWinRule, checkpointThreshold,
  RULE_PRESETS, PRESET_NAMES, DEFAULT_PRESET, DEFAULT_RULES, RULE_KEYS,
  SETS_TO_WIN_CHOICES, normalizeSetsToWin, resolveRules, rulesOf, rulesFor, setsToWinOf,
  DECK_BASE, DECK_KINDS, DECK_ACTION_KINDS, DECK_FIXED, DECK_MIN, DECK_MAX, DECK_ACTION_MAX,
  WILD_PAIRS, deckKindMax, deckSize, normalizeDeck, validateDeck, sameDeck,
  SUDDEN_DEATH_RULES, DEFAULT_SUDDEN_DEATH, CONTEST_LAP_CAP, normalizeSuddenDeath,
  suddenDeathOf, contestOpen, contestLaps, contestBar, contestBlocks, syncContest,
  bankUpgrades, findUpgrade,
  // `emit` is exported for the ONE class of event the engine cannot originate: a deadline
  // expiring. server/timers.js owns the clocks, and a clock running out changes the board
  // without anybody choosing to — so it has to reach the same event stream every deliberate
  // move goes into, or the journal, the gamelog record and the player are all left guessing.
  logLine, emit, LOG_MAX, LOG_TAIL, advanceToNextActive, forceEndTurn, finishGame,
  checkpointForecast, opponentTurnsRemaining, actionLabel, receiveProperty,
};
