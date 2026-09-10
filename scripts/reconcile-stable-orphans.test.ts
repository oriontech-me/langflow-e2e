// Unit tests for the `@stable`-orphan reconciler's I/O half (issue #1746).
// Run with: npm run test:units
//
// Three seams are covered here, and each one fails SILENTLY if it breaks:
//
//   * `parseGitLogRaw` — a wrong blob column reads as "this spec never carried
//     `@stable`", which is the clean-looking verdict, not an error;
//   * `walkSpec` — "the removal is the revision walked immediately BEFORE the
//     last stable one" is an off-by-one whose wrong answer is a plausible
//     commit, so nothing downstream can notice;
//   * `buildTrackerIndex` — counting this check's OWN report issue as a tracker
//     would mark every orphan owned on the next run and empty the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import {
  EXEMPTIONS_PATH,
  GIT_LOG_FORMAT,
  ORPHAN_ISSUE_TITLE,
  buildTrackerIndex,
  isShallowRepository,
  parseExemptions,
  parseGitLogRaw,
  readBlobs,
  walkSpec,
  type RawIssue,
  type Revision,
} from "./reconcile-stable-orphans";
import { REPO_ROOT, type DeclaredTest } from "./lib/stable-tests";
import { historyKey } from "./lib/stable-orphans";

const RS = "\u001e";
const FS_ = "\u001f";

const SPEC = "core-components/example.spec.ts";
const REPO_SPEC = `tests/tests-automations/regression/${SPEC}`;

// ─── parseGitLogRaw ──────────────────────────────────────────────────────────

test("the log format and the parser agree on their separators", () => {
  assert.equal(GIT_LOG_FORMAT, `${RS}%H${FS_}%cI${FS_}%s`);
});

test("parses commit metadata and the POST-image blob of each revision", () => {
  const out = parseGitLogRaw(
    `${RS}aaa${FS_}2026-09-01T10:00:00Z${FS_}second\n\n` +
      ":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 M\t" +
      `${REPO_SPEC}\n` +
      `${RS}bbb${FS_}2026-08-01T10:00:00Z${FS_}first\n\n` +
      ":000000 100644 0000000000000000000000000000000000000000 3333333333333333333333333333333333333333 A\t" +
      `${REPO_SPEC}\n`,
  );
  assert.deepEqual(out, [
    {
      commit: "aaa",
      date: "2026-09-01T10:00:00Z",
      subject: "second",
      blob: "2".repeat(40),
    },
    {
      commit: "bbb",
      date: "2026-08-01T10:00:00Z",
      subject: "first",
      blob: "3".repeat(40),
    },
  ]);
});

test("a rename revision yields the blob, not either of its two paths", () => {
  // `--follow` is what keeps a moved spec's history intact, and a rename line
  // carries an EXTRA tab-separated path. Reading the content by blob rather
  // than by path is the whole reason the walk survives a move.
  const out = parseGitLogRaw(
    `${RS}ccc${FS_}2026-07-01T10:00:00Z${FS_}move the spec\n\n` +
      ":100644 100644 4444444444444444444444444444444444444444 5555555555555555555555555555555555555555 R096\told/path.spec.ts\tnew/path.spec.ts\n",
  );
  assert.deepEqual(out.map((r) => r.blob), ["5".repeat(40)]);
});

test("a revision with no raw diff line is dropped, not reported blank", () => {
  // Merge and empty commits look like this; neither changed the file.
  const out = parseGitLogRaw(`${RS}ddd${FS_}2026-07-01T10:00:00Z${FS_}merge\n\n`);
  assert.deepEqual(out, []);
});

test("a deletion revision is skipped — there is no content to parse at it", () => {
  const out = parseGitLogRaw(
    `${RS}eee${FS_}2026-07-01T10:00:00Z${FS_}delete\n\n` +
      ":100644 000000 6666666666666666666666666666666666666666 0000000000000000000000000000000000000000 D\t" +
      `${REPO_SPEC}\n`,
  );
  assert.deepEqual(out, []);
});

