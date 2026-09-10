# CHUDOPOLY — ARCHITECTURE (LAW)

This document is **binding for every agent** working on the card-table revamp. You may push
back on any rule — but only with measurements in hand, in your final report, and you may not
silently violate it. When this file and any other doc disagree, this file wins.

Goal of the revamp: turn a working-but-dashboard-like multiplayer Monopoly-Deal variant into a
**native-feeling card game** — a physical card table where every card is an object that moves,
flips, and lands; tap-and-drag mobile controls; synthesized tactile audio; correct, explained,
balanced rules. Reference quality bar: `/Users/hunter/src/games/gatecrash` (read its
ARCHITECTURE.md §11a and its fx/audio comments if you need calibration on "juice").

## §0 Non-negotiables

1. **The server is authoritative and stays.** `server.js`, `server/*`, the WebSocket protocol
   message types in `server/protocol.js`, reconnect/resume tokens, bots, and timers are kept.
   Extend, don't replace. The client renders and requests; it never decides.
2. **No build step.** The client ships as native ES modules served statically from `public/`.
   `npm start` must remain the entire deployment story (Railway, single instance).
   `<script type="module" src="/src/main.js?v=...">` — one entry, real imports below it.
3. **Zero external binary assets, with FOUR amendments.** No .png/.jpg/.glb — ever.
   Every texture, card face, card back and icon is generated in code (CSS, inline SVG /
   SVG data-URIs authored as text, canvas). Enforced by `tools/checkAssets.mjs`.

   **AMENDED 2026-08-07 (d) — documentation brand assets are permitted, outside `public/`.**
   Scope: `docs/*.svg` and `docs/*.png`, referenced only by `README.md` and other repo docs.
   GitHub does not render inline SVG in Markdown, so a README cannot show the wordmark
   without a file — and this rule exists to keep the **client payload** free of binary
   assets, not to keep them out of the repository. A README image is served to nobody,
   imported by no module, and never reaches a player. `checkAssets.mjs` must continue to
   fail on anything binary under `public/` outside the two allowlisted directories, and must
   not be relaxed to cover `docs/` — it should simply not scan there.

   **AMENDED 2026-08-07 (b) — self-hosted webfonts are permitted.** `public/fonts/*.woff2`.
   This rule was over-broad from the day it was written: it filed fonts alongside textures
   and sounds, but a texture generated in code *is* the art, whereas a font generated in
   code is just a worse font. The payload argument also died on the spot the moment this
   same section accepted 5.2MB of music — a woff2 subset is 20–80KB, well under 2% of what
   the audio costs.

   The determinism argument runs the **opposite** way from how it was assumed, and this is
   the real reason to make the change. `--font-display` currently resolves to `ui-rounded` /
   `SF Pro Rounded` on macOS, `Segoe UI Variable Display` on Windows, and something else
   again on Linux — so the game has no fixed letterform, and `tools/screenshot.mjs`, which
   hashes PNGs, is measuring whatever font the machine that ran it happened to have.
   **Self-hosting makes the screenshot gate machine-independent for the first time.**

   Conditions: OFL / Apache-2.0 / similarly permissive licences **only** (verify and record
   the licence per file — a font EULA that bars web embedding is the common trap); woff2,
   subset to the glyphs actually used; `font-display: swap` with the existing system stack
   as the fallback so a failed fetch degrades instead of blanking; and metric-compatible
   fallbacks chosen so a swap does not reflow the table. `checkAssets.mjs` is narrowed to
   permit that directory and extension, and must fail on any binary elsewhere.

   *Status 2026-08-07: this amendment is PERMISSION, not a description. `public/fonts/`
   does not exist and there is no `@font-face` anywhere — the game still resolves
   `--font-display` through the platform stack, so the screenshot gate is still measuring
   whatever face the running machine supplies. The machine-independence claimed above is
   available, not yet collected.*

   Note what this does **not** license: a **logo is drawn, not set.** The CHUDOPOLY wordmark
   stays hand-authored geometry. A wordmark typed in someone else's typeface is that
   typeface's identity, not ours, and it is the one mark that has to be ours.

   **AMENDED 2026-08-07 (f) — PWA install icons may ship as generated PNGs, owner directive.**
   Scope: `public/icons/*.png` plus `public/manifest.webmanifest`. The platform, not taste,
   forces the format: iOS `apple-touch-icon` and Android maskable install icons require
   raster files — an installed app with no icon renders a screenshot thumbnail, which is
   worse brand damage than the rule was written to prevent. Conditions: every PNG is
   **rendered by a checked-in generator** (`tools/genicons.mjs` — implemented over the
   project's own pure-JS `server/raster.js`, not node-canvas, which would have added a
   native binary dependency; the generator imports `server/icon.js`'s existing drawn mark
   so the committed files cannot drift from what the server serves) from the game's own
   hand-authored geometry — the source of truth stays code, the PNGs are a build artifact
   that happens to be committed; regeneration must be reproducible (`node tools/genicons.mjs`
   rewrites the set byte-for-byte or the gate fails); `checkAssets.mjs` is narrowed to permit
   exactly that directory and extension with a count cap, and must still fail on any binary
   anywhere else under `public/`. The in-game client may never `<img>` these — they exist
   for the installer surface only. §507.9 still applies: no roundel or insignia imitation
   in the mark.

   **AMENDED 2026-08-07 — recorded music, and only music, may ship as files.** Scope:
   `public/audio/*.opus`, at most **eight** tracks (one lobby bed, **four** match beds, one
   Final Approach bed, and a victory / defeat pair).

   *Status 2026-08-07 evening: FOUR match beds shipped (match-1..4.opus — the fifth texture
   discussed below was the rejected checklist bed; honor-guard and tape-loops were working
   names, not shipped files). The cap and the rotation argument below stand; read "five" as
   the aspiration the cap allows, four as the shipped truth. audiotest asserts the real set.*

   *Raised six → eight on 2026-08-07 (e), owner directive, and the load policy is what makes
   it nearly free: **a session pays for ONE match bed no matter how many exist**, because the
   bed is chosen at game start and never rotated inside a match. So the extra tracks cost
   repository size and a first-fetch on the day a player happens to roll one — not per-session
   payload. More beds also fix the thing that prompted this: at two, a player sees the same
   bed twice in a row 50% of the time, which reads as "there is only one track". At five with
   no-immediate-repeat, never — and the rotation spans strings, electronics and brass, which
   is real texture rather than variations on one.*

   *A fifth bed, a percussion-only "checklist", was generated, measured, placed and **rejected
   by the owner as "way too repetitive" — and it had the BEST score on the metric being used
   to judge these**, 1.6% thin frames against the shipped pair's 24.7% and 34.0%. That is the
   lesson worth keeping: **`thin %` measures LEVEL uniformity, not musical variety.** A bed
   with no harmony and no development is perfectly steady and therefore perfectly monotonous;
   the metric was optimising for exactly the failure it could not see. It remains a good guard
   against a bed that sags or goes silent mid-match, which is what it was built for — it is
   not evidence that a bed is good.*

   *One of the five is a known mix problem and is being taken with its eyes open:
   **honor-guard puts 63% of its energy in the 150–500Hz band** — the octave every card cue's
   dominant energy sits in, and the one the music bus already cuts to let those cues through.
   Compare tape-loops at 24%. It will therefore be thinned harder than its siblings by the
   shared cut, and if it does not survive that, the answer is a **per-track EQ on that bed
   alone** rather than relaxing the masking floor. The floor is the assertion that keeps card
   sounds audible and is not the thing to trade.*

   *The cap moved four → six on 2026-08-07 (c), owner directive, and the endgame pair is
   cheap in a way the beds are not: 40s rather than 3 minutes, so **322KB + 317KB** against
   the beds' 1.5MB each. Total audio 5.2MB → 5.9MB. They are also the only tracks whose load
   moment is known in advance — the win overlay is already held back 850ms for the
   celebration, and §3.10 arms a full cycle before anyone converts, so both can be resident
   without a stall. Whether to prefetch one or both (the winner is not known until it
   happens) is an implementation call for the audio owner.* **Every sound effect stays procedural** and that is not a purity argument:
   a synthesised click fires at zero latency with no load path, and its pitch and timing
   jitter per call, which is what stops a cue heard 400× a match from becoming a woodpecker.
   Samples would ship the *same* click 400 times.

   The music case is different in kind and the numbers say so. A 3-minute bed is ~1.5MB at
   64k Opus against a **~550KiB gzipped client** (381KB was measured before the art, audio
   and stats rounds landed; re-measure before quoting it) — one track is four times the whole game — so
   this is not a cheap amendment and it carries conditions:
   - **Nothing on first paint.** Lobby bed on first user gesture; match bed at game start;
     Final Approach bed prefetched when a seat reaches two sets. A session pays for one
     lobby + one match + at most one climax, never the set.
   - **The procedural beds stay and stay working.** They cover the gap before a file loads
     (no dead air, no spinner) and they are the fallback when a fetch fails or the player is
     offline. `music.js` does not become a file player with synthesis deleted behind it.
   - `checkAssets.mjs` is narrowed, not weakened: it must still fail on any binary outside
     that exact directory and extension, and must fail if the track count exceeds the cap in
     amendment (c) — **six**. (This line said "four" until 2026-08-07: amendment (c) raised
     the cap in the prose above and left the enforcement sentence behind it. `checkAssets.mjs`
     had it right at `cap: 6`; the law was the thing out of date.)

   *Why the amendment, given the previous ruling went the other way:* the research found
   Gatecrash's music is 100% synthesised, which killed the "sampled sounds better" premise
   outright, and separately found five real defects in our own chain — the music never
   touches the reverb at all, the bed is mono, nothing lives above ~2.5kHz, ART §7's "air"
   layer was specified and never built, and the menu→match handoff is a 0.4s unaligned fade
   the spec explicitly names as a failure. **Those four procedural fixes ship regardless and
   ship first.** This amendment is for the thing synthesis genuinely cannot do in reasonable
   code — a composed arrangement that develops — not a shortcut around a chain we hadn't
   finished wiring.
