# Grove console

The console uses the `console-legacy` operational identity with shared DaisyUI fields and actions.

- ENERGY 1 / RHYTHM 1 / MOTION 1: predictable task controls, compact rows, and brief state transitions.
- Schibsted Grotesk is self-hosted through fontless. Body and heading weights are 400 and 500.
- IBM Plex Mono is self-hosted at weight 400 for IDs, digests, and provenance references.
- Paper and ink follow the existing Grove color-scheme preference and theme toggle.
- Surfaces are flat and borderless; hairline rules separate rows and sections. Corners use 2px radii.
- Sienna fills primary actions to distinguish mutations from navigation. Accent colors are #8a3c28 in paper and #ec8a76 in ink.
- Layout uses an 8px spacing grid. Work and Library occupy a 240px navigation rail on wide screens and a top row on narrow screens; this keeps project work separate from artifact retrieval.
- Work and Library retain the project ID and project Version in the URL. Server responses, not decorative status indicators, establish ready work and provenance.
- Remote forms use native submission and progressive enhancement. Project creation has its own page, task actions expand inline, and action errors appear at bottom left.
- Planning and account edits use query overrides for immediate feedback, rollback on failure, and authoritative refresh on success.
- The account menu displays session-backed name and email, account settings, appearance, and sign-out.
- Short state transitions respect reduced-motion preferences. Text and provenance wrap without hiding identifiers.
- Copy names actions and states. Receipt and version instructions appear only in the relevant form.
- Lucide follows the lab's icon standard. List and library glyphs distinguish destinations, plus marks creation, and moon/sun identify appearance controls.
