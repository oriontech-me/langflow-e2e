// Unit tests for the file-watcher's area table and its guards (issue #1092).
//
// Two halves. The synthetic ones pin the fail-closed rules — a missing monitored
// path and an unclassified `lfx` subtree must both be reported, because the bug
// this issue fixes was that neither was. The ones against the REAL table pin the
// decision record itself: every subtree classified, every out-of-scope entry
// carrying a reason, every mapped area name real. A typo in an area name would
// silently drop that subtree from the sweep — the failure mode, again.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  AREAS,
  BODY_DELIMITER,
  DOC_DEPS_EXEMPT_FILES,
  assertValidSince,
  parseArgs,
  LANGFLOW_AREAS,
  LFX_CLASSIFICATION,
  LFX_ROOT,
  MAX_COMMITS_PER_AREA,
  PARTIAL,
  RELEASE_LINES_TRACKED,
  buildAreas,
  checkDocDeps,
  classifyDepToken,
  detectChangedAreas,
  findLfxDrift,
  findMissingPaths,
  matchGlob,
  parseDocDeps,
  parseRefList,
  pickReleaseBranches,
  renderIssueBody,
} from "./watch-upstream-areas.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const AREA_A = {
  area: "Area A",
  tags: ["@one", "@two"],
  checklist: "AREA 1",
  paths: ["src/backend/a.py"],
};
const AREA_B = { area: "Area B", tags: ["@three"], checklist: "AREA 2", paths: ["src/frontend/b/"] };

// ---------- buildAreas ----------

test("buildAreas folds classified lfx subtrees into their area", () => {
  const areas = buildAreas({
    areas: [AREA_A, AREA_B],
    classification: {
      base: { area: PARTIAL },
      "base/agents": { area: "Area A" },
      graph: { area: "Area A" },
      components: { area: null, reason: "packaging axis" },
    },
    lfxRoot: "src/lfx/src/lfx",
  });

  assert.deepEqual(areas[0].paths, [
    "src/backend/a.py",
    "src/lfx/src/lfx/base/agents/",
    "src/lfx/src/lfx/graph/",
  ]);
  // Out-of-scope and PARTIAL entries contribute nothing to any path list.
  assert.deepEqual(areas[1].paths, ["src/frontend/b/"]);
});

test("buildAreas emits a module key without a trailing slash", () => {
  const [area] = buildAreas({
    areas: [AREA_A],
    classification: { "settings.py": { area: "Area A" } },
    lfxRoot: "lfx",
  });
  assert.deepEqual(area.paths, ["src/backend/a.py", "lfx/settings.py"]);
});

test("buildAreas throws when a subtree maps to an area that does not exist", () => {
  assert.throws(
    () =>
      buildAreas({
        areas: [AREA_A],
        classification: { graph: { area: "Aera A" } },
      }),
    /unknown area\(s\): Aera A/,
  );
});

// ---------- findMissingPaths ----------

test("findMissingPaths names the area of every path absent from the checkout", () => {
  const present = new Set(["src/backend/a.py"]);
  const missing = findMissingPaths({
    areas: [AREA_A, AREA_B],
    exists: (p) => present.has(p),
  });
  assert.deepEqual(missing, [{ area: "Area B", path: "src/frontend/b/" }]);
});

test("findMissingPaths strips the trailing slash before probing", () => {
  const probed = [];
  findMissingPaths({
    areas: [AREA_B],
    exists: (p) => {
      probed.push(p);
      return true;
    },
  });
  assert.deepEqual(probed, ["src/frontend/b"]);
});

// ---------- findLfxDrift ----------

const driftFixture = {
  classification: {
    base: { area: PARTIAL },
    "base/agents": { area: "Area A" },
    graph: { area: "Area A" },
    components: { area: null, reason: "packaging axis" },
  },
  lfxRoot: "lfx",
};

test("findLfxDrift reports a subtree that upstream added and nothing classifies", () => {
  const tree = { lfx: ["base", "graph", "components", "deployments"], "lfx/base": ["agents"] };
  const drift = findLfxDrift({ ...driftFixture, listChildren: (dir) => tree[dir] ?? null });
  assert.deepEqual(drift.unclassified, ["deployments"]);
  assert.deepEqual(drift.stale, []);
});

test("findLfxDrift recurses into a PARTIAL subtree", () => {
  const tree = { lfx: ["base", "graph", "components"], "lfx/base": ["agents", "newvendor"] };
  const drift = findLfxDrift({ ...driftFixture, listChildren: (dir) => tree[dir] ?? null });
  assert.deepEqual(drift.unclassified, ["base/newvendor"]);
  assert.deepEqual(drift.scanned, ["lfx", "lfx/base"]);
});

test("findLfxDrift reports an entry whose subtree is gone as stale, not as a failure", () => {
  const tree = { lfx: ["base", "components"], "lfx/base": ["agents"] };
  const drift = findLfxDrift({ ...driftFixture, listChildren: (dir) => tree[dir] ?? null });
  assert.deepEqual(drift.stale, ["graph"]);
  assert.deepEqual(drift.unclassified, []);
});

test("findLfxDrift throws when a scanned level is absent — an unverifiable record is not a clean one", () => {
  assert.throws(
    () => findLfxDrift({ ...driftFixture, listChildren: () => null }),
    /lfx is not a directory in the checkout/,
  );
});

// ---------- detectChangedAreas ----------

