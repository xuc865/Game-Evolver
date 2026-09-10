// net/send.js — one named sender per protocol message (server/protocol.js).
// Nothing else in the client is allowed to hand-roll a socket payload; a typo
// in a message type is a silent no-op on the server and costs an hour.

import { send } from './socket.js';

// `public` rides only when true: absent means private (server/protocol.js
// validates it strictly boolean, default off — owner directive 2026-08-07).
export const createRoom = (name, isPublic) => send({
  type: 'create_room', name, ...(isPublic ? { public: true } : {}),
});
export const quickPlay = (name) => send({ type: 'quick_play', name });

export const joinRoom = (code, name, resume) => send({
  type: 'join_room',
  code: String(code || '').toUpperCase(),
  name,
  ...(resume?.playerId ? { playerId: resume.playerId } : {}),
  ...(resume?.resumeToken ? { resumeToken: resume.resumeToken } : {}),
});

export const reconnect = (playerId, code, resumeToken) =>
  send({ type: 'reconnect', playerId, code, resumeToken });

export const leaveRoom = () => send({ type: 'leave_room' });
export const kick = (targetId) => send({ type: 'kick', targetId });
export const addBot = (mode) => send({ type: 'add_bot', mode });
export const removeBot = (targetId) => send({ type: 'remove_bot', targetId });

/**
 * The rule keys `start_game` may carry — the client mirror of server/handlers.js
 * RULE_FIELDS (which is what pickRuleOpts reads). A second whitelist here was the
 * 2026-08-08 defect: it listed five keys, so `deck` and `suddenDeath` — both
 * validated by the server and both produced by ui/ruleset.js rulesPayload() —
 * were silently dropped client-side and the lobby's steppers launched a stock
 * game. The two lists are not importable across the client/server boundary, so
 * test/rules-wire.test.js pins them equal; adding a key on one side only fails
 * the suite.
 */
export const RULE_WIRE_KEYS = Object.freeze(
  ['preset', 'winRule', 'setsToWin', 'pureSetRequired', 'counterCostsPlay', 'passGoRestartsTurn',
   'suddenDeath', 'deck']);

/**
 * @param {object} [rules] optional ruleset — `preset` and/or any of the keys in
 *   RULE_WIRE_KEYS. Every field is optional and validated server-side; omitting
 *   all of them means the Chudopoly defaults. Only defined keys are sent, so an
 *   old lobby that passes nothing produces the exact payload it always did.
 */
export const startGame = (turnTimeout, responseTimeout, rules = null) => {
  const msg = { type: 'start_game', turnTimeout: turnTimeout | 0, responseTimeout: responseTimeout | 0 };
  for (const key of RULE_WIRE_KEYS) {
    if (rules && rules[key] !== undefined && rules[key] !== null) msg[key] = rules[key];
  }
  return send(msg);
};

export const rematch = () => send({ type: 'rematch' });

export const draw = () => send({ type: 'draw' });
export const playMoney = (cardIndex) => send({ type: 'play_money', cardIndex });

export const playProperty = (cardIndex, targetColor) => send({
  type: 'play_property', cardIndex,
  ...(targetColor ? { targetColor } : {}),
});

export const moveProperty = (cardId, toColor) => send({ type: 'move_property', cardId, toColor });

/**
 * §3.5's atomic two-card exchange (game.js swapProperties). No colour on the
 * wire: both destinations are fully determined by where the two cards already
 * are, and a client that could name them could name a pair that disagrees with
 * the board.
 */
export const swapProperty = (cardId, withCardId) =>
  send({ type: 'swap_property', cardId, withCardId });

/**
 * opts: {targetId, targetColor, targetCardId, myCardId} — only the keys the
 * action needs. Sending an undefined key fails protocol validation, so they are
 * spread in conditionally.
 */
export const playAction = (cardIndex, opts = {}) => send({
  type: 'play_action', cardIndex,
  ...(opts.targetId ? { targetId: opts.targetId } : {}),
  ...(opts.targetColor ? { targetColor: opts.targetColor } : {}),
  ...(opts.targetCardId != null ? { targetCardId: opts.targetCardId } : {}),
  ...(opts.myCardId != null ? { myCardId: opts.myCardId } : {}),
});

export const respond = (response, paymentCards) => send({
  type: 'respond', response,
  ...(paymentCards ? { paymentCards } : {}),
});

export const emote = (text) => send({ type: 'emote', text });
export const chat = (text, scope) => send({ type: 'chat', text, scope });
export const chatHistory = () => send({ type: 'chat_history' });
export const scoop = () => send({ type: 'scoop' });
export const endTurn = (discardIds) => send({
  type: 'end_turn',
  ...(discardIds ? { discardIds } : {}),
});
