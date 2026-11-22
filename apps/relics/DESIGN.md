---
name: Petal Relics
description: A specimen card and museum label for physical collectibles.
colors:
  dark-background: "#171b19"
  dark-surface: "#202622"
  dark-raised: "#303831"
  dark-text: "#f2f0e7"
  dark-muted: "#cdd4c9"
  dark-accent: "#c2d49b"
  dark-accent-text: "#1b2414"
  dark-rule: "#465047"
  dark-photo: "#d9dbd4"
  dark-error: "#ffb7a7"
  dark-error-text: "#32120b"
  light-background: "#f2f0e7"
  light-surface: "#e8e6dc"
  light-raised: "#d6d8ca"
  light-text: "#202820"
  light-muted: "#434d40"
  light-accent: "#3c552a"
  light-accent-text: "#ffffff"
  light-rule: "#b5baad"
  light-photo: "#dedfd8"
  light-error: "#9d2e1b"
typography:
  display:
    fontFamily: "Schibsted Grotesk, sans-serif"
    fontSize: "clamp(2.5rem, 6vw, 4.5rem)"
    fontWeight: 400
    lineHeight: 1.06
  headline:
    fontFamily: "Schibsted Grotesk, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.2
  body:
    fontFamily: "Schibsted Grotesk, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.55
  small:
    fontFamily: "Schibsted Grotesk, sans-serif"
    fontSize: "0.875rem"
  mono:
    fontFamily: "IBM Plex Mono, monospace"
    fontWeight: 400
rounded:
  label: "2px"
spacing:
  xs: "8px"
  sm: "16px"
  md: "24px"
  lg: "32px"
  xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-accent-text}"
    rounded: "{rounded.label}"
    padding: "12px 24px"
    height: "48px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.label}"
    padding: "12px 24px"
    height: "48px"
  field:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.label}"
    padding: "12px 16px"
    height: "48px"
  specimen-card:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.label}"
---

# Design System: Petal Relics

## Overview

**Creative North Star: "The Specimen Card"**

Parker's selected world is a dark specimen card and museum label, with artwork first and a light theme toggle. Existing photography and real specimen data lead; catalog numbers and hairline rules give the interface its quiet structure. This is a code-led implementation, with no approved raster comp.

The specimen route is Experience; the private collection and admin tools are Operate. ENERGY 2 / RHYTHM 2 / MOTION 1. The collection uses photographs for owned relics and a custom mushroom silhouette for missing varieties, never substitute artwork.

**Key Characteristics:**

- Real object photography and an oversized catalog number.
- Flat charcoal and warm paper, with a restrained herb-green accent.
- Schibsted Grotesk, small corners, hairline divisions and short state transitions.

### Review evidence

The reproducible concept seed is `fb9a05f1`, assigned index 6. `.impeccable-seed-proof.txt` contains the corroborating seeded roll. Parker's explicit museum/specimen direction governs the result, as the seed's own user-pinned override permits. No challenger direction or raster comp was adopted.

QUALITY BAR for this pinned, code-led world: one real specimen photograph leads; the adjacent catalog label carries a large number, type, variety and ownership action. On phones the photo stacks above the label and repeated catalog rows recede. The collection uses equally sized specimen cards, original photography for owned varieties and explicit mushroom silhouettes for missing varieties. Text never crowds its neighboring field. Warm paper and charcoal green remain flat, with one herb-green accent, Schibsted Grotesk typography, 2px corners and hairline divisions. Claim opens a short inline form, then the collection is the visible reward. Both themes retain the same hierarchy, and all text clears AA contrast plus the lab's APCA targets.

## Colors

The frontmatter records the dark and light theme values from `src/theme.css`; component primitives there show the dark default and switch to the corresponding light roles in light mode.

### Primary

Herb green marks primary actions, specimen numbers and ownership. Its paired text color preserves legibility.

### Neutral

Charcoal green and warm paper exchange background and text roles between themes. Surface and raised tones group controls and cards; muted text, rules and photo grounds have separate theme values. Paper captions stay light over photographs in either theme. Error colors identify failed actions.

**The Artwork First Rule.** Let the photograph carry the visual weight; use the accent to guide action and catalog identification.

## Typography

Schibsted Grotesk is self-hosted through fontless at weights 400, 500 and 600, with sans-serif fallback, for text and display. Regular-weight headings and body copy keep the label direct. IBM Plex Mono 400, with monospace fallback, identifies catalog numbers, relic IDs and tabular figures; its fixed-width numerals reinforce the specimen-label hierarchy. Both families follow the lab typography standard. The root layout renders fontless-generated global font faces and preloads into the SvelteKit head, so the configured families load in SSR as well as client navigation. Fontless supplies metric-adjusted fallbacks and swap behavior. No letter-spacing overrides are used.

