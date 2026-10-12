# Regional QA of edited PDF pages

`app/local/pdf_quality.py` independently re-reads every exported PDF with MuPDF. Unedited pages are compared
whole. Edited pages are additionally checked **regionally** by the sibling `app/local/pdf_regions.py`. This is
implementation-level evidence about this one output, not a typographic, scientific or human review.

## Where the regions come from

- QA locates each selected Before in the immutable **source** page itself (whitespace removed, nothing else
  normalized, so signs, digits and operators keep their meaning). A missing or repeated anchor is never guessed;
  that page's regional checks become warnings.
- The excluded area is the tight per-line box of the selected **source** characters plus a fixed 1 pt bleed. Whole
  lines, whole pages and anything the output defines are never excluded.
- A supplied private edit plan (`edit_plan=`, schema `falsify.pdf-edit-plan.v1`) is only cross-checked against the
  located plan (code `edit_plan`): same source hash, Before/After hashes, page and regions/styles within 1.5 pt.
  Caller ids are labels only (QA numbers its own edits `edit-N`). A plan that is more conservative
  (ambiguous/unavailable, no regions) is consistent; a malformed, forged or widened plan is a `warning` and is
  ignored. It can never widen or move the exclusion.

## Codes (report schema `falsify.pdf-quality.v1`)

| code | failed (definite) | warning (uncertain) |
|---|---|---|
| `edited_page_render` | a sample outside the sealed regions moved more than 40 levels (new graphic, white cover, damaged figure or paragraph) | kept text of the edited line slid outside the sealed regions (longer/shorter After, re-justified spacing); reflow; continuation; oversized regions |
| `edited_page_text` | unedited text on the edited page lost, restyled or moved; kept same-line text restyled | extra output lines; reflowed or continued text |
| `edited_region_style` | an After glyph has a different font, size (±max(0.25 pt, 3%)) or RGB color (±8) from the selected source | After position unknown after reflow |
| `edited_region_visible` | an After letter leaves no ink, kept same-line letters lose ink they had, or overlapping invisible text | After position unknown |
| `edit_plan` | — | supplied plan inconsistent with the located plan |

Only definite corruption is `failed`. Rotated/cropped pages, continuation groups, repeated anchors, page/character
budgets and an assumed page mapping make the regional codes warnings (limitation `regional_partial` or `budget`), so
they never become a new blanket download block. If the sibling module cannot load, the regional codes are
`unavailable`, never `passed`.

## Isolation

`inspect_isolated` runs the same code in `python -I` with a minimal environment. `pdf_regions.py` is loaded by
absolute path next to `pdf_quality.py`, not through `sys.path` or the working directory, so the isolated child runs
the regional checks. Reports carry fixed codes, statuses and output page numbers only: no document text, plan
coordinates or paths.

## Known limits

- Differences inside the zones where After or shifted kept text lands are at most warnings; a graphic drawn exactly
  there is not proven by the raster (white covers over text are still caught by the ink check).
- Reflowed (non same-placement) edited pages are compared by text and After style/visibility only; their raster is a
  warning, not a proof.
- Rotated or cropped pages and vertical text are not regionally compared.
- Proportional-font edits whose After width differs from the Before almost always shift kept text and therefore
  report `warning` rather than `passed`.
