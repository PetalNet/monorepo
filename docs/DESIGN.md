# Design

> **v0 draft** — grounded in the current token system (`packages/tokens/`).
> Sections marked **OPEN** need Parker/Eli's aesthetic direction; they are
> deliberately _not_ decided here. Everything else traces to a real file in
> this repo — file paths are cited inline. If a claim isn't cited, treat it as
> an OPEN proposal, not established fact.

Nine sections: theme · color · type · spacing · layout · components · motion · voice · anti-patterns.

The authoring source of truth is DTCG JSON under `packages/tokens/src/`,
compiled by `style-dictionary` (see `docs/ARCHITECTURE.md` § "Tokens flow").
Tailwind v4 + DaisyUI are the runtime. This doc describes that system and how
apps should consume it — it does not redefine it.

---

## 1. Theme

**Grounded.** There are exactly two themes, both built from one shared set of
primitives. The semantic layer is what switches; primitives never change across
themes (`packages/tokens/tools/build.mts`, lines 71–94; `README.md` line 18).

- `src/semantic/light.json`
- `src/semantic/dark.json`

Same key shape in both files (the dark file's `$description` literally says
"Same key shape as light/\*"). The build emits per-theme CSS scoped by selector
(`build.mts` lines 84–86):

- light → `:root, [data-theme="light"]`
- dark → `[data-theme="dark"]`

So theme-switching at runtime is "one attribute flip" on the `data-theme`
attribute (`packages/tokens/README.md` line 18). DaisyUI's `@plugin "daisyui"`
block claims these variables; the documented wiring (README lines 38–47) is:

```css
@import "@petalnet/tokens/css";
@import "tailwindcss";
@plugin "daisyui" {
	themes:
		light --default,
		dark --prefersdark;
}
```

`--prefersdark` means dark follows the OS `prefers-color-scheme` by default.

**Proposed — OPEN.** No app in the repo currently wires a theme toggle or sets
`data-theme` (grep found zero `data-theme` usages in `apps/`). The default-vs-
prefers behaviour above is the token README's example, not an enforced app
convention yet. **OPEN:** is light or dark the canonical default? Is there a
user-facing toggle, or OS-follow only?

---

## 2. Color

**Grounded — primitives** (`src/primitives/color.json`). The palette is a
Zinc-style neutral ramp plus four single-stop accents:

| Group | Stops present | Values |
| --- | --- | --- |
| `color.gray` | 50–950 (11 stops) | `#fafafa` `#f4f4f5` `#e4e4e7` `#d4d4d8` `#a1a1aa` `#71717a` `#52525b` `#3f3f46` `#27272a` `#18181b` `#09090b` |
| `color.amber` | 50, 500, 700 | `#fffbeb` `#f59e0b` `#b45309` |
| `color.blue` | 50, 500, 700 | `#eff6ff` `#3b82f6` `#1d4ed8` |
| `color.green` | 500 only | `#22c55e` |
| `color.red` | 500 only | `#ef4444` |

Note the asymmetry: gray is a full ramp; amber/blue have 3 stops; green/red
have a single 500. That's the actual state — not an oversight to paper over.

**Grounded — semantic** (`src/semantic/light.json`, `dark.json`). Ten semantic
color tokens, each a reference to a primitive (except `surface` in light, which
is a raw `#ffffff`):

| Token | Light → | Dark → |
| --- | --- | --- |
| `semantic.color.bg` | `{color.gray.50}` | `{color.gray.950}` |
| `semantic.color.surface` | `#ffffff` (raw) | `{color.gray.900}` |
| `semantic.color.surface-2` | `{color.gray.100}` | `{color.gray.800}` |
| `semantic.color.fg` | `{color.gray.900}` | `{color.gray.100}` |
| `semantic.color.fg-dim` | `{color.gray.600}` | `{color.gray.400}` |
| `semantic.color.border` | `{color.gray.200}` | `{color.gray.800}` |
| `semantic.color.accent` | `{color.blue.500}` | `{color.blue.500}` |
| `semantic.color.ok` | `{color.green.500}` | `{color.green.500}` |
| `semantic.color.warn` | `{color.amber.500}` | `{color.amber.500}` |
| `semantic.color.err` | `{color.red.500}` | `{color.red.500}` |