test("detectChangedAreas skips areas with no commits and caps the listing", () => {
  const commits = Array.from({ length: 9 }, (_, i) => `abc${i} commit ${i}`).join("\n");
  const changed = detectChangedAreas({
    areas: [AREA_A, AREA_B],
    commitsFor: (paths) => (paths.includes("src/backend/a.py") ? commits : "   \n  "),
  });

  assert.equal(changed.length, 1);
  assert.equal(changed[0].area, "Area A");
  assert.equal(changed[0].grep, "@one|@two");
  assert.equal(changed[0].commits.length, MAX_COMMITS_PER_AREA);
  assert.equal(changed[0].commits[0], "abc0 commit 0");
});

// ---------- renderIssueBody ----------

const RENDER_ARGS = {
  since: "24 hours ago",
  today: "2026-07-30",
  areas: [
    {
      area: "Flow CRUD & Canvas",
      grep: "@workspace|@release",
      checklist: "AREA 2 — Flow CRUD | AREA 3 — Folders",
      commits: ["abc1234 fix(frontend): something"],
    },
  ],
};

test("renderIssueBody escapes the pipes that would shred the table", () => {
  const row = renderIssueBody(RENDER_ARGS)
    .split("\n")
    .find((l) => l.startsWith("| Flow CRUD"));
  // Three columns, so exactly four unescaped delimiters — every `|` inside a
  // cell (the --grep alternation, the multi-section checklist) must be escaped.
  assert.equal(row.replace(/\\\|/g, "").split("|").length - 1, 4);
  assert.match(row, /--grep "@workspace\\\|@release"/);
  assert.match(row, /AREA 2 — Flow CRUD \\\| AREA 3 — Folders/);
});