4. **Every card on screen is a persistent DOM node keyed by card id** (`data-card-id`).
   Cards move between zones by reparenting + FLIP transforms. **`innerHTML` rebuilding of any
   zone that contains card nodes is banned.** (Chat/log building nodes via `textContent` is fine
   and required — XSS discipline is kept from the old client.)
5. **All animation/sfx/haptics dispatch from structured engine events** (§4), never from
   string-matching log prose. The prose log exists only as the visible Mission Log.
6. **One clock.** Client animation timing goes through `core/clock.js` (rAF, `dt` clamped to
   [0, 1/20]). No `setInterval` animation, no CSS keyframe whose *phase* matters. CSS
   transitions/keyframes are allowed for ambient loops and screen transitions only.
7. **Determinism hooks for the harness.** The engine accepts an optional seed
   (`createGame(players, {seed})` → seeded shuffle via sfc32/xmur3). The client exposes the
   `__CHUD` bridge (§9) when `?harness=1`. Harness captures must only stage states the real
   game can reach (fixtures are recorded from real games or built through engine calls).
8. **No per-frame allocation in animation hot paths**; guarded DOM writes (skip if value
   unchanged). Target: 60fps on a mid phone with 5 players and a full table.
9. **Accessibility floor:** keyboard operability (Enter/Space activate, Escape cancels/closes,
   focus trap in sheets), `prefers-reduced-motion` honored (motion collapses to fades, sound
   stays), tap targets ≥ 44px, text contrast ≥ 4.5:1 except decorative.
10. **Tests stay green.** `npm run check` and `npm test` pass at every commit. Engine changes
    update `test/*` in the same commit. The old `test/ui-contract.test.js` gets rewritten for
    the new client (keep its spirit: no inline handlers, XSS-safe chat, cache-busted entry).
11. **Comments record measurements, not intent.** A tuning constant gets the number/failure
    that produced it, or no comment at all.

## §1 Directory ownership

One owner per directory per phase. Touching a directory you don't own = your PR is wrong.
If you need a change in someone else's directory, put the request in your report.

