// Adoption guard for LANGFLOW_A2A_ENABLED (issue #1240).
// Run with: npm run test:scripts
//
// What this protects, and why it cannot be trusted to review:
//
// A2A ships OFF by default (`lfx` settings `a2a_enabled=False`) and its router is
// ALWAYS mounted — a per-request guard returns 404 for every `/api/v1/a2a/*`
// route while the flag is off, deliberately making a disabled server
// indistinguishable from an unmounted one (`langflow/api/router.py`). The
// consequence for this suite is that a lane which loses the flag does not go red:
// the `core-functionality/a2a/` specs keep running and assert against a surface
// that answers 404 everywhere. That is the same silent-coverage-loss shape as
// `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false` (#668/#746), and the reason the A2A
// surface reached QA uncovered while LE-1845, LE-1963, LE-2007 and LE-2081 were
// filed by hand (see docs/core-functionality/a2a/a2a-coverage-scope.md).
//
// So the flag's presence is asserted structurally, per lane, rather than reviewed.
// The list below is every workflow that starts a Langflow service container for a
// spec run — including `adaptive-impacted.yml`, which #1240's body omitted because
// CLAUDE.md does not mention it.
//
// Deliberately NOT covered: the two `migration-*.yml` workflows, which run their
// own `docker run` for upgrade-path specs that never touch A2A (they do not set
// LANGFLOW_ALLOW_CUSTOM_COMPONENTS either). Add them here the day a migration spec
// publishes an agent.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SPEC_RUNNING_LANES = [
  "adaptive-impacted.yml",
  "daily-stable.yml",
  "manual.yml",
  "nightly.yml",
  "pr-validation.yml",
  "weekly-stable.yml",
];

function workflow(name) {
  return fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", name), "utf8");
}

for (const lane of SPEC_RUNNING_LANES) {
  test(`${lane} enables A2A on its Langflow service`, () => {
    assert.match(
      workflow(lane),
      /^\s+LANGFLOW_A2A_ENABLED: "true"$/m,
      `${lane} must set LANGFLOW_A2A_ENABLED: "true" — without it every /api/v1/a2a/* route 404s and the A2A specs pass while testing nothing`,
    );
  });

  test(`${lane} keeps A2A in the same service env as the custom-components flag`, () => {
    // Both flags exist for the same reason (a product default that hides a whole
    // surface), and both must land on the SERVICE container, not on a step's env.
    // Asserting adjacency is what catches a well-meaning move into `jobs.*.env`,
    // where the container would never see it.
    const lines = workflow(lane).split("\n");
    const custom = lines.findIndex((l) => /^\s+LANGFLOW_ALLOW_CUSTOM_COMPONENTS: "true"$/.test(l));
    const a2a = lines.findIndex((l) => /^\s+LANGFLOW_A2A_ENABLED: "true"$/.test(l));
    assert.ok(custom > -1, `${lane} lost LANGFLOW_ALLOW_CUSTOM_COMPONENTS`);
    assert.ok(a2a > -1, `${lane} lost LANGFLOW_A2A_ENABLED`);
    assert.equal(
      lines[custom].length - lines[custom].trimStart().length,
      lines[a2a].length - lines[a2a].trimStart().length,
      `${lane}: the two flags are at different indentation — one of them is no longer in the service env`,
    );
  });
}

test("start-langflow-docker.sh passes the flag to the container, overridable", () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, "scripts/start-langflow-docker.sh"), "utf8");
  assert.match(script, /-e LANGFLOW_A2A_ENABLED="\$\{LANGFLOW_A2A_ENABLED:-true\}"/);
});

test("start-langflow-pip.sh exports the flag, overridable", () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, "scripts/start-langflow-pip.sh"), "utf8");
  assert.match(script, /LANGFLOW_A2A_ENABLED="\$\{LANGFLOW_A2A_ENABLED:-true\}"/);
});

test("the default is true, not merely present", () => {
  // `LANGFLOW_A2A_ENABLED=${LANGFLOW_A2A_ENABLED}` with no default would read as
  // "handled" while leaving the surface off whenever the caller's env is clean —
  // the exact failure this guard exists to prevent.
  for (const s of ["scripts/start-langflow-docker.sh", "scripts/start-langflow-pip.sh"]) {
    const text = fs.readFileSync(path.join(REPO_ROOT, s), "utf8");
    const m = text.match(/LANGFLOW_A2A_ENABLED="?\$\{LANGFLOW_A2A_ENABLED:-([a-z]+)\}"?/);
    assert.ok(m, `${s} does not set LANGFLOW_A2A_ENABLED with a default`);
    assert.equal(m[1], "true", `${s} defaults A2A to "${m[1]}"`);
  }
});
