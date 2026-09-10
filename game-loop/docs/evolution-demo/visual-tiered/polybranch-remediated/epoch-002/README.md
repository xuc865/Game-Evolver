# Polybranch — branching Processing.js mini-game

This directory is the deliverable: a static browser game plus a tiny Node
server for serving it.

## Run

```bash
node server.js
# then open the URL the server prints (default http://localhost:3000)
```

Any static file server pointed at this directory also works, because the game
is plain HTML/CSS/JS — the Node server exists only for convenience and correct
MIME types.

## Controls

* **Arrow keys / W A S D** — steer the ship (see `Arrow_keys.png`).
* **Drag** with the mouse, or a finger on touch screens — the ship flies
  toward your pointer (the tunnel scrolls the other way, the same convention
  as the arrow keys). Either input works at any moment; the keyboard loop is
  unchanged.
* **P** pause · **M** mute · **R** restart after a crash.

## This epoch's improvement

Death shockwave: a crash no longer cuts instantly to a frozen screen. When
the ship hits a branch, two rings expand from the crash point and a short
red heat bleed fades out over ~3.7 s (110 one-shot redraws at 34 ms; the
main loop stays stopped with `noLoop`), so the moment of impact keeps
playing while the tunnel freezes. The rings are drawn over the frozen
layers, and the "RUN OVER - score" popup now finishes its fade instead of
freezing mid-frame. A batch token (`deathFxBatch`) invalidates any pending
redraw chain when `newGame` runs, so overlapping deaths or a fast restart
can never double-advance or leak the effect into the next run, and
`newGame` resets `deathFxFrame` to -1. Purely additive rendering: no
gameplay, input, scoring, or restart logic changed. `getDeathFxFrame()`
exposes the effect frame (-1 while a run is live; the probe hook
`forceGameOverForProbe` triggers the real `Game.gameOver()` path). The boot
probe force-crashes a live run, asserts the fx counter starts and advances
across the one-shot redraws, samples real canvas pixels at the expected
outer-ring radius (`probe-evidence/death-shock.png`), then restarts through
the real `jsNewGame` path and asserts the fx state is clean. The prior
epoch's speed streaks, threat direction marker, drag steering, arrow keys,
pause/mute, and restart are unchanged.

## Layout

| Path | Role |
| --- | --- |
| `index.html` | Entry page; loads the libs, the game script, and the sketch |
| `css/styles.css` | Page/canvas styling |
| `js/script.js` | Game bootstrap and glue code |
| `js/libs/` | Vendored `jquery-1.8.3.min.js`, `processing-1.4.1.min.js`, `processing.js` |
| `polybranch.pjs` | Processing sketch with the core game loop |
| `svg/level*.svg` | Level art/geometry (levels 2–12) |
| `sound/` | Bell tones (`_bell0..4`) and `end` chime, in `.mp3` + `.ogg` pairs |
| `server.js` | Minimal static file server |
| `tests/boot-probe.js`, `probe-evidence/` | Boot probe used to smoke-test that the page boots without console errors |

## Known limitations

* Verified only by file inventory and a boot probe in a prior session; the
  full gameplay loop has not been re-verified end to end in this session.
* The `.pjs` sketch and `script.js` are the seed implementation plus additive
  HUD/feedback/steering layers; audio uses plain `<audio>`/fallback and may
  behave differently across browsers (hence the mp3/ogg pairs).
* Levels 2–12 exist as SVG assets; any levels beyond that are not present.
