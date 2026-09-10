// ui/comms.js — Mission Log, chat, emotes.
//
// XSS discipline from the old client is kept verbatim: chat text and player
// names only ever enter the DOM through textContent (§0.4, §2). There is no
// path in this file that turns a string into markup.

import { $, el, clear, setClass } from '../core/dom.js';
import * as bus from '../core/bus.js';
import { EVENTS } from '../core/bus.js';
import * as send from '../net/send.js';
import { store } from '../state/store.js';
import * as pointer from '../interact/pointer.js';
import * as table from '../table/index.js';

const MAX_CHAT = 50;
let scope = 'room';

/* ── the Mission Log moved (P8) ───────────────────────────────────────────
 *
 * This file used to append `game.log` prose into #log, matching the longest
 * suffix of what it had rendered against the arriving 40-line window. That
 * whole mechanism is gone: ui/journal.js now owns #log and builds it from the
 * STRUCTURED event stream (§4) instead, which is what lets a set completion
 * look different from a bank, lets the cards in a line be inspected, and lets
 * the record survive past the tail the server sends.
 *
 * The prose window is not lost — journal.js's "Transcript" tab renders
 * `store.snapshot.log` verbatim, which is the one place prose still wins.
 * Chat, emotes and the software-keyboard handling stay here; they were never
 * part of the log.
 */

function renderChat() {
  const box = $('chat-msgs');
  if (!box) return;
  clear(box);
  for (const msg of store.chat[scope] || []) {
    box.appendChild(el('div', { class: 'chat-msg' }, [
      el('span', { class: 'chat-who', text: `${msg.name}: ` }),
      el('span', { class: 'chat-text', text: msg.text }),
    ]));
  }
  box.scrollTop = box.scrollHeight;
  for (const tab of document.querySelectorAll('.chat-tab')) {
    setClass(tab, 'is-on', tab.dataset.scope === scope);
  }
}

function pushChat(msg) {
  const key = msg.scope === 'global' ? 'global' : 'room';
  const list = store.chat[key];
  list.push(msg);
  if (list.length > MAX_CHAT) list.shift();
  if (key !== scope) store.unread[key]++;
  renderChat();
}

function floatEmote(playerId, name, text) {
  const host = $('emotes');
  if (!host) return;
  const board = table.boardEl(playerId);
  const bubble = el('div', { class: 'emote-bubble', text: `${name}: ${text}` });
  if (board) {
    const rect = board.getBoundingClientRect();
    bubble.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    bubble.style.top = `${Math.round(rect.top + 8)}px`;
  }
  host.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2400);
}

/* ── the software keyboard (§2, restored §P7.6) ────────────────────────────
 *
 * §2 lists "visualViewport keyboard handling" among the things kept from the
 * old client. It was kept nowhere outside fx/overlay.js, and the cost was
 * measured: on a 390×844 phone with the iOS keyboard up, #chat-input and SEND
 * both sat at bottom 835 — 327px under the keyboard. You cannot see what you
 * are typing.
 *
 * Why it happens: iOS does not shrink the LAYOUT viewport for the keyboard, so
 * a `position:absolute; bottom:0` panel keeps sizing to the full 844px. Only
 * `visualViewport` knows. This publishes the occluded height as `--kb-inset` on
 * <html>; content.css lifts the side panel by exactly that (OVERRIDE 3).
 *
 * The value is written on the root, not on .side, so anything else that has to
 * dodge the keyboard later can read it without another listener.
 */
function keyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return 0;
  const occluded = window.innerHeight - (vv.height + vv.offsetTop);
  // Under ~80px it is address-bar chrome, not a keyboard; clamping avoids a
  // panel that twitches every time Safari's toolbar collapses on scroll.
  return occluded > 80 ? Math.round(occluded) : 0;
}

function syncKeyboard() {
  const inset = keyboardInset();
  const root = document.documentElement;
  const current = root.style.getPropertyValue('--kb-inset');
  const next = `${inset}px`;
  if (current !== next) root.style.setProperty('--kb-inset', next);
  setClass(document.body, 'kb-open', inset > 0);
  // The composer is the reason the keyboard is up; keep it in view even when
  // the panel is taller than what is left of the viewport.
  if (inset > 0 && document.activeElement === $('chat-input')) {
    $('chat-msgs') && ($('chat-msgs').scrollTop = $('chat-msgs').scrollHeight);
  }
}

function watchKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  vv.addEventListener('resize', syncKeyboard);
  vv.addEventListener('scroll', syncKeyboard);
  window.addEventListener('resize', syncKeyboard);
  $('chat-input')?.addEventListener('focus', syncKeyboard);
  $('chat-input')?.addEventListener('blur', () => setTimeout(syncKeyboard, 120));
  syncKeyboard();
}

export function mount() {
  watchKeyboard();
  pointer.registerActions({
    'chat-scope': (elx) => { scope = elx.dataset.scope === 'global' ? 'global' : 'room'; store.unread[scope] = 0; renderChat(); },
    'send-chat': () => {
      const input = $('chat-input');
      const text = (input?.value || '').trim();
      if (!text) return;
      send.chat(text, scope);
      input.value = '';
    },
  });

  $('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    document.querySelector('[data-action="send-chat"]')?.click();
  });

  // NO STATE_APPLIED subscription here, and that is load-bearing: this handler
  // used to reset the journal on every snap, and snap fires on ANY first sight
  // whose tail does not begin at seq 1 (store.js applyState) — i.e. every
  // reload/reconnect into a game past event 120. journal.mount runs first, so
  // the just-ingested 120-event tail was wiped in the same broadcast; measured
  // 2026-08-08 off mid-game.json (eventSeq 141, tail seq 22–141):
  // journal.entries()===0 one STATE_APPLIED after ingest had merged all 120.
  // The journal owns its record and its own reset (a `fresh` first sight, a seq
  // restart, a game_start event); chat self-heals from NET_CHAT_HISTORY.
  bus.on(EVENTS.NET_CHAT, (msg) => pushChat(msg.msg));
  bus.on(EVENTS.NET_CHAT_HISTORY, (msg) => {
    const key = msg.scope === 'global' ? 'global' : 'room';
    store.chat[key] = Array.isArray(msg.msgs) ? msg.msgs.slice(-MAX_CHAT) : [];
    renderChat();
  });
  bus.on(EVENTS.NET_EMOTE, (msg) => floatEmote(msg.playerId, msg.name, msg.text));
}
