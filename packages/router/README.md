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

## Evidence scoring (slices 3 through 3c)

`route explain brief.txt --kind code` reads the same live state as `pick`; it never launches a model. Kind is required; tier defaults to S and data class to public. Kinds also include `cyber` and `architecture`. Excluded candidates retain their explanations, including during a pool cooldown. An evidence ranking is not permission to bypass those exclusions.

Artificial Analysis data is read from `~/.claude/shared/aa-models.json` at runtime, normalized in memory, and never copied into the package. Every numeric leaf of a mapped record becomes `{model, effort, signal, value, src, kind, asof, url}`. Fetch time is the available timestamp, not a claimed evaluation date. Missing files reduce coverage; malformed files fail visibly. Attribution: Artificial Analysis, https://artificialanalysis.ai.

`route pull-evidence` downloads the open sources below, then atomically writes `~/.local/state/router/evidence-open.json`. `pick`, `run` and `explain` merge that artifact with AA. Raw responses and fetch metadata stay in `~/.local/state/router/evidence-raw/`, mode 0600, with a 24-hour cache. Requests are sequential, at least one second apart, capped at 32 MiB and 30 seconds each, with no retries on denial or rate limiting. A failed source retains its previous rows and dates with a visible note. Pulling exits 1 when no rows are available. No benchmark data belongs in git.

