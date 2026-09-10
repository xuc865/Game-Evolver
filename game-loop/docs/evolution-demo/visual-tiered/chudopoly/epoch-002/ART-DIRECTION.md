# CHUDOPOLY — ART DIRECTION: "APRON"

Ratified 2026-08-06 by the orchestrator from the P8 research brief. **This document is
binding** and replaces ARCHITECTURE §6. Where it and any other doc disagree, ARCHITECTURE §0
still wins (no build step, zero binary assets, one clock, accessibility floor).

Provenance: the owner's `/Users/hunter/design-research/` corpus; Grok CLI with X search;
independent verification of every contrast ratio and license by the research agent.

## 0. The thesis

**Real printed cards on a real airfield apron.**

Light theme = the apron in daylight (warm concrete). Dark theme = the apron at night.
**The cards do not change between themes** — they are cream printed stock in both, like
physical cards in a lit room and a dark room. The *table* changes; the *objects* don't.

This kills the navy dominance without abandoning blue, makes the 10 set colours a solved
problem (they only ever sit on one substrate — cream stock), and gives every later decision a
right answer to check against: *is that how paper, concrete, or paint behaves?*

The old identity "night flight line" is retired.

## 1. Colour and material are two independent channels

Hue-based signalling is banned. 10 categorical set hues + 4 semantic hues do not fit in 360°
with usable separation — measured collisions today: `--go` 152° vs Elite green 136°, `--warn`
31° vs T&E orange 29°, `--gold` 42° vs Mobility yellow 46°.

> "Using color to distinguish between 'types' of anything in a game is a bad idea —
> iconography and form is much better from a UX perspective." — @kingbdogz (Mojang), via X

| Layer | Carries meaning via | Never |
|---|---|---|
| Card sets (10) | **glyph first, colour second** — distinct silhouette per set; colour only as a solid band on stock, a 3px mat rail, and the glyph | glow, gradient, ring, animation |
| Primary action (CONFIRM, END TURN, REMATCH) | **achromatic ink slab** — solid `--ink` in light, solid `--paper` in dark | any hue at all |
| Selection / your turn / valid drop | **cobalt ring** — 2px stroke *outside* the object | being a fill |
| Danger / final approach | **hazard material** — 45° caution stripes + vermillion | being a plain coloured chip |
| Foil / brass | **victory modal only** | anywhere else |

> **OWNER RULING 2026-08-07 — the victory modal is a CEREMONY, and the anti-slop
> rules do not apply inside it.** A critic called the win screen's gold rays "the
> most AI-generated-looking element in the build" and the fix stripped it back to
> a flat grey panel with plain type. The owner compared the two directly: *"yesterday
> just looked so much better, higher res etc — it's almost too bland now."* They are
> right, and the over-correction was mine. Inside `#win-overlay` the following are
> **sanctioned, not violations**: gold display type for the title, a foil-gradient
> primary CTA, a lit roundel, and depth/atmosphere behind the panel. "No glow" and
> "no gradient CTA" are rules for the *table and its chrome*, where they stop the
> UI shouting over the cards. The victory screen is the one place the game is
> allowed to shout. Restraint outside the modal, ceremony inside it.

Sets own colour-as-fill; signals own material. They cannot be confused even at 4° of hue
separation, and the system survives colourblindness — which the current build does not.

## 2. Tokens (measured, WCAG 2.x relative luminance)

**Shared — the card, identical in both themes**
```css
--card-stock: #FBF8F1;  --card-edge: #D9D2C4;  --card-back: #14161A;
--ink: #14161A;         /* 17.08:1 on stock */
--ink-mute: #5C6470;    /*  5.64:1 on stock */
```

**Light — "apron, daylight"** (never pure white: a white UI is a flashlight in the face)
```css
--ground: #E8E2D4;  --ground-deep: #D5CDBB;  --surface: #F3EEE3;
--fg: #14161A;      /* 14.02:1 on ground */   --fg-mute: #5C6470;  /* 5.1:1 */
--act: #14161A;     --act-fg: #FBF8F1;        /* 18.1:1 */
--accent: #0B4FD8;  /* AF cobalt, 5.20:1 */   --danger: #C9300B;   /* 4.16:1, always with stripes+icon */
--foil: #8A6320;    /* victory modal only */
```

