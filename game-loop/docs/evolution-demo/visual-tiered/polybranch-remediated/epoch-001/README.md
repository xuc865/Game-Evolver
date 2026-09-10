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

Proximity warning ring: a red ring now surrounds the ship whenever a live
branch is inside the 120 px danger range. The ring tightens, thickens and
brightens as the nearest branch closes in, so a close call is signalled
*before* it happens instead of only being rewarded after the fact. The
distance is measured from the ship to the nearest rendered branch vertex of
layers at the ship's plane (eased distance 0.9–1.15 — the same band the
collision test uses), so distant layers drawn small around the screen center
never false-trigger. The boot probe forces a branch to 34 px, asserts the
sketch's danger level rises, samples real canvas pixels to confirm the ring
renders (`probe-evidence/danger-ring.png`), then releases the hold and asserts
the ring tracks live proximity. Drag steering, arrow keys, pause/mute,
restart, and all other HUD paths are unchanged.

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
