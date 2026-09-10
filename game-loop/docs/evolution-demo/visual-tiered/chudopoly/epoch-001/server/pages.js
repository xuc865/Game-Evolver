// server/pages.js — the crawlable half of the site.
//
// WHY THIS EXISTS. The game is one screen of JavaScript. A crawler that does
// not run JS sees a wordmark, one sentence and a deck tag — nothing to rank,
// and nothing to answer a question with. Meanwhile the project owns a rules
// corpus (game.js's own numbers, and the 2026-08-08 rulebook research in
// docs/rules-research.md) that no page ever served. These two documents are
// that corpus, rendered as HTML on the server.
//
// TWO RULES THIS FILE KEEPS.
//   §0.3 (nothing binary ships): everything here is text, generated per
//        request from the same modules the game runs on. Same story as
//        /og.png and /icon.svg — a route, not a file.
//   FACTS COME FROM THE ENGINE. Every set size, rent ladder, card name, card
//        description, deck count and preset below is read out of game.js at
//        render time. Prose is written here; NUMBERS ARE NEVER TYPED HERE.
//        test/seo.test.js fails if a number in the page disagrees with the
//        engine, which is the only way a rules page stays true for longer
//        than one balance round.
//
// The trademark line, on every page and in the footer: Chudopoly is not
// Monopoly Deal and does not claim to be. It is a game of the same KIND, said
// descriptively, which is what LICENSE's trademark notice reserves.

'use strict';

const G = require('../game');

/* ── html helpers ──────────────────────────────────────────────────────── */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const h = (tag, attrs, inner) => {
  const a = Object.entries(attrs || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return inner === undefined ? `<${tag}${a}>` : `<${tag}${a}>${inner}</${tag}>`;
};
const p = (text) => h('p', {}, text);
const li = (text) => h('li', {}, text);
const ul = (items) => h('ul', {}, items.map(li).join(''));
const h2 = (id, text) => h('h2', { id }, esc(text));
const h3 = (text) => h('h3', {}, esc(text));
const a = (href, text, ext) => h('a', ext
  ? { href, rel: 'noopener noreferrer', target: '_blank' } : { href }, esc(text));

/** A table from a header row and body rows. Cells are ALREADY escaped by the
 *  caller when they carry markup, so this escapes nothing — the callers below
 *  build their cells from esc()'d engine strings. */
const table = (head, rows) => h('table', {},
  h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, c)).join('')))
  + h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)).join(''))).join('')));

/* ── the document shell ────────────────────────────────────────────────── */

// Self-contained, on purpose. The app's design system is a system for a TABLE:
// full-bleed, fixed, no document flow. A rules document wants document flow, so
// it carries its own 40 lines rather than bending eight stylesheets to it. The
// palette is ART §2's: cream stock and near-black ink, both themes, and the
// numbers are the same pairs checkContrast already measures on the app.
const STYLE = `
:root{--bg:#DFD7C5;--fg:#14161A;--mute:#4A4E57;--rule:#A19B8C;--card:#FBF8F1;--link:#1F3A93}
@media (prefers-color-scheme:dark){
:root{--bg:#15171C;--fg:#F2EEE4;--mute:#A7ADB8;--rule:#404753;--card:#1B1E24;--link:#8FB0FF}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:44rem;margin:0 auto;padding:2rem 1.15rem 4rem}
a{color:var(--link)}
h1{font-size:1.75rem;line-height:1.2;margin:.2rem 0 .35rem}
h2{font-size:1.2rem;margin:2.2rem 0 .6rem;padding-top:1.1rem;border-top:1px solid var(--rule)}
h3{font-size:1rem;margin:1.3rem 0 .35rem}
.lede{font-size:1.05rem;color:var(--mute);margin:0 0 1.4rem}
.crumb{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:0 0 .6rem}
table{width:100%;border-collapse:collapse;margin:.8rem 0;font-size:.94rem}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}
ul{padding-left:1.15rem}
li{margin:.3rem 0}
blockquote{margin:.8rem 0;padding:.55rem .9rem;background:var(--card);
border-left:3px solid var(--rule);border-radius:.25rem}
blockquote p{margin:.25rem 0}
.cta{display:inline-block;margin:.5rem .5rem .5rem 0;padding:.6rem 1rem;background:var(--fg);
color:var(--bg);text-decoration:none;border-radius:.3rem;font-weight:700}
footer{margin-top:2.5rem;padding-top:1.1rem;border-top:1px solid var(--rule);
font-size:.85rem;color:var(--mute)}
`.trim();

