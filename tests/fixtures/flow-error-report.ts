/**
 * The read-only flow-error report a spec can ask `page` for (#1452).
 *
 * WHY THIS EXISTS
 *
 * The fixture's flow-error gate fails a test on a verdict it *reached* — v1
 * since #1162, v2 since #1165 (`f3bdd864`). What it cannot do is fail a test on
 * a verdict it never reached. Several paths do that — a body that timed out, one
 * it could not read at all (an unreadable content type), a stream the page
 * cancelled, an empty body, a v2 surface with no CDP session, and a provider
 * outage, the last downgraded on purpose because failing on a drained key would
 * strip `@stable` in an unreviewed commit (#1165). Read the set out of
 * `countUnevaluated`'s call sites rather than from a number here: this comment
 * shipped saying "four", which was the count of CATEGORIES and not of paths.
 * Every one of them is counted and printed as *"this test's flow-error verdict
 * is unknown, not clean"*, and then the test passes anyway.
 *
 * That is the right default for 200-plus specs that merely happen to drive a
 * run. It is the wrong default for a spec whose whole contract is *"the run did
 * not crash"* — `agent-tool-error-handling.spec.ts` says so in as many words:
 * *"No `allowFlowErrors`: any flow error fails the test via the fixture — that
 * IS the 'handled without crashing' guarantee."* For that spec, an unevaluated
 * run is not a neutral outcome; it is the assertion silently not happening.
 *
 * So the report answers the question the gate does not: **was a verdict reached,
 * and was it clean?** `clean` is true only when every run stream this test
 * produced was evaluated and none of them failed. Unknown counts as not clean,
 * which is the same rule the daily's runguard applies to a zero-test report
 * (#1012).
 *
 * WHAT IT IS NOT
 *
 * Not a hatch and not affected by one. `page.allowFlowErrors()` suppresses the
 * gate; it does not empty this report, so a hatched spec can still find out what
 * actually happened.
 *
 * It is also NOT per-run. Every count is cumulative for the whole test, and the
 * first draft of this comment claimed otherwise — that a spec tolerating one
 * deliberate failure could assert a *later* run came back clean. It cannot:
 * `clean` stays false for the rest of the test once anything has failed
 * (confirmed by probe during review, against the very sentence that promised
 * it). A spec that needs a per-run window takes TWO reports and compares them:
 *
 *     const before = await page.flowErrorReport();
 *     … drive the run …
 *     const after = await page.flowErrorReport();
 *     expect(after.failures.length).toBe(before.failures.length);
 *     expect(after.evaluated, "the run produced no verdict at all")
 *       .toBeGreaterThan(before.evaluated);
 *
 * which is why `evaluated` and the raw arrays are exposed and not just `clean`.
 *
 * Kept pure and separate from `fixtures.ts` for the reason `catalogVerdict` is:
 * a verdict that decides whether a test passes has to be unit-testable without
 * a browser, and the fixture then holds nothing but the I/O.
 */

/** One flow-error verdict the fixture reached during the test. */
export interface FlowErrorFailure {
  url: string;
  message: string;
}

/** One reason a run stream produced no verdict, with how often it did. */
export interface UnevaluatedRun {
  reason: string;
  count: number;
}

export interface FlowErrorReport {
  /** Flow-error verdicts reached so far, v1 and v2 alike. */
  failures: FlowErrorFailure[];
  /**
   * Run streams the fixture reached a CONCLUSION about — failed or clean.
   *
   * `clean` says nothing happened wrong; this says something happened at all.
   * The two are different assertions and the gap between them is a real failure
   * mode: with no run at all — a send that never fired, a run that moved to an
   * endpoint `runStreamSurface()` does not classify — every count is zero and
   * `clean` is vacuously true. A spec adopting this accessor as its gate should
   * assert `evaluated > 0` alongside it. A provider outage does not count:
   * it is a conclusion about the account, not about Langflow.
   */
  evaluated: number;
  /**
   * Run streams that produced NO verdict, by reason, sorted by reason.
   *
   * Sorted rather than in insertion order: the order these arrive in is the
   * order of network events, so an unsorted `summary` would differ between two
   * runs of the same spec — the same non-determinism that made the catalog
   * baseline report a phantom `MOVED`.
   */
  unevaluated: UnevaluatedRun[];
  /** Sum of `unevaluated[].count` — one unread stream is enough to void a verdict. */
  unevaluatedTotal: number;
  /**
   * Runs with no verdict yet, on either surface, at the moment of the call.
   *
   * Their verdict is not in, so it is neither a failure nor an unevaluated run —
   * it is simply not decided, and it therefore blocks `clean` too. A spec seeing
   * this should wait for its own run to finish (the Stop button hidden, the reply
   * rendered) and ask again; the report deliberately does NOT wait, because
   * nothing here can know whether a given stream is ever going to close.
   *
   * Normalised to 0 when the caller hands over something that is not a
   * non-negative integer — `clean` refuses that input (see below), but the FIELD
   * is a count and reads 0, so do not test `pending` to detect it; test `clean`
   * or read `summary`.
   */
  pending: number;
  /**
   * False when no CDP session could be opened, so the whole v2 surface — every
   * Playground and agent run on 1.12.x — went unwatched for this test.
   */
  v2Watched: boolean;
  /**
   * True only when a verdict was reached for every run stream and all of them
   * were clean. Unknown is never clean (#1012).
   */
  clean: boolean;
  /**
   * Why `clean` is what it is, as one line — meant to be passed straight to an
   * assertion so a red names its own cause:
   *
   *     const report = await page.flowErrorReport();
   *     expect(report.clean, report.summary).toBe(true);
   */
  summary: string;
}

