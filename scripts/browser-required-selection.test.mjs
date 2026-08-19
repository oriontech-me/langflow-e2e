import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  classifySelection,
  usesBrowser,
} from "./browser-required-selection.mjs";

const API_SPEC = `
  test("reads the policy", { tag: ["@api"] }, async ({ request }) => {});
`;
const UI_SPEC = `
  test("opens the sidebar", { tag: ["@ui-ux"] }, async ({ page }) => {});
`;
const BEFORE_EACH_ONLY = `
  test.beforeEach(async ({ page }) => { await page.goto("/"); });
  test("does something", { tag: ["@ui-ux"] }, async ({ request }) => {});
`;
const MULTILINE = `
  test("mixed", { tag: ["@api"] }, async ({
    request,
    page,
  }) => {});
`;
const NOTHING_RECOGNISABLE = `
  // a file with no fixture callbacks at all
  export const helper = 1;
`;

function sources(map) {
  return (spec) => {
    if (!(spec in map)) throw new Error("ENOENT: no such file");
    return map[spec];
  };
}

describe("usesBrowser", () => {
  it("sees a browser fixture, including one only a hook asks for", () => {
    assert.equal(usesBrowser(UI_SPEC), true);
    // The hook opens the browser for every test in the file, so the file needs
    // one even though the test itself only takes `request`.
    assert.equal(usesBrowser(BEFORE_EACH_ONLY), true);
    assert.equal(usesBrowser(MULTILINE), true);
  });

  it("reports a request-only spec as browser-free", () => {
    assert.equal(usesBrowser(API_SPEC), false);
  });

  it("reports UNDECIDABLE rather than browser-free when it recognises nothing", () => {
    // The distinction that matters: `null` must not collapse into `false`, or an
    // unparsed file would skip the install and fail at browser launch.
    assert.equal(usesBrowser(NOTHING_RECOGNISABLE), null);
  });

  it("does not mistake a longer identifier for a browser fixture", () => {
    assert.equal(usesBrowser(`async ({ requestPage }) => {}`), false);
    assert.equal(usesBrowser(`async ({ pageSize }) => {}`), false);
  });
});

describe("classifySelection", () => {
  it("skips the install only when EVERY spec is positively browser-free", () => {
    const verdict = classifySelection(
      ["a.spec.ts", "b.spec.ts"],
      sources({ "a.spec.ts": API_SPEC, "b.spec.ts": API_SPEC }),
    );
    assert.equal(verdict.browserRequired, false);
    assert.equal(verdict.browserUsing.length, 0);
  });

  it("one browser spec makes the whole selection require it", () => {
    const verdict = classifySelection(
      ["a.spec.ts", "b.spec.ts"],
      sources({ "a.spec.ts": API_SPEC, "b.spec.ts": UI_SPEC }),
    );
    assert.equal(verdict.browserRequired, true);
    assert.deepEqual(verdict.browserUsing, ["b.spec.ts"]);
  });

  it("an unreadable spec installs, and does not throw", () => {
    // The opposite default from destructive-only-selection.mjs, on purpose: a
    // wrong skip here fails the run with a launch error that names nothing.
    const verdict = classifySelection(
      ["gone.spec.ts"],
      sources({}),
    );
    assert.equal(verdict.browserRequired, true);
    assert.deepEqual(verdict.undecidable, ["gone.spec.ts"]);
  });

  it("an unrecognisable spec installs", () => {
    const verdict = classifySelection(
      ["x.spec.ts"],
      sources({ "x.spec.ts": NOTHING_RECOGNISABLE }),
    );
    assert.equal(verdict.browserRequired, true);
  });

  it("an EMPTY selection installs", () => {
    // The job should not reach this with no specs, but answering `false` here
    // would skip the install for a canary run, whose specs come from elsewhere.
    assert.equal(classifySelection([], sources({})).browserRequired, true);
  });
});

describe("the real suite", () => {
  it("classifies a known API spec and a known UI spec correctly", () => {
    const api = readFileSync(
      "tests/tests-automations/regression/api/flows/api-health-check.spec.ts",
      "utf8",
    );
    const ui = readFileSync(
      "tests/tests-automations/regression/core-functionality/auth/logout-flow.spec.ts",
      "utf8",
    );
    // Pinned against real files so a change in how specs are written — a new
    // fixture style, say — shows up here instead of silently skipping installs.
    assert.equal(usesBrowser(api), false);
    assert.equal(usesBrowser(ui), true);
  });
});

describe("pr-validation.yml wiring", () => {
  const workflow = readFileSync(".github/workflows/pr-validation.yml", "utf8");

  it("exports the verdict and gates the install step on it", () => {
    assert.match(workflow, /browser_required: \$\{\{ steps\.diff\.outputs\.browser_required \}\}/);
    assert.match(
      workflow,
      /if: needs\.detect-specs\.outputs\.browser_required != 'false'/,
    );
  });
});
