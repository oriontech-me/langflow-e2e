// Unit tests for scripts/resolve-target-version.mjs.
// Run with: npm run test:scripts
//
// What these protect: the answer to "which Langflow should the VM be testing?", which
// is upstream's rule and not ours. Every failure mode here is silent — a wrong answer
// still resolves, the run still goes green, and the divergence list quietly fills with
// product changelog described as environment differences.
//
//   - Numeric ordering. `release-1.9.0` sorts ABOVE `release-1.12.0` as a string, so
//     a lexicographic compare pins the lane a cycle behind and nothing complains.
//   - `main` is never the answer. It is only where the nightly workflow file lives;
//     the image is built from a release branch.
//   - The PEELED sha of an annotated tag. ls-remote prints two lines per annotated
//     tag, and the unpeeled one is the tag object — checking that out leaves HEAD at
//     a different commit than the image was built from, which is exactly the class of
//     "close enough" this whole step exists to remove.
//   - Cycle parity and commit parity are DIFFERENT claims, and the comparison must
//     not report a mismatch for a correctly placed clone under branch-head, or the
//     check gets ignored the first week.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveTargetVersion, compareVersions } from "./resolve-target-version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "resolve-target-version.mjs");

const sha = (n) => String(n).repeat(40).slice(0, 40);

function refs(lines) {
  return lines.map(([s, r]) => `${s}\t${r}`).join("\n") + "\n";
}

test("the newest release branch is chosen NUMERICALLY, not as a string", () => {
  // The trap: "release-1.9.0" > "release-1.12.0" lexicographically.
  const d = resolveTargetVersion(
    refs([
      [sha(1), "refs/heads/release-1.9.0"],
      [sha(2), "refs/heads/release-1.12.0"],
      [sha(3), "refs/heads/release-1.11.6"],
    ]),
  );
  assert.equal(d.ok, true);
  assert.equal(d.branch, "release-1.12.0");
});

test("main is never the answer, and neither is any other branch shape", () => {
  const d = resolveTargetVersion(
    refs([
      [sha(1), "refs/heads/main"],
      [sha(2), "refs/heads/release-1.13.0"],
      [sha(3), "refs/heads/1.11.0-merge"],
      [sha(4), "refs/heads/release-1.13.0-rc1"],
      [sha(5), "refs/heads/add-ep-build-to-nightly"],
    ]),
  );
  assert.equal(d.branch, "release-1.13.0");
});

test("the newest nightly tag of that cycle wins, with the PEELED commit", () => {
  const d = resolveTargetVersion(
    refs([
      [sha(1), "refs/heads/release-1.13.0"],
      [sha(2), "refs/tags/v1.13.0.dev0"],
      [sha(3), "refs/tags/v1.13.0.dev0^{}"],
      [sha(4), "refs/tags/v1.13.0.dev1"],
      [sha(5), "refs/tags/v1.13.0.dev1^{}"],
    ]),
  );
  assert.equal(d.strategy, "nightly-tag");
  assert.equal(d.version, "1.13.0.dev1");
  assert.equal(d.ref, "v1.13.0.dev1");
  // The peeled entry, not the tag object: checking out the latter leaves HEAD
  // somewhere the image never was.
  assert.equal(d.sha, sha(5));
});

test("dev numbers are ordered numerically too — dev9 does not beat dev10", () => {
  const d = resolveTargetVersion(
    refs([
      [sha(1), "refs/heads/release-1.13.0"],
      [sha(2), "refs/tags/v1.13.0.dev9^{}"],
      [sha(3), "refs/tags/v1.13.0.dev10^{}"],
    ]),
  );
  assert.equal(d.version, "1.13.0.dev10");
});

test("a tag from another cycle is ignored, however new it looks", () => {
  const d = resolveTargetVersion(
    refs([
      [sha(1), "refs/heads/release-1.12.0"],
      [sha(2), "refs/tags/v1.13.0.dev5^{}"],
      [sha(3), "refs/tags/v1.12.0.dev45^{}"],
    ]),
  );
  assert.equal(d.version, "1.12.0.dev45");
});

