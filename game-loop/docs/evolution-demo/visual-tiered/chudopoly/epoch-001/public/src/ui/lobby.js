// ui/lobby.js — seats, bots, timers, launch, invite link.

import { $, el, clear, setText, setHidden, setAttr } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store } from '../state/store.js';
import * as pointer from '../interact/pointer.js';
import { toast } from './screens.js';
import {
  PRESETS, PRESET_ORDER, PRESET_COPY, SETS_TO_WIN_CHOICES, WIN_RULES,
  WIN_RULE_NAMES, WIN_RULE_LINE, TOGGLE_COPY,
  matchPreset, presetLabel, normalizeRules, rulesPayload,
  loadHostRules, saveHostRules, winRuleSummary,
  DECK_ORDER, DECK_COPY, DECK_BASE, DECK_MIN, DECK_MAX, deckKindMax, deckSize,
  SUDDEN_DEATH_RULES, SUDDEN_DEATH_COPY,
} from './ruleset.js';
import { BOT_LABEL, BOT_BLURB, botBlurb } from '../core/bots.js';

/* ── who you are actually sitting down with (§P7.19) ───────────────────────
 *
 * MOVED to core/bots.js. It used to live here as two module-private consts and
 * render into a single <p> under the add-bot <select>, which meant the answer to
 * "what is a WILDCARD?" existed only for the host, only in the lobby, and only
 * for whichever option the dropdown happened to be showing. The seat rows below
 * now carry it per seated bot, and ui/help.js carries all five in the in-game
 * brief, from the same source.
 */

/* ── the two match clocks (§P9, owner directive) ───────────────────────────
 *
 * "45-second default response timer, customisable in the lobby."
 *
 * server/handlers.js is already there: DEFAULT_RESPONSE_TIMEOUT is 45,
 * DEFAULT_TURN_TIMEOUT is 60, the ceilings are 120s and 300s, and a room with
 * two or more humans floors them at 15s and 30s (MIN_HUMAN_*). public/index.html
 * is architect-owned (§1) and still ships the OLD option lists — reply
 * 0/15/30/60 with 30 selected — so a host who touched nothing sent 30 and a
 * host who did not have the control on screen at all got 45. Two different
 * answers to the same question, neither of them the one the owner asked for.
 *
 * The lists are therefore rebuilt here, from the server's own numbers, exactly
 * the way describeBots() rewrites the bot labels. `selected` is set on the
 * DEFAULT, and the host's last choice is remembered so a table that always
 * plays on a 90s clock does not re-pick it every night.
 *
 * WHY THE CLOCKS ARE EXPLAINED AND NOT JUST OFFERED. §6 agency: an expiring
 * answer clock is the one board change nobody chooses. server/timers.js
 * autoResolveResponse() accepts on your behalf and pays the charge out of your
 * CHEAPEST cards (autoPickPayment: bank, then Upgrades, then properties). That
 * consequence has to be legible before the host picks a number, not discovered
 * after a set has been broken by it.
 */
const TURN_CHOICES = [
  { value: 0, label: 'off' }, { value: 30, label: '30s' }, { value: 45, label: '45s' },
  { value: 60, label: '60s' }, { value: 90, label: '90s' }, { value: 120, label: '2 min' },
  { value: 180, label: '3 min' },
];
const REPLY_CHOICES = [
  { value: 0, label: 'off' }, { value: 15, label: '15s' }, { value: 30, label: '30s' },
  { value: 45, label: '45s' }, { value: 60, label: '60s' }, { value: 90, label: '90s' },
  { value: 120, label: '2 min' },
];
const DEFAULT_TURN = 60;
const DEFAULT_REPLY = 45;          // server/handlers.js DEFAULT_RESPONSE_TIMEOUT
const CLOCK_KEY = 'chud_clocks';

function loadClocks() {
  try {
    const raw = JSON.parse(localStorage.getItem(CLOCK_KEY) || 'null');
    return {
      turn: TURN_CHOICES.some(c => c.value === raw?.turn) ? raw.turn : DEFAULT_TURN,
      reply: REPLY_CHOICES.some(c => c.value === raw?.reply) ? raw.reply : DEFAULT_REPLY,
    };
  } catch { return { turn: DEFAULT_TURN, reply: DEFAULT_REPLY }; }
}

