// Unit tests for the API-coverage recorder (#1692).
// Run with: npm run test:units
//
// The recorder is what makes a declaration verifiable: it wraps the test-scoped
// `APIRequestContext` so every call the spec issues is keyed and kept. A fake
// context is enough to pin all of it — no browser, no Langflow. What only exists
// in a real session (the fixture teardown failing the test) is pinned by
// `api-coverage-gate.spec.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildCoverageRecord,
  coverageTeardownError,
  installApiCoverage,
  writeCoverageRecord,
} from "./api-coverage";
import { makeTempDir } from "../../scripts/lib/tmp-dir.mjs";

/** Stands in for a test-scoped APIRequestContext. */
const fakeContext = () => {
  const calls: string[] = [];
  const make =
    (verb: string) =>
    async (url: string, options?: { method?: string }) => {
      calls.push(`${options?.method ?? verb} ${url}`);
      return { status: () => 200 };
    };
  return {
    calls,
    get: make("GET"),
    post: make("POST"),
    put: make("PUT"),
    patch: make("PATCH"),
    delete: make("DELETE"),
    head: make("HEAD"),
    fetch: make("GET"),
  };
};

test("installApiCoverage records every verb and still delegates", async () => {
  const ctx = fakeContext();
  const { coverage, recorded } = installApiCoverage(ctx as never);

  const res = await ctx.get("/api/v2/files");
  await ctx.post("/api/v2/files");
  await ctx.put("/api/v2/files/abc?name=x");
  await ctx.delete("/api/v2/files/abc");

  // Delegation is the load-bearing half: a recorder that swallowed the response
  // would break every spec it touched.
  assert.equal(res.status(), 200);
  assert.deepEqual(ctx.calls, [
    "GET /api/v2/files",
    "POST /api/v2/files",
    "PUT /api/v2/files/abc?name=x",
    "DELETE /api/v2/files/abc",
  ]);
  assert.deepEqual(recorded, [
    { method: "GET", pathname: "/api/v2/files" },
    { method: "POST", pathname: "/api/v2/files" },
    { method: "PUT", pathname: "/api/v2/files/abc" },
    { method: "DELETE", pathname: "/api/v2/files/abc" },
  ]);
  assert.equal(typeof coverage.declare, "function");
});

test("installApiCoverage reads the method out of fetch's options", async () => {
  // `request.fetch(url, { method })` is how a spec sends a DELETE with a body,
  // which is exactly what the batch operations need. Keying it as GET would make
  // the declaration unmatchable.
  const ctx = fakeContext();
  const { recorded } = installApiCoverage(ctx as never);
  await ctx.fetch("/api/v2/files/batch/", { method: "DELETE" });
  assert.deepEqual(recorded, [
    { method: "DELETE", pathname: "/api/v2/files/batch/" },
  ]);
});

test("installApiCoverage records a request that throws", async () => {
  // A connection error is still an attempt at the operation, and the alternative
  // is worse: the test fails on the request AND on an unfulfilled declaration,
  // with the second message burying the first.
  const ctx = {
    get: async () => {
      throw new Error("socket hang up");
    },
  };
  const { recorded } = installApiCoverage(ctx as never);
  await assert.rejects(() => (ctx as { get: (u: string) => Promise<unknown> }).get("/api/v2/files"));
  assert.deepEqual(recorded, [{ method: "GET", pathname: "/api/v2/files" }]);
});

test("declare accumulates across calls and rejects a malformed entry on the spot", () => {
  const ctx = fakeContext();
  const { coverage, declared } = installApiCoverage(ctx as never);
  coverage.declare(["GET /api/v2/files"]);
  coverage.declare(["POST /api/v2/files"]);
  assert.deepEqual(declared, ["GET /api/v2/files", "POST /api/v2/files"]);
  // Named where it is written, not later as "declared and never called".
  assert.throws(() => coverage.declare(["/api/v2/files"]), /METHOD path/);
  assert.throws(() => coverage.declare(["GET /api/v2/files"]), /twice|duplicate/i);
});