test("a subject containing the field separator's neighbours survives the split", () => {
  const out = parseGitLogRaw(
    `${RS}fff${FS_}2026-07-01T10:00:00Z${FS_}fix(x): drop @stable | keep :100644\n\n` +
      ":100644 100644 7777777777777777777777777777777777777777 8888888888888888888888888888888888888888 M\t" +
      `${REPO_SPEC}\n`,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].subject, "fix(x): drop @stable | keep :100644");
});

// ─── readBlobs ───────────────────────────────────────────────────────────────

test("readBlobs frames a batch on BYTES, so a non-ASCII blob decodes intact", () => {
  // The batch protocol declares each payload's size in bytes. Slicing the
  // decoded string instead would desynchronise on the first multi-byte
  // character — and every spec title in this suite is full of them.
  const shas = ["HEAD:package.json", "HEAD:CLAUDE.md"].map((rev) =>
    execFileSync("git", ["rev-parse", rev], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim(),
  );
  const blobs = readBlobs(shas);
  assert.equal(blobs.size, 2);
  for (const [i, rev] of ["HEAD:package.json", "HEAD:CLAUDE.md"].entries()) {
    const expected = execFileSync("git", ["show", rev], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(blobs.get(shas[i]), expected, `${rev} round-trips`);
  }
  assert.ok(
    (blobs.get(shas[1]) as string).includes("—"),
    "the fixture really does exercise multi-byte content",
  );
});

test("a sha the object store does not have is absent from the map, not empty in it", () => {
  const missing = "0".repeat(40);
  assert.equal(readBlobs([missing]).has(missing), false);
});

// ─── walkSpec ────────────────────────────────────────────────────────────────

function rev(commit: string, date: string, subject: string): Revision {
  return { commit, date, subject, blob: `blob-${commit}` };
}

function specSource(entries: Array<{ title: string; stable: boolean }>): string {
  return entries
    .map(
      (e) =>
        `test("${e.title}", { tag: [${e.stable ? '"@stable", ' : ""}"@regression"] }, async () => {});`,
    )
    .join("\n");
}

function deps(
  revisions: Revision[],
  contents: Record<string, string>,
  maxRevisions = 500,
  shallow = false,
) {
  return {
    revisionsOf: () => revisions,
    readBlobs: (shas: string[]) =>
      new Map(
        shas
          .filter((s) => s in contents)
          .map((s) => [s, contents[s]] as [string, string]),
      ),
    maxRevisions,
    shallow,
  };
}

const TITLE = "the loop component iterates";

test("the removal is the revision walked immediately BEFORE the last stable one", () => {
  const revisions = [
    rev("c3", "2026-09-01T00:00:00Z", "unrelated edit"),
    rev("c2", "2026-08-03T00:00:00Z", "chore(triage): auto-remove @stable"),
    rev("c1", "2026-07-01T00:00:00Z", "add the test"),
  ];
  const out = walkSpec(
    SPEC,
    [TITLE],
    deps(revisions, {
      "blob-c3": specSource([{ title: TITLE, stable: false }]),
      "blob-c2": specSource([{ title: TITLE, stable: false }]),
      "blob-c1": specSource([{ title: TITLE, stable: true }]),
    }),
  );
  const v = out[historyKey(SPEC, TITLE)];
  assert.equal(v.kind, "removed");
  assert.equal(
    v.kind === "removed" && v.removal.commit,
    "c2",
    "c1 still HAD the tag, so the commit that removed it is the next one forward",
  );
  assert.equal(
    v.kind === "removed" && v.removal.subject,
    "chore(triage): auto-remove @stable",
  );
});

test("a title absent from an older revision resolves as `never`, not as a removal", () => {
  const revisions = [
    rev("c2", "2026-09-01T00:00:00Z", "add the test, untagged"),
    rev("c1", "2026-07-01T00:00:00Z", "some other test"),
  ];
  const out = walkSpec(
    SPEC,
    [TITLE],
    deps(revisions, {
      "blob-c2": specSource([{ title: TITLE, stable: false }]),
      "blob-c1": specSource([{ title: "another test", stable: true }]),
    }),
  );
  assert.deepEqual(out[historyKey(SPEC, TITLE)], { kind: "never" });
});

test("a title present but never tagged through the whole history is `never`", () => {
  const revisions = [rev("c1", "2026-07-01T00:00:00Z", "add the test")];
  const out = walkSpec(
    SPEC,
    [TITLE],
    deps(revisions, {
      "blob-c1": specSource([{ title: TITLE, stable: false }]),
    }),
  );
  assert.deepEqual(out[historyKey(SPEC, TITLE)], { kind: "never" });
});

test("hitting the revision cap is UNKNOWN, never `never` (#1012)", () => {
  const revisions = [
    rev("c2", "2026-09-01T00:00:00Z", "b"),
    rev("c1", "2026-07-01T00:00:00Z", "a"),
  ];
  const out = walkSpec(
    SPEC,
    [TITLE],
    deps(
      revisions,
      {
        "blob-c2": specSource([{ title: TITLE, stable: false }]),
        "blob-c1": specSource([{ title: TITLE, stable: true }]),
      },
      1,
    ),
  );
  const v = out[historyKey(SPEC, TITLE)];
  assert.equal(v.kind, "unknown");
  assert.match(v.kind === "unknown" ? v.reason : "", /1-revision cap/);
});

test("a spec with no committed history is UNKNOWN, with the reason named", () => {
  const out = walkSpec(SPEC, [TITLE], deps([], {}));
  const v = out[historyKey(SPEC, TITLE)];
  assert.equal(v.kind, "unknown");
  assert.match(v.kind === "unknown" ? v.reason : "", /no committed history/);
});

test("a blob that cannot be read stops the walk as UNKNOWN, not as a verdict", () => {
  const revisions = [
    rev("c2", "2026-09-01T00:00:00Z", "b"),
    rev("c1", "2026-07-01T00:00:00Z", "a"),
  ];
  const out = walkSpec(SPEC, [TITLE], deps(revisions, {}));
  const v = out[historyKey(SPEC, TITLE)];
  assert.equal(v.kind, "unknown");
  assert.match(v.kind === "unknown" ? v.reason : "", /could not be read/);
});

test("a git failure is UNKNOWN for every title in that spec, with the reason", () => {
  const out = walkSpec(SPEC, [TITLE, "another"], {
    revisionsOf: () => {
      throw new Error("fatal: bad revision\nmore noise");
    },
    readBlobs: () => new Map(),
    maxRevisions: 500,
    shallow: false,
  });
  for (const t of [TITLE, "another"]) {
    const v = out[historyKey(SPEC, t)];
    assert.equal(v.kind, "unknown");
    assert.match(v.kind === "unknown" ? v.reason : "", /fatal: bad revision/);
  }
});

test("a tag present at HEAD but gone in the working tree is UNKNOWN, not attributed to HEAD", () => {
  // Local runs only — CI checks out clean. Naming HEAD as the removing commit
  // would put an innocent commit in a report a human acts on.
  const revisions = [rev("c1", "2026-09-01T00:00:00Z", "head")];
  const out = walkSpec(
    SPEC,
    [TITLE],
    deps(revisions, {
      "blob-c1": specSource([{ title: TITLE, stable: true }]),
    }),
  );
  const v = out[historyKey(SPEC, TITLE)];
  assert.equal(v.kind, "unknown");
  assert.match(v.kind === "unknown" ? v.reason : "", /uncommitted/);
});

test("several titles in one spec are resolved from a single walk", () => {
  const other = "a second test";
  const revisions = [
    rev("c2", "2026-09-01T00:00:00Z", "drop @stable from one of them"),
    rev("c1", "2026-07-01T00:00:00Z", "add both"),
  ];
  const out = walkSpec(
    SPEC,
    [TITLE, other],
    deps(revisions, {
      "blob-c2": specSource([
        { title: TITLE, stable: false },
        { title: other, stable: false },
      ]),
      "blob-c1": specSource([
        { title: TITLE, stable: true },
        { title: other, stable: false },
      ]),
    }),
  );
  assert.equal(out[historyKey(SPEC, TITLE)].kind, "removed");
  assert.deepEqual(out[historyKey(SPEC, other)], { kind: "never" });
});

// ─── parseExemptions ─────────────────────────────────────────────────────────

test("a well-formed declarations file parses", () => {
  const list = parseExemptions(
    JSON.stringify({
      exemptions: [
        { spec: "a/b.spec.ts", title: "t", reason: "because", ref: "#1039" },
      ],
    }),
    "test.json",
  );
  assert.deepEqual(list, [
    { spec: "a/b.spec.ts", title: "t", reason: "because", ref: "#1039" },
  ]);
});

test("a declaration with no reason is refused — a silent one is the defect", () => {
  assert.throws(
    () =>
      parseExemptions(
        JSON.stringify({ exemptions: [{ spec: "a.spec.ts", title: "t" }] }),
        "test.json",
      ),
    /missing a non-empty "reason"/,
  );
});

test("a malformed declarations file is a hard failure, never 'no exemptions'", () => {
  // Reading a broken file as empty would turn every declared absence into a
  // fresh orphan row and drown the real findings.
  assert.throws(() => parseExemptions("{ not json", "test.json"), /not valid JSON/);
  assert.throws(
    () => parseExemptions(JSON.stringify({ exemptions: {} }), "test.json"),
    /must have an "exemptions" array/,
  );
});

test("the committed declarations file parses and every entry names a real spec", () => {
  const file = path.join(REPO_ROOT, EXEMPTIONS_PATH);
  const list = parseExemptions(fs.readFileSync(file, "utf-8"), EXEMPTIONS_PATH);
  for (const e of list) {
    assert.ok(
      fs.existsSync(
        path.join(REPO_ROOT, "tests/tests-automations/regression", e.spec),
      ),
      `${e.spec} exists — a declaration for a vanished spec protects nothing`,
    );
  }
});

// ─── buildTrackerIndex ───────────────────────────────────────────────────────

function issue(over: Partial<RawIssue> = {}): RawIssue {
  return {
    number: 1,
    title: "an issue",
    body: "",
    html_url: "https://example.invalid/1",
    ...over,
  };
}

function candidate(over: Partial<DeclaredTest> = {}): DeclaredTest {
  return {
    title: TITLE,
    relativePath: SPEC,
    line: 1,
    tags: [],
    stable: false,
    fixme: false,
    // `modifier` is the declaring token behind `fixme` ("fixme" | "skip", or ""
    // for a plain `test()`), added to DeclaredTest by the inherited-spec triage
    // work, which needs to tell an operator WHICH token to unmute. The
    // reconciler ignores it; this factory line keeps every fixture in this file
    // compiling against the widened interface.
    modifier: "",
    unparseableTags: false,
    ...over,
  };
}

test("an issue naming the spec basename owns the removal", () => {
  const c = candidate();
  const index = buildTrackerIndex(
    [issue({ number: 42, body: "fails in example.spec.ts every day" })],
    [c],
  );
  assert.deepEqual(index[historyKey(SPEC, TITLE)].map((t) => t.number), [42]);
  assert.equal(index[historyKey(SPEC, TITLE)][0].matchedOn, "path");
});

test("an issue quoting the test title is recorded as the stronger match", () => {
  const c = candidate();
  const index = buildTrackerIndex(
    [issue({ number: 43, body: `example.spec.ts — "${TITLE}" is quarantined` })],
    [c],
  );
  assert.equal(index[historyKey(SPEC, TITLE)][0].matchedOn, "title");
});

test("an issue naming the full path under regression/ also owns it", () => {
  const c = candidate();
  const index = buildTrackerIndex([issue({ number: 44, body: SPEC })], [c]);
  assert.equal(index[historyKey(SPEC, TITLE)][0].number, 44);
});

test("a PR that happens to name the spec is not a tracker", () => {
  const c = candidate();
  const index = buildTrackerIndex(
    [issue({ number: 45, body: "example.spec.ts", pull_request: { url: "x" } })],
    [c],
  );
  assert.equal(index[historyKey(SPEC, TITLE)], undefined);
});

test("this check's OWN report issue never counts as a tracker", () => {
  // The report names every orphaned spec by construction. Counting it would
  // mark every orphan "owned" on the next run, empty the report, and make the
  // finding reappear the run after — an oscillation with no visible symptom.
  const c = candidate();
  const index = buildTrackerIndex(
    [issue({ number: 46, title: ORPHAN_ISSUE_TITLE, body: "example.spec.ts" })],
    [c],
  );
  assert.equal(index[historyKey(SPEC, TITLE)], undefined);
});

test("an issue naming a different spec owns nothing", () => {
  const c = candidate();
  const index = buildTrackerIndex(
    [issue({ number: 47, body: "other-thing.spec.ts is flaky" })],
    [c],
  );
  assert.deepEqual(index, {});
});

// ─── Wiring ──────────────────────────────────────────────────────────────────

test("the workflow takes the issue title from the script, never a second copy", () => {
  // Two spellings of the title are two identities: the workflow would open a
  // NEW issue every run while the matcher kept excluding the old one.
  const wf = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows/stable-orphan-reconcile.yml"),
    "utf-8",
  );
  assert.ok(
    !wf.includes(ORPHAN_ISSUE_TITLE),
    "the workflow must not hardcode the report issue's title",
  );
  assert.match(
    wf,
    /outputs\.issue_title/,
    "the workflow reads the title the script emitted",
  );
});

// The two properties the whole design leans on, neither of which was pinned.
// Structural, and #1226 is the standing reason that is the weaker thing — but a
// workflow cannot be exercised from a unit test at all, so the alternative here
// is not a behavioural guard, it is nothing.
test("the workflow checks out FULL history and never destroys the report on a lookup outage", () => {
  const wf = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows/stable-orphan-reconcile.yml"),
    "utf-8",
  );

  // Without it every row comes back UNKNOWN — loud, useless, and the benign
  // half of the pair. Pinned anyway: the reason lives in a comment that a tidy-up
  // can carry away with the line.
  assert.match(
    wf,
    /fetch-depth:\s*0/,
    "the reconcile job checks out full history — a shallow clone dates no removal",
  );

  // The destructive half. `has_findings` is `false` on a lookup outage for the
  // same reason it is false on a clean tree, so the CLOSE step without this
  // clause would comment on and close a standing issue listing real orphans —
  // silently, on a five-minute GitHub API blip, taking any human notes with it.
  /**
   * One step's YAML, from its `- name:` to the next one.
   *
   * A fixed `slice(0, N)` was used here and it is the wrong tool: it measures
   * PROSE, so adding a comment above the `if:` pushes the clauses past the
   * window and the guard fails on a change that altered no behaviour — which is
   * exactly what happened when this file grew one. The step boundary is what
   * the assertion actually means.
   */
  function stepBody(name: string): string {
    const start = wf.indexOf(`- name: ${name}`);
    assert.notEqual(start, -1, `the step "${name}" is still in this workflow`);
    const next = wf.indexOf("\n      - name: ", start + 1);
    return wf.slice(start, next === -1 ? undefined : next);
  }

  const closeStep = stepBody(
    "Close the report issue when there is nothing left to reconcile",
  );
  assert.match(
    closeStep,
    /tracker_lookup_failed == 'false'/,
    "the CLOSE step is barred when the issue lookup itself failed",
  );
  assert.match(
    closeStep,
    /gate_lookup_failed == 'false'/,
    "the CLOSE step is barred when a cited REFERENCE could not be looked up (#1783)",
  );

  const openStep = stepBody("Open or refresh the report issue");
  assert.match(
    openStep,
    /tracker_lookup_failed == 'false'/,
    "the REFRESH step is barred when the issue lookup itself failed — it rewrites the whole body",
  );
  assert.match(
    openStep,
    /gate_lookup_failed == 'false'/,
    "the REFRESH step is barred when a cited REFERENCE could not be looked up either (#1783) — a reference that does not exist is a finding, one we could not ask about is an outage, and refreshing on the second replaces real findings with a page that says less",
  );

  // A `#` inside a folded block scalar is CONTENT, not a comment: YAML only
  // treats `#` as a comment outside a scalar. A note written inside an
  // `if: >-` block therefore lands in the expression GitHub Actions evaluates,
  // and the workflow fails to parse. This file grew one such comment while
  // #1783 was being written.
  const lines = wf.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("if: >-")) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (lines[j].length - lines[j].trimStart().length <= indent) break;
      assert.ok(
        !lines[j].trimStart().startsWith("#"),
        `line ${j + 1} is a comment INSIDE an \`if: >-\` block, where YAML reads it as part of the expression`,
      );
    }
  }
});

