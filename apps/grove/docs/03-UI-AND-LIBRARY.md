# Grove final UI and Library design

**Status:** Focused implementation view  
**Normative source:** `01-GROVE-BUILD-SPEC.md`

This reconciles Eli's craft bar, the current Console foundations, and the final Grove Library model.

## 1. Product shell

Grove uses the current unified SvelteKit application. Participant and Admin surfaces share the same identity, domain operations, design system, and deep-link model.

### Participant navigation

- Home
- Library
- Admin, when authorized
- global Ask/Search palette
- recents, pins, and browser-style history/tabs

Rooms, Projects, Tasks, Agents, people, Topics, documents, and artifacts open as typed object pages.

### Admin navigation

Preserve the current operator lenses inside Admin:

- Cockpit
- Work
- Agents
- Hosts
- Observability
- Signals
- Network
- Updates
- Library administration
- Terminal, admin-only

These are curated views over the same substrate, not another product or authority.

### Desktop frame

- 232px sidebar when full Admin navigation is present;
- 56px icon rail at narrower desktop widths;
- 24px page padding;
- no global top bar;
- surface utility row only when controls earn the space;
- persistent Ask/Search access;
- drawers for drill-in without unnecessary route changes.

### Responsive

- Desktop supports dense boards, tables, graph views, and Admin.
- Tablet stacks panels and preserves Room/Task/Library work.
- Phone prioritizes Home, Ask/Capture, Needs You, Room conversation, Task review, and object reading.
- Dense Admin tables get dedicated mobile lenses or remain explicitly desktop-oriented.

## 2. Visual language

### Stack

- SvelteKit 5
- Tailwind v4
- DaisyUI custom themes
- Material 3, not Material Expressive
- Lucide icons
- self-hosted Geist and Geist Mono

### Surfaces

- Borderless.
- Use background steps, elevation, and hairline separators.
- No inset fake borders.
- One deliberate M3 outlined tile pattern is allowed.
- No gradients, glow, cursor light, parallax, reveal-on-scroll, or heavy shadows.
- Dialog is the only substantial shadow.

### Radius

- 2px default for cards, rows, chips, and badges;
- 8px controls and inputs;
- 12px only for assistant-composed canvas panels;
- 16px dialogs;
- pill only when the pattern demands it, including chat bubbles and HUD chips.

### Grid and spacing

Use the 8pt grid:

- 4px inside tight pairs;
- 8px inside a block;
- 16px between blocks;
- 24px page padding;
- 32px major divisions;
- 48px only for major section separation.

Shared components own dimensions. Repeated UI must not drift by route.

### Type

- Geist 400/500 for body and controls;
- Geist Mono for IDs, counts, timestamps, hashes, and data;
- light weights, default tracking;
- no hand-tuned kerning;
- minimum rendered text size 11px;
- self-hosted fonts with fallback metric overrides;
- code text matches surrounding text size unless intentionally scaled.

### Color

- one interaction accent, theme-swapped;
- neutral paper/ink surfaces;
- named semantic status colors;
- no color-only meaning;
- normal text contrast target 7:1;
- large text target at least 4.5:1;
- verify every text/surface pair;
- darken the supplied accent when necessary.

### Icons and copy

- Lucide for every standard icon;
- missing icons become external SVG assets, not inline one-offs;
- no emoji as functional iconography;
- minimal copy;
- em-dash-free UI strings;
- empty state: `All caught up.`

### Motion

Animate state changes only:

- panel settle;
- dock transition;
- status crossfade;
- list reordering;
- one-shot communication cue;
- failure transition;
- snackbar.

No infinite idle animation. Spinners only for active polling/streaming. Reduced motion is none or a simple crossfade.

### Focus and keyboard

- 2px outline hugging the radius, offset 2px;
- 8px clearance around dense interactive chips;
- `/` focuses Ask/Search;
- `Esc` closes or re-docks;
- arrow and Enter navigation for lists/panels;
- `Shift+F10`/menu key for contextual actions;
- deterministic quick navigation that never depends on an LLM.

## 3. Shared components

