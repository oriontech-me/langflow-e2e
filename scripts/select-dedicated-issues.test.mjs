// Unit tests for the `since`-window selection of the dedicated-issue contract
// sweep (issue #1037). Run with: npm run test:scripts
//
// Why these exist: the sweep runs with `continue-on-error: true` on a path that
// only fires on a `pode abrir` comment on an umbrella — which needs a red daily
// plus a human — so a window that selects nothing produced a green job and one
// ambiguous log line, and could not be proven before merge. These cover the
// comparison and the reporting on every PR instead.
//
// The fixtures use the real shapes: `createdAt` exactly as `gh issue list` emits
// it, and `since` exactly as `triage-dispatch.yml` stamps it
// (`date -u -d '-1 minute' +%Y-%m-%dT%H:%M:%SZ`).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isAtOrAfter,
  selectDedicatedIssues,
} from "./select-dedicated-issues.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const readWorkflow = (name) => fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", name), "utf8");

// The four dedicated issues the 2026-07-30 triage actually created, plus that
// day's umbrella — the data this selection was verified against by hand.
const REAL_LIST = [
  { number: 1126, createdAt: "2026-07-30T11:35:41Z", title: "[Daily #1121] mcp-client-regression: …" },
  { number: 1125, createdAt: "2026-07-30T11:35:39Z", title: "[Daily #1121] upload-via-component: …" },
  { number: 1124, createdAt: "2026-07-30T11:35:38Z", title: "[Daily #1121] keyboardComponentSearch: …" },
  { number: 1123, createdAt: "2026-07-30T11:35:36Z", title: "[Daily #1121] mcp-server-starter-projects: …" },
  { number: 1121, createdAt: "2026-07-30T10:46:15Z", title: "[Daily Failure] @stable tests failed on 2026-07-30 …" },
  { number: 1063, createdAt: "2026-07-29T11:40:12Z", title: "[Daily #1057] execution-error-notification: …" },
];

test("selects exactly the issues created at or after the stamped window", () => {
  // `date -u -d '-1 minute'` one minute before the first creation.
  const result = selectDedicatedIssues(REAL_LIST, { since: "2026-07-30T11:34:36Z" });

  assert.deepEqual(result.selected.sort(), [1123, 1124, 1125, 1126]);
  assert.equal(result.inWindow, 4);
  assert.equal(result.scanned, 6);
  assert.equal(result.oldestScanned, "2026-07-29T11:40:12Z");
  assert.deepEqual(result.warnings, [], "a healthy sweep warns about nothing");
});

test("the umbrella is selected by the window and left for the title check to exclude", () => {
  // Deliberate: the exclusion the contract relies on is BY TITLE, inside the
  // validator (`kind: umbrella`). When the sweep is scoped to open issues only,
  // an already-closed umbrella drops out by STATE and the title rule never runs —
  // which is what happened on 2026-07-30 and would have hidden a broken title
  // rule. The window must hand the umbrella over.
  const result = selectDedicatedIssues(REAL_LIST, { since: "2026-07-30T10:00:00Z" });

  assert.ok(result.selected.includes(1121), "the umbrella reaches the validator");
  assert.equal(result.inWindow, 5);
});

test("an issue created exactly at the boundary is included", () => {
  const result = selectDedicatedIssues(REAL_LIST, { since: "2026-07-30T11:35:36Z" });

  assert.ok(result.selected.includes(1123), ">=, not >");
  assert.equal(result.inWindow, 4);
});

test("compares instants, so a differently-formatted timestamp still resolves", () => {
  // A plain string `>=` gets this wrong: "2026-07-30T11:35:41Z" < "2026-07-30T11:34:36+00:00"
  // lexicographically, so the issue would silently drop out of the window.
  assert.equal(isAtOrAfter("2026-07-30T11:35:41Z", "2026-07-30T11:34:36+00:00"), true);
  assert.equal(isAtOrAfter("2026-07-30T11:35:41.123Z", "2026-07-30T11:34:36Z"), true);
  assert.equal(isAtOrAfter("2026-07-30T11:30:00Z", "2026-07-30T11:34:36Z"), false);

  const result = selectDedicatedIssues(REAL_LIST, { since: "2026-07-30T11:34:36+00:00" });
  assert.deepEqual(result.selected.sort(), [1123, 1124, 1125, 1126]);
});

