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
    // The one that sat on the edge unseen, behind a named constant.
    "const CREDENTIAL_SETTLE_INTERVALS_MS = [250, 500, 1000, 2000];",
    "const retryIntervals = [2000];",
  ]) {
    const found = findKeepAliveEdgeIntervals(source);
    assert.equal(found.length, 1, source);
    assert.equal(found[0].value, 2000, source);
  }
});

test("the band covers the risk below the edge, where processing time lands", () => {
  // The server sees interval + client processing, so a 1500 is one heavy parse away
  // from 2000; above the edge the gap only grows away from it.
  for (const value of [1001, 1250, 1500, 1800, 1999, 2000, 2050, 2099]) {
    assert.equal(findKeepAliveEdgeIntervals(`intervals: [${value}]`).length, 1, String(value));
  }
  for (const value of [1000, 2100, 3000]) {
    assert.deepEqual(findKeepAliveEdgeIntervals(`intervals: [${value}]`), [], String(value));
  }
});

test("an element it cannot evaluate is reported, never read as clean", () => {
  for (const element of ["2 * 1000", "TWO_SECONDS", "2e3", "base[0]"]) {
    const found = findKeepAliveEdgeIntervals(`intervals: [500, ${element}]`);
    assert.equal(found.length, 1, element);
    assert.equal(found[0].value, null, element);
    assert.equal(found[0].element, element);
  }
});

test("a nested bracket does not end the array early", () => {
  // `[^\]]*` stopped at the first `]` and lost the 2000 after it.
  const found = findKeepAliveEdgeIntervals("intervals: [base[0], 2000]");
  assert.deepEqual(
    found.map((v) => v.value),
    [null, 2000],
  );
});

test("parentheses and braces nest like brackets: their commas do not split elements", () => {
  // Proven for `[` above; without this, splitting on every comma, or letting only
  // brackets nest, passed every test.
  const found = findKeepAliveEdgeIntervals("intervals: [Math.max(500, 1000), { a: 1, b: 2 }, (2000)]");
  assert.deepEqual(
    found.map((v) => v.element),
    ["Math.max(500, 1000)", "{ a: 1, b: 2 }", "(2000)"],
  );
});

test("detector leaves the clean cadences alone", () => {
  for (const source of [
    "intervals: [500, 1000]",
    "intervals: [300, 700, 1000]",
    "intervals: [500, 1000, 3000]",
    "intervals: [500, 1_000, 3_000]",
    "intervals: [3000]",
    "intervals: [2500]",
    "intervals: POLL_INTERVALS",
    "intervals?: number[];",
    "const timeout = 2000;",
    "const auto_saving_interval = [2000];",
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
      (v) =>
        `${relative(root, file)}:${v.line} — ` +
        (v.value === null ? `\`${v.element}\` is not a whole-number literal` : `${v.value} ms`) +
        ` in \`${v.text}\``,
    ),
  );
  assert.deepEqual(
    offenders,
    [],
    "poll intervals in (1000, 2100) ms reuse a keep-alive socket at the backend's 2 s " +
      "close once the client's processing is added (#2236, #2243), and an interval this " +
      "guard cannot evaluate is not clean. Use [500, 1000] — or ≥3000 ms where the " +
      "cadence must back off — and wrap API reads in `retryOnDroppedConnection`:\n" +
      offenders.join("\n"),
  );
});
