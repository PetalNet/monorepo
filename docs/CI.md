# CI selection and merge protection

The `ci` workflow always starts on pull requests and merge groups. `select` plans
the work; `finish` waits for every validation job and checks its exact expected
conclusion. This follows [Roc's CI manager](https://github.com/roc-lang/roc/blob/main/.github/workflows/ci_manager.yml),
with Turborepo owning the JavaScript dependency graph.

The manager is an Effect CLI at `tools/ci-manager/main.ts`. `policy.ts` defines
native selection; `select.ts` performs Git/Turbo planning;
`gate.ts` contains the explicit expected-job inventory and validates GitHub's
inputs with Effect Schema. Run `pnpm test:ci-manager` for the gate matrix and
real Git/Turbo regression fixtures; it also runs as part of the root checks.

JS jobs reuse `.github/actions/setup`, following
[Flint's setup action](https://github.com/flint-fyi/flint/tree/main/.github/actions/setup).
It installs the manifest-pinned pnpm/Node and frozen dependencies once per job.
The workflow sets `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` after relying on
that explicit install; Turbo passes it through to child tasks so pnpm does not
attempt implicit dependency installation inside dry plans or checks.

## Selection

- Pull requests compare the event's base SHA with the checked-out merge commit.
  Merge groups compare their base SHA with the group head. Full checkout history
  avoids shallow-history guesses. Renames are treated as delete plus add, so both
  paths select work. A failed diff or Turbo plan fails selection, not an empty plan.
- JS build and test selection comes from a Turbo affected dry run; execution
  uses the same base/head and `--affected`. Turbo propagates package dependency
  changes. `globalDependencies` still invalidate cache hashes, but are not
  additional dependency edges for affected selection. Root inputs can select
  all JS packages. Root code checks always run because they include
  repository-wide checks, not just package tasks. `TURBO_SCM_BASE` and
  `TURBO_SCM_HEAD=HEAD` ensure planning and execution compare the same commits,
  instead of using Turbo's default base-branch inference.
- Rust sources, Cargo manifests/locks/toolchains, `.cargo` configuration, and
  shared CI inputs select all native apps and Rust CodeQL. This conservative
  fan-out covers cross-app dependencies such as Box Agent and Control Plane
  depending on Dispatcher without requiring Rust tooling in the selector.
  Other native app inputs select that app's existing checks; Point includes
  both server and Flutter, PostgreSQL and the desktop bridge. Workflow,
  CI-manager, and Mise changes are shared CI inputs. Ordinary JS app, package,
  pnpm-lockfile, and JS tool changes do not select native checks or Rust CodeQL.
- Main pushes and manual runs execute the whole validation suite. Weekly CodeQL
  scans also analyze all four languages, independent of change selection.
  JavaScript/TypeScript and Python scan on every PR. Actions scans only when
  `.github/workflows/` or `.github/actions/` changes, including deleted or renamed
  paths. Rust scans when native Rust inputs are selected. Python coverage remains
  for `apps/manager/docs/contracts/validate.py`; replacing that validator with
  TypeScript is outside this PR.
- Work that is only partially selected on PRs runs in full on main: JS builds
  and tests, native checks, and all CodeQL languages. Repository-wide checks,
  including formatting, already run in full on PRs and remain full on main;
  there is no formatting-specific merge-queue history lookup.

Native Turbo Rust execution is not required for this design. Experimental Cargo
workspace support stays disabled. If enabled later, JS plans and commands must
exclude Cargo packages, native dependency selection must use that graph, and the
strict Clippy, PostgreSQL, tmux, and standalone Flutter bridge contracts must remain.

## The merge gate

Require the GitHub Actions check named **`finish`** (integration ID `15368`) in
the default-branch ruleset. It requires:

- `select`, root checks, typos, links, and zizmor to succeed;
- selected JS, native, and CodeQL jobs to succeed;
- unselected jobs to be exactly `skipped`.

Failure, cancellation, a missing job, an invalid selector output, an unexpected
skip, or an unclassified dependency fails the gate. Matrix jobs use their aggregate
conclusion; Point's reusable workflow must pass both Rust and Flutter. New CI jobs
must be added to both `finish.needs` and the manager's gate classification.

Keep the separate CodeQL alert-severity rule (`errors`, security `high_or_higher`)
and code-quality rule. A successful analysis action only proves the scan completed;
the code-scanning rule blocks qualifying alerts. Do not replace it with `finish`.
GitHub's [code-scanning merge protection](https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection)
does not cover merge queue groups; `finish` still blocks scan/job failures there,
but is not an alert-severity gate for a merge group.

## Activate safely

The owner has disabled GitHub-generated **default setup**. Advanced scans are now
enabled directly: no repository variable is required. They use `security-extended`
to preserve the previous security query coverage. Default setup must remain off
because GitHub rejects advanced uploads while it is enabled. Do not install the
generated template alongside these workflows: it would duplicate analysis and
restore unconditional Rust/Actions scans on PRs.

1. Land the workflow changes after checking the new `finish` result. Existing
   required check names remain available during this transition.
2. In repository Settings → Rules → Rulesets, edit
   [the Primary ruleset](https://github.com/PetalNet/monorepo/rules/17085602) and
   add `finish` as a required GitHub Actions status check. Once a main run has
   passed, replace the individual build/check/link/zizmor/typos requirements with
   `finish`. Keep code scanning and code quality required; do not add bypasses.
3. Confirm default setup remains disabled in repository Settings → Code Security
   → CodeQL analysis. No Actions variable needs to be set.
4. Run `ci` manually on `main` and wait for all languages to upload and `finish`
   to pass. Confirm the repository's code-scanning rule is satisfied. Do not
   resume auto-merging during this initialization window.
5. Verify a JS-only PR: native lanes, Rust CodeQL, and Actions CodeQL skip;
   JS/TS and Python scans finish. Verify a workflow/action PR selects Actions.
   `finish` passes, and the code-scanning rule permits merging. Verify a Rust PR:
   Rust CodeQL runs. Verify a deliberately failing selected check makes `finish`
   fail. Old default-setup analysis configurations may need retirement in the
   tool status page if GitHub reports missing configurations after the cutover;
   do not resolve that by weakening the alert rule or uploading empty SARIF.

GitHub auto-merge and Renovate then wait for `finish` plus the existing security
rules. No privileged merge bot, polling loop, or `pull_request_target` execution
of untrusted PR code is needed.

For rollback, revert the activation changes to the workflow and gate together,
disable advanced uploads, and restore default setup. Verify its scans pass before
resuming merges. Keep `finish` required; disabling advanced scans is not a
substitute for restoring default setup.
