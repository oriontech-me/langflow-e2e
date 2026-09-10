// Unit tests for the account axis (#1800).
//
// Run: npm run test:scripts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  foldUsability,
  readUsability,
  usabilityState,
} from "./provider-usability.mjs";

/** The shape `collect-models` writes, trimmed to the two fields this reads. */
const record = (provider, status, error = null) => ({
  provider,
  model: status === "active" ? "some-model" : null,
  status,
  error,
});

test("a provider recorded active makes the account alive", () => {
  const usability = foldUsability([
    [record("openai", "active"), record("google", "inactive", "spending cap")],
  ]);
  assert.deepEqual(usability, { known: true, active: ["openai"] });
  assert.equal(usabilityState(usability), "alive");
});

test("every provider inactive is a DRY account, not an unknown one", () => {
  // The distinction decides whether a lane fails: dry means a re-run cannot help.
  const usability = foldUsability([
    [record("openai", "inactive", "no credits"), record("google", "inactive", "cap")],
  ]);
  assert.deepEqual(usability, { known: true, active: [] });
  assert.equal(usabilityState(usability), "dry");
});

// The daily collects health per SHARD, and the four sweeps can legitimately disagree
// when a key recovers mid-run. One shard reaching a provider proves the ACCOUNT could,
// so the fold is a union — the intersection would let one shard's transient failure
// report the account as dead and fail a run the other three covered.
test("the shards union, they do not intersect", () => {
  const shard1 = [record("openai", "inactive", "no credits"), record("google", "active")];
  const shard2 = [record("openai", "active"), record("google", "inactive", "cap")];

  assert.deepEqual(foldUsability([shard1, shard2]), {
    known: true,
    active: ["google", "openai"],
  });
  assert.deepEqual(foldUsability([shard1]), { known: true, active: ["google"] });
});

test("no readable file is UNKNOWN, never dry", () => {
  // `providers.json` is gitignored and only exists after `collect-models`, which is
  // legitimately skipped and legitimately allowed to fail. Reading absence as "dry"
  // would fail a lane over a file that was never meant to be there.
  assert.deepEqual(foldUsability([]), { known: false, active: [] });
  assert.equal(usabilityState(foldUsability([])), "unknown");
  assert.equal(usabilityState({ known: false, active: [] }), "unknown");
  assert.equal(usabilityState(undefined), "unknown");
});

test("a shape it does not recognise degrades instead of throwing", () => {
  // This consumes a file written by another process on another machine, inside a
  // reporting step that must not be the thing that reddens a run.
  assert.deepEqual(foldUsability([null, "nope", 42, {}]), { known: false, active: [] });
  assert.deepEqual(foldUsability([[null, "x", { status: "active" }, { provider: "  " }]]), {
    known: true,
    active: [],
  });
  // An empty array IS a readable answer: the sweep ran and recorded nothing active.
  assert.deepEqual(foldUsability([[]]), { known: true, active: [] });
});

test("readUsability names what it could not read instead of dropping it", () => {
  const files = {
    "ok.json": JSON.stringify([record("openai", "active")]),
    "bad.json": "{",
    "object.json": JSON.stringify({ openai: "active" }),
  };
  const readFile = (p) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  };

  const usability = readUsability(
    ["ok.json", "bad.json", "object.json", "gone.json"],
    { readFile },
  );
  assert.deepEqual(usability.active, ["openai"]);
  assert.equal(usability.known, true);
  // Unparseable, wrong-shaped and absent are all reported — a silently dropped file
  // is what would decide a verdict without saying so (#1012).
  assert.deepEqual(usability.unread, ["bad.json", "object.json", "gone.json"]);
});

test("readUsability with no paths is unknown and reports nothing unread", () => {
  const usability = readUsability([], { readFile: () => "[]" });
  assert.deepEqual(usability, { known: false, active: [], unread: [] });
});