| Path | Contents | Owner (phase) |
|---|---|---|
| `game.js`, `bot.js`, `simulate.js` | Engine, bots, balance sim | engine agent (P1) |
| `server/` | Transport, validation, timers | engine agent (P1), then frozen |
| `test/` | Node test suite | whoever changes the code under test |
| `tools/` | Harness scripts (Playwright etc.) | harness agent (P2) |
| `public/index.html` | Shell, screen containers | architect (P3) |
| `public/src/core/` | bus, clock, math/easing, dom helpers, rng | architect (P3) |
| `public/src/net/` | socket, reconnect, message router | architect (P3) |
| `public/src/state/` | store, event queue, selectors | architect (P3) |
| `public/src/table/` | zones, card nodes, layout | table agent (P3/P4) |
| `public/src/anim/` | FLIP engine, choreography per event | motion agent (P4) |
| `public/src/interact/` | tap/drag/targeting, sheets | interaction agent (P4) |
| `public/src/ui/` | screens: home/lobby/game HUD/win, chat, help | ui agent (P3/P6) |
| `public/src/audio/` | WebAudio engine, sfx bank, dispatch map | audio agent (P5) |
| `public/src/fx/` | confetti, flash, shake, floating text, haptics | fx agent (P5) |
| `public/style/` | design system CSS (see §6) | design agent (P3), then per-file |
| `ARCHITECTURE.md`, `README.md` | Law + truth | orchestrator only |

## §2 What we keep from the old client (spirit, not code)

- Server-authoritative full-state broadcasts with per-player redaction (`getPlayerView`).
- Reconnect with resume tokens in `sessionStorage`; 2s retry.
- Delegated event handling (no inline `on*=` attributes anywhere — test-enforced).
- Chat via `textContent` only. Emotes. Turn/response timers with urgency treatment.
- Safe-area insets, visualViewport keyboard handling, `@media (hover:hover)` gating.

The old `public/js/*` and `public/style/*` files are **deleted** in P3, replaced by the new
tree. Git history is the archive; do not keep a `legacy/` copy.

## §3 Gameplay balance (P1 directives)

Authoritative deck stays 106 cards.

> **AMENDED 2026-08-07 — the default stays 106; a custom lobby may edit it.** Thirteen counts
> are editable (the eleven action kinds, plus wilds split into rainbow and an ordered
> two-colour list), clamped per-kind 0–12 and 80–130 total, resolved and refused **server-side**.
> Property, money and rent are deliberately **not** editable: `COLORS[c].size` is simultaneously
> the property count, the §3.5 zone cap and the completion test, so a property knob makes
> colours uncompletable or breaks an invariant `validateState` asserts; money and rent are the
> economy's scale, and moving them moves every rent, demand and payment together, so nothing
> measured over them is interpretable. A count is never a card list — the host says how many,
> the engine says which.
>
> **The measurement said ship nothing to the stock deck**, and that null result is recorded
> here because it cost 10,000+ games to earn. One more Inspector General does move Final
> Approach shot-down (45.8% → 52.4% at 4p) and a size-neutral control (+1 IG, −1 PCS, still
> 106) reaches 53.3% — so the lever is the *breaker*, not the deck size, and the deck genuinely
> was the ceiling the bot round named. But every breaker addition pushes 5-player points-endings
> from 8.4% to 13–19% and p90 past 110 turns. All of them fail §3.6's bar.
>
> Two findings worth keeping: **restoring the two missing wilds runs the other way** — it lowers
> shot-down but improves every cost (5p p90 96 → 81, points-endings 8.39% → 5.93%). And
> **`mdFaithful` shoots down only 24.8% at 4p**, which means CHUD is doing most of the
> set-breaking work in this game. `mdFaithful` is now literally the official deck: our action
> counts already matched MD exactly, so `chud: 0, wildPairs: 9` lands on it category-for-category
> and stays at 106 because the two changes cancel.

Changes below are directives; the engine agent tunes exact
numbers and **must validate with `simulate.js` winrate matrices** (≥500 games per matchup of
the 5 bot personalities; no personality > 60% or < 8% winrate in a 4-player mixed game, and
first-player advantage measured and reported).

