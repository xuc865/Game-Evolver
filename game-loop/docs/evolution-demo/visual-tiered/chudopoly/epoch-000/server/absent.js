// server/absent.js — Absent player handling and bot name generation

let G, broadcast;

function init(deps) {
  G = deps.G;
  broadcast = deps.broadcast;
}

const BOT_CALLSIGNS = [
  'Viper', 'Iceman', 'Phoenix', 'Rooster', 'Hangman',
  'Warlock', 'Coyote', 'Merlin', 'Slider', 'Bandit',
  'Cobra', 'Hawk', 'Reaper', 'Phantom', 'Shadow',
  'Bolt', 'Ace', 'Blaze', 'Raptor', 'Jester',
];

function generateBotName(room) {
  const used = room.players.map(p => p.name);
  const available = BOT_CALLSIGNS.filter(n => !used.includes(n));
  return available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : 'Bot-' + Math.floor(Math.random() * 900 + 100);
}

function handleAbsent(room) {
  if (!room?.state || room.state.phase !== 'playing') return;
  const MAX_ITER = 30;
  for (let i = 0; i < MAX_ITER; i++) {
    if (room.state.phase !== 'playing') return;

    const active = room.players.filter(x => !room.state.players?.find(sp => sp.id === x.id)?.eliminated);
    const connected = active.filter(x => x.isBot || x.ws?.readyState === 1);
    const humanConnected = active.filter(x => !x.isBot && x.ws?.readyState === 1);
    if (humanConnected.length === 0 && connected.length > 1) {
      return;
    }
    if (connected.length <= 1 && active.length > 1) {
      if (connected.length === 1) {
        const winner = G.getPlayer(room.state, connected[0].id);
        // finishGame() rather than stamping phase/winner by hand. Hand-rolling it left
        // `endReason` null, `turnPhase` mid-turn, a live `pendingAction` and — because the
        // celebration is gated on the event, not the phase — NO win event at all, so the
        // table just stopped. It also made the record indistinguishable from a crash in the
        // game log: 5 of the first 91 production records carried a winner with a null
        // endReason and no win event, and nothing downstream could tell a walkover from a
        // real win. 'walkover' is its own reason because it is not 'last_standing' — nobody
        // was scooped, they disconnected — and a stats query has to be able to drop it.
        G.finishGame(room.state, connected[0].id, 'walkover',
          winner.name + ' wins — all other players left!');
      }
      return;
    }

    if (room.state.pendingAction) {
      const pa = room.state.pendingAction;
      const absentResponder = G.pendingResponders(room.state)
        .find(pid => !broadcast.isConnected(room, pid));
      if (!absentResponder) return;

      const gp = G.getPlayer(room.state, absentResponder);
      const owed = pa.type === 'payment' && absentResponder !== pa.sourceId ? (pa.amount || 0) : 0;
      const picked = owed > 0 ? require('./timers').autoPickPayment(gp, owed) : [];
      const res = G.respondToAction(room.state, absentResponder, 'accept', picked.length > 0 ? picked : undefined);
      if (res?.needPayment) {
        G.respondToAction(room.state, absentResponder, 'accept', G.payableCards(gp).map(c => c.id));
      }
      G.logLine(room.state, (gp?.name || '?') + ' is absent — auto-resolved');
      continue;
    }

    const cp = G.currentPlayer(room.state);
    if (cp.eliminated || !broadcast.isConnected(room, cp.id)) {
      if (!cp.eliminated) G.logLine(room.state, cp.name + ' is absent — turn skipped');
      room.state.turnPhase = 'play';
      const excess = cp.hand.length > 7 ? cp.hand.slice(-(cp.hand.length - 7)).map(c => c.id) : undefined;
      const res = G.endTurn(room.state, cp.id, excess);
      // Blind `(idx+1) % len` could land on an eliminated seat, which then also fails
      // endTurn on the next pass — a 30-iteration spin ending on a wedged table.
      if (res.error) G.forceEndTurn(room.state);
      continue;
    }

    return;
  }
}

module.exports = { init, generateBotName, handleAbsent };
