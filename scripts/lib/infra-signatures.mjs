// ESM half of the infra-signature exemption. The patterns live in
// `./infra-signature-patterns.json`; `./infra-signatures.ts` is the CommonJS half.
// The data file does NOT share the modules' basename on purpose — see the
// resolution trap documented in `infra-signatures.ts`.
//
// WHY THERE ARE TWO ACCESSORS FOR ONE LIST (#1310)
//
// #1031 introduced the exemption for ONE consumer: `@stable` auto-removal
// (`remove-stable-from-failures.ts`, TypeScript → CommonJS). #1310 added a
// second consumer on the triage side, and both places that need it there are
// ESM `.mjs`: `append-weekly-history.mjs`, which writes the classification into
// `reports/daily-history.jsonl`, and the triage dataset builder, which reads it.
//
// On Node 20 a CommonJS module cannot `require()` an ESM one, and a `.ts`
// compiled to CommonJS cannot import a `.mjs`. So one *code* module cannot serve
// both halves. JSON can, which is why the list is data: CommonJS gets it through
// `resolveJsonModule`, ESM through the read below. Copying the patterns into a
// second module was rejected — this repo has twice removed exactly that after it
// drifted (#1043, #1184).
//
// Keep this file's behaviour identical to the `.ts`. Both are covered by tests
// (`scripts/lib/infra-signatures.test.mjs` asserts, among other things, that the
// two agree on every pattern), because "identical" is the whole point and a
// silent divergence here would re-open the drift this design exists to prevent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Read rather than `import ... with { type: "json" }`: import attributes are not
// available across the Node versions this repo runs (20 locally and in CI), and
// a syntax error there would take down the daily's history append. The read
// happens once, at module load.
const RAW = JSON.parse(readFileSync(join(HERE, "infra-signature-patterns.json"), "utf8"));

/**
 * Ordered most-specific first — `classifyInfraError` returns the first match.
 * @type {{id: string, why: string, pattern: RegExp}[]}
 */
export const INFRA_SIGNATURES = RAW.map((s) => ({
  id: s.id,
  why: s.why,
  pattern: new RegExp(s.pattern, s.flags),
}));

/**
 * Playwright colourises error messages; the patterns match plain text.
 *
 * Two forms are stripped, not one: the proper ESC-prefixed sequence
 * (\u001b[<n>m), and a bare [<n>m whose escape was already lost. The second is
 * not hypothetical — the signatures stored in reports/daily-history.jsonl read
 * `Error: [2mexpect([22m…`, so the escape does go missing somewhere between the
 * reporter and the artifact. The bare form requires a digit (`+`, not `*`) so it
 * cannot eat real text like `[preflight]`.
 *
 * Character-for-character equivalent to the `.ts` half, which is asserted rather
 * than trusted: `infra-signatures.test.mjs` runs both on the same inputs. The
 * escape is written `\u001b` instead of as a literal control byte so that the
 * two files read the same and neither lints as `no-control-regex` by accident.
 */
export function stripAnsi(text) {
  return String(text || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\[[0-9;]+m/g, "");
}

/**
 * The infra signature carried by `error`, or `null` when the error is (or could
 * be) the spec's own. Matches anywhere in the message, not just the first line:
 * a wedge often surfaces as an assertion whose *cause* line is the transport
 * error, and the first line alone would miss it.
 *
 * That "anywhere" is the reason #1310 classifies at write time, where the full
 * message is still in hand. Handed only a stored `error_signature` — one line,
 * capped at 240 chars — this function is strictly weaker: it still catches a
 * flake whose transport error IS line 1, and it cannot catch one wrapped by an
 * assertion (the `#751` credential guard being the common wrapper here).
 */
export function classifyInfraError(error) {
  const text = stripAnsi(error ?? "");
  if (!text.trim()) return null;
  for (const signature of INFRA_SIGNATURES) {
    if (signature.pattern.test(text)) return signature;
  }
  return null;
}
