import { touchDriver } from './touch.mjs';

/**
 * tools/lib/drivers.mjs — the "a fixture is a state PLUS a gesture" library.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * Lifted out of screenshot.mjs in P8 because a second gate needs the same
 * surfaces: checkContrast.mjs must measure text on the discard browser, the
 * help sheet and the win recap, and those are CLIENT modes — no recorded server
 * snapshot can encode them. Two tools driving the same moment two different
 * ways is how screenshot and touchtest silently disagreed in round 1.
 *
 * Two kinds of driver:
 *
 *   DRIVERS[name]      a self-contained async function handed to page.evaluate.
 *                      No closures, no imports — it is serialised to the page.
 *   HOST[name]         runs in NODE with the Playwright `page`, for gestures
 *                      that must enter the browser's real input pipeline and
 *                      then be HELD while the frame is captured (`drag-mid`).
 *
 * Every driver returns a STRING describing what it reached. The caller compares
 * it to the shot's `expect` prefix and fails the shot if it does not match — a
 * driver that silently degrades to "whatever the fixture looked like" is the
 * exact round-1 targeting lie (two names, one picture).
 */

/** Set by a host driver that leaves a finger down; lifted by releaseInput. */
let heldTouch = null;

/**
 * Pick a card the pointer can ACTUALLY REACH, and say so when none can be.
 *
 * P8 round 2, found by the feel agent chasing a red `screenshot` run:
 * `HOST.peek` chose `cards[len/2]` — the middle board card in document order —
 * and on `peek-opponent@desktop` that landed on a card which is not hit-testable
 * at the driver's own sample point. `elementFromPoint` there returns
 * `div.propcol`; the card appears nowhere in `elementsFromPoint`. So no
 * `pointerover` ever fired, no peek code ran, and the shot failed `peek:absent`
 * — blaming the peek for a LAYOUT defect. The agent proved it pre-existing by
 * reverting its own `peek.js`/`motion.css` to HEAD and getting the identical
 * failure; the same gesture on a reachable card returns `peek:open 497×402`.
 *
 * A driver that aims at a point without checking what is at that point is not
 * driving the client, it is guessing. This checks: for each candidate, the
 * sample point must hit-test back to the card or something inside it. The
 * middle-of-the-list preference is kept (it is a better picture than the first
 * card), then it walks outward to the nearest reachable one.
 *
 * When NOTHING is reachable the return string names the real defect and its
 * size — `no-reachable-card 8/32 unreachable, first blocked by div.propcol` —
 * because "the peek is broken" and "a third of the board is clipped out of its
 * own scroller" need different people to read them. `touchtest` reports the same
 * root cause from the other side as controls clipped by a scrolling ancestor.
 *
 * Runs inside `page.evaluate`, so it takes the hit-test helper by reference from
 * the page (`audit.installPageHelpers`) rather than importing it — but works
 * without it too, falling back to a plain `elementFromPoint`, because the peek
 * cares about paint order and not about `pointer-events` policy.
 */
export function pickReachableCard(sel, yFrac = 0.3) {
  const cards = [...document.querySelectorAll(sel)].filter((c) => {
    const r = c.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight
      && r.right > 0 && r.left < innerWidth;
  });
  if (!cards.length) return { at: null, reason: 'no-card', total: 0, unreachable: 0 };

  const point = (c) => {
    const r = c.getBoundingClientRect();
    // Upper portion: a fanned card's lower half is covered by its neighbour.
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * yFrac) };
  };
  const reaches = (c, p) => {
    if (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) return null;
    const hit = document.elementFromPoint(p.x, p.y);
    if (!hit) return null;
    return (hit === c || c.contains(hit)) ? true : hit;
  };

  // Middle first, then alternate outwards: same picture as before when the
  // layout is healthy, nearest usable card when it is not.
  const mid = Math.floor(cards.length / 2);
  const order = [mid];
  for (let d = 1; d <= cards.length; d++) {
    if (mid - d >= 0) order.push(mid - d);
    if (mid + d < cards.length) order.push(mid + d);
  }

  let unreachable = 0;
  let firstBlocker = null;
  let chosen = null;
  for (const i of order) {
    const c = cards[i];
    const p = point(c);
    const hit = reaches(c, p);
    if (hit === true) { if (!chosen) chosen = { card: c, at: p }; continue; }
    unreachable++;
    if (!firstBlocker) {
      firstBlocker = hit
        ? `${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''}`
          + `${(hit.getAttribute?.('class') || '').trim() ? '.' + (hit.getAttribute('class') || '').trim().split(/\s+/)[0] : ''}`
        : 'nothing (off-frame)';
    }
  }
  return {
    at: chosen ? chosen.at : null,
    id: chosen ? chosen.card.dataset.cardId : null,
    total: cards.length,
    unreachable,
    firstBlocker,
    reason: chosen ? 'ok' : 'no-reachable-card',
  };
}

/**
 * NODE SIDE. Run `pickReachableCard` in the page.
 *
 * `page.evaluate` serialises a function without its module scope, so the picker
 * is shipped as source and rebuilt once per document. Doing it here rather than
 * through an installer keeps every tool that imports these drivers — screenshot,
 * checkContrast, anything later — working without having to remember a setup
 * call, which is the failure mode this whole file exists to prevent.
 */
const pickCard = (page, sel, yFrac = 0.3) => page.evaluate(
  ([s, yf, src]) => {
    const pick = window.__chudPickCard
      || (window.__chudPickCard = new Function(`return (${src})`)());
    return pick(s, yf);
  },
  [sel, yFrac, pickReachableCard.toString()],
);

/** The one-line explanation a failed pick owes its reader. */
const unreachableMsg = (p, where) => (p.reason === 'no-card'
  ? `peek:no-card (${where})`
  : `peek:no-reachable-card (${where}) — ${p.unreachable}/${p.total} card(s) are not `
    + `hit-testable at their own centre, first blocked by ${p.firstBlocker}; `
    + 'this is a layout/clipping defect, not a peek defect');

