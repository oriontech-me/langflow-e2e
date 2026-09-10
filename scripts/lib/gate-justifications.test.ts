/**
 * Unit tests for the gate-justification check (#1783).
 *
 * The classification is pure, so every rule is exercised on constructed input.
 * What that CANNOT cover is the shape of the real data, and two of the bugs
 * this check produced during development were exactly that: `gh api graphql`
 * substitutes `{owner}` and `{repo}` but NOT `{name}`, and it exits non-zero on
 * a partial resolution while still returning the resolved aliases. Both live in
 * `reconcile-stable-orphans.ts` and are covered there.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  candidateSpecs,
  checklistBullets,
  classifyGates,
  extractRefs,
  hasGateFindings,
  normalizeDeclRef,
  refKey,
  renderGateSection,
  tagsSection,
  type GateDecl,
  type GateInput,
  type JustificationSource,
  type RefState,
} from "./gate-justifications";
import type { DeclaredTest } from "./stable-tests";

function test_(
  overrides: Partial<DeclaredTest> & { relativePath: string },
): DeclaredTest {
  return {
    title: "t",
    line: 1,
    tags: [],
    stable: false,
    fixme: false,
    unparseableTags: false,
    ...overrides,
  } as DeclaredTest;
}

function source(text: string): JustificationSource {
  return { kind: "doc-tags", file: "docs/x.md", line: 1, text };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    tests: [test_({ relativePath: "a/x.spec.ts" })],
    justifications: {},
    refStates: {},
    trackedSpecs: {},
    declarations: [],
    ...over,
  };
}

describe("extractRefs", () => {
  it("reads a bare ref as this repo's and a slugged one as upstream", () => {
    assert.deepEqual(extractRefs("gated on #818 and langflow-ai/langflow#14489"), [
      { repo: "self", number: 818 },
      { repo: "upstream", number: 14489 },
    ]);
  });

  it("de-duplicates while keeping first-seen order", () => {
    assert.deepEqual(
      extractRefs("#773 then #820 then #773").map(refKey),
      ["#773", "#820"],
    );
  });

  it("keeps the same number in the two repos apart", () => {
    // The load-bearing case: `#14512` and `langflow-ai/langflow#14512` are
    // different references, and conflating them would resolve the bare one
    // against the wrong repo — the exact false verdict rule 3 exists to stop.
    assert.deepEqual(
      extractRefs("#14512 vs langflow-ai/langflow#14512").map(refKey),
      ["#14512", "upstream#14512"],
    );
  });

  it("does not match a `#` that continues a word", () => {
    // `\b` does not fire before `#`, so a naive boundary matches this.
    assert.deepEqual(extractRefs("abc#12"), []);
  });

  it("ignores a slug that is neither this repo nor upstream", () => {
    // A stray `path/to#34` in prose is not a cross-repo reference, and an
    // earlier version mapped ANY slug to upstream — which would also have
    // resolved this repo's own 8 self-qualified citations against Langflow.
    assert.deepEqual(extractRefs("path/to#34"), []);
  });

  it("reads this repo written out as its own reference, not as upstream", () => {
    assert.deepEqual(extractRefs("oriontech-me/langflow-e2e#963").map(refKey), [
      "#963",
    ]);
  });

  it("ignores a heading anchor, which has no digits", () => {
    assert.deepEqual(extractRefs("see [Tags](#tags-required)"), []);
  });
});

describe("tagsSection", () => {
  it("returns the body up to the next heading of any level", () => {
    const doc = [
      "# Title",
      "",
      "## Tags *(required)*",
      "",
      "`@regression`",
      "gated on #1",
      "",
      "## Preconditions",
      "not part of it #2",
    ].join("\n");
    const body = tagsSection(doc) as string;
    assert.match(body, /gated on #1/);
    assert.doesNotMatch(body, /#2/);
  });

  it("reaches the end of the file when Tags is the last section", () => {
    // A regex written with `\Z` (which JS does not support) silently fails
    // here, and the whole justification would go unread.
    const doc = "## Tags\n\ngated on #7\n";
    assert.match(tagsSection(doc) as string, /#7/);
  });

  it("returns null when there is no Tags heading", () => {
    assert.equal(tagsSection("# Title\n\nnothing here\n"), null);
  });
});

describe("checklistBullets", () => {
  it("matches the spec basename on a boundary, not as a substring", () => {
    // This tree really contains `run-flow.spec.ts` inside
    // `api-run-flow.spec.ts`; a bare `includes` attributes the wrong bullet.
    const checklist = [
      "- [-] a → `api-run-flow.spec.ts` (#1)",
      "- [-] b → `run-flow.spec.ts` (#2)",
    ].join("\n");
    const found = checklistBullets(checklist, "flow-functionality/run-flow.spec.ts");
    assert.equal(found.length, 1);
    assert.match(found[0].text, /#2/);
    assert.equal(found[0].line, 2);
  });
});

describe("candidateSpecs", () => {
  it("excludes a file where any test carries @stable", () => {
    const tests = [
      test_({ relativePath: "a/x.spec.ts", stable: true }),
      test_({ relativePath: "a/x.spec.ts", stable: false }),
      test_({ relativePath: "a/y.spec.ts", stable: false }),
    ];
    assert.deepEqual(candidateSpecs(tests), ["a/y.spec.ts"]);
  });

  it("excludes a file kept out of the daily by a lane tag (#1010)", () => {
    const tests = [
      test_({ relativePath: "a/lane.spec.ts", tags: ["@destructive"] }),
    ];
    assert.deepEqual(candidateSpecs(tests), []);
  });

  it("keeps a file where only SOME tests are lane-gated", () => {
    const tests = [
      test_({ relativePath: "a/mix.spec.ts", tags: ["@destructive"] }),
      test_({ relativePath: "a/mix.spec.ts", tags: ["@regression"] }),
    ];
    assert.deepEqual(candidateSpecs(tests), ["a/mix.spec.ts"]);
  });
});

describe("classifyGates", () => {
  const closed: RefState = { kind: "closed" };
  const open: RefState = { kind: "open" };

  it("reports a spec whose every citation is closed", () => {
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [source("gated on #818, per #827")],
          },
        },
        refStates: { "#818": closed, "#827": closed },
      }),
    );
    assert.equal(v.expired.length, 1);
    assert.equal(v.expired[0].spec, "a/x.spec.ts");
    assert.equal(hasGateFindings(v), true);
  });

  it("leaves a spec alone when ONE citation is still open (rule 1)", () => {
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [source("cluster #773; revisit per #1465")],
          },
        },
        refStates: { "#773": closed, "#1465": open },
      }),
    );
    assert.equal(v.expired.length, 0);
    assert.equal(v.live.length, 1);
    assert.equal(hasGateFindings(v), false);
  });

  it("treats a MERGED upstream pull request as closed (rule 4)", () => {
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [source("blocked on langflow-ai/langflow#14489")],
          },
        },
        refStates: { "upstream#14489": { kind: "merged" } },
      }),
    );
    assert.equal(v.expired.length, 1);
  });

  it("does NOT clear the finding when an open issue names the spec (rule 2)", () => {
    // The self-reference trap: the issue specifying this check lists every
    // affected spec, so suppression here empties the report.
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [source("gated on #818")],
          },
        },
        refStates: { "#818": closed },
        trackedSpecs: {
          "a/x.spec.ts": [{ number: 1783, url: "u" }],
        },
      }),
    );
    assert.equal(v.expired.length, 1);
    assert.deepEqual(
      v.expired[0].trackedBy.map((t) => t.number),
      [1783],
      "the tracker must still be carried, as context",
    );
  });

  it("reports an unresolvable citation as undecidable, never as closed (rule 3)", () => {
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [source("see #14512")],
          },
        },
        refStates: {
          "#14512": {
            kind: "unresolved",
            cause: "not-found",
            reason: "does not exist here",
          },
        },
      }),
    );
    assert.equal(v.expired.length, 0);
    assert.equal(v.unknown.length, 1);
    assert.match(v.unknown[0].reason ?? "", /does not exist here/);
  });

  it("is undecidable when only SOME citations resolve", () => {
    // A row whose other reference is plainly closed must not be reported
    // expired on the strength of the half that resolved.
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [source("#1575 and #14512")],
          },
        },
        refStates: {
          "#1575": closed,
          "#14512": { kind: "unresolved", cause: "not-found", reason: "nope" },
        },
      }),
    );
    assert.equal(v.unknown.length, 1);
    assert.equal(v.expired.length, 0);
  });

  it("degrades every row to undecidable when the lookup failed (#1012)", () => {
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [source("gated on #818")],
          },
        },
        refStates: { "#818": closed },
        lookupError: "gh exploded",
      }),
    );
    assert.equal(v.expired.length, 0);
    assert.equal(v.unknown.length, 1);
    assert.match(v.unknown[0].reason ?? "", /gh exploded/);
  });

  it("reports an unreadable doc as undecidable, not as citing nothing", () => {
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [],
            readError: "EACCES",
          },
        },
      }),
    );
    assert.equal(v.unknown.length, 1);
  });

  it("does not list a spec that cites nothing at all", () => {
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": { spec: "a/x.spec.ts", sources: [source("no refs")] },
        },
      }),
    );
    assert.equal(v.expired.length + v.unknown.length + v.live.length, 0);
    assert.equal(v.counts.withRefs, 0);
    assert.equal(v.counts.candidateSpecs, 1);
  });

  it("honours a declaration whose citations are all still cited", () => {
    const decl: GateDecl = {
      spec: "a/x.spec.ts",
      refs: ["#1039"],
      reason: "packaging policy",
    };
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": { spec: "a/x.spec.ts", sources: [source("per #1039")] },
        },
        refStates: { "#1039": closed },
        declarations: [decl],
      }),
    );
    assert.equal(v.expired.length, 0);
    assert.equal(v.declared.length, 1);
    assert.equal(v.staleDeclarations.length, 0);
    assert.equal(hasGateFindings(v), false);
  });

  describe("a declaration is verified in the other direction too (rule 5, #1084)", () => {
    const decl: GateDecl = {
      spec: "a/x.spec.ts",
      refs: ["#1039"],
      reason: "packaging policy",
    };

    it("expires when the spec carries @stable again", () => {
      const v = classifyGates(
        input({
          tests: [test_({ relativePath: "a/x.spec.ts", stable: true })],
          declarations: [decl],
        }),
      );
      assert.equal(v.staleDeclarations.length, 1);
      assert.match(v.staleDeclarations[0].reason, /@stable/);
    });

    it("expires when the spec no longer exists", () => {
      const v = classifyGates(
        input({
          tests: [test_({ relativePath: "a/other.spec.ts" })],
          declarations: [decl],
        }),
      );
      assert.equal(v.staleDeclarations.length, 1);
      assert.match(v.staleDeclarations[0].reason, /protects nothing/);
    });

    it("expires when the justification stopped citing the declared reference", () => {
      const v = classifyGates(
        input({
          justifications: {
            "a/x.spec.ts": {
              spec: "a/x.spec.ts",
              sources: [source("now cites #2000 instead")],
            },
          },
          refStates: { "#2000": closed },
          declarations: [decl],
        }),
      );
      assert.equal(v.staleDeclarations.length, 1);
      assert.match(v.staleDeclarations[0].reason, /#1039/);
    });

    it("does not expire on an unreadable doc — that is undecidable", () => {
      const v = classifyGates(
        input({
          justifications: {
            "a/x.spec.ts": { spec: "a/x.spec.ts", sources: [], readError: "EACCES" },
          },
          declarations: [decl],
        }),
      );
      assert.equal(v.staleDeclarations.length, 0);
      assert.equal(v.unknown.length, 1);
    });
  });

  it("counts distinct references once across specs", () => {
    const v = classifyGates(
      input({
        tests: [
          test_({ relativePath: "a/x.spec.ts" }),
          test_({ relativePath: "a/y.spec.ts" }),
        ],
        justifications: {
          "a/x.spec.ts": { spec: "a/x.spec.ts", sources: [source("#820")] },
          "a/y.spec.ts": { spec: "a/y.spec.ts", sources: [source("#820")] },
        },
        refStates: { "#820": closed },
      }),
    );
    assert.equal(v.counts.refs, 1);
    assert.equal(v.counts.withRefs, 2);
  });
});

describe("normalizeDeclRef", () => {
  it("accepts the spelling a human writes in the declarations file", () => {
    assert.equal(normalizeDeclRef("#1039"), "#1039");
    assert.equal(
      normalizeDeclRef("langflow-ai/langflow#14512"),
      "upstream#14512",
    );
  });
});

describe("renderGateSection", () => {
  const opts = { declarationsPath: "scripts/lib/decl.json" };

  it("names the finding, its citations and the context column", () => {
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [source("gated on #818")],
          },
        },
        refStates: { "#818": { kind: "closed" } },
        trackedSpecs: { "a/x.spec.ts": [{ number: 963, url: "u" }] },
      }),
    );
    const md = renderGateSection(v, opts);
    assert.match(md, /\*\*1 expired\*\*/);
    assert.match(md, /a\/x\.spec\.ts/);
    assert.match(md, /#818 — closed/);
    assert.match(md, /#963/);
    assert.match(md, /CONTEXT, not ownership/);
  });

  it("says a clean run is clean without inventing a table", () => {
    const md = renderGateSection(classifyGates(input()), opts);
    assert.match(md, /\*\*0 expired\*\*/);
    assert.doesNotMatch(md, /### Expired/);
  });

  it("escapes a pipe so one reason cannot break the table", () => {
    const v = classifyGates(
      input({
        justifications: {
          "a/x.spec.ts": {
            spec: "a/x.spec.ts",
            sources: [source("see #1")],
          },
        },
        refStates: {
          "#1": { kind: "unresolved", cause: "not-found", reason: "a | b" },
        },
      }),
    );
    const row = renderGateSection(v, opts)
      .split("\n")
      .find((l) => l.includes("a/x.spec.ts")) as string;
    assert.match(row, /a \\\| b/);
    // Count UNESCAPED delimiters: the escaped pipe is still a `|` character,
    // and a naive split counts it and reports the escaping as broken.
    assert.equal(
      row.split(/(?<!\\)\|/).length - 1,
      4,
      "the row must keep 4 unescaped delimiters",
    );
  });
});
