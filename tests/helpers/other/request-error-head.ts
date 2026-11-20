/**
 * The part of a request error that is safe to put in a skip reason, an annotation or a
 * log line: its first non-blank line, with ANSI colour codes removed (#2485).
 *
 * WHY NOT THE WHOLE MESSAGE
 *
 * A Playwright `APIRequestContext` error is two parts: a one-line cause, then a
 * `Call log:` block listing the request, and that block prints every request header
 * with its value. Measured on @playwright/test 1.58.2, and identical apart from the
 * version on 1.65.1 (#2167), a GET to a closed port with `api-key` and
 * `Authorization` headers throws:
 *
 *   apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:9
 *   Call log:
 *     - → GET http://127.0.0.1:9/models
 *     - user-agent: Playwright/1.65.1 (…)
 *     - api-key: <value, in full>
 *     - Authorization: Bearer <value, in full>
 *
 * Nothing in Playwright redacts them. A probe that writes `(e as Error).message` into a
 * `test.skip()` reason therefore copies the provider key into the test's annotations,
 * which `results.json` and the HTML report keep. That happened on the VM daily
 * `20261118T080018Z`, where the Azure AI Foundry endpoint dropped the TLS handshake.
 *
 * The first line holds the cause a reader needs (`connect ECONNREFUSED …`,
 * `Client network socket disconnected before secure TLS connection was
 * established`, `Timeout 15000ms exceeded.`). The call log adds only the request,
 * which the caller already knows.
 *
 * Tolerant of anything thrown: `Error.message` is typed `string`, but a thrown value
 * need not be an `Error` and `message` need not be a string. Every input maps to a
 * string, and this function never throws, so a probe's catch block cannot fail the
 * test it exists to skip.
 */

const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/** What is returned when the thrown value carries no readable text. */
export const UNREADABLE_REQUEST_ERROR = "unknown error (the thrown value carried no message)";

function rawText(error: unknown): string {
  try {
    if (error instanceof Error) {
      const { message } = error;
      return typeof message === "string" ? message : String(message);
    }
    if (typeof error === "string") return error;
    return String(error);
  } catch {
    // String(x) throws when x's toString or Symbol.toPrimitive throws, or x is a
    // null-prototype object with neither.
    return "";
  }
}

export function requestErrorHead(error: unknown): string {
  const head = rawText(error)
    .replace(ANSI_SGR, "")
    // `trim` also drops the `\r` of a CRLF line ending, so splitting on `\n` is enough.
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return head ?? UNREADABLE_REQUEST_ERROR;
}