test("coverageTeardownError names the declarations that were never issued", () => {
  const error = coverageTeardownError(
    ["GET /api/v2/files", "DELETE /api/v2/files/{file_id}"],
    [{ method: "GET", pathname: "/api/v2/files" }],
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /DELETE \/api\/v2\/files\/\{file_id\}/);
  // The message has to say what to do: either the spec stopped driving the
  // operation, or the declaration was aspirational. Both are the author's call,
  // and neither is fixed by re-running.
  assert.match(error.message, /declar/i);
});

test("coverageTeardownError is null when nothing was declared or all was issued", () => {
  assert.equal(coverageTeardownError([], []), null);
  assert.equal(
    coverageTeardownError(
      ["GET /api/v2/files"],
      [{ method: "GET", pathname: "/api/v2/files/" }],
    ),
    null,
  );
});

test("buildCoverageRecord keeps only what the report needs", () => {
  const record = buildCoverageRecord(
    { file: "tests/api/files/x.spec.ts", title: "uploads a file", status: "passed" },
    ["GET /api/v2/files", "POST /api/v2/files"],
    [
      { method: "GET", pathname: "/api/v2/files" },
      { method: "GET", pathname: "/api/v1/version" },
    ],
  );
  // Credit is declaration-intersect-recorded: `/api/v1/version` was issued (the
  // spec's own bearer setup does), and it earns nothing.
  assert.deepEqual(record.covered, ["GET /api/v2/files"]);
  assert.deepEqual(record.declared, ["GET /api/v2/files", "POST /api/v2/files"]);
  assert.equal(record.file, "tests/api/files/x.spec.ts");
  assert.equal(record.title, "uploads a file");
  assert.equal(record.status, "passed");
});

test("buildCoverageRecord credits nothing from a test that did not pass", () => {
  // A failed test proves nothing about the contract it declared, so counting its
  // declarations would let a red spec hold coverage — the state #1012's rule
  // exists to keep out of the count.
  const record = buildCoverageRecord(
    { file: "x.spec.ts", title: "t", status: "failed" },
    ["GET /api/v2/files"],
    [{ method: "GET", pathname: "/api/v2/files" }],
  );
  assert.deepEqual(record.covered, []);
});

test("writeCoverageRecord persists the record, and writes nothing when nothing was declared", () => {
  // Record CONTENT lives here rather than in the behavioural gate spec: reading
  // a record written by a sibling test made those assertions serial-dependent,
  // and a serial-dependent test fails in isolation even unmutated — which turns
  // its force-fail into a false positive (the ff-run trap: it banks any
  // failure). What genuinely needs a Playwright session is the fixture FAILING
  // the test, and that is all the gate spec asserts now.
  const dir = makeTempDir("api-coverage-");
  const info = {
    testId: "abc123",
    titlePath: ["chromium", "suite", "a test"],
    status: "passed" as const,
    file: path.join(__dirname, "../tests-automations/x.spec.ts"),
  };
  writeCoverageRecord(
    info,
    ["GET /api/v2/files"],
    [{ method: "GET", pathname: "/api/v2/files" }],
    dir,
  );
  const written = JSON.parse(
    fs.readFileSync(path.join(dir, "abc123.json"), "utf8"),
  );
  assert.deepEqual(written.covered, ["GET /api/v2/files"]);
  assert.equal(written.title, "suite › a test");
  assert.match(written.file, /x\.spec\.ts$/);

  // Nothing declared means nothing to report — an empty record would show up in
  // the report as a spec file contributing zero, which is noise.
  writeCoverageRecord({ ...info, testId: "empty" }, [], [], dir);
  assert.equal(fs.existsSync(path.join(dir, "empty.json")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeCoverageRecord credits nothing for a test that did not pass", () => {
  const dir = makeTempDir("api-coverage-");
  writeCoverageRecord(
    {
      testId: "failed1",
      titlePath: ["chromium", "s", "t"],
      status: "failed",
      file: path.join(__dirname, "../tests-automations/y.spec.ts"),
    },
    ["GET /api/v2/files"],
    [{ method: "GET", pathname: "/api/v2/files" }],
    dir,
  );
  const written = JSON.parse(
    fs.readFileSync(path.join(dir, "failed1.json"), "utf8"),
  );
  assert.equal(written.status, "failed");
  assert.deepEqual(written.covered, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
