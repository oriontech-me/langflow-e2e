// Behavioural test for the API-coverage declaration fixture (#1692).
//
// The pure halves are covered by `npm run test:units` — `api-coverage-policy.ts`
// for matching, `api-coverage.ts` for the recorder, the record content and the
// file write. What THIS pins is the half that only exists inside a real
// Playwright session and that no unit test can reach: the fixture's teardown
// deciding the fate of the test.
//
//   1. a declaration the test issues lets it pass;
//   2. an undeclared request does not fail it — the mechanism that keeps
//      incidental traffic out of the numerator without punishing a spec for the
//      calls its own setup makes;
//   3. a malformed declaration is refused where it is written;
//   4. a declaration the test never issues **FAILS the test**. That is the whole
//      reason the gauge is trustworthy: a declaration nobody verifies is a
//      comment, and a comment claiming coverage is how a gauge starts lying
//      (#1084);
//   5. and that failure writes **no** record, so the operation reads as
//      uncovered rather than credited by a red test.
//
// (4) is the one a print-only warning would have left unpinned. `test.fail()`
// reaches it without a nested-run harness, but only because the fixture branches
// on `testInfo.status === "passed"` rather than on `expectedStatus` — the same
// property `http-error-gate.spec.ts` depends on, and the one `flow-error-gate`
// had to record as a follow-up.
//
// NO TEST HERE DEPENDS ON A SIBLING, and that is deliberate. The first version
// read the record a previous test had written, which made those assertions
// serial-dependent — and a serial-dependent test fails in isolation even
// unmutated, so its force-fail records a failure the mutation did not cause
// (`ff-run` banks any failure). Record content moved to the unit tests, where it
// needs neither a browser nor an ordering.
//
// A tiny local server stands in for Langflow: no container, no provider key, no
// flow. The recorder only cares about the method and the pathname.
//
// WHY `@stable` — the same reasoning as `http-error-gate.spec.ts`, and load
// bearing for the same reason: `daily-stable.yml` selects with `--grep @stable`
// and is the only recurring lane, while `pr-validation.yml` caps the impacted set
// at 20 with `@stable` first and a `tests/fixtures/**` change resolves to every
// spec in the repo. An untagged guard here would sort below the cap and never
// run — the defect it exists to prevent, wearing the fix's clothes. It needs no
// QA-CHECKLIST bullet: `check-checklist-coverage.ts` and `stable-tests.ts` both
// scope to `tests/tests-automations/regression/`, outside this file's path.

import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { expect, test } from "./fixtures";
import { COVERAGE_DIR, type CoverageRecord } from "./api-coverage";

let server: http.Server;
let origin: string;

/** The title of the test in (4), used to assert its record does NOT exist. */
const UNFULFILLED_TITLE = "a declaration the test never issues fails it";