### ObjectHeader

- type/role chip;
- title;
- current status;
- visibility;
- current Version verification;
- responsible human and Agent;
- primary actions.

### AskCapture

- private by default;
- intent preview;
- destination, context, tools, launch policy;
- accessible correction and cancellation;
- no resting border;
- real focus state.

### NeedsYouCard

- fact-first requirement;
- source and age;
- consequence of inaction;
- exact resolution action;
- delegate, snooze, decline, or policy;
- automatic disappearance after source resolution.

### AgentChip

- Agent identity;
- live state;
- current Task;
- host/model on hover or drill-in;
- private/shared scope;
- presence lease when relevant.

### TaskCard

- title;
- role/origin;
- status;
- assignee/Claim;
- dependency/blocker;
- verification;
- Attempt progress;
- priority/deadline.

### VersionBadge

- current/pinned;
- short digest;
- verified/unverified/invalid;
- signer;
- timestamp;
- opens full verification detail.

### CitationChip

- object title/type;
- living or pinned state;
- permission/share status;
- source/provenance preview;
- copy stable reference.

### RelationshipList

- typed incoming/outgoing links;
- grouped by meaning;
- permission-filtered;
- never dumps raw graph edges without labels.

### PresenceBar

- Room policy mode;
- attached/temporary Agents;
- lease expiry;
- pause/revoke;
- quiet, persistent, not a warning banner.

### Drawer, dialog, snackbar, skeleton

- real components;
- bottom-left stacked snackbars with cap;
- shape-matched skeletons;
- no fake affordances.

## 4. Home design

### Default hierarchy

1. Ask/Capture.
2. Adaptive Needs You / Continue / All caught up region.
3. Optional pinned views.

Do not create a permanent dashboard grid merely to fill the screen.

When Needs You is present, it leads without displacing Ask/Capture. When empty, Ask/Capture becomes the visual center.

### Pinned views

Users may pin:

- saved Library search;
- Project status;
- Room;
- Task branch;
- Topic;
- chart or statistic;
- Agent/host state if authorized.

Pins are Library objects or references, not local-only UI state.

## 5. Library front door

The Library is search-first and Librarian-assisted.

### First view

- Ask/Search;
- held for you;
- relevant to current work;
- recent accepted contributions;
- active Topics/Projects;
- saved views;
- clear access to filters and stacks.

The Personal Librarian powers private personalization. The Grove Librarian powers shared curation. They are visibly distinct.

### Search result

Each result shows:

- title and type;
- why it matched;
- current/pinned Version;
- trust/freshness state where applicable;
- origin and responsible actors;
- relevant relationship;
- permission and share status;
- concise preview.

Weak results are omitted.

### Views

One object graph powers:

- search/list;
- table;
- board;
- timeline;
- graph;
- Topic page;
- Project page;
- citation browser;
- curation queue.

Graph visualization is a lens. The default Library must work without it.

## 6. Object pages

### Universal frame

Header:

- stable identity;
- type and role;
- title;
- status;
- visibility;
- current Version and verification.

Primary body:

- renderer selected by type registry.

Secondary areas:

- related objects;
- backlinks;
- responsible humans/Agents;
- version history;
- provenance;
- actions;
- comments/reviews/approvals.

### Project Task page

- purpose and standing/finite state;
- completion contract;
- Needs You;
- Task DAG overview;
- active Rooms;
- people and Agents;
- key outputs and decisions;
- latest accepted contributions;
- progress and recent changes.

### Task page

- intent and scope;
- DAG parents/children/dependencies;
- readiness/blockers;
- current Claim;
- Attempt history;
- inputs and pinned citations;
- outputs;
- completion contract;
- verification;
- recovery/workspace.

### Room page

- conversation is primary;
- anchor Task and active lanes are visible but quiet;
- members, history policy, Steward, and presence mode;
- agent invocation preview in composer;
- significant Task results inline;
- low-level execution behind Task links.

### Document/research/decision page

- readable content;
- exact Version;
- citations and sources;
- current/preferred/provisional/contradicted/superseded state;
- Topic and Project relationships;
- edit/read parity.

