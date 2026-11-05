// Unit tests for the flow storage namespace switch (issue #2338).
// Run with: npm run test:units
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowStorageFolder, usesTypedFlowNamespace } from "./flow-storage-namespace";

// Every 1.13.1 version is downstream of the fix (the bump follows it), so the 1.13
// floor is the lowest 1.13.1 version there is, not the first rc that was measured.
test("builds that carry LE-3242 store flow attachments under flow-<id>", () => {
  for (const version of [
    "1.13.1.dev0",
    "1.13.1.dev3",
    "1.13.1b1",
    "1.13.1rc0",
    "1.13.1",
    "1.13.2",
    "1.14.0.dev16",
    "1.14.0.dev18",
    "1.14.0rc1",
    "1.14.0",
    "1.15.0.dev0",
  ]) {
    assert.equal(usesTypedFlowNamespace(version), true, version);
  }
});

test("builds before it keep the bare <id>, the 1.14 nightlies up to dev15 included", () => {
  for (const version of [
    "1.12.1",
    "1.13.0",
    "1.13.0.post1",
    "1.14.0.dev0",
    "1.14.0.dev6",
    "1.14.0.dev15",
  ]) {
    assert.equal(usesTypedFlowNamespace(version), false, version);
  }
});

test("the folder is built from the flow id on either side of the change", () => {
  assert.equal(flowStorageFolder("1.14.0.dev18", "abc"), "flow-abc");
  assert.equal(flowStorageFolder("1.14.0.dev6", "abc"), "abc");
});

test("an unreadable version throws instead of picking a layout", () => {
  for (const raw of [undefined, null, "", "latest"]) {
    assert.throws(() => usesTypedFlowNamespace(raw), /cannot be parsed/, JSON.stringify(raw));
  }
});
