# DECISIONS — oxfmt / vp native Svelte formatting

Branch: `chore/oxfmt-vp-native-svelte` (off `origin/main` @ dc4260a)
Requested by: Eli — "move oxfmt back to vp and use vp's new native Svelte support."

## 1. Investigation: what the current state actually is

The request's framing implies a vendored or standalone oxfmt that needs to be
moved back under `vp`. **That is not the state of `main`.** Concretely:

- No `oxfmt` entry in any `package.json` in the repo, and none in the
  `pnpm-workspace.yaml` catalogs.
- No `.oxfmtrc.json` / `.oxfmtrc.*` anywhere, and no vendored oxfmt binary or
  checked-in copy.
- `oxfmt@0.57.0` appears in `pnpm-lock.yaml` **only as a dependency of
  `vite-plus@0.2.4`**. `vp --version` confirms it: vp reports its bundled
  tools as `oxfmt v0.57.0`, `oxlint v1.72.0`, `vite`, `rolldown`, `vitest`,
  `tsdown`.
- Root `package.json` already routes formatting through vp:
  `"fmt": "vp fmt"`, `"fmt:check": "vp fmt --check"`, and `check` runs
  `vp run fmt:check`.
- Formatter options already live in vp's own config — `vite.config.ts` has an
  `fmt: {...}` block (`useTabs`, `singleQuote`, `semi`, `sortImports`,
  `sortTailwindcss`, `jsdoc`, `ignorePatterns`). vp types this as
  `fmt?: OxfmtConfig`, passed straight through to oxfmt.

So oxfmt is already _in_ vp, and `vp fmt` already _is_ oxfmt. There was nothing
to move.

### The "vendored oxfmt" in lychee.toml is a misreading

`lychee.toml` says the design-doc excludes are "the same vendored treatment
already applied to oxfmt and typos." That refers to the **vendored
`apps/point/docs/design` path being excluded in oxfmt's and typos' configs** —
`vite.config.ts` carries `apps/point/docs/design/**` in `fmt.ignorePatterns`,
and `typos.toml` does the equivalent. It is not a statement that oxfmt itself
is vendored.

### What _was_ genuinely missing: Svelte

`vp fmt` was not formatting `.svelte` files **at all**:

```console
$ vp fmt --check 'apps/collegemap/src/**/*.svelte'
Expected at least one target file. All matched files may have been excluded by ignore rules.
$ vp fmt --check          # baseline on main
All matched files use the correct format.   → 416 files
```

95 tracked `.svelte` files were entirely outside the formatter's scope.

## 2. Confirming vp's native Svelte support exists (it does)

