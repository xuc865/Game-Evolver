// test/ui-payhand.test.js — §3.13, the hand during a payment.
//
// `4a8e282` folds the fan whenever the prompt is a payment, because the hand is the one
// surface that cannot answer it (payableCards is bank + properties + upgrades) and on a phone
// the two surfaces that CAN were below the fold. That reasoning is about REACH, which is only
// scarce on a phone. Owner directive 2026-08-12: desktop keeps its hand, the fold is a
// setting, and on a phone the hand stays reachable by swiping the dock up.
//
// These are text assertions rather than DOM ones on purpose: settings.js applies the
// preference at MODULE SCOPE (the same trick applyTheme uses to avoid a flash on boot), so
// importing it in node touches `document` before a test could stub it. What is pinned here is
// the contract between the three files, which is where this feature can silently rot.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (p) => readFileSync(join(__dirname, '..', p), 'utf8');
const CSS = read('public/style/table.css');
const PEEK = read('public/src/interact/handpeek.js');
const SETTINGS = read('public/src/ui/settings.js');
const MAIN = read('public/src/main.js');

test('the three pay-hand states exist and auto is the media-gated one', () => {
  assert.match(CSS, /:root\[data-payhand="show"\][\s\S]*?#zone-hand/,
    'no `show` override — the desktop directive is what this whole change is for');
  // `auto` is the ABSENCE of the attribute, so its rule must be the one inside a media query
  // and must exclude an explicit `hide`. Without the :not(), choosing Hide on a laptop would
  // silently do nothing, which is the failure a reader would never think to check.
  const autoRule = CSS.match(/@media \(min-width:[^)]*\) and \(min-height:[^)]*\) \{[\s\S]{0,400}?\}/);
  assert.ok(autoRule, 'the auto rule must be inside a width+height media query');
  assert.match(autoRule[0], /:root:not\(\[data-payhand="hide"\]\)/,
    'the auto rule must yield to an explicit Hide, or the setting is a no-op on desktop');
});

test('settings.js is the only writer of [data-payhand]', () => {
  const writers = [PEEK, MAIN, CSS].filter(src => /setAttribute\(['"]data-payhand/.test(src));
  assert.equal(writers.length, 0, 'only ui/settings.js may write the attribute');
  assert.match(SETTINGS, /removeAttribute\('data-payhand'\)/,
    "`auto` must REMOVE the attribute, not write a token — otherwise the media query "
    + 'never gets to decide, exactly as applyTheme documents for [data-theme]');
  assert.match(SETTINGS, /chud\.payhand/, 'the preference must persist under a chud.* key');
});

test('the peek class name agrees between the gesture and the stylesheet', () => {
  // Two files, one string. If either side is renamed the swipe silently stops revealing
  // anything and every gate still passes, because nothing else reads it.
  assert.match(PEEK, /classList\.add\('is-peeking'\)/);
  assert.match(CSS, /\.hand-dock\.is-peeking #zone-hand/);
});

test('the peek reads pointer-events, never a measured height', () => {
  // THE BUG THIS PINS, found by driving a real phone browser: the fold animates
  // max-block-size/opacity/padding over 180ms, so a getBoundingClientRect() height taken while
  // the prompt is still opening returns a half-collapsed ~12px, folded() answers false, and the
  // swipe is ignored for the fifth of a second a player is most likely to try it. Measured:
  // fan 12.2px at pointerdown -> swipe ignored -> fan 0.0px. `pointer-events` is in the same
  // rule and deliberately NOT in its transition list, so it flips the instant the fold applies.
  assert.match(PEEK, /getComputedStyle\([\s\S]{0,40}?\)\.pointerEvents === 'none'/,
    'foldedness must be read from pointer-events');
  assert.doesNotMatch(PEEK, /getBoundingClientRect\(\)\.height/,
    'a height read is transition-dependent and was the original defect');
  // ...and the CSS side of that contract: pointer-events must stay OUT of the transition list.
  const fold = CSS.match(/\.screen-game:has\(#prompt\[data-state="payment"\]\) #zone-hand \{[\s\S]*?\}/);
  assert.ok(fold, 'the fold rule must exist');
  assert.match(fold[0], /pointer-events: none/);
  const transition = fold[0].match(/transition:[^;]*/);
  assert.ok(transition, 'the fold animates, so it has a transition list');
  assert.doesNotMatch(transition[0], /pointer-events/,
    'pointer-events must not be transitioned, or folded() becomes time-dependent again');
});

test('the peek is scoped to one payment and cannot outlive it', () => {
  // A dock stuck open into the next prompt would cover the board with no way back.
  assert.match(PEEK, /STATE_APPLIED[\s\S]{0,80}?close\(\)/,
    'a state change with no payment open must close the peek');
  assert.match(PEEK, /dataset\.state === 'payment'/,
    'the gesture must key off the same prompt state the stylesheet does');
});

test('handpeek is mounted at boot', () => {
  assert.match(MAIN, /import \* as handpeek from '\.\/interact\/handpeek\.js'/);
  assert.match(MAIN, /handpeek\.mount\(\)/);
});
