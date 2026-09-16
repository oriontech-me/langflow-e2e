// Unit tests for describeProjectListing (#1807 / LE-2598).
// Run with: npm run test:units
//
// The sibling of describeFlowReadback, for the one assertion in the projects
// family that fails on an ABSENCE rather than on a status: `api-projects-transfer`
// step 5 looks the imported project up by name in `GET /api/v1/projects/`, and
// `expect(imported).toBeTruthy() / Received: undefined` says nothing about why.
//
// Three properties carry the design and all three are asserted below.
//
// 1. It NEVER THROWS. It runs on the branch where an assertion is about to fail;
//    a throw here would replace the real failure with its own.
//
// 2. UNDECIDED is a real third outcome, never folded into either verdict (#1012).
//
// 3. A 200 whose body is NOT a project list is UNDECIDED, not "absent". This is
//    the guard the two siblings do not need: they read a STATUS, this one reads
//    a COLLECTION, so `{"detail": "Not authenticated"}` and `null` both have a
//    perfectly good `.find` answer of `undefined` — i.e. they would report the
//    project as genuinely missing off a body that never listed anything. Same
//    class of false verdict as `snapshotCatalog` normalising a 200-with-no-
//    categories into "every category vanished".
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { describeProjectListing } from "./describe-project-listing";

const NAME = "pimp-mtvivcxb-6jcb";

/** A request context whose GET answers `status` with `body`, recording the call. */
function fakeRequest(status: number, body: unknown) {
  const calls: Array<{ url: string; options: unknown }> = [];
  const request = {
    get: async (url: string, options: unknown) => {
      calls.push({ url, options });
      return {
        status: () => status,
        json: async () => {
          if (body === Symbol.for("unparseable")) throw new Error("Unexpected token < in JSON");
          return body;
        },
      };
    },
  } as unknown as APIRequestContext;
  return { request, calls };
}

/** A request context whose GET rejects — the backend is unreachable. */
function throwingRequest(message: string) {
  return {
    get: async () => {
      throw new Error(message);
    },
  } as unknown as APIRequestContext;
}

const rows = (...names: string[]) => names.map((name, i) => ({ id: `id-${i}`, name }));

test("a listing that now contains the name says it landed between the two reads", async () => {
  const { request } = fakeRequest(200, rows("other", NAME, "another"));
  const line = await describeProjectListing(request, NAME);
  assert.match(line, /200/);
  assert.ok(line.includes(NAME), "the line must name the project it looked for");
  assert.match(line, /is now listed/i);
  assert.match(line, /between the two reads/i);
  assert.match(line, /3 project/, "the size of the listing it read");
});

test("a listing that still lacks the name says so, and does not call it a window", async () => {
  const { request } = fakeRequest(200, rows("other", "another"));
  const line = await describeProjectListing(request, NAME);
  assert.match(line, /200/);
  assert.match(line, /still absent/i);
  assert.match(line, /2 project/);
  // The load-bearing half: "absent on the re-read too" must never be dressed up
  // as the transient shape — that is the reading that sends a triage after the
  // wrong defect, and under a still-open window it is the honest answer that
  // the reads were taken too close to the failure to tell.
  assert.doesNotMatch(line, /between the two reads/i);
  assert.doesNotMatch(line, /is now listed/i);
});

test("a non-200 re-read is UNDECIDED and claims neither verdict", async () => {
  const { request } = fakeRequest(503, null);
  const line = await describeProjectListing(request, NAME);
  assert.match(line, /503/);
  assert.match(line, /undecided/i);
  assert.doesNotMatch(line, /is now listed/i);
  assert.doesNotMatch(line, /still absent/i);
});

test("a 200 whose body is not a project list is UNDECIDED, never 'absent'", async () => {
  for (const body of [null, { detail: "Not authenticated" }, "a string", 7]) {
    const { request } = fakeRequest(200, body);
    const line = await describeProjectListing(request, NAME);
    assert.match(line, /undecided/i, `body ${JSON.stringify(body)}`);
    assert.doesNotMatch(line, /still absent/i, `body ${JSON.stringify(body)}`);
    assert.doesNotMatch(line, /is now listed/i, `body ${JSON.stringify(body)}`);
  }
});

test("a body that cannot be parsed is UNDECIDED, and the throw does not escape", async () => {
  const { request } = fakeRequest(200, Symbol.for("unparseable"));
  const line = await describeProjectListing(request, NAME);
  assert.match(line, /undecided/i);
  assert.match(line, /Unexpected token/);
  assert.doesNotMatch(line, /still absent/i);
  assert.doesNotMatch(line, /is now listed/i);
});

test("a re-read that throws is UNDECIDED, and the throw does not escape", async () => {
  const line = await describeProjectListing(throwingRequest("socket hang up"), NAME);
  assert.match(line, /undecided/i);
  assert.match(line, /socket hang up/);
  assert.doesNotMatch(line, /still absent/i);
  assert.doesNotMatch(line, /is now listed/i);
});

test("a thrown non-Error still yields a line rather than escaping", async () => {
  // `Error.message` is a plain own property typed `string`, so a thrown object
  // can carry anything there — and the coercion is what threw in #1432. This
  // helper must not become the one thing in a failing branch able to throw.
  const request = {
    get: async () => {
      throw { message: Symbol("nope") };
    },
  } as unknown as APIRequestContext;
  const line = await describeProjectListing(request, NAME);
  assert.match(line, /undecided/i);
});

test("it reads the collection route and forwards the caller's options", async () => {
  const { request, calls } = fakeRequest(200, rows(NAME));
  const headers = { Authorization: "Bearer t" };
  await describeProjectListing(request, NAME, { headers });
  assert.equal(calls.length, 1, "exactly one re-read request");
  assert.equal(calls[0].url, "/api/v1/projects/");
  assert.deepEqual(calls[0].options, { headers });
});

test("an extra note from the caller is carried into the line", async () => {
  const { request } = fakeRequest(200, rows("other"));
  const line = await describeProjectListing(request, NAME, undefined, "upload answered 201");
  assert.match(line, /upload answered 201/);
  assert.match(line, /still absent/i);
});