test("renderIssueBody carries the window and one commit block per area", () => {
  const body = renderIssueBody(RENDER_ARGS);
  assert.match(body, /\*\*Window:\*\* `24 hours ago`/);
  assert.match(body, /\*\*Date:\*\* 2026-07-30/);
  assert.match(body, /#### Flow CRUD & Canvas\n```\nabc1234 fix\(frontend\): something\n```/);
});

test("a hostile commit subject cannot close the heredoc output", () => {
  // Every commit subject in the body is untrusted upstream input. It must not be
  // able to end the $GITHUB_OUTPUT value early and inject further outputs.
  const changed = detectChangedAreas({
    areas: [AREA_A],
    commitsFor: () => `evil \${process.exit(1)} \`whoami\`\n${BODY_DELIMITER}\nbody=pwned`,
  });
  const body = renderIssueBody({ since: "24 hours ago", today: "2026-07-30", areas: changed });

  assert.equal(
    body.split("\n").some((l) => l === BODY_DELIMITER),
    false,
  );
  // The other two lines survive verbatim — the guard drops the delimiter only.
  assert.match(body, /evil \$\{process\.exit\(1\)\} `whoami`/);
  assert.match(body, /^body=pwned$/m);
});

// ---------- the real table ----------

test("every lfx entry is either mapped to a real area or out of scope with a reason", () => {
  const names = new Set(LANGFLOW_AREAS.map((a) => a.area));
  for (const [key, entry] of Object.entries(LFX_CLASSIFICATION)) {
    if (entry.area === PARTIAL) continue;
    if (entry.area === null) {
      assert.ok(
        entry.reason && entry.reason.length > 20,
        `${key} is out of scope but carries no usable reason — the record is the deliverable of #1092`,
      );
    } else {
      assert.ok(names.has(entry.area), `${key} maps to unknown area "${entry.area}"`);
    }
  }
});

test("the lfx package is actually covered — the blind spot #1092 is about", () => {
  const lfxPaths = AREAS.flatMap((a) => a.paths).filter((p) => p.startsWith(LFX_ROOT));
  assert.ok(lfxPaths.length >= 20, `only ${lfxPaths.length} lfx paths are watched`);

  const mcp = AREAS.find((a) => a.area === "MCP Server");
  // The exact path whose change broke all six stdio registrations (#1091).
  assert.ok(mcp.paths.includes(`${LFX_ROOT}/base/mcp/`));

  const agents = AREAS.find((a) => a.area === "Agents & Agentic Flows");
  assert.ok(agents.paths.includes(`${LFX_ROOT}/base/agents/`));
});

test("area names and paths are unique, and every area keeps tags plus a checklist", () => {
  const names = AREAS.map((a) => a.area);
  assert.equal(new Set(names).size, names.length);
  for (const area of AREAS) {
    assert.ok(area.tags.length > 0, `${area.area} has no tags — the issue would print an empty --grep`);
    assert.ok(area.checklist.length > 0, `${area.area} has no checklist reference`);
    assert.equal(new Set(area.paths).size, area.paths.length, `${area.area} lists a path twice`);
    for (const p of area.paths) {
      assert.ok(p.startsWith("src/"), `${area.area} watches a non-source path: ${p}`);
    }
  }
});

test("file-watcher.yml runs both modes and consumes every output this script emits", () => {
  // A table nothing reads, or an output name that drifted on one side only,
  // would restore the silence this issue is about.
  const yml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/file-watcher.yml"), "utf8");
  assert.match(yml, /watch-upstream-areas\.mjs --mode=check/);
  assert.match(yml, /watch-upstream-areas\.mjs --mode=detect/);
  assert.match(yml, /steps\.detect\.outputs\.title/);
  assert.match(yml, /steps\.detect\.outputs\.body/);
  // The output that GATES issue creation. Renaming it on either side would leave
  // a green job that never opens an issue — a silent fail-open.
  assert.match(yml, /steps\.detect\.outputs\.has_changes == 'true'/);
  // The body reaches github-script through the environment. Interpolating it
  // into the script body would put an upstream commit subject inside a JS
  // template literal.
  assert.match(yml, /body: process\.env\.ISSUE_BODY/);
  // Issue creation needs an explicit grant; every other issue-opening workflow
  // in the repo declares one.
  assert.match(yml, /permissions:\s*\n\s*contents: read\s*\n\s*issues: write/);
  // Labels must exist in the repo — GitHub silently creates unknown ones.
  assert.match(yml, /labels: \['needs-triage', 'automated'\]/);
  // The guard runs first for early annotations, but must not suppress the report
  // for the healthy areas; the job is failed afterwards instead.
  assert.ok(
    yml.indexOf("--mode=check") < yml.indexOf("--mode=detect"),
    "the existence guard must precede the change sweep",
  );
  assert.match(yml, /id: guard\s*\n\s*continue-on-error: true/);
  assert.match(yml, /steps\.guard\.outcome == 'failure'/);
});

// ---------- the window ----------

test("assertValidSince accepts the documented forms and rejects what git would guess at", () => {
  for (const good of [
    "24 hours ago",
    "3 days ago",
    "1 week ago",
    "2 months ago",
    "yesterday",
    "2026-07-15",
    "2026-07-15 17:24",
    "2026-07-15T17:24:00-0700",
  ]) {
    assert.doesNotThrow(() => assertValidSince(good), `${good} should be accepted`);
  }
  // Measured against the real clone: "undefined" selects 0 commits (a green run
  // that looks like a quiet day) and "last thursdya" selects 200 (12 of 13 areas
  // fire). approxidate never errors, so the input is validated here instead.
  for (const bad of ["undefined", "last thursdya", "2026-07-15 to 2026-07-16", "", "yesterdya", "24 hours"]) {
    assert.throws(() => assertValidSince(bad), /is not an accepted window/, `${bad} should be rejected`);
  }
});

// ---------- parseArgs ----------

test("parseArgs accepts both --flag value and --flag=value", () => {
  assert.deepEqual(parseArgs(["--mode=detect", "--root", "up", "--since=2026-07-15"]), {
    mode: "detect",
    root: "up",
    since: "2026-07-15",
    releases: "",
    ref: "HEAD",
    changed: "",
  });
  // check-docs adds two flags; `--changed` defaults to empty, which is what makes
  // the diff-scoped severity opt-in rather than silently absent (#1298).
  assert.deepEqual(parseArgs(["--mode=check-docs", "--ref", "origin/main", "--changed=list.txt"]), {
    mode: "check-docs",
    root: ".",
    since: "24 hours ago",
    ref: "origin/main",
    releases: "",
    changed: "list.txt",
  });
  assert.throws(() => parseArgs(["--nope"]), /unknown argument --nope/);
  assert.throws(() => parseArgs(["--root"]), /--root needs a value/);
});

// ---------- the CLI contract ----------

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts/watch-upstream-areas.mjs"), ...args], {
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test("the CLI exits 2 — could not decide — for an unusable root or a bad flag", () => {
  const missingRoot = runCli(["--mode=check", "--root", path.join(REPO_ROOT, "no-such-checkout")]);
  assert.equal(missingRoot.code, 2);
  assert.match(missingRoot.err, /is not a directory/);

  assert.equal(runCli(["--mode=check", "--root"]).code, 2);
  assert.equal(runCli(["--bogus"]).code, 2);
  assert.equal(runCli(["--mode=nope"]).code, 2);
  assert.equal(runCli(["--mode=detect", "--root", REPO_ROOT, "--since", "undefined"]).code, 2);
});

test("the CLI exits 1 and names the path when the checkout contradicts the table", () => {
  // A tree with the lfx layout but one monitored path deliberately absent.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-cli-"));
  try {
    for (const area of AREAS) {
      for (const p of area.paths) {
        const rel = p.replace(/\/$/, "");
        if (rel.endsWith(".py") || rel.endsWith(".ts") || rel.endsWith(".tsx")) {
          fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
          fs.writeFileSync(path.join(root, rel), "");
        } else {
          fs.mkdirSync(path.join(root, rel), { recursive: true });
        }
      }
    }
    // Every classified lfx child must exist, or the drift scan reports it too.
    for (const key of Object.keys(LFX_CLASSIFICATION)) {
      const target = path.join(root, LFX_ROOT, key);
      if (key.endsWith(".py")) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "");
      } else {
        fs.mkdirSync(target, { recursive: true });
      }
    }

    // Now take one watched subtree away — the flow_constants case.
    fs.rmSync(path.join(root, LFX_ROOT, "base/mcp"), { recursive: true });

    const result = runCli(["--mode=check", "--root", root]);
    assert.equal(result.code, 1);
    assert.match(result.err, /::error::monitored path "[^"]*base\/mcp\/" \(area: MCP Server\)/);
    // The same removal is also reported as a stale classification entry, and a
    // warning must never be the only signal for a coverage hole.
    assert.match(result.err, /::warning::LFX_CLASSIFICATION records "base\/mcp"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked lfx subtree is classified, not skipped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-link-"));
  try {
    const lfx = path.join(root, LFX_ROOT);
    fs.mkdirSync(path.join(lfx, "graph"), { recursive: true });
    fs.symlinkSync("graph", path.join(lfx, "newsurface"));
    const drift = findLfxDrift({
      classification: { graph: { area: "Area A" } },
      listChildren: (dir) => {
        const full = path.join(root, dir);
        if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return null;
        return fs
          .readdirSync(full, { withFileTypes: true })
          .filter((e) => e.isDirectory() || e.isSymbolicLink() || (e.isFile() && e.name.endsWith(".py")))
          .map((e) => e.name);
      },
      lfxRoot: LFX_ROOT,
    });
    assert.deepEqual(drift.unclassified, ["newsurface"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- spec-doc dependency paths (issue #1298) ----------
//
// The unit lane has no upstream clone, so these pin the DECISION rules over an
// injected tree. What they cannot prove — that the repo's 423 real paths resolve
// against upstream — is proven by running `--mode=check-docs` against a clone;
// see the run recorded in the PR. The last two tests below are over the real
// docs and need no clone.

const DOC = (markdown, file = "docs/area/thing.md") => ({ file, markdown });
const SECTION = (...bullets) => ["## External dependencies", "", ...bullets, "", "---"].join("\n");
/** One resolvable ref. `checkDocDeps` resolves against a LIST of them (#1574). */
const TREE = (ref, ...entries) => ({ ref, entries });

test("parseDocDeps takes every src/ token in the section, not just the leading one", () => {
  const deps = parseDocDeps(
    [
      "# Title",
      "",
      "- `src/before/section.py` — outside the section, must be ignored",
      "",
      "## External dependencies *(required)*",
      "",
      "- `src/one.py` — leading token, plus `src/two.py` named mid-sentence",
      "  `src/three.py` — a continuation line",
      "- `tests/helpers/local.ts` — ours, not upstream",
      "",
      "---",
      "",
      "- `src/after/section.py` — after the section ends",
    ].join("\n"),
  );

  assert.deepEqual(
    deps.map((d) => d.token),
    ["src/one.py", "src/two.py", "src/three.py"],
  );
  assert.equal(deps[0].line, 7);
});

test("classifyDepToken strips a line range and a trailing slash, and names the three kinds", () => {
  assert.deepEqual(classifyDepToken("src/lfx/src/lfx/components/input_output/chat.py:70-78"), {
    kind: "literal",
    target: "src/lfx/src/lfx/components/input_output/chat.py",
  });
  assert.deepEqual(classifyDepToken("src/frontend/src/pages/MainPage/"), {
    kind: "literal",
    target: "src/frontend/src/pages/MainPage",
  });
  assert.equal(classifyDepToken("src/frontend/src/pages/MainPage/**").kind, "glob");
  assert.equal(classifyDepToken("src/backend/base/langflow/api/.../variables").kind, "ellipsis");
  // The unicode ellipsis is the same defect as three dots and was used in 3 docs.
  assert.equal(classifyDepToken("src/frontend/src/…/flowSettings").kind, "ellipsis");
});

test("matchGlob lets ** cross directories and keeps * inside one segment", () => {
  const tree = ["src/a/b", "src/a/b/c.tsx", "src/a/d.tsx", "src/other.tsx"];
  assert.deepEqual(matchGlob("src/a/**", tree), ["src/a/b", "src/a/b/c.tsx", "src/a/d.tsx"]);
  // If `*` crossed `/`, a dead path like `src/a/*` would match a nested file and
  // pass — the silence this guard removes.
  assert.deepEqual(matchGlob("src/a/*", tree), ["src/a/b", "src/a/d.tsx"]);
  assert.deepEqual(matchGlob("src/gone/**", tree), []);
});

test("checkDocDeps fails a path in a doc the PR changed and warns on a pre-existing one", () => {
  const docs = [
    DOC(SECTION("- `src/gone.py` — moved upstream"), "docs/area/touched.md"),
    DOC(SECTION("- `src/gone.py` — moved upstream"), "docs/area/untouched.md"),
  ];
  const verdict = checkDocDeps({
    docs,
    trunk: TREE("origin/main", "src/here.py"),
    changedFiles: ["docs/area/touched.md"],
  });

  assert.equal(verdict.checked, 2);
  assert.deepEqual(
    verdict.failures.map((f) => f.file),
    ["docs/area/touched.md"],
  );
  assert.deepEqual(
    verdict.warnings.map((w) => w.file),
    ["docs/area/untouched.md"],
  );
});

test("checkDocDeps treats an ellipsis as a defect, not as a path it cannot judge", () => {
  const verdict = checkDocDeps({
    docs: [DOC(SECTION("- `src/frontend/src/.../playground` — the chat input"), "docs/area/touched.md")],
    // Even with the real directory present, the token itself is unresolvable.
    trunk: TREE("origin/main", "src/frontend/src/components/core/playgroundComponent"),
    changedFiles: ["docs/area/touched.md"],
  });

  assert.equal(verdict.failures.length, 1);
  assert.equal(verdict.failures[0].kind, "ellipsis");
});

test("checkDocDeps accepts a resolving glob and a path carrying a line range", () => {
  const verdict = checkDocDeps({
    docs: [
      DOC(
        SECTION(
          "- `src/frontend/src/pages/LoginPage/**` — the login page",
          "- `src/lfx/chat.py:70-78` — the FileInput block",
        ),
        "docs/area/touched.md",
      ),
    ],
    trunk: TREE(
      "origin/main",
      "src/frontend/src/pages/LoginPage",
      "src/frontend/src/pages/LoginPage/index.tsx",
      "src/lfx/chat.py",
    ),
    changedFiles: ["docs/area/touched.md"],
  });

  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(verdict.warnings, []);
  assert.equal(verdict.checked, 2);
});

test("checkDocDeps skips an exempt doc entirely and reports that it did", () => {
  const verdict = checkDocDeps({
    docs: [DOC(SECTION("- `src/backend/...` — placeholder by design"), "docs/TEST-SPEC-TEMPLATE.md")],
    trunk: TREE("origin/main", "src/backend"),
    changedFiles: ["docs/TEST-SPEC-TEMPLATE.md"],
  });

  assert.equal(verdict.checked, 0);
  assert.deepEqual(verdict.exempt, ["docs/TEST-SPEC-TEMPLATE.md"]);
  assert.deepEqual(verdict.failures, []);
});

// --- #1574: the suite validates the nightly, which is cut from a release line,
// not from upstream `main`. The trunk and the release lines are both resolved
// against, and any one of them is enough.

test("checkDocDeps accepts a path that exists only on the release line, and names the ref that satisfied it", () => {
  const verdict = checkDocDeps({
    docs: [DOC(SECTION("- `src/lfx/src/lfx/exceptions/tweaks.py` — TweakRefusedError"), "docs/security/x.md")],
    trunk: TREE("origin/main", "src/lfx/src/lfx/processing/process.py"),
    releases: [
      TREE("origin/release-1.12.0", "src/lfx/src/lfx/processing/process.py", "src/lfx/src/lfx/exceptions/tweaks.py"),
    ],
    // The PR changed the doc, so under the old trunk-only guard this FAILED.
    changedFiles: ["docs/security/x.md"],
  });

  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(verdict.warnings, []);
  assert.deepEqual(verdict.partial, [
    {
      file: "docs/security/x.md",
      line: 3,
      token: "src/lfx/src/lfx/exceptions/tweaks.py",
      class: "release-only",
      resolvedOn: ["origin/release-1.12.0"],
      missingOn: ["origin/main"],
    },
  ]);
});

test("checkDocDeps stays silent about a path the trunk and a release line both carry", () => {
  // The report is the attribution half, not a second verdict: a path everything
  // carries is not interesting and must not dilute the ones that are.
  const verdict = checkDocDeps({
    docs: [DOC(SECTION("- `src/here.py` — everywhere"), "docs/area/touched.md")],
    trunk: TREE("origin/main", "src/here.py"),
    releases: [TREE("origin/release-1.12.0", "src/here.py")],
    changedFiles: ["docs/area/touched.md"],
  });

  assert.deepEqual(verdict.partial, []);
  assert.deepEqual(verdict.failures, []);
});

test("checkDocDeps reports a path the trunk has and no release line does", () => {
  // The mirror of #1574: a doc written against `main`-only code names code the
  // image this suite runs does not have.
  const verdict = checkDocDeps({
    docs: [DOC(SECTION("- `src/new_on_main.py` — unreleased"), "docs/area/touched.md")],
    trunk: TREE("origin/main", "src/new_on_main.py"),
    releases: [TREE("origin/release-1.12.0", "src/old.py")],
    changedFiles: ["docs/area/touched.md"],
  });

  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.partial[0].class, "trunk-only");
  assert.deepEqual(verdict.partial[0].missingOn, ["origin/release-1.12.0"]);
});

test("checkDocDeps says nothing about a path merely newer than the OLDEST release line", () => {
  // The reason the refs carry roles instead of sitting in a flat list. Measured
  // against the real docs, a symmetric report over a flat list produced 8 of 9
  // findings of exactly this shape — all noise, and it grows with each release
  // cut, burying the one finding that matters.
  const verdict = checkDocDeps({
    docs: [DOC(SECTION("- `src/recent.py` — landed in 1.12"), "docs/area/touched.md")],
    trunk: TREE("origin/main", "src/recent.py"),
    releases: [TREE("origin/release-1.12.0", "src/recent.py"), TREE("origin/release-1.11.5", "src/old.py")],
    changedFiles: ["docs/area/touched.md"],
  });

  assert.deepEqual(verdict.partial, []);
});

test("checkDocDeps still fails a path that resolves on NO ref, naming all of them", () => {
  // #1298's original purpose. Widening the refs must not widen into "anything goes".
  const verdict = checkDocDeps({
    docs: [
      DOC(SECTION("- `src/gone.py` — moved upstream"), "docs/area/touched.md"),
      DOC(SECTION("- `src/gone.py` — moved upstream"), "docs/area/untouched.md"),
    ],
    trunk: TREE("origin/main", "src/here.py"),
    releases: [TREE("origin/release-1.12.0", "src/here.py")],
    changedFiles: ["docs/area/touched.md"],
  });

  assert.deepEqual(
    verdict.failures.map((f) => f.file),
    ["docs/area/touched.md"],
  );
  assert.match(verdict.failures[0].reason, /origin\/main, origin\/release-1\.12\.0/);
  assert.equal(verdict.warnings.length, 1);
  assert.deepEqual(verdict.partial, []);
});

test("checkDocDeps resolves a glob against each ref independently", () => {
  const verdict = checkDocDeps({
    docs: [DOC(SECTION("- `src/lfx/exceptions/*.py` — the module"), "docs/area/touched.md")],
    trunk: TREE("origin/main", "src/lfx/processing/process.py"),
    releases: [TREE("origin/release-1.12.0", "src/lfx/exceptions/tweaks.py")],
    changedFiles: ["docs/area/touched.md"],
  });

  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.partial[0].class, "release-only");
});

test("checkDocDeps reports an ellipsis once, not once per ref", () => {
  // No ref can decide it, so asking each one would only multiply the finding and
  // make the reason name refs that were never consulted.
  const verdict = checkDocDeps({
    docs: [DOC(SECTION("- `src/frontend/src/.../playground` — the chat input"), "docs/area/touched.md")],
    trunk: TREE("origin/main", "src/frontend"),
    releases: [TREE("origin/release-1.12.0", "src/frontend")],
    changedFiles: ["docs/area/touched.md"],
  });

  assert.equal(verdict.failures.length, 1);
  assert.equal(verdict.failures[0].kind, "ellipsis");
  assert.deepEqual(verdict.partial, []);
});

test("checkDocDeps with no release line behaves exactly as the pre-#1574 guard did", () => {
  const docs = [DOC(SECTION("- `src/only_on_release.py` — 1.12 only"), "docs/area/touched.md")];
  const trunk = TREE("origin/main", "src/here.py");

  assert.equal(checkDocDeps({ docs, trunk, changedFiles: ["docs/area/touched.md"] }).failures.length, 1);
  assert.deepEqual(checkDocDeps({ docs, trunk, changedFiles: ["docs/area/touched.md"] }).partial, []);
});

test("checkDocDeps refuses to resolve without a trunk instead of failing every path", () => {
  assert.throws(() => checkDocDeps({ docs: [DOC(SECTION("- `src/here.py` — a file"))] }), /needs a trunk/);
});

test("parseRefList passes a single ref through verbatim and splits a list in order", () => {
  assert.deepEqual(parseRefList("origin/release-1.12.0"), ["origin/release-1.12.0"]);
  assert.deepEqual(parseRefList("origin/release-1.12.0,origin/release-1.11.5"), [
    "origin/release-1.12.0",
    "origin/release-1.11.5",
  ]);
  // Whitespace and a duplicate must not become a second verdict about one ref.
  assert.deepEqual(parseRefList(" origin/a , origin/a ,origin/b "), ["origin/a", "origin/b"]);
  assert.throws(() => parseRefList(" , "), /names no ref/);
  // An empty --releases is the trunk-only run, which is legitimate and announced.
  assert.deepEqual(parseRefList("", { allowEmpty: true }), []);
});

test("pickReleaseBranches sorts by version, not lexically", () => {
  // The trap: upstream carries release-1.9.7 and release-1.12.0 side by side, and
  // a string sort picks the 1.9 line — a line the nightly has not been cut from
  // for two releases.
  const output = [
    "47ce5bf\trefs/heads/release-1.9.7",
    "5ccd44e\trefs/heads/release-1.10.3",
    "1e40f92\trefs/heads/release-1.12.0",
    "287c864\trefs/heads/release-1.11.5",
  ].join("\n");

  assert.deepEqual(pickReleaseBranches(output), ["release-1.12.0", "release-1.11.5"]);
  assert.deepEqual(pickReleaseBranches(output, 1), ["release-1.12.0"]);
});

test("pickReleaseBranches tracks two lines, because the shipping line lags the newest cut", () => {
  // Measured on the real remote: 61 `src/` paths live on release-1.11.5 and on
  // NEITHER main nor release-1.12.0. A one-line window drops all of them the
  // moment upstream cuts the next release, which is #1574 reopening.
  assert.equal(RELEASE_LINES_TRACKED, 2);
});

test("pickReleaseBranches ignores the branches that only look like a release line", () => {
  // All five are real entries in `git ls-remote` on langflow-ai/langflow.
  const output = [
    "a\trefs/heads/release-notes",
    "b\trefs/heads/release-0.6.0a",
    "c\trefs/heads/release-1.6.0-backup",
    "d\trefs/heads/release-1.6.0-at-scheduling-logic-branch",
    "e\trefs/heads/release-1.5",
  ].join("\n");

  // Only the two-part `release-1.5` is a release line among them.
  assert.deepEqual(pickReleaseBranches(output), ["release-1.5"]);
});

test("pickReleaseBranches breaks the release-1.12 / release-1.12.0 tie deterministically", () => {
  // Same version, so without a tie-break the winner would be whatever order
  // ls-remote happened to print — and the winner is a ref the caller then fetches.
  const forward = "a\trefs/heads/release-1.12\nb\trefs/heads/release-1.12.0";
  const reversed = "b\trefs/heads/release-1.12.0\na\trefs/heads/release-1.12";

  assert.deepEqual(pickReleaseBranches(forward, 1), ["release-1.12.0"]);
  assert.deepEqual(pickReleaseBranches(reversed, 1), ["release-1.12.0"]);
});

test("pickReleaseBranches throws rather than returning nothing when no line is found", () => {
  // Undecidable, not "no release line" — the caller exits 2 on this, because
  // guessing would put the guard back on `main` alone with nothing in the log.
  assert.throws(() => pickReleaseBranches("a\trefs/heads/main\n"), /cannot be derived/);
});

// ---------- #1574 end-to-end through the CLI ----------
//
// The four tests above pin the pure verdict. These pin what the LANE runs: the
// flags being honoured, the report a human reads, and the exit codes. Without
// them, reverting `--releases` to a no-op, deleting the printed report, or
// letting an unlistable ref be skipped all leave the suite green — measured, all
// three survived the pure tests alone.

/** A throwaway upstream: one trunk branch, one release line, one file apart. */
function upstreamFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-upstream-"));
  const run = (...args) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  const write = (rel) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "");
  };

  run("init", "-q", "-b", "main");
  write("src/shared.py");
  run("add", "-A");
  run("commit", "-qm", "trunk");
  for (const branch of ["release-1.12.0", "release-1.9.7", "release-notes"]) run("branch", branch);
  run("checkout", "-q", "release-1.12.0");
  write("src/only_on_release.py");
  run("add", "-A");
  run("commit", "-qm", "release line");
  run("checkout", "-q", "main");
  // `--mode=release-ref` reads `git ls-remote origin`, so the fixture is its own.
  run("remote", "add", "origin", root);
  return root;
}

/**
 * A standalone copy of the script beside a synthetic `docs/` tree.
 *
 * `check-docs` collects docs from the repo root it computes from its own
 * location, so this is what makes the printed report assertable without touching
 * the real docs. The script is dependency-free ESM, so a copy runs as-is.
 */
function docsFixture(markdown) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-docs-"));
  fs.mkdirSync(path.join(home, "scripts"));
  fs.mkdirSync(path.join(home, "docs", "area"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts/watch-upstream-areas.mjs"),
    path.join(home, "scripts/watch-upstream-areas.mjs"),
  );
  fs.writeFileSync(path.join(home, "docs/area/spec.md"), markdown);
  fs.writeFileSync(path.join(home, "changed.txt"), "docs/area/spec.md\n");
  return home;
}

function runCliFrom(home, args) {
  const result = spawnSync(process.execPath, [path.join(home, "scripts/watch-upstream-areas.mjs"), ...args], {
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test("the CLI resolves a release-only path, exits 0, and NAMES the ref in the report", () => {
  const upstream = upstreamFixture();
  const home = docsFixture(SECTION("- `src/only_on_release.py` — the 1.12-only module"));

  const withRelease = runCliFrom(home, [
    "--mode=check-docs",
    "--root",
    upstream,
    "--ref",
    "main",
    "--releases",
    "release-1.12.0",
    "--changed",
    path.join(home, "changed.txt"),
  ]);

  assert.equal(withRelease.code, 0, withRelease.err);
  // The report a human reads — the deliverable itself, not the returned object.
  assert.match(withRelease.out, /resolves on release-1\.12\.0; absent from main/);
  assert.match(withRelease.err, /::notice::docs\/area\/spec\.md:\d+/);

  // The same run without --releases is the pre-#1574 guard, and it FAILS: this is
  // the defect the issue was filed for, reproduced through the CLI.
  const trunkOnly = runCliFrom(home, [
    "--mode=check-docs",
    "--root",
    upstream,
    "--ref",
    "main",
    "--changed",
    path.join(home, "changed.txt"),
  ]);
  assert.equal(trunkOnly.code, 1);
  assert.match(trunkOnly.err, /does not exist on main/);
});

test("the CLI still exits 1 for a path on no ref at all, and 2 for a ref it cannot list", () => {
  const upstream = upstreamFixture();
  const home = docsFixture(SECTION("- `src/nowhere.py` — moved upstream"));
  const args = (extra) => [
    "--mode=check-docs",
    "--root",
    upstream,
    "--ref",
    "main",
    ...extra,
    "--changed",
    path.join(home, "changed.txt"),
  ];

  // #1298's purpose, through the lane.
  const gone = runCliFrom(home, args(["--releases", "release-1.12.0"]));
  assert.equal(gone.code, 1);
  assert.match(gone.err, /does not exist on main, release-1\.12\.0/);

  // A declared ref that is not in the checkout is undecidable — never a ref to
  // quietly drop, which would narrow resolution back to the trunk in silence.
  const unlistable = runCliFrom(home, args(["--releases", "release-1.12.0,release-9.9.9"]));
  assert.equal(unlistable.code, 2);
  assert.match(unlistable.err, /could not list the upstream tree at "release-9\.9\.9"/);
});

test("the CLI derives the release lines from the upstream remote, newest first", () => {
  const upstream = upstreamFixture();
  const derived = runCli(["--mode=release-ref", "--root", upstream]);

  assert.equal(derived.code, 0, derived.err);
  // release-notes is not a release line; 1.12.0 outranks 1.9.7 numerically.
  assert.deepEqual(derived.out.trim().split("\n"), ["release-1.12.0", "release-1.9.7"]);
});

test("no real doc outside the allowlist carries an unresolvable ellipsis dependency", () => {
  // Pins the #1298 sweep: 10 entries were written as `src/frontend/src/.../x`,
  // which no ref can confirm or refute. This costs no clone, so it runs in the
  // PR unit lane and catches the style coming back.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = path.relative(REPO_ROOT, full);
        if (DOC_DEPS_EXEMPT_FILES.includes(rel)) continue;
        for (const dep of parseDocDeps(fs.readFileSync(full, "utf8"))) {
          if (classifyDepToken(dep.token).kind === "ellipsis") offenders.push(`${rel}:${dep.line} ${dep.token}`);
        }
      }
    }
  };
  walk(path.join(REPO_ROOT, "docs"));

  assert.deepEqual(offenders, []);
});

test("every exempt doc exists, so the allowlist cannot rot into a blanket skip", () => {
  for (const rel of DOC_DEPS_EXEMPT_FILES) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} is exempt but does not exist`);
  }
});

/**
 * The `run:` body of a named step in a workflow, dedented so bash can run it.
 *
 * Extracting it beats retyping it: a hand-written copy of this block passed a
 * full local reproduction while the YAML itself built the ref list into a
 * variable no other line read, and the lane shipped an empty `--releases`
 * (measured on PR #1580's first run — every guard in this repo green).
 */
function stepRunBody(yml, stepName) {
  const at = yml.indexOf(`- name: ${stepName}`);
  assert.ok(at >= 0, `no step named "${stepName}"`);
  const runAt = yml.indexOf("run: |", at);
  assert.ok(runAt >= 0, `step "${stepName}" has no run: block`);
  const lines = yml.slice(yml.indexOf("\n", runAt) + 1).split("\n");
  const indent = lines[0].match(/^\s*/)[0];
  const body = [];
  for (const line of lines) {
    if (line.trim() !== "" && !line.startsWith(indent)) break;
    body.push(line.slice(indent.length));
  }
  return body.join("\n");
}

test("the doc-deps steps, AS WRITTEN IN THE YAML, resolve a release-only path end to end", () => {
  // The strongest guard in this file: it runs the workflow's own shell against a
  // local git fixture — no network — so a defect in the YAML fails here instead
  // of on the PR that ships it. It is what #1226 asks for: assert on behaviour,
  // not on a spelling.
  const yml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"), "utf8");
  const home = docsFixture(SECTION("- `src/only_on_release.py` — the release-line-only module"));
  // The steps address the checkout by that exact relative name.
  const upstream = path.join(home, "langflow-upstream");
  fs.renameSync(upstreamFixture(), upstream);
  // The fixture is its own remote, so moving it invalidates the URL it recorded.
  spawnSync("git", ["remote", "set-url", "origin", upstream], { cwd: upstream });
  spawnSync("git", ["fetch", "-q", "origin"], { cwd: upstream });
  fs.renameSync(path.join(home, "changed.txt"), path.join(home, "changed-docs.txt"));

  const githubEnv = path.join(home, "github-env");
  const summary = path.join(home, "step-summary");
  fs.writeFileSync(githubEnv, "");

  const fetchStep = spawnSync("bash", ["-c", stepRunBody(yml, "Fetch the release lines the nightly is cut from")], {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, GITHUB_ENV: githubEnv },
  });
  assert.equal(fetchStep.status, 0, fetchStep.stderr);
  // The step's whole product: the value the next step reads. An empty one is how
  // the guard silently fell back to the trunk alone.
  const exported = Object.fromEntries(
    fs
      .readFileSync(githubEnv, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  assert.equal(exported.RELEASE_CSV, "origin/release-1.12.0,origin/release-1.9.7");

  // The fixture's trunk is `main`, so the step's `--ref origin/main` resolves
  // against the tracking ref the fetch above created.
  const resolveStep = spawnSync(
    "bash",
    ["-c", stepRunBody(yml, "Resolve every External-dependencies path against upstream")],
    { cwd: home, encoding: "utf8", env: { ...process.env, ...exported, GITHUB_STEP_SUMMARY: summary } },
  );

  assert.equal(resolveStep.status, 0, resolveStep.stdout + resolveStep.stderr);
  assert.match(resolveStep.stdout, /resolves on origin\/release-1\.12\.0; absent from origin\/main/);
  // What a reviewer actually opens.
  assert.match(fs.readFileSync(summary, "utf8"), /resolve on only one side/);
});

test("pr-validation.yml runs the doc-deps guard with a diff list and a real upstream ref", () => {
  // Presence wiring, not behaviour: the behaviour is pinned by checkDocDeps above.
  // #1226's lesson is that a regex over YAML cannot prove a verdict is right —
  // but the guard reaching the lane at all is exactly what a regex can prove, and
  // a mode nobody invokes is how #1092's watcher ended up with no run history.
  const yml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"), "utf8");
  assert.match(yml, /watch-upstream-areas\.mjs \\\n\s+--mode=check-docs/);
  // Without --changed the verdict cannot fail anything, so the flag IS the gate.
  assert.match(yml, /--changed changed-docs\.txt/);
  // #1574: `main` alone failed PRs for paths that are correct for the image under
  // test, so the lane must resolve against the release lines too — and must
  // DERIVE them, since a hardcoded ref goes stale silently on the next release.
  assert.match(yml, /--ref origin\/main \\\n\s+--releases "\$RELEASE_CSV"/);
  assert.match(yml, /--mode=release-ref --root langflow-upstream/);
  // The refspec, without which the fetch lands in FETCH_HEAD and `origin/<line>`
  // never exists — the ls-tree would then exit 2 for a ref that WAS fetched.
  assert.match(yml, /"\+refs\/heads\/\$\{RELEASE_REF\}:refs\/remotes\/origin\/\$\{RELEASE_REF\}"/);
  // Set in one step and read in the next, so the order of the two is load-bearing.
  assert.match(yml, /echo "RELEASE_CSV=\$RELEASE_CSV" >> "\$GITHUB_ENV"/);
  assert.ok(
    yml.indexOf("Fetch the release lines") < yml.indexOf("Resolve every External-dependencies path"),
    "the release lines must be fetched before the step that resolves against them",
  );
  // Upstream fetches are flaky — the clone above retries for that reason, and two
  // un-retried network calls beneath it would redden the job on a blip (#980).
  const fetchStep = yml.slice(yml.indexOf("Fetch the release lines"), yml.indexOf("Resolve every External-dependencies"));
  assert.equal((fetchStep.match(/for attempt in 1 2 3; do/g) || []).length, 2);
  // A blobless, no-checkout clone is what makes the ls-tree resolver affordable
  // here; a plain clone would pull ~117 MB per PR.
  assert.match(yml, /git clone --filter=blob:none --depth 1 --no-checkout/);
  // The clone must not fail open: no tree means no verdict, which is not a pass.
  assert.match(yml, /::error::could not clone langflow-ai\/langflow/);
});
