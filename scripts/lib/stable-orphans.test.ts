// Unit tests for the `@stable`-orphan reconciler's PURE half (issue #1746).
// Run with: npm run test:units
//
// What this module must never do is produce a CLEAN-LOOKING verdict it did not
// earn. Three hand audits (#974, #1504, plus the #1460 case a human caught by
// accident) all failed the same way — a removal nobody owned looked like
// nothing at all — so the negative cases below are the load-bearing ones: an
// undecidable history, a failed issue lookup, and a declaration whose reason
// has expired must each surface rather than fold into "no orphans".
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasFindings,
  historyKey,
  laneTagsOf,
  reconcile,
  renderReport,
  selectCandidates,
  type ExemptionDecl,
  type HistoryVerdict,
  type TrackerRef,
} from "./stable-orphans";
import type { DeclaredTest } from "./stable-tests";

function declared(over: Partial<DeclaredTest> = {}): DeclaredTest {
  return {
    title: "a test",
    relativePath: "core-components/example.spec.ts",
    line: 10,
    tags: ["@regression"],
    stable: false,
    fixme: false,
    // The declaring token behind `fixme` — see the same line in
    // scripts/reconcile-stable-orphans.test.ts for why the interface gained it.
    modifier: "",
    unparseableTags: false,
    ...over,
  };
}

const REMOVED: HistoryVerdict = {
  kind: "removed",
  removal: {
    commit: "32ac9a15d9dcb45c777c835f0c7a983d24e0f067",
    date: "2026-08-03T11:39:26Z",
    subject: "chore(triage): auto-remove @stable from 1 hard-failing test(s)",
  },
};

const RENDER = { exemptionsPath: "scripts/lib/stable-orphan-exemptions.json" };

function historyFor(t: DeclaredTest, v: HistoryVerdict) {
  return { [historyKey(t.relativePath, t.title)]: v };
}

// ─── Candidate selection ─────────────────────────────────────────────────────

test("a test carrying @stable is not a candidate", () => {
  const t = declared({ stable: true, tags: ["@stable"] });
  assert.deepEqual(selectCandidates([t]), []);
});

test("@stable inherited from a describe block keeps a test out of the candidates", () => {
  // Playwright applies a suite tag to every test inside, and the daily's
  // `--grep "@stable"` honours it — so such a test IS in the daily, and
  // reporting it as an unowned removal would be a false orphan.
  const t = declared({ stable: true, tags: [] });
  assert.deepEqual(selectCandidates([t]), []);
});

test("a lane-gated test is not a candidate, on any of the three selectors", () => {
  for (const tag of ["@destructive", "@enterprise", "@serving"]) {
    const t = declared({ tags: [tag, "@regression"] });
    assert.deepEqual(laneTagsOf(t), [tag]);
    assert.deepEqual(
      selectCandidates([t]),
      [],
      `${tag} keeps a test out of the daily by design (#1010) — its missing @stable is not an orphan`,
    );
  }
});

test("a plain non-@stable test IS a candidate", () => {
  const t = declared();
  assert.deepEqual(selectCandidates([t]), [t]);
});

// ─── historyKey ──────────────────────────────────────────────────────────────

test("historyKey cannot collide across (path, title) pairs", () => {
  // A printable separator would let "a/b.spec.ts" + " x" collide with
  // "a/b.spec.ts " + "x". The key is only ever built from a real path and a
  // real title, but a collision here silently attributes one test's removal
  // history to another.
  assert.notEqual(
    historyKey("a/b.spec.ts", " x"),
    historyKey("a/b.spec.ts ", "x"),
  );
});

// ─── Classification ──────────────────────────────────────────────────────────

test("a dated removal that no open issue names is an orphan", () => {
  const t = declared();
  const v = reconcile({
    tests: [t],
    history: historyFor(t, REMOVED),
    trackers: {},
    exemptions: [],
  });
  assert.equal(v.orphaned.length, 1);
  assert.equal(v.owned.length, 0);
  assert.equal(v.orphaned[0].removal?.commit, REMOVED.removal!.commit);
  assert.ok(hasFindings(v));
});

test("a dated removal an OPEN issue names is owned, not orphaned", () => {
  // Rule 1 from the hand audits: the criterion is the ABSENCE of an open
  // tracker. #1460 closed WITH the restore performed, and keying on the
  // tracker's state would have reported two false orphans.
  const t = declared();
  const tracker: TrackerRef = {
    number: 1744,
    title: "restore @stable on the loop template test",
    url: "https://example.invalid/1744",
    matchedOn: "title",
  };
  const v = reconcile({
    tests: [t],
    history: historyFor(t, REMOVED),
    trackers: { [historyKey(t.relativePath, t.title)]: [tracker] },
    exemptions: [],
  });
  assert.deepEqual(v.orphaned, []);
  assert.equal(v.owned.length, 1);
  assert.equal(v.owned[0].trackers[0].number, 1744);
  assert.equal(
    hasFindings(v),
    false,
    "an owned removal is reported for transparency but is not a finding — refreshing an issue for it every run is how a mechanism becomes noise nobody reads (#1252)",
  );
});

