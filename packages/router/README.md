# Route

Run `quota` to see each provider's used allowance and reset times. The first
line is the pacer's recommendation for additional builders. `route ls` and
`route pace` print the same report.

Choose a model and effort, then pass the brief as text, an existing file, or
stdin (`-`).

```sh
route run gpt-6.2-sol:medium --class public brief.md
```

- `public` can use Codex or agy. `sensitive` requires US hosting and a
  verified training opt-out, which excludes every agy model.
- `parcs` requires the native Claude plan. The launcher scans briefs for
  credentials and PARCS terms and raises the class when needed.
- Native Claude uses exit 5 and records a handoff. For public or sensitive use,
  an explicit `--allow-claude` is required.
- `--for` is accepted for one release and has no effect. The launcher starts
  only the supplied model, caps execution at 12 hours, and permits four nested
  launches.
- Run output and `ledger.jsonl` live under `~/.local/state/router`. The
  completion channel also reports refusals and failures to start.

See [QUOTA-PACING.md](QUOTA-PACING.md) for how the scheduled pacer uses the ledger.
