// Unit tests for the 422-redaction release gate.
// Run with: npm run test:units
//
// The gate's two failure modes are opposite and both silent. Too permissive and a
// pre-1.13.0.dev10 dispatch goes red on a contract that image never shipped; too
// strict and the spec skips on the nightly, which is the green all-skip #1010
// exists to prevent — and the daily would never notice, since a skipped test says
// nothing. So both directions are asserted around the exact boundary, and the
// ordering is asserted against the PEP 440 rule Langflow's own tags follow
// (dev < rc < final), which a plain numeric-tuple comparison gets backwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_REDACTION_VERSION,
  compareLangflowVersions,
  parseLangflowVersion,
  redactionVerdict,
} from "./validation-redaction-gate";

const parse = (v: string) => {
  const p = parseLangflowVersion(v);
  assert.ok(p, `${v} should parse`);
  return p;
};

test("the version shapes Langflow actually ships all parse", () => {
  assert.deepEqual(parse("1.12.2").release, [1, 12, 2]);
  assert.deepEqual(parse("1.13.0.dev14").release, [1, 13, 0]);
  assert.equal(parse("1.13.0.dev14").serial, 14);
  assert.equal(parse("1.11.2rc3").serial, 3);
  // Every one of these is a tag this project has actually published (checked
  // against the upstream clone: `1.1.4.post1`, `1.5.0.post1`, `1.8.0qa1`,
  // `1.7.0-pre`, and a `b` run on 0.5.x).
  assert.equal(parse("1.5.0.post1").serial, 1);
  assert.deepEqual(parse("0.5.0b6").release, [0, 5, 0]);
  assert.deepEqual(parse("1.7.0-pre").release, [1, 7, 0]);
  // Both spellings PEP 440 normalises to the same build.
  assert.deepEqual(parse("1.13.0.rc1"), parse("1.13.0rc1"));
  assert.deepEqual(parse("1.13.0dev9"), parse("1.13.0.dev9"));
});

test("an unreadable SUFFIX keeps the release triple — it is not a parse failure", () => {
  // `1.8.0qa1` is a published tag. Refusing it whole would hard-FAIL a dispatch
  // that should simply skip, which is the opposite of this gate's purpose.
  const qa = parse("1.8.0qa1");
  assert.deepEqual(qa.release, [1, 8, 0]);
  assert.equal(qa.stage, null);
  // It still orders against a floor on another release, because the triple decides.
  assert.equal(compareLangflowVersions(qa, parse(MIN_REDACTION_VERSION)), -1);
  // And it is UNORDERABLE only against its own release.
  assert.equal(compareLangflowVersions(qa, parse("1.8.0")), null);
});

