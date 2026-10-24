# Make every interactive affordance on the agent table keyboard-operable

**Status: Done, with a correction** — implemented in `ffc731e` on `feat/pwa-responsive` (PR #12).

Written against: `e1be0b0` (`fix(dashboard): keep the workspace directory at every width`), plus the uncommitted working-tree changes in `.worktrees/pwa-responsive` that restore the full workspace path and add the workspace label and inline branch.

## Evidence chain

- Surface: `<path: dashboard.mjs>` → `renderDashboardHtml()`, the page at route `/`. The two affordances are the workspace path chip in the "Workspace / Directory" cell and the prompt cell in "Current Tool & Prompt".
- Problem: the two affordances that carry the primary task — copy a workspace path, expand a prompt — are a `<span>` and a `<div>` with delegated click handlers. Nothing in the page makes either one reachable or operable from a keyboard: `aria-` occurs 0 times, `role=` 0 times, `tabindex` 0 times, and there is no `<label>`.
- Design evidence: the same surface already uses native `<button>` for every other action — the four filter tabs (`dashboard.mjs:598-601`), the modal close button (`:632`), and the update-banner dismiss (`:557`). `.filter-tab` (`dashboard.mjs:299`) is the established button styling and is styled for pressability explicitly (`cursor: pointer`, `transition: all 0.1s ease`, a `:hover` rule at `:310` and a `.active` rule at `:311`).
- Owner: `.path-chip` (`dashboard.mjs:252`) and `.action-text` (`dashboard.mjs:346`) in the page's inline stylesheet; the markup is generated in `renderRows()` at `dashboard.mjs:788` and `:803`.
- Scope and affected surfaces: only these two cells of the agent table. The delegated listeners at `dashboard.mjs:679` and `:684` already dispatch via `e.target.closest('[data-copy-path]')` and `e.target.closest('[data-agent-id]')`, so they keep working unchanged when the elements become buttons — the attributes move onto the button itself.
- Uncertainty: none affecting the correction. Screen-reader announcement wording is not specified by any document in this repository, so the plan fixes the element semantics and the accessible name only, and leaves any further phrasing to review.

## Design decision

Render the two affordances as `<button type="button">` elements instead of a `<span>` and a `<div>`, and reset the two classes so the button element carries no default chrome. This resolves the root problem — the affordances are not operable without a mouse — and it does so by following the convention the surface already established rather than introducing a new one. `type="button"` is required: these cells are inside no form today, but a future form wrapper would otherwise make them submit.

The accessible name comes from the existing visible text, which is already meaningful (`/home/…/agent-notify`, and the prompt text itself). The existing `title` attributes already state the action ("Click to copy full path", "Click to expand prompt") and become the accessible description.

The `.action-plain` variant at `dashboard.mjs:804` is a row with nothing to expand. It stays a non-interactive element and must **not** become a button: it has no handler and `cursor: default` today, and converting it would announce a control that does nothing.

## Reuse

- `--accent`, `--card-border`, `--text-muted`, `--card-bg` tokens from the `:root` block (`dashboard.mjs:132-149`).
- `.filter-tab` (`dashboard.mjs:299`) as the exemplar for a native button on this surface: it demonstrates the reset this plan needs (explicit `border`, `background`, `color`, `cursor`, `transition`) and the `:hover`/`.active` treatment to stay consistent with.
- `.path-chip` (`dashboard.mjs:252`) and `.action-text` (`dashboard.mjs:346`) keep their current visual declarations; only the properties the browser's default button style would override are added.
- Exemplar: `dashboard.mjs:598-601` (filter tabs) and `:632` (modal close) for button markup on this surface.

No new primitive is required. The existing classes already own the appearance, and the existing listeners already own the behavior.

## Changes

1. `dashboard.mjs:788` — the workspace path chip
   - Change: replace the `<span class="path-chip path-full" …>` element with `<button type="button" class="path-chip path-full" …>`, keeping `data-copy-path`, `title`, and the text content exactly as they are, and closing with `</button>`.
   - Preserve: the full path text, the `data-copy-path` value used by the copy handler, the `title` tooltip, and the wrapping behaviour that keeps a long path readable.
   - Verify: the chip is in the tab order; pressing Enter or Space copies the path and shows the existing "Copied to clipboard!" toast; the visual appearance is unchanged at 320, 375, 768 and 1280 px.

2. `dashboard.mjs:803` — the expandable prompt cell
   - Change: replace the `<div class="action-text" data-agent-id="…" title="…">` element with `<button type="button" class="action-text" data-agent-id="…" title="…">`, keeping `data-agent-id`, `title` and the inner `[tool]` code plus prompt span unchanged, and closing with `</button>`.
   - Preserve: the `data-agent-id` value used by `showModalById`, the two-line clamp, and the fact that the modal opens with the same content.
   - Verify: the cell is in the tab order; Enter or Space opens the prompt modal; the clamp still shows at most two lines.

3. `dashboard.mjs:804` — the non-interactive variant
   - Change: none to the element. It stays `<div class="action-text action-plain">`.
   - Preserve: it must remain outside the tab order and carry no `data-agent-id`, because there is nothing to expand.
   - Verify: an idle row with no tool and no prompt cannot be focused and does not open the modal.

4. `dashboard.mjs:252` and `dashboard.mjs:346` — button reset
   - Change: add to both `.path-chip` and `.action-text` the properties the user-agent button style would otherwise impose: `border: none; background: transparent; font: inherit; text-align: left; padding: 0; margin: 0;` — except where the class already declares that property, in which case keep the existing value (`.path-chip` already sets `background`, `padding`, `border-radius`; `.action-text` sets none of these). Add `appearance: none;` to both. `.path-chip` keeps its existing `background: rgba(110, 118, 129, 0.1)` and `padding: 2px 6px`.
   - Preserve: the computed appearance of both elements as measured before the change.
   - Verify: side-by-side screenshot comparison against the current build shows no visual diff at any of the four viewports; `getComputedStyle` reports the same `background-color`, `padding`, `border-width` and `font-family` as before.

## Scope

- Inherit: every rendered agent row, at every viewport. Both cells appear once per row, and every row goes through `renderRows()`.
- Verify: the copy still works through the delegated listener at `dashboard.mjs:679` after the element becomes a button (the listener uses `closest('[data-copy-path]')`, so no change is expected — but a button's default `type` would matter if one were omitted). The modal still opens through `dashboard.mjs:684`.
- Exclude: the `.action-plain` variant, which stays non-interactive by design. The filter tabs, modal close and banner dismiss already are buttons and are untouched.

## Validation

- Product: from a keyboard alone, tab to a row's workspace path, press Enter, and confirm the path is copied; tab to its prompt, press Enter, and confirm the prompt modal opens with the agent's tool and text.
- Interface: routes — `/` only. States — a row with a tool and prompt, a row with neither (must stay inert), and a row whose prompt was captured but whose tool is null. Content extremes — a long absolute path that wraps, and a prompt long enough to clamp. Viewports — 320, 375, 768, 1280 px. Interactions — mouse click and Enter/Space must produce identical results.
- System: confirm `.filter-tab` remains the only button-style exemplar and that no second styling pattern was introduced for these two cells; confirm `.action-plain` still computes `cursor: default` and has no `data-agent-id`.
- Repository: `node test_cases.test.js` and `bun test_cases.test.js` → both report `0 failed`. Add assertions that the rendered markup contains `<button type="button" class="path-chip path-full"` and `class="action-text" data-agent-id`, and that the `.action-plain` case renders neither a button nor a `data-agent-id`. Run `fallow audit --format json --quiet --gate-marker agent` → verdict `pass`.

## Stop conditions

- Stop if the delegated listeners at `dashboard.mjs:679`/`:684` are changed to depend on the element tag rather than the data attribute — the two elements would then need separate handlers and the plan's "no behavior change" assumption fails.
- Stop if a `<form>` is introduced around the table, which changes how `type="button"` behaves and may require revisiting the reset.
- Stop if converting to a button changes the computed background, padding or font in the visual comparison; the plan's aim is semantics only, and a visual change would need its own review.

## Outcome

Implemented as planned, with one addition the plan's validation exercise forced.

The plan's stop conditions were checked and none applied: the delegated listeners
still dispatch on the data attributes and not on the element tag, no `<form>`
wraps the table, and the computed background, padding and font of both controls
are unchanged. One visual property did change and was restored: the chip's
`border-bottom: 1px solid rgba(48, 54, 61, 0.6)` was dropped by the button reset,
which flattens the chip against the row. It is now declared after the reset, and
the computed value was read back from the browser to confirm.

The addition: a keyboard user could reach the buttons but not keep them. The
table is rebuilt from a string every 3 s, so the focused element was thrown away
and focus fell to the body mid-interaction. `renderRows()` now records the focused
row control by its data attribute and restores it on the matching control after
the rebuild. This is behaviour rather than presentation, and it is invisible to
the mouse, which is why the plan did not anticipate it: it surfaced only when the
journey was actually driven with Tab.

## Design documentation

- After acceptance and validation: record in `AGENTS.md` under a new "Dashboard UI" note that interactive elements inside the agent table are native `<button type="button">` with data attributes carrying behavior, and that non-interactive variants (`action-plain`) carry neither the attribute nor the element. There is no `DESIGN.md` in this repository, and this plan does not create one.