test("no tag yet falls back to the branch head, and SAYS it is only cycle parity", () => {
  const d = resolveTargetVersion(refs([[sha(7), "refs/heads/release-1.14.0"]]));
  assert.equal(d.ok, true);
  assert.equal(d.strategy, "branch-head");
  assert.equal(d.sha, sha(7));
  assert.equal(d.version, "1.14.0");
  assert.match(d.warnings.join(" "), /CYCLE, not of commit/);
});

test("no release branch at all is an error that names the rule, not a fallback to main", () => {
  const d = resolveTargetVersion(refs([[sha(1), "refs/heads/main"]]));
  assert.equal(d.ok, false);
  assert.match(d.error, /release-X\.Y\.Z/);
  assert.match(d.error, /main/);
});

// --- the published image decides -------------------------------------------------

/** A Docker Hub tags page, with `latest` sharing a digest with one version tag. */
function imageTags(latestVersion, extra = []) {
  const digest = `sha256:${"a".repeat(64)}`;
  const img = (d) => [
    { architecture: "arm64", os: "linux", digest: `sha256:${"b".repeat(64)}` },
    { architecture: "amd64", os: "linux", digest: d },
  ];
  return JSON.stringify({
    results: [
      { name: "latest", images: img(digest) },
      { name: latestVersion, images: img(digest) },
      ...extra.map((v) => ({ name: v, images: img(`sha256:${"c".repeat(64)}`) })),
      { name: "base-latest", images: img(`sha256:${"d".repeat(64)}`) },
    ],
  });
}

test("the PUBLISHED image wins over a newer git tag", () => {
  // The live case the day this was written: v1.13.0.dev1 was tagged, and `latest` was
  // still 1.13.0.dev0. Upstream tags BEFORE it builds, and only ships if the tests
  // pass — so a clone correctly sitting where the CI is would be called a mismatch.
  const d = resolveTargetVersion(
    refs([
      [sha(1), "refs/heads/release-1.13.0"],
      [sha(2), "refs/tags/v1.13.0.dev0^{}"],
      [sha(3), "refs/tags/v1.13.0.dev1^{}"],
    ]),
    imageTags("1.13.0.dev0", ["1.13.0.dev1"]),
  );
  assert.equal(d.strategy, "published-image");
  assert.equal(d.version, "1.13.0.dev0");
  assert.equal(d.sha, sha(2), "the commit must be the one of the PUBLISHED version");
  assert.match(d.digest, /^sha256:a+$/);
});

test("a release branch cut ahead of the image does not drag the answer with it", () => {
  // release-1.14.0 exists before any nightly is built from it; `latest` is still the
  // previous cycle. Branch-first resolution flips a whole cycle ahead of reality.
  const d = resolveTargetVersion(
    refs([
      [sha(1), "refs/heads/release-1.13.0"],
      [sha(2), "refs/heads/release-1.14.0"],
      [sha(3), "refs/tags/v1.13.0.dev5^{}"],
    ]),
    imageTags("1.13.0.dev5"),
  );
  assert.equal(d.version, "1.13.0.dev5");
  assert.equal(d.branch, "release-1.13.0");
});

test("the amd64 digest is the one matched, not whatever comes first", () => {
  // Both lanes run amd64. Matching an arm64 digest finds nothing and drops the whole
  // resolution to the fallback without saying why.
  const payload = JSON.parse(imageTags("1.13.0.dev2"));
  for (const t of payload.results) t.images.reverse();
  const d = resolveTargetVersion(refs([[sha(1), "refs/heads/release-1.13.0"]]), JSON.stringify(payload));
  assert.equal(d.strategy, "published-image");
  assert.equal(d.version, "1.13.0.dev2");
});

test("an unreadable image listing falls back to the refs, naming what that costs", () => {
  const d = resolveTargetVersion(
    refs([
      [sha(1), "refs/heads/release-1.13.0"],
      [sha(2), "refs/tags/v1.13.0.dev1^{}"],
    ]),
    "not json at all",
  );
  assert.equal(d.strategy, "nightly-tag");
  assert.equal(d.version, "1.13.0.dev1");
  assert.match(d.warnings.join(" "), /before the image is built/);
});

test("a published version with no matching tag keeps the version and drops the commit", () => {
  const d = resolveTargetVersion(refs([[sha(1), "refs/heads/release-1.13.0"]]), imageTags("1.13.0.dev9"));
  assert.equal(d.version, "1.13.0.dev9");
  assert.equal(d.sha, "");
  assert.match(d.warnings.join(" "), /exact commit of the published image is unknown/);
});

