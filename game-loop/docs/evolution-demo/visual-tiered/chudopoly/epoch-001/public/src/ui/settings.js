// ui/settings.js — sound, appearance, and the way back to the rules.
//
// The audio engine (P5) already persists its own preferences; this is only the
// control surface. Every control is a native form element so keyboard operation
// is the browser's job, not ours: Space toggles the switch, arrows move the
// slider (§0.9).
//
// SFX and MUSIC are two independent pairs, persisted separately by the engine,
// because "kill the music, keep the card sounds" is the setting people actually
// want (audio agent, P7: there is now a menu bed and an in-match drone).
//
// ── ONE SHEET, THREE SCREENS (P9) ─────────────────────────────────────────
// This used to be reachable only from ui/hud.js's dial, which lives in
// .hud-right inside #screen-game. §7 attaches the music bed on the first
// pointerdown ANYWHERE (main.js), so a player who tapped Quick Play bought a
// bed they could not touch until the table finished loading, and the lobby had
// no route to it at all. The rail's right corner on both home and lobby now
// carries the same `data-action="settings"` mark, and ui/screens.js's
// openSheet() supplies the focus trap, Escape, scrim-tap and return-focus, so
// there is exactly one settings chassis in the product (ART §3.2).
//
// ── THE FIRST-GESTURE PATH, AND WHAT THE FOLD ACTUALLY COSTS ──────────────
// The home rail used to carry a one-tap music mark whose whole value was that
// interact/pointer.js dispatches on window CAPTURE while main.js's audio unlock
// is a bubble-phase listener on the same window, so pressing it FIRST set the
// preference before init() ever ran. Folding it in here had to be paid for with
// a number, not an argument. Measured on a cold load with pristine storage, no
// autoplay flag, polling audio.musicStats() every 50ms from the first gesture
// (the settings mark) — t is milliseconds after that pointerdown:
//
//   AudioContexts constructed with NO gesture at all      0   (§10 holds)
//   AudioContext constructed                           t+22
//   graph ready, ctx 'running'                         t+145
//   PROCEDURAL lobby bed audible                       t+145
//   lobby.opus takes over from the synth bed           t+351
//   sheet open, titled Settings, Sound + Music the
//     first two rows                                   within 3ms of the
//                                                      window seeing pointerdown
//   Music switch off -> mode 'off', bed null, and
//     chud.audio persisted {"music":false}             immediate, on tap two
//
// So the honest cost of the fold is ONE EXTRA TAP AND ABOUT A SECOND OF BED —
// t+145ms is faster than any hand, and the old mark only ever beat it by being
// the literal first press. Everything else moves the other way: the lobby had
// no audio control whatsoever before this round, the sheet also carries volume
// (which a toggle never could), and the rail keeps two corner marks instead of
// three. REQUEST TO THE ARCHITECT (main.js is not this agent's): having the
// unlock listener skip a pointerdown whose target is `[data-action="settings"]`
// would take that second back and costs one line — the next pointerdown still
// unlocks, since the listener is `{ once: true }` and would not have fired.

import { el, setAttr, setText } from '../core/dom.js';
import * as audio from '../audio/engine.js';
import * as pointer from '../interact/pointer.js';
import { openSheet, closeSheet } from './screens.js';
import * as hints from './hints.js';

function pct(v) { return `${Math.round(v * 100)}%`; }

