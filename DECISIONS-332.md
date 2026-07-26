# DECISIONS — PR #332 (root ESLint consolidation)

Branch `chore/root-eslint-config`. This log covers the session that took the branch from
"conflicted with main, console blanket-ignored, 150 errors outstanding" to green.

## Final state

| Gate                                            | Result                               |
| ----------------------------------------------- | ------------------------------------ |
| `eslint -c eslint.config.ts . --max-warnings=0` | **0 errors, 0 warnings** (470 files) |
| `tsc -b` (root project references)              | **clean**                            |
| `vp fmt --check`                                | **clean** (407 files)                |
| `oxlint --max-warnings=0`                       | **clean**                            |

Error count at the start of the session: 150 across the five projects, plus `apps/console`
excluded from linting entirely. Error count now: 0, with console **linted**.

## 0. Merge of `origin/main`

`origin/main` (8 commits ahead) landed a large Effect-based refactor of `apps/console` —
`console-api.ts` alone lost ~1900 lines to new `domain/commands/op-plane.ts`,
`domain/terminal/service.ts` and `domain/palette/service.ts` modules.

**12 conflicts, all in `apps/console`.** Every conflict was main's refactor against this
branch's cosmetic `eslint --fix` output from 54ed1b4 (bracket→dot notation,
`prefer-optional-chain`, `array-type`, `consistent-type-definitions`,
`non-nullable-type-assertion-style`).

**Resolution: took main's side for all 12.** Rationale — main's side is the substantive
change; ours was autofix output that (a) largely no longer applies to the rewritten code and
(b) is re-derivable by running the linter. Dropping main's refactor to keep a bracket-to-dot
rewrite would have been a functional regression for a whitespace-class gain.

Nothing from the consolidation was lost: `eslint.config.ts` did not conflict (main never
touched it), and every tsconfig project-reference fix from fd2121f survived alongside main's
`emitDeclarationOnly` additions — verified file by file after the merge.

### Install note (correction to the brief)

The brief prescribed `corepack pnpm@10.26.0 install --ignore-workspace`. That **fails**:

```text
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  the current "catalogs" configuration doesn't match the lockfile
```

`--ignore-workspace` discards `pnpm-workspace.yaml`, and with it the catalogs the lockfile
was built from — so the frozen check can never pass. Reproduced against the pre-merge
`pnpm-workspace.yaml` too, so it is not merge-induced. A plain workspace install works:

```sh
COREPACK_INTEGRITY_KEYS=0 CI=true corepack pnpm@10.26.0 install
```

The stray `/home/docker/pnpm-lock.yaml` the brief warns about is not a problem: pnpm stops
its upward workspace-root search at `mono-slide/pnpm-workspace.yaml` and never reaches it.

Also note `mise exec -- pnpm exec …` does not work here — mise supplies pnpm 11.11.0, which
tries to purge the modules directory pnpm 10.26.0 created and aborts with no TTY. Run the
binaries directly (`./node_modules/.bin/eslint`, `./node_modules/.bin/tsc`).

## 1. `apps/console`: rule-disables, not an ignore

Replaced `{ ignores: ["apps/console/**"] }` with a scoped rule-disable block mirroring the
`apps/slide/**` one. Method: dropped the ignore, ran ESLint over console, collected every
`ruleId` that fired, and turned off exactly those.

**707 errors across 24 rules.** Console's 284 files are now inside the lint scope and report
zero: a violation of any _other_ rule still fails CI, which the blanket ignore could not do.
Tracked in PetalNet/monorepo#337; the block is meant to shrink and be deleted after the
rewrite, never to grow.

Unignoring console also surfaced 5 `typescript-eslint` project-service parse errors —
`effectdb.config.ts` and `scripts/**/*.ts` belonged to no tsconfig. Fixed by extending
console's `include`, the same way fd2121f handled the other orphaned config files, not with
`allowDefaultProject`.

Top rules in the block, by count: `dot-notation` (295), `no-unsafe-member-access` (133),
`require-await` (57), `prefer-nullish-coalescing` (36), `no-unsafe-assignment` (27).

## 2. The small five — 150 errors, all fixed at the source

No rule was disabled for any of these. One commit per project.

### `apps/collegemap` — 126 → 0

- **tsconfig coverage**: `drizzle.config.ts` and `svelte.config.js` were owned by no project
  (2 parse errors). Added a `files` array, matching the fd2121f pattern.
- **Untrusted JSON given shapes**: the Wikipedia page-summary reply, the Nominatim geocode
  hits and `/api/college-info`'s response were flowing on as `any`. Each now has a declared
  shape and is narrowed at the point of use.
- **Route props**: `$props()` was unannotated in five route components, so `data` / `form` /
  `children` resolved to nothing. Annotated with the generated `PageProps` / `LayoutProps`.
