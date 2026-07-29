import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FULL_SUITE_PATHS,
  isFullSuiteTrigger,
  parseImportSpecifiers,
  resolveSpecifier,
  buildImporterGraph,
  selectImpactedSpecs,
  applyCap,
} from "./impacted-specs-by-import.mjs";

/**
 * The gate this feeds selects PR E2E work. Its failure mode is silence: a
 * shared helper changes, nothing is selected, and the PR reads as covered
 * (#1054 — PR #1052 changed a helper reached by 112 specs and ran zero; PR
 * #1088 changed one imported by 135 and reaching 171, and ran zero). These tests pin the two
 * properties that keep that from recurring: resolution is TRANSITIVE, and a
 * suite-wide change announces itself instead of resolving to nothing.
 */

// A miniature suite: spec A imports the helper directly, spec B reaches it
// through a Page Object, spec C imports neither.
const FILES = new Map([
  ["tests/helpers/ui/adjust-screen-view.ts", "export function adjustScreenView() {}"],
  [
    "tests/pages/SimpleAgentTemplatePage.ts",
    `import { adjustScreenView } from "../helpers/ui/adjust-screen-view";`,
  ],
  ["tests/pages/index.ts", `export * from "./SimpleAgentTemplatePage";`],
  [
    "tests/tests-automations/regression/a/direct.spec.ts",
    `import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";`,
  ],
  [
    "tests/tests-automations/regression/a/indirect.spec.ts",
    `import { SimpleAgentTemplatePage } from "../../../pages";`,
  ],
  [
    "tests/tests-automations/regression/a/unrelated.spec.ts",
    `import { test } from "../../../fixtures/fixtures";`,
  ],
  ["tests/fixtures/fixtures.ts", "export const test = {};"],
]);

test("parseImportSpecifiers finds static imports, type imports, re-exports and require", () => {
  const src = `
    import { a } from "./a";
    import type { B } from '../b';
    import * as c from \`./c\`;
    export { d } from "./d";
    export * from "./e";
    const f = require("./f");
    const g = await import("./g");
    import "side-effect";
  `;
  const found = parseImportSpecifiers(src);
  for (const s of ["./a", "../b", "./c", "./d", "./e", "./f", "./g", "side-effect"]) {
    assert.ok(found.includes(s), `expected specifier ${s}`);
  }
});

test("resolveSpecifier resolves extensionless, explicit and index imports; ignores packages", () => {
  const exists = (p) => FILES.has(p);
  assert.equal(
    resolveSpecifier("tests/pages/SimpleAgentTemplatePage.ts", "../helpers/ui/adjust-screen-view", exists),
    "tests/helpers/ui/adjust-screen-view.ts",
  );
  assert.equal(
    resolveSpecifier("tests/tests-automations/regression/a/indirect.spec.ts", "../../../pages", exists),
    "tests/pages/index.ts",
  );
  assert.equal(
    resolveSpecifier("tests/x.ts", "@playwright/test", exists),
    null,
    "a package specifier is not a repo edge",
  );
});

test("buildImporterGraph inverts the import edges", () => {
  const graph = buildImporterGraph(FILES);
  assert.deepEqual(
    [...(graph.get("tests/helpers/ui/adjust-screen-view.ts") ?? [])].sort(),
    ["tests/pages/SimpleAgentTemplatePage.ts", "tests/tests-automations/regression/a/direct.spec.ts"],
  );
});

test("selectImpactedSpecs is TRANSITIVE — the indirect spec is not left behind", () => {
  // The property #1052 would have failed: a direct-importers-only pass returns
  // the direct spec alone and reads as coverage while half the reach is unrun.
  const r = selectImpactedSpecs({
    changed: ["tests/helpers/ui/adjust-screen-view.ts"],
    files: FILES,
  });
  assert.deepEqual(r.specs, [
    "tests/tests-automations/regression/a/direct.spec.ts",
    "tests/tests-automations/regression/a/indirect.spec.ts",
  ]);
  assert.equal(r.fullSuite, false);
  assert.deepEqual(r.direct, ["tests/tests-automations/regression/a/direct.spec.ts"]);
});

test("a changed spec selects itself", () => {
  const r = selectImpactedSpecs({
    changed: ["tests/tests-automations/regression/a/unrelated.spec.ts"],
    files: FILES,
  });
  assert.deepEqual(r.specs, ["tests/tests-automations/regression/a/unrelated.spec.ts"]);
});

test("a change reaching no spec selects nothing and says so", () => {
  const files = new Map(FILES);
  files.set("tests/helpers/orphan.ts", "export const unused = 1;");
  const r = selectImpactedSpecs({ changed: ["tests/helpers/orphan.ts"], files });
  assert.deepEqual(r.specs, []);
  assert.equal(r.fullSuite, false);
});