/* ══ UI SCALE ═══════════════════════════════════════════════════════════════
   A multiplier on --s (style/variables.css), and on --s ONLY. The bounds are
   measurements, not taste — swept on a 390×844 phone across the mid-game,
   five-player and big-hand fixtures with the GATE'S OWN audit
   (tools/lib/audit.mjs auditTapTargets), so these numbers are the same ones
   touchtest reports:

     scale   fatal sub-44px controls        offscreen controls
     0.70    1–4  (pile 40×68; hand card    0 / 3 / 0
                   exposed strip 43px)
     0.80    0    0    0                    0 / 3 / 0
     1.00    0    0    0                    0 / 0 / 0
     1.30    0    0    0                    0 / 0 / 1
     1.40    0    0    0                    13 / 4 / 2  ← section.board 370×432
                                                          leaves the viewport

   MIN 0.80 — the §0.9 floor is what fails first going down, and it fails at
   0.70, not at 0.80. table.css floors most hit areas on --tap rather than --s
   (`min-height: var(--tap)`, `max(var(--card-tap), calc(var(--s) * N))`,
   `minmax(var(--tap), 1fr)`), so shrinking --s slides each card down its max()
   until --tap takes over and the target stops shrinking. Two places leak
   because they have no --tap floor — `.opponents .zone-bank` (--card-w is a
   bare `calc(var(--s) * 2.2)`) and the deck/discard pile — and those are what
   go sub-44 at 0.70. 0.80 is the last step measured clean everywhere.

   MAX 1.30 — going up, targets never fail; LAYOUT does. 1.40 pushes whole
   boards out of the viewport (13 offscreen controls on mid-game). 1.30 costs
   exactly one offscreen node, a hand card in big-hand, and .zone-hand is
   `overflow-x: auto` so it is still reachable by scrolling the fan.

   DEFAULT 1 — arithmetically the pre-setting expression, so a player who never
   opens this sees the identical table and tools/screenshot.mjs hashes are
   unchanged. VERIFIED, not argued: mid-game/five-player/big-hand rendered at
   phone and desktop under `calc(clamp(…) * var(--ui-scale))` and under the bare
   `clamp(…)` produced byte-identical PNG hashes, --s resolving to 14.3438px and
   16.5469px in both. The gate also runs on pristine storage (harness.mjs
   pristineStorage), so it reads this default and never a stored value.

   iOS FOCUS-ZOOM is NOT reintroduced by scaling down, and this was measured
   rather than assumed, because it is the obvious way this setting could have
   broken the fix at base.css's `.field` rule. That rule is `font-size:
   max(16px, 1em)` — the 16px arm is an absolute length and does not take the
   multiplier, so it holds. Swept at 0.80: all six focusable text controls
   (name-input, code-input, chat-input and the three lobby selects) compute to
   exactly 16px, which is the safe side of the threshold — Mobile Safari zooms
   at 15px and below, and 16px does not zoom.

   Scaling DOWN is the direction that helps this table most, and that is also
   measured: the clipped-by-a-scrolling-ancestor count (touchtest's largest
   failure) falls with scale — mid-game 6 clipped at 1.00 → 0 at 0.80,
   five-player 24 → 15. The control is a real player-side mitigation for the
   clipped board, not just a type-size preference. */
const SCALE_KEY = 'chud.uiscale';
const SCALE_MIN = 0.8;
const SCALE_MAX = 1.3;
const SCALE_DEFAULT = 1;

// `Number('')` is 0, not NaN, so a blank key would clamp to the FLOOR and a
// player whose storage got half-written would silently boot at 80%. Measured:
// before this guard, localStorage['chud.uiscale'] = '' rendered --s at 11.47px
// instead of 14.34px. Blank is missing, and missing is the default.
function clampScale(v) {
  // Number('') and Number(null) are both 0 — finite, so they would survive the
  // guard below and clamp to the FLOOR. Blank and absent are neither a size
  // nor an error; they are the default.
  if (v == null || (typeof v === 'string' && v.trim() === '')) return SCALE_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return SCALE_DEFAULT;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
}

export function getScale() {
  try {
    const raw = localStorage.getItem(SCALE_KEY);
    return raw == null ? SCALE_DEFAULT : clampScale(raw);
  } catch { return SCALE_DEFAULT; }        // private mode
}

export function setScale(v) {
  const n = clampScale(v);
  applyScale(n);
  try { localStorage.setItem(SCALE_KEY, String(n)); } catch { /* private mode */ }
}

/** The only writer of --ui-scale. Left unset at the default so the cascade
 *  keeps variables.css's own `--ui-scale: 1` and the computed style of a
 *  default session is byte-identical to one from before this setting existed. */
function applyScale(n) {
  const root = document.documentElement;
  if (n === SCALE_DEFAULT) root.style.removeProperty('--ui-scale');
  else root.style.setProperty('--ui-scale', String(n));
}

// Applied at module evaluation, not at mount(): mount() runs inside boot()
// after table.mount() has already built the table, and re-scaling it there is
// a visible jump on every load for anyone not at 100%. The import graph
// resolves before boot() runs, so this lands before first paint.
applyScale(getScale());