function saveClocks() {
  try {
    localStorage.setItem(CLOCK_KEY, JSON.stringify({
      turn: Number($('turn-timeout')?.value ?? DEFAULT_TURN),
      reply: Number($('response-timeout')?.value ?? DEFAULT_REPLY),
    }));
  } catch { /* private mode */ }
}

/** Rebuild one <select> to `choices`, selecting `value`. Idempotent. */
function fillClock(id, choices, value) {
  const select = $(id);
  if (!select) return;
  const wanted = choices.map(c => String(c.value)).join(',');
  if (select.dataset.chudClock === wanted) { select.value = String(value); return; }
  clear(select);
  for (const c of choices) {
    select.appendChild(el('option', { text: c.label, attrs: { value: String(c.value) } }));
  }
  select.dataset.chudClock = wanted;
  select.value = String(value);
}

/** The sentence under the two clocks. Rewritten on every change, because what
 *  the pair MEANS changes with the numbers — 'off' is a different game. */
function describeClocks() {
  const turn = Number($('turn-timeout')?.value ?? DEFAULT_TURN);
  const reply = Number($('response-timeout')?.value ?? DEFAULT_REPLY);
  const humans = store.room.players.filter(p => !p.isBot).length;

  /* TIGHTENED, not cut. §6 agency still requires the CONSEQUENCE of each clock
     to be legible before the host picks a number — an expiring answer clock is
     the one board change nobody chooses, and server/timers.js pays the charge
     out of your cheapest cards on your behalf. What is gone is only the
     restatement: the old copy said "you have 45s" after a heading that already
     read "ANSWER CLOCK 45s". Measured at 390×844 in the rebuilt lobby, the two
     sentences were 409 characters and ran to SIX lines above the presets, which
     is a wall in front of the decision this screen exists for; they are 258 and
     run to four. Both auto-resolutions are still named. */
  const bits = [];
  bits.push(reply > 0
    ? `ANSWER CLOCK ${reply}s — a card played against you must be OPSEC'd or paid inside it. `
      + 'Let it run out and it is accepted for you, out of your cheapest cards.'
    : 'ANSWER CLOCK OFF — a card played against you waits forever. One player who walks away '
      + 'freezes the table.');
  bits.push(turn > 0
    ? `TURN CLOCK ${turn}s — a turn that runs out is ended for you, discarding to the hand `
      + 'limit if it has to.'
    : 'TURN CLOCK OFF — turns never expire.');
  // The floors are server-side and silent; a lobby that shows a number the
  // server will overrule is a label that lies (server/handlers.js MIN_HUMAN_*).
  if (humans > 1 && (reply > 0 && reply < 15)) bits.push('With two or more humans the answer clock is floored at 15s.');
  if (humans > 1 && reply === 0) bits.push('With two or more humans OFF is floored to 15s — a 0 clock is a griefing tool.');
  if (humans > 1 && turn > 0 && turn < 30) bits.push('With two or more humans the turn clock is floored at 30s.');
  if (humans > 1 && turn === 0) bits.push('With two or more humans OFF is floored to 30s.');

  let note = $('clock-note');
  if (!note) {
    note = el('p', { class: 'hint clock-note', attrs: { id: 'clock-note', 'aria-live': 'polite' } });
    $('response-timeout')?.closest('.row')?.after(note);
  }
  setText(note, bits.join(' '));
}

function ensureClocks() {
  const turnSel = $('turn-timeout');
  const replySel = $('response-timeout');
  if (!turnSel || !replySel) return;
  if (!turnSel.dataset.chudClock) {
    const saved = loadClocks();
    fillClock('turn-timeout', TURN_CHOICES, saved.turn);
    fillClock('response-timeout', REPLY_CHOICES, saved.reply);
    for (const sel2 of [turnSel, replySel]) {
      sel2.addEventListener('change', () => { saveClocks(); describeClocks(); });
    }
  }
  describeClocks();
}

/**
 * public/index.html is architect-owned (§1) and ships the five <option> labels;
 * the meaning is added here rather than by editing the shell.
 */
function describeBots() {
  const select = $('bot-mode');
  if (!select) return;
  for (const option of select.options) {
    if (BOT_LABEL[option.value]) option.textContent = BOT_LABEL[option.value];
  }
  let blurb = $('bot-blurb');
  if (!blurb) {
    blurb = el('p', {
      class: 'hint bot-blurb',
      attrs: { id: 'bot-blurb', 'aria-live': 'polite' },
    });
    select.closest('.row')?.after(blurb);
    select.addEventListener('change', () => setText(blurb, BOT_BLURB[select.value] || ''));
  }
  setText(blurb, BOT_BLURB[select.value] || '');
}

