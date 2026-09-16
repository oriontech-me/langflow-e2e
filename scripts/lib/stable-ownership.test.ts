// Unit tests for the `@stable` ownership verdict (issue #1770).
// Run with: npm run test:units
//
// The question: every spec whose tests carry no `@stable` runs in no scheduled
// lane, so does an OPEN issue own it, or is its absence declared? A tag that was
// REMOVED is #1746's question and a separate report; this one is about the
// specs nobody is holding at all.
//
// Four properties carry the design, and each is asserted below because each
// one fails silently if it breaks:
//
//   * SEVERITY FOLLOWS THE DIFF (#980). A spec outside the frozen baseline fails
//     only when the PR itself touched it. The daily strips `@stable` from a
//     hard-failing test on its own, so a spec can enter the backlog with no PR
//     at all — failing on it would redden every unrelated PR until someone
//     reacted.
//   * UNDECIDABLE IS NOT CLEAN (#1012). A failed issue lookup makes every row
//     that depends on it `unknown`, and `unknown` fails.
//   * THE DOMAIN IS PINNED. Lane-gated specs are out by construction, and that
//     is asserted by feeding the real backlog predicate an Enterprise-only
//     population — an assertion over an empty input list would pass whatever
//     the predicate did.
//   * AN EXEMPTION IS NOT RE-VERIFIED HERE. It is read from #1746's declarations,
//     which already report their own expiry against the test's actual state; a
//     second verifier with a different rule is how the two reports would come
//     to disagree about the same spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OWNERSHIP_ISSUE_TITLE,
  hasOwnershipFindings,
  ownershipOutputLines,
  ownershipReport,
  renderOwnershipReport,
  type OwnershipInput,
} from "./stable-ownership";
import { classifyBacklog } from "./inherited-backlog";
import type { DeclaredTest } from "./stable-tests";

const base: OwnershipInput = {
  backlogSpecs: ["a/x.spec.ts"],
  baselineSpecs: ["a/x.spec.ts"],
  exemptSpecs: new Map(),
  trackers: {},
};

const rowOf = (input: OwnershipInput, spec: string) => {
  const row = ownershipReport(input).rows.find((r) => r.spec === spec);
  assert.ok(row, `no row for ${spec}`);
  return row;
};

test("an open issue naming the spec owns it, and ownership is neither a failure nor a notice", () => {
  const r = ownershipReport({ ...base, trackers: { "a/x.spec.ts": [{ number: 7 }, { number: 9 }] } });
  assert.equal(r.rows[0].verdict, "owned");
  assert.match(r.rows[0].detail, /#7/);
  assert.match(r.rows[0].detail, /#9/);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.notices, []);
});

test("a baseline spec with no owner is a notice, never a failure", () => {
  const r = ownershipReport(base);
  assert.equal(r.rows[0].verdict, "unowned-baseline");
  assert.deepEqual(r.failures, []);
  assert.equal(r.notices.length, 1);
});

test("a spec beyond the baseline that the PR touched, with no owner, fails and is named", () => {
  const input: OwnershipInput = {
    ...base,
    backlogSpecs: ["a/x.spec.ts", "b/new.spec.ts"],
    changedSpecs: new Set(["b/new.spec.ts"]),
  };
  const r = ownershipReport(input);
  assert.equal(rowOf(input, "b/new.spec.ts").verdict, "unowned-new");
  assert.deepEqual(r.failures.map((f) => f.spec), ["b/new.spec.ts"]);
  assert.match(r.failures[0].detail, /this PR/);
});

// The daily removes `@stable` from a hard-failing test and commits straight to
// `main`. A spec that loses its last `@stable` that way enters the backlog with
// no PR involved, and failing every later PR on it is the exact #980 inversion.
test("a spec beyond the baseline that the PR did NOT touch is a warning, not a failure", () => {
  const input: OwnershipInput = {
    ...base,
    backlogSpecs: ["a/x.spec.ts", "c/elsewhere.spec.ts"],
    changedSpecs: new Set(["unrelated/other.spec.ts"]),
  };
  const r = ownershipReport(input);
  assert.equal(rowOf(input, "c/elsewhere.spec.ts").verdict, "unowned-new");
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings.map((w) => w.spec), ["c/elsewhere.spec.ts"]);
});

test("with no diff context (the daily) a spec beyond the baseline is a warning and a finding", () => {
  const input: OwnershipInput = { ...base, backlogSpecs: ["a/x.spec.ts", "c/elsewhere.spec.ts"] };
  const r = ownershipReport(input);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings.map((w) => w.spec), ["c/elsewhere.spec.ts"]);
  assert.equal(hasOwnershipFindings(r), true);
});

