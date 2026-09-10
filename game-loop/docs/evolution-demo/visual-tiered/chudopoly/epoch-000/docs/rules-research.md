# Rules Research — CHUDOPOLY §3 rulings vs official Monopoly Deal and the field

Date: 2026-08-08. Research-only; no engine changes proposed or made. Every external claim has a
URL; page snapshots and the cloned implementation are preserved under
`/tmp/chud-evidence/rules-research/` (ephemeral — re-fetch if gone; all sources were live on
2026-08-08).

## Sources (priority order)

**Official Hasbro:**

- 2008 rulebook PDF (shipped in the box):
  <https://www.buffalolib.org/sites/default/files/gaming-unplugged/inst/Monopoly%20Deal%20Card%20Game%20Instructions.pdf>
  (also <https://archive.org/details/monopoly-deal-rules-2017>; Hasbro's own portal
  <https://instructions.hasbro.com/en-gb/instruction/monopoly-deal-card-game> links the same rules)
- Hasbro customer-care FAQ (live, North America):
  - a_id/922 rearrange on your turn — <https://hasbro-new.custhelp.com/app/answers/detail/a_id/922>
  - a_id/924 more than 3 sets — <https://hasbro-new.custhelp.com/app/answers/detail/a_id/924>
  - a_id/925 multiple players, same colour — <https://hasbro-new.custhelp.com/app/answers/detail/a_id/925>
  - a_id/926 Sly/Forced Deal vs complete sets — <https://hasbro-new.custhelp.com/app/answers/detail/a_id/926>
  - a_id/928 Deal Breaker takes house/hotel too — <https://hasbro-new.custhelp.com/app/answers/detail/a_id/928>
  - a_id/937 move wilds between sets — <https://hasbro-new.custhelp.com/app/answers/detail/a_id/937>
  - a_id/939 wild cards as payment — <https://hasbro-new.custhelp.com/app/answers/detail/a_id/939>
  - a_id/944 which cards can pay — <https://hasbro-new.custhelp.com/app/answers/detail/a_id/944>
  - a_id/945 not enough money — <https://hasbro-new.custhelp.com/app/answers/detail/a_id/945>
  - a_id/948/949/951 Double The Rent (counts as a play / any rent card / two = ×4) —
    <https://hasbro-new.custhelp.com/app/answers/detail/a_id/951> (948, 949 adjacent)
  - a_id/950 2-colour rent charges ALL, 10-colour rent charges ONE —
    <https://hasbro-new.custhelp.com/app/answers/detail/a_id/950>
- The 2011 official FAQ (predecessor of the custhelp answers above, via Wayback):
  <https://web.archive.org/web/20111221041240/https://www.hasbro.com/monopoly/en_US/discover/faq.cfm>

**Implementations surveyed:**

- **playmdeal** — <https://playmdeal.com/> ; official rulebook page <https://playmdeal.com/rules>
  (reskinned names: Steal=Sly Deal, Swap=Forced Deal, Takeover=Deal Breaker, Charge=rent,
  Rainbow Charge=wild rent, Charge 2x=Double The Rent, +3/+4=House/Hotel, No=Just Say No).
  Closed-source server; only documented behaviour is cited.
- **coopoly-deal** (= **monopolydealonline**; the same thing) — source:
  <https://github.com/alexwohlbruck/coopoly-deal> (cloned 2026-08-08, engine read at
  `server/src/engine/game-engine.ts`); deployed at <https://monopolydeal.online/> (confirmed by
  `client/src/hooks/useGameStore.ts:19-20` and `ShareModal.tsx:51` hard-coding
  `monopolydeal.online`). Line numbers below are from that clone.
- **monopolydealrules.com** — fan FAQ (2012-era, "generally accepted answer" where official is
  silent): property <https://monopolydealrules.com/index.php?page=property>,
  rent <https://monopolydealrules.com/index.php?page=rent>,
  house/hotel <https://monopolydealrules.com/index.php?page=house>,
  action <https://monopolydealrules.com/index.php?page=action>,
  general <https://monopolydealrules.com/index.php?page=general>
