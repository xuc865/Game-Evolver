// core/clock.js — the ONE clock (§0.6). rAF driven, dt clamped to [0, 1/20].
//
// Allocation discipline: the subscriber list is a plain array walked by index;
// add/remove during a tick go into pending arrays that are drained between
// frames, so a frame never allocates and never mutates the array it is walking.

const MAX_DT = 1 / 20;   // §0.6. A 3s tab stall must not teleport a card.

const subs = [];
const pendingAdd = [];
const pendingRemove = [];

let running = false;
let ticking = false;
let rafId = 0;
let last = 0;
let elapsed = 0;
let frames = 0;

export function subscribe(fn) {
  if (ticking) pendingAdd.push(fn);
  else if (subs.indexOf(fn) < 0) subs.push(fn);
  start();
  return () => unsubscribe(fn);
}

export function unsubscribe(fn) {
  if (ticking) { pendingRemove.push(fn); return; }
  const i = subs.indexOf(fn);
  if (i >= 0) subs.splice(i, 1);
}

/** Seconds since the clock first ran. Presentation only — never game logic. */
export function now() { return elapsed; }
export function frameCount() { return frames; }
export function subCount() { return subs.length; }

function drain() {
  for (let i = 0; i < pendingAdd.length; i++) {
    if (subs.indexOf(pendingAdd[i]) < 0) subs.push(pendingAdd[i]);
  }
  pendingAdd.length = 0;
  for (let i = 0; i < pendingRemove.length; i++) {
    const j = subs.indexOf(pendingRemove[i]);
    if (j >= 0) subs.splice(j, 1);
  }
  pendingRemove.length = 0;
}

function tick(t) {
  rafId = requestAnimationFrame(tick);
  let dt = (t - last) / 1000;
  last = t;
  if (!(dt > 0)) dt = 0;
  if (dt > MAX_DT) dt = MAX_DT;
  elapsed += dt;
  frames++;

  ticking = true;
  for (let i = 0; i < subs.length; i++) subs[i](dt, elapsed);
  ticking = false;
  drain();

  if (subs.length === 0) stop();
}

export function start() {
  if (running) return;
  running = true;
  last = performance.now();
  rafId = requestAnimationFrame(tick);
}

export function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

/** Resolve after `ms`, on the same clock, so the choreographer has one time source. */
export function wait(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let left = ms / 1000;
    const step = (dt) => {
      left -= dt;
      if (left <= 0) { unsubscribe(step); resolve(); }
    };
    subscribe(step);
  });
}
