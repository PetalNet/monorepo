# Product

<!-- impeccable:product-schema 1 -->

Written from the owner's brief without an interview round. Items marked (inferred) are
assumptions to confirm.

## Platform

web

## Users

One household-and-homelab owner (and anyone running the app on their own network) who
labels things with a Brother PT-P710BT tape printer: cables, rack gear, storage bins,
pantry jars, folders, school supplies, chargers, plants. They reach for it in the
moment, often on a phone standing next to the thing being labelled, sometimes at a
desk printing a batch. Agents on the same network print through its JSON API.

## Product Purpose

Design a label, see exactly what the printer will burn, and print it in seconds. Start
from a template with one tap, edit the words, print. Print many at once from pasted
lines, a CSV, or a lab inventory. Success: a correct label on the first print, because
tape costs money.

## Positioning

The preview is the print. The same renderer draws the on-screen preview and the
printer raster, at the printer's 180 dpi and 1-bit depth, for the tape that is loaded
right now. Brother's own apps and generic label tools approximate; this one does not.

## Operating Context

- The printer is attached over USB to a server; a small Python daemon speaks Brother's
  raster protocol and exposes HTTP. This app renders and queues; the daemon prints.
- Tape is 3.5 to 24 mm TZe cassettes; the loaded width is read from the printer. The
  printable band is narrow (70 dots on 12 mm tape), so labels are short, wide strips.
- Common errors are physical: no tape, cover open, wrong tape width.
- Optional read-only inventory sources (a hypervisor, a NAS, a home-automation hub)
  feed batch labels; each is configured by environment and may be absent.

## Capabilities and Constraints

- Elements: text, icons, shapes, images (threshold or dither), QR, Code128, DataMatrix,
  EAN-13. Templates with `{{variables}}`. Batch printing with cuts between labels.
  Print history with reprint. A print queue that serializes jobs.
- The PT-P710BT only does full cuts; there is no half cut.
- Public, open-source code: no secrets, hostnames, or personal data in source. All
  endpoints and credentials come from environment configuration.

## Brand Commitments

The owner's bar, verbatim: "great UI/UX and incredibly intuitive. think apple or google
phone UI. Linear? vercel? Make it premium and modern." Mobile first, fast, tasteful
motion.

## Evidence on Hand

No screenshots, users, or testimonials exist. Do not invent any.

## Product Principles

1. What you see is what prints. Never show a preview the printer would not reproduce.
2. One tap to a useful label. Templates first; the blank canvas is the advanced path.
3. Tape is money. Make the cost visible (length in mm) and confirm before long or many prints.
4. Errors speak printer. "Cover open" beats "HTTP 400".
5. Fast in the hand. A phone in one hand next to a shelf is the primary scene (inferred).
