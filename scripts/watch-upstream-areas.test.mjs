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
import path from "node:path";

import {
  AREAS,
  BODY_DELIMITER,
  LANGFLOW_AREAS,
  LFX_CLASSIFICATION,
  LFX_ROOT,
  MAX_COMMITS_PER_AREA,
  PARTIAL,
  buildAreas,
  detectChangedAreas,
  findLfxDrift,
  findMissingPaths,
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

test("file-watcher.yml runs both guards and consumes the payload", () => {
  // A table nothing reads, or a check the workflow forgot to run, would restore
  // the silence this issue is about.
  const yml = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/file-watcher.yml"), "utf8");
  assert.match(yml, /watch-upstream-areas\.mjs --mode=check/);
  assert.match(yml, /watch-upstream-areas\.mjs --mode=detect/);
  assert.match(yml, /steps\.detect\.outputs\.title/);
  assert.match(yml, /steps\.detect\.outputs\.body/);
  // The body reaches github-script through the environment. Interpolating it
  // into the script body would put an upstream commit subject inside a JS
  // template literal.
  assert.match(yml, /body: process\.env\.ISSUE_BODY/);
  // The guard must run BEFORE the sweep, or a stale table still produces a report.
  assert.ok(
    yml.indexOf("--mode=check") < yml.indexOf("--mode=detect"),
    "the existence guard must precede the change sweep",
  );
});
