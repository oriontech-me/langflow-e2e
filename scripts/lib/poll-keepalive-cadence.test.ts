// Guard: no poll under tests/ waits on the backend's 2 s keep-alive edge (#2243).
// Run with: npm run test:units
//
// The detector, its band and the reasoning behind both are in
// poll-keepalive-cadence.ts. It lives in scripts/lib/ rather than beside a helper
// because it covers no one helper: it scans every spec, page and helper under tests/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { findKeepAliveEdgeIntervals, walk } from "./poll-keepalive-cadence";

test("detector flags the shapes the repo actually used", () => {
  for (const source of [
    "{ timeout: 20000, intervals: [500, 1000, 2000] }",
    "{ timeout: 30000, intervals: [500, 500, 1000, 1000, 2000] }",
    "{ timeout: 60000, intervals: [2000] }",
    "{ timeout: 30000, intervals: [1000, 2000, 3000, 5000] }",
    "{\n  timeout: 20000,\n  intervals: [\n    200,\n    2000,\n  ],\n}",
    "{ intervals: [2_000] }",
  ]) {
    const found = findKeepAliveEdgeIntervals(source);
    assert.equal(found.length, 1, source);
    assert.equal(found[0].value, 2000, source);
  }
});

test("detector covers the whole band, not only 2000", () => {
  // Pinning only the observed spelling would leave a 1800 or a 2200 — equally
  // close to the edge on a loaded runner — passing.
  for (const value of [1501, 1800, 1999, 2001, 2200, 2499]) {
    assert.equal(findKeepAliveEdgeIntervals(`intervals: [${value}]`).length, 1, String(value));
  }
});

test("detector leaves the clean cadences alone", () => {
  for (const source of [
    "intervals: [500, 1000]",
    "intervals: [500, 1000, 1500]",
    "intervals: [1000, 1500, 3000, 5000]",
    "intervals: [3000]",
    "intervals: [2500]",
    "intervals: POLL_INTERVALS",
    "const timeout = 2000;",
  ]) {
    assert.deepEqual(findKeepAliveEdgeIntervals(source), [], source);
  }
});

test("no poll under tests/ sits on the 2 s keep-alive edge", () => {
  const root = join(__dirname, "..", "..", "tests");
  const files = walk(root);
  // A walk that missed the specs would pass vacuously — and a floor on the file
  // COUNT alone does not catch that: `tests/helpers` by itself holds well over a
  // hundred files, while every offender ever found lived under `tests-automations/`.
  // So the floor is on the specs specifically.
  const specs = files.filter((f) => f.includes(`${sep}tests-automations${sep}`) && f.endsWith(".spec.ts"));
  assert.ok(specs.length > 200, `expected to scan the spec suite, found ${specs.length} spec file(s)`);
  const offenders = files.flatMap((file) =>
    findKeepAliveEdgeIntervals(readFileSync(file, "utf8")).map(
      (v) => `${relative(root, file)}:${v.line} — ${v.value} ms in \`${v.text}\``,
    ),
  );
  assert.deepEqual(
    offenders,
    [],
    "poll intervals in (1500, 2500) ms reuse a keep-alive socket at the backend's 2 s " +
      "close (#2236, #2243). Use [500, 1000] — or 1500 / ≥3000 ms where the cadence " +
      "must back off — and wrap API reads in `retryOnDroppedConnection`:\n" +
      offenders.join("\n"),
  );
});
