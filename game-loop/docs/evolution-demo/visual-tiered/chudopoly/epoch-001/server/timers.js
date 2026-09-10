// server/timers.js — Turn timer and response timer management

let G, Bot, broadcast;

function init(deps) {
  G = deps.G;
  Bot = deps.Bot;
  broadcast = deps.broadcast;
}

/* ── Turn timer ─────────────────────────────────────────────────────── */

// Arms (or disarms) only the turn deadline. Never touches the response timer or the bot
// timeout, so it is safe to call from syncTimers().
function armTurnTimer(room) {
  if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; }
  room.turnStartedAt = null;
  if (!room.turnTimeout || room.turnTimeout <= 0) return;
  if (!room.state || room.state.phase !== 'playing') return;
  if (room.state.pendingAction) return;
  room.turnStartedAt = Date.now();
  room.turnTimerId = setTimeout(() => onTurnTimeout(room), room.turnTimeout * 1000);
}

function onTurnTimeout(room) {
  room.turnTimerId = null;
  room.turnStartedAt = null;
  if (!room.state || room.state.phase !== 'playing') return;
  const cp = G.currentPlayer(room.state);
  if (room.state.pendingAction) { startResponseTimer(room); return; }
  room.state.turnPhase = 'play';
  const excess = cp.hand.length > 7 ? cp.hand.slice(-(cp.hand.length - 7)).map(c => c.id) : undefined;
  // Say what happened, in prose AND as a structured event, BEFORE the turn is force-ended —
  // so the beat reads in the order it happened and the discard is attributed to the clock
  // rather than looking like a choice the player made.
  G.logLine(room.state, `${cp.name} ran out of time (${room.turnTimeout}s) — turn ended automatically`
    + (excess ? `, ${excess.length} card${excess.length === 1 ? '' : 's'} discarded to the hand limit` : '') + '.');
  G.emit(room.state, 'turn_timeout', {
    actor: cp.id,
    name: cp.name,
    auto: true,
    timeout: room.turnTimeout,
    discarded: excess ? excess.length : 0,
  });
  const res = G.endTurn(room.state, cp.id, excess);
  // Blind `(idx+1) % len` here could hand the turn to an eliminated seat and skipped
  // beginTurn(), so an armed final approach parked at its checkpoint never resolved.
  if (res.error) G.forceEndTurn(room.state);
  startTurnTimer(room);
  broadcast.broadcastAndScheduleBot(room);
}

// The pendingAction branch is deliberately BEFORE the turnTimeout<=0 return: response
// deadlines must not depend on the turn clock. With turnTimeout 0 (Quick Play) the old
// order meant a bot's charge armed no response timer at all — nothing ever auto-resolved
// and the client correctly showed no countdown.
function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.state || room.state.phase !== 'playing') return;
  if (room.state.pendingAction) { startResponseTimer(room); return; }
  armTurnTimer(room);
}

// Idempotent reconciliation of room timers against room.state. Called after every
// broadcast (including the bots' own) so a pending action created outside a handler —
// a bot playing rent — still gets a response deadline.
function syncTimers(room) {
  if (!room?.state) return;
  // A finished game must not leave a re-arming turn timer behind.
  if (room.state.phase !== 'playing') { clearTurnTimer(room); return; }
  if (room.state.pendingAction) {
    if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; room.turnStartedAt = null; }
    // Unconditional now that startResponseTimer preserves every deadline already running.
    // It used to be guarded by `if (!room.responseTimerId)` because calling it restamped the
    // shared clock; the cost of that guard was that a pending action which changed hands
    // outside a handler — a BOT playing OPSEC — left the new responder running against the
    // old responder's deadline. Reconciliation is only reconciliation if it always runs.
    startResponseTimer(room);
    return;
  }
  if (room.responseTimerId) clearResponseTimer(room);
  if (!room.turnTimerId) armTurnTimer(room);
}

function clearTurnTimer(room) {
  if (room.turnTimerId) { clearTimeout(room.turnTimerId); room.turnTimerId = null; }
  room.turnStartedAt = null;
  clearResponseTimer(room);
  Bot.cancelBotTimeout(room);
}

/* ── Response timer ──────────────────────────────────────────────────── */

