# Router

`route pick --dry --kind sweep --tier C --data-class public brief.txt` ranks offers without launching a builder. `pick` reads a brief file.

`route run --kind sweep --tier C --data-class public 'Reply with exactly: ok'` launches the highest eligible offer in the current working directory. `run` accepts brief text. An empty tier steps one tier up, then one down. Providers without an execution adapter are excluded before tier selection.

Adapters use agy (effort encoded in the slug and passed with `--effort`) or Codex (brief on stdin, explicit effort in `model_reasoning_effort`). Both use the caller's existing credentials and permissions. `--allow-claude` permits Claude selection; it prints a handoff and exits 5 without invoking Claude. Other hard filters still apply.

Codex's plan enables paid overflow. Quota windows below the floor do not exclude it, but auth errors and actual pool cooldowns still do.

Run state lives in `~/.local/state/router/`:

- `availability.json`: pool cooldowns, bad offers with 24-hour expiry, and signed-out plans. Writes use `flock` and atomic rename. A quota failure also excludes that pool for the remainder of the run. Relative `Resets in` durations and ISO reset timestamps are parsed; absent a usable reset, the cooldown is one hour.
- `ledger.jsonl`: launch and outcome events for every attempt, followed by one inject result. Events include model, effort, plan, pool, timestamps, output paths, and a brief hash. A completed process is not a quality label. Historical agy logs are imported once as metadata with null kind and tier.
- `runs/<runid>.out`: final attempt's redacted stdout. `runs/<runid>.log`: redacted stdout/stderr for all attempts. Output and ledger files are mode 0600.

Transient failures retry once after 30 seconds, then fall through. Invalid model IDs disable that offer for 24 hours. Auth failures disable the plan. Empty or sentinel output stops the run. Unknown failures stop rather than guessing a retry policy. Signed-out markers persist until an operator removes the plan's entry under the same `.lock` after restoring login; automatic auth recovery is not implemented yet.

One `cc-link-inject --source route --key <runid>` runs at the end. The output is redacted before selecting its tail. Injection failure returns an error while preserving the result and ledger. Exit codes: 0 success, 1 failure, 2 invalid CLI input, 3 no eligible offer, 5 Claude handoff.

## Evidence scoring (slice 3)

`route explain brief.txt --kind code` reads the same live state as `pick`; it never launches a model. Kind is required; tier defaults to S and data class to public. Kinds also include `cyber` and `architecture`. Excluded candidates retain their explanations, including during a pool cooldown. An evidence ranking is not permission to bypass those exclusions.

Artificial Analysis data is read from `~/.claude/shared/aa-models.json` at runtime, normalized in memory, and never copied into the package. Every numeric leaf of a mapped record becomes `{model, effort, signal, value, src, kind, asof, url}`. Fetch time is the available timestamp, not a claimed evaluation date. Missing files use the table; malformed files fail visibly. There is no fetcher or new dependency. Attribution: Artificial Analysis, https://artificialanalysis.ai.

An explicit release alias map handles decimal slug spelling and Claude shorthand. No fuzzy alias matching or deprecated-model substitution occurs. Unknown AA releases/efforts are listed by `explain`. Codex uses medium when the catalog has no effort; Claude shorthand uses max. These are router defaults, not claims about CLI defaults. Evidence-selected efforts are passed explicitly to Codex and agy. Matching AA and CLI effort names does not establish equal token budgets; no model jobs were run to validate that equivalence.

Profiles live in `src/evidence.ts`. Code groups the duplicated terminal benchmarks and removes stale SWE-bench Pro. Other design weights remain visible even when their sources are unavailable. Sweep's quality weights are normalized; cost and speed enter utility separately. UI's missing Arena sources and writing's missing EQ-Bench/creative Arena scores reduce coverage. Cyber currently falls back to the table; this slice adds no cyber-access eligibility claim.

Quality uses weighted percentiles over the fixed, explicitly mapped evidence cohort, confidence decay (AA 180 days, vendor 365), and the design's 0.15 family regularizer. It does not change with quota. Measured values win over vendor values; missing efforts interpolate only between measured neighbours, without imposing a monotone curve. Then comes the family median, then dropping the signal. All substitutions print their provenance. Family medians do not count as observed offer coverage. At coverage >= 0.3, utility uses evidence; below that it uses the historical score plus kind bonus, marked `(table)`. Existing table tier bands still constrain eligibility.

Until ledger calibration, utility assumes a medium task, difficulty zero, ordinary stakes, `V=10` (`2` for sweep), `p=.45+.47Q`, and batch latency at `.05/minute`. Output tokens scale AA tokens/task to 12,000 at the cohort median; task cost scales AA cost/task by the same factor. Latency is TTFT plus output tokens/speed. Pool fraction is explicitly an uncalibrated `.01 × task dollars` proxy. Shadow price is `.5+2(1-headroom)^2`; reset pace is unknown (`rho=1`). Missing cost/speed inputs use disclosed neutral defaults after the evidence fallback chain. The table quality is divided by 100 and mapped to the same probability/value scale for mixed rankings. No Beta updates or exploration occur; `n=0` means zero labels used by this scorer, not an empty ledger.

OpenAI/Codex and Anthropic/Claude account training opt-outs are recorded as `Parker 2026-11-19`; Google AI Pro remains training. `--data-class parcs`, or a brief mentioning PARCS/Bridgeton, permits only the Claude plan (never Claude via agy). It prints a handoff and exits 5 without launch, even when live exclusions prevent choosing a specific Claude offer. Other blocks remain visible for the caller. Credential detection cannot downgrade `parcs`.

## Slice 4 prerequisites

Join launch and outcome events by run and attempt, distinguish process completion from a quality label, and define labels per kind (CI/merge for code, check results for sweep, explicit ratings for other kinds). Imported logs remain unlabelled. Pool failures, auth failures, handoffs and invalid offers must never increment beta. Pool effort into model × kind until data supports finer cells; gate posterior routing on at least 30 labels per kind. Decay evidence toward its prior rather than shrinking the prior. Fit task cost/pool deltas and success calibration from observed runs, handle selection bias, and keep Claude excluded from exploration. Add convergence, decay, quota-failure and spend-cap simulations before enabling any exploration.