> **AMENDED 2026-08-11 — the winrate matrix is necessary and NOT sufficient; it cannot see
> absolute strength.** `simbalance` divides a fixed pot between five personalities, so a
> change that makes *every* bot stronger moves nothing in it, and a change that makes one bot
> stronger is indistinguishable from one that makes the other four weaker. The gate above
> still stands — it is what stops a personality running away with the game — but "did this
> make the bots play better?" has to be asked somewhere else.
>
> The second instrument is **self-play A/B**: seat the modified bot against three copies of
> the shipped one and measure against a 25% fair share. `bot.js` supports a `persona@scale`
> seat suffix for exactly this (`neutral@0` is neutral with `HOLDBACK_SCALE` 0), sim-only —
> `server/handlers.js` allowlists the five bare names, so a suffix can never reach a lobby.
> Two traps, both of which produced confidently wrong numbers before they were caught by a
> null test, and both of which are the reason a null test is now mandatory:
>
>   * **`runGame` does not seed the bot RNG. Only `runMatches` does** (`setRng(makeRng('bot:'
>     + gameSeed))`). A harness calling `runGame` directly leaves bot decisions on unseeded
>     `Math.random`, and every measurement taken that way is noise.
>   * **Mode is consulted in a dozen places** — seven persona tables, inline string tests,
>     `chooseDiscards`, the OPSEC economy. A new mode string that misses any one of them
>     silently becomes a *different personality*, not a variant. `personaOf()` normalises at
>     every entry point so the whole class of mistake is gone.
>
> **Run the null first: subject and baseline behaviourally identical must return 25%.** It is
> not ceremony. It caught both traps above.
>
> **What the second instrument then found: the holdback is the dominant strength lever, and
> it was written as flavour.** "Sometimes don't use all 3 plays" is set per personality in
> exactly the order the personalities finish in — aggressive 0/0.08, neutral 0.05/0.15,
> conservative 0.08/0.25, matching production winrates of 28.9%, 13.3%, 13.3% across 45
> controlled Quick Play games. So "conservative plays defensively" was mostly a bot declining
> a quarter of the turns it was offered. `HOLDBACK_SCALE` is now the dial; **set to 0.5**
> (owner decision). At N=6000 per cell, seat-rotated, subject vs three copies of the shipped
> persona: conservative +2.47pp (z=3.1), neutral +2.17pp (z=2.7), aggressive +0.23pp (ns) —
> the gain tracks each persona's holdback size, which is what makes it the mechanism rather
> than a correlate. §3 still passes at 600 games and the spread *tightened* (14.6–33.5 from
> 11.9–35.2). Pushing the dial to 0 is worth roughly double but pulls chud to 10.0% against
> the 8% floor, because chud's holdback lives in `botTakeTurn` and does not scale.
>
> **Five other candidates failed, and the null results are recorded because they cost the
> measurement to earn.** Drawn from the same production fingerprint: contest the leader from
> their first set, drop the rent floor 2→1 or 2→0, gate PCS Orders on hand size, rescore
> placement through `boardScore`, bank weak property plays. None beat the null. **Gating PCS
> Orders was significantly WORSE** (−1.7pp, z=−2.1) — drawing into the hand limit is a
> *filter*, since the discard sheds the lowest cards, so the obvious reading of "conservative
> discards 6.6 cards per 100 turns against a human's 0.9" had the causation backwards.
>
> **The rearranging lead was followed, and it is a dead end. Recorded so nobody spends the
> measurement twice.** `planRearrange` takes only single moves that improve the board on
> their own; the atomic swap fires only when two zones are each full of what the other wants.
> Neither can see the shape a human plays constantly — move a wild OUT of a zone where it is
> wasted (worth nothing alone) and a second wild IN to finish a set. A two-move lookahead was
> built and measured: **no effect at any threshold.** −0.07pp at a completed-set bar, −0.07pp
> at 100, −0.10pp at a bar of zero (N=4000–6000 per cell, z=−0.1 throughout), and set
> completion did not move off 37.5 per 100 turns in any run.
>
> The instrumentation says why, and it is the useful part: across 1500 games the pair search
> was **reached 15,231 times and found a qualifying plan 8 times.** The branch is live, not
> dead — it is the *situation* that does not arise. For a pair to beat every single move, the
> second move must be one the greedy search could not already take, which in practice means
> `zoneFull` blocked it until the first wild vacated. That is a real position (a full-but-
> incomplete zone under `pureSetRequired`) and it happens about once every 187 games.
>
> So the residual is NOT rearranging depth. Seven candidates have now been measured against
> the shipped bot and only the holdback moved; the remaining human edge — 50.4 sets per 100
> turns against ~41, and 0.564 sets per property play against 0.284 — is not reachable by
> tuning these heuristics one at a time. **Anything further should be measured on production
> data first rather than reasoned from the fingerprint**, which has now produced six confident
> wrong answers out of seven.

1. **CHUD** keeps its identity (steal any property, even from a complete set) but **loses the
   2M tax rider**. It is OPSEC-able. If sims show it still dominates, raise its face value
   (dead-weight as payment) rather than adding riders. ~~*Ruling (P7 round 1):* TDY Orders may
   swap into a complete set.~~ **REVERSED 2026-08-06 by research.** Hasbro's own FAQ (answer
   926) bars *both* Sly Deal and Forced Deal from complete sets, and it is consensus, not a
   split. Leaving TDY unguarded gave Chudopoly **three** set-breaking cards (Inspector General,
   CHUD, TDY — 8 of 106) where MD has **one** (Deal Breaker, 2 copies), the likely cause of the
   long-game tail. TDY now takes the same `zoneRequisitionable` guard as Midnight Requisition,
   on **both** sides of the swap. CHUD remains the only card that takes from a complete set, so
   the "robs vs trades" copy still holds and is now actually true.
