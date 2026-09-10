// Strict validation for every client-to-server WebSocket command.

// The scalar rule vocabularies below are deliberately restated rather than imported — they
// are three short lists and test/houserules.test.js pins them against the engine. The DECK
// is not: it is thirteen counts, thirteen ceilings and two totals, and a mirror that long
// drifts. game.js owns it and this file calls G.validateDeck(). No cycle — game.js requires
// nothing.
const G = require('../game');

const MESSAGE_TYPES = new Set([
  'create_room', 'quick_play', 'join_room', 'reconnect', 'kick', 'add_bot',
  'remove_bot', 'leave_room', 'set_rules', 'start_game', 'rematch', 'draw', 'play_money',
  'play_property', 'move_property', 'swap_property', 'play_action', 'respond', 'emote', 'chat',
  'chat_history', 'scoop', 'end_turn',
]);
const BOT_MODES = new Set(['random', 'conservative', 'neutral', 'aggressive', 'chud']);
const WIN_RULES = new Set(['finalApproach', 'mdFaithful', 'instant']);
const RULE_PRESETS = new Set(['chudopoly', 'mdFaithful', 'blitz', 'longGame']);
const SETS_TO_WIN = new Set([3, 4, 5]);
// §3.10b. Restated rather than imported for the same reason as the three above — a short
// closed vocabulary, pinned against the engine by test/deckconfig.test.js. The
// instant-win combination is refused by game.js normalizeSuddenDeath, not here: this
// layer validates a FIELD, and legality that depends on another field is the engine's.
const SUDDEN_DEATH = new Set(['off', 'oneLap', 'escalate', 'points']);
function validOptionalBool(value) { return value === undefined || typeof value === 'boolean'; }
const COLORS = new Set(['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'darkblue', 'base', 'intel']);
const ID_PATTERN = /^[a-f0-9-]{16,64}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ROOM_PATTERN = /^[A-HJ-NP-Z2-9]{4}$/;

function fail(error) { return { ok: false, error }; }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isInt(value, min = 0, max = 100000) {
  return Number.isInteger(value) && value >= min && value <= max;
}
function validOptionalId(value) { return value === undefined || (typeof value === 'string' && ID_PATTERN.test(value)); }
function validOptionalCardId(value) { return value === undefined || isInt(value, 0, 1000); }
function validOptionalColor(value) { return value === undefined || COLORS.has(value); }
function validName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,15}$/.test(value.trim());
}
function validUniqueCardIds(value, maxLength = 110) {
  return Array.isArray(value) && value.length <= maxLength
    && value.every(id => isInt(id, 0, 1000))
    && new Set(value).size === value.length;
}

// The five rule fields, shared verbatim by `start_game` (which launches a ruleset) and
// `set_rules` (which only announces the one the lobby is about to launch). Both commands
// MUST accept exactly the same values, or the picker could show a ruleset that start_game
// would then refuse. One function, two callers, no drift.
//
// Every field is optional and additive: absent means the Chudopoly default. A preset
// supplies the base; individual toggles override it. Presets are resolved server-side
// (game.js resolveRules), never trusted from the client.
function validateRuleFields(message) {
  if (message.preset !== undefined && !RULE_PRESETS.has(message.preset)) return fail('Invalid rule preset');
  if (message.winRule !== undefined && !WIN_RULES.has(message.winRule)) return fail('Invalid win rule');
  if (message.setsToWin !== undefined && !SETS_TO_WIN.has(message.setsToWin)) return fail('Invalid sets to win (3, 4 or 5)');
  if (!validOptionalBool(message.pureSetRequired)) return fail('Invalid pure-set setting');
  if (!validOptionalBool(message.counterCostsPlay)) return fail('Invalid OPSEC-cost setting');
  if (!validOptionalBool(message.passGoRestartsTurn)) return fail('Invalid PCS Orders setting');
  if (message.suddenDeath !== undefined && !SUDDEN_DEATH.has(message.suddenDeath)) {
    return fail('Invalid sudden death setting');
  }
  // Deck composition (§3 deck knob). The counts are the engine's to police — game.js owns
  // the kind list, the per-kind ceilings and the total bounds, and this is the strict door
  // in front of the same function normalizeDeck() falls back to silently. One source, so a
  // count the lobby is allowed to offer is exactly a count start_game will accept.
  const deckError = G.validateDeck(message.deck);
  if (deckError) return fail(deckError);
  return null;
}

