// Unit tests for the API-coverage declaration policy (#1692).
// Run with: npm run test:units
//
// The policy decides one thing: did the spec actually issue the operation it
// declared it covers? Everything here is pure; the fixture wiring that feeds it
// lives in `api-coverage.ts` and is pinned behaviourally by
// `api-coverage-gate.spec.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeDeclarationDefect,
  matchesOperation,
  recordFromUrl,
  unfulfilledDeclarations,
} from "./api-coverage-policy";

// ---------------------------------------------------------------------------
// recordFromUrl — what a request contributes
// ---------------------------------------------------------------------------

test("recordFromUrl keeps the pathname and drops the query", () => {
  // The v2 rename is `PUT /api/v2/files/{file_id}?name=…`. Carrying the query
  // into the key would make the operation unmatchable.
  assert.deepEqual(
    recordFromUrl("put", "http://localhost:7860/api/v2/files/abc?name=renamed"),
    { method: "PUT", pathname: "/api/v2/files/abc" },
  );
});

test("recordFromUrl accepts a bare path, the way an APIRequestContext is called", () => {
  // Specs call `request.get("/api/v2/files")` against a baseURL, so the recorder
  // sees a relative path and must not need a parseable absolute URL.
  assert.deepEqual(recordFromUrl("GET", "/api/v2/files"), {
    method: "GET",
    pathname: "/api/v2/files",
  });
  assert.deepEqual(recordFromUrl("GET", "/api/v2/files?x=1"), {
    method: "GET",
    pathname: "/api/v2/files",
  });
});

test("recordFromUrl returns null for something that is not a request path", () => {
  assert.equal(recordFromUrl("GET", ""), null);
  assert.equal(recordFromUrl("GET", "not-a-url"), null);
});

// ---------------------------------------------------------------------------
// matchesOperation — a declaration against a request
// ---------------------------------------------------------------------------

test("matchesOperation requires the method and the exact path", () => {
  const req = { method: "GET", pathname: "/api/v2/files" };
  assert.equal(matchesOperation("GET /api/v2/files", req), true);
  assert.equal(matchesOperation("POST /api/v2/files", req), false);
  assert.equal(matchesOperation("GET /api/v2/files/batch/", req), false);
});

test("matchesOperation fills a {param} with exactly one segment", () => {
  const op = "GET /api/v2/files/{file_id}";
  assert.equal(
    matchesOperation(op, {
      method: "GET",
      pathname: "/api/v2/files/40dd6449-943c-495b-84eb-21b7d9f087a9",
    }),
    true,
  );
  // One segment, not zero and not two: `/files` is the list operation and
  // `/files/a/b` is a different route entirely.
  assert.equal(
    matchesOperation(op, { method: "GET", pathname: "/api/v2/files" }),
    false,
  );
  assert.equal(
    matchesOperation(op, { method: "GET", pathname: "/api/v2/files/a/b" }),
    false,
  );
});

test("matchesOperation fills two params independently", () => {
  const op = "DELETE /api/v1/files/delete/{flow_id}/{file_name}";
  assert.equal(
    matchesOperation(op, {
      method: "DELETE",
      pathname: "/api/v1/files/delete/4fac8111/2026-09-03_12-28-16_probe.txt",
    }),
    true,
  );
  assert.equal(
    matchesOperation(op, {
      method: "DELETE",
      pathname: "/api/v1/files/delete/4fac8111",
    }),
    false,
  );
});

test("a slash-less declaration accepts either spelling — the router registered both", () => {
  // `/api/v2/files` and `/api/v2/files/` are both registered and both answer
  // directly, so `normalizeRouteTable` collapses them onto the slash-less key.
  // Matching has to honour the same collapse or the canonical key would be
  // uncreditable by half the calls that legitimately hit it.
  assert.equal(
    matchesOperation("GET /api/v2/files", {
      method: "GET",
      pathname: "/api/v2/files/",
    }),
    true,
  );
});

