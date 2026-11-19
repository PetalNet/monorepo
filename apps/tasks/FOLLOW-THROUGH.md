# Follow-through controls

`/janet/follow-through` shows open promises, their source conversations, reminder delivery state, and gallery questions for the signed-in viewer. Operators can pause ledger delivery, snooze an item for a day, or drop it with a recorded reason. The page distinguishes captured progress, reconciliation needed, and pending reminders. It never runs a sweep or changes the Hermes scheduler.

The API uses the existing Effect services and SvelteKit authentication boundary. Configure `FOLLOW_THROUGH_OPERATORS` with a comma-separated allowlist of Authentik usernames. The default is no operators, including for reads. Keep the app behind the existing trusted authentication proxy; its asserted user header is not an internet authentication mechanism by itself.

Set `FOLLOW_THROUGH_COMMAND_ARGV` to a JSON array for the fixed command that runs `packages/harness-hooks/src/promise-control.ts` on the ledger host. The command receives one JSON request on stdin and returns a validated snapshot on stdout. Use the existing SSH transport when the app and ledger run on different hosts; do not expose the ledger file over HTTP. Request data cannot choose a command or path. The bridge must configure `PROMISE_STORE` and `HERMES_HOME` for the intended host.

An unconfigured command, unavailable store, malformed reply, or command timeout returns 503. An unauthorized viewer returns 403 before launching the bridge. Mutations require an Origin header matching the request URL, including for JSON requests. The CLI accepts snapshot, pause, resume, drop, and snooze only, and refuses a missing store rather than creating an empty one.

Pausing the ledger and pausing `promise-sweep` are separate controls. Enabling ledger delivery on this page leaves a paused scheduler paused. Keep the production scheduler paused until the redesigned ledger has passed review and landed on main.
