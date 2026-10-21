# Give every interactive element on the dashboard a visible focus indicator

**Status: Done** — implemented in `ffc731e` on `feat/pwa-responsive` (PR #12).

Written against: `e1be0b0` (`fix(dashboard): keep the workspace directory at every width`), plus the uncommitted working-tree changes in `.worktrees/pwa-responsive`.

## Evidence chain

- Surface: `<path: dashboard.mjs>` → `renderDashboardHtml()`, the page at route `/`. Affected controls: the search input, the four filter tabs, the modal close button, the update-banner dismiss, and — after the companion plan lands — the workspace path chip and the prompt cell.
- Problem: the page suppresses the user agent's focus ring on its one text input and replaces it with a 1px border recolour, and it declares no focus style at all for its buttons. A keyboard user cannot reliably see where focus is.
- Design evidence, measured: the whole page contains exactly one focus rule, `.search-box:focus { border-color: var(--accent) }` at `dashboard.mjs:294`, paired with `outline: none` on `.search-box` at `dashboard.mjs:284-295`. The indicator is therefore a 1px border. Its colours: idle border `--card-border #30363d` against `--card-bg #161b22` is **1.42:1**; focused border `--accent #58a6ff` against `--card-bg` is **6.85:1**. So the state change is detectable in colour, but it is carried by a 1px line — the thinnest possible indicator — and `.filter-tab` (`dashboard.mjs:299`) and `.modal-close` (`dashboard.mjs:405`) have no focus rule whatsoever, which means they fall back to the user agent default that the page never acknowledges and which `outline: none` on a sibling establishes no expectation for either way.
- Owner: the inline stylesheet in `dashboard.mjs`. There is no shared focus token or utility: `:focus-visible` occurs 0 times in the file.
- Scope and affected surfaces: all interactive elements on `/`. One route, one stylesheet, so a single rule covers the surface.
- Uncertainty: none that affects the correction. The exact colour is taken from the existing `--accent` token rather than invented; only the outline width and offset are new values, and they follow the WCAG 2.4.11 minimum rather than a product decision.

## Design decision

Keep `outline: none` off the elements and add one `:focus-visible` rule that applies to every interactive element on the surface, using the existing `--accent` token for the ring:

```css
.search-box:focus-visible,
.filter-tab:focus-visible,
.modal-close:focus-visible,
.path-chip:focus-visible,
.action-text:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

`:focus-visible` rather than `:focus` is the decision that matters: it shows the ring for keyboard navigation but not for a mouse click, which is why the current rule reached for `outline: none` in the first place. The existing `.search-box:focus { border-color: var(--accent) }` at `dashboard.mjs:294` can stay — a border recolour alongside a ring is not a contradiction — but the `outline: none` at `:284-293` must go, since it is what suppresses the ring the rule restores.

`outline-offset: 2px` keeps the ring clear of the element's own border so the two are distinguishable; `2px` is the smallest width that satisfies WCAG 2.4.11's 3:1 contrast requirement as a non-text indicator against both the element and the page background, and `--accent` at 6.85:1 against `--card-bg` clears that with margin.

## Reuse

- `--accent` (`#58a6ff`) from the `:root` token block at `dashboard.mjs:132-149`. It is already the surface's focus colour, used by the one existing focus rule.
- `.search-box:focus` at `dashboard.mjs:294` as the exemplar of the surface's intent to indicate focus, and as the rule this change generalises.
- Exemplar: `dashboard.mjs:294`.

No new primitive is required, and no new token: the colour, the selector style, and the intent all already exist on this surface.

## Changes

1. `dashboard.mjs:284-295` — the `.search-box` rule
   - Change: remove `outline: none;`.
   - Preserve: every other declaration on the rule, including the border, background, padding, radius and width, and the responsive override at `dashboard.mjs:461`.
   - Verify: the search box still looks identical at rest; focusing it with the keyboard now shows both the existing accent border and the new ring.

2. `dashboard.mjs`, immediately after the `.search-box:focus` rule at `:294` — add the focus block
   - Change: insert the `:focus-visible` rule above, listing the five selectors. Include `.path-chip` and `.action-text` so the companion plan's buttons are covered without a second edit.
   - Preserve: the existing `.search-box:focus` rule, which stays as written.
   - Verify: tabbing through the page shows a 2px accent ring on the search box, each filter tab, the modal close button and the banner dismiss; clicking with a mouse shows no ring on those controls.

3. `dashboard.mjs:405` — the modal
   - Change: none to `.modal-close` itself; confirm the `:focus-visible` rule reaches it and that the modal does not trap focus in a way that makes the ring unreachable. If the modal has no focus management, that is a separate behavior change and out of scope here.
   - Preserve: the close button's existing appearance and its `onclick`.
   - Verify: with the modal open, the close button shows the ring when reached by keyboard.

## Scope

- Inherit: every interactive element on `/`, at every viewport. The rule is not media-scoped, so the narrow layout receives it automatically.
- Verify: the ring must not be clipped by an ancestor's `overflow: hidden`. The narrow-screen table cells set `overflow: hidden` on `tbody td:nth-child(4) > div` and on `tbody td:nth-child(6) .action-text` (`dashboard.mjs:520-530` region); `outline-offset: 2px` may be clipped there. Check at 375px specifically.
- Exclude: the non-interactive `.action-plain` variant, which is not focusable. A focus trap, a skip link, and any change to the modal's behavior are out of scope.

## Validation

- Product: navigate the whole page with Tab alone and confirm the focused element is always visually identifiable, including inside the modal.
- Interface: routes — `/` only. States — no rows, one row, many rows; modal open; empty search result. Content extremes — long paths and clamped prompts, where the ring must not be clipped. Viewports — 320, 375, 768, 1280 px. Interactions — keyboard Tab/Shift+Tab and mouse click must differ only in whether the ring shows.
- System: confirm no second focus colour was introduced (`--accent` only) and that `outline: none` no longer appears anywhere in the stylesheet except, if retained, on elements that carry an equivalent ring.
- Repository: `node test_cases.test.js` and `bun test_cases.test.js` → both `0 failed`. Add assertions that the stylesheet contains a `:focus-visible` rule whose selector list includes `.filter-tab`, `.modal-close`, `.path-chip` and `.action-text`, and that `.search-box` no longer declares `outline: none`. Run `fallow audit --format json --quiet --gate-marker agent` → verdict `pass`.

## Stop conditions

- Stop if a stylesheet-wide search finds `outline: none` on an element this plan does not cover; that element would then have no indicator at all and the change would be incomplete rather than wrong.
- Stop if `outline-offset: 2px` proves clipped at 375px by an ancestor `overflow: hidden`; the correction then belongs on the clipping context, not on the ring, and needs its own decision.
- Stop if the modal is found to lack any focus management; moving focus into the modal is functional behavior, not presentation, and must not be smuggled into this plan.

## Design documentation

- After acceptance and validation: record in `AGENTS.md` that the dashboard uses `:focus-visible` with `outline: 2px solid var(--accent); outline-offset: 2px` as its single focus convention, and that `outline: none` must not be reintroduced without an equivalent indicator. There is no `DESIGN.md` in this repository, and this plan does not create one.