test("a declaration that ENDS in a slash requires the slash — measured", () => {
  // `POST /api/v2/files/batch/` is registered ONLY with the slash. Without it the
  // request falls through to `/api/v2/files/{file_id}` and answers 405 (422
  // `uuid_parsing` on DELETE). Crediting the slash-less call would mark the batch
  // operation covered by a request that never reached it.
  assert.equal(
    matchesOperation("POST /api/v2/files/batch/", {
      method: "POST",
      pathname: "/api/v2/files/batch/",
    }),
    true,
  );
  assert.equal(
    matchesOperation("POST /api/v2/files/batch/", {
      method: "POST",
      pathname: "/api/v2/files/batch",
    }),
    false,
  );
});

test("matchesOperation is case-insensitive on the recorded method only", () => {
  assert.equal(
    matchesOperation("GET /api/v1/version", {
      method: "get",
      pathname: "/api/v1/version",
    }),
    true,
  );
});

test("matchesOperation never matches on a malformed declaration", () => {
  for (const bad of ["", "GET", "/api/v2/files", "GET  ", "GET api/v2/files"]) {
    assert.equal(
      matchesOperation(bad, { method: "GET", pathname: "/api/v2/files" }),
      false,
      bad,
    );
  }
});

// ---------------------------------------------------------------------------
// describeDeclarationDefect — catching a typo'd declaration at its source
// ---------------------------------------------------------------------------

test("describeDeclarationDefect rejects a declaration that can never match", () => {
  // A typo'd declaration would otherwise fail the test with "you declared this
  // and never called it", pointing the reader at the spec body instead of at the
  // string. Naming the string is the difference between a 30-second fix and a
  // debugging session.
  assert.match(String(describeDeclarationDefect(["/api/v2/files"])), /METHOD path/);
  assert.match(String(describeDeclarationDefect(["GET api/v2/files"])), /leading \//);
  assert.match(String(describeDeclarationDefect(["FETCH /api/v2/files"])), /method/i);
  assert.match(String(describeDeclarationDefect([])), /empty/i);
  assert.equal(
    describeDeclarationDefect(["GET /api/v2/files", "POST /api/v2/files/batch/"]),
    null,
  );
});

test("describeDeclarationDefect rejects a duplicate declaration", () => {
  // Two identical entries mean one of them can never be the reason the test
  // exists, and the union that credits coverage would count it once anyway.
  assert.match(
    String(describeDeclarationDefect(["GET /api/v2/files", "GET /api/v2/files"])),
    /duplicate/i,
  );
});

// ---------------------------------------------------------------------------
// unfulfilledDeclarations — the load-bearing half
// ---------------------------------------------------------------------------

test("unfulfilledDeclarations names what was declared and never issued", () => {
  const missing = unfulfilledDeclarations(
    ["GET /api/v2/files", "DELETE /api/v2/files/{file_id}"],
    [{ method: "GET", pathname: "/api/v2/files" }],
  );
  assert.deepEqual(missing, ["DELETE /api/v2/files/{file_id}"]);
});

test("unfulfilledDeclarations is empty when every declaration was issued", () => {
  assert.deepEqual(
    unfulfilledDeclarations(
      ["POST /api/v2/files", "GET /api/v2/files/{file_id}"],
      [
        { method: "POST", pathname: "/api/v2/files" },
        { method: "GET", pathname: "/api/v2/files/abc" },
      ],
    ),
    [],
  );
});

test("an undeclared request earns no coverage", () => {
  // Credit is declaration-intersect-recorded. This is what keeps incidental
  // traffic out of the count: a spec that happens to hit an endpoint has not
  // asserted its contract, which is the definition of covered this gauge uses.
  assert.deepEqual(
    unfulfilledDeclarations(
      ["GET /api/v2/files"],
      [
        { method: "GET", pathname: "/api/v2/files" },
        { method: "GET", pathname: "/api/v1/version" },
      ],
    ),
    [],
  );
});
