---
name: Label Studio
description: Design a tape label, see exactly what the printer will burn, print it in seconds.
colors:
  accent: "oklch(0.5 0.12 155)"
  accent-hover: "oklch(0.45 0.12 155)"
  on-accent: "oklch(0.99 0.01 155)"
  accent-soft: "oklch(0.5 0.12 155 / 0.12)"
  accent-text: "oklch(0.45 0.12 155)"
  ground: "oklch(0.962 0.004 165)"
  panel: "oklch(0.994 0.002 165)"
  sheet: "oklch(1 0 0)"
  sunken: "oklch(0.935 0.005 165)"
  rule: "oklch(0.9 0.005 165)"
  rule-strong: "oklch(0.84 0.006 165)"
  ink: "oklch(0.21 0.008 165)"
  ink-2: "oklch(0.43 0.01 165)"
  ink-3: "oklch(0.49 0.01 165)"
  hover: "oklch(0.21 0.008 165 / 0.055)"
  press: "oklch(0.21 0.008 165 / 0.1)"
  dimension: "oklch(0.52 0.01 165)"
  danger: "oklch(0.53 0.19 27)"
  danger-soft: "oklch(0.53 0.19 27 / 0.1)"
  warn: "oklch(0.5 0.11 70)"
  warn-soft: "oklch(0.75 0.15 75 / 0.16)"
  scrim: "oklch(0.2 0.01 165 / 0.32)"
  tape: "oklch(0.992 0.003 95)"
  tape-shade: "oklch(0.955 0.004 95)"
  tape-ink: "oklch(0.16 0 0)"
  accent-dark: "oklch(0.76 0.15 155)"
  accent-hover-dark: "oklch(0.81 0.14 155)"
  on-accent-dark: "oklch(0.2 0.04 155)"
  accent-soft-dark: "oklch(0.76 0.15 155 / 0.14)"
  accent-text-dark: "oklch(0.8 0.14 155)"
  ground-dark: "oklch(0.165 0.005 165)"
  panel-dark: "oklch(0.205 0.006 165)"
  sheet-dark: "oklch(0.24 0.007 165)"
  sunken-dark: "oklch(0.14 0.005 165)"
  rule-dark: "oklch(0.29 0.007 165)"
  rule-strong-dark: "oklch(0.36 0.008 165)"
  ink-dark: "oklch(0.95 0.004 165)"
  ink-2-dark: "oklch(0.83 0.008 165)"
  ink-3-dark: "oklch(0.76 0.008 165)"
  hover-dark: "oklch(0.95 0.004 165 / 0.06)"
  press-dark: "oklch(0.95 0.004 165 / 0.11)"
  dimension-dark: "oklch(0.74 0.008 165)"
  danger-dark: "oklch(0.77 0.14 25)"
  danger-soft-dark: "oklch(0.72 0.16 25 / 0.14)"
  warn-dark: "oklch(0.82 0.13 80)"
  warn-soft-dark: "oklch(0.82 0.13 80 / 0.13)"
  scrim-dark: "oklch(0 0 0 / 0.5)"
typography:
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.2
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 500
  caption:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    fontFeature: "tnum"
  micro:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 500
rounded:
  tape: "1px"
  r: "2px"
  sheet: "10px"
  pill: "999px"
spacing:
  "2": "2px"
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "20": "20px"
  "24": "24px"
  bar-h: "56px"
  tab-h: "56px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.r}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    padding: "0 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.r}"
    padding: "0 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.r}"
    height: "32px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.r}"
    size: "32px"
  icon-button-pressed:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-text}"
  input-number:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    padding: "0 8px"
    height: "32px"
  segmented:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink-2}"
    padding: "2px"
  segmented-thumb:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
  chip:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
  chip-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.panel}"
  status-pill:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "0 12px 0 10px"
    height: "28px"
  status-pill-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
  card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.r}"
  sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
  tape-strip:
    backgroundColor: "{colors.tape}"
    textColor: "{colors.tape-ink}"
    rounded: "{rounded.tape}"
