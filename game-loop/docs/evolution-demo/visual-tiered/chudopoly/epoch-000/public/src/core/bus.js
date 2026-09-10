// core/bus.js — the one pub/sub. "Typed" by convention: every channel used
// anywhere in the client is named in EVENTS, so a typo is a lookup failure at
// authoring time instead of a silent no-op at runtime.

export const EVENTS = Object.freeze({
  NET_OPEN: 'net:open',
  NET_CLOSE: 'net:close',
  NET_JOINED: 'net:joined',
  NET_STATE: 'net:state',
  NET_ERROR: 'net:error',
  NET_KICKED: 'net:kicked',
  NET_EMOTE: 'net:emote',
  NET_CHAT: 'net:chat',
  NET_CHAT_HISTORY: 'net:chat_history',
  NET_NEED_PAYMENT: 'net:need_payment',
  NET_SENT: 'net:sent',

  STATE_APPLIED: 'state:applied',     // { snapshot, room, events, snap, fresh }
  STATE_SCREEN: 'state:screen',       // 'home' | 'lobby' | 'game'

  CHOREO_EVENT: 'choreo:event',       // one engine event reached the table
  CHOREO_SFX: 'choreo:sfx',           // { name, ev, mine } — audio/fx dispatch
  CHOREO_IDLE: 'choreo:idle',
  FX_CUE: 'fx:cue',                   // { kind, mine, big, at:{x,y} } — anim/cues.js

  GAME_BANKED: 'stats:banked',        // { row } — the recorder banked one game

  INTERACT_CHANGED: 'interact:changed',
  UI_DETAILS: 'ui:details',           // card id — open the details sheet
  UI_PEEK: 'ui:peek',                 // card id — hover/hold peek opened
  UI_PEEK_END: 'ui:peek_end',
  TOAST: 'ui:toast',
  ACTION: 'ui:action',                // delegated data-action dispatch
});

const channels = new Map();

export function on(type, fn) {
  let list = channels.get(type);
  if (!list) { list = []; channels.set(type, list); }
  list.push(fn);
  return () => off(type, fn);
}

export function off(type, fn) {
  const list = channels.get(type);
  if (!list) return;
  const i = list.indexOf(fn);
  if (i >= 0) list.splice(i, 1);
}

export function once(type, fn) {
  const stop = on(type, (payload) => { stop(); fn(payload); });
  return stop;
}

export function emit(type, payload) {
  const list = channels.get(type);
  if (!list || list.length === 0) return;
  // Copy: handlers legitimately unsubscribe themselves mid-dispatch (once()).
  const snapshot = list.length === 1 ? list : list.slice();
  for (let i = 0; i < snapshot.length; i++) {
    try {
      snapshot[i](payload);
    } catch (err) {
      reportError(err);
    }
  }
}

let errorSink = null;
export function setErrorSink(fn) { errorSink = fn; }
export function reportError(err) {
  if (errorSink) errorSink(err);
  else console.error(err);
}
