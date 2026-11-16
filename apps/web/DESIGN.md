# TshepoVet design system

**The specimen and the seal.** TshepoVet's world is official paper: CIPC certificates, SARS PIN
letters, B-BBEE affidavits stamped by a commissioner of oaths, the supplier's passport. Security
printing gives the vocabulary, used sparingly:

- **The seal** (a generated guilloche rosette, `components/brand/seal.tsx`) is the only ornament:
  the brand, a verified passport, and the sandbox band. Nothing else is decorated.
- **Stamps** carry verdicts and statuses: a double rule in stamp ink, an icon, and the word.
- **Specimen**: the sandbox is marked the way reference banknotes are, in plain words, on every page.
- Everything else is quiet: cool security paper, petrol ink, records with their "as of" dates.

## Tokens (`app/globals.css`)

| Role | Light | Dark | Text pair (measured) |
|---|---|---|---|
| Paper (page) | `#F3F6F4` | `#0C161B` | ink 14.7 / 16.0 |
| Sheet (records) | `#FFFFFF` | `#13212A` | ink 16.0 / 14.3 |
| Ink | `#10242C` | `#EAF1EF` | secondary ink 7.9 / 10.3 |
| Stamp violet (actions, links, focus) | `#4B2A8C` | `#C9B8F7` | on violet 10.5 / 10.0 |
| Verified green | `#084F2E` | `#86DCAB` | on tint 8.4 / 8.7 |
| Caution amber | `#6B3F00` | `#F2CB7E` | on tint 7.6 / 9.4 |
| Refusal red | `#8E1B26` | `#F8A9B1` | on tint 7.2 / 8.4 |
| Petrol (pending, info) | `#18506A` | `#93CDE6` | on tint 7.4 / 8.0 |

Every text pair is 7:1 or better (WCAG 1.4.6, AAA); control edges 3:1. Violet, green and red are
never decoration: violet is "you can do this", the stamp colours are verdicts.

**Type:** Atkinson Hyperlegible Next (the Braille Institute's legibility face: I, l, 1 and O, 0
never look alike) for everything; its Mono cut only for identifiers people copy or compare
(registration numbers, PINs, keys). Body 16px, line height 1.6, measure under 72 characters, a
1.25 scale. Radii by hierarchy: stamp 3px, control 6px, record sheet 10px.

## The AAA floor (checked by `tests/a11y.spec.ts`)

- axe with the AAA rules in both themes, at desktop and phone sizes, with errors and overlays open;
- every target at least 44 by 44 pixels (2.5.5), label rows included;
- a 3px focus ring with offset (2.4.13), a skip link first;
- no sideways scrolling at 320 pixels (1.4.10): wide tables scroll inside a labelled, focusable region;
- no time limits (toasts with errors stay until dismissed), reduced motion respected;
- abbreviations expanded (`<Term>`, `/glossary`), plain words, errors that say how to fix them.

Lessons: menus are non-modal and not portalled (a modal menu hides the page with aria-hidden while
it stays focusable; a portal leaves the landmarks). Scroll regions are `position: relative`, or
visually hidden text inside them escapes and widens the page.