1b. **Upgrades follow Hasbro (2026-08-06 research).** A broken set sends its House/FOC to the
   owner's **bank** (Hasbro CS: *"those houses and hotels have to go into your bank"*), never
   the discard; upgrades are **payable** (modern rulebook: *"all cards — except the 2 Wild
   Property cards — have cash value and may be used to pay debts"*); and they may be **moved
   between complete sets** on your turn. Today's engine discards them and excludes them from
   payment while `playerNetWorth` still counts them — the HUD shows a net worth the player
   cannot spend, which is a lie regardless of which rule we choose.
1c. **Surge Ops follows Double The Rent.** It **stacks** (two copies = ×4, spending two of your
   three plays — MD explicitly allows this) and applies to **rent only**, never Finance Office
   or Roll Call. Today's engine has both backwards.
1d. **OPSEC follows Just Say No's modern cost (2026-08-08 research), in the MD Faithful
   preset only.** `counterCostsPlay` — OFF by default, ON in `mdFaithful` — makes an OPSEC
   played in response *while it is your own turn* spend one of your three plays, and refuses
   it outright with none left. Hasbro's current printings charge it: Monopoly Deal FIFA
   (G3239) prints on the RED CARD *"If you add this card to your Bank as points or play it
   as an action card, it counts as one of the three cards you may play on your turn."* Only
   the seat whose turn it is has a play budget, so a defender answering on somebody else's
   turn still counters for free — the cost lands on the attacker's counter-counter, which is
   the half of an OPSEC chain that actually spirals. The default table is untouched: OPSEC
   there is free at every depth, as it has always been.

2. **Wild rent ("any")** targets **one chosen player**, like the color rents. (The old
   hit-everyone behavior was an undocumented buff.)
3. ~~**Surge Ops** doubles the **next charge you make this turn** — rent, Finance Office,
   Roll Call, any demand~~ **SUPERSEDED by §1c (2026-08-06 research):** Surge Ops is Double
   The Rent — it stacks and applies to **rent only**. This line is kept struck through
   because card text and help were written against it; §1c is the ruling.
4. **Zero-value wilds**: keep value 0 (dead weight is their cost), but fix the insolvency
   exploit — a player whose only cards are zero-value cards must surrender them when they
   cannot otherwise pay ("pay with everything you have" already exists; make zero-value cards
   count as "something").

   > **OWNER RULING 2026-08-07 — KEPT, knowing it is the minority position.** A survey of
   > six other Monopoly Deal implementations votes **3–1 the other way**: the field treats
   > zero-value cards as *immune* — you may not pay with them and may not be forced to
   > surrender them, and one implementation prints "Immune" on the card face. Coopoly agrees
   > with the field, though only by accident: its guards test card *value*, so a 0-value card
   > is simply invisible to them.
   >
   > We depart deliberately. Under the immune reading, a player holding nothing but rainbow
   > wilds pays **nothing** and **keeps everything**, which makes the most flexible card in
   > the deck also the safest — a card that is dead weight by design becomes armour. Our rule
   > counts *cards*, not value (`game.js:1473-1477`), so "pay with everything you have" means
   > everything. The owner's words: *"if you cant pay you do have to give up your 0cost
   > wilds… and should just be forced to do so."*
   >
   > Recorded here so it reads as a choice rather than an oversight to the next person who
   > checks us against the field.
5. **Overstacking**: a color zone holds at most `set size` property cards. Extra copies must
   go to a different legal zone (wilds) or stay in hand. Kills the armor exploit.

   > **OWNER RULING 2026-08-07 — §3.5 stands, and gains an atomic swap.** The rule has a
   > consequence nobody had noticed: a **true swap is impossible**. Darkblue 2/2 holding a
   > green/darkblue wild and green 3/3 holding a rainbow — each wild is legal in the other's
   > zone, and the engine refuses **both directions**, because neither can transit through an
   > overfull state. Measured, not theorised.
   >
   > Real Monopoly Deal has no such problem, for two reasons, and it is worth being precise
   > about which one matters. First, it is physical: you pick both cards up and put them down,
   > so there is no intermediate state to validate. Second, and more fundamentally, **MD has no
   > overstacking rule at all** — extra properties of a colour *start a second set of that
   > colour* (2011 archived official FAQ; monopolydealrules.com Property §8 — live FAQ
   > a_id/924 answers a different question and was cited here in error). §3.5 is **ours**, added
   > to kill the armour exploit, so the blocker is a consequence of our own rule rather than a
   > divergence from MD's.
   >
   > MD's actual permission we already match, and it is the thing the client was violating
   > until `55a014f`: *"you can move wild cards and Property cards around as much as you like
   > amongst the sets, but ONLY during your turn. Moving a card that is already on the table in
   > front of you does not count as 'playing' a card."* (Hasbro FAQ a_id/937.)
   >
   > **The fix is an atomic two-card exchange, not a relaxation of §3.5.** Rejected: allowing a
   > transient overfull state (the invariant `validateState` asserts is meant to hold
   > continuously — that is what makes it worth having), and adopting MD's second-set rule
   > (a cross-cutting engine rewrite that reopens the exploit).
   >
   > Open for the implementing agent to decide and defend: whether a swap costs **one**
   > rearrange from the per-turn budget or **two**, and how it is initiated without adding a
   > mode to an interaction model that already has enough.
6. **Stalemate end**: when the deck and discard are both empty and a full round passes with no
   card leaving any hand, the game ends; most completed sets wins, net worth breaks ties.
7. ~~**Upgrades (FOC/hangar)** stay off-limits as payment (matches MD)~~ **SUPERSEDED by §1b
   (2026-08-06 research):** upgrades ARE payable per the modern rulebook and the engine
   implements §1b. The surviving half of this line is the display rule: upgrades must be
   **shown** in net worth display so the UI never lies.
8. **Free wild rearranging** stays (it's good), but becomes a first-class visible interaction.
10. **FINAL APPROACH (win grace cycle — owner directive 2026-08-06).** Reaching 3 complete
    sets does NOT win immediately.

    > **CORRECTED 2026-08-08 — the faithfulness claim below was wrong, and `mdFaithful` was
    > wrong with it.** The rulebook sentence is CONDITIONAL: *"if you realize you've won
    > **during someone else's turn**, you must wait until it's your turn to say it"* (2008
    > sheet). The wait is the exception, not the rule — complete your third set on your own
    > turn and Monopoly Deal ends there. Every printing since drops even the exception:
    > E3113 (2017/18, the foldout §1b already quotes) and the 2025 licensed cuts (Deal FIFA
    > G3239, Deal Harry Potter G0717) all print *"the game ends when one player collects 3
    > complete Property sets in different colors. That player wins!"* with no timing caveat
    > at all. Extracted from the shipped PDFs, not from a FAQ site.
    >
    > So **Final Approach is ours** — a deliberate house rule, not the source's — and the
    > `mdFaithful` preset, which deferred *every* completion by a full lap, was Final
    > Approach under another name in the 94.8% own-turn case. It now wins inline on an
    > own-turn completion and arms only when the set lands off-turn, converting at that
    > player's very next own turn start. `finalApproach` (the default) and `instant` are
    > unchanged, and so is every other preset.
    >
    > Two more corrections landed with it, both scoped to `mdFaithful` and both OFF in the
    > default: **`pureSetRequired` was narrowed** from "needs one real property" to "needs
    > one card that is not a RAINBOW wild" — the 2025 card faces split the two by name
    > ("two-colour wild: *You may* make a complete set using only these cards"; "every-colour
    > wild: *You may not*"), so banning two-colour-wild sets was stricter than any edition.
    > And **`counterCostsPlay` was added** (§3.1d): an OPSEC played in response *while it is
    > your own turn* spends one of your three plays and is refused with none left — FIFA
    > Deal's RED CARD prints *"If you add this card to your Bank as points or play it as an
    > action card, it counts as one of the three cards you may play on your turn."* A
    > defender answering on someone else's turn has no play budget and never pays, so the
    > bite is on the attacker's counter-counter, which is where OPSEC chains spiral.

    The house rule itself, unchanged: two consequences follow from the grace window —
    (a) the **contested race is already answered** — both claimants wait, and whoever's turn
    arrives first declares and wins, which is exactly what `resolveFinalApproach` does, so no
    sudden-death or tiebreak mechanic is needed; (b) it is strictly the most generous of the
    three win rules to the defenders. It arms *final
    approach*: every other player gets exactly one turn to respond; if the player still holds
    ≥3 complete sets when their own next turn begins, they win then. Dropping below 3 disarms
    (and can re-arm — each arming restarts the cycle). Multiple players can be armed at once;
    the first to reach their checkpoint still armed wins. Engine emits `final_approach`
    `{actor, sets}` on arm and `final_approach_broken` `{actor, by}` on disarm so the client
    can treat it as the dramatic peak it is. Bots must understand both defending and breaking
    a final approach. `last_standing` (scoop-out) still ends the game immediately.
    The checkpoint requires a **full round**: the win resolves at the armed player's first
    own-turn start that is ≥ one full turn cycle after arming, so every opponent is
    guaranteed at least one turn to respond regardless of when the arming happened.
11. **Deck-cycle attrition end (ratified from P1b measurement).** After the discard has been
    reshuffled into the deck **16 times**, the game ends on points exactly like §3.6
    (most completed sets, net worth tiebreak), emitting `stalemate {reason:'deck_cycles'}`.
    Measured: fires in 0.45% of games, only at 5 players, and caps the pathological tail
    (p99 387 turns → max 152) without touching healthy games (p90 reshuffles = 5).
9. Every rule above must be reflected in card text and the help content — **no rule may exist
   that the help screen doesn't state**. The help must also cover: rent on incomplete sets,
   set sizes/rent ladders, OPSEC chains, scoop, hand limit, and win-on-opponent's-turn.

## §4 Structured event channel (the protocol addition)

The engine appends events to `state.events` as it mutates. Broadcast includes the tail
(last 120). Envelope: `{ seq, t, ...payload }` — `seq` monotonically increasing per game.
Client tracks `lastSeq`, animates only unseen events in order, then **reconciles** the DOM
against the state snapshot (the snapshot is always truth; animation is presentation).

Redaction rule: events must leak nothing `getPlayerView` hides. Draws/deals carry card ids
only in the drawer's own view; other players get `{count}`. Cards becoming public (played,
paid, discarded, stolen) carry the full public card object `{id, name, type, color, value}`
so the client can animate a card it has never seen.

Vocabulary (engine agent may append rows in its report; may not repurpose existing ones):

| t | payload | fired when |
|---|---|---|
| `game_start` | `{order:[pid], names:{pid:name}}` | game created |
| `deal` | `{to, count, cards?}` | opening hands |
| `turn_start` | `{actor, plays}` | turn begins |
| `draw` | `{to, count, cards?}` | draw phase / empty-hand 5 |
| `shuffle` | `{deckCount}` | discard reshuffled into deck |
| `play_money` | `{actor, card}` | banked |
| `play_property` | `{actor, card, color}` | property/wild placed |
| `play_action` | `{actor, card, action}` | action card hits the table |
| `rent_charged` | `{actor, color, amount, targets, doubled}` | rent played |
| `demand` | `{actor, target, amount, reason}` | finance/rollcall demand |
| `opsec` | `{actor, against, depth}` | OPSEC played (incl. counter-OPSEC) |
| `payment` | `{from, to, cards, total}` | payment resolves |
| `insolvent` | `{from, to}` | target had nothing of value |
| `steal` | `{actor, from, card, toColor}` | midnight requisition / CHUD |
| `swap` | `{actor, target, gave, took}` | TDY orders |
| `set_stolen` | `{actor, from, color, cards}` | inspector general |
| `upgrade` | `{actor, color, card}` | FOC/hangar placed |
| `move_property` | `{actor, card, from, to, swapWith?, swapHalf?}` | wild rearranged; the two optional fields tag the halves of an atomic swap (§3.5) |
| `set_completed` | `{actor, color}` | a set completes (any cause) |
| `discard` | `{actor, cards}` | end-of-turn discard |
| `turn_end` | `{actor}` | turn passes |
| `scoop` | `{actor}` | player scoops |
| `win` | `{actor, sets}` | victory |
| `stalemate` | `{winner, reason}` | deck-dry end |

## §5 Client architecture (P3+)

- **Store**: one module holding `{snapshot, self, room, timers, lastSeq}`. Snapshot replaced
  wholesale per `state` message; an **event queue** feeds the choreographer. Subscribers get
  `(snapshot, events)`. No `window._*` globals — interaction state lives in `interact/`.
- **Choreographer** (`anim/`): consumes events serially (max ~600ms per event, overlappable
  where safe), drives table mutations through `table/`'s API, then calls `table.reconcile
  (snapshot)` which corrects any drift silently. On reconnect or `?harness=1` fixture load:
  skip animation, snap.
- **Table API** (`table/`): `zoneFor(kind, ownerId, color?)`, `spawnCard(card | back)`,
  `moveCard(id, zone, {flip, arc, delay})` (FLIP: measure → reparent → invert → spring to 0),
  `reconcile(snapshot)`. Card faces are built once per card node and cached.
- Opponent hands render as **fanned card backs** (count-accurate up to 9, then a counter).
  The deck is a real stack with depth (up to 6 stacked back nodes + count). Discard shows the
  real top card, slightly rotated per card (seeded by card id — deterministic).
- Your properties and opponents' properties are **real miniature cards** in set columns —
  never text rows, never colored squares. Tapping any zone zooms it (no data hidden on touch).
- **Interactions** (`interact/`): tap a hand card → it lifts and shows an inline action strip
  (Play / Bank / Details), not a modal. Drag the same card to a zone to play it directly
  (drop targets highlight; invalid targets shake head). Targeting (rent target, steals) happens
  **on the table**: eligible player boards glow, tap to choose; Escape/scrim-tap cancels.
  Payment selection: your bank/property cards become toggleable with a running total chip and
  a confirm bar. Bottom sheets only for: card details, help, settings, discard pick.
- **Timers**: served `{timeout, startedAt}` → client renders ring/bar; urgency at ≤10s and
  ≤5s (sound + haptic once each, not per tick).

## §6 Design system — SUPERSEDED

**`ART-DIRECTION.md` ("APRON", ratified 2026-08-06) replaces this section in full.** Read it
instead: printed cream cards on an airfield apron, light and dark themes that change the table
and not the cards, colour-and-material as two independent channels (sets own colour, signals
own material), measured tokens, ten set glyphs, the desktop three-column table, menu music, and
the peek spec. §0 still outranks it. The text below is retained only as the record of what the
P3–P7 build was made against.

### §6-legacy (historical — do not build against)

- **Identity: "night flight line."** A felt-and-tarmac card table under hangar light. Navy
  felt surface (radial gradient + SVG feTurbulence grain, authored inline), gold as *foil* —
  reserved for emphasis (your turn, selection, CHUD, victory) — silver/steel for chrome,
  signal colors only from card sets.
- **One scale unit**: `--s: clamp(...)` on the app root; components size in `em`/`--s`
  multiples. Portrait override allowed. No other `px` font sizes.
- **Cards are the heroes**: aspect ratio 5:7 everywhere (one `--card-w` per context:
  hand/table/mini), layered face (frame, type band, name, art field, rent ladder, value coin),
  procedural per-color art motif (CSS/SVG — e.g. contrails, roundels, runway chevrons),
  embossed edge (inset highlight + drop shadow), **a real card back** (AF star roundel,
  used for deck, opponent hands, and flips). `backface-visibility` flips for reveals.
- **Type**: system stack, weight 800/900 for display with tight tracking; small caps/
  letterspacing for micro-labels. No webfonts (see §0.3).
- **Motion language**: overshoot easings (`cubic-bezier(.18,1.5,.4,1)` family) for landings;
  cards travel with slight arc + rotation; springs from `core/math.js` (`damp`, `spring`,
  `easeOutBack`) for JS-driven motion. Durations 180–420ms; nothing over 600ms uninterruptible.
- **Dark only.** No light theme. `theme-color` set. Looks native full-screen on a phone
  (`viewport-fit=cover`, safe areas, `overscroll-behavior:none`, no tap highlight).

## §7 Audio (P5) — all WebAudio synthesis

- No `AudioContext` before a user gesture; every call no-ops silently until `init()`.
- Master chain: `sfx/ui/music buses → compressor (-14dB, 12:1) → soft-clip WaveShaper →
  master`. No clipping as a graph invariant.
- **Card-tactile vocabulary is mandatory**: shuffle riffle (filtered noise bursts), card slide
  (short noise swish), card snap-down (thump + click transient), flip (pitch-swept tick),
  chip/coin for money, distinct positive chime ladder for set progress (pentatonic,
  monotonic), a *distinctly sour* treatment (tritone/downglide) for being stolen from or
  paying, klaxon-adjacent hit for CHUD, resolved fanfare + crowd-less confetti crackle for win.
- Events happening **to you** are louder/centered; others' are quieter. Rate-limit per sound;
  voice cap with weights.
- Haptics (`navigator.vibrate` where available): short tick on your card landing, double-buzz
  on being targeted, success pattern on set completion, long on win. Never more than one
  pattern per event.

## §8 Harness (P2, `tools/`)

All tools run headless Chromium (Playwright, devDependency) against `npm start` on an
ephemeral port, plus Node-only engine tools. Every tool exits nonzero on failure.

| Tool | Asserts |
|---|---|
| `tools/checkAssets.mjs` | no binary assets anywhere in repo (allowlist: none) |
| `tools/checkClient.mjs` | no `innerHTML` writes in `table/`/`anim/`; no `on*=` in html; entry cache-busted; **safe-area insets owned by exactly one container** — resolved against a parsed `index.html` tree so shell-level owners (`#sheet`, `#toast`, `.hints`) are not false-flagged |
| `tools/checkServer.mjs` | 7 raw-socket WS abuse vectors + ping/pong liveness. **A `[FATAL] uncaught exception` in the log fails the gate even though the process survives** — a liveness-only check passes 4/4 while every vector escapes (proven by mutation test) |
| `tools/simbalance.mjs` | winrate matrix per §3 bounds, prints table for README |
| `tools/playtest.mjs` | full seeded game to the win screen, zero console errors, drift 0 — **in both instant and animated passes** (`--cadence 120`, `setInstant(false)`), plus every big-moment `seq` must carry a `CHOREO_SFX` (`isBigMoment` is read out of the client so the gate cannot drift from it) |
| `tools/touchtest.mjs` | **real CDP `Input.dispatchTouchEvent`** (synthetic PointerEvents never consult `touch-action`); drag-play vertical AND horizontal-first; tap targets across 11 surfaces incl. `.propcol`, live drop targets, inputs and exposed hand-card strips; occlusion by **rect overlap** (hit-testing skips `pointer-events:none`); landscape; soft-keyboard composer; offline/reconnect; duplicate CTAs |
| `tools/screenshot.mjs` | review set at desktop / phone / landscape. Client-side moments are **driven, not staged** (`drive` + `expect` per shot); every PNG is hashed and **two differently-named shots sharing an image is a failure**; `auditClippedText` runs in-page at every capture |
| `tools/audiotest.mjs` | OfflineAudioContext: peak ≤ 0dBFS, chime ladder monotonic, sour below chime-0, **every loss cue louder than shuffle/snap/timer**, `droppedPriority === 0`, match music below `card_slide` |
| `tools/record.mjs` | fixtures from real seeded games; **fails if two moments select the same state** |
| `tools/checkContrast.mjs` | §0.9 text contrast in **both themes plus the `[data-theme]` override**; ink from `getComputedStyle`, paper **refined from the rendered frame** where the CSS answer is fiction (`#btn-quick-play` reads 1.22:1 in CSS, 8.4:1 painted); occluded and sub-8px runs counted, never gated; proven to fail (`--prove` injects `#6a6f78` → 0→31) |
| `tools/coverage.mjs` | **THE SURFACE CENSUS.** `lib/census.mjs` enumerates the client's own surface space FROM SOURCE — every `is-*`/`has-*` state class `public/style/` has a rule for and `public/src/` can produce, every attribute-VALUE selector, every shell layer `index.html` ships `hidden`, every screen, and `interact/`'s modes and `needs` steps (133 markers today; nobody maintains the number). `screenshot` and `touchtest` sample `observeMarkers` off the same settled frame they measure everything else on and drop a sidecar; this diffs the two in ~40ms of pure Node. **A marker no gate has ever visited is a FAILURE** — adding a screen without a shot breaks the build. Unholdable states (a 420ms shake, a card mid-flight) are EXEMPT with a reason each, and an exemption naming a marker that no longer exists is itself a failure. Also reports markers **styled but unreachable** (dead CSS), which nothing else can see. `--prove` |
| `tools/grayscale.mjs` | ART §10 grayscale hierarchy in CIE L\*: bulk range ≥45 and ≥3 tonal tiers. Plain figure-ground was **tried and rejected** — ART §2 puts L\* 97 stock on L\* 88 concrete, so that assertion would fail the ratified design. Proven to fail (flat-grey and no-ink-slab mutations both red; both simulated themes green) |

`tools/screenshot.mjs` additionally carries a **theme axis** (light+dark on a
representative subset; a byte-identical pair fails **by name**, `--prove-theme`
demonstrates it), **held-input shots** (mid-drag, peek) driven by real mouse/CDP
touch across the shutter, and captures only **settled frames with client storage
reset** — two harness bugs that had been silently corrupting every byte-identical
rule (the same seed produced 36.8 vs 86.9 L\*, and once-ever hints surviving
`page.goto` produced two images 21,593 pixels apart from identical state).

**Why the census exists, and it is the most expensive lesson in this table.** The
twelve gates were measuring *what they could reach*, not *what a player sees*. Six
surfaces reachable in ordinary play had been rendered by none of them, and each was
found by a different agent tripping over it while doing something else: the **host
lobby** (a lobby broadcast carries no `game`, and `game` was the only thing
`store.applyState` could infer a seat from, so `store.self.id` stayed null and every
`lobby@*.png` ever taken was the *guest* view); the **`myColor` wild-placement step**
and the advice printed on the mats; an **opponent holding an Upgrade**; an **opponent
at six colours**; an **ARMED opponent** (the `final-approach` selector claimed a
"threat view" and tested `armedIds[0] !== currentPlayerId`, which is a different
question — it had always selected the local seat); and both transient message layers,
**`#toast`** and **`.announce`**. All six are now fixtured/driven and gated. A
hand-written list of surfaces would have had the same holes, because it is written by
the same people who write the gates — so the list is read out of the client instead,
and `lib/stage.mjs` seats the client from the fixture's own `selfId` (`__CHUD.joinAs`,
§9) so no tool can forget the step that hid the lobby.

