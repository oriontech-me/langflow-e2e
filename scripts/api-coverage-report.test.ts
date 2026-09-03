// Unit tests for the API coverage report (#1692).
// Run with: npm run test:units
//
// The report answers one question — how much of the in-scope OSS API is covered
// by the definition in `docs/api/api-surface-coverage-gauge.md` — and it has to
// answer it in a way a reader can act on. #1226's lesson applies directly: a
// guard that pins a spelling does not pin a behaviour, so these assert on the
// rendered output, not on the shape of the code that renders it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateCoverage,
  dropStaleRecords,
  formatCoverageReport,
} from "./api-coverage-report";
import type { ApiSurfaceBaseline } from "../tests/helpers/other/api-surface-drift";

const BASELINE: ApiSurfaceBaseline = {
  version: "1.13.0.dev0",
  exclusions: [
    { prefix: "/api/v1/store/", reason: "external service, unreachable in CI" },
  ],
  operations: [
    { method: "GET", path: "/api/v2/files", inSchema: true },
    { method: "POST", path: "/api/v2/files", inSchema: true },
    { method: "DELETE", path: "/api/v2/files/{file_id}", inSchema: true },
    { method: "POST", path: "/api/v2/files/batch/", inSchema: true },
    { method: "GET", path: "/api/v1/version", inSchema: true },
    { method: "GET", path: "/api/v1/store/tags", inSchema: false },
  ],
};

const record = (covered: string[], declared = covered) => ({
  file: "tests/tests-automations/regression/api/files/api-files-v2-store.spec.ts",
  title: "t",
  status: "passed",
  declared,
  covered,
});

test("aggregateCoverage counts the in-scope surface, not the whole table", () => {
  const result = aggregateCoverage(BASELINE, [record(["GET /api/v2/files"])]);
  // 6 operations, 1 excluded.
  assert.equal(result.inScope, 5);
  assert.equal(result.covered, 1);
  assert.equal(result.excludedCount, 1);
});

test("aggregateCoverage names every uncovered operation", () => {
  const result = aggregateCoverage(BASELINE, [record(["GET /api/v2/files"])]);
  assert.deepEqual(result.uncovered, [
    "DELETE /api/v2/files/{file_id}",
    "GET /api/v1/version",
    "POST /api/v2/files",
    "POST /api/v2/files/batch/",
  ]);
});

test("aggregateCoverage groups by family and orders by what is left to do", () => {
  const result = aggregateCoverage(BASELINE, [
    record(["GET /api/v2/files", "POST /api/v2/files"]),
  ]);
  assert.deepEqual(
    result.families.map((f) => [f.family, f.covered, f.total]),
    [
      ["/api/v2/files", 2, 4],
      ["/api/v1/version", 0, 1],
    ],
  );
});

test("aggregateCoverage de-duplicates an operation two tests both cover", () => {
  const result = aggregateCoverage(BASELINE, [
    record(["GET /api/v2/files"]),
    record(["GET /api/v2/files", "POST /api/v2/files"]),
  ]);
  assert.equal(result.covered, 2);
});

test("aggregateCoverage separates a declaration that is out of scope from one that is not in the surface", () => {
  // Both are author errors, and they need different fixes: the first means the
  // exclusion list and the spec disagree, the second means a typo or a route
  // that upstream removed. Reporting them as one line would send the reader to
  // the wrong place.
  const result = aggregateCoverage(BASELINE, [
    record(["GET /api/v1/store/tags", "GET /api/v9/nope"]),
  ]);
  assert.deepEqual(result.declaredOutOfScope, ["GET /api/v1/store/tags"]);
  assert.deepEqual(result.declaredNotInSurface, ["GET /api/v9/nope"]);
  // Neither earns coverage.
  assert.equal(result.covered, 0);
});

test("aggregateCoverage ignores a record whose test did not pass", () => {
  const result = aggregateCoverage(BASELINE, [
    { ...record(["GET /api/v2/files"]), status: "failed", covered: [] },
  ]);
  assert.equal(result.covered, 0);
});

test("aggregateCoverage refuses an unusable baseline instead of reporting 0/0", () => {
  // A 0/0 report reads as "nothing to do" — the false-clean verdict the whole
  // gauge exists to prevent (#1012).
  assert.throws(() => aggregateCoverage({} as never, []), /baseline/i);
});