test("a version with no readable release triple is null, never a guess", () => {
  for (const bad of ["", "1.13", "v1.13.0", "nightly", "1.x.0"]) {
    assert.equal(parseLangflowVersion(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
  for (const bad of [null, undefined, 113, {}, ["1.13.0"]]) {
    assert.equal(parseLangflowVersion(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test("ordering follows PEP 440: dev < a < b < rc < final < post", () => {
  // A numeric tuple gets two of these backwards: it sorts `1.13.0` BELOW
  // `1.13.0.dev14`, and `1.13.0.post1` below `1.13.0`.
  const ascending = [
    "1.12.2",
    "1.13.0.dev9",
    "1.13.0.dev10",
    "1.13.0.dev14",
    "1.13.0a1",
    "1.13.0b1",
    "1.13.0rc1",
    "1.13.0",
    "1.13.0.post1",
    "1.13.1.dev1",
    "1.14.0.dev1",
  ];
  for (let i = 0; i + 1 < ascending.length; i++) {
    const a = parse(ascending[i]);
    const b = parse(ascending[i + 1]);
    assert.equal(compareLangflowVersions(a, b), -1, `${ascending[i]} < ${ascending[i + 1]}`);
    assert.equal(compareLangflowVersions(b, a), 1, `${ascending[i + 1]} > ${ascending[i]}`);
  }
  assert.equal(compareLangflowVersions(parse("1.13.0.dev14"), parse("1.13.0.dev14")), 0);

  // `post` ranking ABOVE `final` is asserted structurally, not through an
  // ordering: a final release always carries serial 0, so `1.13.0.post1` sorts
  // after `1.13.0` on the serial alone and collapsing the two ranks is
  // behaviourally inert for every version string that can exist. Pinning the
  // rank is what keeps the code expressing PEP 440 instead of a coincidence.
  assert.ok(
    (parse("1.13.0.post1").stage as number) > (parse("1.13.0").stage as number),
    "post must rank above final",
  );
});

test("the boundary is exactly the first build carrying the handler", () => {
  // One below and one at the floor — the pair that a >= / > slip would break.
  const below = redactionVerdict({ version: "1.13.0.dev9" });
  assert.equal(below.available, false);
  assert.ok("skipReason" in below && below.skipReason.includes("1.13.0.dev9"));
  assert.ok("skipReason" in below && below.skipReason.includes(MIN_REDACTION_VERSION));

  assert.deepEqual(redactionVerdict({ version: MIN_REDACTION_VERSION }), { available: true });
});

test("the nightly the daily runs is available, and released 1.12.x skips", () => {
  assert.deepEqual(redactionVerdict({ version: "1.13.0.dev14" }), { available: true });
  assert.deepEqual(redactionVerdict({ version: "1.14.0" }), { available: true });
  assert.equal(redactionVerdict({ version: "1.12.2" }).available, false);
  assert.equal(redactionVerdict({ version: "1.11.2rc3" }).available, false);
});

test("a post-release of a line that HAS the handler runs, and does not fail the daily", () => {
  // The dangerous direction: `1.13.0.post1` carries the handler, so refusing to
  // order it would redden a run with a message telling the reader to fix OUR gate.
  assert.deepEqual(redactionVerdict({ version: "1.13.0.post1" }), { available: true });
  assert.deepEqual(redactionVerdict({ version: "1.13.2.post1" }), { available: true });
});

test("an old tag with an exotic suffix SKIPS rather than failing the run", () => {
  // Published tags, all below the floor: the triple decides and the suffix never
  // has to be understood.
  for (const version of ["1.1.4.post1", "1.8.0qa1", "1.7.0-pre", "0.5.0b6"]) {
    assert.equal(
      redactionVerdict({ version }).available,
      false,
      `${version} predates the floor and must skip, not fail`,
    );
  }
});

test("no suffix can reach a rank through Object.prototype", () => {
  // `SEGMENT_ALIASES` is a Map for this reason: an object index walks the
  // prototype, where `constructor` is the one all-lowercase property the
  // `[a-z]+` segment can spell. Reaching it there returns a FUNCTION as the
  // rank, which compares as NaN and resolves to "newer than the floor" — a
  // wrong `available: true` instead of the honest `unknown`.
  for (const suffix of ["constructor", "tostring", "valueof", "hasownproperty"]) {
    const parsed = parse(`1.13.0.${suffix}`);
    assert.equal(parsed.stage, null, `1.13.0.${suffix} must not resolve to a rank`);
    assert.equal(redactionVerdict({ version: `1.13.0.${suffix}` }).available, "unknown");
  }
});

test("a PEP 440 local version is ordered by the release it was built from", () => {
  // `1.13.0.dev10+g1234` is what a setuptools-scm build of the release line
  // emits, and it DOES carry the handler — so it must run, not hard-fail.
  assert.deepEqual(redactionVerdict({ version: "1.13.0.dev14+g1234" }), { available: true });
  assert.deepEqual(redactionVerdict({ version: "1.13.0+local" }), { available: true });
  assert.equal(redactionVerdict({ version: "1.12.2+g99" }).available, false);
});

test("PEP 440 case-insensitivity and a serial-less segment are both honoured", () => {
  // Both are legal spellings, and each pins a line the ordering depends on:
  // without toLowerCase() a `DEV` build reads as unreadable, and without the
  // optional serial a bare `dev` does.
  assert.deepEqual(parse("1.13.0.DEV14"), parse("1.13.0.dev14"));
  assert.equal(redactionVerdict({ version: "1.13.0.DEV14" }).available, true);
  // A bare `dev` is `dev0`, which is BELOW the dev10 floor; a bare `post` is
  // `post0`, which is above every dev of the same release.
  assert.equal(redactionVerdict({ version: "1.13.0.dev" }).available, false);
  assert.equal(redactionVerdict({ version: "1.13.0.post" }).available, true);
  // Padding is trimmed rather than making the whole string unreadable.
  assert.deepEqual(parse("  1.13.0.dev14  "), parse("1.13.0.dev14"));
});

test("only an unreadable suffix ON THE FLOOR'S OWN RELEASE is undecidable", () => {
  const v = redactionVerdict({ version: "1.13.0qa1" });
  assert.equal(v.available, "unknown");
  assert.ok("failReason" in v && v.failReason.includes("validation-redaction-gate.ts"));
});

test("an unreadable version is UNKNOWN, never a skip and never available", () => {
  for (const body of [{}, { version: null }, { version: "nightly" }, null, undefined, "1.13.0"]) {
    const v = redactionVerdict(body);
    assert.equal(
      v.available,
      "unknown",
      `${JSON.stringify(body)} must not resolve to a verdict`,
    );
    // The caller FAILS on this, so the reason has to point at the gate, not at the
    // product: a spec author reading it must not file a Langflow bug.
    assert.ok("failReason" in v && v.failReason.includes("validation-redaction-gate.ts"));
  }
});

test("the skip reason names the upstream change, so a skipped run is diagnosable", () => {
  const v = redactionVerdict({ version: "1.12.2" });
  assert.ok("skipReason" in v);
  assert.match(v.skipReason, /validation_errors\.py/);
  assert.match(v.skipReason, /15038|LE-2462/);
});
