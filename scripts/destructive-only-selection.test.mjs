import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  classifySelection,
  isDestructiveOnlySource,
} from "./destructive-only-selection.mjs";

const DESTRUCTIVE_SPEC = `
  test("blocks a component", { tag: ["@destructive", "@api", "@governance"] }, async () => {});
  test("puts it back", { tag: ["@destructive", "@api", "@governance"] }, async () => {});
`;

const MIXED_SPEC = `
  test("lists folders", { tag: ["@stable", "@api"] }, async () => {});
  test("deletes every project", { tag: ["@destructive", "@release", "@api"] }, async () => {});
`;

const NORMAL_SPEC = `
  test("searches the sidebar", { tag: ["@stable", "@workspace", "@ui-ux"] }, async () => {});
`;

function sources(map) {
  return (spec) => {
    if (!(spec in map)) throw new Error("ENOENT: no such file");
    return map[spec];
  };
}

describe("isDestructiveOnlySource", () => {
  it("is true when every tag array carries @destructive", () => {
    assert.equal(isDestructiveOnlySource(DESTRUCTIVE_SPEC), true);
  });

  it("is false when one test in the file is runnable in the normal lane", () => {
    // The shape that kept this bug hidden: folder-deletion-integrity.spec.ts.
    assert.equal(isDestructiveOnlySource(MIXED_SPEC), false);
  });

  it("is false for a spec with no destructive test at all", () => {
    assert.equal(isDestructiveOnlySource(NORMAL_SPEC), false);
  });

  it("is false when the file declares no tag array", () => {
    // Untagged is against the repo rule, but running the normal lane is the
    // outcome that cannot lose coverage.
    assert.equal(isDestructiveOnlySource("test('untagged', async () => {});"), false);
  });

  it("reads the tag from a tag array, never from a comment", () => {
    const commented = `
      // @destructive would be wrong here — this suite is safe to run in parallel.
      test("safe", { tag: ["@stable", "@api"] }, async () => {});
    `;
    assert.equal(isDestructiveOnlySource(commented), false);
  });

  it("matches a multi-line tag array", () => {
    const multiline = `
      test(
        "blocks a component",
        {
          tag: [
            "@destructive",
            "@api",
          ],
        },
        async () => {},
      );
    `;
    assert.equal(isDestructiveOnlySource(multiline), true);
  });
});

describe("classifySelection", () => {
  it("reports destructiveOnly when no selected spec can run in the normal lane", () => {
    const verdict = classifySelection(
      ["a.spec.ts", "b.spec.ts"],
      sources({ "a.spec.ts": DESTRUCTIVE_SPEC, "b.spec.ts": DESTRUCTIVE_SPEC }),
    );
    assert.equal(verdict.destructiveOnly, true);
    assert.deepEqual(verdict.runnable, []);
    assert.equal(verdict.destructive.length, 2);
  });

  it("one runnable spec is enough to keep the normal lane", () => {
    const verdict = classifySelection(
      ["a.spec.ts", "b.spec.ts"],
      sources({ "a.spec.ts": DESTRUCTIVE_SPEC, "b.spec.ts": MIXED_SPEC }),
    );
    assert.equal(verdict.destructiveOnly, false);
    assert.deepEqual(verdict.runnable, ["b.spec.ts"]);
  });

  it("an empty selection is not destructive-only", () => {
    // `has_specs` already skips the job there; answering true would skip the
    // normal lane for a reason unrelated to tags.
    const verdict = classifySelection([], sources({}));
    assert.equal(verdict.destructiveOnly, false);
  });

  it("throws on an unreadable spec instead of guessing", () => {
    assert.throws(
      () => classifySelection(["gone.spec.ts"], sources({})),
      /cannot read selected spec "gone.spec.ts".*undecidable/s,
    );
  });
});

describe("against the suite's real specs", () => {
  it("the governance specs are destructive-only and folder-deletion-integrity is not", () => {
    const governance =
      "tests/tests-automations/regression/governance/catalog-policy/component-blocklist-enforcement.spec.ts";
    const mixed =
      "tests/tests-automations/regression/core-functionality/project-management/folder-deletion-integrity.spec.ts";

    // Both files are committed sources, so this pins the classifier against the
    // two real shapes rather than against fixtures only. A spec that moves makes
    // this fail loudly, which is the intent.
    let governanceSource;
    try {
      governanceSource = readFileSync(governance, "utf8");
    } catch {
      // The governance specs land in a sibling PR (#1494); until it merges this
      // half is skipped rather than red.
      governanceSource = null;
    }
    if (governanceSource !== null) {
      assert.equal(isDestructiveOnlySource(governanceSource), true);
    }

    assert.equal(
      isDestructiveOnlySource(readFileSync(mixed, "utf8")),
      false,
      `${mixed} is expected to carry non-destructive tests — if that changed, the lane's assumptions changed with it`,
    );
  });
});

describe("pr-validation.yml wiring", () => {
  // Presence checks only. #1226's lesson is that a regex over YAML pins a
  // spelling, not a behaviour — the behaviour above is what the rest of this
  // file asserts. These exist because the bug reached the lane by the step
  // simply not knowing about the destructive lane at all, and a deleted gate
  // would restore exactly that.
  const workflow = readFileSync(".github/workflows/pr-validation.yml", "utf8");

  it("detect-specs exports the verdict and the run step is gated on it", () => {
    assert.match(workflow, /destructive_only: \$\{\{ steps\.diff\.outputs\.destructive_only \}\}/);
    assert.match(
      workflow,
      /if: needs\.detect-specs\.outputs\.destructive_only != 'true'/,
    );
  });

  it("the skip is announced, so it cannot read as coverage", () => {
    assert.match(workflow, /::warning::Every impacted spec is @destructive/);
  });

  it("the normal run still fails on an empty match it did not predict", () => {
    // i.e. the fix is the gate, NOT --pass-with-no-tests on the normal run.
    const normalRun = workflow.slice(
      workflow.indexOf("- name: Run impacted specs"),
      workflow.indexOf("# Destructive lane (#1010)"),
    );
    assert.ok(normalRun.includes("npx playwright test $SPECS --reporter=github"));
    assert.ok(!normalRun.includes("--pass-with-no-tests"));
  });
});
