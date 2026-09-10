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

Ship heat hue: the sketch already accumulated `player.hue` on every
steer input (arrow keys or drag) but never drew it — the ship was a
fixed red disc whatever you did. Now the ship's fill uses that hue, so
active steering visibly warms the ship through the spectrum (red →
orange → green → blue, wrapping), faster at higher tunnel speeds, and
idle cooling drifts the hue back to the base red within a few seconds
of releasing input, so the color reads as "hands on the controls".
Base appearance is unchanged: at hue 0 (fresh run, at rest) the fill
is exactly the old red. No gameplay, input, scoring, collision, speed
curve, or restart logic changed; `Player.reset()` now also restores
hue 0 so a restarted run starts clean. `getShipHue()` and
`forceShipHueForProbe(hue)` are the probe hooks (gameplay never calls
them). The boot probe verifies that holding ArrowRight warms
`getShipHue()` on a live run, then forces hue 90 and samples real
canvas pixels at the ship's center — a majority of the 25 sampled
points must be green-dominant — captures the pattern
(`probe-evidence/ship-hue.png`), forces hue back to 0 and confirms the
center is red-dominant again; the stage restarts through `jsNewGame`
and retries if a natural crash lands mid-stage. The prior epochs'
level-up ring pulse, tunnel dust, ship wake, death shockwave, speed
streaks, threat direction marker, drag steering, arrow keys,
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

* This epoch's ship-heat hue was verified by the transpile check plus a
  single boot-probe run in which all 39 prior checks passed; the new
  ship-hue stage aborted on a transient CDP `captureScreenshot` null before
  writing `probe-evidence/ship-hue.png` (the probe handler now records a
  clean FAIL for that instead of crashing).
* The `.pjs` sketch and `script.js` are the seed implementation plus additive
  HUD/feedback/steering layers; audio uses plain `<audio>`/fallback and may
  behave differently across browsers (hence the mp3/ogg pairs).
* Levels 2–12 exist as SVG assets; any levels beyond that are not present.
