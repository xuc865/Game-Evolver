// Contract tests for the surface census (tools/lib/census.mjs, tools/coverage.mjs).
//
// The census is the thing that is supposed to notice when a surface has no gate
// on it, so the failure mode that matters is the census going QUIET — a regex
// that stops matching, a stylesheet that moves, a source layout change that
// makes `producedBy` find nothing. A census that enumerates zero markers reports
// perfect coverage, which is the §8 "a gate that measured nothing must not pass"
// failure wearing the friendliest possible face.
//
// These run in `npm test`, not in the browser: they are about the enumeration,
// not about what any capture saw.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

let census;
let EXEMPT;
let observeMarkers;

test.before(async () => {
  ({ census, EXEMPT, observeMarkers } = await import('../tools/lib/census.mjs'));
});

test('the census enumerates a real surface space, not an empty one', () => {
  const { markers } = census();
  // 133 on the day this landed. The floor is deliberately far below that: this
  // asserts the enumeration still WORKS, and a tighter number would just be a
  // second place to update every time the client grows a state.
  assert.ok(markers.length > 60, `only ${markers.length} markers enumerated — the census has gone blind`);
  for (const kind of ['class', 'attr', 'layer', 'screen', 'mode', 'step']) {
    assert.ok(markers.some((m) => m.kind === kind), `no '${kind}' markers — that extractor stopped matching`);
  }
});

test('every marker names where it is produced and how to look for it', () => {
  const { markers } = census();
  for (const m of markers) {
    assert.ok(m.key.includes(':'), `marker "${m.key}" has no kind prefix`);
    assert.ok(m.where, `marker ${m.key} does not say where it is produced`);
    // A DOM-visible marker must carry a selector; mode/step are read off the
    // §9 bridge instead, and carry `sel: null` on purpose.
    if (['class', 'attr', 'layer', 'screen'].includes(m.kind)) {
      assert.ok(m.sel, `marker ${m.key} has no selector, so nothing can observe it`);
    }
  }
});

test('the surfaces this round was built for are all in the census', () => {
  const keys = new Set(census().markers.map((m) => m.key));
  // If any of these stops being enumerated, the gate that now covers it stops
  // being able to report its absence — which is exactly the state the harness
  // was in before: the surface existed, and nothing knew to look for it.
  for (const key of [
    'layer:lobby-host',        // the host lobby
    'layer:btn-start',         // Launch Mission
    'step:myColor',            // the wild-placement step
    'attr:data-final-approach=1', // the ARMED treatment
    'layer:emotes',
    'mode:target',
    'mode:discard',
    'screen:lobby',
  ]) {
    assert.ok(keys.has(key), `census no longer enumerates ${key}`);
  }
});

test('no exemption outlives its marker', () => {
  const keys = new Set(census().markers.map((m) => m.key));
  for (const [key, why] of Object.entries(EXEMPT)) {
    assert.ok(keys.has(key), `EXEMPT names ${key}, which the census no longer enumerates — `
      + 'delete it rather than leaving a hiding place');
    assert.ok(why && why.length > 20, `EXEMPT[${key}] has no real reason recorded`);
  }
});

test('observeMarkers is self-contained enough to be serialised into a page', () => {
  // It is handed to page.evaluate, which drops the module scope. A closure over
  // anything in census.mjs would throw ReferenceError inside the browser and
  // the sidecar would silently record nothing.
  const src = observeMarkers.toString();
  for (const forbidden of ['EXEMPT', 'census(', 'require(', 'import(']) {
    assert.ok(!src.includes(forbidden), `observeMarkers references ${forbidden} from module scope`);
  }
  assert.ok(src.includes('__CHUD'), 'observeMarkers no longer reads mode/step off the §9 bridge');
});

test('the §9 bridge still exposes joinAs, which is what makes a lobby fixture honest', () => {
  const src = readFileSync('public/src/harness.js', 'utf8');
  assert.match(src, /bridge\.joinAs\s*=/, 'harness.js no longer exposes joinAs');
  assert.match(src, /NET_JOINED/, 'joinAs must go through the same bus event a real join does');
  const stage = readFileSync('tools/lib/stage.mjs', 'utf8');
  assert.match(stage, /joinAs/, 'stage.mjs no longer seats the client before applying a fixture');
});