test("a spec declared exempt is exempt, even while an open issue also names it", () => {
  const r = ownershipReport({
    ...base,
    exemptSpecs: new Map([["a/x.spec.ts", "not bundled in the tested image"]]),
    trackers: { "a/x.spec.ts": [{ number: 7 }] },
  });
  assert.equal(r.rows[0].verdict, "exempt");
  assert.match(r.rows[0].detail, /not bundled/);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.notices, []);
});

test("a failed issue lookup makes every row that needs it unknown, and unknown fails", () => {
  const input: OwnershipInput = {
    backlogSpecs: ["a/x.spec.ts", "b/new.spec.ts", "z/exempt.spec.ts"],
    baselineSpecs: ["a/x.spec.ts"],
    exemptSpecs: new Map([["z/exempt.spec.ts", "a standing packaging decision"]]),
    trackers: null,
    lookupError: "HTTP 502: Bad Gateway",
  };
  const r = ownershipReport(input);
  assert.equal(rowOf(input, "a/x.spec.ts").verdict, "unknown");
  assert.equal(rowOf(input, "b/new.spec.ts").verdict, "unknown");
  assert.match(rowOf(input, "a/x.spec.ts").detail, /HTTP 502/);
  // An exemption is read from a committed file, not from GitHub, so the outage
  // decides nothing about it — labelling it unknown would name the wrong cause.
  assert.equal(rowOf(input, "z/exempt.spec.ts").verdict, "exempt");
  assert.deepEqual(r.failures.map((f) => f.spec).sort(), ["a/x.spec.ts", "b/new.spec.ts"]);
  assert.equal(r.lookupFailed, true);
});

test("a lookup that failed without saying why still names that it failed", () => {
  const r = ownershipReport({ ...base, trackers: null });
  assert.equal(r.rows[0].verdict, "unknown");
  assert.match(r.rows[0].detail, /could not be read/i);
});

test("an all-owned or all-exempt population has no findings; an empty one has none either", () => {
  const owned = ownershipReport({ ...base, trackers: { "a/x.spec.ts": [{ number: 1 }] } });
  assert.equal(hasOwnershipFindings(owned), false);
  const empty = ownershipReport({ ...base, backlogSpecs: [], baselineSpecs: [] });
  assert.deepEqual(empty.rows, []);
  assert.equal(hasOwnershipFindings(empty), false);
});

test("rows come out sorted and every row lands in exactly one count", () => {
  const input: OwnershipInput = {
    backlogSpecs: ["z/b.spec.ts", "a/owned.spec.ts", "m/base.spec.ts", "q/new.spec.ts"],
    baselineSpecs: ["m/base.spec.ts", "z/b.spec.ts"],
    exemptSpecs: new Map([["z/b.spec.ts", "declared"]]),
    trackers: { "a/owned.spec.ts": [{ number: 3 }] },
  };
  const r = ownershipReport(input);
  assert.deepEqual(r.rows.map((x) => x.spec), [...input.backlogSpecs].sort());
  const total = Object.values(r.counts).reduce((n, v) => n + v, 0);
  assert.equal(total, r.rows.length);
  assert.deepEqual(r.counts, {
    owned: 1, exempt: 1, "unowned-baseline": 1, "unowned-new": 1, unknown: 0,
  });
});

