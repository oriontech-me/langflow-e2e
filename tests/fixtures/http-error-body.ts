/**
 * What to record, and what to print, for the body of a monitored HTTP error
 * (#1432).
 *
 * The fixture used to do this inline:
 *
 * ```ts
 * try {
 *   entry.responseBody = await response.text();
 *   console.log(`   Response: ${entry.responseBody}`);
 * } catch (e) {
 *   entry.responseBody = "Could not read response";
 * }
 * ```
 *
 * When the read threw, the sentinel went into the entry and **nothing was
 * printed**. The log showed the `🚨 Backend Error` line and moved on,
 * indistinguishable from an error whose body was empty — so reading the log,
 * there was no way to tell "the backend said nothing" from "we could not ask",
 * and the reason was discarded along with the body. That is #1012's rule, an
 * unread body is unknown rather than absent, applied to the fixture that is
 * itself the suite's evidence trail.
 *
 * It is not hypothetical. #1424 is open on *"the global-variable persist call
 * answers non-2xx while validate-provider succeeds"* and has had no cause
 * through three consecutive dailies (2026-08-10/11/12, `400 POST
 * /api/v1/variables/`). Not one of those four occurrences carries a body in the
 * logs, while every `500` in the same runs does — the status alone does not say
 * what the backend rejected, which is most of why the issue is still
 * descriptive.
 *
 * MEASURED while building this, and it is the finding rather than a detail:
 * **Chromium does not retain a zero-length response body**, so `response.text()`
 * on a bodyless `400` REJECTS with `Protocol error (Network.getResponseBody): No
 * data found for resource with given identifier` — it does not resolve to `""`.
 * (Pinned behaviourally in `http-error-gate.spec.ts`.) The branch that used to
 * be swallowed in silence is therefore not an exotic one; it is what every
 * bodyless error response does, which is the likeliest explanation for #1424's
 * shape — the `500`s in those same runs carry `{"detail": …}`, which Chromium
 * keeps. The `""` branch below is still real and still distinguished: it is
 * reachable through other transports, and an entry that says "empty" must not be
 * confusable with one that says "we could not ask".
 *
 * THREE states, not two. The fixture records the entry BEFORE reading the body
 * on purpose (the read is an `await` inside an async event handler and teardown
 * does not wait for it — #1084's undercount), so a read that never settles
 * leaves an entry with neither a body nor a failure. That third state is
 * therefore given a reason up front and overwritten by whichever of the other
 * two wins; nothing here can produce an entry that is silent about its body.
 *
 * Pure and unit-tested (`http-error-body.test.ts`). `http-error-gate.spec.ts`
 * remains the behavioural half of the fixture; the printing decision belongs in
 * the unit lane, where forcing a body read to fail is one line rather than a
 * container.
 */

/**
 * The reason stamped on an entry the moment it is recorded, before the read is
 * attempted. It survives only when the read neither resolves nor rejects before
 * the test ends.
 */
export const BODY_PENDING =
  "the body read had not settled when the test ended";

/** Longest reason text carried into the entry and the log. */
const REASON_MAX = 200;

export type BodyRead =
  | { ok: true; body: string }
  | { ok: false; error: unknown };

export interface BodyOutcome {
  /**
   * Set ONLY when the body was actually read. `""` is a real, empty body and
   * must stay distinguishable from an unread one — which is why this is
   * optional rather than a sentinel string: a sentinel is also a value a
   * backend could legitimately return.
   */
  responseBody?: string;
  /** Set ONLY when it was not read. The reason, for the entry and the log. */
  bodyUnavailable?: string;
  /** The line to print under the `🚨 Backend Error` line. Never empty. */
  line: string;
}

/**
 * One line of an arbitrary thrown value, capped. Playwright's body-read
 * rejections carry a useful first line (`Protocol error
 * (Network.getResponseBody): No resource with given identifier found`) under a
 * long stack, and a `throw "string"` or a `throw undefined` has to survive this
 * too — the catch that this replaces accepted anything.
 */
export function readFailureReason(error: unknown): string {
  const raw =
    error instanceof Error
      ? // A named subclass says something ("TimeoutError"); the generic `Error`
        // name says nothing, and printing it would be the empty line again with
        // extra steps.
        error.message || (error.name && error.name !== "Error" ? error.name : "")
      : typeof error === "string"
        ? error
        : error === undefined
          ? "undefined"
          : error === null
            ? "null"
            : (() => {
                try {
                  return String(error);
                } catch {
                  return "a value that cannot be stringified";
                }
              })();
  const firstLine = raw.split("\n")[0].trim();
  if (!firstLine) return "the read failed with no message";
  return firstLine.length > REASON_MAX
    ? `${firstLine.slice(0, REASON_MAX)}…`
    : firstLine;
}

/**
 * Decide what a body read produced: what the entry records, and what the log
 * says. Every branch prints — the defect being fixed is a branch that did not.
 */
export function describeResponseBody(read: BodyRead): BodyOutcome {
  if (!read.ok) {
    const reason = readFailureReason(read.error);
    return {
      bodyUnavailable: reason,
      line: `   Response: <could not be read: ${reason}>`,
    };
  }
  if (read.body === "") {
    // Said out loud rather than printed as a bare `Response:` with nothing
    // after it, which reads exactly like a line that was cut short.
    return { responseBody: "", line: "   Response: <empty body>" };
  }
  return { responseBody: read.body, line: `   Response: ${read.body}` };
}

/**
 * The teardown counterpart, over every recorded HTTP error.
 *
 * The inline line above races the end of the test — the read is not awaited —
 * so an error observed late can leave the log with a `🚨` line and no
 * `Response:` line at all. This is where that becomes visible instead of
 * looking like a body nobody bothered to print.
 *
 * Returns an empty array when every error carried a body, so the caller adds no
 * noise to the common case.
 */
export function summarizeMissingBodies(
  entries: Array<{ bodyUnavailable?: string }>,
): string[] {
  const byReason = new Map<string, number>();
  for (const entry of entries) {
    if (entry.bodyUnavailable === undefined) continue;
    byReason.set(
      entry.bodyUnavailable,
      (byReason.get(entry.bodyUnavailable) ?? 0) + 1,
    );
  }
  if (byReason.size === 0) return [];
  const total = [...byReason.values()].reduce((a, b) => a + b, 0);
  return [
    `   ⚠️  ${total} of them carry NO body — unread is unknown, not absent (#1012):`,
    ...[...byReason.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `      ${count}× ${reason}`),
  ];
}