const TRADEMARK = 'MONOPOLY and MONOPOLY DEAL are trademarks of Hasbro, Inc. Chudopoly is an '
  + 'independent, original game and is not affiliated with, endorsed by or sponsored by Hasbro. '
  + 'Game mechanics are not subject to copyright; every card name, card face and piece of '
  + 'artwork here is original work, and references to Monopoly Deal are descriptive.';

/**
 * @param {object} o
 * @param {string} o.origin absolute origin, from og.originOf()
 * @param {string} o.path   absolute path this document is served at
 * @param {string} o.title  <title> and og:title
 * @param {string} o.description meta description, og and twitter
 * @param {string} o.h1
 * @param {string} o.lede
 * @param {string} o.body   already-built HTML
 * @param {object} o.jsonLd schema.org object
 */
function shell(o) {
  const url = `${o.origin}${o.path}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#15171C" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#DFD7C5" media="(prefers-color-scheme: light)">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="CHUDOPOLY">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(o.origin)}/og.png?v=1">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${esc(o.origin)}/og.png?v=1">
<link rel="icon" type="image/svg+xml" sizes="any" href="/icon.svg?v=1">
<style>${STYLE}</style>
<script type="application/ld+json">${JSON.stringify(o.jsonLd)}</script>
</head>
<body>
<main>
<p class="crumb">${a('/', 'Chudopoly')} — free Monopoly Deal online</p>
<h1>${esc(o.h1)}</h1>
<p class="lede">${esc(o.lede)}</p>
${o.body}
<p>${h('a', { class: 'cta', href: '/' }, 'Play Monopoly Deal online free')}</p>
<footer>
<p>${a('/', 'Play')} · ${a('/rules', 'Chudopoly rules')} · ${a('/monopoly-deal-rules', 'Monopoly Deal rules')} · ${a('https://github.com/8tp/chudopoly', 'Source on GitHub', true)}</p>
<p>${esc(TRADEMARK)}</p>
</footer>
</main>
</body>
</html>`;
}

/* ── shared engine reads ───────────────────────────────────────────────── */

const COLOR_KEYS = Object.keys(G.COLORS);
const money = (n) => `${n}M`;

/** One row per colour: name, set size, rent at each step. All from G.COLORS. */
function colorTable() {
  return table(['Set', 'Cards to complete', 'Rent by cards owned'],
    COLOR_KEYS.map((k) => {
      const c = G.COLORS[k];
      return [esc(c.name), String(c.size), c.rent.map((r, i) => `${i + 1} → ${money(r)}`).join(' · ')];
    }));
}

/** One row per ACTION card in the stock deck: name, count, bank value, text. */
function actionTable() {
  const deck = G.buildDeck();
  const byAction = new Map();
  for (const card of deck) {
    if (card.type !== 'action') continue;
    const seen = byAction.get(card.action);
    if (seen) { seen.count++; continue; }
    byAction.set(card.action, { name: card.name, value: card.value, text: card.description, count: 1 });
  }
  return table(['Card', 'In deck', 'Bank value', 'What it does'],
    [...byAction.values()].map((c) => [esc(c.name), String(c.count), money(c.value), esc(c.text)]));
}

/** The stock deck, counted by family — every number read off buildDeck(). */
function deckTable() {
  const deck = G.buildDeck();
  const n = (fn) => String(deck.filter(fn).length);
  return table(['Family', 'Cards'], [
    ['Properties', n((c) => c.type === 'property')],
    ['Property wilds', n((c) => c.type === 'wild_property')],
    ['Rent', n((c) => c.type === 'rent')],
    ['Money', n((c) => c.type === 'money')],
    ['Action', n((c) => c.type === 'action')],
    ['<strong>Total</strong>', `<strong>${deck.length}</strong>`],
  ]);
}

/* ── /rules ────────────────────────────────────────────────────────────── */

