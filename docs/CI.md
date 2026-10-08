# CI

| Work                              | PR / merge group                                                 | Main / manual      |
| --------------------------------- | ---------------------------------------------------------------- | ------------------ |
| JS build and test                 | Turbo affected graph                                             | Full graph         |
| Native checks                     | Turbo owners/dependents; explicit Flutter and shared-input rules | All lanes          |
| CodeQL                            | Independently selected JS/TS, Python, Actions and Rust inputs    | All four languages |
| Root checks, typos, links, zizmor | Full                                                             | Full               |

Selection compares the event's base SHA with `HEAD`; renames include both paths.
Failed Git/Turbo planning fails CI. Source-only packages and standalone scripts
still select CodeQL even without build/test tasks. Shared CI inputs select all
native lanes and scans. Weekly `codeql-full` scans all four languages.

The selector provisions Rust and queries affected packages once, then emits exact
JS package filters. Build/test execution never uses `--affected` or unions subsets
with a namespace-wide filter. Empty or malformed subset filters fail closed.

Native comparisons use that Cargo graph; the synthetic workspace is not a
service lane. Flutter/bridge changes select Point directly. Root Cargo, toolchain
and shared native configuration select all lanes. Rust CodeQL selection is
independent of native job selection.

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
CI_MANAGER_NATIVE_TESTS=true pnpm test:ci-manager # real Cargo graph fixtures; Rust required
pnpm ci-manager select # GITHUB_EVENT_PATH and GITHUB_OUTPUT required
pnpm ci-manager gate   # NEEDS_JSON required
```

Main/manual root checks include real Cargo graph fixtures; PR root checks keep
Rust-free gate, language, JS, filter-execution and malformed-query regression cases.

## Activation / rollback

- Keep default CodeQL setup disabled; advanced uploads use `security-extended`.
- After a full `ci` run on main passes, replace individual required CI checks
  with `finish`; retain security requirements. No repository variable is needed.
- Verify language-specific PR selection and a deliberately failing selected job
  before enabling auto-merge. Retire stale default-setup configurations if needed;
  never weaken alert rules or upload empty SARIF to bypass them.
- Roll back workflows and gate together, restore default setup, and verify scans
  before resuming merges.
