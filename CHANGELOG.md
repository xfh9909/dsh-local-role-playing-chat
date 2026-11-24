# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-24

First usable version: the roleplay app lives inside DSH.

### Added

- `sidebar.panellist` row「角色扮演」(order 40) and the `main` keyed panel
  `roleplay`, which hosts the app in a same-origin iframe on `/rp/`.
- Host routes: `prefix /rp/api` (status, SSE chat passthrough, migration
  staging, settings, backups) and `prefix /rp` (static app with the
  `boot.js` shim injected into `index.html`).
- Browser shim `static/boot.js`: `rp_` localStorage prefix, `rp_chat_db`
  IndexedDB name, `/api/* → /rp/api/*` fetch rewrite, embed-mode role mode
  and an exit postMessage from the app's back button.
- Migration staging endpoint with CORS open to `file://`/legacy origins and a
  `data` field compatible with the app's own `migrate.js`.
- `scripts/sync-static.mjs` to copy the app's build output in, with `--build`
  to run the app build first.
- `scripts/dev-server.mjs` standalone harness for the Host half.
- Tests for static serving, API routes, trust checks and SSE passthrough
  (`node --test`).

### Known limits

- Panel switches rebuild the iframe, so unsent drafts are lost.
- The iframe does not follow the host theme.
- `/rp/*` is guarded by loopback + same-origin checks only, not by identity.
