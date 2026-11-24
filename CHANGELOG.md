# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-11-24

Panel polish after a first hands-on pass: the two ✕ marks did nothing and are gone,
and the app now follows the host.

### Changed

- **Removed both close marks.** The floating ✕ over the panel and the ✕ the shim had
  painted over the app's back arrow are gone. The back arrow is hidden inside the
  panel instead (it points at the app's other internal mode, not at DSH).
- **Exit lives in the app's own header**, as a normal `header button`-styled
  「回到对话」 at the far right; it posts `dsh-roleplay:exit` and the host switches to
  the Conversation. Same exit also works by picking any session in the DSH sidebar.
- **Fixed the exit path.** The panel now takes `layout` from its injection scope
  (`ctx.inject(['slots','layout'])`) instead of reaching for `ctx.layout` on the
  plugin context, which throws for an undeclared service — that is why neither ✕
  did anything.
- **Theme and type follow the host:** `<body data-ds-dark-theme>` maps onto the app's
  `body.dark` and keeps following through a `MutationObserver`; the app's font family
  takes the host's body font.
- **Panel clips to the host panel radius** (`--dsh-windows-content-radius`).

### Added

- Boot-shim tests for the header exit button, the hidden back arrow, host theme
  mapping and standalone no-ops (13 cases in `test/boot.test.mjs`).

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