// ─── Review findings, pinned ─────────────────────────────────────────────────

test("a SHALLOW clone reports UNKNOWN, never `never` — the false-clean the check exists to prevent", () => {
  // Measured on a real `git clone --depth 1` of this branch before the fix:
  // "0 orphaned, 0 undecidable", both live orphans gone and both valid #1039
  // declarations reported as expired. The revision cap cannot catch it — a
  // truncated history runs out long before 500 revisions.
  const revisions = [rev("c1", "2026-09-01T00:00:00Z", "the graft commit")];
  const out = walkSpec(
    SPEC,
    [TITLE],
    deps(
      revisions,
      { "blob-c1": specSource([{ title: TITLE, stable: false }]) },
      500,
      /* shallow */ true,
    ),
  );
  const v = out[historyKey(SPEC, TITLE)];
  assert.equal(v.kind, "unknown");
  assert.match(v.kind === "unknown" ? v.reason : "", /SHALLOW clone/);
  assert.match(v.kind === "unknown" ? v.reason : "", /fetch-depth: 0/);
});

test("a `never` OBSERVED inside a shallow window is still `never`", () => {
  // The distinction is what keeps the fix from degrading every report on a
  // shallow clone into noise: a title absent at a revision we actually READ
  // means the test's whole life is inside the window, whatever the depth.
  const revisions = [
    rev("c2", "2026-09-01T00:00:00Z", "add the test, untagged"),
    rev("c1", "2026-07-01T00:00:00Z", "the graft commit"),
  ];
  const out = walkSpec(
    SPEC,
    [TITLE],
    deps(
      revisions,
      {
        "blob-c2": specSource([{ title: TITLE, stable: false }]),
        "blob-c1": specSource([{ title: "another test", stable: true }]),
      },
      500,
      /* shallow */ true,
    ),
  );
  assert.deepEqual(out[historyKey(SPEC, TITLE)], { kind: "never" });
});

