// Unit tests for the registered-templates baseline writer (#1862).
// Run with: npm run test:units
//
// Only the pure part is covered here — the writer itself needs a live Langflow.
// What matters is `readExistingDeclarations`: a declared absence is invisible in
// the listing by definition, so only a human can state one. If a refresh dropped
// it, #1744's justification would disappear with no diff line to review, which is
// exactly the silent expiry #1084 was raised about.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "./lib/tmp-dir.mjs";
import { readExistingDeclarations } from "./update-registered-templates-baseline";

const withTempFile = (contents: string | null, fn: (p: string) => void): void => {
  const dir = makeTempDir("tpl-baseline-");
  const file = path.join(dir, "registered-templates-baseline.json");
  try {
    if (contents !== null) fs.writeFileSync(file, contents);
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("declarations on disk survive a refresh", () => {
  const declared = [
    {
      nameKey: "research_translation_loop",
      name: "Research Translation Loop",
      reason: "ArXivComponent is not shipped by this image.",
      issue: "#1744",
      unavailableComponents: ["ArXivComponent"],
    },
  ];
  withTempFile(JSON.stringify({ version: "x", templates: [], declaredAbsences: declared }), (p) => {
    assert.deepEqual(readExistingDeclarations(p), declared);
  });
});

test("a first capture, with no file yet, declares nothing rather than throwing", () => {
  withTempFile(null, (p) => {
    assert.deepEqual(readExistingDeclarations(p), []);
  });
});

test("an unreadable or shapeless file yields no declarations rather than throwing", () => {
  // The writer must still be able to recover a corrupted baseline. Losing the
  // declarations here is safe because the contradiction check in `main` refuses
  // to write when a declared absence is registered — and a declaration that is
  // genuinely gone shows as a diff line the committer has to accept.
  for (const contents of ["{ not json", "null", "[]", '{"declaredAbsences": "nope"}', "{}"]) {
    withTempFile(contents, (p) => {
      assert.deepEqual(readExistingDeclarations(p), [], `for ${contents}`);
    });
  }
});

test("the committed baseline's declarations round-trip through the reader", () => {
  const committed = path.join(
    __dirname,
    "../tests/assets/templates/registered-templates-baseline.json",
  );
  const declared = readExistingDeclarations(committed);
  assert.equal(declared.length, 1);
  assert.equal(declared[0].nameKey, "research_translation_loop");
  assert.equal(declared[0].issue, "#1744");
});
