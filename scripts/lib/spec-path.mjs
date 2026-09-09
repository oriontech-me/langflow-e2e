// The ONE spelling of "a spec path, as the merged Playwright report writes it".
//
// The merged report spells `spec.file` relative to Playwright's rootDir
// (`tests/`), while a shard's liveness summary carries `matrix.files`, which may
// be either form depending on how the list was built. Since #1589 that string is
// also a JOIN KEY between two scripts in two languages: `report-backend-outages.mjs`
// writes the collateral attempts and `remove-stable-from-failures.ts` looks them
// up. A near-miss in the normalisation corroborates nothing, exempts nothing, and
// is completely invisible — so the two share this function rather than each
// carrying a copy that only has to agree.
export function normalizeSpecPath(file) {
  return String(file || "")
    .replace(/^\.\//, "")
    .replace(/^tests\//, "");
}
