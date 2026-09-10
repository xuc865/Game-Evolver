#!/usr/bin/env node
/**
 * tools/checkClient.mjs — static gate over the new client (§8, §10).
 *
 * Cheap greps that catch the four invariants which are expensive to catch any
 * other way, because each one produces a bug that looks like something else:
 *
 *   innerHTML in table/ or anim/  → destroys card nodes mid-FLIP; presents as
 *                                   "animation randomly stops" (§0.4, §10)
 *   on*= in index.html            → CSP + XSS regression; presents as nothing
 *                                   at all until someone types a name (§2)
 *   setInterval in anim/          → second clock; presents as jitter under load
 *                                   that no profiler run reproduces (§0.6)
 *   uncached entry <script>       → stale module after deploy; presents as
 *                                   "works on my machine" (§0.2)
 *   Math.random in table/         → nondeterministic layout; presents as the
 *                                   screenshot harness never reproducing (§5)
 *
 * Exits 2 (SKIP) until public/src/ exists — P3 has not written it yet. The
 * index.html scans still RUN in that state and print as advisory, so the
 * architect sees the bar before writing the file rather than after.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, green, red, yellow, dim, bold, EXIT_PASS, EXIT_FAIL, EXIT_SKIP,
} from './lib/harness.mjs';

const SRC = path.join(ROOT, 'public', 'src');
const INDEX = path.join(ROOT, 'public', 'index.html');
const hasSrc = fs.existsSync(SRC) && fs.statSync(SRC).isDirectory();

console.log(bold('checkClient') + dim('  §8 static client invariants'));

let code = EXIT_PASS;
const advisory = [];
const pass = (m) => console.log(`  ${green('✓')} ${m}`);
const fail = (m) => {
  if (hasSrc) { code = EXIT_FAIL; console.log(`  ${red('✗')} ${m}`); }
  else advisory.push(m);
};

function walkFiles(dir, re) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full, re));
    else if (re.test(ent.name)) out.push(full);
  }
  return out;
}

/**
 * Strips // and /* comments and string/template literals before matching, so
 * a comment saying "never use innerHTML here" does not fail the innerHTML gate.
 * Deliberately crude — it only has to be right about which bytes are CODE.
 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === quote) { out += ' '; i++; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
    } else {
      out += c; i++;
    }
  }
  return out;
}

function scan(files, re, label, { code: codeOnly = true } = {}) {
  const hits = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const hay = codeOnly ? stripNonCode(raw) : raw;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(hay))) {
      const line = hay.slice(0, m.index).split('\n').length;
      hits.push(`${path.relative(ROOT, f)}:${line}  ${raw.split('\n')[line - 1]?.trim().slice(0, 90)}`);
    }
  }
  if (hits.length) {
    fail(`${hits.length} ${label}`);
    for (const h of hits.slice(0, 12)) console.log(`      ${dim(h)}`);
  } else if (hasSrc) {
    pass(`no ${label}`);
  }
  return hits.length;
}

// ---------------------------------------------------------------- public/src
if (hasSrc) {
  const jsIn = (sub) => walkFiles(path.join(SRC, sub), /\.m?js$/);

  const cardDirs = [...jsIn('table'), ...jsIn('anim')];
  scan(cardDirs, /\.innerHTML\s*=|\binsertAdjacentHTML\s*\(|\bouterHTML\s*=/, 'innerHTML/outerHTML write(s) in table\\/ or anim\\/');

  scan(jsIn('anim'), /\bsetInterval\s*\(/, 'setInterval call(s) in anim/ (§0.6: one clock, rAF via core/clock.js)');

  // core/rng.js is the sanctioned source of randomness; table layout must be
  // reproducible or screenshot.mjs can never diff.
  const tableFiles = jsIn('table').filter((f) => !/rng\.m?js$/.test(f));
  scan(tableFiles, /\bMath\.random\s*\(/, 'Math.random call(s) in table/ (use core/rng.js)');

  const allSrc = walkFiles(SRC, /\.m?js$/);
  if (!allSrc.length) fail('public/src/ contains no .js modules');
  else pass(`${allSrc.length} client module(s) scanned`);
} else {
  console.log(yellow('  public/src/ does not exist yet — src scans skipped'));
}

// ------------------------------------------------------- safe-area accounting
/**
 * P7 round 1: the mobile critic measured ~68px of dead chrome on a phone with
 * no notch. Cause: `.screen` pads for all four insets, and elements NESTED
 * inside a `.screen` (the hand dock, the side panel) added
 * `env(safe-area-inset-bottom)` again. On a real iPhone that is the
 * home-indicator gutter counted twice — a band of nothing where cards go.
 *
 * CONTAINMENT IS THE WHOLE POINT. `#sheet`, `#win-overlay`, `#toast`,
 * `#emotes` and the runtime `.hints` stack are children of `#app` and SIBLINGS
 * of `.screen`, so no owner padding ever reaches them and their own
 * `env(safe-area-inset-*)` is REQUIRED — remove it and the sheet sits under the
 * home indicator. A gate that cannot tell those two cases apart teaches the
 * design agent to delete padding that must stay, so this one reads
 * public/index.html and resolves each flagged selector against the real tree.
 *
 * touchtest measures the resulting dead space at runtime, but emulated Chromium
 * reports zero insets, so only the source shows the double-count.
 */