/* ── the ruleset picker (§P8) ──────────────────────────────────────────────
 *
 * Real tables negotiate a handful of rules before anyone deals, and they do it
 * by NAME — "normal", "quick game" — not by enumerating four switches. So the
 * four presets are the whole choice, one tap each, and the switches live behind
 * a disclosure for the table that actually wants to argue about them.
 *
 * WHY THE HOST'S CHOICE IS LOCAL, AND WHAT NON-HOSTS SEE.
 * The lobby broadcast (server/broadcast.js broadcastRoom) carries code, phase,
 * players, hostId, game and the two timers. There is NO ruleset field before a
 * game exists — `game` is null in a lobby — so a pending choice has nowhere to
 * travel and no other seat can read it. server/ is frozen (§1) and not ours, so
 * the picker is host-local and every other seat is told the truth: the host is
 * choosing, and the ruleset is stated on the table and in How to play from the
 * first broadcast onward (ui/ruleset.js activeRules → ui/help.js ruleBadge).
 * The alternative — showing non-hosts the DEFAULT ruleset as though it were the
 * pending one — is a label that lies four times out of five. The one-message
 * server change that would fix it properly is in this agent's report.
 *
 * PERSISTENCE: ui/ruleset.js loadHostRules/saveHostRules. A host who picked
 * Blitz last night gets Blitz selected tonight, in a new room, without asking.
 */

/** The host's pending toggle set. Server-authoritative from `start_game` on. */
let pending = normalizeRules(null);
let pickerRoot = null;

/** name → the four inputs that must reflect `pending`, cached at build time. */
const inputs = { preset: [], winRule: [], setsToWin: [], flags: {}, suddenDeath: [], deck: {} };

function radio(name, value, checked) {
  return el('input', {
    class: 'rule-input',
    attrs: { type: 'radio', name, value, ...(checked ? { checked: true } : {}) },
  });
}

function presetTile(id) {
  const copy = PRESET_COPY[id];
  const input = radio('chud-preset', id, id === matchPreset(pending));
  inputs.preset.push(input);
  return el('label', { class: 'preset' }, [
    input,
    el('span', { class: 'preset-body' }, [
      el('span', { class: 'preset-top' }, [
        el('span', { class: 'preset-name', text: copy.name }),
        el('span', { class: 'preset-tag', text: copy.tag }),
        el('span', { class: 'preset-turns', text: copy.turns }),
      ]),
      el('span', { class: 'preset-line', text: copy.line }),
    ]),
  ]);
}

function winRuleRow(id) {
  const input = radio('chud-winrule', id, pending.winRule === id);
  inputs.winRule.push(input);
  return el('label', { class: 'rule-row' }, [
    input,
    el('span', { class: 'rule-body' }, [
      el('span', { class: 'rule-name', text: WIN_RULE_NAMES[id] }),
      el('span', { class: 'rule-line', text: WIN_RULE_LINE[id] }),
    ]),
  ]);
}

function setsRow() {
  return el('div', { class: 'rule-seg', attrs: { role: 'radiogroup', 'aria-label': 'Sets to win' } },
    SETS_TO_WIN_CHOICES.map((n) => {
      const input = radio('chud-sets', String(n), pending.setsToWin === n);
      inputs.setsToWin.push(input);
      return el('label', { class: 'seg' }, [input, el('span', { class: 'seg-face', text: String(n) })]);
    }));
}

function flagRow(key, name) {
  const copy = TOGGLE_COPY[key];
  const input = el('input', {
    class: 'rule-input',
    attrs: { type: 'checkbox', name, ...(pending[key] ? { checked: true } : {}) },
  });
  inputs.flags[key] = input;
  return el('label', { class: 'rule-row' }, [
    input,
    el('span', { class: 'rule-body' }, [
      el('span', { class: 'rule-name', text: copy.label }),
      el('span', { class: 'rule-line', text: copy.line }),
    ]),
  ]);
}

