// Making a measured string safe to RENDER, in the two places this repo renders one
// (issue #1801).
//
// Both consumers show a reason that came from a provider's own error body, and both
// were closing half the hole each: `lane-coverage-verdict.mjs` collapsed newlines
// (the `$GITHUB_OUTPUT` forging vector) and left `|` to split its markdown table,
// while `select-daily-model-target.mjs` escaped `|` and left the newline. A
// multi-line reason is not hypothetical — `collect-models.ts` writes a collector
// STALL reason built by `formatSaveBusyFailure()`, which is deliberately several
// lines — so on a stall day the rotation table terminated at that row and the rest
// of it fell out of the table.
//
// One implementation, imported by both, for the reason this repo keeps re-learning:
// two copies of one decision drift, and here they had already drifted before either
// was a week old.

/**
 * A measured string, safe for a step output and for an `::error::` annotation.
 *
 * The runner reads `$GITHUB_OUTPUT` line-wise, so a newline inside a value could
 * forge a second `key=value` line — `verdict=covered` included, which is what the
 * daily's fail-closed gate reads, and GitHub takes the LAST occurrence of a key.
 * ANSI codes go too: Playwright's error text carries them and they render as
 * literal noise in an issue body.
 *
 * @param {unknown} value
 * @returns {string} one line, no control characters
 */
export function displaySafe(value) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A measured string, safe INSIDE a markdown table cell.
 *
 * `displaySafe` first — a newline ends the table outright, which is worse than a
 * split row — then the pipe, which would otherwise open extra columns and push
 * every value after it out of its own.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function tableCell(value) {
  return displaySafe(value).replace(/\|/g, "\\|");
}
