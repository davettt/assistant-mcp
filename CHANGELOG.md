# Changelog

## [0.3.0] - 2026-10-19

### Added

- Lists & Notes can now be changed, with Lists & Notes 1.23.0 or later: `lists_and_notes_add_items`, `lists_and_notes_update_items` (tick, untick, reword or annotate items named by their text), `lists_and_notes_add_list`, `lists_and_notes_add_note` and `lists_and_notes_update_note` (append, replace or rename). Changes to an existing list or note send the `modified` stamp last read; if the user changed it in the meantime the app refuses, and the tool re-reads and retries once. Item ids are always sent back. An older Lists & Notes gets a message saying which version writes need. No delete tool. End-to-end test against the real 1.23.0 server.

## [0.2.0] - 2026-10-19

### Added

- `npx @tiongcreative/assistant-mcp install` sets the assistant up in Claude Desktop: adds one entry to its config file with the full path to npx (a desktop app cannot see the shell's PATH), keeps a backup, refuses to touch a file it cannot parse, and prints the next steps. `uninstall` removes the entry; `status` reports it. `--allow-fresh` passes npm's release-age override into the entry for Macs that refuse packages younger than a few days. Unit tests cover create, merge, idempotence, corrupt files and removal.

### Changed

- README setup is now the one-command path.

## [0.1.1] - 2026-10-19

### Changed

- Release workflow stages each tagged version on npm instead of publishing it; the developer promotes it on npmjs.com with 2FA, so the workflow alone can never publish. First release through the trusted publisher; 0.1.0 was published by hand.

## [0.1.0] - 2026-10-18

### Fixed

- Gift Keeper dates came out a day early east of UTC: the occasion date is local midnight as an ISO timestamp and was cut to its UTC day; it is now formatted in local time (found on real data, 2026-10-18)
- `package.json` version set back to 0.1.0: a Gift Keeper version bump had been run in this folder by mistake and committed as 1.3.0; nothing was published under that number

### Added

- MCP server over stdio (`src/index.js`) for Claude Desktop and Claude Code, with tools `whats_on` (upcoming items across every available app), `open_app` (opens an app only after the user agrees), and Due Again tools `due_again_items`, `due_again_history`, `due_again_add_item` (category given by name; a miss returns the category list) and `due_again_complete`.
- Gift Keeper reads `gift_keeper_ideas` (the ideas pool, including ideas not tied to an occasion) and `gift_keeper_gifts` (every tracked gift by stage), both filterable by person. Found in use: asking what gifts were available only showed gifts already attached to an occasion.
- Change tools so every app can be edited, not only added to: Due Again `update_item`, `reschedule`, `skip`; Gift Keeper `update_gift`, `add_person`, `add_occasion`, `complete_occasion`; Client Manager `add_client`, `add_job`, `update_job`. Each returns the changed record and refuses a call with nothing to change.
- Tools are registered only for apps installed on this Mac (app bundle in Applications, or a data folder), checked at start-up. An installed app with the switch off still says so; an app the user does not have is simply absent, so the assistant never tells them to enable it. `whats_on` says which apps it works with when none are installed.
- Client Manager: `client_manager_update_task` (move the due date, change status, edit title or notes) and `client_manager_update_reminder` (complete, snooze, move or edit; completing a recurring reminder lets the app create the next one). Found in use: the assistant could add a task but not move an overdue one to today.
- Lists & Notes tools, read-only: `lists_and_notes_lists` (all lists, or one by name with its items), `lists_and_notes_notes` (search titles, previews, summaries and tags) and `lists_and_notes_note` (the full markdown of one note by title). End-to-end test against a real Lists & Notes server.
- Client Manager tools: `client_manager_reminders`, `client_manager_tasks`, `client_manager_invoices` (with totals and balance from `?totals=1`), `client_manager_client`, `client_manager_add_reminder`, `client_manager_add_task`, `client_manager_log_activity`; reminders, dated tasks and invoices owing appear in `whats_on`. End-to-end test against a real Client Manager server. Apps may name their token file (`tokenFile`) when it is not under `local_data`.
- Gift Keeper tools: `gift_keeper_upcoming`, `gift_keeper_people`, `gift_keeper_add_idea` (person given by name; a miss returns the people list) and `gift_keeper_mark_gift_given`; Gift Keeper occasions appear in `whats_on`. End-to-end test against a real Gift Keeper server (`tests/gift-keeper.test.js`).
- App discovery and auth (`src/connection.js`): reads each app's per-launch `local_data/assistant.json` (port, pid, token) under `~/Library/Application Support` (or `TC_DATA_ROOT`), checks the process and `/api/health`, and calls the app's API on 127.0.0.1 with a Bearer token; no network listener of its own.
- Tests: `tests/due-again.test.js` runs a real Due Again server on a temp data folder and drives this server through the SDK stdio client (tool listing, not-enabled state, reads, a completion, the app's validation error, revocation); `tests/dates.test.js`.
- Release workflow (`.github/workflows/publish.yml`): on a `v*` tag, validates, tests and stages the version on npm through trusted publishing with automatic provenance; the developer promotes it on npmjs.com with 2FA. The tag must match `package.json`. `publishConfig.access` set to public for the scoped name.
- Project scaffold from build-policy (CI, husky, allowlist, lint, prettier), MIT licence.