What flips light↔dark: the neutral roles (`bg`, `surface`, `surface-2`, `fg`,
`fg-dim`, `border`) invert across the gray ramp. What stays constant: the four
status/accent colors (`accent`, `ok`, `warn`, `err`) are identical in both
themes — they're the brand/status signal that should read the same regardless
of mode.

**How to consume.** Apps reference semantic tokens, not primitives:

```css
background: var(--semantic-color-bg);
color: var(--semantic-color-fg);
```

(CSS-var name = the kebab-cased token path; `build.mts` line 24 emits
`--${t.name}`, and the README example uses `tokens["semantic-color-bg"]`.)

**Proposed — OPEN.**

- The accent is currently **blue 500 (`#3b82f6`)**. Whether that's the
  PetalNet brand accent or a placeholder is an aesthetic call. **OPEN.**
- `accent` has no hover/active/pressed variant token and no `accent-fg`
  (on-accent text color). Apps need one for buttons — **OPEN** whether to add
  semantic tokens (`accent-hover`, `accent-fg`) or lean on DaisyUI's computed
  states.
- amber/blue carry a `50` and `700` stop that no semantic token references yet
  — presumably reserved for tints/hover. **OPEN:** intended use?

---

## 3. Type

**Grounded** (`src/primitives/type.json`).

**Families** (`font.family.*`):

- `sans`: `Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- `serif`: `Fraunces, ui-serif, Georgia, serif`
- `mono`: `JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

Inter and Fraunces and JetBrains Mono are named first but each has a full
system fallback stack — important given the "fontless" rule (§9). The fallback
chain is what renders if the webfont isn't self-hosted.

**Size scale** (`font.size.*`, all `rem`):

| Token | rem | px @16 |
| --- | --- | --- |
| `xs` | 0.75 | 12 |
| `sm` | 0.875 | 14 |
| `base` | 1 | 16 |
| `lg` | 1.125 | 18 |
| `xl` | 1.25 | 20 |
| `2xl` | 1.5 | 24 |
| `3xl` | 1.875 | 30 |
| `4xl` | 2.25 | 36 |

This is the standard Tailwind ramp, capped at `4xl` (36px) — no display/hero
sizes above that.

**Weights** (`font.weight.*`): `regular 400`, `medium 500`, `semibold 600`,
`bold 700`. No 300/800/900.

**Proposed — OPEN.**

- No `lineHeight` or `letterSpacing` tokens exist. **OPEN:** add them, or defer
  to Tailwind/DaisyUI defaults?
- `serif` (Fraunces) is defined but unreferenced by any semantic token — is it
  for headings, or unused? **OPEN.**
- No semantic "role" tokens for type (e.g. `text.body`, `text.heading`) — only
  the primitive scale. Whether to add a semantic type layer is **OPEN**.

---

## 4. Spacing

**Grounded** (`src/primitives/space.json`).

**`space.*`** (rem-based, with two pixel anchors):

| Token | Value |
| --- | --- |
| `0` | `0px` |
| `px` | `1px` |
| `1` | `0.25rem` (4px) |
| `2` | `0.5rem` (8px) |
| `3` | `0.75rem` (12px) |
| `4` | `1rem` (16px) |
| `6` | `1.5rem` (24px) |
| `8` | `2rem` (32px) |
| `12` | `3rem` (48px) |
| `16` | `4rem` (64px) |
| `24` | `6rem` (96px) |

It's a 4px-based scale (Tailwind-aligned numbering) but **sparse** — `5`, `7`,
`9`, `10`, `11` etc. are intentionally absent. Compose from the present steps;
don't reach for arbitrary in-between values.

**`radius.*`** (`space.json` lines 16–25):

| Token | Value |
| --- | --- |
| `none` | `0px` |
| `sm` | `0.125rem` (2px) |
| `md` | `0.375rem` (6px) |
| `lg` | `0.5rem` (8px) |
| `xl` | `0.75rem` (12px) |
| `2xl` | `1rem` (16px) |
| `full` | `9999px` |

**Proposed — OPEN.** No shadow/elevation tokens, no border-width tokens, no
z-index scale exist in the token source. collegemap hand-codes shadows and
`z-index: 1000+` (see `apps/collegemap/src/routes/+page.svelte` style block).
**OPEN:** promote elevation + z-index to tokens?

---

## 5. Layout

**Proposed — OPEN.** There is **no layout token set or grid system** in
`packages/tokens/`. The only real layout code in the repo is collegemap's
hand-rolled flex layout (`apps/collegemap/src/routes/+page.svelte`):
full-height `flex-direction: column` shell (`height: 100dvh`), a fixed header,
a `flex: 1; min-height: 0` map area, and absolutely-positioned overlays at
`z-index: 1000+`. That's one app's bespoke layout, not a system.

