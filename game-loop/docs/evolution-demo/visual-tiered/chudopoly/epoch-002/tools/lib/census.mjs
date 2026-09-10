/**
 * tools/lib/census.mjs — enumerate THE CLIENT'S OWN SURFACE SPACE from source,
 * so a gate can be asked the only question that matters about coverage:
 * *which states this product can be in has nothing ever looked at?*
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * WHY IT DERIVES ITSELF. Six independent agents each found a blind spot by
 * tripping over it — a host lobby nothing had rendered, a `myColor` step with
 * no driver, an opponent's upgrade lane that appeared in no fixture, an
 * opponent at six colours, an armed opponent, `#toast` and `.announce`. All six
 * were reachable in ordinary play and invisible to twelve gates, and every one
 * was discovered by archaeology. A hand-written list of surfaces would have had
 * the same hole, because it is written by the same people who wrote the gates.
 * So the list is not written: it is READ OUT OF THE CLIENT, and it goes stale
 * only if the client stops describing itself.
 *
 * WHAT COUNTS AS A SURFACE. A marker is a conditional visual state that
 *   (a) `public/style/` has a rule for — the design system says it looks like
 *       something, so somebody meant it to be seen — and
 *   (b) `public/src/` or `public/index.html` can produce.
 * That intersection is the honest definition of "a way this product can look".
 * Five kinds, all read from source:
 *
 *   class:is-*      state/modifier classes (`.is-refusing`, `.is-collapsed`).
 *                   The `is-`/`has-`/`no-` prefix is this codebase's own
 *                   convention for "a state", so the filter is the project's,
 *                   not one invented here.
 *   attr:data-x=v   attribute-VALUE selectors (`[data-droppable="1"]`,
 *                   `[data-collapsed="1"]`, `[data-theme="light"]`). A value
 *                   selector is a branch by definition.
 *   layer:#id       shell elements index.html ships `hidden` — a layer that
 *                   starts hidden exists to be shown.
 *   screen:name     `#screen-*` in index.html.
 *   mode:kind /     the interaction machine's states and its `needs` steps,
 *   step:name       read out of interact/index.js. `mode.kind` is not in the
 *                   DOM; §9 puts it on the bridge, which is how a tool sees it.
 *
 * WHAT IT DELIBERATELY DOES NOT COUNT. Plain layout classes (`.card`, `.rail`)
 * are not states — they are always on, so "covered" would be meaningless. And
 * markers a mutation-style tool cannot hold still (a 90ms flash) are EXEMPT
 * below, each with the reason and each checked to still exist: an exemption for
 * a marker that has been deleted is itself a failure, so the exemption list
 * cannot rot into a way of hiding coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const PUBLIC = path.join(ROOT, 'public');
const STYLE = path.join(PUBLIC, 'style');
const SRC = path.join(PUBLIC, 'src');
const INDEX = path.join(PUBLIC, 'index.html');

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Markers that cannot be held still long enough for any capture to see, plus
 * the one reason each. Every entry is checked against the enumerated set: an
 * exemption naming a marker that no longer exists FAILS, so this list is a
 * record of decisions rather than a place to put things.
 */
export const EXEMPT = {
  'class:is-flying': 'a card mid-arc between two zones; the frame it exists in is the frame the '
    + 'choreographer is drawing, and stableScreenshot exists to refuse exactly that frame',
  'class:is-landing': 'the last 120ms of a flight (anim/flight.js), same reason',
  'class:is-hero': 'the hero beat of a big moment; transient half of a flight',
  'class:is-dropping': 'the release half of a drag — over before the pointer is up',
  'class:is-unpressing': 'the press-release spring, 120ms',
  'class:is-pressed': 'held only while a finger is down on a control',
  'class:is-refused': 'the 420ms refusal shake. Its PERSISTENT half (`is-refusing`) is the '
    + 'covered one — see the note on the `refusal` driver in lib/drivers.mjs',
  'class:is-riffling': 'the deck riffle, an ambient loop with no settled state',
  'class:is-changed': 'a 1-frame flash on a number that just moved',
  'class:is-hit': 'the damage flash on a seat that just paid',
  'class:is-in': 'the fade-IN half of an announce/toast; the settled state is the class without it',
  'class:is-empty': 'the hud-strip with its paint turned OFF — content.css makes it '
    + '`visibility: hidden` (display: none under 1023px) precisely so the reserved band '
    + 'cannot move the felt. Its entire visible effect is that nothing is painted, and '
    + 'observeMarkers counts only PAINTED nodes by design, so the marker is structurally '
    + 'unobservable: there is no frame in which it is both on and visible',
  'attr:data-facing=down': 'the face-down half of a card flight. table/index.js spawnCard '
    + 'sets it only with `faceDown: animate` (anim in progress) and anim/flight.js flips it '
    + 'up at the arc\'s half-turn — no settled zone in this client rests a card face-down, '
    + 'so the only frames carrying it are the mid-flight ones stableScreenshot refuses '
    + '(same transient family as is-flying/is-landing above)',
};

