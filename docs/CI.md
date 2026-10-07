# CI selection and merge protection

The `ci` workflow always starts on pull requests and merge groups. `select` plans
the work; `finish` waits for every validation job and checks its exact expected
conclusion. This follows [Roc's CI manager](https://github.com/roc-lang/roc/blob/main/.github/workflows/ci_manager.yml),
with Turborepo owning the JavaScript dependency graph.

## Selection

- Pull requests compare the event's base SHA with the checked-out merge commit.
  Merge groups compare their base SHA with the group head. Full checkout history
  avoids shallow-history guesses. Renames are treated as delete plus add, so both
  paths select work. A failed diff or Turbo plan fails selection, not an empty plan.
- JS build and test selection comes from a Turbo affected dry run; execution
  uses the same base/head and `--affected`. Turbo propagates package dependency
  changes. `globalDependencies` still invalidate cache hashes, but are not
  additional dependency edges for affected selection. Root inputs can select
  all JS packages. Root `pnpm check` always runs
  because it includes repository-wide checks, not just package tasks.
- Each native app selects its existing Cargo checks; Point selects both server
  and Flutter checks, including PostgreSQL and the desktop bridge. Workflow,
  CI-manager, root Cargo/toolchain, `.cargo`, and Mise changes select all native
  apps. Rust CodeQL selects Rust sources, Cargo manifests/locks/toolchains,
  `.cargo` configuration, and the shared CI inputs. Ordinary JS app, package,
  pnpm-lockfile, and JS tool changes do not select Rust CodeQL.
- Main pushes and manual runs execute the whole validation suite. Weekly CodeQL
  scans also analyze all three languages, independent of change selection.

Native Turbo Rust execution is not required for this design. Experimental Cargo
workspace support stays disabled. If enabled later, JS plans and commands must
exclude Cargo packages, native dependency selection must use that graph, and the
strict Clippy, PostgreSQL, tmux, and standalone Flutter bridge contracts must remain.

## The merge gate

Require the GitHub Actions check named **`finish`** (integration ID `15368`) in
the default-branch ruleset. It requires:

- `select`, root checks, typos, links, and zizmor to succeed;
- selected JS, native, and enabled CodeQL jobs to succeed;
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

The existing GitHub-generated **default setup** continues scanning until an admin
switches it off. Advanced uploads cannot coexist with default setup, so the new
workflow is staged behind repository variable `CODEQL_ADVANCED=true`. Until then,
its two jobs are intentionally skipped and default setup remains the security gate.
**Rust CodeQL will still run on JS-only PRs until this cutover is done.**

1. Land the workflow changes after checking the new `finish` result. Existing
   required check names remain available during this transition.
2. In [the Primary ruleset](https://github.com/PetalNet/monorepo/settings/rules/17085602),
   add `finish` as a required GitHub Actions status check. Once a main run has
   passed, replace the individual build/check/link/zizmor/typos requirements with
   `finish`. Keep code scanning and code quality required; do not add bypasses.
3. In [Code Security settings](https://github.com/PetalNet/monorepo/settings/security_analysis),
   switch CodeQL off from default setup. Immediately set repository Actions
   variable `CODEQL_ADVANCED` to `true`. Use an admin session or a token with
   repository administration, Actions variables, and code-scanning configuration
   access; the orb's GitHub integration token may not have those scopes.
4. Run `ci` manually on `main` and wait for all languages to upload and `finish`
   to pass. Confirm the repository's code-scanning rule is satisfied. Do not
   resume auto-merging during this initialization window.
5. Verify a JS-only PR: native lanes and Rust CodeQL skip, JS/Actions scans finish,
   `finish` passes, and the code-scanning rule permits merging. Verify a Rust PR:
   Rust CodeQL runs. Verify a deliberately failing selected check makes `finish`
   fail. Old default-setup analysis configurations may need retirement in the
   tool status page if GitHub reports missing configurations after the cutover;
   do not resolve that by weakening the alert rule or uploading empty SARIF.

GitHub auto-merge and Renovate then wait for `finish` plus the existing security
rules. No privileged merge bot, polling loop, or `pull_request_target` execution
of untrusted PR code is needed.

For rollback, restore default setup first and unset `CODEQL_ADVANCED`, then verify
its scans pass. Keep `finish` required; disabling the advanced scans is not a
substitute for restoring default setup.