export interface FlowErrorReportInput {
  failures: FlowErrorFailure[];
  /** Reason -> count, as the fixture accumulates it. */
  unevaluated: ReadonlyMap<string, number>;
  pending: number;
  evaluated: number;
  v2Watched: boolean;
}

/**
 * Build the report. Pure: no page, no clock, no network.
 *
 * Every input is copied rather than referenced — the fixture keeps mutating its
 * own accounting after the call, and a report that changed under the caller
 * would be worse than no report at all.
 */
export function buildFlowErrorReport(
  input: FlowErrorReportInput,
): FlowErrorReport {
  const failures = input.failures.map(({ url, message }) => ({ url, message }));
  const unevaluated = [...input.unevaluated.entries()]
    .map(([reason, count]) => ({ reason, count }))
    // Deliberately not `localeCompare`: that reads the runtime's default locale,
    // and this repo already treats an env-dependent assertion as a hazard. The
    // reasons are ASCII, so a plain comparison is both stable and enough.
    .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  const unevaluatedTotal = unevaluated.reduce((sum, e) => sum + e.count, 0);
  // `pending` is a SUM of counters the caller owns (`open.size + settling.size +
  // requests.size` from the v2 capture, plus the v1 in-flight count), so anything
  // but a non-negative integer is a bug in the caller rather than a state of the
  // run — and it is reported as UNDECIDABLE, not clamped to zero. The symbol is
  // `pendingStreams()`; an earlier version of this comment named an
  // `openStreams()` that does not exist and described it as one `Map.size`,
  // which understated what has to hold. Clamping is the tempting move and it is
  // the wrong direction: it would turn a nonsensical count into a clean verdict,
  // which is the one outcome this whole accessor exists to prevent (#1012).
  const pendingValid = Number.isInteger(input.pending) && input.pending >= 0;
  const pending = pendingValid ? input.pending : 0;
  const clean =
    pendingValid &&
    failures.length === 0 &&
    unevaluatedTotal === 0 &&
    pending === 0 &&
    input.v2Watched;

  const shape = {
    failures,
    evaluated: Math.max(0, Math.trunc(input.evaluated)) || 0,
    unevaluated,
    unevaluatedTotal,
    pending,
    v2Watched: input.v2Watched,
    clean,
  };
  return { ...shape, summary: summarize(shape, pendingValid) };
}

function summarize(
  report: Omit<FlowErrorReport, "summary">,
  pendingValid: boolean,
): string {
  if (report.clean) {
    // The vacuous case is a CLEAN verdict, so it cannot be reported as a
    // reason-for-not-clean — it has to be said here or nowhere. A spec asserting
    // only `clean` would otherwise read this line on a test where no run ever
    // happened.
    return report.evaluated === 0
      ? "no run stream in this test produced a verdict at all — nothing failed, and nothing ran either; assert `evaluated > 0` if a run was expected"
      : `every run stream in this test was evaluated (${report.evaluated}) and none carried a flow error`;
  }

  const parts: string[] = [];
  if (report.failures.length > 0) {
    // First, and with the message: a reached verdict is the strongest thing this
    // report can say, and it is what the reader needs to see first.
    parts.push(
      `${report.failures.length} flow error(s): ` +
        report.failures
          .map((f) => `${f.url} — ${f.message.split("\n")[0]}`)
          .join("; "),
    );
  }
  if (!report.v2Watched) {
    // Ahead of the counts, because it explains why they may be empty: with no
    // CDP session, a v2 run produces no verdict AND no unevaluated entry from
    // this path — the fixture records that one separately.
    parts.push(
      "the v2 run surface was NOT watched (no CDP session), so every Playground/agent run in this test is unaccounted for",
    );
  }
  if (report.unevaluatedTotal > 0) {
    parts.push(
      `${report.unevaluatedTotal} run stream(s) not evaluated: ` +
        report.unevaluated.map((e) => `${e.count}× ${e.reason}`).join(", "),
    );
  }
  if (report.pending > 0) {
    parts.push(
      `${report.pending} run stream(s) still open — no verdict yet; wait for the run to finish before asking`,
    );
  }
  if (!pendingValid) {
    // Never reachable from the fixture, and it still has to say something: a
    // not-clean report whose summary lists no reason is the least useful red a
    // spec could get.
    parts.push(
      "the open-stream count was not a non-negative integer, so how many runs are still in flight is unknown",
    );
  }
  return `this test's flow-error verdict is NOT clean: ${parts.join(" | ")}`;
}