/** Read `public/style/*.css` and return every state class + value selector. */
function fromStylesheets() {
  const classes = new Map();      // name → file it is styled in
  const attrs = new Map();        // `data-x=v` → file
  for (const file of walk(STYLE, '.css')) {
    const rel = path.relative(ROOT, file);
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/\.((?:is|has|no)-[\w-]+)/g)) {
      if (!classes.has(m[1])) classes.set(m[1], rel);
    }
    for (const m of text.matchAll(/\[(data-[a-z-]+)\s*[~^|*$]?=\s*['"]?([^\]'"]+)['"]?\]/g)) {
      const key = `${m[1]}=${m[2].trim()}`;
      if (!attrs.has(key)) attrs.set(key, rel);
    }
  }
  return { classes, attrs };
}

/** Everything the client can WRITE: js sources plus the shell. */
function clientSources() {
  const files = walk(SRC, '.js');
  if (fs.existsSync(INDEX)) files.push(INDEX);
  return files.map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));
}

/** Does any client source contain this literal token? */
function producedBy(sources, token) {
  const re = new RegExp(`(^|[^\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`);
  for (const s of sources) if (re.test(s.text)) return s.rel;
  return null;
}

const camel = (attr) => attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * The two ways this client writes a marker WITHOUT ever spelling it out, both
 * found by the first census run reporting them as unreachable when they are
 * not:
 *   `el.dataset.type = card.type`        never contains the string "data-type"
 *   `announce is-${kind}` / `is-${outcome}`  never contains "is-win"
 * So a marker also counts as produced when the attribute's dataset name is
 * written, or when a class template exists AND the suffix appears as a string
 * literal somewhere in the client. Both are weaker than a literal match and
 * both are recorded as such, because "we could not prove it is unreachable" is
 * a different claim from "we found where it is written".
 */
function producedIndirectly(sources, marker) {
  if (marker.startsWith('data-')) {
    const attr = marker.split('=')[0];
    const key = camel(attr);
    const hit = producedBy(sources, `dataset.${key}`);
    if (hit) return { where: hit, how: 'dataset' };
    // core/dom.js `el(tag, { dataset: { type: … } })` — the commonest way this
    // client writes a data attribute, and the one that spells out neither
    // `data-type` nor `dataset.type`. Found because the first census run
    // called five live `[data-type]` selectors unreachable while 40 elements
    // on a staged mid-game table were carrying the attribute.
    const inObject = new RegExp(`dataset:\\s*\\{[^}]*\\b${key}\\s*:`, 's');
    const obj = sources.find((x) => inObject.test(x.text));
    if (obj) return { where: obj.rel, how: 'dataset-literal' };
    return null;
  }
  const suffix = marker.replace(/^(is|has|no)-/, '');
  const prefix = marker.slice(0, marker.indexOf('-') + 1);
  const template = sources.find((s) => s.text.includes(`${prefix}\${`));
  if (!template) return null;
  const lit = sources.find((s) => new RegExp(`['"\`]${suffix}['"\`]`).test(s.text));
  return lit ? { where: `${template.rel} (template) + ${lit.rel}`, how: 'template' } : null;
}

function shellLayers() {
  if (!fs.existsSync(INDEX)) return [];
  const html = fs.readFileSync(INDEX, 'utf8');
  const out = new Set();
  for (const m of html.matchAll(/<[a-z]+\b([^>]*)>/g)) {
    const tag = m[1];
    if (!/\bhidden\b/.test(tag)) continue;
    const id = /\bid="([\w-]+)"/.exec(tag);
    if (id) out.add(id[1]);
  }
  return [...out];
}

function screens() {
  if (!fs.existsSync(INDEX)) return [];
  const html = fs.readFileSync(INDEX, 'utf8');
  return [...html.matchAll(/id="screen-([\w-]+)"/g)].map((m) => m[1]);
}

