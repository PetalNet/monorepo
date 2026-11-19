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

Failure classification and reset dates read only stderr lines beginning `AGY_ERROR:` or `ERROR:`, after checking the exit status. Builder stdout and unprefixed transcript text cannot trigger quota cooldowns, sign-outs, invalid-offer marks or transient retries.

One `cc-link-inject --source route --key <runid>` runs at the end. The output is redacted before selecting its tail. Injection failure returns an error while preserving the result and ledger. Exit codes: 0 success, 1 failure, 2 invalid CLI input, 3 no eligible offer, 5 Claude handoff.

## Evidence scoring (slices 3 and 3b)

`route explain brief.txt --kind code` reads the same live state as `pick`; it never launches a model. Kind is required; tier defaults to S and data class to public. Kinds also include `cyber` and `architecture`. Excluded candidates retain their explanations, including during a pool cooldown. An evidence ranking is not permission to bypass those exclusions.

Artificial Analysis data is read from `~/.claude/shared/aa-models.json` at runtime, normalized in memory, and never copied into the package. Every numeric leaf of a mapped record becomes `{model, effort, signal, value, src, kind, asof, url}`. Fetch time is the available timestamp, not a claimed evaluation date. Missing files reduce coverage; malformed files fail visibly. Attribution: Artificial Analysis, https://artificialanalysis.ai.

`route pull-evidence` downloads the open sources below, then atomically writes `~/.local/state/router/evidence-open.json`. `pick`, `run` and `explain` merge that artifact with AA. Raw responses and fetch metadata stay in `~/.local/state/router/evidence-raw/`, mode 0600, with a 24-hour cache. Requests are sequential, at least one second apart, capped at 32 MiB and 30 seconds each, with no retries on denial or rate limiting. A failed source retains its previous rows and dates with a visible note. Pulling exits 1 when no rows are available. No benchmark data belongs in git.

