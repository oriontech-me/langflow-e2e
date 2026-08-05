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
  buildAreas,
  checkDocDeps,
  classifyDepToken,
  detectChangedAreas,
  findLfxDrift,
  findMissingPaths,
  matchGlob,
  parseDocDeps,
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
    treeEntries: ["src/here.py"],
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
    treeEntries: ["src/frontend/src/components/core/playgroundComponent"],
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
    treeEntries: ["src/frontend/src/pages/LoginPage", "src/frontend/src/pages/LoginPage/index.tsx", "src/lfx/chat.py"],
    changedFiles: ["docs/area/touched.md"],
  });

  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(verdict.warnings, []);
  assert.equal(verdict.checked, 2);
});

test("checkDocDeps skips an exempt doc entirely and reports that it did", () => {
  const verdict = checkDocDeps({
    docs: [DOC(SECTION("- `src/backend/...` — placeholder by design"), "docs/TEST-SPEC-TEMPLATE.md")],
    treeEntries: ["src/backend"],
    changedFiles: ["docs/TEST-SPEC-TEMPLATE.md"],
  });

  assert.equal(verdict.checked, 0);
  assert.deepEqual(verdict.exempt, ["docs/TEST-SPEC-TEMPLATE.md"]);
  assert.deepEqual(verdict.failures, []);
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

test("pr-validation.yml runs the doc-deps guard with a diff list and a real upstream ref", () => {
  // Presence wiring, not behaviour: the behaviour is pinned by checkDocDeps above.
  // #1226's lesson is that a regex over YAML cannot prove a verdict is right —
  // but the guard reaching the lane at all is exactly what a regex can prove, and
  // a mode nobody invokes is how #1092's watcher ended up with no run history.
  const yml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"), "utf8");
  assert.match(yml, /watch-upstream-areas\.mjs \\\n\s+--mode=check-docs/);
  // Without --changed the verdict cannot fail anything, so the flag IS the gate.
  assert.match(yml, /--changed changed-docs\.txt/);
  assert.match(yml, /--ref origin\/main/);
  // A blobless, no-checkout clone is what makes the ls-tree resolver affordable
  // here; a plain clone would pull ~117 MB per PR.
  assert.match(yml, /git clone --filter=blob:none --depth 1 --no-checkout/);
  // The clone must not fail open: no tree means no verdict, which is not a pass.
  assert.match(yml, /::error::could not clone langflow-ai\/langflow/);
});
