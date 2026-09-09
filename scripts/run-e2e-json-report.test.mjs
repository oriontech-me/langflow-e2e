// STRUCTURAL, and structural guards pin a SPELLING rather than a behaviour
// (#1226: every regex added over a workflow's text was then shown to pass its
// own mutation). It is here because a silent revert would strand every consumer
// of results.json -- the measurement included; the
// behaviour is covered where it can be -- build-triage-table.test.mjs asserts on
// real report fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ACTION = fs.readFileSync(".github/actions/run-e2e/action.yml", "utf8");

test("the main run emits a JSON report to a file", () => {
  assert.match(ACTION, /--reporter=html,github,json/);
  // To a FILE. Without the output name Playwright writes the JSON to stdout,
  // which buries the run log and breaks any grep over it.
  assert.match(ACTION, /PLAYWRIGHT_JSON_OUTPUT_NAME:\s*results\.json/);
});

test("the destructive lane still reports github-only", () => {
  // It must not overwrite the HTML report the main run produced, and it must not
  // overwrite results.json either.
  assert.match(ACTION, /npx playwright test --pass-with-no-tests --reporter=github \\/);
});

test("results.json is uploaded", () => {
  assert.match(ACTION, /name: playwright-json-manual-\$\{\{ github\.run_id \}\}/);
  assert.match(ACTION, /path: results\.json/);
});