/* ══ THEME ══════════════════════════════════════════════════════════════════
   ART §2 ships two full appearances — "apron, daylight" and "apron, night" —
   selected three ways: bare `:root` is light, `prefers-color-scheme: dark`
   flips it, and `:root[data-theme]` overrides both (variables.css:268). The
   third of those had NO user control. The app followed the OS and nothing else,
   which is a design system half-delivered: a player on a dark-set laptop who
   wants to look at the cards in daylight had no way to ask.

   THE OVERRIDE WAS VERIFIED BEFORE IT WAS PROMISED, not assumed from reading
   the stylesheet. tools/lib/theme.mjs already drives exactly this path as its
   `override` mode — media dark plus [data-theme=light] — and checkContrast.mjs
   measures all three, so "the attribute did not beat the media query" is
   already a gate failure and has been passing. Setting the attribute from JS is
   the same mutation applyTheme() performs.

   THREE VALUES, NOT TWO. 'auto' is the default and is the ABSENCE of the
   attribute, not a third token set — that matters twice over:
     · it is the only value that tracks an OS light/dark schedule, which is
       what most people actually want, so a two-way switch would force everyone
       to give that up to express a preference once;
     · determinism. tools/lib/harness.mjs pristineStorage clears localStorage
       before every capture, so the gate reads 'auto', removeAttribute() is a
       no-op on a document that never had one, and every screenshot hash is
       what it was before this control existed. applyTheme() then sets or clears
       the attribute itself, AFTER this module has run, so the tools still win.

   THE ACCESSIBILITY FLOOR IS NOT AT RISK HERE, and that is a property of the
   design rather than a promise: both branches are complete, ratified token sets
   that checkContrast measures at 0 violations. This control cannot mix them —
   it selects one whole appearance. That is the difference between it and the
   scale slider, which had to be clamped because it interpolates.

   NO SYSTEM LISTENER. Under 'auto' the media query is the cascade's own job;
   adding a matchMedia('change') handler that re-asserted the attribute would
   only give this module a way to fight tools/lib/theme.mjs mid-capture. */
const THEME_KEY = 'chud.theme';
const THEMES = ['auto', 'light', 'dark'];
const THEME_DEFAULT = 'auto';
const THEME_LABEL = { auto: 'System', light: 'Light', dark: 'Dark' };

export function getTheme() {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return THEMES.includes(raw) ? raw : THEME_DEFAULT;
  } catch { return THEME_DEFAULT; }        // private mode
}

export function setTheme(value) {
  const next = THEMES.includes(value) ? value : THEME_DEFAULT;
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
}

/** The only writer of [data-theme]. 'auto' REMOVES it rather than writing a
 *  token, so the cascade falls back to prefers-color-scheme exactly as it did
 *  before this setting existed. */
function applyTheme(value) {
  const root = document.documentElement;
  if (value === THEME_DEFAULT) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', value);
}

// Module scope, for the same reason applyScale is: boot() has already built the
// table by the time mount() runs, and repainting the whole apron there is a
// visible flash on every load for anyone not on 'auto'.
applyTheme(getTheme());

/* ── §3.13 the hand during a payment ────────────────────────────────────────
 *
 * `4a8e282` retracted the fan whenever the prompt is a payment, on the measured
 * ground that the hand is the ONE surface that cannot answer it — `payableCards`
 * (game.js:1128) is bank + properties + upgrades — and that 67 of 71 production
 * response timeouts were somebody sitting on a payment prompt.
 *
 * That reasoning is about REACH, and reach is only scarce on a phone. On a desktop
 * the bank row and the property columns are already above the fold, nothing needs
 * lifting, and hiding the hand only removes information a player wants while
 * deciding what to give up — which cards they hold is exactly what tells them
 * whether a property is worth defending. Owner directive, 2026-08-12.
 *
 * So the retract becomes device-aware by default and overridable always:
 *   auto — retract on coarse/short screens only (where it was measured)
 *   show — never retract
 *   hide — always retract (the behaviour 4a8e282 shipped)
 *
 * `auto` REMOVES the attribute rather than writing a token, exactly as applyTheme
 * does, so the cascade falls back to the media query on its own and a player who
 * never opens settings gets the measured behaviour on the device it was measured on.
 */
