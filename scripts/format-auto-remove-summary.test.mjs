// Unit tests for the auto-removal issue-body formatter (issue #1031).
// Run with: npm run test:scripts
//
// This block IS the daily umbrella's `@stable` section. Its job since #1031 is
// to keep two things apart that a wedged run mashes together: failures the run
// can attribute to their spec, and failures that only describe a dead backend.
// Getting that wrong is expensive in a specific way — on run 30374528125 triage
// read 14 collateral specs as 14 broken specs and paid a full cycle for it.
//
// The script is a plain stdout filter, so drive it as one rather than importing:
// the argv-in/stdout-out contract is what `.github/actions/auto-remove-stable`
// actually uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "format-auto-remove-summary.mjs");

function render(result) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-1031-"));
  try {
    const file = path.join(dir, "auto-remove-result.json");
    fs.writeFileSync(file, JSON.stringify(result));
    return execFileSync(process.execPath, [SCRIPT, file], { encoding: "utf-8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const collateral = (title) => ({
  file: `tests/x/${title}.spec.ts`,
  title,
  line: 4,
  signature: "api-request-timeout",
  why: "a direct REST call to the backend never answered",
  error: "TimeoutError: apiRequestContext.get: Timeout 20000ms exceeded.",
});

test("an all-collateral run says so instead of reading as a clean triage", () => {
  const md = render({
    status: "none",
    threshold: 5,
    hardFailures: 3,
    attributableFailures: 0,
    removed: [],
    skipped: [],
    exempt: [collateral("a"), collateral("b"), collateral("c")],
    backendWedged: "true",
  });

  assert.match(md, /3 hard failure\(s\) are NOT attributable/);
  assert.match(md, /all 3 hard failure\(s\) were non-attributable/);
  // The pre-#1031 wording alone would have read as "nothing to see here".
  assert.doesNotMatch(md, /^No per-test `@stable` hard failures were auto-removed\./m);
  assert.match(md, /Do not open a per-spec issue for these/);
  assert.match(md, /measured a mid-run outage/);
});

test("collateral is rendered BEFORE the removals, and the two never merge", () => {
  const md = render({
    status: "removed",
    threshold: 5,
    hardFailures: 2,
    attributableFailures: 1,
    removed: [{ file: "tests/x/broken.spec.ts", title: "broken", line: 9, soleTag: false }],
    skipped: [],
    exempt: [collateral("wedged")],
    backendWedged: "true",
  });

  assert.ok(md.indexOf("NOT attributable") < md.indexOf("Auto-removed"), md);
  assert.match(md, /Auto-removed `@stable`\*\* from 1 hard-failing test\(s\)/);
  assert.match(md, /- `tests\/x\/wedged\.spec\.ts` — wedged _\(api-request-timeout/);
  assert.match(md, /- `tests\/x\/broken\.spec\.ts` — broken/);
});

test("the liveness verdict only changes the wording, never the claim", () => {
  const base = {
    status: "none",
    threshold: 5,
    hardFailures: 1,
    attributableFailures: 0,
    removed: [],
    skipped: [],
    exempt: [collateral("a")],
  };

  assert.match(render({ ...base, backendWedged: "false" }), /measured \*\*no\*\* outage/);
  assert.match(render({ ...base, backendWedged: "" }), /not measured/);
  // Whatever the verdict, the exemption itself is stated the same way.
  for (const backendWedged of ["true", "false", ""]) {
    assert.match(render({ ...base, backendWedged }), /`@stable` was \*\*left in place\*\*/);
  }
});

test("a guard-tripped run still names its collateral and explains the count", () => {
  // The early return in the script must not cost the labelling: the wide wedge
  // is precisely the run whose issue body has to lead with the cause.
  const md = render({
    status: "guard_tripped",
    threshold: 5,
    hardFailures: 19,
    attributableFailures: 5,
    removed: [],
    skipped: [],
    exempt: Array.from({ length: 14 }, (_, i) => collateral(`c${i}`)),
    backendWedged: "true",
  });

  assert.match(md, /14 hard failure\(s\) are NOT attributable/);
  assert.match(md, /Mass-failure guard tripped/);
  assert.match(md, /counts \*\*every\*\* hard failure, collateral included \(14 of 19/);
  assert.match(md, /the 5 attributable/);
});

test("a run with no collateral renders exactly the pre-#1031 block", () => {
  const md = render({
    status: "removed",
    threshold: 5,
    hardFailures: 1,
    attributableFailures: 1,
    removed: [{ file: "tests/x/broken.spec.ts", title: "broken", line: 9, soleTag: true }],
    skipped: [],
    exempt: [],
    backendWedged: "false",
  });

  assert.doesNotMatch(md, /NOT attributable/);
  assert.match(md, /^🔻 \*\*Auto-removed/);
  assert.match(md, /the array was left empty, please review/);
});

test("output produced before #1031 still renders", () => {
  // The action writes and reads the JSON within one job, so this is only a
  // replay concern — but a formatter that throws on an older artifact would
  // take the umbrella issue's whole `@stable` section with it.
  const md = render({
    status: "guard_tripped",
    threshold: 5,
    hardFailures: 6,
    removed: [],
    skipped: [{ file: "tests/x/ghost.spec.ts", title: "t1", line: 4, reason: "spec file not found" }],
  });

  assert.match(md, /Mass-failure guard tripped/);
  assert.doesNotMatch(md, /NOT attributable/);
  assert.match(md, /Skipped 1/);
});