`npm run verify` chains: `check → test → checkAssets → checkClient → checkServer → simbalance →
playtest → touchtest → screenshot → checkContrast → coverage → audiotest`. **Strict is the default** — a skipped gate
fails the run; `--allow-skips` is the loud escape hatch, `verify:fast` is for the inner loop.
Review sets are for humans/critics, not pixel-gated (no imagediff until the design settles).

**A gate must be proven to fail.** Before a new assertion is trusted, break the fix it guards
(mutation) and watch it go red — an assertion nobody has seen fail is a decoration.

**A gate must also be proven not to move.** Two runs on an unchanged build must produce the
same number, and a driver must verify its target before aiming at it. Every moving count this
project produced was the gate measuring something other than what it reported: buried text
went 317 → 219 → 219 because both audits ran 180ms *before* the frame that was actually
photographed; the clipped-control count moved 38 → 48 because six surfaces were opened over a
*live* game whose bots act on a wall clock a seed cannot fix; and `peek-opponent` reported
`peek:absent` because the driver aimed at the middle card in document order, which was behind
`.propcol` — reporting a layout defect as a peek defect.

**A gate that measured nothing must not pass.** Enforced by `MIN_PAIRS` in grayscale and
`stagesFailed` in touchtest, both found by mutation rather than review — touchtest once printed
"✓ tap targets ≥ 44px on all 9 measured surfaces" on a run where all five staged surfaces had
failed to load, because the summary counted what it was given.