const PAYHAND_KEY = 'chud.payhand';
const PAYHANDS = ['auto', 'show', 'hide'];
const PAYHAND_DEFAULT = 'auto';
const PAYHAND_LABEL = { auto: 'Auto', show: 'Show', hide: 'Hide' };

export function getPayHand() {
  try {
    const raw = localStorage.getItem(PAYHAND_KEY);
    return PAYHANDS.includes(raw) ? raw : PAYHAND_DEFAULT;
  } catch { return PAYHAND_DEFAULT; }       // private mode
}

export function setPayHand(value) {
  const next = PAYHANDS.includes(value) ? value : PAYHAND_DEFAULT;
  applyPayHand(next);
  try { localStorage.setItem(PAYHAND_KEY, next); } catch { /* private mode */ }
}

/** The only writer of [data-payhand]. */
function applyPayHand(value) {
  const root = document.documentElement;
  if (value === PAYHAND_DEFAULT) root.removeAttribute('data-payhand');
  else root.setAttribute('data-payhand', value);
}

// Module scope, same reason as applyTheme: the dock exists before mount() runs.
applyPayHand(getPayHand());

function payHandRow(body) {
  const current = getPayHand();
  const strip = el('div', {
    class: 'rule-seg', attrs: { role: 'radiogroup', 'aria-label': 'Hand while paying' },
  }, PAYHANDS.map((value) => {
    const input = el('input', {
      class: 'rule-input',
      attrs: { type: 'radio', name: 'chud-payhand', value, ...(value === current ? { checked: true } : {}) },
    });
    input.addEventListener('change', () => { if (input.checked) setPayHand(value); });
    return el('label', { class: 'seg seg-wide' }, [
      input, el('span', { class: 'seg-face', text: PAYHAND_LABEL[value] }),
    ]);
  }));

  body.appendChild(el('div', { class: 'settings-row' }, [
    el('span', { class: 'settings-label', text: 'Hand while paying' }),
    strip,
  ]));
}

/**
 * A segmented radio group, not a <select> and not a switch. Three mutually
 * exclusive values want a radiogroup's semantics (arrow keys traverse, the
 * group has one accessible name), and lobby.css already draws this exact
 * control for "Sets to win" — `.rule-seg` / `.seg` / `.seg-face` — so this is
 * the app's existing segmented strip rather than a fourth control shape.
 * The inputs stay real and merely visually hidden (.rule-input), which is the
 * rule that file states: never a <div role="radio">.
 */
function themeRow(body) {
  const current = getTheme();
  const strip = el('div', {
    class: 'rule-seg', attrs: { role: 'radiogroup', 'aria-label': 'Theme' },
  }, THEMES.map((value) => {
    const input = el('input', {
      class: 'rule-input',
      attrs: { type: 'radio', name: 'chud-theme', value, ...(value === current ? { checked: true } : {}) },
    });
    input.addEventListener('change', () => { if (input.checked) setTheme(value); });
    return el('label', { class: 'seg seg-wide' }, [
      input, el('span', { class: 'seg-face', text: THEME_LABEL[value] }),
    ]);
  }));

  body.appendChild(el('div', { class: 'settings-row' }, [
    el('span', { class: 'settings-label', text: 'Theme' }),
    strip,
  ]));
}

/**
 * One switch + slider bound to one pair of engine getters/setters.
 * @param {{id:string, label:string, isOn:Function, setOn:Function,
 *          getVol:Function, setVol:Function, preview?:boolean}} spec
 */