/* ── the deck editor (§3 deck knob) ────────────────────────────────────────
 *
 * A STEPPER PER CARD, not a free text field and not a slider. Three reasons, and
 * the first is the one that decided it:
 *   * every count is a small integer with a hard per-kind ceiling, so − and +
 *     can be DISABLED at the bounds. A host is never offered a value the server
 *     would refuse, which is the only honest way to build a control in front of
 *     an authoritative validator.
 *   * the numbers are the whole point. "2 → 3 Inspector General" is the edit;
 *     a slider hides exactly the digit being chosen.
 *   * it degrades to a plain +/− pair on a phone at 44px (§0.9) without a
 *     custom gesture.
 *
 * The running deck TOTAL is shown because it is the one number with a global
 * bound (game.js DECK_MIN/DECK_MAX): a per-card step can be individually legal
 * and still push the deck out of range, and the host has to be able to see why
 * the + went dead.
 */
function deckStepper(kind) {
  const dec = el('button', {
    class: 'deck-step', attrs: { type: 'button', 'data-deck': kind, 'data-delta': '-1',
      'aria-label': `One fewer ${DECK_COPY[kind]}` }, text: '−' });
  const inc = el('button', {
    class: 'deck-step', attrs: { type: 'button', 'data-deck': kind, 'data-delta': '1',
      'aria-label': `One more ${DECK_COPY[kind]}` }, text: '+' });
  const count = el('span', { class: 'deck-count', attrs: { 'aria-live': 'polite' } });
  inputs.deck[kind] = { dec, inc, count, row: null };
  const row = el('div', { class: 'deck-row' }, [
    el('span', { class: 'deck-name', text: DECK_COPY[kind] }),
    el('span', { class: 'deck-ctl' }, [dec, count, inc]),
  ]);
  inputs.deck[kind].row = row;
  return row;
}

function suddenDeathRow(id) {
  const input = radio('chud-sudden', id, pending.suddenDeath === id);
  inputs.suddenDeath.push(input);
  const copy = SUDDEN_DEATH_COPY[id];
  return el('label', { class: 'rule-row' }, [
    input,
    el('span', { class: 'rule-body' }, [
      el('span', { class: 'rule-name', text: copy.label }),
      el('span', { class: 'rule-line', text: copy.line }),
    ]),
  ]);
}

/** Fold one changed control back into `pending`, persist, repaint the label. */
function onPick(e) {
  const t = e.target;
  if (!t || t.tagName !== 'INPUT') return;
  switch (t.name) {
    // A preset REPLACES the toggle set — that is what picking one means.
    case 'chud-preset': pending = { ...PRESETS[t.value] }; break;
    case 'chud-winrule': pending = { ...pending, winRule: t.value }; break;
    case 'chud-sets': pending = { ...pending, setsToWin: Number(t.value) }; break;
    case 'chud-pure': pending = { ...pending, pureSetRequired: t.checked }; break;
    case 'chud-opsec': pending = { ...pending, counterCostsPlay: t.checked }; break;
    case 'chud-pcs': pending = { ...pending, passGoRestartsTurn: t.checked }; break;
    case 'chud-sudden': pending = { ...pending, suddenDeath: t.value }; break;
    default: return;
  }
  pending = normalizeRules(pending);
  saveHostRules(pending);
  syncPicker();
}

/**
 * A deck stepper. Clamped against the SAME bounds game.js normalizeDeck uses, so
 * a step the server would refuse cannot be taken — but the button is also
 * disabled at those bounds by syncPicker(), and this is the second line of
 * defence rather than the first (a keyboard Enter on a disabled-looking control,
 * a stale DOM, a double-fire).
 */
function onDeckStep(e) {
  const btn = e.target.closest?.('[data-deck]');
  if (!btn || !pickerRoot.contains(btn)) return;
  e.preventDefault();
  const kind = btn.getAttribute('data-deck');
  const delta = Number(btn.getAttribute('data-delta'));
  const deck = { ...(pending.deck || DECK_BASE) };
  const next = (deck[kind] ?? DECK_BASE[kind]) + delta;
  if (next < 0 || next > deckKindMax(kind)) return;
  const size = deckSize({ ...deck, [kind]: next });
  if (size < DECK_MIN || size > DECK_MAX) return;
  deck[kind] = next;
  pending = normalizeRules({ ...pending, deck });
  saveHostRules(pending);
  syncPicker();
}

/**
 * Push `pending` back into every control and repaint the summary. Runs after a
 * pick AND on every lobby render, so a picker built from a stale localStorage
 * read can never disagree with the object that is actually sent.
 */