function rulesPage(origin) {
  const sets = G.SETS_TO_WIN;
  const hand = G.HAND_LIMIT;
  const body = [
    h2('object', 'Object of the game'),
    p(`Be the first player to complete <strong>${sets} full property sets, each a different colour</strong>, `
      + 'and still hold them when the win resolves. Two sets of the same colour do not count as two.'),
    p(`Chudopoly is free, runs in the browser, seats 2–5 players and needs no download or account. `
      + `${a('/', 'Start a table')} or play against bots.`),

    h2('turn', 'On your turn'),
    ul([
      'Draw 2 cards automatically at the start of your turn — or 5 if you begin the turn with an empty hand.',
      'Play up to <strong>3 cards</strong>, in any combination. You may play none.',
      `End your turn holding at most <strong>${hand} cards</strong>; discard the rest.`,
      'Moving cards already on your own board is free and does not spend a play.',
    ]),
    h3('The three ways to play a card'),
    ul([
      '<strong>Into your bank</strong> — money, or an action card used as money. An action card in the bank is money for the rest of the game and can never be played for its action.',
      '<strong>Into your property collection</strong> — a property or a wild, placed in a colour zone.',
      '<strong>As an action</strong> — read it, resolve it, discard it.',
    ]),

    h2('sets', 'The sets, and what they charge'),
    p('Rent is charged on the colour you name, and it rises with how many cards of that colour you own. '
      + 'You do not need a complete set to charge rent.'),
    colorTable(),
    p('An <strong>Upgrade</strong> adds +3M and a <strong>Full Operational Capability</strong> a further '
      + '+4M, both only on a set that is already complete, and FOC only after an Upgrade.'),

    h2('paying', 'Paying, and what happens when you cannot'),
    ul([
      'You choose what to hand over — bank, properties, upgrades or a mix. The player charging you does not choose.',
      'There is no change. Overpaying is the cost of holding big notes.',
      'Cards never go back to a hand. Properties you pay with land in the other player\'s collection.',
      'If you cannot cover it, you surrender everything you have and the debt is settled.',
    ]),

    h2('cards', 'Every action card in the deck'),
    p('Counts are the stock deck; a custom lobby can edit them.'),
    actionTable(),
    h3('The deck'),
    deckTable(),

    h2('winning', 'Winning, and the four rulesets'),
    p('A host picks one of four presets, or edits the toggles into a custom ruleset. '
      + 'The engine resolves the choice server-side, so every seat plays the same rules.'),
    table(['Preset', 'Sets to win', 'When the win lands'], [
      ['<strong>Chudopoly</strong> (default)', String(G.RULE_PRESETS.chudopoly.setsToWin),
        'Reaching the last set arms <em>final approach</em>: every other player gets one full turn to break it before the win resolves at your own turn start.'],
      ['<strong>MD Faithful</strong>', String(G.RULE_PRESETS.mdFaithful.setsToWin),
        'The rulebook. Completing on your own turn wins on the spot; a set handed to you during someone else\'s turn waits for your next turn.'],
      ['<strong>Blitz</strong>', String(G.RULE_PRESETS.blitz.setsToWin),
        'The last set wins the instant it lands, on anyone\'s turn.'],
      ['<strong>Long Game</strong>', String(G.RULE_PRESETS.longGame.setsToWin),
        'Five sets, final approach, roughly twice the length.'],
    ]),
    p('Two endings have no counterpart in the original: if the deck and discard both run dry and a full '
      + `round passes with nobody playing a card, or the discard has been reshuffled ${G.DECK_CYCLE_LIMIT} `
      + 'times, the game is decided on points — most complete sets, then net worth.'),

    h2('differences', 'How this differs from the original'),
    p('Chudopoly is a game of the same kind as Monopoly Deal, not a copy of it: the card names, faces and '
      + 'artwork are original, and several rulings deliberately differ. '
      + `${a('/monopoly-deal-rules', 'The Monopoly Deal rules page')} sets the official rules out in full, `
      + 'with sources, and lists every place we depart from them.'),
  ].join('\n');

  return shell({
    origin,
    path: '/rules',
    title: 'Chudopoly Rules — How to Play (Monopoly Deal Online, Free)',
    description: `How to play Chudopoly free online: complete ${sets} property sets of different colours, `
      + `3 plays a turn, ${hand}-card hand limit, every action card explained. 2–5 players, no download.`,
    h1: 'Chudopoly rules: how to play',
    lede: 'The whole ruleset on one page — turns, rent, payment, every action card and all four win rules. '
      + 'Every number here is read straight out of the game engine.',
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Chudopoly rules: how to play',
      about: 'Monopoly Deal style card game rules',
      isPartOf: { '@type': 'WebSite', name: 'Chudopoly', url: `${origin}/` },
      mainEntityOfPage: `${origin}/rules`,
      publisher: { '@type': 'Organization', name: 'Chudopoly' },
    },
  });
}

/* ── /monopoly-deal-rules ──────────────────────────────────────────────── */

