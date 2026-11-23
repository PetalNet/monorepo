# Janet quota pacing

## Provider clocks

Times below are UTC and describe the account readings on November 23, 2026. The pacer reads timestamps again on every check.

| Provider and meter               | Next reset at the time of measurement                                    | How to read the meter                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex Pro 100 (`prolite`) weekly | November 29 at 18:38:43                                                  | Provider-reported percentage of the included Work and Codex allowance. The weekly cycle is anchored to usage, and resets or plan changes can move the date.                                                                                  |
| Codex 5 h on plans that have it  | No active 5 h meter on Pro 100                                           | The first request after the previous window ends starts a new 5 h window. The prior Plus history shows both meters.                                                                                                                          |
| agy Gemini Models                | Weekly November 28 at 09:34:50, 5 h approximately 5 h after an idle read | `agy -p /quota` gives percent remaining. Subtract from 100. A zero-use 5 h reading moved forward with elapsed time until work began.                                                                                                         |
| agy Gemini 4 Argon               | Weekly November 29 at 01:54:56                                           | The CLI reports a separate weekly allowance. The router also reserves Gemini 5 h budget for Argon because the coupling is uncertain.                                                                                                         |
| agy Claude and GPT               | Weekly November 26 at 07:01:27, 5 h returned `disabled`                  | The CLI supplied a weekly meter for this account. A 5 h meter applies when the CLI reports one.                                                                                                                                              |
| Claude Max 20x                   | General and Fable Tuesday at 10:00, next November 24                     | Anthropic reports account utilization. The first request starts the 5 h clock, and general and Fable weekly allowances reset at fixed account times. Fable consumed 9 points of the general weekly allowance when its scoped meter read 18%. |

The agy weekly meters report distinct account deadlines. There is insufficient reset history to establish whether each deadline repeats at the same wall time. OpenAI weights work by model and task, Google relates spend to work done by the agent, and Anthropic accounts for model, effort, features and conversation size across its product surfaces. A percentage point means one hundredth of a given allowance, so rates from one window or plan cannot be transferred directly to another. [OpenAI](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex), [Google](https://antigravity.google/docs/plans), [Anthropic](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work), [Fable](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan)

## Observed burn

These rates assign each eligible account-wide counter increase to the model and effort with at least 60% of routed builder time in the interval. They are approximations for this workload. Non-router activity, shared counters, rounding and delay can affect attribution. An hour means elapsed subprocess time, including tool work and waits. Runs in the denominator are attempts ending inside the measured intervals. For agy, historic launch summaries omit reset timestamps, so the estimates exclude counter decreases and gaps longer than one hour. The Gemini 5 h estimate also excludes gaps longer than 30 minutes.

| Meter                    | Dominant model and effort | Intervals | Builder-hours | Runs | pp/hour | pp/run |
| ------------------------ | ------------------------- | --------: | ------------: | ---: | ------: | -----: |
| Codex Pro 100 weekly     | GPT-6.2 Sol high          |        20 |          5.74 |    4 |    1.92 |   2.75 |
| Codex Pro 100 weekly     | GPT-6.1 Sol medium        |         9 |          5.71 |   12 |    1.40 |   0.67 |
| Codex Pro 100 weekly     | GPT-6.1 Sol high          |         2 |          2.47 |    5 |    1.62 |   0.80 |
| Codex Plus 5 h           | GPT-6.1 Sol high          |       122 |        104.96 |   91 |    2.53 |   2.91 |
| Codex Plus weekly        | GPT-6.1 Sol high          |        71 |         77.41 |  108 |    0.67 |   0.48 |
| agy Gemini Models 5 h    | Gemini 4 Neon high        |         8 |          0.96 |    8 |  107.93 |  13.00 |
| agy Gemini Models weekly | Gemini 4 Neon high        |         9 |          0.87 |    8 |   38.99 |   4.25 |
| agy Gemini Models 5 h    | Gemini 4 Argon high       |         6 |          0.85 |   10 |    5.86 |   0.50 |
| agy Argon weekly         | Gemini 4 Argon high       |         8 |          1.33 |   14 |   60.87 |   5.79 |

Across eligible Pro 100 intervals the weekly meter rose 83 points over 61.04 routed builder-hours and 246 completed attempts (1.36 pp/hour and 0.34 pp/run). Sparse model and effort combinations have insufficient matched observations. The Claude and agy Claude/GPT counters lacked matching routed work history. AgentsView supplied session and activity records, and its `session_plan_usage` table had zero rows. The Astrolabe feed overwrites its previous snapshot. Router logs supplied historical agy readings and run status. Codex rollouts supplied 64,151 token events with quota observations across 1,819 sessions from the local and NAS history.

The router ledger contained 1,535 Codex attempts and 171 agy attempts since November 19. Median hourly peak overlap was six Codex builders and two agy builders. Observed maxima were 21 and 10. Three Codex quota exits occurred with three to five simultaneous attempts near the same weekly limit. These records do not establish provider concurrency or requests-per-minute ceilings. The pacer uses operating ceilings of six Codex and two agy builders and keeps Claude report-only, consistent with the router's Claude handoff and the absence of transferable rate data.

## Admission

`route pace --class public` reads fresh provider counters and the router ledger, records a 14-day history under `~/.local/state/router/pacing-readings.jsonl`, and prints `launch <pool> <model>:<effort> +<count>` or `hold`. The Nix package `quota-pacer` exposes the same check as `quota-pace`.

Each applicable window must have enough budget for the candidate's estimated full run after reserving the estimated cost of active work. Estimate the launch cost as the greater of one point, the upper per-run estimate, and the upper hourly estimate times the observed run duration. Derive the current budget by projecting the schedule to the next 15-minute check or expected run end, whichever comes later, toward 97% at reset. Allocate available host slots one by one so shared windows and provider concurrency are debited across the recommendation. A tight weekly budget can leave spare 5 h capacity. A missing, stale or exhausted window holds that pool, and an unmeasured active run holds the windows it shares.

The calibration uses at least three comparable intervals and at least two positive deltas. It excludes meter resets, decreases, capped readings and intervals with unresolved work, and assigns the whole counter delta to the dominant model as a conservative estimate. The initial rates for the current plan use the measured intervals above with a 50% reserve and expire December 7. Treat the resulting recommendations as workload estimates. Long or externally launched work can make the target unattainable.

On 202, reserve 2,500 MiB of available RAM and require another 3,072 MiB per recommended builder and 8,000 MiB free on the root filesystem. Existing `route-unit` admission still applies at launch, with systemd `MemoryHigh=3G` and `MemoryMax=4G`. The pacer uses the normal router menu, including Eli's effort cap, policy exclusions and cooldowns. Paced launches use `FLOOR=2` explicitly because the normal router floor reserves 15 points for agy.
