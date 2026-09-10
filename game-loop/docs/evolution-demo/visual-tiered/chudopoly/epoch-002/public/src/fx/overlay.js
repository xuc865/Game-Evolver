// fx/overlay.js — the FX substrate: one canvas, one flash plate, one text layer.
//
// WHY A CANVAS AND NOT DOM NODES. A win throws ~380 confetti pieces. As DOM
// that is 380 nodes the compositor has to lay out, paint and composite every
// frame on top of a table that already carries ~60 card nodes; on the emulated
// 390×844 DPR3 phone that is the frame budget gone. One canvas is one composited
// layer whose per-frame cost is fill-rate, and fill-rate is the one thing a
// phone GPU has spare. Floating text stays DOM (12 nodes, real text, selectable
// by a screen reader if it ever needs to be) — see fx/floaters.js.
//
// OWNERSHIP. fx/ may not touch public/index.html or public/style/ (§1), so this
// module builds its own DOM and its own stylesheet at runtime. Everything it
// creates is prefixed `fx-` and nothing else in the client selects on that
// prefix — grep `fx-` across public/ and public/src/ returns only this file.
//
// IDLE COST. Nothing exists until the first effect: no node, no canvas backing
// store, no resize listener, no clock subscriber. When the last effect dies the
// root goes `display:none` (see setActive) so the compositor drops the layer,
// and tools/screenshot.mjs captures a page that is byte-identical to one where
// fx/ was never imported.

const DPR_CAP = 2;        // 3× on a 390×844 phone is 3.0 Mpx of confetti fill for
                          // no visible gain — the pieces are 6px rects.

let root = null;
let canvas = null;
let ctx2d = null;
let flashPlate = null;
let floatLayer = null;
let active = false;

let cssW = 0, cssH = 0, dpr = 1;

const CSS = `
#fx-root{position:fixed;inset:0;z-index:97;pointer-events:none;display:none;
  contain:layout style paint;overflow:hidden}
#fx-root.is-on{display:block}
#fx-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#fx-flash{position:absolute;inset:0;pointer-events:none;opacity:0;
  will-change:opacity;mix-blend-mode:screen}
#fx-float{position:absolute;inset:0;pointer-events:none}
/* rem, deliberately: base.css sets html font-size to var(--s), so 1rem IS
   §6's one scale unit and this text tracks the design system on every viewport
   without fx/ knowing anything about it (1.5rem = 24.8px desktop, 21.5px phone).
   1.5, not the 1.05 this shipped with first: at 1.05 a "-9M" on the 1280×720
   capture was 17px sitting on a 55px card and read as part of the card's own
   micro-labelling rather than as an event. */
.fx-text{position:absolute;left:0;top:0;pointer-events:none;opacity:0;
  font:900 1.5rem/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  letter-spacing:.02em;white-space:nowrap;
  text-shadow:0 1px 2px rgba(0,0,0,.92),0 0 12px rgba(0,0,0,.7);
  will-change:transform,opacity;transform:translate3d(0,0,0)}
/* THE TWO SHOUTS ("CHUD!", "OPSEC!") — §P9 FEEL round 3. A money delta lands on
   felt; a label lands wherever the crime was, which is usually ON an opponent
   board, and the drop-shadow above is tuned for dark navy. MEASURED: "CHUD!"
   rendered low-contrast against the opponent boards behind it. A solid 3px dark
   ring (four offsets + a tight glow) makes the glyphs legible against any
   surface the table can put under them, which is what a once-a-game shout has
   to be. Same colour, same size — only the separation from its background. */
.fx-text.is-label{
  text-shadow:
    0 0 3px rgba(0,0,0,1),0 0 3px rgba(0,0,0,1),
    2px 0 2px rgba(0,0,0,.95),-2px 0 2px rgba(0,0,0,.95),
    0 2px 2px rgba(0,0,0,.95),0 -2px 2px rgba(0,0,0,.95),
    0 0 16px rgba(0,0,0,.85)}
`;

/** Build the substrate. Called on the first effect and never again. */
export function ensure() {
  if (root) return root;

  const style = document.createElement('style');
  style.id = 'fx-style';
  style.textContent = CSS;                       // text, never HTML (§0.4)
  document.head.appendChild(style);

  root = document.createElement('div');
  root.id = 'fx-root';
  root.setAttribute('aria-hidden', 'true');

  canvas = document.createElement('canvas');
  canvas.id = 'fx-canvas';
  // alpha:true is required (we composite over the table); desynchronized lets
  // Chrome skip a frame of latency on the overlay, which it may because nothing
  // reads this canvas back.
  ctx2d = canvas.getContext('2d', { alpha: true, desynchronized: true });

  flashPlate = document.createElement('div');
  flashPlate.id = 'fx-flash';

  floatLayer = document.createElement('div');
  floatLayer.id = 'fx-float';

  root.appendChild(canvas);
  root.appendChild(flashPlate);
  root.appendChild(floatLayer);
  document.body.appendChild(root);

  resize();
  addEventListener('resize', resize, { passive: true });
  if (typeof visualViewport !== 'undefined' && visualViewport) {
    visualViewport.addEventListener('resize', resize, { passive: true });
  }
  return root;
}

function resize() {
  if (!canvas) return;
  const w = Math.max(1, innerWidth | 0);
  const h = Math.max(1, innerHeight | 0);
  const d = Math.min(DPR_CAP, devicePixelRatio || 1);
  if (w === cssW && h === cssH && d === dpr) return;
  cssW = w; cssH = h; dpr = d;
  canvas.width = Math.round(w * d);
  canvas.height = Math.round(h * d);
}

/**
 * Show/hide the whole overlay. `display:none` rather than opacity so the
 * compositor drops the layer entirely — the point of the idle-cost rule.
 */
export function setActive(on) {
  if (!root || active === !!on) return;
  active = !!on;
  root.classList.toggle('is-on', active);
  if (!active && ctx2d) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}

export function isActive() { return active; }
export function ctx() { return ctx2d; }
export function flashEl() { return flashPlate; }
export function floatEl() { return floatLayer; }
export function width() { return cssW; }
export function height() { return cssH; }
export function scale() { return dpr; }

/** Clear the whole backing store. One call per painted frame. */
export function clear() {
  if (ctx2d) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}
