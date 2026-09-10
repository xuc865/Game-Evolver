// test/seo.test.js — the crawlable surface, and the one thing that makes it
// worth having: the numbers on the rules page come from the ENGINE.
//
// A rules page is a liability the moment it disagrees with the game. Prose is
// written by hand in server/pages.js and reviewed by hand; every NUMBER is read
// out of game.js at render time, and this file fails if one of them is typed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../game');
const pages = require('../server/pages');

const ORIGIN = 'https://chudopoly.deal';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const html = read('public/index.html');
const rules = pages.rulesPage(ORIGIN);
const mdRules = pages.mdRulesPage(ORIGIN);

/* ── 1. the documents exist, are documents, and say where they live ────── */

test('both rules pages are complete crawlable documents', () => {
  for (const [name, doc, url] of [['rules', rules, '/rules'], ['md', mdRules, '/monopoly-deal-rules']]) {
    assert.match(doc, /^<!DOCTYPE html>/, name);
    assert.match(doc, /<html lang="en">/, name);
    // Exactly one h1 — more than one and no crawler knows what the page is about.
    assert.equal((doc.match(/<h1>/g) || []).length, 1, `${name}: exactly one h1`);
    assert.match(doc, new RegExp(`<link rel="canonical" href="${ORIGIN}${url}">`), `${name}: canonical`);
    assert.match(doc, /<meta name="description" content="[^"]{80,200}">/, `${name}: description`);
    // Absolute, or the unfurl breaks the moment the link leaves the site.
    assert.match(doc, new RegExp(`<meta property="og:image" content="${ORIGIN}/og\\.png`), `${name}: og:image`);
    assert.ok(doc.length > 6000, `${name}: a thin page ranks for nothing (${doc.length} bytes)`);
  }
});

test('the structured data on every page parses and declares a type', () => {
  for (const [name, doc] of [['rules', rules], ['md', mdRules]]) {
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(doc);
    assert.ok(block, `${name}: ships structured data`);
    const parsed = JSON.parse(block[1]);
    assert.equal(parsed['@context'], 'https://schema.org', name);
    assert.ok(parsed['@type'], name);
  }
  // The FAQ page's questions are the reason it exists — every one needs an answer.
  const faq = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(mdRules)[1]);
  assert.equal(faq['@type'], 'FAQPage');
  assert.ok(faq.mainEntity.length >= 5, 'a FAQPage with two questions is not a FAQ');
  for (const q of faq.mainEntity) {
    assert.equal(q['@type'], 'Question');
    assert.ok(q.name.endsWith('?'), q.name);
    assert.ok(q.acceptedAnswer.text.length > 40, q.name);
  }
});

/* ── 2. THE ONE THAT MATTERS: the page agrees with the engine ──────────── */

test('every number on the rules page is the engine\'s number', () => {
  // Set sizes and rent ladders, colour by colour.
  for (const [key, c] of Object.entries(G.COLORS)) {
    assert.ok(rules.includes(pages.esc(c.name)), `${key}: the set is named`);
    const ladder = c.rent.map((r, i) => `${i + 1} → ${r}M`).join(' · ');
    assert.ok(rules.includes(ladder), `${key}: rent ladder "${ladder}"`);
  }
  // Hand limit and sets to win, in words, from the constants.
  assert.ok(rules.includes(`${G.HAND_LIMIT} cards`), 'the hand limit');
  assert.ok(rules.includes(`${G.SETS_TO_WIN} full property sets`), 'the win condition');
  assert.ok(rules.includes(String(G.DECK_CYCLE_LIMIT)), 'the deck-cycle limit');

  // Every action card in the stock deck is on the page, with ITS OWN text and
  // ITS OWN count — this is what catches a card renamed or rebalanced in
  // game.js and never carried across.
  const deck = G.buildDeck();
  const counts = new Map();
  for (const card of deck) {
    if (card.type !== 'action') continue;
    counts.set(card.action, (counts.get(card.action) || 0) + 1);
    assert.ok(rules.includes(pages.esc(card.name)), `${card.action}: named on the page`);
    assert.ok(rules.includes(pages.esc(card.description)), `${card.action}: its own card text`);
  }
  assert.ok(counts.size >= 10, 'the whole action family is covered');
  // Deck totals, by family.
  assert.ok(rules.includes(`<td><strong>${deck.length}</strong></td>`), 'the deck total');
  for (const type of ['property', 'wild_property', 'rent', 'money', 'action']) {
    const n = deck.filter((c) => c.type === type).length;
    assert.ok(rules.includes(`<td>${n}</td>`), `${type} count (${n})`);
  }
  // Presets, by their real setsToWin.
  for (const name of G.PRESET_NAMES) {
    assert.ok(rules.includes(`<td>${G.RULE_PRESETS[name].setsToWin}</td>`), `${name}: sets to win`);
  }
});