| Source      | Official download                                                                                                                                   | Signals and provenance                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| LMArena     | [Arena's Hugging Face dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), via dataset API                                     | WebDev, text overall, creative writing; measured; publication date; CC BY 4.0                                                     |
| DesignArena | [Documented leaderboard API](https://docs.designarena.ai/api-reference/leaderboard)                                                                 | Website models; measured; board update date; approved `DESIGNARENA_API_KEY` required                                              |
| EQ-Bench    | [Creative Writing v3](https://eqbench.com/creative_writing.html) and [EQ-Bench 4](https://eqbench.com/eqbench4.html), official site's data literals | Creative writing and emotional/social intelligence separately; measured; fetch date for v3, export date for v4                    |
| Epoch AI    | [Benchmarking hub CSV ZIP](https://epoch.ai/benchmarks/use-this-data)                                                                               | GPQA Diamond, MirrorCode, SWE-bench Verified; measured; run date when present; CC BY 4.0                                          |
| CyberGym    | [Official leaderboard JSON](https://www.cybergym.io/cybergym/)                                                                                      | Level 1, single trial, model entries only; vendor submissions with reporter and harness retained                                  |
| Cybench     | [Official leaderboard CSV](https://cybench.github.io/)                                                                                              | Unguided end-to-end solve rate; model-card footnotes remain vendor evidence; fetch date                                           |
| AA Cyber    | [Artificial Analysis Cyber Index](https://artificialanalysis.ai/evaluations/artificial-analysis-cyber-index)                                        | Public embedded JSON, parsed without executing JavaScript; defensive evaluations in Stirrup; exact release and effort; fetch date |

Downloads without a stated data license remain internal; none are republished. DesignArena's API is the authorized path; missing credentials produce a gap, without scraping its pages. Python 3 supplies CSV, ZIP and HTTP support from its standard library, avoiding new dependencies. It is required for pulls and the package's tests; selection still runs in Node.js.

An explicit release alias map handles decimal slug spelling and Claude shorthand. No fuzzy matching, preview substitution or generation substitution occurs. `explain` lists unknown source names. Open rows add `reporter` and `halfLifeDays`; effort not published by a source stays `unspecified`. Such rows contribute model-level coverage and are labeled accordingly, without claiming an effort match.

Each model is offered at every supported adapter effort. Catalog variants of the same model, provider and pool are grouped; the highest catalog score determines the model's tier for all its efforts. This lets a low-effort sweep compete with a high-effort code task within the same model tier. Legacy model and effort bans still apply, including Claude aliases. Exhaustion still cools the whole pool. A transient failure retries once, then skips that model's remaining efforts; an invalid agy variant disables only that variant.

`src/effort.ts` records the adapter capabilities checked on 2026-11-19:

| Adapter/model          | Offered efforts                |
| ---------------------- | ------------------------------ |
| Codex                  | none, low, medium, high, xhigh |
| agy Neon/Hydrogen      | low, medium, high, xhigh       |
| agy Argon/Flash/Claude | low, medium, high              |
| agy GPT-OSS-120B       | medium                         |
| Claude handoff         | low, medium, high, xhigh, max  |

Unknown adapters/models retain their catalog effort until capabilities are known. `agy models` supplies the published variants; the global flag enum alone does not imply model support. agy rejects conflicting slug and `--effort` values: neither wins. The adapter constructs a matching pair. The documented `/effort` command verified this with zero turns and tokens. Codex 0.164's `debug prompt-input` dry config check accepted the five requested values and rejected non-string controls, with prompt output discarded. Its config parser also accepts arbitrary strings, so this does not prove endpoint support. Matching source and CLI effort names does not establish equal token budgets; no model jobs were run. Codex always receives `-c model_reasoning_effort=<level>`, and Claude handoffs name the effort. The legacy `agy-build` Codex path now honors an optional `CODEX_EFFORT`; unset inherits Codex configuration rather than forcing xhigh.

Profiles live in `src/evidence.ts`. UI keeps the design weights, including the unavailable DesignArena weight. Writing allocates 0.25 to Arena creative, 0.10 to Arena text, 0.20 to EQ Creative v3, 0.05 to EQ4, 0.20 to personality, 0.10 to Briefcase and 0.10 to GDPval. Code groups duplicated terminal benchmarks and removes stale SWE-bench Pro. Epoch code/reasoning scores appear as unweighted cross-checks in code, research and architecture explanations. Cyber allocates 0.70 to AA Cyber Index and 0.15 each to Cybench and CyberGym. AA's CWE-Bench, DeepsecBench and CyberGym-E2E components appear as unweighted cross-checks, avoiding duplicate votes. CyberGym-E2E-AA is distinct from CyberGym Level 1. The live pull has exact AA matches; old Cybench/CyberGym releases remain unmapped rather than being substituted for newer releases. This slice adds no cyber-access eligibility claim.

Quality uses weighted percentiles over the fixed, explicitly mapped evidence cohort, confidence decay and the design's 0.15 family regularizer. Half-lives are 90 days for Arena, DesignArena and EQ-Bench, 180 for AA, Epoch and independent cyber measurements, and 365 for vendor reports. Quality does not change with quota. Each signal uses its own effort's record first, with measured values winning over vendors. Missing quality, task cost, tokens, speed and TTFT interpolate between that model's measured neighbours without imposing a monotone curve. Outside the measured range, the nearest endpoint is held constant; a single measurement therefore gives a flat estimate. Both cases print `interpolated` and their source levels. Estimates retain source measurement weight so shrinking an estimate toward a strong family prior cannot invent an advantage over its endpoints. Then come unspecified model-level evidence, the family median and dropping the signal. Family medians do not count toward coverage. Coverage includes model-level and interpolated inputs; it is not a count of measurements at the selected effort.

At coverage >= 0.3, utility uses evidence. Lower coverage uses the historical score plus kind bonus, marked `(table)`. Eligible evidence-backed offers precede table-only fallback; quota and policy exclusions always win. Tied utility prefers observed inputs, then lower effort. `pick` and `explain` both show the chosen effort and adjacent-effort quality, task cost and time deltas, including their contributions to utility. `explain` also shows tokens, speed, TTFT and each input's provenance.

To reproduce a live check from the repository root (using the source entry point if `route` is not installed):

```sh
node packages/router/src/route.ts pull-evidence
node packages/router/src/route.ts explain brief.txt --kind ui
node packages/router/src/route.ts explain brief.txt --kind write
node packages/router/src/route.ts explain brief.txt --kind cyber
pnpm --filter @petalnet/router test
pnpm --filter @petalnet/router typecheck
```

Until ledger calibration, utility assumes a medium task, difficulty zero, ordinary stakes, `V=10`, `p=.45+.47Q`, and batch latency at `.05/minute`. Routine sweeps use `V=1` and `.20/minute` to favor turnaround over marginal quality gains. These are explicit policy assumptions, not fitted observations or brief difficulty inference. Output tokens scale AA tokens/task to 12,000 at the cohort median; task cost scales AA cost/task by the same factor. Latency is TTFT plus output tokens/speed. Pool fraction is explicitly an uncalibrated `.01 × task dollars` proxy. Shadow price is `.5+2(1-headroom)^2`; reset pace is unknown (`rho=1`). Utility is `V*p - lambda*.01*taskCost - latencyRate*seconds/60`; task dollars are a quota proxy, not a claimed subscription bill. Missing cost/speed inputs use disclosed neutral defaults after the evidence fallback chain. Table quality is divided by 100 and mapped to the same probability/value scale. No Beta updates or exploration occur; `n=0` means zero labels used by this scorer, not an empty ledger.

OpenAI/Codex and Anthropic/Claude account training opt-outs are recorded as `Parker 2026-11-19`; Google AI Pro remains training. `--data-class parcs`, or a brief mentioning PARCS/Bridgeton, permits only the Claude plan (never Claude via agy). It prints a handoff and exits 5 without launch, even when live exclusions prevent choosing a specific Claude offer. Other blocks remain visible for the caller. Credential detection cannot downgrade `parcs`.

## Slice 4 prerequisites

Join launch and outcome events by run and attempt, distinguish process completion from a quality label, and define labels per kind (CI/merge for code, check results for sweep, explicit ratings for other kinds). Imported logs remain unlabelled. Pool failures, auth failures, handoffs and invalid offers must never increment beta. Preserve selected effort and interpolation provenance in learning inputs; pool effort into model × kind until data supports finer cells. Gate posterior routing on at least 30 labels per kind. Decay evidence toward its prior rather than shrinking the prior. Record actual tokens, cost, TTFT, runtime and quota deltas; fit the current task-size, effort-cost and success assumptions against them. Validate sweep value/time policy, handle selection bias, and keep Claude excluded from exploration. Add convergence, decay, quota-failure and spend-cap simulations before enabling any exploration.
