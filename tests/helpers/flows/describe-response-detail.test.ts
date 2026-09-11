// Unit tests for describeResponseDetail (#1777 / LE-2598).
// Run with: npm run test:units
//
// The helper exists because the 2026-09-09 daily's `api-flows-versions` failure
// printed `Expected: 200 / Received: 404` and nothing else, so the one string
// that splits the two candidate shapes -- `"Flow not found"` (the row was not
// visible) vs `"Not Found"` (the route did not resolve) -- was simply not
// recorded, and recovering it cost three dailies.
//
// It is the sibling of `describeFlowReadback` and carries the same two
// contractual properties, both asserted below.
//
// 1. It NEVER THROWS. It runs on the branch where an assertion is about to
//    fail; a throw here would replace the real failure with its own.
//
// 2. States it could not read are NAMED, never folded into a verdict (#1012).
//    "the body was empty", "the body could not be read" and "the body had no
//    detail field" are three different observations and route triage
//    differently.
//
// The read-rejects branch is not exotic, which is the measurement worth
// keeping: CLAUDE.md's #1432 entry records that Chromium does not retain a
// zero-length response body, so `response.text()` REJECTS for a bodyless
// response rather than resolving to `""`. A naive `await res.text()` in a
// failing branch therefore throws on exactly the responses this helper exists
// to describe.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIResponse } from "@playwright/test";
import { describeResponseDetail } from "./describe-response-detail";

/** A response whose `text()` resolves to `body`. */
function fakeResponse(body: string): APIResponse {
  return { text: async () => body } as unknown as APIResponse;
}

/** A response whose `text()` rejects — the body was never retained. */
function throwingResponse(thrown: unknown): APIResponse {
  return {
    text: async () => {
      throw thrown;
    },
  } as unknown as APIResponse;
}

test("a JSON body with a detail field is reported as that detail", async () => {
  const line = await describeResponseDetail(
    fakeResponse('{"detail":"Flow not found"}'),
  );
  assert.match(line, /detail/i);
  assert.match(line, /Flow not found/);
});

test("the two discriminating details are reported verbatim and do not collide", async () => {
  // This is the whole point of the helper: `"Flow not found"` is the row not
  // being visible (LE-2598's window), `"Not Found"` is FastAPI's unmatched
  // route. A description that normalised or truncated either would destroy the
  // discriminator -- and `"Not Found"` is a SUBSTRING of nothing here, so the
  // check is that each line carries its own and not the other's meaning.
  const visibility = await describeResponseDetail(
    fakeResponse('{"detail":"Flow not found"}'),
  );
  const routing = await describeResponseDetail(fakeResponse('{"detail":"Not Found"}'));
  assert.match(visibility, /Flow not found/);
  assert.match(routing, /Not Found/);
  assert.doesNotMatch(routing, /Flow not found/);
});

test("a JSON body without a detail field is carried as the body, not as a detail", async () => {
  const line = await describeResponseDetail(fakeResponse('{"entries":[],"max":50}'));
  assert.match(line, /entries/);
  // It must not claim to have found a `detail`: a triage grepping for the
  // discriminator would otherwise read the whole body as one.
  assert.doesNotMatch(line, /\bdetail\b/i);
});

test("a non-JSON body is carried verbatim rather than discarded", async () => {
  const line = await describeResponseDetail(fakeResponse("<html>502 upstream</html>"));
  assert.match(line, /502 upstream/);
  assert.doesNotMatch(line, /\bdetail\b/i);
});

test("a body that decodes to the empty string says so, and is not a read failure", async () => {
  const line = await describeResponseDetail(fakeResponse(""));
  assert.match(line, /empty/i);
  // Distinct from the branch below: an empty body was READ, an unavailable one
  // was not, and #1432 is the incident where collapsing the two hid the reason.
  assert.doesNotMatch(line, /unavailable|could not/i);
});

test("a read that rejects is reported as unavailable, with the reason, and does not throw", async () => {
  const line = await describeResponseDetail(
    throwingResponse(
      new Error(
        "response.text: Protocol error (Network.getResponseBody): No data found for resource with given identifier",
      ),
    ),
  );
  assert.match(line, /unavailable|could not/i);
  assert.match(line, /No data found for resource/);
  assert.doesNotMatch(line, /empty/i);
});

test("the reason is the first non-blank line of a multi-line throw", async () => {
  const line = await describeResponseDetail(
    throwingResponse(new Error("\n\nsocket hang up\n  at Object.<anonymous>")),
  );
  assert.match(line, /socket hang up/);
  assert.doesNotMatch(line, /at Object/);
});

test("a thrown value that is not an Error does not crash the helper", async () => {
  // `Error.message` is TYPED string but is a plain own property, so a thrown
  // object can carry a Symbol, a number or an object there. #1432 measured the
  // coercion blowing up as `TypeError: raw.split is not a function` out of an
  // async handler with no surrounding try. Here the throw would replace a real
  // assertion failure, which is the same class of damage.
  for (const thrown of [
    { message: Symbol("nope") },
    { message: 42 },
    { message: { nested: true } },
    "a bare string",
    null,
    undefined,
  ]) {
    const line = await describeResponseDetail(throwingResponse(thrown));
    assert.equal(typeof line, "string");
    assert.match(line, /unavailable|could not/i);
  }
});

test("a very long body is capped so it cannot swamp the assertion message", async () => {
  const line = await describeResponseDetail(fakeResponse("x".repeat(5000)));
  assert.ok(
    line.length < 1000,
    `the description must stay readable inside a failure message, got ${line.length} chars`,
  );
});

test("a long detail is still capped, and the cap is visible rather than silent", async () => {
  const line = await describeResponseDetail(
    fakeResponse(JSON.stringify({ detail: "y".repeat(5000) })),
  );
  assert.ok(line.length < 1000, `got ${line.length} chars`);
  // A truncation nobody can see reads as the backend's whole answer (#1012).
  assert.match(line, /…|\.\.\.|truncated/);
});