### Artifact page

- preview/download;
- digest and verification;
- producing Task/Attempt;
- versions;
- reviews/approvals;
- distribution references.

### Agent page

- identity and sponsor/scope;
- role profile;
- lifecycle;
- current Runtime;
- model and placement policy;
- Tasks and Rooms;
- memory boundary;
- provenance/history.

## 7. Library information model in the UI

### Personal and Grove

Every create/publish flow clearly shows:

- Private;
- Grove;
- Explicitly restricted.

Project affiliation is shown as origin, not mistaken for visibility.

### Versions

Default object links are living. Evidence and publication automatically pin Versions.

The UI must make the difference understandable:

```text
Current
```

versus:

```text
Pinned to v12 · sha256:…
```

Version history supports:

- compare;
- verify;
- cite;
- see parents;
- see actor/authority;
- restore by creating a new Version, never rewriting history.

### Provenance

Show the meaningful chain:

```text
Prompted by Room message
Planned under Project Task
Produced by Attempt 3
Reviewed by Agent R
Approved by Eli
Published to Grove
```

Each hop opens the exact object Version. There is no generic Record page.

### Topic pages

A Topic is a living map:

- current synthesis;
- strongest sources;
- relevant decisions;
- competing claims;
- open questions;
- related Projects/Tasks/Rooms;
- artifacts/capabilities;
- recent changes.

Librarian synthesis is labeled and never hides source disagreement.

### Curation

Automatic reversible actions:

- indexing;
- aliases;
- summaries;
- suggested relationships;
- duplicate clusters;
- freshness/source checks.

Reviewable actions:

- meaning-changing merge;
- canonical preference;
- destructive consolidation;
- permission change;
- deletion/redaction;
- external publication.

## 8. Work/DAG presentation

Use multiple lenses over the same Tasks:

- outline/tree for decomposition;
- DAG view for dependencies;
- board for lifecycle;
- timeline for Attempts and changes;
- table for filtering;
- compact inline lanes in Rooms.

The DAG view:

- distinguishes hierarchy from dependency;
- highlights ready, running, blocked, review, completed;
- shows critical path when useful;
- collapses invocation microtasks by default;
- never hides blockers;
- supports keyboard navigation;
- does not imply that physical screen position is authority.

## 9. Admin design

Reuse the current operator console strengths:

- attention-first Cockpit;
- Agent roster with Runtime/lease/health;
- hosts/services;
- signals/bus;
- observability;
- network;
- updates/security;
- terminal behind explicit admin authorization.

Requirements:

- true current state;
- stale watermarks;
- recovery actions based on executor liveness;
- one command plane shared with agents;
- source/provenance on every statistic;
- routine signals do not become participant notifications.

## 10. Markdown parity

Where Markdown has edit and read views:

- identical content padding;
- identical line-height and font sizes;
- code size equals surrounding text unless intentionally different;
- identical list marker position/size/color;
- identical blockquote geometry;
- code block padding accounts for fences;
- browser screenshot diff required.

## 11. Accessibility and verification

Before a surface is complete:

- AAA contrast measured for every pair;
- all actions keyboard-reachable;
- focus order logical;
- focus visible;
- screen-reader names and state present;
- no color-only state;
- reduced motion verified;
- 200% zoom and reflow checked;
- shape-matched loading states;
- honest empty/error/stale states;
- Chrome, Safari, and Firefox tested;
- typecheck, lint with zero warnings, knip, and format green;
- all visible affordances wired to real operations.

## 12. UI anti-patterns

Reject:

- separate Work/Rooms/Agents silos that make Library discovery secondary;
- giant graph as the default navigation;
- project switchers that trap users in one context;
- permanent notification feeds;
- checkbox approval cascades;
- ambient shared UI agents;
- fake freshness;
- raw event/RPC traffic in Room chat;
- borders and hand-tuned spacing drift;
- emoji controls;
- gradient/glow spectacle;
- actions that exist only in UI;
- mutable or unverified provenance displays;
- review against an unpinned current object.
