import { versionAtLeast } from "../other/served-version";

/**
 * Whether a cancelled knowledge-base ingestion run keeps `finished_at: null` forever on
 * this Langflow build — a confirmed regression (#2417, filed as LE-3447).
 *
 * Upstream #13508 (`ba88fe1767`, first nightly `1.14.0.dev23`, `release-1.14.0` only)
 * made `execute_with_status` finish a job through `complete_live_job`, which writes
 * only while the row is still live. `POST /{kb}/cancel` marks the job `cancelled`
 * without a `finished_timestamp`, so nothing ever sets it, and `GET /{kb}/runs/{id}`
 * projects `finished_at` from exactly that column. Before dev23 the unconditional
 * COMPLETED write set it as a side effect.
 *
 * No upper bound: no build carries a fix yet. When one does, the declared-failing
 * check in memory-base-ingestion.spec.ts passes, Playwright reports "expected to fail
 * but passed", and that is the cue to add the fixed version here.
 *
 * The 1.13 lines and `main` (as of 2026-11-12) lack #13508 and are not affected. An
 * unreadable version throws (versionAtLeast does not guess).
 */
export function cancelledRunKeepsNullFinishedAt(version: unknown): boolean {
  return versionAtLeast(version, "1.14.0.dev23");
}