function validateMessage(message) {
  if (!isObject(message)) return fail('Message must be a JSON object');
  if (typeof message.type !== 'string' || !MESSAGE_TYPES.has(message.type)) return fail('Unknown message type');

  switch (message.type) {
    case 'create_room':
      if (!validName(message.name)) return fail('Call sign must be 1-16 letters, numbers, spaces, or . _ - characters');
      // Opt-in public listing (owner directive 2026-08-07). Strictly boolean:
      // a truthy string silently coerced is how a room ends up listed by a
      // client bug nobody chose. Absent means private — the default.
      if (!validOptionalBool(message.public)) return fail('Invalid public setting');
      break;
    case 'quick_play':
      if (!validName(message.name)) return fail('Call sign must be 1-16 letters, numbers, spaces, or . _ - characters');
      break;
    case 'join_room':
      if (typeof message.code !== 'string' || !ROOM_PATTERN.test(message.code.toUpperCase())) return fail('Invalid room code');
      if (!validName(message.name)) return fail('Call sign must be 1-16 letters, numbers, spaces, or . _ - characters');
      if (message.playerId !== undefined && !validOptionalId(message.playerId)) return fail('Invalid player ID');
      if (message.resumeToken !== undefined && (typeof message.resumeToken !== 'string' || !TOKEN_PATTERN.test(message.resumeToken))) return fail('Invalid resume token');
      break;
    case 'reconnect':
      if (typeof message.code !== 'string' || !ROOM_PATTERN.test(message.code.toUpperCase())) return fail('Invalid room code');
      if (!validOptionalId(message.playerId) || message.playerId === undefined) return fail('Invalid player ID');
      if (typeof message.resumeToken !== 'string' || !TOKEN_PATTERN.test(message.resumeToken)) return fail('Invalid resume token');
      break;
    case 'kick':
    case 'remove_bot':
      if (!validOptionalId(message.targetId) || message.targetId === undefined) return fail('Invalid target ID');
      break;
    case 'add_bot':
      if (!BOT_MODES.has(message.mode)) return fail('Invalid bot mode');
      break;
    case 'start_game':
      // Both clocks are OPTIONAL: absent means "the host did not say", and the server
      // supplies the default (60s turn, 45s answer). An explicit 0 still means OFF, and an
      // out-of-range or non-integer value is still a hard refusal — silently clamping a
      // typo'd clock is how a table ends up running on a setting nobody chose.
      if (message.turnTimeout !== undefined && !isInt(message.turnTimeout, 0, 300)) return fail('Invalid timer setting');
      if (message.responseTimeout !== undefined && !isInt(message.responseTimeout, 0, 120)) return fail('Invalid timer setting');
      {
        const ruleError = validateRuleFields(message);
        if (ruleError) return ruleError;
      }
      break;
    case 'set_rules': {
      // Lobby-only, host-only (enforced in handlers.js). Carries nothing but the same five
      // optional rule fields start_game accepts — no clocks, no player ids, no state.
      const ruleError = validateRuleFields(message);
      if (ruleError) return ruleError;
      break;
    }
    case 'play_money':
      if (!isInt(message.cardIndex, 0, 110)) return fail('Invalid card index');
      break;
    case 'play_property':
      if (!isInt(message.cardIndex, 0, 110) || !validOptionalColor(message.targetColor)) return fail('Invalid property play');
      break;
    case 'move_property':
      if (!isInt(message.cardId, 0, 1000) || !COLORS.has(message.toColor)) return fail('Invalid property move');
      break;
    // §3.5's atomic swap. Two card ids and NOTHING ELSE — no colour rides on the
    // wire, because the destinations are entirely determined by where the two
    // cards already are. A client that could name the colours could name a pair
    // that disagrees with the board, and the engine would then have to decide
    // which of the two it believed. This layer validates SHAPE (two distinct
    // integer card ids in range); every question that needs the board — do you
    // own them, are they in different zones, is each legal in the other's zone,
    // can you afford two rearranges — is game.js swapProperties()'s, per §0.1.
    case 'swap_property':
      if (!isInt(message.cardId, 0, 1000) || !isInt(message.withCardId, 0, 1000)) {
        return fail('Invalid property swap');
      }
      if (message.cardId === message.withCardId) return fail('Pick two different cards');
      break;
    case 'play_action':
      if (!isInt(message.cardIndex, 0, 110) || !validOptionalId(message.targetId)
        || !validOptionalCardId(message.targetCardId) || !validOptionalCardId(message.myCardId)
        || !validOptionalColor(message.targetColor)) return fail('Invalid action play');
      break;
    case 'respond':
      if (!['accept', 'opsec'].includes(message.response)) return fail('Invalid response');
      if (message.paymentCards !== undefined && !validUniqueCardIds(message.paymentCards)) return fail('Invalid payment selection');
      break;
    case 'emote':
      if (typeof message.text !== 'string' || message.text.length < 1 || message.text.length > 30) return fail('Invalid emote');
      break;
    case 'chat':
      if (typeof message.text !== 'string' || message.text.trim().length < 1 || message.text.length > 500) return fail('Invalid chat message');
      if (!['room', 'global'].includes(message.scope)) return fail('Invalid chat scope');
      break;
    case 'end_turn':
      if (message.discardIds !== undefined && !validUniqueCardIds(message.discardIds)) return fail('Invalid discard selection');
      break;
  }

  return { ok: true, value: { ...message, name: typeof message.name === 'string' ? message.name.trim() : message.name } };
}

module.exports = { validateMessage };