function syncPicker() {
  if (!pickerRoot) return;
  const preset = matchPreset(pending);
  for (const input of inputs.preset) input.checked = input.value === preset;
  for (const input of inputs.winRule) input.checked = input.value === pending.winRule;
  for (const input of inputs.setsToWin) input.checked = Number(input.value) === pending.setsToWin;
  inputs.flags.pureSetRequired.checked = pending.pureSetRequired;
  inputs.flags.counterCostsPlay.checked = pending.counterCostsPlay;
  inputs.flags.passGoRestartsTurn.checked = pending.passGoRestartsTurn;
  for (const input of inputs.suddenDeath) input.checked = input.value === pending.suddenDeath;
  // §3.10b is meaningless under 'instant' — nothing is ever armed, so there is no
  // contest to suspend. game.js normalizeSuddenDeath forces it off; the control is
  // disabled here so the host sees WHY rather than watching their choice revert.
  const sdDead = pending.winRule === 'instant';
  for (const input of inputs.suddenDeath) input.disabled = sdDead;
  setHidden($('sudden-na'), !sdDead);

  const deck = pending.deck || DECK_BASE;
  const size = deckSize(deck);
  for (const kind of DECK_ORDER) {
    const ui = inputs.deck[kind];
    if (!ui) continue;
    const n = deck[kind] ?? DECK_BASE[kind];
    setText(ui.count, String(n));
    // Disabled at the per-kind bound OR where the step would take the whole deck
    // out of [DECK_MIN, DECK_MAX] — both are server refusals, so both are dead here.
    ui.dec.disabled = n <= 0 || size - 1 < DECK_MIN;
    ui.inc.disabled = n >= deckKindMax(kind) || size + 1 > DECK_MAX;
    ui.row.classList.toggle('is-changed', n !== DECK_BASE[kind]);
  }
  setText($('deck-total'), `${size} cards`);
  setAttr($('deck-total'), 'data-stock', size === 106 ? 'stock' : 'custom');

  // The label the host reads is computed the same way the server computes the
  // one the table will read (game.js resolveRules), so flipping a toggle off a
  // preset says "Custom" here exactly when the broadcast will say 'custom'.
  const bits = [`${WIN_RULE_NAMES[pending.winRule]}`, `${pending.setsToWin} sets`];
  if (pending.pureSetRequired) bits.push('no all-rainbow sets');
  if (pending.counterCostsPlay) bits.push('OPSEC costs a play');
  if (pending.passGoRestartsTurn) bits.push('PCS Orders restarts');
  if (pending.suddenDeath !== 'off') bits.push(SUDDEN_DEATH_COPY[pending.suddenDeath].label.toLowerCase());
  // Only ever says "custom deck" when it IS one — a deck that happens to equal the
  // stock 106 after two cancelling edits is the stock deck and says nothing.
  if (size !== 106 || DECK_ORDER.some(k => (deck[k] ?? DECK_BASE[k]) !== DECK_BASE[k])) {
    bits.push(`custom deck (${size})`);
  }
  setText($('ruleset-name'), presetLabel(preset));
  setText($('ruleset-bits'), bits.join(' · '));
  setText($('ruleset-win'), winRuleSummary(pending));
  setAttr($('ruleset'), 'data-preset', preset);
}

/**
 * index.html ships no picker, so it is built here — once, then only mutated.
 *
 * IT NOW HAS A COLUMN OF ITS OWN (#lobby-rules). It used to be inserted into
 * #lobby-host directly above Launch Mission, which put ~500px of presets — and
 * 2041px with the disclosure open — between the seat list and the one button
 * the screen exists for, inside a `overflow: hidden` screen that could not
 * scroll to reach it. Measured at 1280×720 with host + 3 bots and the
 * disclosure CLOSED: Launch Mission at y 805..849 in a 720px viewport. The
 * button is pinned in the rail now and this block scrolls beside the room.
 */
