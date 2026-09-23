import { test } from "node:test";
import assert from "node:assert/strict";

import { MERGE_CODES } from "./merge-token-payload.mjs";
import { describeMergeOutcome, describeIngest, readIngestFields } from "./post-token-payload.mjs";

// ---------------------------------------------------------------------------
// The merge verdicts
// ---------------------------------------------------------------------------

test("every code merge-token-payload can emit is handled", () => {
  // The same guarantee daily-stable.yml's structural guard gives its own step: a new
  // code this does not know about would be reported as the default one, which is a
  // real outcome losing its name.
  for (const code of MERGE_CODES) {
    const out = describeMergeOutcome(code);
    if (code === "merged") {
      assert.equal(out, null, "`merged` is not an ending — the POST follows it");
      continue;
    }
    assert.ok(out && out.text, `${code} reached no description`);
    assert.doesNotMatch(out.text, /no verdict/, `${code} fell through to the unknown branch`);
  }
});

test("an absent block and an unparseable one are DIFFERENT facts", () => {
  // The conflation this path exists to prevent: one is a run that captured nothing,
  // the other is a run whose spend was computed and then lost.
  const missing = describeMergeOutcome("block_missing");
  const unparseable = describeMergeOutcome("block_unparseable");

  assert.match(missing.text, /captured nothing/);
  assert.equal(missing.level, "notice", "capturing nothing is normal, not a warning");

  assert.match(unparseable.text, /LOST/);
  assert.equal(unparseable.level, "warning");
  assert.notEqual(missing.text, unparseable.text);
});

test("an unknown code is UNKNOWN, never zero and never a neighbour", () => {
  const out = describeMergeOutcome("something_new");
  assert.match(out.text, /UNKNOWN, not zero/);
  assert.equal(out.level, "warning");
});

test("a missing code is still reported rather than read as success", () => {
  assert.match(describeMergeOutcome(undefined).text, /UNKNOWN, not zero/);
});

// ---------------------------------------------------------------------------
// The ingest verdicts — HTTP 200 is not the verdict
// ---------------------------------------------------------------------------

test("only ingested-with-nothing-dropped counts as delivered", () => {
  const out = describeIngest({ status: "ingested", dropped: "0", received: "42", superseded: false });
  assert.equal(out.level, "info");
  assert.match(out.text, /delivered/);
  assert.match(out.text, /42 row/);
});

test("a rejected block inside a 200 is not delivery", () => {
  const out = describeIngest({ status: "rejected", dropped: "0", received: "0", superseded: false });
  assert.equal(out.level, "warning");
  assert.match(out.text, /did not ingest/);
  assert.doesNotMatch(out.text, /delivered/);
});

test("dropped rows are named with both numbers", () => {
  const out = describeIngest({ status: "ingested", dropped: "3", received: "42", superseded: false });
  assert.equal(out.level, "warning");
  assert.match(out.text, /dropped 3 of 42/);
  assert.doesNotMatch(out.text, /delivered/);
});

test("an absent tokens_status is UNKNOWN, not a zero", () => {
  for (const fields of [{}, { status: "absent" }, { status: null }]) {
    const out = describeIngest(fields);
    assert.equal(out.level, "warning");
    assert.match(out.text, /UNKNOWN/);
  }
});

test("a superseded rejection names the supersede flag", () => {
  const out = describeIngest({ status: "rejected", superseded: true });
  assert.match(out.text, /superseded=true/);
});

// ---------------------------------------------------------------------------
// Reading the body
// ---------------------------------------------------------------------------

test("the four fields come from ONE parse", () => {
  const f = readIngestFields('{"tokens_status":"ingested","tokens_dropped":0,"tokens_received":7,"tokens_superseded":false}');
  assert.deepEqual(f, { status: "ingested", dropped: 0, received: 7, superseded: false });
});

test("an unreadable body yields absent everywhere, never a plausible zero", () => {
  const f = readIngestFields("not json at all");
  assert.deepEqual(f, { status: "absent", dropped: "absent", received: "absent", superseded: "absent" });
  // And the description built from it must not claim delivery.
  assert.match(describeIngest(f).text, /UNKNOWN/);
});

test("a present-but-null field is absent, not null", () => {
  const f = readIngestFields('{"tokens_status":"ingested","tokens_dropped":null,"tokens_received":null}');
  assert.equal(f.dropped, "absent");
  assert.equal(f.received, "absent");
  // dropped !== "0", so this is NOT reported as delivered.
  assert.doesNotMatch(describeIngest(f).text, /delivered/);
});

test("a numeric zero dropped still reads as delivered", () => {
  // `0 !== "0"` in JS, and the comparison is on the stringified value for that reason.
  const f = readIngestFields('{"tokens_status":"ingested","tokens_dropped":0,"tokens_received":5}');
  assert.match(describeIngest(f).text, /delivered/);
});