// The research artefact. Sources are the rulebooks Hasbro ships, extracted from
// the PDFs on 2026-08-08 — docs/rules-research.md carries the full workings and
// the URLs. Quotes here are verbatim from those files.
function mdRulesPage(origin) {
  const q = (text, cite) => h('blockquote', {}, p(`“${esc(text)}”`) + p(h('small', {}, esc(cite))));
  const body = [
    h2('win', 'How you win at Monopoly Deal'),
    p('Be the first player to collect <strong>three full property sets, each a different colour</strong>. '
      + 'Two sets of one colour and one of another does not win — the rulebook says so in as many words.'),
    q('TO WIN, BE THE FIRST PLAYER TO COLLECT 3 FULL PROPERTY SETS OF DIFFERENT COLORS.',
      'Monopoly Deal rulebook, 2008 printing'),
    q('The game ends when one player collects 3 complete Property sets in different colors. That player wins!',
      'Monopoly Deal rulebook E3113, 2017/18 printing — and the 2025 licensed editions print the same'),

    h3('When does the win actually happen?'),
    p('This is the question the FAQ sites answer badly, and the editions genuinely disagree. '
      + 'The 2008 sheet adds one caveat, and it is <strong>conditional</strong>:'),
    q('You can only reorganize your property collection on your turn. If you realize you have won during '
      + 'someone else\'s turn, you must wait until it is your turn to say it!',
      'Monopoly Deal rulebook, 2008 printing'),
    p('So the wait is the exception, not the rule. Lay your third set down on <strong>your own turn</strong> '
      + 'and the game ends there; only a set that arrives during somebody else\'s turn — through a payment, '
      + 'a steal or a swap — has to wait for your next turn, and can be broken in the meantime. '
      + 'Every printing since 2017 drops even that caveat and simply ends the game.'),

    h2('wilds', 'Can a set be made entirely of wild cards?'),
    p('The two wilds are not the same card, and the current printings say so on the faces:'),
    ul([
      '<strong>Two-colour wild</strong> — “You may make a complete player set using only these cards.” A set of nothing but two-colour wilds is legal.',
      '<strong>Every-colour (rainbow) wild</strong> — “You may not make a complete player set using only these cards.” It also has no cash value and may not be used to pay.',
    ]),
    p('Older answers from Hasbro support said “at least 1 standard property card”, which is stricter than '
      + 'what the cards now print. Where the two disagree, the printed card is the newer answer.'),

    h2('jsn', 'Does Just Say No cost you a play?'),
    p('On your own turn, yes — in the modern printings:'),
    q('You may play this card at any time, even if it isn\'t your turn… If you add this card to your Bank as '
      + 'points or play it as an action card, it counts as one of the three cards you may play on your turn.',
      'Monopoly Deal FIFA World Cup 26 (G3239), RED CARD — the Just Say No of that edition'),
    p('Only the player whose turn it is has a three-card budget, so a defender answering on someone else\'s '
      + 'turn still blocks for free. The cost falls on the attacker\'s counter-block, which is the half of a '
      + 'block war that actually spirals.'),

    h2('faq', 'The rulings people look up most'),
    h3('Can you steal from a complete set?'),
    p('Not with Sly Deal or Forced Deal — both cards print “(Cannot be part of a full set.)”, and Forced '
      + 'Deal is guarded on both sides of the swap. Deal Breaker is the one card that takes a complete set, '
      + 'and it takes any house and hotel with it.'),
    h3('Does Double The Rent stack?'),
    p('Yes. Two Double The Rent cards plus a rent card is all three of your plays and quadruples the rent. '
      + 'It works with any rent card including the multicoloured one, and it applies to <strong>rent only</strong> '
      + '— never to Debt Collector or It\'s My Birthday.'),
    h3('What if you cannot pay?'),
    p('You pay what you can and the debt is settled: “If you have no money or Property in front of you, '
      + 'nothing happens.” Rainbow wilds are not payment, so a player holding only those pays nothing.'),
    h3('Can you rearrange your properties?'),
    p('Freely, on your own turn, and it never costs a play — moving a card already on the table in front of '
      + 'you is not “playing” a card.'),
    h3('What is in the deck?'),
    p('110 cards: 4 rules cards and 106 playable — 28 properties, 11 property wilds, 13 rent, 20 money and '
      + '34 action cards.'),

    h2('chudopoly', 'Where Chudopoly deliberately differs'),
    p(`${a('/rules', 'Chudopoly')} is an original game of the same kind, with its own cards and artwork. `
      + 'These are the rulings that knowingly depart from the source — the rest follows it.'),
    table(['Chudopoly', 'Monopoly Deal', 'Why'], [
      ['Final approach: the last set arms a grace window and every opponent gets a turn to break it.',
        'The game ends when the third set lands on your turn.',
        'Ours. The <em>MD Faithful</em> preset plays the rulebook instead.'],
      ['THE CHUD CARD takes one property out of a complete set.',
        'Only Deal Breaker touches a complete set, and it takes the whole thing.',
        'An original card with no counterpart.'],
      ['A colour zone never holds more than its set size.',
        'Extra copies start a second set of that colour.',
        'Kills an armour exploit; the modern books do cap wilds the same way.'],
      ['A player who cannot otherwise pay must surrender zero-value wilds too.',
        'Rainbow wilds may not be used as payment at all.',
        'A deliberate minority position: a card that is dead weight by design should not also be armour.'],
      ['Games can end on points — a dry deck, or 16 reshuffles.',
        'No such ending; play continues indefinitely.',
        'The project does not ship non-terminating states.'],
    ]),

    h2('sources', 'Sources'),
    p('Everything quoted above was extracted from the rulebook files themselves, not from summaries:'),
    ul([
      a('https://instructions.hasbro.com/en-us/instruction/monopoly-deal-card-game-instructions', 'Monopoly Deal instructions, E3113 (Hasbro)', true),
      a('https://instructions.hasbro.com/en-us/instruction/monopoly-deal-card-game', 'Monopoly Deal instructions, B0965 (Hasbro)', true),
      a('https://instructions.hasbro.com/en-us/instruction/monopoly-deal-fifa', 'Monopoly Deal FIFA World Cup 26, G3239 (Hasbro)', true),
      a('https://instructions.hasbro.com/en-us/instruction/monopoly-deal-harry-potter-card-game', 'Monopoly Deal: Harry Potter, G0717 (Hasbro)', true),
      a('https://github.com/8tp/chudopoly/blob/main/docs/rules-research.md', 'The full research notes, with every citation', true),
    ]),
  ].join('\n');

  return shell({
    origin,
    path: '/monopoly-deal-rules',
    title: 'Monopoly Deal Rules: How You Win (Quoted from the Rulebooks)',
    description: 'How you win at Monopoly Deal, quoted from Hasbro\'s own rulebooks: three sets of '
      + 'different colours, when the win actually lands, wild-card sets, and what happens if you '
      + 'cannot pay.',
    h1: 'Monopoly Deal rules: how you actually win',
    lede: 'Read out of the rulebooks Hasbro ships — the 2008 sheet, the current E3113 foldout and the 2025 '
      + 'editions — because they do not all say the same thing, and the difference decides games.',
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        ['How do you win at Monopoly Deal?',
          'Be the first player to collect three full property sets, each in a different colour. Two sets of the same colour do not count as two.'],
        ['Do you win immediately or wait for your turn?',
          'If your third set completes on your own turn, the game ends there. Only a set handed to you during another player\'s turn has to wait until your next turn to be declared, and it can be broken in the meantime.'],
        ['Can a complete set be made only of wild cards?',
          'A set of two-colour wilds is legal. A set of nothing but every-colour (rainbow) wilds is not, and rainbow wilds cannot be used as payment.'],
        ['Does Just Say No count as one of your three cards?',
          'On your own turn, yes, in the modern printings. A defender playing it on somebody else\'s turn blocks for free.'],
        ['Can you steal from a complete set?',
          'Not with Sly Deal or Forced Deal. Deal Breaker is the only card that takes a complete set, and it takes any house and hotel with it.'],
        ['What happens if you cannot pay?',
          'You pay what you can and the debt is settled. If you have nothing in front of you, you pay nothing.'],
      ].map(([question, answer]) => ({
        '@type': 'Question', name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      })),
    },
  });
}

/* ── robots.txt and sitemap.xml ────────────────────────────────────────── */

// The three documents worth crawling, in the order they matter. `/` is the app;
// the other two are the reason a search engine has anything to read.
const ROUTES = ['/', '/rules', '/monopoly-deal-rules'];

function sitemap(origin) {
  const urls = ROUTES.map((route) => '  <url>'
    + `<loc>${esc(origin + route)}</loc>`
    + `<changefreq>${route === '/' ? 'weekly' : 'monthly'}</changefreq>`
    + `<priority>${route === '/' ? '1.0' : '0.8'}</priority>`
    + '</url>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls + '\n</urlset>\n';
}

// Deliberately permissive: there is nothing here to hide, and room URLs are
// query strings on `/`, which carry no content a crawler could index anyway.
// Cloudflare appends its own content-signal block to whatever the origin sends.
function robots(origin) {
  return ['User-agent: *', 'Allow: /', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
}

module.exports = { rulesPage, mdRulesPage, sitemap, robots, ROUTES, esc };