function ensurePicker() {
  if (pickerRoot) return;
  const column = $('lobby-rules');
  if (!column) return;

  /* THE HOST'S BODY LEADS WITH THE DECISION, AND IT IS MOVED IN THE DOM.
   *
   * Measured at 390×844 with host + 4 bots, disclosure closed, at rest:
   * .lobby-body was scrollHeight 996 in a 618px scrollport, the room column ran
   * y86..606, and #ruleset therefore started at y620 — 23px of summary line
   * against a fold at 688, with 0 of the 4 preset plates fully in view. The
   * ruleset's position was a function of the seat count (the room column grows
   * 54px per seat, the rules column does not grow at all), so the one decision
   * this screen exists for sank further out of sight as the lobby filled.
   * After this move, at the same scrollTop 0: .ruleset-head y86..109, all four
   * plates in the scrollport, the win-rule sentence at y414..465, and 158px of
   * the room column — its legend and two and a half seats — still under it at
   * every seat count.
   *
   * IN THE DOM, NOT WITH `order`. A CSS reorder under a phone query was tried
   * and measured first: it puts tab order and reading order in opposite
   * sequences inside a container that scrolls to whatever takes focus, so a
   * host tabbing off Copy invite went DOWN past the fold into the seat list
   * (scrollTop 0 → 366) and then back UP 816px to the presets. Moving the node
   * keeps one sequence at every width and lets ui.css drop `order` entirely;
   * ui.css THE DECISION LEADS carries the two focus walks side by side.
   *
   * HERE RATHER THAN IN index.html because that file is architect-owned (§1),
   * and HOST-ONLY because it is the host's decision that earns the lead: a
   * guest's rules column holds one sentence (ensureGuestNote) and keeps the
   * seat list first, which is what a guest is there to read. A request to make
   * this the shipped source order is in this agent's report.
   */
  column.parentNode?.prepend(column);

  pending = loadHostRules();

  /* ── THE PICKER FOLDS ON A PHONE (P10, MOBILE critic finding 3) ─────────
   *
   * MEASURED at 390×844, host + 4 bots: .lobby-body is 1022px of content in a
   * 618px scrollport, and the tail below the fold is the ROOM's — the last two
   * Remove marks sliced mid-row under the rail, the bot picker and Add bot at
   * y835 and both clocks at y934, entirely off-viewport in the cold frame.
   * The ui.css DECISION LEADS note already proved no ordering fixes a 400px
   * shortfall; the only thing left to move is the 340px the preset plates and
   * the win sentence occupy — behind a disclosure, on the screens where they
   * do not fit. The resolved ruleset stays readable while folded: the head's
   * live name/bits line ("Chudopoly · Final Approach · 3 sets") is OUTSIDE the
   * fold, so the fold hides the CONTROLS, never the answer. After, same
   * viewport: every control on this screen sits inside the 618px port — the
   * off-viewport and clipped-by-scroller counts on `lobby (host)` go to zero
   * instead of being re-aimed.
   *
   * ≥720px (ui.css's own rail breakpoint) the fold ships OPEN and its summary
   * row is hidden by lobby.css, so a desktop host sees exactly the round-9
   * screen: decision first, all four plates up. The listener re-opens it when
   * a window widens across the breakpoint; it deliberately never CLOSES on
   * shrink — snatching an open picker out from under a host mid-choice is a
   * board change nobody chose. */
  const wide = typeof matchMedia === 'function' ? matchMedia('(min-width: 720px)') : null;
  const fold = el('details', {
    class: 'ruleset-fold',
    attrs: wide && !wide.matches ? {} : { open: '' },
  }, [
    el('summary', { class: 'ruleset-summary ruleset-fold-summary' }, [
      el('span', { class: 'ruleset-summary-text', text: 'Choose the ruleset' }),
      el('span', { class: 'ruleset-caret', attrs: { 'aria-hidden': 'true' }, text: '▸' }),
    ]),
    el('div', {
      class: 'preset-grid',
      attrs: { role: 'radiogroup', 'aria-label': 'Ruleset preset' },
    }, PRESET_ORDER.map(presetTile)),
    el('p', { class: 'ruleset-win hint', attrs: { id: 'ruleset-win' } }),
    buildAdv(),
  ]);
  if (wide) {
    const reopen = () => { if (wide.matches) fold.open = true; };
    if (wide.addEventListener) wide.addEventListener('change', reopen);
    else if (wide.addListener) wide.addListener(reopen);
  }

  pickerRoot = el('section', {
    class: 'ruleset',
    attrs: { id: 'ruleset', 'aria-labelledby': 'ruleset-head' },
  }, [
    el('div', { class: 'ruleset-head' }, [
      el('h3', { class: 'ruleset-title', attrs: { id: 'ruleset-head' }, text: 'Rules' }),
      el('span', { class: 'ruleset-now', attrs: { 'aria-live': 'polite' } }, [
        el('span', { class: 'ruleset-name', attrs: { id: 'ruleset-name' } }),
        el('span', { class: 'ruleset-bits', attrs: { id: 'ruleset-bits' } }),
      ]),
    ]),
    fold,
  ]);

  pickerRoot.addEventListener('change', onPick);
  pickerRoot.addEventListener('click', onDeckStep);
  column.appendChild(pickerRoot);
  syncPicker();
}