test("isShallowRepository answers for the repository the walk actually reads", () => {
  // Asserted against git's own marker file rather than against a constant: this
  // lane's own checkout IS shallow (`pr-validation.yml` clones at the default
  // depth), so `assert.equal(…, false)` would be an environment-dependent
  // assertion that passes locally and reddens every PR — which is exactly how
  // the first version of this test failed.
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  }).trim();
  const marker = path.resolve(REPO_ROOT, commonDir, "shallow");
  assert.equal(
    isShallowRepository(),
    fs.existsSync(marker),
    "the verdict must track git's own shallow marker, in either direction",
  );
});

test("a longer basename that CONTAINS this spec's does not own its removal", () => {
  // Three such pairs exist in this tree — `run-flow.spec.ts` inside
  // `api-run-flow.spec.ts` is one of them, and `run-flow.spec.ts` is an orphan
  // the reconciler reports today. A bare `includes` would silence it the day
  // anyone files an issue about the longer spec.
  const c = candidate({ relativePath: "flow-functionality/run-flow.spec.ts" });
  const index = buildTrackerIndex(
    [issue({ number: 48, body: "api-run-flow.spec.ts times out" })],
    [c],
  );
  assert.deepEqual(index, {});
});

test("the same basename at a real path boundary still owns it", () => {
  const c = candidate({ relativePath: "flow-functionality/run-flow.spec.ts" });
  for (const body of [
    "run-flow.spec.ts times out",
    "see tests/tests-automations/regression/flow-functionality/run-flow.spec.ts",
    "`run-flow.spec.ts` is quarantined",
    "(run-flow.spec.ts)",
  ]) {
    const index = buildTrackerIndex([issue({ number: 49, body })], [c]);
    assert.equal(
      index[historyKey("flow-functionality/run-flow.spec.ts", TITLE)]?.[0]
        ?.number,
      49,
      `"${body}" names the spec`,
    );
  }
});
