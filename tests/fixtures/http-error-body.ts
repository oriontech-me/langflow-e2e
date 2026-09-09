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
 * WHY IT WAS FILED, and what the record actually shows. #1432 was raised off
 * #1424 — three consecutive dailies of `400 POST /api/v1/variables/` with, it
 * said, no body in the logs. **That premise was wrong, and #1424 is closed**
 * (root-caused 2026-08-12, fixed by PR #1441): two of those four `400`s did
 * carry bodies, and a 2026-07-13 occurrence on the same endpoint printed
 * `{"detail":"Invalid API key for OpenAI"}` in full. The causes were a
 * create-vs-update race (#1431), a key with no credits, and an Azure endpoint
 * answering past its 10 s validation timeout — none of them this. So nothing
 * here is offered as an explanation of #1424; #1424's own close-out is what
 * says this is still worth fixing, and on its own terms:
 *
 *   > #1432 is still worth fixing: it is the reason this took three dailies.
 *
 * MEASURED, and it is what the fix stands on: **Chromium does not retain a
 * zero-length response body**, so `response.text()` REJECTS with `response.text:
 * Protocol error (Network.getResponseBody): No data found for resource with
 * given identifier` rather than resolving to `""`. Not specific to `400` —
 * verified across 200 / 204 / 400 / 404 / 500, with an explicit
 * `content-length: 0`, and with a gzip of the empty string; a redirect gives a
 * third real message (`Response body is unavailable for redirect responses`).
 * So the branch the fixture used to swallow in silence is not exotic: it is what
 * every bodyless response does, and until now every one of them looked exactly
 * like a body nobody printed.
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
  let raw: string;
  try {
    raw = rawReason(error);
  } catch {
    // A `message` getter that throws. Exotic — Playwright throws plain `Error`s
    // — but this function replaced a `catch` that never touched `e` at all, so
    // it must not be the first thing in the fixture able to throw from inside an
    // async `response` handler that has no surrounding try.
    raw = "the read failed with an error that could not be inspected";
  }
  // The first NON-BLANK line. `[0]` alone loses the whole message when the
  // first line is empty (`new Error("\nreal message")`), and then the fallback
  // below claims there was no message — the exact loss this exists to fix.
  const firstLine = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!firstLine) return "the read failed with no message";
  return firstLine.length > REASON_MAX
    ? `${firstLine.slice(0, REASON_MAX)}…`
    : firstLine;
}

/**
 * A value that is typed `string` but reaches us from a thrown object, coerced
 * to one. `String()` is used rather than a template literal because a `Symbol`
 * throws in the latter and this must not be the thing that throws.
 */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "";
  }
}

function rawReason(error: unknown): string {
  return error instanceof Error
      ? // A named subclass says something ("TimeoutError"); the generic `Error`
        // name says nothing, and printing it would be the empty line again with
        // extra steps.
        //
        // `message` is TYPED `string` and is not guaranteed to BE one: it is a
        // plain own property and anything can write it. Returning it unchecked
        // handed a non-string to `raw.split()` one frame up, OUTSIDE the try —
        // so this function threw, from inside an async `response` handler with
        // no surrounding try, which is the one thing its header says it must
        // never do.
        asText(error.message) ||
          (asText(error.name) && asText(error.name) !== "Error"
            ? asText(error.name)
            : "")
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
    //
    // Reachable on this very transport, and the case is worth naming because it
    // is narrow: a body of **non-zero length that decodes to the empty string**.
    // A 3-byte UTF-8 BOM does it — Chromium retains the bytes, `text()`
    // resolves, and the result is `""`. A genuinely zero-length body rejects
    // instead (see the header), so this branch and the one above are two
    // different observations rather than two spellings of one.
    return { responseBody: "", line: "   Response: <empty body>" };
  }
  return { responseBody: read.body, line: `   Response: ${read.body}` };
}

/**
 * The teardown counterpart, over every recorded HTTP error.
 *
 * The inline line above races the end of the test. The read IS awaited inside
 * the `page.on("response")` handler — what nothing awaits is the handler
 * itself, so an error observed late can have its entry recorded (that part is
 * synchronous) while the log never gets the `Response:` line under its `🚨`.
 * This is where that becomes visible instead of looking like a body nobody
 * bothered to print.
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
      // Not `localeCompare`: it reads the RUNTIME locale, so the order of two
      // equally-common reasons would depend on the machine printing them.
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([reason, count]) => `      ${count}× ${reason}`),
  ];
}
