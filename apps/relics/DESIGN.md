---
name: Petal Relics
description: A little woodland tale for a party favor and its naming phone.
colors:
  paper: "#fbf5e7"
  ink: "#423e2f"
  muted: "#64614b"
  primary: "#526444"
  primary-text: "#fffaf0"
  sage: "#e7ead9"
  raised: "#d8dec5"
  rule: "#bcbda5"
  error: "#8e263f"
typography:
  display:
    fontFamily: "Lora, Georgia, serif"
    fontSize: "2.18rem"
    fontWeight: 500
    lineHeight: 1.14
  body:
    fontFamily: "Nunito, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
  note:
    fontFamily: "Patrick Hand, cursive"
    fontSize: "20px"
    fontWeight: 400
rounded:
  button: "8px"
  field: "6px"
spacing:
  xs: "8px"
  sm: "16px"
  md: "24px"
  lg: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.button}"
    padding: "12px 20px"
    height: "48px"
  field:
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "10px 14px"
    height: "50px"
---

# Petal Relics: a little woodland tale

Parker chose B · Storybook on November 22, 2026. The approved reference is `relics-redo/comps/B-card.png`, with four 390 × 844 screens and their HTML sources. This replaces the museum/specimen world. The product is a party favor with a page you can name, without an account or a collection game.

Guest pages are Experience; naming and staff tools are Operate. ENERGY 2 / RHYTHM 2 / MOTION 1. One friend or one task leads each screen. The naming form replaces the large photograph with a thumbnail so the fields and save action fit above a keyboard. Staff setup proceeds through type, colors/photos, quantity, then writing. Optional editing tools remain in one compact selector.

## Tokens and reasons

| Role            | Value                                              | Reason                                                      |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| Paper           | `#fbf5e7`                                          | Matches the comp's warm book paper.                         |
| Ink             | `#423e2f`                                          | Warm, readable text instead of stark black.                 |
| Secondary ink   | `#64614b`                                          | Quieter supporting text with AA contrast on paper and sage. |
| Olive action    | `#526444` on `#fffaf0`                             | A woodland accent leads the next real action.               |
| Sage surface    | `#e7ead9`                                          | Groups the current physical tag and saved state.            |
| Raised sage     | `#d8dec5`                                          | Distinguishes secondary controls.                           |
| Rule            | `#bcbda5`                                          | Separates birthday and trait like lines in a small book.    |
| Error           | `#8e263f`                                          | Distinguishes failed requests with readable text.           |
| Display         | Lora 500                                           | The exact Storybook heading voice selected in B.            |
| Body            | Nunito 400/700                                     | Friendly, open forms and instructions at phone sizes.       |
| Notes           | Patrick Hand 400                                   | Personal marginal notes, greetings and celebration.         |
| Control corners | 8px buttons, 6px fields                            | Matches B's quiet rectangular controls.                     |
| Side inset      | 24px                                               | Keeps text and touch targets away from phone edges.         |
| Touch targets   | At least 44px; fields 50px; main guest action 58px | Supports thumbs and avoids input zoom.                      |

Fonts are self-hosted through fontless. The page remains light paper even if the browser or an older local preference requests dark mode. The selected paper world is the reason for a fixed light theme.

## Imagery and layout

Existing uploaded photographs remain authoritative. `RelicPhoto` falls back to the comp's explicitly illustrated snail with “Photo coming soon” for missing or broken photos. This is a generic little-friend placeholder, never presented as a photograph of the actual relic. The same component is used for guest art, staff thumbnails and upload previews.

The snail and phone/tag diagram are reused external SVG assets from the approved comp, not generated substitutes. The phone diagram explains where to hold the tag. A curved olive flourish and the handwritten “hello, you.” note repeat the comp's personal story motif. These are scoped exceptions to the lab's general material/serif/illustration defaults, authorized by the selected reference.

The guest page is a narrow book page on large screens, with the same reading order as the phone comp. Photographs remain large and simple, with 8px corners. No missing-variety silhouettes, completion counts, browse controls or collection navigation remain in the guest UI. Home explains tapping the physical tag. Workshop and source links live only at the bottom of home.

## States and motion

Naming adds the friend’s name, the naming person's first name, a birthday and a stable silly trait derived from the tag ID. Only the owning phone receives Rename and the quiet Pass it on link. Renaming preserves the birthday. Visitors see the same story without ownership warnings or locks. Names and first names are public; the form says this before saving.

A short, single upward settling motion marks successful naming. Reduced-motion preferences disable it. Forms have inline busy/error feedback; upload previews, staff empty states and the writer's status region remain real. The browser writer keeps its foreground NFC scanner, explicit Write tap, replacement confirmation and fresh exact readback. Its active state hides the optional navigation and checklist so the physical tag, placement diagram and Cancel lead.

## Verification scope

The writing workshop keeps color and batch selectors in a labeled disclosure because the current tag already identifies both. This leaves room for the write action on small phones. Active NFC instructions use a smaller placement diagram and omit it when replacement consent needs attention. Completed batches lead with Make more tags; rewriting a completed tag is labeled explicitly. A failed checklist save keeps the verified tag and a direct retry together. These refinements preserve Storybook B, its type and palette, and ENERGY 2 / RHYTHM 2 / MOTION 1.

Phone captures cover 360, 390 and 412 CSS pixels using Chromium touch emulation at DPR 2. Reduced 500px viewports check form access with keyboard space reserved. These do not establish physical OS keyboard, Safari or Android NFC hardware behavior. Review and deployment evidence is recorded in the external `relics-redo/STORYBOOK.md` handoff.