- **`Map.svelte`** (41 errors, the worst file): `map`, `L` and `tileLayer` were declared
  non-nullable but are genuinely absent until the async Leaflet import lands — which is why
  ~10 real guards read as dead code. Declared them `| undefined` and narrowed once into a
  local per function so the closures (cluster icon factory, marker handlers) keep the
  non-null view. Two `as any` casts became a typed `CollegeMarkerOptions extends MarkerOptions`
  carrying `collegeCount`. The `popupopen` handler's `async` body moved into a named function
  the void-returning Leaflet callback kicks off.
- **`UserWithCollege` had three identical copies** (`Map.svelte`, `Timeline.svelte`,
  `+page.svelte`). Moved it, plus `groupUsersByCollege`, to `$lib/collegeGroups.ts`. This is
  also the honest answer to two `svelte/prefer-svelte-reactivity` reports: a grouping
  accumulator that never outlives its function has no business being a `SvelteMap`, and in a
  `.ts` module it does not have to be. The two maps that really are component-lifetime state
  (`markersByCollege`, `collegeInfoCache`) became `SvelteMap`; `preseededMap` is built from an
  iterable instead of filled by `.set`, since it is read-only for the component's life.
- **`formText()` in `$lib/server/form.ts`**: `FormData.get` returns `string | File | null`,
  and a client may send a file part for any field. `[object File]` was reaching first names,
  passwords and `parseFloat`. Non-text now reads as absent. (10 `no-base-to-string` errors.)
- **SvelteKit idiom**: `redirect()` throws internally in v2 and is typed `never`, so the
  legacy `throw redirect(...)` was both redundant and an `only-throw-error` violation (7
  sites). Internal links now `resolve()` their hrefs (7 `svelte/no-navigation-without-resolve`).
- Numbers in template literals are stringified explicitly (14 sites).

`svelte-check`: 0 errors. The one remaining warning (`state_referenced_locally` on
`+page.svelte:19`) pre-dates this work and is untouched.

### `apps/clarity-mcp` — 10 → 0

The Searx response was _asserted_ (`JSON.parse(body) as SearxResponse`), not validated, so
declaring `results?: SearxResult[]` claimed field types the code then defensively re-coerced
with `String()` / `Number()`. That is why the checker called the conversions redundant _and_
the runtime guard dead — the declaration was the thing that was wrong. Typed `results` as
`unknown[]` (the treatment `unresponsive_engines` already had) and narrowed each row where it
is read, so the guard is real and the conversions are gone rather than hidden.

**Behaviour note:** a non-string `title`/`url`/`content`/`engine`/`category` from the backend
now reads as `""` instead of its `String()` rendering. For a search backend that always sends
strings this is a no-op; it is a deliberate, narrow change and the only one in this project.

Also `while (true)` → `for (;;)` in `readResponseText`, and the deprecated
`z.string().url()` → `z.url()`.

### `packages/svelte-ws` — 10 → 0

`websocket-runtime.ts` took an unannotated `httpServer`, and its `import("SERVER_HOOKS")` is
an unresolvable copy-time placeholder (the adapter rewrites it in `builder.copy`), so both
were `any` and the `upgrade` listener's three params with them. Annotated `httpServer` as
`node:http`'s `Server` — which alone gives the listener its real
`IncomingMessage`/`Duplex`/`Buffer` types — and gave the dynamic import the shape it is
rewritten to. In `vite.ts`, `prependListener` is only typed through `EventEmitter`'s
catch-all overload, so the upgrade params are annotated once instead of cast three times at
the call site. `index.ts`: `opts` has a `{}` default, so `opts ?? {}` was dead.

### `packages/console-bus-rpc` — 3 → 0

`addEventListener`'s `open`, `close` and `error` overloads were identical apart from the
literal type. Merged into one union-typed signature; `message` keeps its own overload because
its listener genuinely differs.

### `apps/grove` — 1 → 0

Root layout's `$props()` was unannotated, making `{@render children()}` an unsafe call.
Typed as `Snippet`.

## 3. Formatting

`eslint --fix` in 54ed1b4 shortened expressions without rejoining the lines it had wrapped,
leaving 13 files that oxfmt disagreed with. Reflowed; whitespace only, committed separately
so it does not muddy the fix commits.

## Not done / left alone

- **The PR was not merged and `main` was not touched**, per the brief.
- **Nothing was suppressed to reach green.** The only disable blocks in `eslint.config.ts`
  are the two sanctioned debt blocks (`apps/slide/**` → #336, `apps/console/**` → #337). No
  inline `eslint-disable` comments were added anywhere.
- **No lint scope was narrowed.** The only `ignores` entry left is `.gitignore` via
  `includeIgnoreFile`.
