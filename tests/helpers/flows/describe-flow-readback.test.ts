// Unit tests for describeFlowReadback (#1759 / LE-2552).
// Run with: npm run test:units
//
// The helper exists because the three api-flows-crud failures on the 2026-09-08
// daily named nothing. `expect(found).toBeDefined() / Received: undefined` does
// not say whether the row is missing from the DATABASE or merely missing from
// the LIST, and those are two different defects. The helper reads the row by id
// and turns that into one line that goes into the assertion message.
//
// Two properties carry the whole design and both are asserted below.
//
// 1. It NEVER THROWS. It runs on the branch where an assertion is about to
//    fail, so a throw here would replace the real failure with its own and the
//    original signal would be gone -- the same reasoning that wraps
//    `recordTokenAttribution` inside `deleteFlow` (delete-flow.ts §2.3).
//
// 2. It has THREE outcomes, not two. A readback that cannot be performed is
//    UNDECIDED and says so; it is never folded into either verdict (#1012 --
//    an unevaluated result is unknown, not clean). Getting this wrong is worse
//    than having no helper: a triage reading "the row is NOT there" off a 503
//    would chase a phantom.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { describeFlowReadback } from "./describe-flow-readback";

const ID = "3fa4f2b2-31d0-408d-a64d-c8ee30772add";

/** A request context whose GET answers `status`, recording what it was asked. */
function fakeRequest(status: number) {
  const calls: Array<{ url: string; options: unknown }> = [];
  const request = {
    get: async (url: string, options: unknown) => {
      calls.push({ url, options });
      return { status: () => status };
    },
  } as unknown as APIRequestContext;
  return { request, calls };
}

/** A request context whose GET rejects — the backend is unreachable. */
function throwingRequest(message: string) {
  const request = {
    get: async () => {
      throw new Error(message);
    },
  } as unknown as APIRequestContext;
  return request;
}

test("a 200 readback states the row exists and nothing more", async () => {
  const { request } = fakeRequest(200);
  const line = await describeFlowReadback(request, ID);
  assert.match(line, /200/);
  assert.match(line, /exists/i);
  assert.ok(line.includes(ID), "the line must name the id it read");
  // The helper must NOT infer which caller-side read failed. It is called from
  // a list assertion AND from a raw-DELETE assertion, and in the second there
  // is no list at all -- an earlier version of this line ended "so the list is
  // what failed to return it" and printed exactly that under the DELETE test,
  // pointing a triage at a read that never happened. The caller supplies the
  // context through `note`; the helper reports only what it observed.
  assert.doesNotMatch(line, /\blist\b/i);
});

test("a 404 readback says the row is absent", async () => {
  const { request } = fakeRequest(404);
  const line = await describeFlowReadback(request, ID);
  assert.match(line, /404/);
  assert.match(line, /absent|not there|does not exist/i);
});

test("any other status is UNDECIDED and claims neither verdict", async () => {
  const { request } = fakeRequest(503);
  const line = await describeFlowReadback(request, ID);
  assert.match(line, /503/);
  assert.match(line, /undecided/i);
  // The load-bearing half: a readback that did not answer must not be read as
  // either outcome. Asserting only the presence of "undecided" would pass on a
  // line that ALSO claimed the row exists.
  assert.doesNotMatch(line, /exists/i);
  assert.doesNotMatch(line, /absent|not there|does not exist/i);
});

test("a readback that throws is UNDECIDED, and the throw does not escape", async () => {
  const request = throwingRequest("socket hang up");
  const line = await describeFlowReadback(request, ID);
  assert.match(line, /undecided/i);
  assert.match(line, /socket hang up/);
  assert.doesNotMatch(line, /exists/i);
  assert.doesNotMatch(line, /absent|not there|does not exist/i);
});

test("it reads the by-id route and forwards the caller's options", async () => {
  const { request, calls } = fakeRequest(200);
  const headers = { Authorization: "Bearer t" };
  await describeFlowReadback(request, ID, { headers });
  assert.equal(calls.length, 1, "exactly one readback request");
  assert.equal(calls[0].url, `/api/v1/flows/${ID}`);
  assert.deepEqual(calls[0].options, { headers });
});

test("an extra note from the caller is carried into the line", async () => {
  const { request } = fakeRequest(404);
  const line = await describeFlowReadback(request, ID, undefined, "list had 31 flows");
  assert.match(line, /list had 31 flows/);
  assert.match(line, /404/);
});