**Dark — "apron, night"** (neutral near-black, NOT navy — this is the fix)
```css
--ground: #15171C;  --ground-deep: #0B0D10;  --surface: #20242B;
--fg: #F2EEE4;      /* 15.48:1 */             --fg-mute: #8E97A3;  /* 5.27:1 */
--act: #F2EEE4;     --act-fg: #14161A;        /* 15.63:1 */
--accent: #6E9BFF;  /* 6.66:1 */              --danger: #FF6A3D;   /* 6.30:1 */
--foil: #C9A253;
```

**The 10 set colours — one set, both themes** (all ≥4.5:1 on card stock AND white-on-them ≥4.5:1)

| Set | Hex | on stock | white on it |
|---|---|---|---|
| Drone Ops | `#8A4B1E` | 6.37 | 6.76 |
| Training | `#136C90` | 5.54 | 5.87 |
| Space Force | `#B01C63` | 6.20 | 6.58 |
| Test & Eval | `#A85200` | 5.11 | 5.42 |
| Fighters | `#B81A33` | 6.12 | 6.49 |
| Mobility | `#8A6A00` | 4.78 | 5.07 |
| Elite Programs | `#1B6E37` | 5.94 | 6.30 |
| Command | `#26308F` | 10.41 | 11.04 |
| Overseas Bases | `#0C5F5B` | 7.06 | 7.49 |
| Intelligence | `#465767` | 7.02 | 7.45 |

Set **mats** on the table: same hue at 14% alpha (light) / 22% (dark) over ground, plus a 3px
solid rail. Mats are furniture; cards are objects.

Watch: cobalt 220° vs Command 234° is 14° apart — mitigated by material (cobalt is only ever a
ring, Command only ever a fill) plus the four-star glyph. Verify in review.

Delete: `--felt-*`, `--steel-*`, `--gold-dim`, `--go`, `--warn`.

## 3. The eight things that make it read as a web app (kill all of them)

Diagnosed from the current review set:

1. **Full-width stacked bands** — `mid-game@desktop` is seven full-bleed horizontal sections.
   That is page anatomy. Card tables have a centre and edges. → §5 grid.
2. **Rounded-rect panel + 1px border on slightly-lighter ground, ×9 per screen** — the
   dashboard stack named in the owner's own report. → furniture gets *material*: debossed into
   the apron (`inset 0 2px 3px rgba(0,0,0,.25), inset 0 -1px 0 rgba(255,255,255,.06)`), never
   outlined. **Zero `border: 1px solid` on table furniture.**
3. **`home@desktop` is a login form** — centred 430px card, five equal full-width buttons,
   label-above-input, gradient CTA. → the home screen IS the table, seen from above, deck
   sitting on it, actions painted into the apron as markings.
4. **Metallic-gradient primary buttons** → flat ink slab, hard 4px offset shadow, collapses to
   0 on press. *"If you need gradients to make it look good, you can't design."*
5. **Glow as personality** (roundel, win screen) → no glow anywhere; the roundel is *debossed*.
6. **~40 tracked-uppercase micro-labels per screen** → a real type scale (§4). Tracked caps
   survive in **exactly one place**: the set name in a card's colour band.
7. **Floating hint pills over the board** → hints are *stencilled on the apron* in ground-
   coloured ink, not floating objects.
8. **One art motif reskinned ten times** → ten distinct glyphs (§6).

Grayscale test on `mid-game@desktop` currently **fails** — everything sits within ~8%
luminance. It must pass.

## 4. Type, depth, motion

**Type — earn hierarchy with size and weight, never tracking.**

| Role | Stack | Treatment |
|---|---|---|
| Display | `ui-rounded, "SF Pro Rounded", "Segoe UI Variable Display", system-ui` 800 | 2.5–4× body, tracking **−0.02em** |
| Body / rules | `system-ui, -apple-system, "Segoe UI", Roboto` 400–600 | sentence case, readable |
| Figures (money, rent, counters, codes) | `ui-monospace, "SF Mono", "Cascadia Mono", Menlo` + `tabular-nums` | this is the character |

No webfonts (§0.3). `ui-rounded` on Apple platforms is distinctive, costs zero bytes, and is
nothing like Inter.

**Depth — two shadow languages, each earned.** Paper casts a soft shadow; painted steel does
not.
- **Cards** (mass): `0 1px 1px rgba(0,0,0,.18), 0 3px 6px rgba(0,0,0,.14), 0 10px 24px rgba(0,0,0,.10)` at rest; ~×2.5 offset/blur while dragged.
- **Chrome** (pressables): hard offset, zero blur, `4px 4px 0 var(--ink)`; on `:active`
  `translate(4px,4px)` and shadow → 0. Offset shadows appear **only** on pressables, only as a
  press mechanic — never on cards, panels, or decoration (they are becoming the next cliché).