// Pinned negative scope. Enterprise is the largest population with no
// `@stable` anywhere in the repo, and its absence is correct (#1010). The
// assertion goes THROUGH the real backlog predicate on purpose: fed an empty
// list, `ownershipReport` returns no rows whatever the predicate does, so a
// test written that way would keep passing the day someone widened the domain.
test("an Enterprise-only population yields no backlog spec, so no row at all", () => {
  const declared = (relativePath: string, title: string, tags: string[]): DeclaredTest => ({
    title,
    relativePath,
    line: 1,
    tags,
    stable: false,
    fixme: false,
    modifier: "",
    unparseableTags: false,
    grepTitle: [title, ...tags].join(" "),
  });
  const population = [
    declared("enterprise/admin-console/a.spec.ts", "an admin toggles a policy", ["@enterprise", "@authz"]),
    declared("enterprise/admin-console/a.spec.ts", "an admin exports the audit log", ["@enterprise"]),
    declared("governance/catalog.spec.ts", "a blocked component is refused", ["@destructive", "@governance"]),
    declared("serving/identity.spec.ts", "two identities never share memory", ["@serving"]),
  ];
  const backlog = classifyBacklog(population, () => ({ hasMirroredDoc: true, hasIdScopedCleanup: true }));
  const backlogSpecs = backlog.specs.map((s) => s.relativePath);
  assert.deepEqual(backlogSpecs, [], "a lane-gated test must never enter the backlog");

  const r = ownershipReport({
    backlogSpecs,
    baselineSpecs: [],
    exemptSpecs: new Map(),
    trackers: {},
  });
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.failures, []);

  // And the control: the same predicate DOES admit a plain, untagged-for-lanes
  // test, so the empty result above is the lane rule and not a predicate that
  // admits nothing.
  const control = classifyBacklog(
    [...population, declared("ui-ux/plain.spec.ts", "a plain test", ["@regression"])],
    () => ({ hasMirroredDoc: false, hasIdScopedCleanup: false }),
  );
  assert.deepEqual(control.specs.map((s) => s.relativePath), ["ui-ux/plain.spec.ts"]);
});

test("the report leads with what fails, then what warns, and folds away what is settled", () => {
  const input: OwnershipInput = {
    backlogSpecs: ["a/base.spec.ts", "b/new.spec.ts", "c/drift.spec.ts", "d/owned.spec.ts", "e/exempt.spec.ts"],
    baselineSpecs: ["a/base.spec.ts"],
    exemptSpecs: new Map([["e/exempt.spec.ts", "packaging decision"]]),
    trackers: { "d/owned.spec.ts": [{ number: 12 }] },
    changedSpecs: new Set(["b/new.spec.ts"]),
  };
  const md = renderOwnershipReport(ownershipReport(input), { runLabel: "[run 42](https://x/42)" });
  const at = (s: string) => {
    const i = md.indexOf(s);
    assert.notEqual(i, -1, `the report names ${s}`);
    return i;
  };
  assert.ok(at("b/new.spec.ts") < at("c/drift.spec.ts"), "failures before warnings");
  assert.ok(at("c/drift.spec.ts") < at("a/base.spec.ts"), "warnings before baseline notices");
  assert.ok(at("<details>") < at("d/owned.spec.ts"), "owned rows are folded away");
  assert.match(md, /run 42/);
  assert.match(md, /#1746/, "the report cross-links the removed-tag report");
  assert.match(md, /5 spec/);
});

test("an empty report says so rather than rendering nothing", () => {
  const md = renderOwnershipReport(
    ownershipReport({ backlogSpecs: [], baselineSpecs: [], exemptSpecs: new Map(), trackers: {} }),
    {},
  );
  assert.match(md, /no spec/i);
});

test("the GitHub output carries the verdict flags, the title, and the body under a delimiter it cannot contain", () => {
  const report = ownershipReport(base);
  const body = renderOwnershipReport(report, {});
  const lines = ownershipOutputLines(report, body, "__DELIM_X__");
  assert.ok(lines.includes("has_findings=true"));
  assert.ok(lines.includes("tracker_lookup_failed=false"));
  assert.ok(lines.includes(`issue_title=${OWNERSHIP_ISSUE_TITLE}`));
  assert.ok(lines.includes("summary_md<<__DELIM_X__"));
  const open = lines.indexOf("summary_md<<__DELIM_X__");
  const close = lines.lastIndexOf("__DELIM_X__");
  assert.ok(close > open, "the heredoc is closed");
  assert.equal(lines.slice(open + 1, close).join("\n"), body);

  const failed = ownershipReport({ ...base, trackers: null });
  assert.ok(ownershipOutputLines(failed, "x", "D").includes("tracker_lookup_failed=true"));

  // A delimiter that occurs in the body would truncate the heredoc silently.
  assert.throws(() => ownershipOutputLines(report, "a line with __DELIM_X__ inside", "__DELIM_X__"), /delimiter/);
});