Starting proposals (all **OPEN**, need sign-off):

- Use the spacing scale (§4) for all gaps/padding; no arbitrary px.
- Define a max content width + container token (none exists).
- Standardize breakpoints. collegemap uses `min-width: 480px` and `640px`
  inline — these aren't tokenized. **OPEN:** adopt Tailwind's default
  breakpoints, or define our own?
- Prefer `dvh` over `vh` for full-height shells (collegemap already does, and
  per memory a `height:100%` cap once broke a scroll fix — full-height layouts
  are a known footgun here).

---

## 6. Components

**Grounded baseline.** The runtime component layer is **DaisyUI on Tailwind v4**
(`docs/ARCHITECTURE.md` line 34, root `README.md`). DaisyUI's themed component
classes (`btn`, `card`, `input`, `menu`, …) read the semantic CSS variables, so
a component built with DaisyUI classes inherits theme-switching for free.

A shared `@petalnet/ui` package is _planned_ (`docs/ARCHITECTURE.md` line 10,
`README.md` layout) but **does not exist yet** — there is no
`packages/ui/`. So today there is no shared component library; collegemap rolls
its own `.btn-primary` / `.btn-outline` in scoped `<style>`
(`apps/collegemap/src/routes/+page.svelte` lines 428–461) **without DaisyUI**.

**Proposed — OPEN.**

- When `@petalnet/ui` lands, components should be DaisyUI-based and consume only
  semantic tokens — never primitives, never hard-coded hex. **OPEN:** confirm
  DaisyUI is the component substrate vs. a from-scratch Svelte set.
- Buttons need an on-accent text token + hover state (see §2 OPEN).
- collegemap's hand-rolled buttons should be re-expressed via DaisyUI/tokens
  during its token migration (see §9). Flagged, not yet done.
- Svelte 5 runes only for any component logic (`$props`, `$state`, `$derived`,
  `$effect`) — collegemap already follows this
  (`apps/collegemap/src/routes/+page.svelte`). See §9.

---

## 7. Motion

**No motion system exists in the repo.** There are no motion/duration/easing
tokens in `packages/tokens/`. The only motion in the repo is collegemap's
ad-hoc CSS: `@keyframes fade-in / slide-up / slideIn`, plus inline
`transition: ... 0.2s` and staggered `animation-delay: {i * 40}ms`
(`apps/collegemap/src/routes/+page.svelte`, `layout.css`). Durations there
cluster around 0.1s–0.5s and easing is mostly `ease`.

**Proposed minimal starting point — OPEN** (nothing below is established):

- Duration tokens: `fast 120ms`, `base 200ms`, `slow 320ms` (brackets the
  values collegemap already uses).
- Easing: a single `standard` ease (e.g. `cubic-bezier(0.2, 0, 0, 1)`) for
  most transitions; `ease-out` for enter, `ease-in` for exit.
- Default to transitioning `opacity` and `transform` only (cheap to composite).

**Reduced motion (should be non-negotiable once adopted):** wrap non-essential
animation in `@media (prefers-reduced-motion: reduce)` and disable/shorten it.
collegemap does **not** currently honour this — flag for its migration.

---

## 8. Voice

This is the lab's UI-copy voice. Context: the homelab is lightly _The Good
Place_-themed and its assistant persona is **Janet** — warm, helpful,
plain-spoken, lightly wry, never corporate-SaaS. UI copy should sound like Janet
wrote it.

**Principles**

- Plain and direct. Say the thing. Short sentences.
- Warm, never cutesy. A light wry edge is welcome; jokes that get in the way
  of doing the task are not.
- Helpful over clever. Error messages tell the user what happened and what to do
  next.
- No corporate filler, no fake urgency, no exclamation spam.
- Lowercase-friendly for incidental microcopy; sentence case for anything
  substantial. Avoid Title Case On Everything.

**Do / Don't**

| Don't (corporate-SaaS) | Do (Janet) |
| --- | --- |
| "Oops! Something went wrong." | "That didn't save — the server didn't answer. Try again?" |
| "Please authenticate to continue." | "You'll need to log in first." |
| "No results found." | "Nothing matches that yet." |
| "Submission successful!" | "Saved." |
| "Are you sure you want to proceed?" | "This deletes the map for everyone. Still want to?" |
| "Loading, please wait…" | "One sec…" |
| "Welcome to your dashboard!" | "Here's what's happening." |