**Motion — one physics, five verbs.** The playbook's "motion budget = 2" translates for a game
as: **two world-stopping moments, one physical system underneath.**
- Signature moments: **set completion** (cards square up, rail flashes, coin ladder chimes) and
  **final approach / victory** (hazard rails rise; on victory the apron floods).
- Everything else is physics: deal, play, flip, steal, pay — each with its own arc height,
  rotation and duration so a steal *feels* different from a play.
- Measured numbers to build against: drag tilt `rotate(v*6deg)` + `scaleX(1+|v|*0.08)`; settle
  `250ms cubic-bezier(.22,1,.36,1)`; springs `stiffness 520 / damping 38`; deal stagger 64ms.
- **Hitstop**: freeze the table 40–60ms on a card landing before the settle. ~6 lines in the
  choreographer; the largest perceived-weight gain available.
- Edge friction over hard stops: invalid drops **lerp home over 260ms**, never teleport.
- **View Transitions API** for whole-screen changes only (home → lobby → table → win); gated
  behind `prefers-reduced-motion`. Never for card movement — card moves must stay interruptible.

## 5. Desktop table layout

> **OWNER OVERRIDE 2026-08-06 — the seating below is REJECTED.** After playing it:
> *"layout wise I think it looked better before — the other players at top, chat opening on
> the right etc."* So: **opponents sit across the TOP**, and **comms opens as a RIGHT-hand
> drawer**, as they did before. Everything else in this section still holds — the deck and
> discard must stay out of the path between hand and properties, the property region must
> remain a generous 2D drop target (the drag must never go back to "285px straight up into a
> 60px strip"), and the hand must stay fully on-screen. The measured geometry below is kept
> as the record of what the three-column cut was solving; re-solve those problems within a
> top-opponents layout.
>
> **Delivered, with its cost stated (2026-08-07).** Seats sit across the top, comms is a
> right-hand overlay drawer, and the piles never sit between hand and properties. The drop
> target stayed a 5×2 grid (~110px drag, not 285px into a 60px strip). But **720px cannot hold
> seats-on-top *and* §5's run-up**: the hand fan is **84px, not 96**, the ~100px gap to the
> hand is **0**, and the bank is `position: sticky; bottom: 0`. Those three numbers supersede
> §5's above. Opponent seats scroll with 2+ opponents; a full board still overflows ~15px into
> the sticky-bank fallback.
>
> **Furniture separation is now the load-bearing part of the identity** (2026-08-07). The
> build read flat because cards sat on mats at 1.09:1 and mats on the table at 1.8 L\* (light)
> / 0.1 L\* (dark) — right colours, no steps. The furniture now steps *down* from the ground
> (light panels 94.2 → 70.1, dark 14.1 → 30.0) and all 16 adjacent pairs clear 12 L\*.
> **Caveat the gate prints every run:** 12/12 dark and 10/12 light pairs are carried by *edge*
> treatment, and the weakest field step is **0.0 L\*** — `#hud` and `.board-bank` are the same
> tone as their surroundings, separated purely by stroke and shadow. That is a legitimate §4
> position and it is fragile in a nameable way: remove the strokes and the same palette fails
> at 4.4.

The complaint diagnosed: ten set slots in one centred ~60px-tall row with ~250px of dead apron
below, hand fan cropped at the viewport — a ~285px drag straight up into a 60px band with no
lateral forgiveness. At `min-width: 1024px`, three columns instead:

| Element | Spec |
|---|---|
| Left rail | 220px — deck, discard, mission log, room code. **Never between hand and properties.** |
| Right rail | 200px — opponents as vertical **seats**, stacked. 5 players shrinks seat height, never crams horizontally. |
| Centre | ~840px, yours |
| Property mats | **5 × 2 grid**, each **156 × 132px**, 8px gutter |
| Bank mat | 340 × 90 under the grid |
| Gap to hand | ~100px |
| Hand fan | 150px tall, cards ≥96px, **fully inside the viewport** |

Drag becomes ~120px into a 132px 2D target. **Six drop affordances, all required:**
1. On drag start: legal mats scale 1.04 + 2px accent ring + one elevation rung; illegal mats
   desaturate to 35% and drop a rung.
2. Magnetic snap: invisible hit radius **48px** beyond visual bounds; snaps early and *stays*.
3. Landing silhouette: dashed card ghost at the exact final position and rotation.
4. **Whole-region auto-place**: dropping anywhere in the property region plays the card into
   its only legal set. Precision is required only for genuinely ambiguous cards (wilds).
5. Hand retracts 24px and flattens on drag start, opening the path.
6. Invalid drop lerps home (260ms), never teleports.

Mobile portrait keeps its dock; the fix there is that hand cards are cropped at the viewport
bottom in every phone shot — that reads as broken, not dense.

## 6. Cards

Stop drawing a sci-fi HUD mini-poster on dark stock. **Draw a printed card.**

**Face (hand size, 5:7):** solid set-colour band full-bleed across the top 20% with the set
name in stock colour, 800 weight, tracked caps (the app's only tracked caps) → glyph at ~46%
card width, centred high, set colour at 100% → rent ladder right-aligned in mono tabular
figures → value coin: filled ink disc with bone numerals, ≥22% of card width.
Stock carries `--grain` at ~3.5% and a 1px `--card-edge` inset stroke 2px in from the trim.
Corner radius **6px** (not 0 — that's a spreadsheet cell; not 12 — that's an app card).
Watermark: the glyph at ~130%, set colour 7%, bled off the bottom-left.
**A card must announce WHICH COLOURS it concerns, before it announces what it is.**
(Owner defect, 2026-08-06: "there is like an orange rent card but it's actually the wild — it
was quite confusing what the actual card was and what it did." Every rent card wore the same
amber band, so the band said "rent" and nothing said "which rent". Monopoly Deal solves this by
making the rent card *be* its colours. Copy that.)

- **Colour-pair rent** — the face is **dominated by its two set colours**, split hard down the
  middle (or 45°), each half carrying that set's glyph. A small achromatic RENT mark identifies
  the type. No amber band. At mini tier the card is simply the two colours split, which is
  identifiable at 28px.
- **Wild rent ("any")** — **all ten set colours**, as a hard-edged fan/wheel of segments, never
  a soft rainbow gradient (a gradient reads as decoration; hard segments read as "all of them").
  It must be unmistakable at a glance against every colour-pair rent.
- **Two-colour property wild** — the two colours split with both glyphs at half size.
- **Any-colour property wild** — the same ten-colour device as the wild rent but in the
  *property* chassis, so the two wild kinds differ by chassis, not by colour. Both are 0M, and
  the value coin reading `0M` is a third distinguishing channel.
- **Actions** — achromatic ink slab band plus a large action-specific glyph; actions concern no
  colour, and that absence is itself the signal.

The test: at mini tier, with no text rendered, a player must be able to say *which* rent this is.

**Tier degradation via container queries** — at ≤60px: band + glyph at 60% + value coin, and
nothing else (three marks). At ≤28px: band + glyph at 70% only. Nothing that can truncate.

> **AMENDED 2026-08-07 — the 14×14 1-bit mandate is retired for set glyphs.** It was the right
> test for the *mini* tier and the wrong objective for the whole system: three redraws chasing
> a threshold check produced a Space Force mark that reads as a witch's hat, and the owner's
> verdict on the result was "this SVG art is just bad". **Two marks per subject** instead — a
> drawn glyph that only has to work from the table tier up, and a letter/short code that owns
> the mini tier. That is also how MIL-STD-2525 does it (air platform type is carried as a
> Sector-1 letter: B bomber, C cargo, F fighter, K tanker, R recon), so the split has
> precedent in the game's own idiom rather than being a concession.
>
> **Three legal constraints on how the art is made** (researched 2026-08-07, sources in the
> research report; none of them require a §0 change):
> 1. **Draw no insignia by hand.** 32 C.F.R. §507.9 is inverted from intuition: *photographing*
>    a service medal, badge, patch, seal or device is **authorised**, while "making or executing
>    in any manner any engraving, impression, or **colorable imitation**" is **prohibited**
>    without written approval. Hand-authored SVG is exactly the prohibited act. This rules out
>    seals, emblems, patches, medals, ribbons and **roundels** — including the star-and-bar
>    device currently on the card back, which is a colorable imitation of the US national
>    aircraft insignia. Generic aircraft planforms and 2525-style glyphs are unaffected.
> 2. **Trace from orthographic 3-views, never from photographs.** *ATC Distribution v. Whatever
>    It Takes* (6th Cir. 2005) held sketches traced from catalogue photographs uncopyrightable
>    slavish copying; *Rentmeester v. Nike* (9th Cir. 2018) held that reducing a photo to a
>    silhouette is non-infringing as a matter of law. A top-down planform keeps none of a
>    photographer's choices; a dramatic three-quarter shot keeps all of them. Trace only Tier-1
>    public-domain corpora (Greg Goebel's ~557 `PD-author` silhouettes, FM 44-80 *Visual
>    Aircraft Recognition*, US Navy Standard Aircraft Characteristics 3-views, AIGA/DOT).
>    **~57% of Commons' 3-view aircraft SVGs are CC BY-SA** — tracing one would force the whole
>    game copyleft to save an hour of drawing. Keep a per-asset provenance log and cross-check
>    each planform against two independent PD sources.
> 3. **Trademarked designations stay on card faces and off all branding.** *AM General v.
>    Activision* protects depicting and naming real hardware inside an expressive work;
>    *Jack Daniel's v. VIP Products* (2023) removes that protection when a mark is used as a
>    source identifier for your own goods. "F-35 Lightning II" as a card name is defensible;
>    the same name on packaging, a logo or a store listing is not. Note "Thunderbirds" is a
>    claimed DAF brand element **including trade dress** — the four-ship diamond geometry is
>    fine, the name and any red/white/blue livery are the exposure.
>
> **Technical-order drawing style** (MIL-STD-38784B / ASME Y14.2), which the identity already
> half-honours: exactly **two line widths at a 2:1 ratio**, thick for object lines only;
> **square corners always** (`miter` joins, `butt` caps, no rounded corners anywhere);
> **never a gradient, blur or soft shadow** — the one sanctioned shadow in the entire corpus is
> a hard zero-blur offset block behind a WARNING box; solid black reverse-out chips used
> aggressively; and **patterns rather than opacity for tints** (a 45° dot-grid reads as the
> halftone screen it is imitating, where `fill-opacity` just reads as faded).

**Ten glyphs**, historically specified as legible 1-bit at 14×14px on a 24px grid with a 2px
minimum stroke (see the amendment above — this now applies to the code, not the drawing): Drone Ops = top-down delta UAV · Training = two stacked chevrons · Space Force
= dot with one elliptical orbit · Test & Eval = reticle with axis ticks · Fighters = swept-wing
jet nose-up · Mobility = high-wing cargo with T-tail · Elite Programs = four-point star in a
diamond · Command = four stars in a bar · Overseas Bases = runway trapezoid with centreline
dashes · Intelligence = parabolic dish on a mast. These are also the colourblind channel.

**Card back — the one dark object:** `--card-back` in both themes, roundel debossed, 45°
cross-hatch at 4%, 2px bone border inset 3px. Faces are bone, backs are near-black, so face-up
vs face-down is unmistakable at 20px (currently they are near-identical).

## 7. Menu music

Character: **pre-flight, before dawn.** Aviation (mechanical, precise, a little lonely), not
military brass — and brass is also what we cannot synthesise convincingly, so constraint and
taste agree. It must have a **pulse** and a **phrase that ends**; corporate ambient has long
pads, no pulse, no phrase, no stakes.

A minor or D Dorian · 96 BPM · 8 bars 4/4 (~20s, perfect loop on the bar) · 3 voices at rest,
4 max · master −14 dBFS.
1. **Bass** triangle, root on 1, walking note on 3, ~15ms attack, long decay.
2. **Pad** two saws detuned ±6 cents, lowpass ~900Hz, 0.07Hz LFO on cutoff, whole notes,
   `i – VII – VI – VII`, −18dB relative to lead.
3. **Lead** square, a 4–6 note motif over 2 bars, playing bars 1–2 and 5–6 and **resting 3–4
   and 7–8**. The rests are the whole trick.
4. **Air** filtered white noise, highpass ~4kHz, gated 8ths at −26dB. **No kick drum.**

Anti-fatigue: every 2 loops change exactly one thing (mute the air 4 bars / transpose the motif
+2 / invert the pad voicing); a second pad layer only after 45s idle; seed the variation
sequence from `core/rng.js`. Exit on match start: bar-aligned V→i stinger + noise riser (500ms)
with an 800ms exponential ramp to silence and cutoff → 300Hz. Never a hard mid-note cut (reads
as a bug), never a 5s fade with no stinger (reads as a website).

## 8. Peek — reading a card costs zero taps

`public/src/ui/peek.js` exists; this is refinement, not a rebuild.

| Concern | Value | Why |
|---|---|---|
| Hover open | **140ms** | the peek is the primary read path, not an incidental tooltip |
| **Delay group** | **600ms grace; second-and-later peeks open at 0ms and crossfade** | the missing piece — a single timer can either stop lag or stop strobing, not both |
| Close delay | **160ms**, cancelled on re-entering any peekable | instant-out feels twitchy across a 2px gap between fanned cards |
| Safe polygon | cheap ~40-line version: pointer→peek triangle counts as still-hovering | steal the idea, don't vendor Floating UI |
| Scale | 2.6× table / 1.9× hand, **min 280px wide** | 280px is where rules text hits ~15px |
| Touch hold | **300ms** | the 500–700ms research number is for context menus, where a false positive is expensive; a peek is free and dismisses on release |
| Drag slop | **8px**, and movement past it **hands off to the drag** and dismisses the peek | must never swallow the gesture |

**Live context is what makes it a game feature rather than a tooltip:** a rent card shows
*"Collects 5M from Blaze right now"*; a property shows *"Elite Programs 2/3 · one more
completes"*; a wild shows its legal sets with glyphs; an action shows its resolved outcome
against the current table; **any card shows whether it is playable right now, and if not, why**
— which removes an entire class of confused taps.

**Accessibility parity is mandatory**, because rules text must not live only in a hover: every
card control carries name/cost/type/rules in its accessible name and description; arrow keys
traverse the hand and **focus opens the peek at 0ms**; Enter/I/long-press opens the persistent
details dialog; `prefers-reduced-motion` removes the scale transition.

## 9. Libraries: vendor nothing

Verified licenses and measured sizes (jsDelivr min builds, Aug 2026):

| Library | Verdict |
|---|---|
| Motion (motion.dev), MIT, ~46KB gz for springs+timelines | **already written** — the "90% smaller than GSAP" claim doesn't survive measuring full builds |
| anime.js v4, MIT, ~41KB gz | best ESM story of the three; still redundant with `choreographer.js` |
| GSAP + Flip, **not OSI** (Webflow license) | our FLIP works; a non-OSI license on a project whose whole story is "npm start is the deployment" is a liability for zero gain |
| Lit, BSD-3 | **architecturally wrong** — §0.4 requires persistent card nodes reparented, never rebuilt; a declarative re-render library fights that invariant |
| Oat, MIT | study it, don't ship it — adopting it means adopting its look then overriding all of it |
| Floating UI, MIT | steal `safePolygon` (~50 lines), don't vendor |
| ZzFXM, MIT | study the instrument/pattern/sequence data model for `audio/music.js`; don't vendor (it renders to AudioBuffer, we synthesise live) |
| Tone.js | larger than the entire client |
| mo.js, Popmotion, Velocity, WOW.js, ScrollReveal | **dead** — all last shipped ~2022 |

The one platform primitive worth adopting is the **View Transitions API** (§4). A Grok
recommendation of *"MICL (henkpb/micl)"* could not be verified to exist — **do not act on it.**

## 10. Ship gate (the owner's own tests)

- [ ] Remove the roundel — does it still look like this specific game?
- [ ] Count custom visuals: target ≥16 (10 glyphs + back + coin + ladder + apron + stencil +
      hazard rail). Current: **1**.
- [ ] Grayscale `mid-game@desktop`: is hierarchy still readable? Current: **fails**.
- [ ] Both themes ≥4.5:1 on every text token (§2 values are pre-verified).
- [ ] `prefers-reduced-motion`: motion → fades, sound stays.
- [ ] Phone: is the hand fully on-screen? Current: **no**.

## 11. One deliberate departure from the owner's corpus

`grainwave-field-guide.html` commits to cream `#f4efe4` + Instrument Serif italic. **The cream
is kept and used; the editorial serif display face is not** — X reporting (@pbakaus, whose own
site was beige + italic serif by hand) shows that combination has become the 2026 attractor
after Claude flooded the market with it, and we cannot load the face anyway. Our cream is card
stock and concrete with grain and hard geometry, not a beige editorial landing page. That
distinction must stay visible or we walk into the 2026 version of the trap the whole corpus is
about.