/** The advanced disclosure, unchanged from round 9 — only extracted so the
 *  fold above can nest it. */
function buildAdv() {
  return el('details', { class: 'ruleset-adv' }, [
      el('summary', { class: 'ruleset-summary' }, [
        el('span', { class: 'ruleset-summary-text', text: 'Change individual rules' }),
        el('span', { class: 'ruleset-caret', attrs: { 'aria-hidden': 'true' }, text: '▸' }),
      ]),
      el('div', { class: 'adv-body' }, [
        el('fieldset', { class: 'adv-group' }, [
          el('legend', { class: 'adv-legend', text: 'When you win' }),
          ...WIN_RULES.map(winRuleRow),
        ]),
        el('fieldset', { class: 'adv-group adv-group-inline' }, [
          el('legend', { class: 'adv-legend', text: 'Sets to win' }),
          setsRow(),
        ]),
        el('fieldset', { class: 'adv-group' }, [
          el('legend', { class: 'adv-legend', text: 'House rules' }),
          flagRow('pureSetRequired', 'chud-pure'),
          /* §3.1d. Its copy is DELIBERATELY one short line: this fieldset sits directly
             above the Sets strip, and a row that wraps to a third line pushes the strip
             out of the frame checkContrast measures — measured, lobby-host · light. */
          flagRow('counterCostsPlay', 'chud-opsec'),
          flagRow('passGoRestartsTurn', 'chud-pcs'),
        ]),
        el('fieldset', { class: 'adv-group' }, [
          el('legend', { class: 'adv-legend', text: 'When two players are armed at once' }),
          ...SUDDEN_DEATH_RULES.map(suddenDeathRow),
          el('p', {
            class: 'hint', attrs: { id: 'sudden-na', hidden: true },
            text: 'Not available with instant win — nothing is ever armed, so an approach '
              + 'can never be contested.',
          }),
        ]),
        el('fieldset', { class: 'adv-group adv-group-deck', attrs: { 'aria-label': 'The deck' } }, [
          /* A DIV, not a <legend>, and the difference is the whole feature:
           * the deck total is the one number with a GLOBAL bound (game.js
           * DECK_MIN/DECK_MAX — a per-card step can be individually legal and
           * still push the deck out of range), and at 1280×720 it sat above
           * thirteen steppers, below the fold the moment the host scrolled to
           * the row they were editing. lobby.css pins this row sticky inside
           * .lobby-body — which a <legend> cannot be: a legend is laid out in
           * the fieldset's border area by special-case rules and Chromium does
           * not stick it (verified: `position: sticky` on the legend computed
           * but the box never pinned). The group keeps its accessible name via
           * aria-label on the fieldset. */
          el('div', { class: 'adv-legend adv-legend-deck' }, [
            el('span', { text: 'The deck' }),
            el('span', { class: 'deck-total', attrs: { id: 'deck-total', 'aria-live': 'polite' } }),
          ]),
          el('p', {
            class: 'hint',
            text: `Property, money and rent are fixed at 61 cards — a colour's card count IS `
              + `its set size. Everything else is yours, between ${DECK_MIN} and ${DECK_MAX} cards.`,
          }),
          ...DECK_ORDER.map(deckStepper),
        ]),
      ]),
  ]);
}

/**
 * What a seat that is NOT the host sees. Not a picker and not a guess at one:
 * a statement of who decides and where the answer will appear.
 *
 * It goes in the RULES column, which is where the picker would have been — a
 * guest's rules column is otherwise an empty half of the screen, and the note
 * answers the question that empty half raises.
 */
function ensureGuestNote() {
  if ($('ruleset-guest')) return;
  const column = $('lobby-rules');
  if (!column) return;
  column.insertBefore(el('p', {
    class: 'ruleset-guest hint',
    attrs: { id: 'ruleset-guest', hidden: true },
    text: 'The host is choosing the ruleset. Whatever they pick, the table and How to play '
      + 'describe the game you are actually in, from the first hand.',
  }), column.firstChild);
}

