# Design mode — disclosed reference

Setup-time and surface-specific detail pulled out of `SKILL.md` so the top stays legible. Read the
section you need.

## fontless setup

Configure fonts through the `fontless` Vite plugin (self-hosted, no Google Fonts network call). fontless
already emits the `@font-face` defaults — `font-display: swap`, `unicode-range`, `font-weight`,
`font-style`, `font-stretch`, `font-feature-settings`, `font-variation-settings` — so set fonts via its
font objects rather than hand-writing `@font-face` or re-declaring `font-display`.

What you own on top of the defaults:

- **Preload** critical fonts.
- **Fallback metrics:** `size-adjust` + `ascent-override` on fallback fonts to kill layout shift.
- **Preconnect** external services (e.g. the favicons service).

Geist is the lab typeface.

## Markdown read/edit parity

Applies only where content is both authored and rendered — a markdown editor with an edit view and a
rendered read view.

Where it applies, the two views must match exactly:

- Same padding and line-height.
- Same font sizes; **code font-size equals surrounding text** unless deliberately scaled.
- Same bullet size and color.
- Same blockquote bar position and size.
- Code-block padding accounts for the ` ``` ` fence so the block doesn't shift between modes.

**Diff the two views in a headless browser before calling it done** — don't eyeball it.

## Notifications and messages — toasts are an antipattern

Per Primer, toasts are **not recommended**: they pose significant accessibility problems, so default to
persistent, contextual feedback instead of a transient auto-dismissing toast.
https://primer.style/accessibility/patterns/accessible-notifications-and-messages/#toasts

Why toasts fail: users can't be guaranteed enough time to read or act before auto-dismiss; the toast's
DOM placement is disconnected from what triggered it, hurting discovery; focus-order and status-
announcement disruption for AT; text-resize and inconsistent-implementation problems.

Reach for these instead (persist the feedback, keep it close to the triggering action):

- Simple successful action: usually no confirmation needed (the result is self-evident).
- Complex action / long-running task: a persistent **banner** (or progressive disclosure; for long
  tasks, an external notification like email/push).
- Errors: a passive **banner**, or a **dialog** when it must actively interrupt.
- Form validation: **inline validation** on the field.

If a transient toast is genuinely unavoidable, it must at minimum: announce via an `aria-live` region
(`role="status"` polite, `role="alert"` assertive only for errors); never carry an action or information
that lives ONLY in the toast; auto-dismiss slowly and pause on hover/focus; not steal focus; keep any
action keyboard-reachable; and not rely on color alone.