/* ── 3. robots and the sitemap agree with the routes ───────────────────── */

test('the sitemap lists every crawlable route, absolutely', () => {
  const xml = pages.sitemap(ORIGIN);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  for (const route of pages.ROUTES) {
    assert.ok(xml.includes(`<loc>${ORIGIN}${route}</loc>`), `sitemap lists ${route}`);
  }
  assert.equal((xml.match(/<loc>/g) || []).length, pages.ROUTES.length, 'no strays');
  // A relative <loc> is invalid and the whole file is dropped.
  assert.doesNotMatch(xml, /<loc>\//);
});

test('robots.txt allows the crawl and points at the sitemap', () => {
  const txt = pages.robots(ORIGIN);
  assert.match(txt, /^User-agent: \*/m);
  assert.match(txt, /^Allow: \//m);
  assert.doesNotMatch(txt, /^Disallow: \/$/m, 'a bare Disallow: / would delist the whole site');
  assert.ok(txt.includes(`Sitemap: ${ORIGIN}/sitemap.xml`), 'absolute sitemap URL');
});

/* ── 4. the home shell carries the signals a crawler reads ─────────────── */

test('the home page states, in text, what it is', () => {
  // The h1 used to be a drawing with an aria-label. An SVG title is not text.
  const h1 = /<h1 class="brand-title">([\s\S]*?)<\/h1>/.exec(html);
  assert.ok(h1, 'the home screen has an h1');
  const srOnly = /<span class="sr-only">([^<]+)<\/span>/.exec(h1[1]);
  assert.ok(srOnly, 'and the h1 contains real text, not only the mark');
  assert.match(srOnly[1], /Monopoly Deal/, 'which says what kind of game this is');
  // ...and the class has to actually exist, or the sentence is drawn over the mark.
  assert.match(read('public/style/base.css'), /\.sr-only\s*\{/, 'base.css defines .sr-only');
});

test('the head links the crawlable documents to the app and back', () => {
  // Internal links are how the two documents get discovered at all.
  for (const route of ['/rules', '/monopoly-deal-rules']) {
    assert.ok(rules.includes(`href="${route}"`) || mdRules.includes(`href="${route}"`),
      `${route} is linked from a document`);
  }
  assert.ok(rules.includes('href="/monopoly-deal-rules"'), 'rules → md rules');
  assert.ok(mdRules.includes('href="/rules"'), 'md rules → rules');
  assert.ok(rules.includes('href="/"') && mdRules.includes('href="/"'), 'both → the game');
  assert.ok(html.includes('href="/rules"'), 'and the app links out to them');
});

/* ── 5. the trademark position is stated wherever the name is used ─────── */

test('every page carrying the Monopoly Deal name also carries the disclaimer', () => {
  for (const [name, doc] of [['rules', rules], ['md', mdRules]]) {
    assert.match(doc, /Monopoly Deal/, name);
    assert.match(doc, /trademarks of Hasbro/, `${name}: names the holder`);
    assert.match(doc, /not affiliated with, endorsed by or sponsored by Hasbro/,
      `${name}: disclaims affiliation`);
  }
});

test('LICENSE is plain MIT so GitHub can detect it', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  // The trademark notice used to live at the bottom of this file, which made
  // GitHub's licence detector report "other" — no MIT badge, and the repo fell
  // out of every `license:mit` filter. It lives in TRADEMARKS.md now.
  assert.doesNotMatch(license, /Hasbro/, 'the trademark notice belongs in TRADEMARKS.md');
  assert.doesNotMatch(license, /^---$/m, 'nothing appended after the licence text');
  const marks = read('TRADEMARKS.md');
  assert.match(marks, /MONOPOLY and MONOPOLY DEAL are trademarks of Hasbro, Inc\./);
  assert.match(read('README.md'), /TRADEMARKS\.md/, 'and the README points at it');
});