/* ── One clock per outstanding answer ─────────────────────────────────
 *
 * A pending action can owe answers from SEVERAL seats at once (Roll Call charges the whole
 * table). This used to be one shared `responseStartedAt` that was stamped `Date.now()` every
 * time `startResponseTimer` ran — and `case 'respond'` runs it after every successful answer.
 * Measured on a Roll Call with 3 outstanding targets: one answered at +4s and the shared
 * clock jumped +4,344 ms, handing a brand-new full 45s to the two who had done nothing. The
 * countdown widget on their screens visibly jumped back to full — a clock that lies. Worse,
 * `autoResolveResponse` resolved only `pendingResponders()[0]` per expiry and then re-armed
 * another full clock, so four absent seats could hold the table for 4 × 45s = 180s.
 *
 * Now every outstanding answer carries its OWN deadline, keyed by the pending target entry
 * object (stable for the life of that entry; `finishEntry` removes it, OPSEC mutates it in
 * place). A deadline is stamped once and then carried forward untouched — the ONLY thing
 * that starts a new one is the question changing hands, i.e. a new entry appearing or an
 * OPSEC flipping `responderId`/`depth`, which genuinely is a new decision for a new person.
 * That makes `startResponseTimer` idempotent, so every call site can stop caring whether it
 * is the first: syncTimers, `respond`, `play_action` and the auto-resolver all converge on
 * the same deadlines.
 *
 * The single node timer is armed for the EARLIEST outstanding deadline, and expiry resolves
 * every responder that is actually out of time in one pass, so N absent seats cost one
 * response clock in total, not N of them.
 */

// Deadlines within this window of each other expire together. Without it, three clocks armed
// milliseconds apart would each cost a separate 0ms re-arm, broadcast and animation.
const EXPIRY_EPSILON_MS = 250;

function deadlineMap(room) {
  return room.responseDeadlines instanceof Map ? room.responseDeadlines : null;
}

// Rebuild the per-entry deadlines from the live pending action, PRESERVING every clock that
// is still running against the same unchanged question. Returns the live records.
function syncResponseDeadlines(room, now = Date.now()) {
  const pa = room.state?.pendingAction;
  const targets = Array.isArray(pa?.targets) ? pa.targets : [];
  if (!targets.length) { room.responseDeadlines = null; return []; }
  const prev = deadlineMap(room);
  const next = new Map();
  for (const entry of targets) {
    if (!entry?.responderId) continue;
    const old = prev?.get(entry);
    const sameQuestion = old && old.responderId === entry.responderId && old.depth === entry.depth;
    next.set(entry, sameQuestion ? old : { responderId: entry.responderId, depth: entry.depth, startedAt: now });
  }
  room.responseDeadlines = next.size ? next : null;
  return [...next.values()];
}

// The deadline a given seat is actually running against, or null. Used by the broadcast so
// what each client is shown is true FOR THAT CLIENT.
function responseDeadlineFor(room, playerId) {
  const map = deadlineMap(room);
  if (!map) return null;
  for (const record of map.values()) if (record.responderId === playerId) return record.startedAt;
  return null;
}

// The next deadline the table is waiting on — what a seat that owes nothing is shown.
function earliestResponseDeadline(room) {
  const map = deadlineMap(room);
  if (!map) return null;
  let earliest = null;
  for (const record of map.values()) {
    if (earliest === null || record.startedAt < earliest) earliest = record.startedAt;
  }
  return earliest;
}

function startResponseTimer(room) {
  if (room.responseTimerId) { clearTimeout(room.responseTimerId); room.responseTimerId = null; }
  if (!room.responseTimeout || room.responseTimeout <= 0) { clearResponseTimer(room); return; }
  if (!room.state?.pendingAction) { clearResponseTimer(room); return; }
  const records = syncResponseDeadlines(room);
  if (!records.length) { clearResponseTimer(room); return; }
  const earliest = earliestResponseDeadline(room);
  // The legacy room-level field is kept in sync as "the next deadline to expire", so anything
  // still reading it (and the fallback in broadcast.js) reads the truth rather than a clock
  // that was restamped by somebody else's answer.
  room.responseStartedAt = earliest;
  const delay = Math.max(0, earliest + room.responseTimeout * 1000 - Date.now());
  room.responseTimerId = setTimeout(() => {
    room.responseTimerId = null;
    if (!room.state || !room.state.pendingAction) return;
    autoResolveResponse(room);
  }, delay);
}

function clearResponseTimer(room) {
  if (room.responseTimerId) { clearTimeout(room.responseTimerId); room.responseTimerId = null; }
  room.responseStartedAt = null;
  room.responseDeadlines = null;
}