test("a test that never carried @stable is counted, never listed", () => {
  const t = declared();
  const v = reconcile({
    tests: [t],
    history: historyFor(t, { kind: "never" }),
    trackers: {},
    exemptions: [],
  });
  assert.deepEqual(v.orphaned, []);
  assert.deepEqual(v.unknown, []);
  assert.equal(v.counts.neverStable, 1);
  assert.equal(hasFindings(v), false);
});

test("an undecidable history is reported with its reason, not dropped (#1012)", () => {
  const t = declared();
  const v = reconcile({
    tests: [t],
    history: historyFor(t, { kind: "unknown", reason: "the walk hit the cap" }),
    trackers: {},
    exemptions: [],
  });
  assert.deepEqual(v.orphaned, []);
  assert.equal(v.unknown.length, 1);
  assert.match(v.unknown[0].reason ?? "", /hit the cap/);
  assert.ok(hasFindings(v), "undecidable is a finding, not clean");
});

test("a candidate with no history verdict at all is unknown, not clean", () => {
  const t = declared();
  const v = reconcile({ tests: [t], history: {}, trackers: {}, exemptions: [] });
  assert.equal(v.unknown.length, 1);
  assert.equal(v.orphaned.length, 0);
});

test("an unreadable tag option is unknown before history is even consulted", () => {
  const t = declared({ unparseableTags: true });
  const v = reconcile({
    tests: [t],
    history: historyFor(t, REMOVED),
    trackers: {},
    exemptions: [],
  });
  assert.equal(v.unknown.length, 1);
  assert.match(v.unknown[0].reason ?? "", /inline array of string literals/);
});

test("a failed issue lookup makes ownership undecided, never 'nobody owns it'", () => {
  // The difference between a finding and an outage. Reporting these as orphans
  // would open an issue naming every quarantined test on the first day GitHub
  // rate-limits the sweep.
  const t = declared();
  const v = reconcile({
    tests: [t],
    history: historyFor(t, REMOVED),
    trackers: {},
    exemptions: [],
    trackerLookupError: "HTTP 403",
  });
  assert.deepEqual(v.orphaned, []);
  assert.equal(v.unknown.length, 1);
  assert.match(v.unknown[0].reason ?? "", /HTTP 403/);
  assert.equal(
    v.unknown[0].removal?.commit,
    REMOVED.removal!.commit,
    "the removal evidence survives — only the ownership half is undecided",
  );
});

test("a lookup failure does not suppress the declared-exempt classification", () => {
  // The exemption is decided from the source and the history alone; making it
  // depend on GitHub would turn a rate-limited sweep into two dozen rows a
  // human has already ruled on.
  const t = declared();
  const e: ExemptionDecl = {
    spec: t.relativePath,
    title: t.title,
    reason: "not bundled in the tested image",
    ref: "#1039",
  };
  const v = reconcile({
    tests: [t],
    history: historyFor(t, REMOVED),
    trackers: {},
    exemptions: [e],
    trackerLookupError: "HTTP 403",
  });
  assert.equal(v.exempt.length, 1);
  assert.deepEqual(v.unknown, []);
});

// ─── Two states, not one (rule 3) ────────────────────────────────────────────

test("a test.fixme'd removal is reported as running NOWHERE, not just off the daily", () => {
  const offDaily = declared({ title: "off the daily" });
  const nowhere = declared({ title: "runs nowhere", fixme: true });
  const v = reconcile({
    tests: [offDaily, nowhere],
    history: {
      ...historyFor(offDaily, REMOVED),
      ...historyFor(nowhere, REMOVED),
    },
    trackers: {},
    exemptions: [],
  });
  assert.equal(v.orphaned.length, 2);
  const md = renderReport(v, RENDER);
  assert.match(md, /runs nowhere.*`test\.fixme` too/);
  assert.match(md, /not in the daily/);
});

// ─── Declarations, verified in both directions (rule 4 / #1084) ──────────────

const EXEMPT_SPEC = "core-functionality/model-provider/groq-provider.spec.ts";
const EXEMPT_TITLE = "the Groq component configures the API key";
const EXEMPTION: ExemptionDecl = {
  spec: EXEMPT_SPEC,
  title: EXEMPT_TITLE,
  reason: "the components are not bundled in the tested image",
  ref: "#1039",
};

test("a declaration that still holds exempts the row and is not a finding", () => {
  const t = declared({ relativePath: EXEMPT_SPEC, title: EXEMPT_TITLE });
  const v = reconcile({
    tests: [t],
    history: historyFor(t, REMOVED),
    trackers: {},
    exemptions: [EXEMPTION],
  });
  assert.deepEqual(v.orphaned, []);
  assert.equal(v.exempt.length, 1);
  assert.deepEqual(v.staleExemptions, []);
  assert.equal(hasFindings(v), false);
});

