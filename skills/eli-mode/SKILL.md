---
name: eli-mode
description: >-
  How Eli (GitHub lishaduck) reviews code and directs work. Use when writing or reviewing code, PRs,
  or docs for PetalNet or Eli's projects, when pre-reviewing a PR before Eli sees it, or when asked to
  review "like Eli" or work in his style.
---

# Eli mode

Evidence-backed rules for how the reviewer reviews and what he expects from work handed to him. Each
rule appeared across several independent slices of his GitHub reviews or chat. Where this file is
silent, use the referenced skills.

## Calibrate the review

- Volume: about a sixth of PRs get no comment and a third get one. Large refactors get five or more.
  Do not invent findings to fill a review, but when you do comment, read every changed line: his
  points are often small and local (a stray comment, a leftover config entry, a test helper).
- An approval can still carry a one-line idea for later: a lint rule that would catch this class of
  bug, a follow-up refactor, an upstream issue.
- Verdict follows the comments. No comments, or only praise: APPROVE. Any inline question or
  suggestion you want answered: COMMENT (his choice about 70% of the time once he has inline
  comments). APPROVE alongside comments only when every comment is an optional nit or a future idea.
  REQUEST_CHANGES is rare and light: one concrete problem that must change before merge.
- Short comments, usually one to three sentences. Write a concrete fix as a ```suggestion block. An
  empty suggestion block means "delete these lines".
- Ask instead of assert when the reason for a change is not visible: "Why is this needed?", "Is this
  still used?", "Was this intentional?".
- Mark weight. Say which point blocks and which is optional or taste. Defer taste and product calls to
  the owner.
- Say how deep you went ("skimmed the tests", "only reviewed the host changes").
- Push improvements that are not needed now to a linked follow-up issue or PR rather than holding the
  merge.
- Back a claim with a link to the primary source (docs, spec, upstream issue or line).
- When you were wrong, retract in-thread.

## What he flags, by evidence

1. **Dead weight.** Commented-out code, unused files, exports, deps and imports, leftover entries, and
   config that is a default or implied by another option. Code that exists only to work around a tool
   or to satisfy a test. Ask to delete it. See principle-subtract-before-you-add and
   principle-laziness-protocol.
2. **Hand-rolled code with a built-in or existing option.** Point to the platform or stdlib API
   (`RegExp.escape`, `util.styleText`, `toSorted`, `import.meta.resolve`, `fs.glob`, Temporal), the
   dependency's own option, or the repo's existing helper.
3. **Unexplained or out-of-scope changes.** Incidental churn, unrelated fixes, renamed things, removed
   behavior. Ask why, or ask to split them into their own PR.
4. **Escape hatches.** Every `any`, `as` cast, `@ts-ignore`/`@ts-expect-error`, `eslint-disable` and
   ignore-list entry needs a reason. Ask for the real type, a runtime check, or the narrowest
   suppression. When a type should reject an input, make it a type error (`key?: never`, exact
   types) rather than relying on convention. Fix lint and knip findings at the cause, never in config. See
   principle-type-system-discipline.
5. **Dependencies.** Question each new dependency against what it is used for. A large package for a
   small constant list or one helper should be inlined or replaced by a built-in. Then the metadata:
   runtime vs dev dependency, `workspace:^` and `catalog:` specifiers, unused or
   duplicate deps, version floors that match the APIs used, engines that match the minimum supported
   runtime.
6. **Prose.** Copy-edit docs, READMEs, changesets and user-facing messages with suggestion blocks.
   Precise wording, correct product casing (Node.js, pnpm, TypeScript, VS Code), no claims beyond what
   ships, no AI-flavored styling (emoji-bold bullet lists, runs of tiny sentences). See unslop and
   technical-writing.
7. **Single source of truth and boundaries.** Derive lists and values from the existing source instead
   of a parallel hardcoded copy. Keep code in its layer and package. Pass capabilities (fs, cwd, env)
   through the existing abstraction instead of reaching for globals.
8. **Deprecated or legacy choices.** Name the current replacement and link it. Prefer maintained
   runtime versions and current APIs.
9. **Comments in the diff.** Read them like code. A TODO stays next to the code it is about and links
   an issue. New public members, options and type augmentations get doc comments. Links in comments
   must not go stale. Narrating comments go.
10. **The PR's goal, applied to all of it.** If the PR removes reliance on something (a global, a Node
    API, a helper), flag what still uses it, including tests, and sibling code paths that need the same
    change. Suggest a stacked follow-up PR for the siblings.
11. **Platform-neutral shared code.** Core and library code should run outside Node. Flag `node:*`
    imports and Node-only packages there and route them through the existing host or adapter.
12. **Recurring mistakes.** Suggest the lint rule, compiler flag or script that would catch the class
    next time. See principle-encode-lessons-in-structure.
13. **Names.** Domain names over generic ones, consistent with the project's existing terms.
14. **Process gaps.** A TODO without a tracking issue. A public package behavior change without a
    changeset (user-facing, full sentences; refactors get none). A related open PR or issue that
    should be linked. Tests removed or weakened without replacement. A branch that is behind main or
    conflicting: ask for a rebase (check this when you have the repo, not just the diff).
15. **CI and config.** Least-privilege permissions, steps or jobs that are redundant or serialized for
    no reason.

For a performance change, ask for the measurement that is missing (memory as well as time, a
benchmark run). Keep it non-blocking.

He rarely raises: speculative edge cases, generic "add more tests", error-handling hardening on
internal code, or restating what the PR does.

## Writing code for him

- Smallest change that solves it. Delete before adding.
- Root causes over workarounds. Read the dependency's source. If the bug is upstream, patch or report
  it there. See principle-fix-root-causes.
- One concern per PR. Unrelated cleanups go in their own PR.
- Latest stable versions and current APIs. Built-ins over new dependencies.
- PR descriptions and docs are terse. No abbreviations in user-facing prose.
- UI work follows eli-design-mode.
- Evidence over reassurance. Prove the root cause (measure, profile) before fixing, and show the
  benefit justifies the cost: "I need cold hard evidence of this in practice."
- Use the platform or a tool already in the stack before hand-writing it.
- Simplify while keeping the same guarantees.
- Refine and preserve: don't redesign or rewrite copy beyond the ask, and don't settle for merely
  adequate work either.
- Model identity, state and types truthfully (people vs agents, real shapes, not a neighbouring
  tool's). Write types out directly rather than via `ReturnType`/`Parameters`; type imports up top.
- Research prior art and upstream source, and ask why the better option isn't already the default.
- Effect code: services get their dependencies injected through Layers, named per the Effect v4
  conventions.
- Git hygiene: feature branches cut from the latest upstream default branch.
- Show UI changes working in a real browser (before/after screenshots).

## Directing work (from his chat)

- Reversible work proceeds without asking. Report results, not plans.
- Done means the user-visible result is verified, not that a command succeeded. See
  principle-prove-it-works.
- Changes land as PR, review, merge. Deploy only merged main. Self-merge only where he has explicitly
  granted it for that project.
- New PetalNet projects go in the public monorepo. Prefer declarative infra.
- Nothing lives only in chat. Reviews he asks for go in the PR.
- Steelman. Surface the strongest objection before agreeing and do not fold without new reasoning.
- Delete aggressively: stale docs, plans once implemented, archived repos, compat fallbacks.
- Fan work out: independent streams go to separate agents, threads and branches, never one big
  pass. Every change must be independently reviewable; order stacks by their real dependencies and
  parallelize the rest. "How am I supposed to review this? Restart, multithreading."
- When an ask sets permissions (push, open a PR, merge) or scope ("not worth a test"), they override
  the default above: "Don't push without my permission" means exactly that.
- Commission adversarial reviewers with distinct focuses (security, simplicity) before trusting a
  result.
- Let CI validate instead of long local runs.
- Tell him when he is wrong. He asks for it.

## Maintenance

Change a rule only with evidence from his reviews.
The "Writing code" and "Directing work" additions from 2026-10-07 come from his public Amp threads
(39 threads, 365 messages incl. his 16 curated highlights; his Amp "review" threads
are agent-driven and count as weak evidence only). Keep them out of the review rules until his PR
reviews confirm them. The "infer, don't add an explicit type" quote (Flint caching design) is about rule metadata, not return types.
