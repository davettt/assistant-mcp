# Changelog

## [0.1.0] - 2026-10-18

### Added

- MCP server over stdio (`src/index.js`) for Claude Desktop and Claude Code, with tools `whats_on` (upcoming items across every available app), `open_app` (opens an app only after the user agrees), and Due Again tools `due_again_items`, `due_again_history`, `due_again_add_item` (category given by name; a miss returns the category list) and `due_again_complete`.
- Gift Keeper tools: `gift_keeper_upcoming`, `gift_keeper_people`, `gift_keeper_add_idea` (person given by name; a miss returns the people list) and `gift_keeper_mark_gift_given`; Gift Keeper occasions appear in `whats_on`. End-to-end test against a real Gift Keeper server (`tests/gift-keeper.test.js`).
- App discovery and auth (`src/connection.js`): reads each app's per-launch `local_data/assistant.json` (port, pid, token) under `~/Library/Application Support` (or `TC_DATA_ROOT`), checks the process and `/api/health`, and calls the app's API on 127.0.0.1 with a Bearer token; no network listener of its own.
- Tests: `tests/due-again.test.js` runs a real Due Again server on a temp data folder and drives this server through the SDK stdio client (tool listing, not-enabled state, reads, a completion, the app's validation error, revocation); `tests/dates.test.js`.
- Release workflow (`.github/workflows/publish.yml`): on a `v*` tag, validates, tests and publishes to npm through trusted publishing with automatic provenance; the tag must match `package.json`. `publishConfig.access` set to public for the scoped name.
- Project scaffold from build-policy (CI, husky, allowlist, lint, prettier), MIT licence.
