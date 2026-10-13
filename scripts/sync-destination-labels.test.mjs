// Unit tests for scripts/sync-destination-labels.mjs. Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDead, planLabels } from "./sync-destination-labels.mjs";

const L = (name, color = "ededed", description = "") => ({ name, color, description });

test("dead labels are skipped, live ones are created", () => {
  const plan = planLabels(
    [L("area:mcp", "1d76db", "MCP"), L("migration-test"), L("provider-credentials-api"), L("weekly-failure")],
    [],
  );
  assert.deepEqual(plan.create, [{ name: "area:mcp", color: "1d76db", description: "MCP" }]);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.skipped, ["migration-test", "provider-credentials-api", "weekly-failure"]);
});

test("a drifted color or description is updated to the origin's", () => {
  const plan = planLabels(
    [L("qa-infra", "5319e7", "QA testing infrastructure"), L("bug", "d73a4a", "Something isn't working")],
    [L("qa-infra"), L("bug", "D73A4A", "Something isn't working")],
  );
  assert.deepEqual(plan.update, [{ name: "qa-infra", color: "5319e7", description: "QA testing infrastructure" }]);
  assert.deepEqual(plan.create, [], "color case alone is not drift");
});

test("labels only the destination has are left alone", () => {
  const plan = planLabels([], [L("routine-failure"), L("routine:migration")]);
  assert.deepEqual(plan, { create: [], update: [], skipped: [] });
});

test("an applied plan is empty on the next run", () => {
  const origin = [L("flaky", "fbca04", "Intermittent"), L("follow-up")];
  const first = planLabels(origin, []);
  assert.equal(first.create.length, 2);
  assert.deepEqual(planLabels(origin, first.create), { create: [], update: [], skipped: [] });
});

test("weekly-failure is dead but a label that only starts with it is not", () => {
  assert.equal(isDead("weekly-failure"), true);
  assert.equal(isDead("weekly-failure-report"), false);
  assert.equal(isDead("area:api"), false);
});
