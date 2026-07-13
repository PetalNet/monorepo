---
name: Lab Console
description: A calm, evidence-first operating surface for Neighborhood 12358W.
colors:
  paper: "#ffffff"
  paper-raised: "#fbfaf9"
  ink: "#161412"
  ink-secondary: "#3a3631"
  ink-caption: "#524d47"
  petal-action: "#8a3c28"
  petal-identity: "#bc5638"
  jade-proof: "#14574c"
  danger: "#8c2735"
  warning: "#684508"
  success: "#14522f"
typography:
  sign:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "-0.012em"
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.06em"
rounded:
  surface: "2px"
  control: "8px"
  assistant-panel: "12px"
  dialog: "16px"
  pill: "999px"
spacing:
  pair: "4px"
  block: "8px"
  section: "16px"
  page: "24px"
  major: "32px"
components:
  button-primary:
    backgroundColor: "{colors.petal-action}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    height: "40px"
  panel:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "16px"
---

# Design System: Lab Console

## 1. Overview

**Creative North Star: "The Honest Neighborhood"**

Paper, ink, and familiar Material 3 discipline make a dense operations tool feel calm. Burnt-sienna petal is reserved for interaction and identity; jade marks place, live proof, and the assistant. Good Place references are a humane second read, never the information architecture.

The system rejects generic SaaS card grids, neon terminal theater, glassmorphism, decorative motion, and any state that looks healthier than its evidence allows.

**Key Characteristics:** borderless tonal surfaces; hairline separation; compact 8pt rhythm; evidence-first state; one signage moment per screen; shared operational primitives.

## 2. Colors

Paper and warm ink carry the surface, with a single interaction accent and a tightly scoped proof accent. Dark mode uses the paired Ink values defined in `src/app.css`.

**The Two-Accent Charter.** Petal is interaction and identity. Jade is place and proof, never a button color. Status colors always pair dot and text grades.

## 3. Typography

**Display Font:** Iowan Old Style / Palatino, with Georgia fallback
**Body Font:** Geist, with system sans fallback
**Label/Mono Font:** Geist Mono

The serif appears once per screen for signage. All controls, body copy, data, IDs, timestamps, and numerals remain Geist; numerals are tabular mono. Weight never exceeds 500 and the rendering floor is 11px.

## 4. Elevation

Depth comes from `--bg`, `--s1`, `--s2`, and hairline rules. Resting cards have no border and no shadow. The single `--shadow-pop` token is reserved for dialogs; docks may use the specified inset hairline ring.

**The Borderless Surface Rule.** Separate regions with tonal steps and 1px hairlines, never decorative outlines or wide ambient shadows.

## 5. Components

Buttons use 8px corners, measured filled or tonal pairs, 32px minimum targets, visible 2px outset focus, and 120–160ms state transitions. Chips are compact 2px or semantic pills. Panels default to 2px corners; only assistant-composed panels use 12px. Inputs are borderless fills with an outset focus ring. Navigation uses 32px rows, 16px Lucide icons, a tonal active state, and collapses from 232px to a 56px rail.

Every interactive component includes hover, focus, active, disabled-with-reason, loading, and error behavior where meaningful. Loading uses shape-matched skeletons. Empty, stale, degraded, and offline states remain in place and preserve last-known context.

## 6. Do's and Don'ts

### Do:

- **Do** use only the committed tokens in `src/app.css`, including the measured AAA text grades.
- **Do** keep spacing on the 4/8/16/24/32/48/64px system and radius at 2px by default.
- **Do** use Lucide icons and plain functional labels, with lore as secondary copy.
- **Do** show provenance, freshness, executor gating, and unknown values explicitly.

### Don't:

- **Don't** build a generic SaaS card grid, neon terminal fantasy, glassmorphic control room, or novelty fan interface.
- **Don't** hide uncertainty, fabricate freshness, or render null as zero.
- **Don't** use emoji, inline SVG UI icons, decorative gradients, colored side stripes, or borders around resting surfaces.
- **Don't** substitute lore for plain labels or animate anything that is not a state change.