const STYLE = path.join(ROOT, 'public', 'style');

/**
 * Shell-level layers created at RUNTIME, so they are not in index.html and
 * cannot be resolved by parsing it. Each entry names the module that mounts it
 * and where, because that is the fact that makes its own inset legitimate.
 */
const RUNTIME_SHELL = {
  hints: 'public/src/ui/hints.js mounts .hints onto #app (sibling of .screen), not inside a screen',
  'hint-card': 'child of the runtime .hints container, itself an #app child',
};

/** Minimal well-formed-HTML tree: enough to answer "is X inside Y". */
function parseShell(html) {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const root = { tag: '#root', id: '', classes: [], children: [], parent: null };
  const stack = [root];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const [, close, tag, attrs, selfClose] = m;
    const name = tag.toLowerCase();
    if (close) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) { stack.length = i; break; }
      }
      continue;
    }
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || '';
    const cls = (/\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || '').trim();
    const node = {
      tag: name, id, classes: cls ? cls.split(/\s+/) : [],
      children: [], parent: stack[stack.length - 1],
    };
    node.parent.children.push(node);
    if (!selfClose && !VOID.has(name)) stack.push(node);
  }
  return root;
}

function flatten(node, out = []) {
  for (const c of node.children) { out.push(c); flatten(c, out); }
  return out;
}

/** Does a compound selector (`#id`, `.a.b`, `tag.a`) describe this node? */
function matchesCompound(node, compound) {
  const bare = compound.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '');   // drop pseudos
  const id = /#([A-Za-z0-9_-]+)/.exec(bare)?.[1];
  const classes = [...bare.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((x) => x[1]);
  const tag = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(bare)?.[1];
  if (id && node.id !== id) return false;
  if (tag && node.tag !== tag.toLowerCase()) return false;
  for (const c of classes) if (!node.classes.includes(c)) return false;
  return !!(id || classes.length || tag);
}

/** Rightmost compound of a selector — the element the rule actually styles. */
function keyCompound(sel) {
  const first = sel.split(',')[0].trim();
  return first.split(/[\s>+~]+/).filter(Boolean).pop() || first;
}

