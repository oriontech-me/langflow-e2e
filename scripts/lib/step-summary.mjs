// One place to append a block to the GitHub step summary (#1456).
//
// Three callers write provider-coverage blocks — the report verdict and the two
// target-selection scripts — and the whole point of moving those signals out of the
// job log is that they land somewhere a human reads. A per-caller copy of "append if
// there is a sink" is how one of them ends up silently not writing at all.
//
// Best-effort by design: the block is a reporting surface, never a verdict. Every
// caller also prints an annotation and its decision on stdout, so a failed write must
// not become the reason a lane fails. Returns whether it landed, so a caller that
// cares can say so instead of assuming.

import fs from "node:fs";

/**
 * @param {string} markdown block to append; empty means "nothing to say"
 * @param {string} [sink] file to append to; defaults to $GITHUB_STEP_SUMMARY
 * @returns {boolean} whether the block was written
 */
export function appendSummary(markdown, sink = process.env.GITHUB_STEP_SUMMARY) {
  if (!markdown || !sink) return false;
  try {
    fs.appendFileSync(sink, `${markdown}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a `collect-models` error safe to put in a markdown TABLE CELL.
 *
 * These strings are unbounded provider output: Google's spend-cap error carries a
 * documentation URL, and nothing stops a provider from answering with a newline or a
 * pipe, either of which ends the row early and eats the rest of the table. Capped for
 * the same reason `summarize()` caps elsewhere in this repo — a multi-KB payload in a
 * run summary buries the one line the summary exists to show.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function tableCell(text, max = 240) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
