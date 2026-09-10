# Archived: PR #1 — Harden and polish multiplayer gameplay

**8tp** · opened 2026-08-06T17:27:42Z · MERGED

Preserved from `8tp/chudopoly` before the repository was recreated to clear an
inaccurate fork relationship. The git history it describes is intact in the new repo.

---

## Summary

- harden WebSocket input, origin handling, reconnect credentials, and browser security headers
- fix card conservation, stale/duplicate selections, action resolution, finished-game guards, and rematches
- improve the player journey with quick play, invite sharing, reconnects, guided first game, accessibility, and match summaries
- cache-bust browser assets and recover failed lobby connections so Create, Join, and Quick Play remain usable after deploys
- add CI, syntax checks, integration/game/protocol/UI tests, documentation, and maintained dependencies

## Regression fix

Cloudflare applied a four-hour browser cache to the original JavaScript URLs. After the UI switched from inline handlers to `data-action` delegation, clients could receive new HTML with an old `init.js`, leaving the lobby buttons inert. Versioned asset URLs now keep HTML and JavaScript in sync, HTML is served with `no-store`, and failed WebSocket attempts re-enable the controls with a visible error.

## Verification

- `npm run check`
- `npm test` (19 passing)
- `npm audit --audit-level=high` (0 vulnerabilities)
- `node simulate.js 1000`

## Deployment

- prepared for deployment to the existing Railway Chudopoly production service