function channel(body, spec) {
  const toggle = el('input', {
    id: `set-${spec.id}`, class: 'switch-input', attrs: { type: 'checkbox' },
  });
  toggle.checked = !!spec.isOn();

  const slider = el('input', {
    id: `set-${spec.id}-vol`, class: 'slider',
    attrs: {
      type: 'range', min: '0', max: '100', step: '5',
      'aria-label': `${spec.label} volume`,
    },
  });
  slider.value = String(Math.round(spec.getVol() * 100));
  const readout = el('span', { class: 'settings-readout', text: pct(spec.getVol()) });

  const sync = () => {
    setAttr(slider, 'disabled', toggle.checked ? null : true);
    setText(readout, toggle.checked ? pct(spec.getVol()) : 'muted');
  };

  toggle.addEventListener('change', () => {
    spec.setOn(toggle.checked);
    // A settings change is itself a user gesture, so the graph may be built here
    // (§7: never before one). init() is idempotent and a no-op under the harness.
    if (toggle.checked) { audio.init(); if (spec.preview !== false) audio.play('ui_tick'); }
    sync();
  });
  slider.addEventListener('input', () => {
    spec.setVol(Number(slider.value) / 100);
    setText(readout, pct(spec.getVol()));
  });
  // Preview on release only — one tick per drag, not one per step. Music needs
  // no preview: changing its volume is audible in the bed already playing.
  slider.addEventListener('change', () => {
    audio.init();
    if (spec.preview !== false) audio.play('ui_tick');
  });

  body.appendChild(el('div', { class: 'settings-row' }, [
    el('label', { class: 'settings-label', text: spec.label, attrs: { for: toggle.id } }),
    el('span', { class: 'switch' }, [toggle, el('span', { class: 'switch-face' })]),
  ]));
  body.appendChild(el('div', { class: 'settings-row' }, [
    el('label', { class: 'settings-label', text: 'Volume', attrs: { for: slider.id } }),
    slider,
    readout,
  ]));
  sync();
}

/**
 * The UI scale row. A native range input for the same reason every other
 * control here is native: arrows move it without us writing a key handler
 * (§0.9). Percent, not a multiplier, because "90%" is the unit players already
 * read on the two volume rows above it.
 */
function scaleRow(body) {
  const slider = el('input', {
    id: 'set-uiscale', class: 'slider',
    attrs: {
      type: 'range',
      min: String(Math.round(SCALE_MIN * 100)),
      max: String(Math.round(SCALE_MAX * 100)),
      step: '5',
      'aria-label': 'Interface scale',
    },
  });
  slider.value = String(Math.round(getScale() * 100));
  const readout = el('span', { class: 'settings-readout', text: pct(getScale()) });

  // `input`, not `change`: the whole point is that the table behind the sheet
  // resizes under the thumb, so the player picks a size by seeing it.
  slider.addEventListener('input', () => {
    setScale(Number(slider.value) / 100);
    setText(readout, pct(getScale()));
  });

  body.appendChild(el('div', { class: 'settings-row' }, [
    el('label', { class: 'settings-label', text: 'Interface scale', attrs: { for: slider.id } }),
    slider,
    readout,
  ]));
}

export function show() {
  const body = el('div', { class: 'settings' });

  channel(body, {
    id: 'sound', label: 'Sound',
    isOn: audio.isEnabled, setOn: audio.setEnabled,
    getVol: audio.getVolume, setVol: audio.setVolume,
  });
  channel(body, {
    id: 'music', label: 'Music',
    isOn: audio.isMusicEnabled, setOn: audio.setMusicEnabled,
    getVol: audio.getMusicVolume, setVol: audio.setMusicVolume,
    preview: false,
  });

  themeRow(body);
  payHandRow(body);
  scaleRow(body);

  body.appendChild(el('p', {
    class: 'hint',
    text: 'Interface scale resizes the cards and text. Buttons and card targets keep their '
      + 'full tap size at every setting, so a smaller table is still a hittable one.',
  }));

  body.appendChild(el('p', {
    class: 'hint',
    text: 'Hand while paying: on a phone the fan folds away during a payment so the bank and '
      + 'your properties — the only cards that can actually pay — sit above the fold. Swipe up '
      + 'on the dock to look at your hand without losing the prompt. On a wider screen nothing '
      + 'needs folding, so the hand stays put.',
  }));

  body.appendChild(el('p', {
    class: 'hint',
    text: 'Reduced motion is followed automatically from your system setting — cards fade '
      + 'instead of flying, and the sound stays.',
  }));

  body.appendChild(el('button', {
    class: 'btn btn-primary', text: 'How to play',
    attrs: { type: 'button' }, dataset: { action: 'help' },
  }));
  body.appendChild(el('button', {
    class: 'btn btn-ghost', text: 'Show first-game hints again',
    attrs: { type: 'button' }, dataset: { action: 'reset-hints' },
  }));

  openSheet('Settings', body);
}

export function mount() {
  pointer.registerActions({
    settings: () => show(),
    'reset-hints': () => { hints.reset(); closeSheet(); },
  });
  // The "How to play" button carries data-action="help", which ui/overlays.js
  // registers — one handler, one paged brief, no second entry point to drift.
}
