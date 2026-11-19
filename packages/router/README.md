# Router

`route pick --dry --kind sweep --tier C --data-class public brief.txt` ranks offers without launching a builder. `pick` reads a brief file.

`route run --kind sweep --tier C --data-class public 'Reply with exactly: ok'` launches the highest eligible offer in the current working directory. `run` accepts brief text. An empty tier steps one tier up, then one down. Providers without an execution adapter are excluded before tier selection.

Adapters use agy (effort encoded in the slug) or Codex (brief on stdin, explicit effort in `model_reasoning_effort`). Both use the caller's existing credentials and permissions. `--allow-claude` permits Claude selection; it prints a handoff and exits 5 without invoking Claude. Other hard filters still apply.

Codex's plan enables paid overflow. Quota windows below the floor do not exclude it, but auth errors and actual pool cooldowns still do.

Run state lives in `~/.local/state/router/`:

- `availability.json`: pool cooldowns, bad offers with 24-hour expiry, and signed-out plans. Writes use `flock` and atomic rename. A quota failure also excludes that pool for the remainder of the run. Relative `Resets in` durations and ISO reset timestamps are parsed; absent a usable reset, the cooldown is one hour.
- `ledger.jsonl`: launch and outcome events for every attempt, followed by one inject result. Events include model, effort, plan, pool, timestamps, output paths, and a brief hash. A completed process is not a quality label. Historical agy logs are imported once as metadata with null kind and tier.
- `runs/<runid>.out`: final attempt's redacted stdout. `runs/<runid>.log`: redacted stdout/stderr for all attempts. Output and ledger files are mode 0600.

Transient failures retry once after 30 seconds, then fall through. Invalid model IDs disable that offer for 24 hours. Auth failures disable the plan. Empty or sentinel output stops the run. Unknown failures stop rather than guessing a retry policy. Signed-out markers persist until an operator removes the plan's entry under the same `.lock` after restoring login; automatic auth recovery is not implemented yet.

One `cc-link-inject --source route --key <runid>` runs at the end. The output is redacted before selecting its tail. Injection failure returns an error while preserving the result and ledger. Exit codes: 0 success, 1 failure, 2 invalid CLI input, 3 no eligible offer, 5 Claude handoff.

## Next slice

Read the local `aa-models.json` into evidence rows keyed by canonical model and effort. Keep AA data and its puller outside this package. Resolve catalog IDs against AA `slug` and `suffix` explicitly; preserve source URLs, timestamps, missing values, and measured/vendor/prior distinctions. Build per-kind scores with coverage and `route explain`, group overlapping benchmarks, and renormalize weights over supported signals. Missing evidence must leave routing usable.

Use labelled sanity cases rather than treating agreement with historical picks as quality. Validate effort equivalence before interpolating effort curves. Keep execution availability failures separate from future per-kind quality labels; imported logs are not labelled outcomes. The AA licensing and attribution questions from the design critique remain prerequisites to publishing evidence or a puller.