test("an empty selection is reported as ambiguous, never as a pass", () => {
  // The #1037 condition: a broken window and a triage that created nothing are
  // indistinguishable from inside the sweep, so the log must say so.
  const result = selectDedicatedIssues(REAL_LIST, { since: "2026-07-31T00:00:00Z" });

  assert.equal(result.inWindow, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /NOTHING selected/);
  assert.match(result.warnings[0], /#1037/, "points at the issue that owns this risk");
});

test("a full page whose oldest issue is still in-window is flagged", () => {
  // The only shape where the page size can actually hide an in-window issue.
  const page = Array.from({ length: 5 }, (_, i) => ({
    number: 900 + i,
    createdAt: `2026-07-2${5 + i}T10:00:00Z`,
  }));

  const result = selectDedicatedIssues(page, { since: "2026-07-20T00:00:00Z", limit: 5 });

  assert.equal(result.truncated, true);
  assert.match(result.warnings.join(" "), /page is full/);
});

test("a full page that already spans the window is NOT flagged", () => {
  // Measured against the real repo: `--state all` returns a full page of 100 on
  // every run (the label has 114 issues), while the oldest of them predates the
  // window by weeks. Warning on page-full alone would fire every single time, and
  // a warning that always fires stops being read.
  const page = [
    { number: 1126, createdAt: "2026-07-30T11:35:41Z" },
    { number: 803, createdAt: "2026-07-10T10:00:00Z" },
    { number: 802, createdAt: "2026-07-09T10:00:00Z" },
    { number: 801, createdAt: "2026-07-08T10:00:00Z" },
    { number: 800, createdAt: "2026-07-07T10:00:00Z" },
  ];

  const result = selectDedicatedIssues(page, { since: "2026-07-30T11:34:36Z", limit: 5 });

  assert.equal(result.truncated, false, "the page demonstrably covers the whole window");
  assert.deepEqual(result.selected, [1126]);
  assert.deepEqual(result.warnings, []);
});

test("an unparseable createdAt is excluded AND surfaced", () => {
  const result = selectDedicatedIssues(
    [
      { number: 1, createdAt: "2026-07-30T11:35:41Z" },
      { number: 2, createdAt: "not a timestamp" },
      { number: 3 },
    ],
    { since: "2026-07-30T11:34:36Z" },
  );

  assert.deepEqual(result.selected, [1]);
  assert.match(result.warnings.join(" "), /unparseable createdAt/);
  assert.match(result.warnings.join(" "), /2 issue\(s\)/);
});

test("a missing or unparseable --since throws instead of selecting everything", () => {
  // Fail loud: the alternative is a sweep that checks the whole backlog, or none
  // of it, depending on how the comparison degrades.
  assert.throws(() => selectDedicatedIssues(REAL_LIST, { since: "" }), /--since is missing/);
  assert.throws(() => selectDedicatedIssues(REAL_LIST, { since: "yesterday" }), /--since is missing or not a parseable/);
});

test("an empty list is handled without throwing, and still warns", () => {
  const result = selectDedicatedIssues([], { since: "2026-07-30T11:34:36Z" });

  assert.deepEqual(result.selected, []);
  assert.equal(result.scanned, 0);
  assert.equal(result.oldestScanned, null);
  assert.match(result.warnings.join(" "), /NOTHING selected/);
});

// ── Agent-path wiring ───────────────────────────────────────────────────────
//
// The selection above is only reached if the step that calls it is still wired
// into `triage-dispatch.yml`'s `execute` job, in the right place, with the right
// window. That wiring has NEVER executed: every triage-dispatch run to date is a
// `propose` (the `execute` job needs a red daily plus a human "pode abrir"), so
// nothing but these assertions stands between a broken wiring and a green log.

test("the execute job stamps the window BEFORE the agent runs", () => {
  // Order is the whole contract: a timestamp taken after the agent would exclude
  // every issue the agent had already created, and the sweep would check zero
  // while reporting success.
  const text = readWorkflow("triage-dispatch.yml").split("\n");
  const execute = text.findIndex((l) => l.startsWith("  execute:"));
  assert.ok(execute > -1, "no `execute` job");

  const stamp = text.findIndex((l, i) => i > execute && l.includes("id: started"));
  const agent = text.findIndex((l, i) => i > execute && l.includes("anthropics/claude-code-action"));
  const guard = text.findIndex((l, i) => i > execute && l.includes("uses: ./.github/actions/guard-dedicated-issue"));

  assert.ok(stamp > -1 && agent > -1 && guard > -1, "stamp, agent or guard step missing from the execute job");
  assert.ok(stamp < agent, "the window must be stamped BEFORE the agent creates the issues");
  assert.ok(agent < guard, "the guard must run AFTER the agent, or there is nothing to check yet");
});

test("the guard's since input is bound to the stamped window, not to a literal", () => {
  const text = readWorkflow("triage-dispatch.yml");
  assert.match(text, /since: \$\{\{ steps\.started\.outputs\.at \}\}/);
  // The stamp's own shape is load-bearing: `select-dedicated-issues` parses it as
  // an instant, and the minute of slack absorbs runner/API clock skew.
  assert.match(text, /date -u -d '-1 minute' \+%Y-%m-%dT%H:%M:%SZ/);
});

test("the guard reports without blocking, and runs even when the agent died", () => {
  // `if: always()` — a triage that failed mid-way can still have created issues,
  // and those are precisely the ones worth checking. `continue-on-error` — a
  // malformed issue still carries evidence, so it gets a comment, not a red job.
  const lines = readWorkflow("triage-dispatch.yml").split("\n");
  const guard = lines.findIndex((l) => l.includes("uses: ./.github/actions/guard-dedicated-issue"));
  const block = lines.slice(Math.max(0, guard - 4), guard + 4).join("\n");
  assert.match(block, /if: always\(\)/);
  assert.match(block, /continue-on-error: true/);
});

test("the sweep path has an on-demand entry, so it is not only provable by coincidence", () => {
  // #1037's actual blocker: the sweep could only ever run inside a live `execute`,
  // an event that has not occurred once. `issue-contract-guard.yml` accepts a
  // `since` dispatch so the identical composite action can be exercised on real
  // issues from a branch, dry-run by default.
  const text = readWorkflow("issue-contract-guard.yml");
  assert.match(text, /^ {6}since:$/m, "no `since` dispatch input");
  assert.match(text, /since: \$\{\{ inputs\.since \}\}/, "the since input is not passed to the action");
  // Both inputs at once would silently check the issue and ignore the window.
  assert.match(text, /Reject an ambiguous dispatch/);
  assert.match(text, /dry_run:[\s\S]*default: true/, "a dispatch must not mutate issues unless asked");
});