The body is 16px with a 1.55 line height; the standard heading scale is in frontmatter. The specimen number is 6rem on wide screens, 5rem at 1000px and 3rem at 700px. Small supporting text is 0.875rem; photo captions can be 0.75rem.

## Layout

Main content is capped at 1280px, with 48px horizontal padding, reduced to 24px at 800px and 20px at 540px. Spacing commonly follows 8px increments. The specimen uses a two-column image and label layout, stacking image above label at 700px; repeated type and variety rows recede on the smaller layout. The phone identity label reserves 128px for the monospace catalog number. Collection cards use three columns, then two at 800px and below. Admin tables scroll horizontally when needed.

## Elevation & Depth

Surfaces are flat and separated by tonal changes or hairline rules. The release dialog alone uses a shadow (`0 16px 64px #0006`) and a dark backdrop (`#0008`) to separate the confirmation from the page.

## Shapes

Controls and cards use small 2px corners. Square image areas frame collection artwork; one-pixel rules organize catalog rows. The mushroom is a custom external silhouette, while Lucide supplies functional interface icons.

## Components

### Buttons

Primary buttons use the accent and its paired text, with a 48px minimum height and 12px by 24px padding. Ghost buttons are transparent and gain a surface fill on hover; neutral buttons use the raised tone. Hover lifts buttons by 1px; active returns them to rest. Visible keyboard focus is a 2px accent outline with a 4px offset.

### Inputs and fields

Fields use the surface tone, 2px corners, 12px by 16px padding and a 48px minimum height. Labels and placeholders use muted text. Form panels invert the field to the base background.

### Specimen cards and labels

Cards pair square, cropped photography with a padded caption, type, tabular catalog number and variety. A missing variety uses a mushroom silhouette on the surface tone, with an explicit uncollected label. A missing image has a textual placeholder. On hover, cards change surface tone and images scale to 1.025.

The specimen view pairs the image with a large number, identity, ownership state and action. Claim expands a short inline name form when needed; release opens a confirmation dialog.

### Navigation and motion

The header pairs the mushroom mark with collection navigation and a light/dark toggle. At 600px the collection icon is hidden and the header tightens. Buttons and card backgrounds transition over 160ms ease-out; card images use 240ms. Reduced-motion preferences disable transitions and animation.

## Do's and Don'ts

### Do:

- **Do** keep real photography and specimen data foremost.
- **Do** preserve the same hierarchy in both themes and visible keyboard focus.
- **Do** use silhouettes with an explicit missing or uncollected state.

### Don't:

- **Don't** replace specimen artwork with invented imagery.
- **Don't** add public owner lists, social rankings, invented lore or unsupported count claims.
- **Don't** add heavy decorative effects to the flat museum-label world.

## Staff workshop

The admin surface is Operate for a nontechnical maker preparing physical NFC tags. ENERGY 1 / RHYTHM 2 / MOTION 1. The existing Schibsted Grotesk and IBM Plex Mono roles and both palettes remain: plain text for guidance, mono for physical tag numbers and URLs. A single primary action starts a new type; the ordered steps explain the required sequence. Existing editing, ownership, individual artwork, stories and sets remain in named tools.

The setup form has one task at a time, with optional descriptions and custom catalog numbers disclosed on demand. A quieter side panel explains the next steps; it stacks below the task on phones. Quantity replaces start/end arithmetic, while custom numbering preserves the original range capability. The writing surface pairs the current physical tag with a persistent checklist, stacking the checklist below the tag on phones. The green accent marks actions and the selected/written state. Flat tonal surfaces, 8px spacing increments and 2px control corners preserve the specimen world; no decorative assets were added. The QR image is generated locally from the exact tag URL and is tucked into its own disclosure so writing stays the focal task. Photo previews show the uploaded input before saving. Short existing state transitions and reduced-motion behavior remain.

### Browser tag writing

The writing step remains Operate, ENERGY 1 / RHYTHM 2 / MOTION 1. On supported phones the full-width Write tag button leads. Plain text explains permission, placement, writing, readback and saved progress; the completed tag number remains visible as the next tag is selected. Existing URL, copy, manual checklist and QR controls remain secondary. Both themes use the existing tonal surfaces, accent and font roles, without new decorative assets. Occupied tags require a separate replacement choice and a second presentation of the same identified tag. NFC sessions stop on cancellation, timeout or navigation. Permanent locking is omitted because it would add an irreversible operation to Jeff's first-use flow.
