import type { APIRequestContext } from "@playwright/test";

/**
 * Reads a flow by id and describes, in one line, what that read found — for use
 * as the message of an assertion that is about to fail.
 *
 * Why this exists (#1759 / `LE-2552`): on the 2026-09-08 daily, three
 * `api-flows-crud` assertions failed and none of their messages said what the
 * backend had done. `expect(found).toBeDefined() / Received: undefined` does not
 * distinguish *the row is missing from the database* from *the row is there and
 * the LIST did not return it*, and those are two different defects. The by-id
 * route answers exactly that question, so reading it at the moment of failure
 * turns an unattributable message into an attributable one. The assertion itself
 * is unchanged — this only decorates it.
 *
 * Two properties are contractual, and both are pinned in
 * `describe-flow-readback.test.ts`:
 *
 * 1. **It never throws.** It runs on the branch where a test is already failing.
 *    A throw here would replace the real failure with its own and destroy the
 *    signal it exists to sharpen — the same reason `deleteFlow` wraps its
 *    attribution hook in a bare `catch` (delete-flow.ts §2.3).
 *
 * 2. **It has three outcomes, not two.** A readback that could not be performed
 *    is `UNDECIDED` and claims neither verdict (#1012 — an unevaluated result is
 *    unknown, not clean). Folding a 503 into "the row is absent" would send a
 *    triage after a phantom, which is worse than printing nothing at all.
 *
 * Deliberately NOT declared through `apiCoverage`: the call only happens on the
 * failing branch, and the coverage gate FAILS a declaration the test never
 * issues (`fixtures/api-coverage-gate.spec.ts` §4). An undeclared request is
 * tolerated, so this needs no declaration.
 *
 * @param request  A Playwright `APIRequestContext` (`page.request` or the `request` fixture).
 * @param id       The flow id whose visibility is in question.
 * @param options  Optional Playwright request options, e.g. `{ headers: { Authorization } }`.
 * @param note     Extra context from the caller, carried into the line verbatim (e.g. the list's length).
 */
export async function describeFlowReadback(
  request: APIRequestContext,
  id: string,
  options?: Parameters<APIRequestContext["get"]>[1],
  note?: string,
): Promise<string> {
  const route = `/api/v1/flows/${id}`;
  const suffix = note ? ` [${note}]` : "";

  let status: number;
  try {
    const res = await request.get(route, options);
    status = res.status();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      `readback GET ${route} threw (${message}): UNDECIDED — ` +
      `the readback never answered, so it says nothing either way${suffix}`
    );
  }

  if (status === 200) {
    // Reports what it observed, and deliberately does not infer which
    // caller-side read failed: this runs from a list assertion AND from a raw
    // DELETE, and in the second there is no list to blame. The caller's `note`
    // carries the context.
    return `readback GET ${route} -> 200: the row EXISTS${suffix}`;
  }
  if (status === 404) {
    return `readback GET ${route} -> 404: the row is absent from the database${suffix}`;
  }
  return (
    `readback GET ${route} -> ${status}: UNDECIDED — ` +
    `the readback did not answer 200 or 404, so it says nothing either way${suffix}`
  );
}