---

## Overview

**Creative North Star: "The Supply Catalog Drawing"**

Every label is a catalog part, drawn at true proportion on its tape and dimensioned like a drawing in an industrial supply catalog. The canvas owns the field; chrome stays at the edges on a cool paper-white ground (graphite in dark) with white panels, hairline rules instead of borders, and one catalog-green accent that marks only the active thing.

Density is spec-row density: the inspector reads like a parts table, label on the left at a fixed 88px column, a live control on the right, every number in tabular figures with its unit in a muted tone. Depth is ply, not decoration: three tiers (ground, panel, sheet) and nothing else. Motion is short and settles with a soft out-curve; dimension values tween as a label's length changes.

Themes are plain CSS custom properties on `:root` in `src/app.css`, switched by `prefers-color-scheme`. DaisyUI is not used because the app may not add dependencies. Components are Svelte files with scoped styles that read those properties.

**Key Characteristics:**

- True-proportion tape strip with live dimension lines (length under, tape width beside) on every rendered label: editor, template cards, batch, history.
- One accent, reserved for selection, the primary action, and a ready printer.
- Three elevation tiers: ground, panel, sheet.
- Hairline rules drawn as 1px box-shadows; no stroked borders.
- One grotesque (Geist) at every size; tabular numerals for every measurement.

## Colors

A near-neutral, faintly green-cool palette (hue 165, chroma at or under 0.01) carrying a single catalog green (hue 155). All values are OKLCH, as written in `src/app.css`; each light token has a `-dark` sibling in the frontmatter.

### Primary

- **Catalog Green** (`accent`): the primary button fill, selection outline and handles, the ready dot in the status pill, a switched-on switch, the focus ring, the text caret. `accent-hover` deepens it on hover; `on-accent` is the text on it.
- **Green Wash** (`accent-soft`, `accent-text`): pressed icon toggles, the selected layer row, text selection, the halo around the ready dot.

### Neutral

- **Cool Paper / Graphite** (`ground`): the workspace behind everything; the canvas sits directly on it.
- **Panel White** (`panel`): top bar, side panels, inspector, cards, the bottom tab bar.
- **Sheet White** (`sheet`): dialogs and menus, the top tier; also the fill of selection handles and switch knobs.
- **Sunken** (`sunken`): wells: number inputs, segmented tracks, secondary buttons, chips, the status pill.
- **Hairline** (`rule`, `rule-strong`): dividers drawn as 1px shadows; `rule-strong` for scrollbars, the sheet grabber, an off switch.
- **Ink** (`ink`, `ink-2`, `ink-3`): primary text (never pure black or white), secondary text and row labels, tertiary text and units.
- **Hover / Press** (`hover`, `press`): translucent ink washes for ghost and icon controls.
- **Dimension Grey** (`dimension`): dimension lines and their tick ends; the value text uses `ink-2`, its unit `ink-3`.

### Status

- **Danger** (`danger`, `danger-soft`): destructive buttons and error banners, always text on its own soft wash.
- **Warn** (`warn`, `warn-soft`): physical printer problems (no tape, cover open) in the pill and banners.
- **Scrim** (`scrim`): the backdrop behind an open sheet.

### Tape

- **Tape** (`tape`, `tape-shade`, `tape-ink`): the label stock itself, a top-to-bottom gradient from `tape` to `tape-shade` with `tape-ink` marks. These have no dark override.

### Named Rules

**The Active Leg Rule.** The accent marks only the active thing: the current selection, the one primary action, a ready printer. A selected chip or current tab uses ink, not green.

**The Tape Is Physical Rule.** The tape stays paper-white with near-black ink in both themes, because it previews what the printer burns. Never theme the label.

## Typography

**Display Font:** Geist (with ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif)
**Body Font:** Geist
**Label/Mono Font:** Geist with tabular numerals (the `.num` utility sets `font-variant-numeric: tabular-nums`)