| Source      | Official download                                                                                                                                   | Signals and provenance                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| LMArena     | [Arena's Hugging Face dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), via dataset API                                     | WebDev, text overall, creative writing; measured; publication date; CC BY 4.0                                  |
| DesignArena | [Documented leaderboard API](https://docs.designarena.ai/api-reference/leaderboard)                                                                 | Website models; measured; board update date; approved `DESIGNARENA_API_KEY` required                           |
| EQ-Bench    | [Creative Writing v3](https://eqbench.com/creative_writing.html) and [EQ-Bench 4](https://eqbench.com/eqbench4.html), official site's data literals | Creative writing and emotional/social intelligence separately; measured; fetch date for v3, export date for v4 |
| Epoch AI    | [Benchmarking hub CSV ZIP](https://epoch.ai/benchmarks/use-this-data)                                                                               | GPQA Diamond, MirrorCode, SWE-bench Verified; measured; run date when present; CC BY 4.0                       |
| CyberGym    | [Official leaderboard JSON](https://www.cybergym.io/cybergym/)                                                                                      | Level 1, single trial, model entries only; vendor submissions with reporter and harness retained               |
| Cybench     | [Official leaderboard CSV](https://cybench.github.io/)                                                                                              | Unguided end-to-end solve rate; model-card footnotes remain vendor evidence; fetch date                        |

Downloads without a stated data license remain internal; none are republished. DesignArena's API is the authorized path; missing credentials produce a gap, without scraping its pages. Python 3 supplies CSV, ZIP and HTTP support from its standard library, avoiding new dependencies. It is required for pulls and the package's tests; selection still runs in Node.js.

An explicit release alias map handles decimal slug spelling and Claude shorthand. No fuzzy matching, preview substitution or generation substitution occurs. `explain` lists unknown source names. Open rows add `reporter` and `halfLifeDays`; effort not published by a source stays `unspecified`. Such rows contribute model-level coverage and are labeled accordingly, without claiming an effort match.

Explicit catalog efforts stay fixed. For unsuffixed Codex offers, selection compares the default medium with measured efforts on the requested kind's signals. If any candidate reaches coverage 0.5, selection maximizes utility within that group; otherwise it uses the existing 0.3 evidence threshold and table fallback. This coverage floor avoids choosing a sparse estimate over a well-observed alternative. Offer IDs, bans and tier bands stay attached to the catalog entry. Claude shorthand defaults to max. Selected efforts are passed explicitly to adapters. Matching source and CLI effort names does not establish equal token budgets; no model jobs were run to validate that equivalence.

Profiles live in `src/evidence.ts`. UI keeps the design weights, including the unavailable DesignArena weight. Writing allocates 0.25 to Arena creative, 0.10 to Arena text, 0.20 to EQ Creative v3, 0.05 to EQ4, 0.20 to personality, 0.10 to Briefcase and 0.10 to GDPval. Code groups duplicated terminal benchmarks and removes stale SWE-bench Pro. Epoch code/reasoning scores appear as unweighted cross-checks in code, research and architecture explanations, so they do not add duplicate votes. Cyber retains the design's Cybench/CyberGym weights; absent exact catalog releases, it still falls back to the table. This slice adds no cyber-access eligibility claim.

Quality uses weighted percentiles over the fixed, explicitly mapped evidence cohort, confidence decay and the design's 0.15 family regularizer. Half-lives are 90 days for Arena, DesignArena and EQ-Bench, 180 for AA, Epoch and independent cyber measurements, and 365 for vendor reports. Quality does not change with quota. Measured values win over vendor values at the same effort; exact effort comes before model-level evidence. Missing efforts interpolate only between measured neighbours, without imposing a monotone curve. Then comes the family median, then dropping the signal. All substitutions print their provenance. Family medians do not count as observed offer coverage. At coverage >= 0.3, utility uses evidence; below that it uses the historical score plus kind bonus, marked `(table)`. Existing table tier bands still constrain eligibility.

To reproduce a live check from the repository root (using the source entry point if `route` is not installed):

```sh
node packages/router/src/route.ts pull-evidence
node packages/router/src/route.ts explain brief.txt --kind ui
node packages/router/src/route.ts explain brief.txt --kind write
node packages/router/src/route.ts explain brief.txt --kind cyber
pnpm --filter @petalnet/router test
pnpm --filter @petalnet/router typecheck
```

Until ledger calibration, utility assumes a medium task, difficulty zero, ordinary stakes, `V=10` (`2` for sweep), `p=.45+.47Q`, and batch latency at `.05/minute`. Output tokens scale AA tokens/task to 12,000 at the cohort median; task cost scales AA cost/task by the same factor. Latency is TTFT plus output tokens/speed. Pool fraction is explicitly an uncalibrated `.01 × task dollars` proxy. Shadow price is `.5+2(1-headroom)^2`; reset pace is unknown (`rho=1`). Missing cost/speed inputs use disclosed neutral defaults after the evidence fallback chain. The table quality is divided by 100 and mapped to the same probability/value scale for mixed rankings. No Beta updates or exploration occur; `n=0` means zero labels used by this scorer, not an empty ledger.

OpenAI/Codex and Anthropic/Claude account training opt-outs are recorded as `Parker 2026-11-19`; Google AI Pro remains training. `--data-class parcs`, or a brief mentioning PARCS/Bridgeton, permits only the Claude plan (never Claude via agy). It prints a handoff and exits 5 without launch, even when live exclusions prevent choosing a specific Claude offer. Other blocks remain visible for the caller. Credential detection cannot downgrade `parcs`.

## Slice 4 prerequisites

Join launch and outcome events by run and attempt, distinguish process completion from a quality label, and define labels per kind (CI/merge for code, check results for sweep, explicit ratings for other kinds). Imported logs remain unlabelled. Pool failures, auth failures, handoffs and invalid offers must never increment beta. Pool effort into model × kind until data supports finer cells; gate posterior routing on at least 30 labels per kind. Decay evidence toward its prior rather than shrinking the prior. Fit task cost/pool deltas and success calibration from observed runs, handle selection bias, and keep Claude excluded from exploration. Add convergence, decay, quota-failure and spend-cap simulations before enabling any exploration.