**A summary may not report success over a set it did not fully measure.**

## §9 The `__CHUD` bridge (test-only contract)

With `?harness=1`, the client exposes `window.__CHUD`:

```js
{
  version: 1,
  ready: Promise,            // resolves when modules are up
  applyState(stateMsg),      // inject a full server state message (fixture)
  joinAs(playerId, name),    // take a seat exactly as the server's `joined` does.
                             // Added P9: a LOBBY broadcast carries no `game`, and
                             // `game` was the only thing store.applyState could
                             // infer a seat from — so every lobby capture in the
                             // whole harness was the guest view of a transcript
                             // recorded by the host. tools/lib/stage.mjs calls it
                             // before every applyState, from the fixture's selfId.
  drainEvents(),             // run queued event animations instantly
  sfxLog: [],                // {name, t} — audio engine records instead of playing
  hapticLog: [],
  driftCount: 0,             // reconcile corrections since load (0 = choreography honest)
  lastError: null,
}
```

Fixtures live in `tools/fixtures/*.json` and are **recorded from real seeded games**
(a recorder script saves the state broadcasts), never hand-authored — states the game
cannot reach must not be screenshot.

## §10 Hard-won invariants (append here as they're earned)

| Invariant | Why | Enforced by |
|---|---|---|
| Card conservation (106, no dupes) before every broadcast | corrupt state = unwinnable game | `validateState` in engine |
| Events leak nothing `getPlayerView` hides | hidden information is the game | `test/protocol.test.js` additions (P1) |
| Snapshot is truth; animation is presentation | desync shows wrong game | `driftCount === 0` in playtest |
| No `AudioContext` before gesture | silent console, autoplay policy | audiotest + code review |
| Zone containers never innerHTML-rebuilt | kills FLIP, scroll, focus | checkClient scan |
| Choreography ≤600ms/event, interruptible | multiplayer can't wait on your cinematics | motion agent measures; playtest wall-clock |
| A swap changes no zone count and no set completion | it is the only reason §3.5's cap holds by construction rather than by ordering — a swap that altered either would be two moves wearing one name, and the transient overfull state we refused would be back through the side door | `test/property-swap.test.js` |

## §11 Phase plan and review gate

P0 constitution → P1 engine+balance → P2 harness → P3 client core (architect, then table/ui/
design in parallel) → P4 motion+interaction → P5 audio+fx → P6 content+clarity → P7 beauty
passes + adversarial gauntlet.

The **gate**: independent critic agents score Look, Feel/Juice, Mobile UX, Clarity/Rules,
and Robustness 1–10 with evidence (screenshots, playtest logs). Ship requires **≥8/10 on
every axis**, re-scored after each fix round by *fresh* critics. Scores without cited
evidence are void. The final README must include an honest-assessment section with the last
round's real numbers.