Geist is self-hosted from `src/lib/ui/fonts` (Latin 400, 500, 600 as woff2) under the SIL Open Font License, included as `OFL.txt` beside the files.

**Character:** One quiet grotesque everywhere. The root size is 14px and hierarchy comes from small size steps and weight, never from case or tracking.

### Hierarchy

- **Headline** (500, 22px, 1.2): the page title on Templates, Batch, and History.
- **Title** (600, 16px): sheet titles; the wordmark uses 600 at body size.
- **Body** (400, 14px, 1.45): default text, card titles at 500.
- **Label** (500, 13px): section tabs, pill text, group headings; spec-row labels at 400 in `ink-2`.
- **Caption** (400, 12px, tabular): dimension values, units, card metadata, small segmented options.
- **Micro** (500, 11px): bottom tab bar labels and small dimension lines.

On coarse pointers, inputs, textareas, and selects render at 16px so iOS does not zoom.

### Named Rules

**The Tabular Measure Rule.** Every measurement (mm, dots, percent, degrees) uses tabular numerals with its unit in a muted tone (`ink-3`) after the number.

**The No Shouting Rule.** No uppercase and no letter-spacing anywhere; the build uses neither.

## Layout

Desktop, below a sticky 56px top bar (wordmark, section tabs, printer pill, page actions): the editor is a three-column grid (280px left panel for Add, Layers, Templates; flexible centre canvas; 320px inspector). In its narrower state it is two columns (flexible canvas, 340px dock). The editor fills the viewport height minus the bar and any job banner; the document scrolls everywhere else.

Content pages pad 24px 24px 96px and collapse to 16px 16px 96px at 760px. Template cards use an auto-fill grid with a 260px minimum. History is capped at 960px; Batch drops to a single column at 960px.

At 760px and below, the section tabs and the wordmark text hide, a sticky 56px bottom tab bar (icon over label) takes over navigation, and the editor becomes the tape strip at full width above a segmented Add / Edit / Layers sheet. Sheets dock to the bottom edge at 640px.

Spacing steps are 2, 4, 6, 8, 12, 16, 20, 24px, with 8px the most common gap. On coarse pointers, controls grow (buttons 44px, number inputs 40px, segmented options 36px, status pill 36px) and small visuals carry an invisible enlarged hit area.

## Elevation & Depth

Ply is the only rank. The ground is flat; panels lift by a 1px shadow; sheets float on a soft two-layer shadow over a scrim. Divisions inside a tier are hairline shadows (`0 1px 0`, `0 -1px 0`, `1px 0 0`, `-1px 0 0` in `rule`), never borders.

### Shadow Vocabulary

- **Panel** (`--shadow-panel`): cards, the search field, the segmented thumb, the blank-label card.
- **Sheet** (`--shadow-sheet`): dialogs and menus; also the hover lift of a template card, which promotes it one tier.
- **Tape** (`--tape-shadow`): the tape strip and the wordmark glyph only, so the label reads as an object lying on the ground.

### Named Rules

**The Three Ply Rule.** Ground, panel, sheet. A fourth tier, or a shadow that is not one of these three tokens or a hairline, is off-system.

## Shapes

Corners are nearly square. Controls, cards, inputs, banners, and tabs use 2px (`--r`); a segmented track adds 2px to its inner thumb. Sheets alone use 10px (`--r-sheet`) and lose their bottom corners when docked on a phone. The tape strip and its handles use 1px. Full rounding is reserved for things that are round by nature: the status pill, chips, switches, and status dots.

## Components

### Buttons

Quiet, small, and firm.

- **Shape:** nearly square (2px).
- **Primary:** catalog green with `on-accent` text, 32px tall, 12px inline padding, weight 500. The top-bar Print button carries the label length after a hairline divider in a lighter weight.
- **Hover / Focus:** fill deepens to `accent-hover`; press scales to 0.97; focus is a 2px accent outline offset 2px.
- **Secondary:** `sunken` fill with ink text. **Ghost:** transparent with `ink-2`, `hover` wash on hover. **Danger:** `danger` text on `danger-soft`.
- **Sizes:** sm 28px / 13px, md 32px, lg 40px / 15px; md and lg become 44px on coarse pointers. Disabled is 0.45 opacity.