// Auto-answer for ONE responder: the narration, then the accept.
function autoResolveOne(room, responderId) {
  const pa = room.state?.pendingAction;
  if (!pa) return;
  const entry = G.pendingEntryFor(room.state, responderId);
  if (!entry) return;
  const responder = G.getPlayer(room.state, responderId);
  if (!responder) return;

  // Whose decision is this, really? At even depth the target is answering a charge aimed at
  // them and accepting means suffering it. At ODD depth the responder is the ATTACKER, being
  // asked whether they will counter the defender's OPSEC — accepting means they concede and
  // the OPSEC stands. `owed` is 0 in that case, so the event used to read
  // `pending:'payment', decision:'accept', amount:0`, which the client now shows prominently:
  // the wrong words, in the one place a player goes to find out what just happened to them.
  const conceding = entry.depth % 2 === 1;
  const owed = pa.type === 'payment' && !conceding && responderId !== pa.sourceId ? (pa.amount || 0) : 0;
  const defenderName = G.getPlayer(room.state, entry.id)?.name || 'the defender';

  // "It just took my cards and I don't know why" was the complaint. An expiring answer clock
  // is the one board change nobody chose, so it is narrated twice: a prose line for the log
  // and a `response_timeout` event for the journal, the replay and the gamelog record. Both
  // are written BEFORE the auto-answer resolves, so the beat that explains the payment comes
  // ahead of the payment itself in the stream.
  const charge = owed > 0 ? ` the ${owed}M charge` : '';
  G.logLine(room.state, conceding
    ? `${responder.name} ran out of time (${room.responseTimeout}s) — did not counter, `
      + `so ${defenderName}'s OPSEC stands.`
    : `${responder.name} ran out of time (${room.responseTimeout}s) — auto-accepted${charge}.`);
  G.emit(room.state, 'response_timeout', {
    actor: responderId,          // whose clock expired (touchesMe() reads `actor`)
    name: responder.name,
    // What they were actually being asked. At odd depth the question is not the original
    // charge, it is "do you counter the OPSEC?" — so it is named as such instead of
    // mislabelling a conceded counter as an accepted 0M payment.
    pending: conceding ? 'opsec' : (pa.type || null),
    decision: conceding ? 'concede' : 'accept',
    blocked: conceding || undefined,     // the action does NOT happen when the source concedes
    depth: entry.depth,
    target: entry.id,                    // the seat the original action was aimed at
    auto: true,
    amount: owed,                        // 0 when the pending action is not a payment
    timeout: room.responseTimeout,
    source: pa.sourceId ?? null,         // who charged them
  });

  const res = G.respondToAction(room.state, responderId, 'accept', autoPickPayment(responder, owed));
  if (res.needPayment) {
    G.respondToAction(room.state, responderId, 'accept', G.payableCards(responder).map(c => c.id));
  }
}

function autoResolveResponse(room) {
  if (!room.state?.pendingAction) return;
  const now = Date.now();
  const map = deadlineMap(room);
  const timeoutMs = (room.responseTimeout || 0) * 1000;

  // Everyone whose OWN clock has run out, resolved in a single pass. Without this, four
  // absent seats each bought a fresh full clock in turn. A room with no deadline map (a unit
  // test, a room whose clock was armed before this existed) treats the call itself as the
  // expiry, which is what it has always meant.
  const expired = map
    ? [...map.values()]
      .filter(r => now - r.startedAt >= timeoutMs - EXPIRY_EPSILON_MS)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(r => r.responderId)
    : G.pendingResponders(room.state);

  for (const responderId of expired) {
    if (!room.state.pendingAction) break;
    autoResolveOne(room, responderId);
  }

  if (room.state.pendingAction) {
    // Re-arm for whoever is still outstanding. Their own deadlines are carried forward
    // untouched — an expiry never hands a live responder a new clock.
    startResponseTimer(room);
  } else {
    startTurnTimer(room);
  }
  broadcast.broadcastAndScheduleBot(room);
}

function autoPickPayment(player, amount) {
  if (!amount || amount <= 0) return [];
  const cards = [];
  let total = 0;

  const bankSorted = [...(player.bank || [])].sort((a, b) => a.value - b.value);
  for (const c of bankSorted) {
    if (total >= amount) break;
    cards.push(c.id);
    total += c.value;
  }

  // §3.1b — upgrades are payable, and are spent before properties.
  if (total < amount) {
    const upgrades = [];
    for (const list of Object.values(player.upgrades || {})) {
      for (const u of list || []) if (u && typeof u === 'object') upgrades.push(u);
    }
    upgrades.sort((a, b) => a.value - b.value);
    for (const c of upgrades) {
      if (total >= amount) break;
      cards.push(c.id);
      total += c.value;
    }
  }

  if (total < amount) {
    const allProps = [];
    for (const propCards of Object.values(player.properties || {})) {
      if (propCards) allProps.push(...propCards);
    }
    allProps.sort((a, b) => a.value - b.value);
    for (const c of allProps) {
      if (total >= amount) break;
      cards.push(c.id);
      total += c.value;
    }
  }

  return cards;
}

module.exports = {
  init, startTurnTimer, clearTurnTimer, startResponseTimer, clearResponseTimer,
  autoPickPayment, autoResolveResponse, onTurnTimeout, syncTimers, armTurnTimer,
  responseDeadlineFor, earliestResponseDeadline, syncResponseDeadlines,
};