function clockValue(id, fallback) {
  const raw = $(id)?.value;
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function inviteUrl() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = store.room.code ? `?room=${store.room.code}` : '';
  return url.toString();
}

function render() {
  if (store.screen !== 'lobby') return;
  setText($('lobby-code'), store.room.code || '----');

  const host = store.room.hostId === store.self.id;
  setHidden($('lobby-host'), !host);
  // Launch Mission lives in the rail now, outside #lobby-host, so hiding the
  // host block no longer hides it — it is hidden on its own or every guest
  // gets a button the server would refuse.
  setHidden($('btn-start'), !host);
  ensureGuestNote();
  setHidden($('ruleset-guest'), host);
  if (host) { describeBots(); ensureClocks(); ensurePicker(); syncPicker(); }
  setText($('lobby-hint'), host
    ? (store.room.players.length < 2 ? 'Add a bot or invite a squadmate — 2 players minimum.' : 'Ready when you are.')
    : 'Waiting for the host to launch…');

  const list = $('lobby-players');
  if (!list) return;
  clear(list);
  for (const player of store.room.players) {
    const row = el('div', { class: 'lobby-row' }, [
      el('span', { class: 'lobby-seat-name', text: player.name }),
      el('span', {
        class: 'lobby-seat-tag',
        // OWNER DIRECTIVE 2026-08-07: personalities are not disclosed, here or at
        // the table — including to the host, whose own picks would otherwise be a
        // seating chart everyone else is denied. Quick Play assigns them anyway.
        text: player.isBot ? 'BOT'
          : (player.id === store.room.hostId ? 'HOST' : (player.connected ? '' : 'OFFLINE')),
      }),
    ]);
    if (host && player.id !== store.self.id) {
      row.appendChild(el('button', {
        class: 'btn btn-ghost btn-small',
        text: player.isBot ? 'Remove' : 'Kick',
        attrs: {
          'data-action': player.isBot ? 'remove-bot' : 'kick',
          'data-target': player.id,
        },
      }));
    }
    list.appendChild(row);
    // The personality of the bot IN THIS SEAT, for everyone at the table — not just
    // the host, and not just the mode the add-bot dropdown is showing. A guest could
    // previously read "BOT · WILDCARD" beside a name with nothing anywhere on any
    // screen saying what a WILDCARD does.
    //
    // A SIBLING OF THE ROW, not a child of it. Measured with tools/screenshot.mjs:
    // inside `.lobby-row` (a flex row) a 130-character sentence took the whole line
    // and crushed every seat NAME to 8-18px of the 28-64px it needed — four clipped
    // runs on desktop and four on phone. The name is the thing that must never be
    // clipped, so the explanation goes on its own line beneath.
    // The per-seat blurb is gone with the label it explained (owner directive):
    // it named the personality in prose, so keeping it would have leaked exactly
    // what the tag stopped showing. The five personalities are still documented
    // in the brief under Bots — what is hidden is WHICH seat is which.
  }
}

export function mount() {
  pointer.registerActions({
    'add-bot': () => send.addBot($('bot-mode')?.value || 'neutral'),
    'remove-bot': (el2) => send.removeBot(el2.dataset.target),
    'kick': (el2) => send.kick(el2.dataset.target),
    // rulesPayload() sends a NAME when the toggles are a named preset and the
    // four toggles when they are not — 'custom' is not a wire value
    // (server/protocol.js rejects it) and resolveRules() reaches the identical
    // ruleset either way. Absent fields would mean Chudopoly, so this is never
    // empty by accident.
    // `|| DEFAULT` cannot be used for the clocks: '0' is a legal, deliberate
    // choice (OFF) and `Number('0') || 45` is 45, so picking OFF silently armed
    // a 45s clock. Only a genuinely absent control falls back.
    'start-game': () => send.startGame(
      clockValue('turn-timeout', DEFAULT_TURN),
      clockValue('response-timeout', DEFAULT_REPLY),
      rulesPayload(pending)
    ),
    'copy-invite': async () => {
      const url = inviteUrl();
      try {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied');
      } catch {
        toast(url);
      }
    },
  });

  bus.on(EVENTS.STATE_APPLIED, render);
  bus.on(EVENTS.STATE_SCREEN, render);
}