- Corroborating: monopolyland.com (collected Hasbro Twitter rulings)
  <https://www.monopolyland.com/monopoly-deal-rules/>; Monopoly Wiki
  <https://monopoly.fandom.com/wiki/Monopoly_Deal>; BoardGames StackExchange
  <https://boardgames.stackexchange.com/questions/2557/in-monopoly-deal-can-you-pay-with-houses-or-hotels>;
  BGG thread documenting a Hasbro self-contradiction
  <https://boardgamegeek.com/thread/565556/paying-with-househotel-card-but-to-where-hasbro-co>

**Engine spot-checks (our side):** `game.js:1401-1410` (surge counter, ×2^stack, rent branch only),
`game.js:1637` (rent passes `surgeable:true`), `game.js:1464,1480` (Finance Office/Roll Call never
surgeable), `game.js:1581-1587` (surge_ops increments counter), `game.js:1832-1834,1868-1875`
(insolvency counts *cards*, zero-value wilds included), `game.js:1808-1817` (swap calls
`bankUpgrades` on both sides when a set breaks).

---

## Ruling-by-ruling comparison

### 1. TDY Orders (=Forced Deal) and Midnight Requisition (=Sly Deal) cannot touch complete sets — both sides of a swap

**Official MD — MATCH.** Card faces: Sly Deal *"Steal a property from the player of your choice.
(Cannot be part of a full set.)"*, Forced Deal *"Swap any property with another player. (Cannot be
part of a full set.)"* (2008 rulebook, "The Cards in More Detail"). a_id/926: *"If you have a Sly
Deal or a Forced Deal card, you can't steal or swap a card from a complete set."* Card text covers
both ends of a Forced Deal (the card given is never in a complete set when it's yours to give away
— Hasbro has never described giving *from* a complete set either; consensus reads both sides
guarded). Also a_id/938: wilds are treated exactly as standard properties for steal/swap.

**Field:** coopoly-deal guards both cards of a swap and Sly Deal
(`game-engine.ts:512,517,668,674` "Cannot trade/take from a complete set", `:1074` "Cannot steal
from a complete set"). playmdeal: Steal — *"it can't already be part of a completed collection"*
(rules page); Swap's complete-set restriction is **not documented** on their rules page (their copy
says only "Trade one of your color cards for one of theirs"). monopolydealrules action #2/#3 agree
with Hasbro.

**VERDICT: MATCH.** §3.1's 2026-08-06 reversal (TDY guarded on both sides) is the official
position. Minor field note: playmdeal may leave Swap unguarded — undocumented, not our problem.

### 2. CHUD is the ONLY card that takes from a complete set

**Official MD.** MD has exactly one set-breaking card: Deal Breaker, which steals a *whole*
complete set (a_id/926; a_id/928 — house/hotel go with it). No MD card removes a *single* property
from a complete set. CHUD's single-card steal from a complete set has no MD counterpart; it is a
CHUDOPOLY-original card. The structural claim in §3.1 — "one card family breaks sets" — mirrors
MD's shape (2 Deal Breakers in 110) with CHUD + Inspector General standing in for it.

