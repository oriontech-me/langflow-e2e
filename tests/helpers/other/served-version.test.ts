// Unit tests for the served-version contract switch (issue #2336).
// Run with: npm run test:units
import { test } from "node:test";
import assert from "node:assert/strict";
import { versionAtLeast } from "./served-version";

const FLOOR = "1.14.0.dev4";

test("builds from the floor on are on the new side", () => {
  for (const version of ["1.14.0.dev4", "1.14.0.dev6", "1.14.0rc1", "1.14.0", "1.14.1", "1.15.0.dev0"]) {
    assert.equal(versionAtLeast(version, FLOOR), true, version);
  }
});

test("builds before the floor are on the old side, the 1.13 patch line included", () => {
  for (const version of ["1.14.0.dev3", "1.14.0.dev0", "1.13.0", "1.13.1rc0", "1.13.1", "1.13.9.post1"]) {
    assert.equal(versionAtLeast(version, FLOOR), false, version);
  }
});

test("an unreadable version throws instead of picking a side", () => {
  for (const raw of [undefined, null, "", "latest", 1.14]) {
    assert.throws(() => versionAtLeast(raw, FLOOR), /cannot be parsed/, JSON.stringify(raw));
  }
});

test("a version tied with the floor's release but unorderable throws", () => {
  assert.throws(() => versionAtLeast("1.14.0qa1", FLOOR), /cannot be ordered/);
});

test("dev serials compare as numbers, not strings (#2525: the LE-3454 gate sits at dev32)", () => {
  assert.equal(versionAtLeast("1.14.0.dev32", "1.14.0.dev4"), true, "dev32 >= dev4");
  assert.equal(versionAtLeast("1.14.0.dev4", "1.14.0.dev32"), false, "dev4 < dev32");
  assert.equal(versionAtLeast("1.14.0.dev100", "1.14.0.dev32"), true, "dev100 >= dev32");
  assert.equal(versionAtLeast("1.14.0.dev31", "1.14.0.dev32"), false, "dev31 < dev32");
  assert.equal(versionAtLeast("1.14.0.dev32", "1.14.0.dev32"), true, "dev32 >= dev32");
});

test("a final release is above every dev build of it", () => {
  assert.equal(versionAtLeast("1.14.0", "1.14.0.dev32"), true);
  assert.equal(versionAtLeast("1.14.0.dev32", "1.14.0"), false);
});