### Icon Buttons

32px square, transparent, Lucide line icons at 18px and stroke 1.75. Pressed toggles take the green wash.

### Chips

- **Style:** pill, `sunken` fill, `ink-2` text, 500 weight.
- **State:** selected inverts to an ink fill with panel text, not the accent.

### Status Pill

The printer's voice in the top bar: a 28px pill with an 8px dot and a short state ("12 mm ready"). Ready turns the dot green with a 3px soft halo; busy and pending pulse the dot; warn takes the warn wash. Tapping opens the printer sheet.

### Cards / Containers

- **Corner Style:** 2px.
- **Background:** `panel` on the ground; template cards hold a `ground` stage with the rendered tape and its dimension line above the meta block.
- **Shadow Strategy:** panel at rest, sheet on hover (see Elevation).
- **Border:** none.
- **Internal Padding:** stage 16px; meta 12px 12px 8px 16px.

### Inputs / Fields

- **Style:** `sunken` well, no stroke, 2px radius, 32px tall (40px coarse), unit suffix in 12px `ink-3`.
- **Focus:** 2px accent outline at offset 0.
- **Disabled:** 0.5 opacity.

### Segmented Control

A `sunken` track with 2px padding and a `panel` thumb carrying the panel shadow that slides between options. The checked option goes to ink. Used for Design / Print view, inspector choices, and the phone editor sheet.

### Navigation

Desktop section tabs are 500-weight `ink-2` text with a `hover` wash; the current tab goes to ink with a 2px ink underline seated on the bar's bottom rule, growing in on change. The phone tab bar uses 22px icons over 11px labels; the current item goes to ink and its icon lifts 1px.

### Tape Strip with Dimension Lines (signature)

The rendered label sits on the ground at true proportion, filled with the tape gradient and the tape shadow. A horizontal dimension line runs under it with the length; a vertical one beside it with the tape width. Lines are 1px in `dimension` with 11px tick ends; the value sits in a ground-coloured gap, tweening over 260ms when the length changes. Selection is a 1.5px accent outline with 9px sheet-filled handles ringed in accent; a locked element shows a dashed `ink-3` outline instead.

### Sheets

Dialogs on `sheet` with the sheet shadow over the scrim, rising 8px into place. At 640px and below they dock to the bottom edge, slide up, show a 36px grabber in `rule-strong`, and stretch footer buttons to full width.

### Motion

`--ease` (`cubic-bezier(0.16, 1, 0.3, 1)`) for things that move into place, `--ease-standard` (`cubic-bezier(0.2, 0, 0, 1)`) for colour and state changes, at 120ms, 180ms, and 260ms. Reduced-motion collapses all animation and transition durations to 1ms.

## Do's and Don'ts

### Do:

- **Do** read every colour, radius, shadow, and duration from the custom properties in `src/app.css`, and give any new token a dark value in the `prefers-color-scheme: dark` block.
- **Do** put a dimension line on every rendered label, wherever it appears.
- **Do** lay out settings as spec rows: an 88px label column and a live control with a numeric readout.
- **Do** draw divisions as 1px hairline shadows in `rule`.
- **Do** keep the tape paper-white with `tape-ink` in both themes.

### Don't:

- **Don't** use the accent for anything that is not the active selection, the primary action, or a ready printer.
- **Don't** add stroked borders, a fourth elevation tier, or shadows outside the three shadow tokens and hairlines.
- **Don't** use pure black or pure white for interface text.
- **Don't** add a second typeface, uppercase labels, or letter-spacing.
- **Don't** round controls past 2px; full rounding is only for pills, chips, switches, and dots.
- **Don't** add a component library or theme plugin; themes stay plain custom properties.