**Field:** coopoly-deal: only Deal Breaker touches complete sets (`:527,544,698,849,872`).
playmdeal: only Takeover (*"Take an opponent's entire completed color collection"*).
monopolydealrules: same (action #3, property #3/#4).

**VERDICT: KNOWN-DIVERGENCE (deliberate variant card, recorded in §3.1).** The guard structure
around it is MATCH.

### 3. Upgrades (House/Hotel): broken set → owner's BANK; payable; movable between complete sets

**Official MD — officially contested; CHUDOPOLY follows one of Hasbro's own two answers.**

- *Bank side (what §1b cites):* Hasbro CS quote *"those houses and hotels have to go into your
  bank"*; the 2008 rulebook prints *"Can also be banked as money"* on House/Hotel; the 2011 FAQ
  recommends banking a Hotel you can't use.
- *Property side:* Hasbro on Twitter (2021-02-03, via monopolyland): *"If a player pays from their
  property collection, the cards must go into the other players property collection"* — monopolyland
  concludes *"you cannot move Houses or Hotels between the Property Collection Area and the Bank.
  Once a House is added to a Property set, it remains as Property throughout the game."* Monopoly
  Wiki: *"If a property set has a House/Hotel on it and the property set is broken up, the
  House/Hotel stays in the property collection, per Hasbro."* monopolydealrules house #8 takes a
  third position: an orphaned house/hotel parks *next to* your property section until a new set
  completes. The BGG thread title says it plainly: *"Hasbro contradiction."*
- *Payable:* monopolyland and coopoly-deal say yes (house/hotel can be paid with); the accepted
  StackExchange answer says no (they are neither bank nor Property cards). Community is split;
  the modern rulebook line §1b quotes ("all cards — except the 2 Wild Property cards — have cash
  value") supports payable.
- *Movable between sets:* Hasbro has not ruled directly; playmdeal allows it (below).

**Field:** coopoly-deal sends orphaned house/hotel to the owner's **bank** — exactly §1b
(`removePropertyFromPlayer`, `game-engine.ts:1552-1561`; also `regroupProperties:1611-1622`
"No valid set, return to bank"); they are payable (`removeCardFromTable:1624+` includes
`set.house`/`set.hotel`); manual moves between sets are NOT supported (`rearrangeProperty:1244`
"Only wildcards can be rearranged") but auto-regroup reseats them. playmdeal: *"+3s and +4s can be
moved freely between your own completed sets — it doesn't cost a turn"* (rules page) — matches
§1b's movable clause; broken-set behaviour undocumented. playmdeal diverges from MD on hotel
ordering (their +4 needs no +3; a_id/927 requires house first — coopoly-deal enforces it via
`requireHouseBeforeHotel`, `:865`).

**VERDICT: MATCH** (with Hasbro's CS/bank reading, which is also what the largest open-source
clone implements) — recorded as owner-ratified in §1b. Noted: Hasbro contradicts itself across
channels, so "the field" is genuinely split; §1b's pick is defensible and documented.
**Doc note (not engine):** §3.7 still says "Upgrades … stay off-limits as payment (matches MD)" —
contradicted by the newer §1b amendment ("upgrades are payable"). Stale line; orchestrator owns
ARCHITECTURE.md.

### 4. Surge Ops (=Double The Rent) stacks (two = ×4) and applies to RENT ONLY

**Official MD — MATCH.** Rulebook card text: *"Play with a standard Rent card to double the
amount."* / *"Needs to be played with a rent card."* a_id/951: two Double The Rent + one rent card
= *"your 3 cards for that turn and quadruples the rent!"* a_id/949: works with ANY rent card,
including the 10-colour one. a_id/948: rent + DTR = 2 of 3 plays. monopolyland (citing the archived
official FAQ): *"You cannot Double the rent on other Action cards such as the Debt Collector card
or the It's My Birthday card."* Rent-only, stacking ×4: official on both counts.

**Field:** coopoly-deal — `executeDoubleTheRent` (`:819-830`) keeps `turn.rentMultiplier *= 2`
("can stack: 1 -> 2 -> 4") and the multiplier is consumed only by rent executions (`:760,797`);
Debt Collector/Birthday never see it. playmdeal: Charge 2x — *"Doubles the very next Charge or
Rainbow Charge you make"* (rent-only; stacking not documented). monopolydealrules rent #2/#5:
each DTR is a play; two in one turn allowed.

**VERDICT: MATCH.** §1c's reversal is the official position, and the engine implements it
(`game.js:1401-1410,1637`; counter cleared at turn end `:2231,2325,2360`).
**Doc note (not engine):** §3 numbered item 3 still says Surge Ops doubles *"rent, Finance Office,
Roll Call, any demand — matching its card text"* — the pre-reversal rule, contradicting §1c and the
engine. Stale line; orchestrator owns ARCHITECTURE.md.

### 5. Wild rent targets ONE chosen player

**Official MD — MATCH.** 2011 FAQ: *"If it's a Rent card with 10 colours on it, charge ONE player
rent on a property in any colour."* a_id/950 same. Rulebook card text: *"Force one player to pay
you rent for properties you own in one of these colours"* (multicolour) vs *"All players pay you
rent"* (2-colour).

**Field:** coopoly-deal `executeRentWild` targets `[targetPlayerId]` (`:797-800`); dual rent
targets all connected opponents (`:752-755`). playmdeal: Rainbow Charge — *"Charge one player"*;
Charge — *"Charge every opponent"*. monopolydealrules rent #1/#4: same.

**VERDICT: MATCH** (the old hit-everyone behaviour was an undocumented buff, as §3.2 says).

### 6. Zero-value wilds must be surrendered when insolvent (§3.4)

**Official MD — the field's "immune" reading is the official one.** Rulebook: the 2 multi-coloured
wilds *"have no monetary value and cannot be used to pay with."* a_id/939: *"You CAN'T use the
10-coloured Property Wild cards to pay other players because they have no monetary value."*
a_id/945 + rulebook: *"If you don't have any properties to pay with, you don't pay at all!"* /
*"If you have no cards in front of you to pay with, you don't pay at all!"* — since rainbow wilds
cannot be paid with, a player holding only rainbow wilds pays nothing and keeps them. So §3.4's
surrender rule genuinely departs from the official text.

**Field:** coopoly-deal confirms §3.4's claim about it exactly: its guards test *value*
(`respondPayWithCards:1009-1013` — empty payment is legal when `totalTableValue(payer) === 0`,
and `totalTableValue:1728-1737` sums `card.value`, making 0-value wilds invisible; the "must pay
more" check at `:1030` likewise uses value). A player can *voluntarily* include a 0-value wild
(`:1018-1024` accepts any on-table card) but is never forced to. monopolydealrules property #5:
*"the Multicolor Property Wildcard is not worth any monetary value so it cannot be use for
payment."* playmdeal: rainbow wild face prints "0" (evidence: `playmdeal-j0-empty.jpg`); payment
rules say "money cards, color cards, or a mix of both" — zero-value case undocumented.
Monopoly Wiki: the multicolour wild *"can only be taken away by Deal Breaker, Sly Deal and Force
Deal"* — i.e. never via payment.

**VERDICT: KNOWN-DIVERGENCE (owner-ratified minority position, recorded 2026-08-07 in §3.4).**
Engine does what §3.4 says (`game.js:1832-1834,1868-1875`: "nothing to pay with" = no *cards*;
short payment legal only when surrendering every card, zero-value wilds included). The official
text and every surveyed implementation vote the other way; the ruling is recorded as deliberate.

### 7. Overstacking ban (§3.5) vs MD's "extras start a second set"

**Official MD.** A colour zone may not exceed set size; extras live as a second (incomplete or
complete) set. 2011 FAQ: *"IF I'M COLLECTING 2 PROPERTY SETS OF THE SAME COLOUR AT ONE TIME…"*
(second sets contemplated) and monopolydealrules property #8: *"The maximum number of cards in
each set has to equal the required number of cards stated on each card… the extra cards must be
used to create a new set."* monopolyland (Hasbro Twitter, 2019-09-09): a 4th card kept on a
complete 3-set *"is considered an extra card and is not safe from a sly deal"* — MD's physical
answer to overstack armour is that extras are simply unprotected, not that they're banned.
a_id/924 supports >3 sets in play generally; a_id/925 supports duplicate colours.

**Citation note:** §3.5's ruling cites "Hasbro FAQ a_id/924" for *"extra properties start a second
set of that colour."* Live a_id/924 is actually *"Is it ok to collect more than 3 property sets at
once?"* (answer: yes) — related but not the second-set rule. The second-set rule's real sources are
the 2011 archived FAQ passage above and monopolydealrules property #8. The *claim* is correct; the
a_id citation is off. Doc-level note only.

**Field:** coopoly-deal creates a new set when the current one reaches `SET_SIZE`
(`addPropertyToPlayer:1463-1486` — fills `s.cards.length < SET_SIZE[color]`, else pushes a new
set; `allowDuplicateSets` default true, `models/types.ts:56`). playmdeal: not documented.
monopolydealrules property #8 as above.

**VERDICT: KNOWN-DIVERGENCE (recorded deliberate, §3.5, with atomic-swap owner ruling
2026-08-07).** MD has no overstacking ban; §3.5 says so itself. No accidental component found.

### 8. Final Approach grace cycle (§3.10) vs MD's "declare on your own turn"

**Official MD — the claimed faithfulness is accurate.** 2008 rulebook: *"You can only reorganize
your property collection on your turn. If you realize you've won during someone else's turn, you
must wait until it's your turn to say it!"* The winner is the first with 3 full sets *down on the
table* on their own turn (monopolydealrules general #4 echoes "and have them down on the table").
So a real off-turn grace window exists in MD and opponents may break a set inside it; §3.10's
"until your next own turn" core is MD-faithful, and its full-cycle checkpoint is a *deliberately
more generous* strictness, as §3.10 itself records.

**Field:** coopoly-deal diverges from MD here — `checkWin` (`:1738-1752`) is instant on any state
change, and it is even called on the *receiver* after a payment resolves
(`respondPayWithCards:1062`), so a player can win off-turn when paid a completing property.
playmdeal: "Complete 3 full color sets before anyone else" — declaration timing undocumented
(reads as instant). monopolydealrules general #4 echoes the rulebook.

**VERDICT: MATCH (core) with recorded deliberate strictness (full-cycle).** CHUDOPOLY is *closer
to official MD* on this edge case than the surveyed game implementations are.

### 9. Stalemate end (§3.6) and 16-reshuffle deck-cycle attrition end (§3.11)

**Official MD.** No counterpart. Rulebook: *"If you've run out of cards, take 5 at the start of
your next turn"*; 2011 FAQ: shuffle the discard into a new draw pile when it runs out; play
continues indefinitely. a_id/61 (6+ players: shuffle two packs) likewise assumes no terminal
state other than 3 sets.

**Field:** coopoly-deal: no stalemate/attrition end found in the engine (only `checkWin` and
resign/last-standing). playmdeal / monopolydealrules: none documented.

**VERDICT: KNOWN-DIVERGENCE (ours, recorded §3.6/§3.11).** As the brief expected: no MD
counterpart exists to match.

### 10. Free wild rearranging on your turn (FAQ 937)

**Official MD — MATCH.** a_id/937: *"Yes, you can move wild cards and Property cards around as
much as you like amongst the sets, but ONLY during your turn. Moving a card that is already on the
table in front of you does not count as [a play]."* a_id/922 same for properties. Hasbro on Twitter
(2021-09-21, via monopolyland): rearranging *"does not count as a move."*

**Field:** coopoly-deal gates `rearrangeProperty` behind `assertCurrentPlayer` (`:1226`) and by
default does not consume a play (`wildcardFlipCountsAsMove: false`, `models/types.ts:57`) — but
restricts rearranging to **wildcards only** (`:1244` "Only wildcards can be rearranged"), a mild
under-implementation of 937 (which covers standard Property cards too). playmdeal: *"Flips are
free… Flip as often as you want — even to break apart a set you already completed."*
monopolydealrules property #6 / general #18: free rearranging on your turn only (their exception:
the receiver of a Forced Deal may place the new card immediately — matches Hasbro's 2020-05-13
tweet).

**VERDICT: MATCH.** §3.8/§3.5's rearrange permission is the official rule; the §3.5 atomic swap
is our addition on top of it (recorded).

---

## Verdict summary

| # | Ruling | Verdict |
|---|---|---|
| 1 | TDY/Requisition guarded from complete sets (both sides) | MATCH |
| 2 | CHUD the only complete-set-taking card | KNOWN-DIVERGENCE (variant card; structure matches) |
| 3 | Upgrades → bank on break, payable, movable | MATCH (one of Hasbro's two self-contradictory answers; §1b recorded) |
| 4 | Surge Ops stacks ×4, rent only | MATCH |
| 5 | Wild rent targets one player | MATCH |
| 6 | Zero-value wilds surrendered when insolvent | KNOWN-DIVERGENCE (owner-ratified minority; official text + all surveyed implementations vote "immune") |
| 7 | Overstacking ban + atomic swap | KNOWN-DIVERGENCE (recorded deliberate; MD starts a second set) |
| 8 | Final Approach grace cycle | MATCH (core faithful; full-cycle strictness recorded) |
| 9 | Stalemate end + deck-cycle attrition end | KNOWN-DIVERGENCE (ours; no MD counterpart, as expected) |
| 10 | Free wild rearranging on your turn | MATCH |

## Suspected accidental divergences

**None found in the rules layer.** Every divergence from official Monopoly Deal located in this
research is already recorded as deliberate in ARCHITECTURE.md §3 (items 2, 6, 7, 9) or matches the
official sources (items 1, 3, 4, 5, 8, 10). Engine spot-checks (`game.js:1401-1410,1464,1480,1581-
1587,1637,1808-1817,1832-1834,1868-1875`) show the shipped code implements the §3 text as amended.

Not a rules divergence, but found while verifying — three **documentation-level** inconsistencies
the orchestrator may want (ARCHITECTURE.md is orchestrator-owned; reported, not edited):

1. §3 numbered item 3 still describes the pre-reversal Surge Ops ("doubles any demand"); §1c and
   the engine say rent-only. Official MD supports §1c (a_id/951 + rulebook card text).
2. §3.7 says upgrades "stay off-limits as payment (matches MD)"; §1b (newer amendment) says
   payable. Official MD is split, but §1b is the ratified position and the engine implements it.
3. §3.5 cites "Hasbro FAQ a_id/924" for the second-set rule; live a_id/924 is the >3-sets answer.
   The second-set rule is real but lives in the 2011 archived FAQ and monopolydealrules property
   #8. Claim correct, citation imprecise.

---

# Addendum — Round 2, 2026-08-08: the win condition, read from the shipped rulebooks

Round 1 above worked from the 2008 sheet, Hasbro's custhelp FAQ and the field. This round went to
the **printed rulebooks Hasbro ships today**, extracted from the PDFs themselves (`pdftotext`),
because the question was the one thing the FAQ pages never restate precisely: *how you normally
win.*

## Sources added this round (all extracted, not summarised)

- **E3113** — the base-game foldout Hasbro's own instruction portal serves today
  (<https://instructions.hasbro.com/en-us/instruction/monopoly-deal-card-game-instructions>,
  `/api/download/E3113_en-us_monopoly-deal-card-game-instructions.pdf`, print © 2017).
- **B0965** — the older leaflet on the main Deal page
  (<https://instructions.hasbro.com/en-us/instruction/monopoly-deal-card-game>, © 2014).
- **G3239 — Monopoly Deal FIFA World Cup 26** (© 2026 Hasbro, print June 2025):
  <https://instructions.hasbro.com/en-us/instruction/monopoly-deal-fifa>
- **G0717 — Monopoly Deal: Harry Potter** (© 2025 Hasbro):
  <https://instructions.hasbro.com/en-us/instruction/monopoly-deal-harry-potter-card-game>
- The 2024 "refresh" edition's two rule changes, secondary only:
  <https://tvtropes.org/pmwiki/pmwiki.php/TabletopGame/MonopolyDeal>

## 11. How you win, and when — CORRECTION to §3.10's faithfulness claim

**Official MD.** 2008 sheet: *"TO WIN, BE THE FIRST PLAYER TO COLLECT 3 FULL PROPERTY SETS OF
DIFFERENT COLORS"*, plus the sentence §3.10 was built on: *"You can only reorganize your property
collection on your turn. If you realize you've won **during someone else's turn**, you must wait
until it's your turn to say it!"* — the wait is **conditional on an off-turn completion**. §3.10
read it as unconditional.

E3113 (2017/18) drops the sentence entirely and prints *"The game ends when one player collects 3
complete Property sets in different colors. That player wins!"* — twice, under OBJECT OF THE GAME
and THE END OF THE GAME. FIFA (2025): *"The game ends when one person has three complete player
sets, each in a different color."* Harry Potter (2025): same, plus the different-colour rule spelled
out — *"you can't win with two red sets and one blue set"* (E3113 says the same of 2 red + 1 blue).

**VERDICT: CORRECTION.** Our `mdFaithful` win rule deferred *every* completion to the armed
player's next own turn, which matches no edition: it is Final Approach with a shorter clock. Fixed
2026-08-08 — own-turn completion wins inline, off-turn completion arms and converts at the next own
turn start. `finalApproach` is recorded as ours, which it always was.

## 12. Wild-only sets — CORRECTION to `pureSetRequired`

**Official MD.** Neither the 2008 sheet nor E3113 addresses it; Hasbro's Twitter (2020-06-22, via
monopolyland) says *"as long as there is at least 1 standard property card."* The 2025 rulebooks
settle it on the card faces, and they do **not** agree with that tweet — they split the two wilds:

- two-colour wild: *"You may make a complete player set using only these cards."*
- every-colour wild: *"You may not make a complete player set using only these cards."*

**VERDICT: CORRECTION.** `pureSetRequired` demanded a real property, outlawing an all-two-colour-wild
set the book explicitly permits. Narrowed to "at least one card that is not a rainbow wild."

## 13. Just Say No costs a play on your own turn — NEW, adopted for MD Faithful

FIFA's RED CARD: *"You may play this card at any time, even if it isn't your turn… If you add this
card to your Bank as points **or play it as an action card**, it counts as one of the three cards
you may play on your turn."* Harry Potter's Protego carries the banking half of the same line. The
2024 base refresh is reported to have introduced it. Adopted as `counterCostsPlay`, ON in
`mdFaithful` only (ARCHITECTURE §3.1d).

## 14. Overstacking — CORRECTION to item 7 above

Item 7 concluded "MD has no overstacking rule at all." The 2025 rulebooks do have one, for wilds:
*"You can't place them in your Bank or use them to exceed the number of magical items in a set of
that color, but you can use them to start a new set"* (G0717; G3239 the same). So §3.5's zone cap is
closer to the source than recorded — it is only the *"extras start a second set"* half that we lack.
No engine change; the record is corrected.

## 15. Zero-value wilds (§3.4) — the divergence is sharper than recorded

E3113: *"All cards—except the 2 Wild Property cards—have cash value and may be used to pay debts."*
FIFA prints it on the card itself: *"You may not use these cards to pay an opponent."* Combined with
*"If you have no money or Property in front of you, nothing happens"*, official MD is unambiguous
that a rainbow wild is never surrendered. §3.4 remains the owner-ratified minority position; it is
now contradicted by card text, not merely by FAQ.

## 16. Expansions — there are none; Hasbro re-cuts the whole game

No expansion pack for Deal exists. What exists is a **2024 "refresh"** of the base game (green box,
new art; reportedly the wild-set and Just Say No changes above), the **licensed re-cuts** — Harry
Potter, FIFA World Cup 26, Fourth Wing, KPop Demon Hunters — and the sibling card games **Monopoly
Bid** (2020) and **Monopoly Millionaire Deal** (2011, same engine, win condition swapped to *first
to $1,000,000*: a real precedent for an alternate win rule).

The mechanic worth stealing is in the licensed cuts: **character cards**. Harry Potter and Fourth
Wing both deal each player one at setup, carrying a permanent asymmetric ability, and Harry Potter
adds a card (Petrificus Totalus) that **disables another player's ability** until they discard 10
points' worth. Nothing in our engine has an equivalent.
