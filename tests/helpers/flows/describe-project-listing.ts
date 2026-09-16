import type { APIRequestContext } from "@playwright/test";
import { readFailureReason } from "../../fixtures/http-error-body";

const ROUTE = "/api/v1/projects/";

/** Keeps the description readable inside an assertion message. */
const MAX_CHARS = 120;

/**
 * Describes a body that answered `200` but is not a list of projects, in a form
 * a triage can act on: what it was, and enough of it to recognise.
 */
function describeShape(body: unknown): string {
  const kind = body === null ? "null" : Array.isArray(body) ? "array" : typeof body;
  let preview: string;
  try {
    preview = JSON.stringify(body) ?? String(body);
  } catch {
    preview = "<not serialisable>";
  }
  const shown = preview.length > MAX_CHARS ? `${preview.slice(0, MAX_CHARS)}…` : preview;
  return `${kind}: ${shown}`;
}

/**
 * Re-reads the projects listing and describes, in one line, whether a project
 * of this name is in it — for use as the message of an assertion that is about
 * to fail on its ABSENCE from an earlier read of the same listing.
 *
 * Why this exists (#1807 / `LE-2598`): on the 2026-09-10 daily,
 * `api-projects-transfer`'s step 5 failed with
 * `no project named "pimp-mtvivcxb-6jcb" after the import` — a message that
 * names the subject and nothing about the backend. Every Langflow write route
 * taking `DbSession` answers its 2xx **before** the transaction commits, so the
 * upload's `201` can precede the rows it describes; the question that message
 * cannot answer is whether those rows exist at all. Paired with
 * {@link describeFlowReadback} on the flow id the upload returned, the two reads
 * separate a closed window from a flow/project row divergence.
 *
 * **What the pair cannot do, measured rather than assumed** (`1.13.0.dev12`,
 * `session_scope` delayed 300 ms): while the window is still open BOTH reads
 * come back negative, 10 of 10 — indistinguishable from an import that never
 * committed. So "absent on the re-read too" is reported as exactly that and
 * never as the transient shape; the caller's doc carries the four-row table.
 *
 * Three properties are contractual, and all three are pinned in
 * `describe-project-listing.test.ts`:
 *
 * 1. **It never throws.** It runs on the branch where a test is already
 *    failing. A throw here would replace the real failure with its own — the
 *    same reasoning behind its two siblings and `deleteFlow`'s bare attribution
 *    `catch`.
 *
 * 2. **UNDECIDED is a real third outcome** (#1012 — an unevaluated result is
 *    unknown, not clean), covering a re-read that threw, one that did not answer
 *    `200`, and one whose body could not be parsed.
 *
 * 3. **A `200` whose body is not a project list is UNDECIDED, never "absent".**
 *    This guard is what the siblings do not need: they read a STATUS, this reads
 *    a COLLECTION, and `null` or `{"detail": "Not authenticated"}` both have a
 *    perfectly good answer of `undefined` to a `.find` — i.e. they would report
 *    the project as genuinely missing off a body that listed nothing at all.
 *    Same class of false verdict as a catalog snapshot normalising a
 *    `200`-with-no-categories into "every category vanished".
 *
 * Deliberately NOT declared through `apiCoverage`: the call only happens on the
 * failing branch, and the coverage gate FAILS a declaration the test never
 * issues. An undeclared request is tolerated, so this needs no declaration.
 *
 * @param request  A Playwright `APIRequestContext` (`page.request` or the `request` fixture).
 * @param name     The project name whose absence is in question.
 * @param options  Optional Playwright request options, e.g. `{ headers: { Authorization } }`.
 * @param note     Extra context from the caller, carried into the line verbatim.
 */
export async function describeProjectListing(
  request: APIRequestContext,
  name: string,
  options?: Parameters<APIRequestContext["get"]>[1],
  note?: string,
): Promise<string> {
  const suffix = note ? ` [${note}]` : "";
  const undecided = (what: string): string =>
    `re-read GET ${ROUTE} ${what}: UNDECIDED — the re-read says nothing either way${suffix}`;

  let response: Awaited<ReturnType<APIRequestContext["get"]>>;
  try {
    response = await request.get(ROUTE, options);
  } catch (error) {
    return undecided(`threw (${readFailureReason(error)})`);
  }

  const status = response.status();
  if (status !== 200) return undecided(`-> ${status}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return undecided(`-> 200 but the body could not be parsed (${readFailureReason(error)})`);
  }

  if (!Array.isArray(body)) {
    return undecided(`-> 200 but the body is not a project list (${describeShape(body)})`);
  }

  const listed = body.some(
    (row) =>
      row !== null && typeof row === "object" && (row as { name?: unknown }).name === name,
  );
  const size = `${body.length} project(s)`;

  return listed
    ? `re-read GET ${ROUTE} -> 200: "${name}" IS now listed (${size}) — ` +
        `it landed between the two reads${suffix}`
    : `re-read GET ${ROUTE} -> 200: "${name}" is still ABSENT (${size})${suffix}`;
}
