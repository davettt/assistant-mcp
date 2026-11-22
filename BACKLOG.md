# Backlog

## Require the app id in the health reply

`appConnection()` in `src/connection.js` refuses to send an app's token when `/api/health`
names a different app than `assistant.json`, but still accepts a reply with no `app` field,
because the apps add it one by one (platform plan `../plans/2026-11-15-platform-direction.md`,
per-app checklist item 3). Once every connected app (Due Again, Gift Keeper, Client Manager,
Lists & Notes, Budget Planner, DiagramSnap) has shipped item 3, treat a missing id as a
mismatch, raise each app's `needs` version to the release that added it, and change the
"accepts a reply with no id" test in `tests/due-again.test.js` to expect a refusal.

## Data root into @tiongcreative/platform

`dataRoot()` only knows the macOS folder, `~/Library/Application Support`. Move it behind
`@tiongcreative/platform` once that package exists (build-policy R-73; the plan's
"Fix-as-we-go items" and per-app checklist item 7).
