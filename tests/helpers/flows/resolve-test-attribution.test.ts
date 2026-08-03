// Unit tests for the ambient attribution resolver (§1.1).
// Run with: npm run test:units
//
// This exists so attribution stops being a parameter 149 specs would each have to
// pass. `test.info()` is Playwright's own per-test metadata and is already used in
// this repo (run-flow.spec.ts:69) — but it THROWS outside a running test, and
// `deleteFlow` is called from helpers and from module scope as well as from hooks.
// So the contract here is: return the fields when they are available, return null
// when they are not, and never throw either way (§2.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTestAttribution } from "./resolve-test-attribution";

test("derives the leaf title and the testDir-relative file", () => {
  const result = resolveTestAttribution(() => ({
    title: "max_tokens=50 caps the response's output tokens",
    file: "/repo/tests/tests-automations/regression/core-functionality/llm-agents/agent-max-tokens.spec.ts",
    project: { testDir: "/repo/tests" },
  }));
  assert.deepEqual(result, {
    test: "max_tokens=50 caps the response's output tokens",
    // `tests-automations/…`, NOT `tests/tests-automations/…`. The run payload
    // reports the longer form and e2e_normalize_spec_path joins the two; matching
    // the payload here would break a join that works (Global Constraints).
    file: "tests-automations/regression/core-functionality/llm-agents/agent-max-tokens.spec.ts",
  });
});

test("returns null when there is no running test — test.info() throws there", () => {
  const result = resolveTestAttribution(() => {
    throw new Error("test.info() can only be called while test is running");
  });
  assert.equal(result, null);
});

test("returns null on a partial info object rather than emitting a broken field", () => {
  // A future Playwright version, or a fixture that builds its own info, could hand
  // back an object missing `project`. `path.relative(undefined, …)` throws — the
  // point of this case is that the throw never escapes.
  assert.equal(resolveTestAttribution(() => ({ title: "t", file: "/repo/x.spec.ts" } as never)), null);
  assert.equal(resolveTestAttribution(() => ({ file: "/repo/x.spec.ts", project: { testDir: "/repo" } } as never)), null);
  assert.equal(resolveTestAttribution(() => ({ title: "t", project: { testDir: "/repo" } } as never)), null);
  assert.equal(resolveTestAttribution(() => null as never), null);
});

test("returns null on an empty title — an unnamed row is worse than no row", () => {
  // An empty `test` would key a by_spec row on `file::""`, which reads as a real
  // measurement of a test nobody can find.
  assert.equal(
    resolveTestAttribution(() => ({ title: "", file: "/repo/x.spec.ts", project: { testDir: "/repo" } })),
    null,
  );
});