Verified against the _shipped_ artifacts in the installed `oxfmt@0.57.0`, not
docs (vp 0.2.4's bundled `docs/` do not yet cover the option):

- `configuration_schema.json` and `dist/index.d.ts` both expose a top-level
  `svelte?: SvelteUserConfig` option — "Options for `prettier-plugin-svelte`.
  Pass `true` or an object to enable `.svelte` file formatting … Default:
  Disabled." `SvelteConfig` accepts `allowShorthand`, `indentScriptAndStyle`,
  and `sortOrder` (default `options-scripts-markup-styles`).
- Many existing options are documented as covering Svelte
  (`sortTailwindcss`, `singleQuote`, `bracketSameLine`, `embeddedLanguageFormatting`,
  `htmlWhitespaceSensitivity`, `singleAttributePerLine`).
- `oxfmt`'s `package.json` declares an **optional** peer on `svelte ^5.0.0` —
  the schema notes oxfmt does not bundle `svelte/compiler` and it must be
  resolvable at runtime.

Runtime resolution is satisfied and deterministic here: pnpm resolved the
optional peer against the workspace's `svelte@5.56.5` and symlinks it beside
oxfmt in the virtual store, which the committed lockfile pins
(`oxfmt@0.57.0(svelte@5.56.5…)(vite-plus@0.2.4…)`). `require.resolve('svelte/compiler')`
from oxfmt's directory succeeds. No new dependency was needed — adding a root
`svelte` devDependency would have been redundant and would have read as an
unused dep to knip.

## 3. The change

One line in `vite.config.ts`:

```ts
fmt: {
  …
  jsdoc: true,
  svelte: true,        // ← added
  ignorePatterns: [...],
}
```

Left at defaults deliberately: `sortOrder`'s default
(`options-scripts-markup-styles`) already matches the repo's prevailing
script → markup → style layout, and `allowShorthand`/`indentScriptAndStyle`
defaults match existing style. The existing `useTabs`/`singleQuote`/`semi`/
`sortTailwindcss` settings now apply to `.svelte` too, which is the point.

Entry points are unchanged — `vp fmt` and `vp fmt --check` as before.

Then `vp fmt` was run, reformatting **95 files**:

- 93 of the 95 `.svelte` files (2 were already conformant).
- `apps/slide/TIMEZONE_GUIDE.md` — it contains ```svelte fenced blocks, which
  are now formatted as embedded code. Expected, and a single small hunk.
- `vite.config.ts` itself (the added line).

`vp fmt` now covers **511 files**, up from 416 (counts measured on the
rebased base, `main` @ 9d15f11).

### Two console tests needed updating

`apps/console` has design-contract tests that `readFile` Svelte components and
regex-match their **raw source text**. Two assertions were pinned to the old
_compressed_ CSS spelling, which the formatter expands:

- `src/lib/components/modal-surface.test.ts` — `box-shadow:var(--shadow-pop)`,
  `border-radius:var(--r-lg)`, `:not([open]){display:none}`
- `src/lib/components/interaction-targets.test.ts` — `.mini…min-height:32px`,
  `.primary,:global(.op-btn.primary){min-height:40px`

These were made whitespace-tolerant (`min-height:\s*32px`, `\s*\{\s*`) rather
than re-pinned to the new spelling, so they assert the design intent (the token
/ the 32px floor is used) instead of the formatter's whitespace. Note that
sibling assertions in the same files already used the spaced form
(`width: 32px`) and passed — the codebase was internally inconsistent, and the
formatter normalizes it.

## 4. Verification

All run via the repo-local vp (`node_modules/.bin/vp`), matching what CI's
`vp run` resolves for nested script invocations:

| Check                                                      | Result                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `vp fmt --check`                                           | clean — "All matched files use the correct format", 511 files                                                               |
| `vp fmt` ×2 (idempotence)                                  | stable — diffstat identical after 2nd run (`95 files changed, 18615 insertions(+), 5350 deletions(-)`); 3rd `--check` clean |
| `vp run check` (CI's step: typecheck && lint && fmt:check) | pass — `tsc -b`, oxlint 0 warnings/0 errors, eslint (incl. console + adapter), fmt:check all clean                          |
| `vp run test`                                              | **264/264 pass, 38/38 files** (was 262 pass / 2 fail before the test-regex fix)                                             |
| `vp run build`                                             | pass — all 6 build tasks                                                                                                    |
| `vp run manypkg`                                           | pass — "success workspaces valid!"                                                                                          |
| `vp run lint:knip` / `lint:knip:prod`                      | pass, no findings                                                                                                           |
| `pnpm-lock.yaml`                                           | unchanged — no dependency changes                                                                                           |

Spot-checked Svelte output by hand:

- `apps/slide/src/lib/components/Button.svelte` — tabs honored, `'` → `"`,
  trailing commas added, over-long `const` string wrapped, `<button>` attrs
  collapsed to one line. Clean and correct.
- `apps/console/src/routes/terminal/+error.svelte` — compressed `<style>` CSS
  expanded to one declaration per line; ternary in markup wrapped. The
  `<span aria-hidden="true"\n\t><Icon …/></span\n>` shape is
  prettier-plugin-svelte's standard whitespace-sensitive inline handling —
  intentional, it preserves rendered whitespace semantics.
- `apps/slide/TIMEZONE_GUIDE.md` — the ```svelte block's `<input>` collapsed
  to one line.

## 5. Outcome / summary

`vp fmt` already was oxfmt-inside-vp; the premise of a vendored oxfmt to move
back did not hold, so there was no vendored path to drop. The real, actionable
gap — 95 `.svelte` files that no formatter governed — is closed by enabling
vp's native Svelte support (`fmt.svelte: true`), which vp 0.2.4 does ship via
its bundled `oxfmt@0.57.0`. Net change: **one config line**, one mechanical
reformat of 95 files, and two source-text test assertions loosened to be
whitespace-agnostic. No dependency or lockfile changes, no new tooling, entry
points untouched. Full CI-equivalent suite green.

## 6. Shipped

- Branch `chore/oxfmt-vp-native-svelte`, PR
  [#341](https://github.com/PetalNet/monorepo/pull/341) → `main`. Not merged.
- Rebased onto `main` @ 9d15f11 after opening the PR (main had advanced by four
  commits touching only `apps/grove/docs/**` and `apps/point/app/**` — no
  overlap with this change, no conflicts). The eleven new markdown files carry
  no ` ```svelte ` fences, and `vp fmt --check` stayed clean on the rebased
  tree at 511 files.
- `#332` (`chore/root-eslint-config`) and `main` were not touched.

One late catch worth recording: the first `vp run check` predated this
DECISIONS file, and once the file existed `eslint` flagged its bare shell
transcript fence (`markdown/fenced-code-language` — every fenced block in this
repo needs a language). Tagged it ` ```console `. The lesson is ordering:
run the lint gate _after_ writing the doc that ships with the change, since the
doc is itself linted.
