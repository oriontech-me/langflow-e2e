// The ONE spelling of "the parameterization label a model-parameterized spec
// carries on its describe title" — `Agent max_tokens [google / gemini-2.5-flash]`
// -> `google / gemini-2.5-flash`, `[model:gpt-4o-mini]` -> `model:gpt-4o-mini`.
//
// `append-weekly-history.mjs` has recorded it as the row's `param` since #899, so
// the triage dataset can group failures by provider variant. Since #1763 the same
// string is also part of a JOIN KEY: a parameterized spec emits one `spec` per
// variant with the SAME file, the SAME `spec.title` and the SAME line — the
// variant lives only in the enclosing describe — so a key without it lets one
// variant's measured outage be attributed to another's failure. Five of the 55
// committed history rows already carry a duplicate `(file, test)` pair, and the
// lane can return to that state at any time: `daily-stable.yml`'s weekday
// rotation step is `continue-on-error` and its own comment names the costlier
// multi-provider run as the intended fallback.
//
// So the two sides share this function rather than each carrying a copy that only
// has to agree — the same reason `spec-path.mjs` exists (#1589). A near-miss in
// either normalisation corroborates nothing, exempts nothing, and is invisible.

/**
 * Scan a suite-title path innermost-first and return the first bracketed
 * content, or null when nothing is parameterized.
 *
 * @param {string[]} suitePath  suite titles, outermost first
 */
export function paramFromSuitePath(suitePath) {
  for (let i = (suitePath || []).length - 1; i >= 0; i--) {
    const m = /\[([^\]]+)\]/.exec(suitePath[i] || "");
    if (m) return m[1].trim();
  }
  return null;
}