test("a listing that was REQUESTED but unusable warns, even when the refs answer", () => {
  // The silent case: `imageTagsText` is falsy both when nobody asked for a listing and
  // when curl never wrote one (or wrote an empty 200). The refs then answer confidently
  // — `nightly-tag`, no warnings — and the reader has no way to know the registry was
  // never consulted, which is the one thing that would make them doubt the answer.
  const withTag = refs([
    [sha(1), "refs/heads/release-1.13.0"],
    [sha(2), "refs/tags/v1.13.0.dev1^{}"],
  ]);
  const silent = resolveTargetVersion(withTag, null, false);
  assert.equal(silent.warnings.length, 0, "nobody asked for a listing: nothing to warn about");

  for (const unusable of [null, ""]) {
    const d = resolveTargetVersion(withTag, unusable, true);
    assert.equal(d.strategy, "nightly-tag");
    assert.match(d.warnings.join(" "), /requested but could not be used/);
    assert.match(d.warnings.join(" "), /AHEAD of what shipped/);
  }
});

test("published-image compares exactly, like the tag it replaced", () => {
  assert.equal(compareVersions("1.13.0.dev0", "1.13.0.dev0", "published-image").match, "yes");
  assert.equal(compareVersions("1.13.0.dev0", "1.13.0.dev1", "published-image").match, "no");
});

test("comparing under nightly-tag is exact", () => {
  assert.equal(compareVersions("1.13.0.dev1", "1.13.0.dev1", "nightly-tag").match, "yes");
  const bad = compareVersions("1.13.0.dev1", "1.12.0", "nightly-tag");
  assert.equal(bad.match, "no");
  assert.match(bad.reason, /1\.12\.0/);
});

test("comparing under branch-head accepts the cycle, because the .devN is not ours to expect", () => {
  // A source clone at the branch head reports `1.13.0`; the CI's image reports
  // `1.13.0.dev1`. Calling that a mismatch would be a false alarm on a correctly
  // placed clone — the fastest way to get a check ignored.
  const r = compareVersions("1.13.0", "1.13.0", "branch-head");
  assert.equal(r.match, "cycle");
  assert.equal(compareVersions("1.13.0", "1.12.0", "branch-head").match, "no");
});

test("an unrecognised strategy is UNKNOWN, never the looser comparison", () => {
  // One character decides whether a different commit is a mismatch or a pass, and
  // the looser rule is the one that answers when nobody recognises the strategy.
  for (const bogus of ["nightlytag", "", "branch head", undefined]) {
    const r = compareVersions("1.13.0.dev1", "1.13.0.dev0", bogus);
    assert.equal(r.match, "unknown", String(bogus));
    assert.match(r.reason, /unrecognised resolution strategy/);
  }
  // And the same inputs under the real strategy are still a mismatch, which is what
  // makes the fallback dangerous rather than merely wrong.
  assert.equal(compareVersions("1.13.0.dev1", "1.13.0.dev0", "nightly-tag").match, "no");
});

test("a missing version on either side is UNKNOWN, never a pass", () => {
  assert.equal(compareVersions("1.13.0.dev1", "", "nightly-tag").match, "unknown");
  assert.equal(compareVersions("", "1.13.0", "nightly-tag").match, "unknown");
});

test("the CLI prints JSON and exits 0, or exits 1 with the decision still readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "resolve-target-version-test-"));
  const good = join(dir, "good.txt");
  const bad = join(dir, "bad.txt");
  writeFileSync(good, refs([[sha(1), "refs/heads/release-1.13.0"]]));
  writeFileSync(bad, refs([[sha(1), "refs/heads/main"]]));

  const ok = spawnSync(process.execPath, [SCRIPT, "--refs-file", good], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).branch, "release-1.13.0");

  const fail = spawnSync(process.execPath, [SCRIPT, "--refs-file", bad], { encoding: "utf8" });
  assert.equal(fail.status, 1);
  // Printed even on failure: the caller quotes the reason rather than inventing one.
  assert.equal(JSON.parse(fail.stdout).ok, false);

  rmSync(dir, { recursive: true, force: true });
});
