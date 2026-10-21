# Keep the Host column visible on narrow screens

**Status: Done** — implemented in `172449a` on `feat/pwa-responsive` (PR #12).

Written against: `e1be0b0` (`fix(dashboard): keep the workspace directory at every width`), plus the uncommitted working-tree changes in `.worktrees/pwa-responsive`.

## Evidence chain

- Surface: `<path: dashboard.mjs>` → `renderDashboardHtml()`, the page at route `/`. The Host cell is the second column of the agent table, `<th>Host</th>` at `dashboard.mjs:610`, rendered per row as `<span class="tag-source tag-orca">Orca</span>` or `<span class="tag-source tag-herdr">Herdr</span>`.
- Problem: below 900px the Host cell is removed from the layout entirely, so a narrow screen shows no indication of which runtime a row came from.
- Design evidence: `@media (max-width: 900px)` sets `tbody td:nth-child(2) { display: none }` at `dashboard.mjs:535`, with this justification in the preceding comment (`:532-534`): "The source tag says which runtime found the row, which the agent name already implies for a reader who knows these tools". That premise is **false**, and the codebase's own data refutes it: `shared/catalog.mjs:74` maps `canonicalAgentName` over the Herdr `agent` field and `:98` over the Orca `agentType` field (the function itself is at `:60`), so after the `dsh` → `dsh-tui` rename both runtimes emit the same agent name. A rendered row from Herdr reading `dsh-tui` was observed directly. The agent name therefore cannot imply the source, which is exactly what the rename established.
- Owner: the narrow-screen block of the inline stylesheet in `dashboard.mjs` (`:439-537`); `.tag-source` (`dashboard.mjs:242`) styles the tag itself and is unaffected.
- Scope and affected surfaces: the Host cell on every row, below 900px only. At 901px and above the column is already visible and must stay unchanged.
- Uncertainty: none. The correction is a restoration of what the table already shows at wider widths, not a new presentational decision.

## Design decision

Stop hiding the Host cell below 900px, and place it on the card's first line beside the status badge — the two pieces of metadata that qualify the row, before the agent name. Delete the false justification comment.

The tag is a fixed-width, 11px uppercase-free chip with 2px 7px padding (`dashboard.mjs:242-248`), roughly 45px wide, so it costs about 8px of card height rather than a whole line if placed inline with the status badge, which the flex card already lays out as `order: 1`. The current rule hides it; the correction is to give it `order: 2` beside the badge and let the existing `gap: 2px 8px` space it.

The agent name moves from `order: 2` to `order: 3`, and the timestamp stays at `order: 3`'s current slot by moving to `order: 4`. The remainder of the ordering is unchanged.

## Reuse

- `.tag-source`, `.tag-orca`, `.tag-herdr` (`dashboard.mjs:242-250`) — the existing tag styling, unchanged.
- The row's existing `display: flex; flex-wrap: wrap; gap: 2px 8px` (`dashboard.mjs:460-470` region) — inline placement needs no new layout primitive.
- Exemplar: the status badge at `order: 1` in the same media block, which already demonstrates an inline leading chip.

No new primitive or token is required.

## Changes

1. `dashboard.mjs:535` — remove `tbody td:nth-child(2) { display: none; }`
   - Change: delete the rule and the three-line comment above it (`:532-534`).
   - Preserve: every other rule in the `max-width: 900px` block, including `tbody td:empty { display: none }` at `:537`, which still removes a genuinely empty Host cell if a future adapter reports no source.
   - Verify: at 375px a Herdr row shows the Herdr tag and an Orca row shows the Orca tag.

2. `dashboard.mjs:485-487` — reorder the first line
   - Change: add `tbody td:nth-child(2) { order: 2; flex: 0 0 auto; }`, change the agent cell from `order: 2` to `order: 3`, and change the timestamp cell from `order: 3` to `order: 4`.
   - Preserve: the timestamp stays right-aligned through its existing `margin-left: auto`; the agent name stays `font-size: 14px`.
   - Verify: the first line reads `[status] [Host] agent … timestamp`, and the timestamp remains flush right.

## Scope

- Inherit: every row below 900px. Rows above 900px are untouched because the rule lives inside the media query.
- Verify: `.tag-source` must not wrap to its own line when the agent name is long; check a row whose agent is `dsh-tui` at 320px.
- Exclude: the table's Host column at 901px and above, and the modal, which already shows all row detail.

## Validation

- Product: on a phone-sized viewport, identify from the card alone whether a row came from Orca or Herdr, without opening the detail panel.
- Interface: routes — `/` only. States — a Herdr row, an Orca row, and a row with no source. Content extremes — the longest agent name (`dsh-tui`) and a long workspace path. Viewports — 320, 375, 768, 899, 901, 1280 px.
- System: confirm no second tag style was introduced and that `.tag-source` remains the single owner of the tag appearance.
- Repository: `node test_cases.test.js` and `bun test_cases.test.js` → both `0 failed`. Add assertions that the narrow-screen block no longer contains `nth-child(2) { display: none` and that the rendered row markup contains `tag-source` for a row with a source. Run `fallow audit --format json --quiet --gate-marker agent` → verdict `pass`.

## Stop conditions

- Stop if showing the tag pushes the agent name or timestamp onto a second line at 320px; the placement then needs a different slot rather than a smaller tag.
- Stop if any adapter is found to report rows with no source, in which case an empty tag would need handling rather than rendering a bare chip.

## Design documentation

- After acceptance and validation: record in `AGENTS.md` that the Host tag is shown at every width because the agent name does not imply the runtime (both adapters emit `dsh-tui` after the canonical rename), and that `shared/catalog.mjs` canonicalises agent names. There is no `DESIGN.md` in this repository, and this plan does not create one.