// ---------------------------------------------------------------------------
// formatCoverageReport — what the reader actually sees
// ---------------------------------------------------------------------------

test("the report leads with the counts, before any caveat", () => {
  // #1226: the cap's dropped list was rendered above the figure a reviewer opens
  // the summary for, which answered the issue in letter only.
  const out = formatCoverageReport(
    aggregateCoverage(BASELINE, [record(["GET /api/v2/files"])]),
  );
  const lines = out.split("\n").filter((l) => l.trim() !== "");
  assert.match(lines[0], /1\s*\/\s*5/);
  const countsAt = lines.findIndex((l) => /\/\s*5/.test(l));
  const uncoveredAt = lines.findIndex((l) => /uncovered/i.test(l));
  assert.ok(countsAt < uncoveredAt, out);
});

test("the report names the uncovered operations rather than only counting them", () => {
  const out = formatCoverageReport(
    aggregateCoverage(BASELINE, [record(["GET /api/v2/files"])]),
  );
  assert.match(out, /POST \/api\/v2\/files\/batch\//);
  assert.match(out, /DELETE \/api\/v2\/files\/\{file_id\}/);
});

test("the report prints each exclusion with its reason", () => {
  // An exclusion nobody can see is an exclusion nobody can challenge.
  const out = formatCoverageReport(aggregateCoverage(BASELINE, []));
  assert.match(out, /\/api\/v1\/store\//);
  assert.match(out, /unreachable in CI/);
});

test("the report says when it saw no records at all", () => {
  // Zero records is the shape of a run that never executed an @api spec — a
  // 0/199 that means "unmeasured", not "uncovered", and saying so is the
  // difference between the two.
  const out = formatCoverageReport(aggregateCoverage(BASELINE, []));
  assert.match(out, /no per-test coverage record/i);
});

test("the report surfaces a bad declaration where the reader will act on it", () => {
  const out = formatCoverageReport(
    aggregateCoverage(BASELINE, [
      record(["GET /api/v1/store/tags", "GET /api/v9/nope"]),
    ]),
  );
  assert.match(out, /out of scope/i);
  assert.match(out, /not in the surface/i);
  assert.match(out, /GET \/api\/v9\/nope/);
});

test("a record from outside the regression suite earns no coverage", () => {
  // Found by running the report for the first time: `tests/fixtures/
  // api-coverage-gate.spec.ts` declares real operation keys and issues them
  // against a LOCAL STUB SERVER, so it credited 3 operations while asserting
  // nothing about Langflow. Coverage comes from the regression suite; a fixture
  // gate spec is a self-test of the harness, and the harness cannot cover the
  // product.
  const result = aggregateCoverage(BASELINE, [
    {
      ...record(["GET /api/v2/files"]),
      file: "tests/fixtures/api-coverage-gate.spec.ts",
    },
  ]);
  assert.equal(result.covered, 0);
  // And it is not reported as a bad declaration either — the declaration is
  // legitimate, it just is not evidence about the product.
  assert.deepEqual(result.declaredOutOfScope, []);
  assert.deepEqual(result.declaredNotInSurface, []);
  assert.equal(result.recordCount, 0);
});

test("dropStaleRecords removes a record whose spec file no longer exists", () => {
  // Records now survive between runs — they have to, because Playwright wipes
  // its own output directory at the start of every run and the @destructive lane
  // is by definition a SECOND run: with the records under `test-results/`, the
  // destructive pass deleted the normal pass's records and the report read
  // 3/204 instead of 15. Surviving records need the opposite guard: a test that
  // was renamed or deleted must stop holding coverage.
  const { kept, dropped } = dropStaleRecords(
    [
      { ...record(["GET /api/v2/files"]), file: "package.json" },
      { ...record(["POST /api/v2/files"]), file: "tests/gone/never.spec.ts" },
    ],
    (p) => p === "package.json",
  );
  assert.equal(kept.length, 1);
  assert.deepEqual(dropped, ["tests/gone/never.spec.ts"]);
});

test("the report names the stale records it dropped", () => {
  // Silently dropping them would make the number fall with no explanation — the
  // shape of report #1012 forbids.
  const out = formatCoverageReport({
    ...aggregateCoverage(BASELINE, [record(["GET /api/v2/files"])]),
    staleDropped: ["tests/gone/never.spec.ts"],
  });
  assert.match(out, /stale/i);
  assert.match(out, /tests\/gone\/never\.spec\.ts/);
});
