/**
 * Which failure errors are NOT attributable to the spec that reported them.
 *
 * When the backend dies mid-run (#1030/#1048), every test that touches it fails
 * with a transport-level error and the report blames the specs that happened to
 * be running. On run 30374528125, 14 of 19 hard failures described one wedged
 * backend, not 14 broken specs. Those failures must never reach the `@stable`
 * auto-removal path (`scripts/remove-stable-from-failures.ts`), which edits spec
 * files and commits them to `main` with no human review.
 *
 * WHY THE LIST IS DELIBERATELY NARROW
 *
 * The mass-failure guard already covers the WIDE wedge (>5 hard failures =>
 * remove nothing). The hole #1031 closes is the NARROW one: a wedge that costs
 * ≤5 tests silently strips their tags. Closing it means turning off auto-removal
 * for whatever matches here — so a pattern that also fires on a real product
 * regression would quietly disable the mechanism instead of protecting it.
 *
 * The bar for inclusion is therefore: **the error cannot be a product assertion
 * under any reading**. It is the harness failing to reach or talk to the
 * backend, full stop. Concretely:
 *
 *  - `apiRequestContext.*: Timeout` — a direct REST call to Langflow that never
 *    answered. Backend down or backend stalled; both are infra. (14 occurrences
 *    in `reports/daily-history.jsonl` at the time of writing.)
 *  - `[preflight] … is not reachable` — the globalSetup health check (#1012).
 *  - socket/DNS level errors — `ECONNREFUSED`, `ECONNRESET`, `socket hang up`,
 *    `EAI_AGAIN`, `net::ERR_CONNECTION_*`, `net::ERR_EMPTY_RESPONSE`.
 *
 * Explicitly EXCLUDED, though they dominate a wedged run's report:
 *
 *  - `locator.click: Timeout`, `page.waitForSelector: Timeout`,
 *    `expect(locator).toBeVisible() failed` — a wedge produces these, but so
 *    does a genuine UI regression, and they are the three most common failure
 *    signatures in the whole history file. Exempting them would mean the daily
 *    stops quarantining almost anything.
 *
 * The consequence is accepted and asymmetric on purpose: a false negative (a
 * genuinely broken spec keeps `@stable` for one more day) costs one extra red
 * daily; a false positive costs a human-gated restoration PR for an innocent
 * spec. The narrow list errs toward the cheaper mistake.
 *
 * This module is pure and dependency-free so both the auto-removal script and
 * its unit tests can import it without touching disk.
 */

export interface InfraSignature {
  /** Stable id, rendered in the issue body and asserted by the unit tests. */
  id: string;
  /** One-line reason this error cannot be the spec's own fault. */
  why: string;
  pattern: RegExp;
}

/**
 * Ordered most-specific first — `classifyInfraError` returns the first match,
 * and the id it returns is what triage reads.
 */
export const INFRA_SIGNATURES: InfraSignature[] = [
  {
    id: "preflight-unreachable",
    why: "the globalSetup health check could not reach Langflow at all",
    pattern: /\[preflight\][^\n]*is not reachable/i,
  },
  {
    id: "api-request-timeout",
    why: "a direct REST call to the backend never answered",
    pattern: /\bapiRequestContext\.\w+:\s*Timeout\b/,
  },
  {
    id: "connection-refused",
    why: "the backend refused the TCP connection",
    pattern: /\bECONNREFUSED\b|net::ERR_CONNECTION_REFUSED/,
  },
  {
    id: "connection-dropped",
    why: "the connection to the backend was dropped mid-request",
    pattern:
      /\bECONNRESET\b|socket hang up|net::ERR_CONNECTION_(RESET|CLOSED|ABORTED)|net::ERR_EMPTY_RESPONSE/i,
  },
  {
    id: "host-unresolvable",
    why: "the backend host could not be resolved",
    pattern: /\bEAI_AGAIN\b|\bENOTFOUND\b|net::ERR_NAME_NOT_RESOLVED/,
  },
];

/**
 * Playwright colourises error messages; the patterns above match plain text.
 *
 * Two forms are stripped, not one: the proper \u001b[…m sequence, and a bare
 * […m whose escape was already lost. The second is not hypothetical — the
 * signatures stored in reports/daily-history.jsonl read `Error: [2mexpect([22m…`,
 * so the escape does go missing somewhere between the reporter and the artifact.
 * The bare form requires a digit so it cannot eat real text like `[preflight]`.
 */
export function stripAnsi(text: string): string {
  return String(text || "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\[[0-9;]+m/g, "");
}

/**
 * The infra signature carried by `error`, or `null` when the error is (or could
 * be) the spec's own. Matches anywhere in the message, not just the first line:
 * a wedge often surfaces as an assertion whose *cause* line is the transport
 * error, and the first line alone would miss it.
 */
export function classifyInfraError(error: string | null | undefined): InfraSignature | null {
  const text = stripAnsi(error ?? "");
  if (!text.trim()) return null;
  for (const signature of INFRA_SIGNATURES) {
    if (signature.pattern.test(text)) return signature;
  }
  return null;
}
