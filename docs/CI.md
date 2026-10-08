# CI

| Work                              | PR / merge group                                              | Main / manual      |
| --------------------------------- | ------------------------------------------------------------- | ------------------ |
| JS build and test                 | Turbo affected graph                                          | Full graph         |
| Native checks                     | Rust inputs → all native lanes; other app inputs → that lane  | All lanes          |
| CodeQL                            | Independently selected JS/TS, Python, Actions and Rust inputs | All four languages |
| Root checks, typos, links, zizmor | Full                                                          | Full               |

Selection compares the event's base SHA with `HEAD`; renames include both paths.
Failed Git/Turbo planning fails CI. Source-only packages and standalone scripts
still select CodeQL even without build/test tasks. Shared CI inputs select all
native lanes and scans. Weekly `codeql-full` scans all four languages.

## Merge protection

Require **`finish`** (GitHub Actions integration `15368`) in the
[Primary ruleset](https://github.com/PetalNet/monorepo/rules/17085602).
Selected jobs must succeed; unselected jobs must be exactly skipped.
Missing, failed, cancelled, malformed or unclassified jobs fail the gate.
Add new jobs to both `finish.needs` and `gate.ts`.

Keep the separate code-scanning alert and code-quality rules: a successful scan
does not mean no alerts. GitHub's alert gate does not cover merge groups.

## Commands

```sh
pnpm test:ci-manager
pnpm ci-manager select # GITHUB_EVENT_PATH and GITHUB_OUTPUT required
pnpm ci-manager gate   # NEEDS_JSON required
```

## Activation / rollback

- Keep default CodeQL setup disabled; advanced uploads use `security-extended`.
- After a full `ci` run on main passes, replace individual required CI checks
  with `finish`; retain security requirements. No repository variable is needed.
- Verify language-specific PR selection and a deliberately failing selected job
  before enabling auto-merge. Retire stale default-setup configurations if needed;
  never weaken alert rules or upload empty SARIF to bypass them.
- Roll back workflows and gate together, restore default setup, and verify scans
  before resuming merges.