export const DRIVERS = {
  /** Tap hand cards until one enters target mode, then stop and hold it. */
  targeting: async () => {
    const hand = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
    for (const card of hand) {
      card.click();
      await new Promise((r) => setTimeout(r, 80));
      const play = document.querySelector('[data-action="play-card"]:not([disabled])');
      if (play) { play.click(); await new Promise((r) => setTimeout(r, 140)); }
      if (window.__CHUD.mode?.kind === 'target') {
        return `target:${window.__CHUD.mode.needs?.[0] || '?'}`;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
    return `stuck:${window.__CHUD.mode?.kind || 'none'}`;
  },

  /** Open payment selection and select cards, so the confirm bar is live. */
  payment: async () => {
    const begin = document.querySelector('[data-action="begin-payment"]');
    if (begin) { begin.click(); await new Promise((r) => setTimeout(r, 180)); }
    const cards = [...document.querySelectorAll('[data-payable="1"], [data-zone="bank"] [data-card-id]')];
    for (const c of cards.slice(0, 3)) { c.click(); await new Promise((r) => setTimeout(r, 60)); }
    return `mode:${window.__CHUD.mode?.kind || 'none'}`;
  },

  /** End turn over the hand limit → discard picker, one card marked. */
  'discard-limit': async () => {
    const et = document.getElementById('btn-end-turn');
    if (et) { et.click(); await new Promise((r) => setTimeout(r, 220)); }
    const cards = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
    if (window.__CHUD.mode?.kind === 'discard' && cards[0]) {
      cards[0].click(); await new Promise((r) => setTimeout(r, 80));
    }
    return `mode:${window.__CHUD.mode?.kind || 'none'}`;
  },

  /**
   * §P8's discard-to-limit READY state, which nothing looked at: the count chip
   * reading n/n, the confirm carrying `.is-ready` rather than `.is-refusing`,
   * and every doomed card struck through (`.card.is-discarding`). The one-tap
   * default ("Cheapest n") is the path most players will take, so it is the
   * path the review set shows.
   */
  'discard-ready': async () => {
    const et = document.getElementById('btn-end-turn');
    if (et) { et.click(); await new Promise((r) => setTimeout(r, 240)); }
    if (window.__CHUD.mode?.kind !== 'discard') return `mode:${window.__CHUD.mode?.kind || 'none'}`;
    const isReady = () => !!document.querySelector('[data-action="confirm-discard"].is-ready');
    const auto = document.querySelector('[data-action="discard-cheapest"]');
    if (auto) { auto.click(); await new Promise((r) => setTimeout(r, 200)); }
    // Fall back to tapping cards if the one-tap default is absent or short.
    // The stop condition is the CONFIRM'S OWN STATE, not a count read off the
    // bridge: `mode.excess` is not part of the §9 contract, and a driver that
    // waits on a field that is always `undefined` never loops and never says so.
    for (let guard = 0; guard < 12 && !isReady(); guard++) {
      const next = [...document.querySelectorAll('#zone-hand [data-card-id]')]
        .find((c) => !c.classList.contains('is-discarding'));
      if (!next) break;
      next.click();
      await new Promise((r) => setTimeout(r, 90));
    }
    const ready = isReady();
    const struck = document.querySelectorAll('.card.is-discarding').length;
    const chip = document.querySelector('#prompt .chip.total')?.textContent?.trim() || '';
    if (!ready) return `notready:struck=${struck} chip="${chip}"`;
    return `ready:${struck} struck, chip "${chip}"`;
  },

  settings: async () => {
    document.querySelector('#hud [data-action="settings"]')?.click();
    await new Promise((r) => setTimeout(r, 320));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  emote: async () => {
    document.getElementById('btn-emote')?.click();
    await new Promise((r) => setTimeout(r, 320));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  side: async () => {
    document.querySelector('#hud [data-action="toggle-side"]')?.click();
    await new Promise((r) => setTimeout(r, 320));
    return document.getElementById('side')?.hidden === false ? 'side:open' : 'side:closed';
  },

  help: async () => {
    document.querySelector('#hud [data-action="help"], [data-action="help"]')?.click();
    await new Promise((r) => setTimeout(r, 360));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  /* ── P8 surfaces that shipped with no shot at all ──────────────────────── */

  /**
   * ui/discard.js turns the centre-table pile into a control. Requested by the
   * UI agent, which had captured this by hand rather than editing tools/.
   */
  discard: async () => {
    document.querySelector('[data-action="open-discard"]')?.click();
    await new Promise((r) => setTimeout(r, 340));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  /** The same sheet, second tab: "What's left" — the deck census. */
  'discard-census': async () => {
    document.querySelector('[data-action="open-discard"]')?.click();
    await new Promise((r) => setTimeout(r, 340));
    document.querySelector('[data-action="discard-panel"][data-panel="left"]')?.click();
    await new Promise((r) => setTimeout(r, 220));
    const open = document.getElementById('sheet')?.hidden === false;
    const on = document.querySelector('[data-action="discard-panel"][data-panel="left"].is-on');
    if (!open) return 'sheet:closed';
    return on ? 'sheet:open census' : 'sheet:open pile-tab-still-selected';
  },

  /**
   * ui/journal.js's full Mission Log. The door lives in the side drawer's head,
   * which is `hidden` until the drawer is open, so the drawer is opened first —
   * a click routed from inside a `hidden` ancestor is not a click a player can
   * make, and a driver that takes one is lying about reachability.
   */
  log: async () => {
    const reachable = () => [...document.querySelectorAll('[data-action="open-log"]')]
      .find((b) => b.getBoundingClientRect().height > 0);
    if (!reachable()) {
      document.querySelector('#hud [data-action="toggle-side"]')?.click();
      await new Promise((r) => setTimeout(r, 320));
    }
    const btn = reachable();
    if (!btn) return 'sheet:closed no-open-log-control';
    btn.click();
    await new Promise((r) => setTimeout(r, 360));
    return document.getElementById('sheet')?.hidden === false ? 'sheet:open' : 'sheet:closed';
  },

  /**
   * §P7.3's out-loud refusal: "NOT disabled. A disabled button is the deadest
   * possible refusal — no shake, no cue, no haptic, no sentence."
   *
   * The transient half (`.is-refused`, a 420ms shake) is deliberately not what
   * this captures — a shot of a 420ms animation is a shot of whenever the
   * shutter happened to fall. The PERSISTENT half is: select a card whose play
   * is blocked and the strip's primary carries `.is-refusing` plus the sentence
   * in its `title`. That state holds until the player does something else, so
   * it is a picture rather than a stopwatch.
   */
  refusal: async () => {
    const hand = [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
    for (const card of hand) {
      card.click();
      await new Promise((r) => setTimeout(r, 120));
      const btn = document.querySelector('[data-action="play-card"].is-refusing, '
        + '[data-action="bank-card"].is-refusing');
      if (btn) return `refusing:${(btn.getAttribute('title') || '').slice(0, 60)}`;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
    return `norefusal:${hand.length} card(s) tried, mode ${window.__CHUD.mode?.kind || 'none'}`;
  },

  /**
   * The win overlay's §P8 "HOW IT WENT" recap. It sits below the fold of a
   * capped `.win-box` at five players, so it is scrolled into view — the review
   * set exists to show the thing, not to prove it is in the DOM.
   */
  'win-recap': async () => {
    const overlay = document.getElementById('win-overlay');
    if (!overlay || overlay.hidden) return 'recap:no-win-overlay';
    const box = overlay.querySelector('.jr-recap');
    if (!box) return 'recap:absent';
    box.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 240));
    const beats = box.querySelectorAll('.jr-list.is-recap > *').length;
    const r = box.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight) return `recap:offscreen ${beats}`;
    return `recap:${beats} beat${beats === 1 ? '' : 's'}`;
  },

  /* ── P9 surfaces: reachable in ordinary play, visited by no gate ───────── */

  /**
   * THE HOST LOBBY. `#lobby-host` — the room code, the invite line, the bot
   * picker, the ruleset toggles — plus `#btn-start`.
   *
   * This is not a driver so much as a REFUSAL TO BE LIED TO. Nothing has to be
   * tapped to reach the host lobby: the state is the state. What was missing is
   * that `store.self.id` was never set from a lobby broadcast (no `game`, and
   * `game` is the only thing store.applyState infers a seat from), so
   * `store.room.hostId === store.self.id` was false and every `lobby@*.png` on
   * disk was the GUEST view of a transcript recorded by the HOST.
   * lib/stage.mjs now hands the client its seat first; this asserts the seat
   * arrived, because a shot that silently degrades to the other player's screen
   * is precisely the "two names, one picture" failure screenshot.mjs exists for.
   */
  'lobby-host': async () => {
    const host = document.getElementById('lobby-host');
    const start = document.getElementById('btn-start');
    const seen = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
    if (!seen(host)) return `lobby:not-host (selfId ${window.__CHUD.selfId || 'null'})`;
    const kicks = document.querySelectorAll('#lobby-players [data-action="remove-bot"], '
      + '#lobby-players [data-action="kick"]').length;
    const r = start?.getBoundingClientRect();
    // The CTA's position relative to the fold is the finding this surface was
    // built for — report it in the reached string so a green run still carries
    // the number, not just a pass.
    const fold = r ? Math.round(r.bottom - innerHeight) : null;
    return `lobby:host ${document.querySelectorAll('.lobby-row').length} seat(s), ${kicks} seat control(s), `
      + `start ${seen(start) ? `${Math.round(r.width)}×${Math.round(r.height)}` : 'HIDDEN'}`
      + `${fold != null && fold > 0 ? `, ${fold}px BELOW THE FOLD` : ''}`;
  },

  /** The same room from a second human seat: host block gone, ruleset read-only. */
  'lobby-guest': async () => {
    const seen = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
    if (seen(document.getElementById('lobby-host'))) {
      return `lobby:host-block-visible-to-guest (selfId ${window.__CHUD.selfId || 'null'})`;
    }
    const note = seen(document.getElementById('ruleset-guest'));
    const controls = document.querySelectorAll('#lobby-players [data-action]').length;
    if (controls) return `lobby:guest-has-${controls}-seat-control(s)`;
    return `lobby:guest ${document.querySelectorAll('.lobby-row').length} seat(s), read-only ruleset ${note ? 'shown' : 'MISSING'}`;
  },

  /**
   * THE `myColor` STEP — the wild's placement question, answered on the mats.
   *
   * §3.8/§3.9's decision aid (`.mat-advice`, interact/index.js paintAdvice) is
   * printed onto every legal column: the rent ladder, the landing rung, which
   * column is BEST. It shipped measured only by the agent that wrote it —
   * `drivers.mjs` had no entry for the step and `checkContrast` had no surface,
   * so the one piece of rules text the game prints ON the table was outside
   * every gate.
   *
   * Reached the way a player reaches it: tap a wild in hand, press Play. The
   * client refuses to ask a question with one answer (playSelected's
   * single-colour short circuit), so the assertion is on the step AND on the
   * chits — a `myColor` step with no advice painted is the defect.
   */
  'wild-place': async () => {
    const hand = () => [...document.querySelectorAll('#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]')];
    for (const card of hand()) {
      card.click();
      await new Promise((r) => setTimeout(r, 100));
      const play = document.querySelector('[data-action="play-card"]:not([disabled]):not(.is-refusing)');
      if (play) { play.click(); await new Promise((r) => setTimeout(r, 220)); }
      const mode = window.__CHUD.mode;
      if (mode?.kind === 'target' && mode.needs?.[0] === 'myColor') {
        const chits = document.querySelectorAll('.mat-advice').length;
        // `[data-best="1"]`, which is what interact.css actually selects on —
        // an `.is-best` class read reported 0 while the chit was marking one.
        const best = document.querySelectorAll('.mat-advice [data-best="1"], .mat-advice[data-best="1"]').length;
        // `data-targetable`, not `data-droppable`: interact/index.js mark()
        // sets the first for a TAP step and drag.js sets the second only while
        // a pointer is down, so counting droppables during a myColor step
        // reported "0 mat(s), 8 advice chit(s)" — eight answers printed onto
        // nothing.
        const mats = document.querySelectorAll('.propcol[data-targetable="1"]').length;
        if (!chits) return `myColor:no-advice ${mats} mat(s) marked but nothing printed on them`;
        return `myColor:${mats} mat(s), ${chits} advice chit(s), ${best} marked best`;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 70));
    }
    /* Distinct fixture-diagnosis wording, not the bare 'mode idle' that read
     * like a client regression: reaching this line means no card in the
     * staged hand produced a myColor step, which is the FIXTURE lacking a
     * playable wild (record.mjs refused exactly that pick after the
     * seat-shuffle re-record shipped one) — or, rarer, every wild in it
     * having a single legal landing (playSelected's one-answer short
     * circuit). Either way the thing to fix is the fixture, not the mats. */
    return `nowild:${hand().length} card(s) tried and none reached a myColor step `
      + `(mode ${window.__CHUD.mode?.kind || 'none'}) — the staged fixture's hand holds no playable wild_property; `
      + 're-record mid-game';
  },

  /**
   * `#toast` — the client's only transient message surface, and one no shot had
   * ever driven, so nothing had measured its contrast, its geometry or what it
   * covers.
   *
   * Reached by the shortest real path there is: type a room code for a room
   * that is not there and press Join. The server answers `Room not found`,
   * main.js classes that as a dead session and ui/screens.js `endSession`
   * toasts "That room is gone. Starting fresh." — fixed wording, no timing, no
   * live game. `ZZZZ` satisfies home.js's own `[A-HJ-NP-Z2-9]{4}` format check,
   * so the request actually leaves the client instead of stopping at the inline
   * error (which is a different surface and not this one).
   */
  toast: async () => {
    const name = document.getElementById('name-input');
    if (name && !name.value) name.value = 'HARNESS';
    const code = document.getElementById('code-input');
    if (!code) return 'toast:no-code-input';
    code.value = 'ZZZZ';
    document.getElementById('btn-join-room')?.click();
    // The server round trip is real; poll rather than guess at its latency.
    for (let i = 0; i < 40; i++) {
      const el = document.getElementById('toast');
      if (el && el.classList.contains('is-on') && (el.textContent || '').trim()) {
        const r = el.getBoundingClientRect();
        return `toast:"${el.textContent.trim().slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return `toast:absent (screen ${document.querySelector('.screen:not([hidden])')?.id || '?'})`;
  },

  /**
   * THE FLIGHT LOG (ui/stats.js), opened the way a player opens it: the second
   * reading mark on the home rail.
   *
   * IT DOES NOT SEED THE LOGBOOK, and that separation is the point. The record
   * arrives in `localStorage` before the document runs, from
   * `lib/logbook.mjs installLogbooks` off a `?logbook=<case>` parameter, because
   * `pristineStorage` clears storage at document start on EVERY navigation — a
   * driver that wrote the key and reloaded would watch it be wiped. So this
   * driver only presses the control and reports what it found.
   *
   * The reported string carries the population, because the whole design of
   * this panel is population-dependent: the mark is not on the rail at zero
   * flights, band 3 is suppressed below eight, and a `stats.status` with
   * something to say puts a note above everything. A shot that silently
   * degraded to "whatever the default logbook looked like" would be the round-1
   * targeting lie with a different subject.
   */
  'flight-log': async () => {
    const mark = document.getElementById('btn-flight-log');
    if (!mark) return 'flightlog:no-mark';
    if (mark.hidden || !mark.getBoundingClientRect().height) {
      // The DELIBERATE state at zero flights, and a legitimate answer — but it
      // is never what a shot of the panel wants, so it is reported as its own
      // outcome rather than as a generic failure.
      return 'flightlog:mark-hidden (zero flights, entry point withheld by design)';
    }
    mark.click();
    await new Promise((r) => setTimeout(r, 340));
    const sheet = document.getElementById('sheet');
    if (!sheet || sheet.hidden) return 'flightlog:sheet-closed';
    const panel = sheet.querySelector('.fl');
    if (!panel) return 'flightlog:sheet-open-but-empty';
    const rate = panel.querySelector('.fl-rate')?.textContent?.trim() || '';
    const den = panel.querySelector('.fl-rate-den')?.textContent?.trim() || '';
    const cells = panel.querySelectorAll('.fl-cell').length;
    const texture = !!panel.querySelector('.fl-band-texture');
    const locked = panel.querySelector('.fl-locked')?.textContent?.trim() || '';
    const note = panel.querySelector('.fl-note') ? 'note ' : '';
    const marks = panel.querySelectorAll('.fl-mark').length;
    if (!rate && !locked && !panel.querySelector('.fl-empty')) {
      return `flightlog:no-bands ${cells} cell(s)`;
    }
    return `flightlog:open ${note}${rate ? `${rate} "${den}"` : 'empty'} `
      + `${cells} cell(s), ${texture ? `texture+${marks} form mark(s)` : 'texture suppressed'}`
      + `${locked ? ` — "${locked.slice(0, 44)}"` : ''}`;
  },

  /**
   * The same panel with the segment toggle moved off All. The default is All
   * and MUST be — every recorded game in this project's logs has exactly one
   * human seat, so a human-only default opens on an empty panel — which is
   * precisely why the empty-segment path needs a gate of its own: it is the
   * state a player reaches on their second tap and the one nobody would have
   * screenshotted.
   */
  'flight-log-people': async () => {
    const mark = document.getElementById('btn-flight-log');
    if (!mark || mark.hidden) return 'flightlog:mark-hidden';
    mark.click();
    await new Promise((r) => setTimeout(r, 340));
    const seg = document.querySelector('.fl-seg input[value="people"]');
    if (!seg) return 'flightlog:no-scope-toggle';
    seg.click();
    await new Promise((r) => setTimeout(r, 200));
    const panel = document.querySelector('#sheet .fl');
    if (!panel) return 'flightlog:sheet-closed';
    const checked = document.querySelector('.fl-seg input:checked')?.value || '?';
    const empty = panel.querySelector('.fl-locked')?.textContent?.trim() || '';
    const rate = panel.querySelector('.fl-rate')?.textContent?.trim() || '';
    return `flightlog:scope=${checked} ${rate ? `rate ${rate}` : `empty — "${empty.slice(0, 52)}"`}`;
  },

  /**
   * `.announce` — ui/journal.js's full-width banner ("FINAL APPROACH", "BREAK
   * THEM NOW", "SET SEIZED"). It is not in any snapshot: it is what the client
   * DOES when an event arrives, so it can only be reached by making the event
   * arrive (lib/stage.mjs `from`, which applies the previous broadcast first
   * and lets the tail between the two replay).
   *
   * Nothing had photographed it, and it was found covering collapsed opponent
   * seats 51% and 42% in portrait and 70% in landscape. Note this driver does
   * NOT create the banner — the state transition does. It reports what is
   * there, so "the announcement did not fire" and "the announcement fired and
   * is fine" cannot be confused.
   */
  announce: async () => {
    const el = document.querySelector('.announce');
    if (!el || el.hidden) return 'announce:absent';
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 'announce:zero-size';
    const flag = el.querySelector('.announce-flag')?.textContent?.trim() || '';
    const kind = [...el.classList].find((c) => c.startsWith('is-') && c !== 'is-in') || '?';
    return `announce:${kind} "${flag}" ${Math.round(r.width)}×${Math.round(r.height)} at y${Math.round(r.top)}`;
  },

  /* ── P10 surfaces: the 20 markers tools/coverage.mjs reported unvisited ── */

  /**
   * THE ANSWER CLOCK NEAR EXPIRY — `#hud-timer` shown, `.is-urgent` (≤10s) and
   * `.is-critical` (≤5s) both on. No shot had ever seen ANY of the three,
   * because every recorded `turnTimer.startedAt` is hours stale by capture
   * time and ui/hud.js correctly hides a clock at 0 left. The stage rebases
   * the clock (stage.mjs `timer`); this driver does not touch it — it WAITS
   * for the client's own tick to cross into critical and reports what the ring
   * says, so the shot cannot fire before the state it is about exists.
   */
  'timer-critical': async () => {
    for (let i = 0; i < 50; i++) {
      const box = document.getElementById('hud-timer');
      if (box && !box.hidden && box.getBoundingClientRect().height > 0
        && box.classList.contains('is-critical')) {
        const text = (box.textContent || '').trim();
        return `timer:critical "${text}" urgent=${box.classList.contains('is-urgent')}`;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    const box = document.getElementById('hud-timer');
    if (!box || box.hidden || !box.getBoundingClientRect().height) {
      return 'stuck:timer-hidden (no served clock reached the ring — was the fixture staged with a rebased timer?)';
    }
    return `stuck:never-critical "${(box.textContent || '').trim()}" class="${box.className}"`;
  },

  /**
   * `[data-theme="dark"]` — the settings sheet's explicit theme override, the
   * one selection path (variables.css:292) neither the review set nor
   * checkContrast ever drove: the harness writes `light` as its override probe
   * and the media query supplies dark, so the dark ATTRIBUTE was written by
   * nobody. Reached the way a player reaches it: the radio in settings.
   */
  'settings-dark': async () => {
    document.querySelector('#hud [data-action="settings"]')?.click();
    await new Promise((r) => setTimeout(r, 320));
    if (document.getElementById('sheet')?.hidden !== false) return 'theme:sheet-closed';
    const radio = document.querySelector('input[name="chud-theme"][value="dark"]');
    if (!radio) return 'theme:no-dark-radio';
    radio.click();
    await new Promise((r) => setTimeout(r, 160));
    const attr = document.documentElement.getAttribute('data-theme');
    return attr === 'dark' ? 'theme:dark (attribute set by the settings radio)' : `theme:attr="${attr || ''}"`;
  },

  /**
   * `[data-stock="custom"]` — the host lobby's deck-total chip once the deck
   * editor has moved off the stock 106. Reached by a real host action: open
   * the advanced ruleset and take one enabled stepper up a step. Local-only
   * (lobby.js onDeckStep updates `pending` and repaints; nothing needs a live
   * socket, and socket.js queues silently before first open).
   */
  'lobby-custom': async () => {
    const adv = document.querySelector('details.ruleset-adv');
    if (!adv) return 'stock:no-advanced-ruleset (guest lobby?)';
    if (!adv.open) {
      adv.querySelector('summary')?.click();
      await new Promise((r) => setTimeout(r, 240));
    }
    const inc = [...document.querySelectorAll('.deck-step[data-delta="1"]')].find((b) => !b.disabled);
    if (!inc) return 'stock:no-enabled-stepper';
    inc.click();
    await new Promise((r) => setTimeout(r, 200));
    const total = document.getElementById('deck-total');
    if (!total || !total.getBoundingClientRect().height) return 'stock:total-chip-hidden';
    // Into the frame, not merely into the DOM: the editor sits below the fold
    // of the rules column, and a census sample of an off-screen chip would be
    // the "in the DOM is not on the screen" claim coverage exists to refuse.
    total.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 220));
    const r = total.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return 'stock:total-chip-offscreen';
    return `stock:${total.getAttribute('data-stock')} "${(total.textContent || '').trim()}"`;
  },

  /**
   * THE SET STEAL — Inspector General's `theirSet` step, which no gate had
   * ever entered (the `targeting` fixture's foes hold zero complete sets, so
   * IG there is the REFUSAL, not the steal). Fixture `steal-set` guarantees a
   * victim; this walks the player's own two taps: victim seat, then the set.
   * The shot is taken ON the theirSet step with the victim's sets marked.
   */
  'steal-set': async () => {
    const B = window.__CHUD;
    const me = B.snapshot?.players?.find((p) => p.id === B.selfId);
    const ig = (me?.hand || []).find((c) => c.action === 'inspector_general');
    if (!ig) return 'stuck:no-inspector-general-in-hand';
    document.querySelector(`#zone-hand [data-card-id="${ig.id}"], [data-zone="hand"] [data-card-id="${ig.id}"]`)?.click();
    await new Promise((r) => setTimeout(r, 120));
    document.querySelector('[data-action="play-card"]:not([disabled])')?.click();
    await new Promise((r) => setTimeout(r, 220));
    if (B.mode?.kind !== 'target') return `stuck:mode-${B.mode?.kind || 'none'}`;
    if (B.mode.needs?.[0] === 'player') {
      const seat = document.querySelector('[data-targetable="1"]');
      if (!seat) return 'stuck:player-step-with-no-targetable-seat';
      seat.click();
      await new Promise((r) => setTimeout(r, 220));
    }
    if (B.mode?.needs?.[0] !== 'theirSet') {
      return `stuck:step-${B.mode?.needs?.[0] || 'none'} (mode ${B.mode?.kind})`;
    }
    const sets = document.querySelectorAll('.propcol[data-targetable="1"]').length;
    if (!sets) return 'stuck:theirSet-step-reached-but-no-set-marked';
    return `theirSet:${sets} set(s) targetable — "${B.mode.hint || ''}"`;
  },

  /**
   * THE UPGRADE PLACEMENT — `mySet`, the other targeting step nothing had
   * entered. Fixture `upgrade-set` holds an Upgrade over a complete,
   * un-upgraded set; the step marks the player's own qualifying columns.
   */
  'upgrade-set': async () => {
    const B = window.__CHUD;
    const me = B.snapshot?.players?.find((p) => p.id === B.selfId);
    const up = (me?.hand || []).find((c) => c.action === 'upgrade' || c.action === 'foc');
    if (!up) return 'stuck:no-upgrade-in-hand';
    document.querySelector(`#zone-hand [data-card-id="${up.id}"], [data-zone="hand"] [data-card-id="${up.id}"]`)?.click();
    await new Promise((r) => setTimeout(r, 120));
    document.querySelector('[data-action="play-card"]:not([disabled]):not(.is-refusing)')?.click();
    await new Promise((r) => setTimeout(r, 220));
    if (B.mode?.kind !== 'target' || B.mode.needs?.[0] !== 'mySet') {
      return `stuck:mode-${B.mode?.kind || 'none'} step-${B.mode?.needs?.[0] || 'none'}`;
    }
    const sets = document.querySelectorAll('.propcol[data-targetable="1"]').length;
    if (!sets) return 'stuck:mySet-step-reached-but-no-set-marked';
    return `mySet:${sets} set(s) targetable — "${B.mode.hint || ''}"`;
  },

  /**
   * `.prompt-why.is-approach` — the FINAL APPROACH payment warning
   * (prompt.js approachWarning: "paying with a card out of a complete set ends
   * it"), which only exists when the ARMED seat is the one being charged. No
   * recorded transcript ever held that state (the recording seat arms and
   * wins); fixture `approach-pay` is built through engine calls. Nothing to
   * drive — the respond prompt paints it on its own — so this only VERIFIES,
   * because a shot that silently degraded to an ordinary payment prompt would
   * be the round-1 targeting lie again.
   */
  'approach-warning': async () => {
    for (let i = 0; i < 10; i++) {
      const el = document.querySelector('.prompt-why.is-approach');
      if (el && el.getBoundingClientRect().height > 0) {
        return `approach:"${(el.textContent || '').trim().slice(0, 56)}"`;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    const me = window.__CHUD.snapshot?.players?.find((p) => p.id === window.__CHUD.selfId);
    return `approach:absent (finalApproach=${!!me?.finalApproach}, pending=${window.__CHUD.snapshot?.pendingAction?.type || 'none'})`;
  },

  /**
   * `.is-decider` — the win screen's "decided on points" emphasis
   * (overlays.js boardRow, only under endReason 'stalemate'). Every recorded
   * game ends on sets, so the attrition ending had no shot; fixture
   * `win-points` reaches it through the engine's own endgame path.
   */
  'win-decider': async () => {
    for (let i = 0; i < 30; i++) {
      const overlay = document.getElementById('win-overlay');
      if (overlay && !overlay.hidden) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const overlay = document.getElementById('win-overlay');
    if (!overlay || overlay.hidden) return 'stuck:no-win-overlay';
    const marks = overlay.querySelectorAll('.win-sets.is-decider, .win-worth.is-decider').length;
    const tag = (overlay.querySelector('.win-tag')?.textContent || '').trim();
    if (!marks) return `stuck:no-decider-mark (tag "${tag}")`;
    return `decider:${marks} mark(s), tag "${tag}"`;
  },

  /**
   * The Mission Brief's inner pages. The `help` shot photographs the DEFAULT
   * page (Goal) and nothing had ever turned to the others, so `.brief-card`
   * kinds (is-chud/is-rent), the OPSEC flags (is-block), the rent ladder's
   * `.rung.is-full` and the chain beats (is-defend/is-result) were all styled,
   * reachable and unvisited. One driver, page by name, verifying the tab took.
   */
  /* Serialised one at a time by page.evaluate (no module scope survives), so
   * each page driver carries the same ~12 lines rather than sharing a helper —
   * the price this file already pays everywhere, stated once here. */
  'help-cards': async () => {
    document.querySelector('#hud [data-action="help"], [data-action="help"]')?.click();
    await new Promise((r) => setTimeout(r, 360));
    if (document.getElementById('sheet')?.hidden !== false) return 'brief:sheet-closed';
    const tab = document.querySelector('[data-action="help-page"][data-page="cards"]');
    if (!tab) return 'brief:no-cards-tab';
    tab.click();
    await new Promise((r) => setTimeout(r, 260));
    const on = document.querySelector('.brief-tab.is-on')?.dataset.page;
    if (on !== 'cards') return `brief:tab-still-${on}`;
    const vis = (sel) => [...document.querySelectorAll(sel)]
      .filter((e) => e.getBoundingClientRect().height > 0).length;
    const kinds = vis('.brief-card.is-chud, .brief-card.is-rent');
    const flags = vis('.brief-card-flag.is-block');
    if (!kinds || !flags) return `stuck:cards open but kinds=${kinds} block-flags=${flags}`;
    return `brief:cards ${kinds} kind-marked card(s), ${flags} OPSEC block flag(s)`;
  },
  'help-sets': async () => {
    document.querySelector('#hud [data-action="help"], [data-action="help"]')?.click();
    await new Promise((r) => setTimeout(r, 360));
    if (document.getElementById('sheet')?.hidden !== false) return 'brief:sheet-closed';
    const tab = document.querySelector('[data-action="help-page"][data-page="sets"]');
    if (!tab) return 'brief:no-sets-tab';
    tab.click();
    await new Promise((r) => setTimeout(r, 260));
    const on = document.querySelector('.brief-tab.is-on')?.dataset.page;
    if (on !== 'sets') return `brief:tab-still-${on}`;
    const n = [...document.querySelectorAll('.rung.is-full')]
      .filter((e) => e.getBoundingClientRect().height > 0).length;
    if (!n) return 'stuck:sets open but 0 full rungs visible';
    return `brief:sets ${n} full rung(s)`;
  },
  'help-opsec': async () => {
    document.querySelector('#hud [data-action="help"], [data-action="help"]')?.click();
    await new Promise((r) => setTimeout(r, 360));
    if (document.getElementById('sheet')?.hidden !== false) return 'brief:sheet-closed';
    const tab = document.querySelector('[data-action="help-page"][data-page="opsec"]');
    if (!tab) return 'brief:no-opsec-tab';
    tab.click();
    await new Promise((r) => setTimeout(r, 260));
    const on = document.querySelector('.brief-tab.is-on')?.dataset.page;
    if (on !== 'opsec') return `brief:tab-still-${on}`;
    const vis = (sel) => [...document.querySelectorAll(sel)]
      .filter((e) => e.getBoundingClientRect().height > 0).length;
    const defend = vis('.op-beat.is-defend');
    const result = vis('.op-beat.is-result');
    if (!defend || !result) return `stuck:opsec open but defend=${defend} result=${result}`;
    return `brief:opsec ${defend} defend beat(s), ${result} result beat(s)`;
  },

  /**
   * `.chip.total.is-over` — the discard picker refusing an OVER-pick. The
   * `discard-ready` shot shows n/n; nothing showed n+1/n, which is the state
   * whose whole job is to be visually unmistakable (content.css hazard fill).
   * Reached by one more tap than ready needs.
   */
  'discard-over': async () => {
    const et = document.getElementById('btn-end-turn');
    if (et) { et.click(); await new Promise((r) => setTimeout(r, 240)); }
    if (window.__CHUD.mode?.kind !== 'discard') return `over:mode-${window.__CHUD.mode?.kind || 'none'}`;
    const isOver = () => !!document.querySelector('.chip.total.is-over');
    for (let guard = 0; guard < 14 && !isOver(); guard++) {
      const next = [...document.querySelectorAll('#zone-hand [data-card-id]')]
        .find((c) => !c.classList.contains('is-discarding'));
      if (!next) break;
      next.click();
      await new Promise((r) => setTimeout(r, 90));
    }
    if (!isOver()) return `over:never (struck ${document.querySelectorAll('.card.is-discarding').length})`;
    const chip = document.querySelector('.chip.total.is-over');
    return `over:"${(chip.textContent || '').trim()}" refusing=${!!document.querySelector('[data-action="confirm-discard"].is-refusing')}`;
  },

  /**
   * `.dv-card.is-reading` — the discard browser's inline reader, the tap that
   * turns a pile row into a readable card. The `discard-browser` shot shows
   * the grid; nobody had ever tapped a row.
   */
  'discard-reading': async () => {
    document.querySelector('[data-action="open-discard"]')?.click();
    await new Promise((r) => setTimeout(r, 340));
    if (document.getElementById('sheet')?.hidden !== false) return 'reading:sheet-closed';
    const row = document.querySelector('[data-action="discard-read"]');
    if (!row) return 'reading:no-readable-row (empty pile?)';
    row.click();
    await new Promise((r) => setTimeout(r, 260));
    const open = document.querySelector('.dv-card.is-reading');
    if (!open || !open.getBoundingClientRect().height) return 'reading:tapped-but-nothing-marked';
    const name = (open.querySelector('.dv-name')?.textContent || '').trim();
    return `reading:"${name || '?'}"`;
  },
};

/* ────────────────────────── host-side (real input) ─────────────────────── */

/**
 * ART §5's six drop affordances, all of which only exist DURING a drag:
 * legal mats ringed, illegal mats desaturated, the landing ghost in the hovered
 * column, the hand retracted. Nothing in the review set had ever seen them,
 * because a screenshot is taken between gestures and a drag is the gesture.
 *
 * So this one starts a real drag through the browser's input pipeline
 * (`page.mouse`, i.e. CDP `Input.dispatchMouseEvent` — pointer events created in
 * page script never consult `touch-action`, see lib/touch.mjs) and DOES NOT
 * RELEASE. The caller screenshots while the button is still down.
 *
 * It asserts on the interaction layer's own state — `.is-held`,
 * `body.is-dragging-card`, `[data-droppable]`, `.drop-ghost` — never on
 * elapsed time. interact/pointer.js takes a drag at 8px of travel
 * (pointer.js:36 SLOP); the path below crosses that in the first two moves and
 * then walks to whatever the client itself marked droppable, so the shot cannot
 * drift out of agreement with the client's own rules.
 */
export const HOST = {
  /**
   * ART §8's peek — "reading a card costs zero taps". It only exists while the
   * pointer is over a card (hover open 140ms, close delay 160ms), so like
   * `drag-mid` it must be held open across the shutter and cannot be reached
   * from page script.
   *
   * `where: 'hand' | 'board'` picks which card is read; the board case is the
   * one that proves the peek works on cards you do not own.
   */
  peek: async (page, where = 'hand') => {
    const sel = where === 'board'
      ? '#opponents [data-card-id], #self-board [data-card-id]'
      : '#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]';
    // Verified target: see pickReachableCard. Aiming at the middle card in
    // document order sent `peek-opponent@desktop` at a card behind `.propcol`
    // and reported `peek:absent` — the peek was fine, the layout was not.
    const pick = await pickCard(page, sel, 0.3);
    if (!pick.at) return unreachableMsg(pick, where);
    const at = pick.at;
    await page.mouse.move(at.x - 30, at.y + 40);
    await page.mouse.move(at.x, at.y);
    await page.mouse.move(at.x + 1, at.y);
    // 140ms hover-open + a frame to paint. Asserted on `.peek`, not on this.
    await page.waitForTimeout(420);
    return page.evaluate(() => {
      const p = document.querySelector('.peek');
      if (!p) return 'peek:absent';
      /* `.peek-name` no longer exists: ui/peek.js defaults `faceRenderer` to the
       * cardart face, which prints `.ca-title` instead, so this read had been
       * returning '' and the reached string said `peek:open ""` while the gate
       * passed on the prefix. Found by the surface census (tools/coverage.mjs)
       * reporting `.is-peek` as never visited. */
      const name = (p.querySelector('.peek-name, .ca-title')?.textContent || '').trim();
      const r = p.getBoundingClientRect();
      if (!r.width || !r.height) return 'peek:zero-size';
      return `peek:open "${name}" ${Math.round(r.width)}×${Math.round(r.height)}`;
    });
  },

  'peek-board': (page) => HOST.peek(page, 'board'),

  /**
   * The same peek, on a phone, where it is a 300ms TOUCH HOLD and not a hover
   * (ART §8: "Touch hold 300ms … a peek is free and dismisses on release", and
   * content.css gates the hover path behind `@media (hover:hover)`). Measured:
   * driving it with `page.mouse` on a mobile context returns `peek:absent`,
   * which is the correct answer to the wrong gesture.
   *
   * Real touch, through CDP, for the reason lib/touch.mjs documents at length:
   * pointer events synthesised in page script never enter the input pipeline.
   * The finger stays DOWN — the peek dismisses on release — so `releaseInput`
   * lifts it after the shutter.
   */
  'peek-hold': async (page) => {
    const pick = await pickCard(
      page, '#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]', 0.3,
    );
    if (!pick.at) return unreachableMsg(pick, 'hand');
    const at = pick.at;
    const cdp = await page.context().newCDPSession(page);
    const { rawTouch, touchPoint } = touchDriver(cdp);
    await rawTouch('touchStart', [touchPoint(at.x, at.y)]);
    heldTouch = rawTouch;
    await page.waitForTimeout(560);           // 300ms hold + open + paint
    return page.evaluate(() => {
      const p = document.querySelector('.peek');
      if (!p) return 'peek:absent';
      /* `.peek-name` no longer exists: ui/peek.js defaults `faceRenderer` to the
       * cardart face, which prints `.ca-title` instead, so this read had been
       * returning '' and the reached string said `peek:open ""` while the gate
       * passed on the prefix. Found by the surface census (tools/coverage.mjs)
       * reporting `.is-peek` as never visited. */
      const name = (p.querySelector('.peek-name, .ca-title')?.textContent || '').trim();
      const r = p.getBoundingClientRect();
      if (!r.width || !r.height) return 'peek:zero-size';
      return `peek:open "${name}" ${Math.round(r.width)}×${Math.round(r.height)}`;
    });
  },

  'drag-mid': async (page) => {
    // Same verified pick as the peek: a drag that starts on a point the pointer
    // cannot reach produces no `pointerdown` and blames the drag engine.
    const pick = await pickCard(
      page, '#zone-hand [data-card-id], [data-zone="hand"] [data-card-id]', 0.5,
    );
    if (!pick.at) {
      return pick.reason === 'no-card' ? 'drag:no-hand-card'
        : `drag:no-reachable-card — ${pick.unreachable}/${pick.total} hand card(s) are not `
          + `hit-testable at their own centre, first blocked by ${pick.firstBlocker}`;
    }
    const from = { ...pick.at, id: pick.id };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Past SLOP (8px) in two steps, then a slow lift so the follow loop has
    // real velocity to lean the card with (ART §4 drag tilt).
    for (const dy of [6, 14, 34, 64]) {
      await page.mouse.move(from.x + 4, from.y - dy);
      await page.waitForTimeout(24);
    }

    // interact/drag.js only draws the landing silhouette over a RANK-0 target
    // (drag.js placeGhost: "a ghost inside #table would be a dashed card in the
    // middle of the felt promising a place the card is not going"). Rank is not
    // in the DOM, so the driver walks the precise targets — `.propcol` first —
    // until the client itself draws the ghost. Measured: aiming at the first
    // `[data-droppable="1"]` in document order got a ghost on the phone and not
    // on the desktop, where the first match is the wider region.
    const candidates = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[data-droppable="1"]')];
      const rank = (e) => (e.classList.contains('propcol') ? 0 : e.matches('.cardzone, [data-zone]') ? 1 : 2);
      return els
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 8 && r.height > 8)
        .sort((a, b) => rank(a.e) - rank(b.e))
        .slice(0, 4)
        .map(({ r }) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
    });

    let cursor = { x: from.x + 4, y: from.y - 64 };
    for (const target of candidates) {
      // Walk in, don't teleport: the hover/ghost state is driven by moves.
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(
          cursor.x + ((target.x - cursor.x) * i) / 6,
          cursor.y + ((target.y - cursor.y) * i) / 6,
        );
        await page.waitForTimeout(20);
      }
      await page.mouse.move(target.x, target.y);
      await page.waitForTimeout(110);
      cursor = target;
      if (await page.evaluate(() => !!document.querySelector('.drop-ghost'))) break;
    }

    return page.evaluate(() => {
      const held = document.querySelectorAll('.card.is-held, .card.is-dragging').length;
      const legal = document.querySelectorAll('[data-droppable="1"]').length;
      const illegal = document.querySelectorAll('[data-drop-illegal="1"]').length;
      const ghost = document.querySelectorAll('.drop-ghost').length;
      const body = document.body.classList.contains('is-dragging-card');
      const detail = `held=${held} legal=${legal} illegal=${illegal} ghost=${ghost} body=${body}`;
      // The four things the shot is ABOUT. Any of them missing and the picture
      // shows a table with a card floating over it, which is not the moment.
      if (!body || !held || !legal || !ghost) return `drag:incomplete ${detail}`;
      return `drag:held ${detail}`;
    });
  },
};

/**
 * The hand fan's reachability probe — a REAL TAP on the exposed strip.
 *
 * Lives here (not inside touchtest.mjs) so a mutation script can exercise the
 * exact code the gate runs: §8 demands the assertion be watchable going red,
 * and a copy in a throwaway script proves nothing about the original.
 *
 * Why not the swipe probe: a horizontal swipe that starts on a hand card IS
 * the drag-play gesture by design (touchtest §A), so the fan's scroller never
 * receives it and swipe-probing the fan can only misreport it (triage
 * 2026-08-08: a 9-card hand printed 'UNREACHABLE … never moved under 8 real
 * swipe(s)' while a real tap selected 9/9 strips, including a 15px one). The
 * fan's reachability contract is §5's tap-the-strip, and SELECTION is the
 * observable half (mode.cardId, mirrored by .is-lifted/.is-picked). A card
 * whose strip no tap can select still comes back red — that is the genuine
 * no-input-reaches-it case, mutation-proven with an overlay over the strip.
 *
 * Not a HOST driver: it takes the openTouchPage() handle, not a bare page,
 * and returns a structured verdict ({ ok, line }) for touchtest's
 * probeAndSplit, not a reached-string.
 *
 * @param handle  an openTouchPage() handle ({ page, tap })
 * @param e       an audit candidate ({ id = data-chud-reach stamp, label, kinds })
 */
export async function probeFanTap(handle, e) {
  const page = handle.page;
  const strip = await page.evaluate((id) => {
    const el = document.querySelector(`[data-chud-reach="${CSS.escape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let right = r.right;
    const sib = el.nextElementSibling;
    if (sib?.hasAttribute('data-card-id')) {
      const sr = sib.getBoundingClientRect();
      if (sr.left > r.left && sr.left < r.right) right = sr.left;
    }
    const l = Math.max(r.left, 0);
    const rt = Math.min(right, innerWidth);
    const tp = Math.max(r.top, 0);
    const b = Math.min(r.bottom, innerHeight);
    return { cardId: el.dataset.cardId, w: rt - l, h: b - tp, x: (l + rt) / 2, y: (tp + b) / 2 };
  }, e.id);
  if (!strip) return { ...e, ok: false, line: `${e.label} — vanished before the fan tap probe could touch it` };
  if (strip.w < 2 || strip.h < 2) {
    return { ...e, ok: false, line: `${e.label} — UNREACHABLE: ${Math.max(0, Math.round(strip.w))}px of exposed strip on screen, `
      + 'and no other gesture reaches a fan card (a swipe here is drag-play by design)' };
  }
  // A tap TOGGLES selection, so probing an already-selected card would
  // deselect it and read as unreachable. Clear first; clear after, so the
  // frame is left as the probe found it.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitForTimeout(120);
  /* Where on the strip a real thumb lands matters. MEASURED on a 9-card fan
   * (2026-08-08, /tmp/chud-evidence/fixtouch/strip-tap-matrix.mjs): the fan
   * leans each card over the previous one's strip, and Chromium's touch
   * targeting resolves a 12px-radius tap on the strip's UPPER half to the
   * overlapping neighbour — the 15px end strip selected the wrong card at
   * y≈0.5 of its rect and the right one at y≥0.6. A thumb re-aims; so does
   * the probe: walk down the exposed strip and take the first point that
   * selects the card. Only a card NO point on its strip can select is red. */
  const sel = async () => page.evaluate((id) => {
    const el = document.querySelector(`[data-chud-reach="${CSS.escape(id)}"]`);
    if (!el) return { found: false };
    const m = window.__CHUD.mode || {};
    const picked = m.selected ? [...m.selected].map(String) : [];
    return {
      found: true,
      selected: String(m.cardId) === String(el.dataset.cardId)
        || picked.includes(String(el.dataset.cardId))
        || el.classList.contains('is-lifted') || el.classList.contains('is-picked'),
      mode: m.kind || 'idle',
    };
  }, e.id);
  let last = null;
  for (const yf of [0.55, 0.7, 0.85]) {
    const y = strip.y - strip.h / 2 + strip.h * yf;
    if (y < 1 || y > (strip.y - strip.h / 2) + strip.h - 1) continue;
    await handle.tap(strip.x, y);
    await page.waitForTimeout(220);
    last = await sel();
    if (!last.found || last.selected) break;
    // The tap selected a SIBLING (or nothing): clear it and re-aim lower.
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitForTimeout(120);
  if (last?.found && last.selected) {
    return { ...e, ok: true, line: `${e.label} — reachable by a real tap on the ${Math.round(strip.w)}px exposed strip `
      + '(§5: the fan answers reachability by tap; a swipe here is drag-play by design)' };
  }
  return { ...e, ok: false, line: `${e.label} — UNREACHABLE: a real tap on the ${Math.round(strip.w)}px exposed strip `
    + `did not select the card at any point along it (${last?.found ? `last try left mode ${last.mode}` : 'the card vanished mid-probe'}) — no input reaches it` };
}

/** Run whichever kind of driver `name` is. Returns the reached string. */
export async function drive(page, name) {
  if (HOST[name]) return HOST[name](page);
  if (!DRIVERS[name]) return `driver:unknown '${name}'`;
  return page.evaluate(DRIVERS[name]);
}

/** Drop anything a host driver is still holding. Safe to call unconditionally. */
export async function releaseInput(page) {
  await page.mouse.up().catch(() => {});
  if (heldTouch) {
    const end = heldTouch;
    heldTouch = null;
    await end('touchEnd', []).catch(() => {});
  }
}