test("a path outside the suite is ignored, not treated as suite-wide", () => {
  const r = selectImpactedSpecs({ changed: ["README.md", "docs/x.md"], files: FILES });
  assert.deepEqual(r.specs, []);
  assert.equal(r.fullSuite, false);
});

test("fixtures and playwright.config raise a full-suite signal", () => {
  for (const p of ["tests/fixtures/fixtures.ts", "playwright.config.ts"]) {
    const r = selectImpactedSpecs({ changed: [p], files: FILES });
    assert.equal(r.fullSuite, true, `${p} must be suite-wide`);
    assert.ok(r.specs.length > 0, "a full-suite signal still names the specs it resolved");
  }
  assert.ok(FULL_SUITE_PATHS.length > 0);
  assert.ok(isFullSuiteTrigger("tests/fixtures/anything.ts"));
  assert.ok(!isFullSuiteTrigger("tests/helpers/ui/adjust-screen-view.ts"));
});

test("applyCap reports what it dropped — a silent cap reads as coverage (#1012)", () => {
  const specs = ["a", "b", "c", "d"];
  const uncapped = applyCap(specs, 0);
  assert.deepEqual(uncapped.selected, specs);
  assert.deepEqual(uncapped.dropped, []);

  const capped = applyCap(specs, 2);
  assert.deepEqual(capped.selected, ["a", "b"]);
  assert.deepEqual(capped.dropped, ["c", "d"]);
});

test("the cap keeps direct importers ahead of transitive ones", () => {
  const r = selectImpactedSpecs({
    changed: ["tests/helpers/ui/adjust-screen-view.ts"],
    files: FILES,
    cap: 1,
  });
  assert.deepEqual(r.selected, ["tests/tests-automations/regression/a/direct.spec.ts"]);
  assert.deepEqual(r.dropped, ["tests/tests-automations/regression/a/indirect.spec.ts"]);
});

test("an import cycle terminates instead of hanging the gate", () => {
  const files = new Map([
    ["tests/helpers/a.ts", `import { b } from "./b";`],
    ["tests/helpers/b.ts", `import { a } from "./a";`],
    ["tests/tests-automations/regression/z.spec.ts", `import { a } from "../../helpers/a";`],
  ]);
  const r = selectImpactedSpecs({ changed: ["tests/helpers/b.ts"], files });
  assert.deepEqual(r.specs, ["tests/tests-automations/regression/z.spec.ts"]);
});

test("within a tier, @stable specs are queued first so a cap keeps the validated subset", () => {
  const files = new Map([
    ["tests/helpers/h.ts", "export const h = 1;"],
    [
      "tests/tests-automations/regression/a/zulu.spec.ts",
      `import { h } from "../../../helpers/h";\ntest("x", { tag: ["@stable"] }, () => {})`,
    ],
    [
      "tests/tests-automations/regression/a/alpha.spec.ts",
      `import { h } from "../../../helpers/h";\ntest("y", { tag: ["@regression"] }, () => {})`,
    ],
  ]);
  const r = selectImpactedSpecs({ changed: ["tests/helpers/h.ts"], files, cap: 1 });
  // Alphabetically alpha comes first; @stable must win the single slot.
  assert.deepEqual(r.selected, ["tests/tests-automations/regression/a/zulu.spec.ts"]);
  assert.deepEqual(r.dropped, ["tests/tests-automations/regression/a/alpha.spec.ts"]);
  assert.equal(r.stableSelected, 1);
  // Ordering, never filtering: the non-@stable spec is still impacted.
  assert.equal(r.specs.length, 2);
});

test("direct beats @stable across tiers — a transitive @stable never displaces a direct importer", () => {
  const files = new Map([
    ["tests/helpers/h.ts", "export const h = 1;"],
    ["tests/pages/P.ts", `import { h } from "../helpers/h";`],
    [
      "tests/tests-automations/regression/a/direct.spec.ts",
      `import { h } from "../../../helpers/h";\ntest("d", { tag: ["@regression"] }, () => {})`,
    ],
    [
      "tests/tests-automations/regression/a/via-pom.spec.ts",
      `import { P } from "../../../pages/P";\ntest("v", { tag: ["@stable"] }, () => {})`,
    ],
  ]);
  const r = selectImpactedSpecs({ changed: ["tests/helpers/h.ts"], files, cap: 1 });
  assert.deepEqual(r.selected, ["tests/tests-automations/regression/a/direct.spec.ts"]);
});
