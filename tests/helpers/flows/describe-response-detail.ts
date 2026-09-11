import type { APIResponse } from "@playwright/test";
import { readFailureReason } from "../../fixtures/http-error-body";

/** Keeps the description readable inside an assertion message. */
const MAX_CHARS = 200;

const truncate = (value: string): string =>
  value.length > MAX_CHARS ? `${value.slice(0, MAX_CHARS)}…` : value;

/**
 * Describes, in one line, what a failing response's body said — for use as the
 * message of an assertion that is about to fail.
 *
 * Why this exists (#1777 / `LE-2598`): on the 2026-09-09 daily,
 * `api-flows-versions`'s read-back of a flow the `POST` had just created failed
 * with `Expected: 200 / Received: 404` and nothing else. The one string that
 * splits the two candidate shapes was never recorded — `detail: "Flow not
 * found"` is the row not being visible, `detail: "Not Found"` is FastAPI's
 * unmatched route — and recovering it cost three dailies. Paired with
 * {@link describeFlowReadback}, the two reads form a three-way discriminator;
 * neither alone separates a transient window from a genuinely absent row.
 *
 * Two properties are contractual, and both are pinned in
 * `describe-response-detail.test.ts`:
 *
 * 1. **It never throws.** It runs on the branch where a test is already
 *    failing. A throw here would replace the real failure with its own and
 *    destroy the signal it exists to sharpen — the same reasoning behind
 *    `describeFlowReadback` and `deleteFlow`'s bare attribution `catch`.
 *
 * 2. **A body that was empty, a body that could not be read, and a body with no
 *    `detail` field are three different observations**, and each is named
 *    (#1012 — an unevaluated result is unknown, not clean). The read-rejects
 *    branch is not exotic: Chromium does not retain a zero-length response
 *    body, so `response.text()` **rejects** for a bodyless response rather than
 *    resolving to `""` (measured in #1432). A naive `await res.text()` in a
 *    failing branch therefore throws on exactly the responses worth describing.
 *
 * Deliberately NOT declared through `apiCoverage`: it issues no request of its
 * own, and its caller's `expect` runs on the failing branch only.
 *
 * @param response The failing Playwright `APIResponse` whose body is in question.
 */
export async function describeResponseDetail(response: APIResponse): Promise<string> {
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    return `body unavailable (${readFailureReason(error)})`;
  }

  if (raw === "") return "<empty body>";

  // A FastAPI error body is `{"detail": ...}`; anything else is reported as the
  // body itself rather than dressed up as a detail, so a triage grepping for the
  // discriminator cannot mistake a whole payload for one.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { detail?: unknown }).detail === "string"
    ) {
      return `detail ${JSON.stringify(truncate((parsed as { detail: string }).detail))}`;
    }
  } catch {
    // Not JSON — fall through and report the raw body.
  }

  return `body ${truncate(raw)}`;
}