if (fs.existsSync(STYLE) && fs.existsSync(INDEX)) {
  const shell = parseShell(fs.readFileSync(INDEX, 'utf8'));
  const nodes = flatten(shell);

  const rules = [];
  for (const f of walkFiles(STYLE, /\.css$/)) {
    const text = fs.readFileSync(f, 'utf8');
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(text))) {
      const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
      // Comments are stripped from the BODY too. Without that, the design
      // agent's own note — "NO env(safe-area-inset-bottom) here: .screen
      // already pads it" — reads to a regex as a use of the thing it is
      // promising not to use, and the gate fails the fix.
      const body = m[2].replace(/\/\*[\s\S]*?\*\//g, ' ');
      if (!/env\(\s*safe-area-inset-/.test(body)) continue;
      if (/^@/.test(selector)) continue;
      rules.push({
        selector,
        line: text.slice(0, m.index).split('\n').length,
        file: path.relative(ROOT, f),
        // The OWNER is whoever pads for all four sides — the app/screen shell.
        owner: ['top', 'right', 'bottom', 'left'].every((s) => body.includes(`safe-area-inset-${s}`)),
      });
    }
  }

  const owners = rules.filter((r) => r.owner);
  const others = rules.filter((r) => !r.owner);

  if (!rules.length) {
    pass('no safe-area insets used (nothing to double-count)');
  } else if (owners.length > 1) {
    fail(`${owners.length} rules each pad for ALL FOUR safe-area insets — the gutters are counted ${owners.length}×`);
    for (const o of owners) console.log(`      ${dim(`${o.file}:${o.line}  ${o.selector.slice(0, 48)}`)}`);
  } else {
    // Every node the single owner rule pads, and everything under it.
    const ownedRoots = owners.length
      ? nodes.filter((n) => matchesCompound(n, keyCompound(owners[0].selector)))
      : [];
    const inOwned = (node) => {
      for (let p = node; p; p = p.parent) if (ownedRoots.includes(p)) return true;
      return false;
    };

    const doubled = [];
    const legit = [];
    const unresolved = [];
    for (const rule of others) {
      const key = keyCompound(rule.selector);
      const hits = nodes.filter((n) => matchesCompound(n, key));
      const where = `${rule.file}:${rule.line}  ${rule.selector.slice(0, 48)}`;
      if (!hits.length) {
        const token = (key.match(/[.#]([A-Za-z0-9_-]+)/g) || []).map((t) => t.slice(1));
        const allowed = token.find((t) => RUNTIME_SHELL[t]);
        if (allowed) legit.push(`${where}  ${dim(`— ${RUNTIME_SHELL[allowed]}`)}`);
        else unresolved.push(where);
        continue;
      }
      if (hits.some(inOwned)) doubled.push(`${where}  ${dim(`— nested inside ${owners[0].selector}`)}`);
      else legit.push(`${where}  ${dim('— #app-level sibling of the owner; its own inset is required')}`);
    }

    if (doubled.length) {
      fail(`${doubled.length} rule(s) add env(safe-area-inset-*) INSIDE ${owners[0]?.selector || 'the inset owner'} `
        + '— that gutter is applied twice');
      for (const d of doubled) console.log(`      ${d}`);
    } else {
      pass(`safe-area insets: owned by ${dim(owners[0]?.selector || '(none)')}, `
        + `${legit.length} shell-level rule(s) legitimately own their own`);
      for (const l of legit) console.log(`      ${dim(l)}`);
    }
    if (unresolved.length) {
      // Not a failure: an unresolvable selector is a gap in THIS gate, not
      // proven evidence of a defect. It is printed so it cannot rot silently.
      console.log(yellow(`  ! ${unresolved.length} safe-area rule(s) whose element is not in index.html and not in `
        + 'RUNTIME_SHELL — containment unverified:'));
      for (const u of unresolved) console.log(`      ${dim(u)}`);
    }
  }
}

// ---------------------------------------------------------------- index.html
if (fs.existsSync(INDEX)) {
  const html = fs.readFileSync(INDEX, 'utf8');

  // Inline handlers. Match only inside tags, so prose or a URL containing
  // "on..." in the body cannot trip it.
  const inline = [];
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let t;
  while ((t = tagRe.exec(html))) {
    const attrRe = /\s(on[a-z]+)\s*=/gi;
    let a;
    while ((a = attrRe.exec(t[0]))) {
      inline.push(`${a[1]} at line ${html.slice(0, t.index).split('\n').length}`);
    }
  }
  if (inline.length) {
    fail(`${inline.length} inline on*= handler(s) in public/index.html (§2: delegated handling only)`);
    for (const h of inline.slice(0, 12)) console.log(`      ${dim(h)}`);
  } else pass('no inline on*= handlers in public/index.html');

  // Cache-busted ES-module entry (§0.2).
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  const modules = scripts.filter((s) => /type\s*=\s*["']module["']/i.test(s) && /\ssrc\s*=/i.test(s));
  const entries = modules.filter((s) => /src\s*=\s*["']([^"']*\/src\/main\.m?js[^"']*)["']/i.test(s));
  const candidates = entries.length ? entries : modules;
  if (!candidates.length) {
    fail('no <script type="module" src="..."> entry in public/index.html (§0.2)');
  } else if (candidates.length > 1 && entries.length !== 1) {
    fail(`${candidates.length} module <script src> tags — §0.2 wants ONE entry with real imports below it`);
  } else {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(candidates[0])[1];
    if (/[?&]v=/.test(src)) pass(`entry is cache-busted ${dim(src)}`);
    else fail(`entry <script src="${src}"> is not cache-busted (needs ?v=…)`);
  }

  // Classic (non-module) app scripts mean the "no build step / real imports"
  // rule got walked back.
  const classic = scripts.filter((s) => /\ssrc\s*=/i.test(s) && !/type\s*=\s*["']module["']/i.test(s));
  if (classic.length) fail(`${classic.length} non-module <script src> tag(s) — §0.2 wants ES modules only`);
  else if (hasSrc) pass('no classic <script src> tags');
} else {
  fail('public/index.html is missing');
}

// ---------------------------------------------------------------- verdict
if (!hasSrc) {
  if (advisory.length) {
    console.log(yellow(`  ${advisory.length} advisory finding(s) against the CURRENT client (not gated, P3 replaces it):`));
    for (const a of advisory) console.log(`      ${dim(a)}`);
  }
  console.log(yellow(bold('  PENDING CLIENT')) + ' — public/src/ (P3) has not landed yet');
  process.exit(EXIT_SKIP);
}
console.log(code === EXIT_PASS ? green(bold('checkClient: PASS')) : red(bold('checkClient: FAIL')));
process.exit(code);