function interactionStates() {
  const file = path.join(SRC, 'interact', 'index.js');
  if (!fs.existsSync(file)) return { kinds: [], steps: [] };
  const text = fs.readFileSync(file, 'utf8');
  const kinds = new Set();
  for (const m of text.matchAll(/mode\.kind\s*=\s*'([\w-]+)'/g)) kinds.add(m[1]);
  const steps = new Set();
  const hints = /const HINTS\s*=\s*\{([\s\S]*?)\n\};/.exec(text);
  if (hints) for (const m of hints[1].matchAll(/^\s*([A-Za-z]\w*)\s*:/gm)) steps.add(m[1]);
  return { kinds: [...kinds], steps: [...steps] };
}

/**
 * The census.
 * @returns {{markers:Array<{key,sel,kind,where,styledIn}>, orphans:Array<{key,styledIn}>}}
 *   `markers` — styled AND producible: the surface space a gate must cover.
 *   `orphans` — styled but produced nowhere in the client. Not a coverage
 *   failure (nothing can reach them, so no gate could); reported because
 *   "the stylesheet describes a state the client cannot enter" is worth
 *   one line and is invisible from every other angle.
 */
export function census() {
  const { classes, attrs } = fromStylesheets();
  const sources = clientSources();
  const markers = [];
  const orphans = [];

  for (const [name, styledIn] of classes) {
    const direct = producedBy(sources, name);
    const indirect = direct ? null : producedIndirectly(sources, name);
    const where = direct || indirect?.where;
    if (where) markers.push({ key: `class:${name}`, sel: `.${name}`, kind: 'class', where, styledIn, how: indirect?.how });
    else orphans.push({ key: `class:${name}`, styledIn });
  }
  for (const [key, styledIn] of attrs) {
    const [attr, value] = key.split('=');
    // `data-theme` is set by the harness itself (lib/theme.mjs) and by the
    // settings sheet; either way the attribute name is the producible token.
    const direct = producedBy(sources, attr);
    const indirect = direct ? null : producedIndirectly(sources, key);
    const where = direct || indirect?.where;
    const sel = `[${attr}="${value}"]`;
    if (where) markers.push({ key: `attr:${key}`, sel, kind: 'attr', where, styledIn, how: indirect?.how });
    else orphans.push({ key: `attr:${key}`, styledIn });
  }
  for (const id of shellLayers()) {
    markers.push({ key: `layer:${id}`, sel: `#${id}`, kind: 'layer', where: 'public/index.html', styledIn: '' });
  }
  for (const name of screens()) {
    markers.push({ key: `screen:${name}`, sel: `#screen-${name}`, kind: 'screen', where: 'public/index.html', styledIn: '' });
  }
  const { kinds, steps } = interactionStates();
  for (const k of kinds) {
    markers.push({ key: `mode:${k}`, sel: null, kind: 'mode', where: 'public/src/interact/index.js', styledIn: '' });
  }
  for (const st of steps) {
    markers.push({ key: `step:${st}`, sel: null, kind: 'step', where: 'public/src/interact/index.js', styledIn: '' });
  }

  markers.sort((a, b) => a.key.localeCompare(b.key));
  orphans.sort((a, b) => a.key.localeCompare(b.key));
  return { markers, orphans };
}

/**
 * IN-PAGE. Which of these markers is on screen right now?
 *
 * Serialised into the page by `page.evaluate`, so it takes the marker list as
 * an argument and closes over nothing. VISIBLE, not merely present: a card in
 * a hidden sheet carries its classes the whole time, and "the DOM contains it"
 * is the kind of coverage claim this file exists to stop making.
 */
export function observeMarkers(markers) {
  const seen = [];
  const shown = (el) => {
    for (let p = el; p; p = p.parentElement) if (p.hasAttribute?.('hidden')) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  for (const m of markers) {
    if (m.sel) {
      let hit = false;
      let nodes = [];
      try { nodes = document.querySelectorAll(m.sel); } catch { nodes = []; }
      for (const el of nodes) { if (shown(el)) { hit = true; break; } }
      if (hit) seen.push(m.key);
      continue;
    }
    const bridge = window.__CHUD;
    if (m.key.startsWith('mode:') && bridge?.mode?.kind === m.key.slice(5)) seen.push(m.key);
    if (m.key.startsWith('step:') && (bridge?.mode?.needs || []).includes(m.key.slice(5))) seen.push(m.key);
  }
  return seen;
}