test("a declaration whose test carries @stable again is reported as expired", () => {
  const t = declared({
    relativePath: EXEMPT_SPEC,
    title: EXEMPT_TITLE,
    stable: true,
    tags: ["@stable"],
  });
  const v = reconcile({
    tests: [t],
    history: {},
    trackers: {},
    exemptions: [EXEMPTION],
  });
  assert.equal(v.staleExemptions.length, 1);
  assert.match(v.staleExemptions[0].reason, /carries `@stable` again/);
  assert.ok(hasFindings(v));
});

test("a declaration whose test was renamed is reported, never silently dropped", () => {
  const t = declared({ relativePath: EXEMPT_SPEC, title: "a new title" });
  const v = reconcile({
    tests: [t],
    history: historyFor(t, REMOVED),
    trackers: {},
    exemptions: [EXEMPTION],
  });
  assert.equal(v.staleExemptions.length, 1);
  assert.match(v.staleExemptions[0].reason, /no test with this title exists/);
  // …and the renamed test is now an unowned orphan in its own right.
  assert.equal(v.orphaned.length, 1);
});

test("a declaration on a test that gained a lane tag is reported as redundant", () => {
  const t = declared({
    relativePath: EXEMPT_SPEC,
    title: EXEMPT_TITLE,
    tags: ["@destructive"],
  });
  const v = reconcile({
    tests: [t],
    history: {},
    trackers: {},
    exemptions: [EXEMPTION],
  });
  assert.equal(v.staleExemptions.length, 1);
  assert.match(v.staleExemptions[0].reason, /@destructive/);
});

test("a declaration on a test that never carried @stable is reported as justifying nothing", () => {
  const t = declared({ relativePath: EXEMPT_SPEC, title: EXEMPT_TITLE });
  const v = reconcile({
    tests: [t],
    history: historyFor(t, { kind: "never" }),
    trackers: {},
    exemptions: [EXEMPTION],
  });
  assert.equal(v.staleExemptions.length, 1);
  assert.match(v.staleExemptions[0].reason, /never carried `@stable`/);
});

test("a declaration whose history is undecidable is reported unverified, not honoured", () => {
  const t = declared({ relativePath: EXEMPT_SPEC, title: EXEMPT_TITLE });
  const v = reconcile({
    tests: [t],
    history: historyFor(t, { kind: "unknown", reason: "shallow clone" }),
    trackers: {},
    exemptions: [EXEMPTION],
  });
  assert.deepEqual(v.staleExemptions, []);
  assert.equal(v.unverifiedExemptions.length, 1);
  assert.match(v.unverifiedExemptions[0].reason, /shallow clone/);
  assert.ok(hasFindings(v));
});

// ─── Rendering ───────────────────────────────────────────────────────────────

test("the report names the removing commit and its date for every orphan", () => {
  const t = declared();
  const v = reconcile({
    tests: [t],
    history: historyFor(t, REMOVED),
    trackers: {},
    exemptions: [],
  });
  const md = renderReport(v, RENDER);
  assert.match(md, /32ac9a15/);
  assert.match(md, /2026-08-03/);
  assert.match(md, /auto-remove @stable/);
  assert.match(md, /\*\*1 orphaned\*\*/);
});

test("a title containing a pipe or a newline cannot break the table", () => {
  const t = declared({ title: "a | b\nc" });
  const v = reconcile({
    tests: [t],
    history: historyFor(t, REMOVED),
    trackers: {},
    exemptions: [],
  });
  const md = renderReport(v, RENDER);
  const row = md
    .split("\n")
    .find((l) => l.includes("a \\| b"))!;
  assert.ok(row, "the escaped title is on a single row");
  assert.equal(
    row.replace(/\\\|/g, "").split("|").length - 1,
    5,
    "an orphan row keeps exactly the 4 columns' worth of UNESCAPED delimiters",
  );
});

test("the footer accounts for every declared test, including the ones not listed", () => {
  const stable = declared({ title: "stable", stable: true, tags: ["@stable"] });
  const lane = declared({ title: "lane", tags: ["@enterprise"] });
  const never = declared({ title: "never" });
  const orphan = declared({ title: "orphan" });
  const v = reconcile({
    tests: [stable, lane, never, orphan],
    history: {
      ...historyFor(never, { kind: "never" }),
      ...historyFor(orphan, REMOVED),
    },
    trackers: {},
    exemptions: [],
  });
  assert.deepEqual(v.counts, {
    declared: 4,
    stable: 1,
    laneGated: 1,
    neverStable: 1,
  });
  assert.match(renderReport(v, RENDER), /Scanned 4 declared test\(s\)/);
});

test("a clean verdict still renders a report and reports no findings", () => {
  const v = reconcile({ tests: [], history: {}, trackers: {}, exemptions: [] });
  assert.equal(hasFindings(v), false);
  assert.match(renderReport(v, RENDER), /\*\*0 orphaned\*\*/);
});