/** Every record currently on disk, for an absence assertion that needs no id. */
const readAllRecords = (): CoverageRecord[] => {
  let names: string[];
  try {
    names = fs.readdirSync(COVERAGE_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map(
    (n) =>
      JSON.parse(
        fs.readFileSync(path.join(COVERAGE_DIR, n), "utf8"),
      ) as CoverageRecord,
  );
};

test.beforeAll(async () => {
  // Clear this file's own leftovers before measuring an ABSENCE.
  //
  // Records accumulate across runs by design (the @destructive lane is a second
  // run and must add to the first). The cost lands exactly here: any run in which
  // the `test.fail()` test above passed — which is precisely what its force-fail
  // mutation makes it do — leaves a record for that title behind forever, and the
  // absence assertion then fails on residue instead of on behaviour. Found by the
  // FORCE_FAIL phase's own final green run.
  //
  // Scoped to the one title this file owns: never a directory wipe, which would
  // delete the coverage another spec just measured.
  try {
    for (const name of fs.readdirSync(COVERAGE_DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(COVERAGE_DIR, name);
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as CoverageRecord;
      if (record.title?.includes(UNFULFILLED_TITLE)) fs.rmSync(file);
    }
  } catch {
    // No directory yet is the normal first-run state, not a failure.
  }

  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test(
  "a declaration the test issues lets it pass",
  { tag: ["@stable", "@api"] },
  async ({ request, apiCoverage }) => {
    apiCoverage.declare([
      "GET /api/v2/files",
      "PUT /api/v2/files/{file_id}",
      "POST /api/v2/files/batch/",
    ]);

    const list = await request.get(`${origin}/api/v2/files`);
    expect(list.status()).toBe(200);
    // The rename carries a query string and the id is a path parameter: both
    // have to survive the keying, or the declaration is unmatchable.
    const renamed = await request.put(
      `${origin}/api/v2/files/abc-123?name=renamed`,
    );
    expect(renamed.status()).toBe(200);
    // The trailing slash is load-bearing on this one — measured: without it the
    // request lands on `/api/v2/files/{file_id}` and Langflow answers 405.
    const batch = await request.post(`${origin}/api/v2/files/batch/`, {
      data: ["abc-123"],
    });
    expect(batch.status()).toBe(200);
  },
);

test(
  "an undeclared request does not fail the test",
  { tag: ["@stable", "@api"] },
  async ({ request, apiCoverage }) => {
    apiCoverage.declare(["GET /api/v2/files"]);

    const declared = await request.get(`${origin}/api/v2/files`);
    expect(declared.status()).toBe(200);
    // Incidental traffic: issued, never declared, asserted nowhere. It must
    // neither fail this test nor earn coverage — a spec's own bearer setup emits
    // exactly this kind of call.
    const incidental = await request.get(`${origin}/api/v1/version`);
    expect(incidental.status()).toBe(200);
    const alsoIncidental = await request.delete(
      `${origin}/api/v2/files/abc-123`,
    );
    expect(alsoIncidental.status()).toBe(200);
  },
);

test(
  "a malformed declaration is refused where it is written",
  { tag: ["@stable", "@api"] },
  async ({ apiCoverage }) => {
    // Named at the declaration, not later as "declared and never called": the
    // difference between a 30-second fix and a debugging session.
    expect(() => apiCoverage.declare(["/api/v2/files"])).toThrow(/METHOD path/);
    expect(() => apiCoverage.declare(["get /api/v2/files"])).toThrow(
      /METHOD path|method/i,
    );
    expect(() => apiCoverage.declare([])).toThrow(/empty/i);
    // Nothing valid is declared on purpose: a refused declaration must leave the
    // list untouched, so this test has nothing to fulfil. Declaring a real
    // operation here without issuing it would fail this test on the very gate it
    // is checking — which is how the first version of this spec behaved, and the
    // clearest possible demonstration that the gate works.
  },
);

test(
  UNFULFILLED_TITLE,
  { tag: ["@stable", "@api"] },
  async ({ request, apiCoverage }) => {
    // EXPECTED TO FAIL: the fixture teardown throws because the second
    // declaration is never issued. `test.fail()` is what lets the assertion be
    // made from inside the test the teardown fails.
    test.fail();
    apiCoverage.declare([
      "GET /api/v2/files",
      "DELETE /api/v2/files/{file_id}",
    ]);
    const res = await request.get(`${origin}/api/v2/files`);
    expect(res.status()).toBe(200);
  },
);

test(
  "the failed verification leaves no record behind",
  { tag: ["@stable", "@api"] },
  async () => {
    // Crediting the operations a failed verification DID issue would let a red
    // test hold coverage. Under-reporting is the safe direction (#1012).
    //
    // Asserted by title over every record on disk rather than by test id, so
    // this needs nothing from the test above and holds when run alone.
    const titles = readAllRecords().map((r) => r.title);
    expect(titles.some((t) => t.includes(UNFULFILLED_TITLE))).toBe(false);
  },
);