**Proposed — OPEN.** How much _Good Place_ flavour belongs in shipped UI copy
vs. kept to the Janet chat persona? The examples above stay neutral-warm on
purpose. **OPEN** for Parker/Eli to dial up or down.

---

## 9. Anti-patterns

Derived from real repo conventions (cited) plus a few general ones.

**Repo-specific (grounded):**

- **No webfont CDN.** The lab went "fontless" — webfonts are self-hosted or we
  ride the system fallback stack (that's why every family in `type.json` has a
  full fallback chain). ⚠️ **collegemap currently violates this**: its
  `+layout.svelte` (lines 10–12) loads Inter from
  `fonts.googleapis.com`. This must be removed during its token migration.
- **No bespoke per-app color vars.** ⚠️ collegemap's `layout.css` defines its
  own `--bg-page`, `--accent: #6366f1`, `--accent-secondary: #0ea5e9` etc. —
  an entirely separate palette from `@petalnet/tokens` (which uses blue `#3b82f6`
  as accent). Apps should consume `--semantic-color-*`, not invent parallel
  vars. collegemap is pre-token-migration; this is the canonical "don't."
- **No hard-coded hex in components.** Reference semantic tokens. Primitives
  are an implementation detail of the semantic layer.
- **Svelte 5 runes only.** `$props/$state/$derived/$effect`. No legacy
  `export let`, no `$:` reactive statements, no writable stores for component
  state. (collegemap is compliant — use it as the reference.)
- **pnpm only.** pnpm 11 workspace with `catalog:` versions
  (`docs/PLAN.md`, root `README.md`). No npm/yarn lockfiles.
- **No manual asset-version query strings.** Vite hashes assets at build; never
  hand-append `?v=123`. (Per repo tooling + prior lab convention.)
- **Don't edit generated token outputs.** `dist/tailwind.preset.js` and
  `dist/index.js` are AUTO-GENERATED (`build.mts` lines 55, 67). Edit the DTCG
  JSON in `src/` and rebuild.
- **No Turbo, no Prettier, no changesets** (`docs/PLAN.md`). Task running is
  `vp run`; formatting is `oxfmt`.

**General (sensible defaults, lower-confidence):**

- Don't skip the semantic layer to "save a hop" — direct primitive references in
  app code break theme-switching.
- Don't animate `width`/`height`/`top`/`left`; prefer `transform`/`opacity`.
- Don't ship motion without a `prefers-reduced-motion` escape hatch (§7).
- Don't introduce one-off spacing/radius values outside the scales in §4.

---

## Open questions for sign-off

Aesthetic-direction calls that this draft deliberately does **not** make — for
Parker + Eli:

1. **Overall vibe.** Is PetalNet's UI aiming minimal / Linear-esque, or
   playful / _Good Place_-themed? This anchors most of the calls below and is
   explicitly not decided here. (§ all)
2. **Brand accent.** Keep blue `#3b82f6` as `semantic.color.accent`, or pick a
   real brand color? (§2)
3. **Accent states.** Add `accent-hover` / `accent-fg` semantic tokens, or rely
   on DaisyUI's computed states? (§2, §6)
4. **Default theme + toggle.** Light or dark canonical default? OS-follow only,
   or a user toggle? (§1)
5. **Type system depth.** Add line-height / letter-spacing tokens and a semantic
   type-role layer? Is `serif` (Fraunces) for headings or unused? (§3)
6. **Elevation / z-index / border-width tokens.** Promote to the token source?
   (§4)
7. **Layout system.** Max-width/container token + a canonical breakpoint set
   (adopt Tailwind defaults vs. custom)? (§5)
8. **Component substrate.** Confirm `@petalnet/ui` will be DaisyUI-based, and
   schedule collegemap's migration off its bespoke CSS. (§6)
9. **Motion tokens.** Adopt the proposed duration/easing set (or other), and
   make reduced-motion mandatory? (§7)
10. **Voice flavour.** How much _Good Place_ / Janet personality in shipped UI
    copy vs. neutral-warm? (§8)

---

_v0 draft, task-101. Grounded in `packages/tokens/` and `apps/collegemap/` as of
this commit; cross-reference `docs/ARCHITECTURE.md` § "Tokens flow"._
