// Unit tests for the raw i18n key detector (#2304).
// Run with: npm run test:units
//
// The detector is what makes "no raw key" a check at all, so both of its
// directions are pinned: it matches the keys the Connections surfaces use, and it
// does not match the dotted strings those surfaces legitimately show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRawKey, RAW_KEY_NAMESPACES } from "./i18n-raw-keys";

test("a key from each namespace the Connections surfaces read is a raw key", () => {
  for (const key of [
    "connections.title",
    "connections.add.tokenGenericHelp",
    "connections.status.auth-expired",
    "settings.nav.connections",
    "common.cancel",
    "loading.default",
  ]) {
    assert.equal(isRawKey(key), true, key);
  }
  assert.equal(isRawKey("  connections.title  "), true, "surrounding whitespace is trimmed");
});

test("what the surfaces legitimately show is not a raw key", () => {
  for (const text of [
    "Connections",
    "google/gmail_qa",
    "drive.file",
    "gmail.send",
    "Missing gmail.send",
    "https://www.googleapis.com/auth/drive.file",
    "read:page:confluence",
    "connections",
    "connections.",
    "the connections.title key",
  ]) {
    assert.equal(isRawKey(text), false, text);
  }
});

test("the namespaces are the four the Connections tree calls t() with", () => {
  assert.deepEqual([...RAW_KEY_NAMESPACES], ["connections", "settings", "common", "loading"]);
});
