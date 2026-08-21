import type { Locator } from "@playwright/test";

/**
 * The trigger that opens a node TableInput's editing dialog, resolved from the
 * field's container (`div-table_<field>`, e.g. `div-table_headers`).
 *
 * Anchored on the container's `data-testid` plus the role — deliberately NOT on
 * the accessible name. Upstream a11y PR #14461 (`13bb21ce26`, landed on
 * `release-1.12.0` 2026-08-18, first shipped in nightly `1.12.0.dev32`) added
 * `aria-labelledby={ariaLabelledBy}` to this button, pointing at the field's
 * visible label. `aria-labelledby` outranks an element's own contents in the
 * accessible-name computation, so the name flipped from the backend
 * `trigger_text` ("Open table") to the field's display name ("Headers",
 * "Body") — while the button, its visible text and its behaviour are
 * unchanged. Every spec clicking it as `getByRole("button", { name: "Open
 * table" })` stopped matching on the same day (#1488).
 *
 * `TableNodeComponent` renders exactly one button inside that container, so the
 * role alone is unambiguous; a second one appearing there fails strict mode
 * loudly rather than clicking the wrong control.
 */
export function tableFieldTrigger(fieldContainer: Locator): Locator {
  return fieldContainer.getByRole("button");
}
