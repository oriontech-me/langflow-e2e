// Unit tests for the model-toggle persistence-write verdict (issue #1696).
// Run with: npm run test:units
//
// What rides on this file: a model toggle persists through a ~1 s debounced
// `POST /api/v1/models/enabled_models`, and the spec arms `page.waitForResponse`
// BEFORE clicking because navigating away first would drop the write. On daily
// 2026-09-01 (run `33511210195`) that wait timed out on BOTH tests of
// `model-provider-model-toggle.spec.ts`, and all the run recorded was
//
//   TimeoutError: page.waitForResponse: Timeout 15000ms exceeded while waiting
//   for event "response"
//
// — a string that cannot distinguish the two very different things that produce
// it: the UI never firing the write at all (a suite or product defect) and the
// instance not answering one that was sent (saturation). The budget is NOT the
// fix and is deliberately unchanged; a saturated instance still fails, and
// correctly. What changes is that the failure says WHICH half broke, so the
// next occurrence is not a fifth nameless signature (#1012/#1626).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toggleWriteVerdict,
  type ToggleWriteSnapshot,
} from "./model-toggle-write";

const ENDPOINT = "/api/v1/models/enabled_models";

const BASE: ToggleWriteSnapshot = {
  requestsSeen: 0,
  responsesSeen: 0,
  ariaChecked: "false",
  wantedEnabled: false,
  model: "gpt-4o-mini",
};

test("no request observed is not-issued — the UI never fired the write", () => {
  const v = toggleWriteVerdict(BASE, ENDPOINT, 15000);
  assert.equal(v.kind, "not-issued");
  assert.match(v.message, /^TOGGLE_WRITE_NOT_ISSUED:/);
  assert.match(v.message, /gpt-4o-mini/);
  assert.match(v.message, /15000ms/);
  assert.match(v.message, new RegExp(ENDPOINT.replace(/\//g, "\\/")));
  // Must point at the suite/product, never at the instance.
  assert.doesNotMatch(v.message, /saturat/i);
});

test("not-issued names the aria-checked the switch was left showing", () => {
  // The optimistic update is what tells a reader whether the click even landed:
  // aria-checked flipped with no POST is a debounce/queue defect, while an
  // unflipped switch means the click itself did nothing.
  const v = toggleWriteVerdict(
    { ...BASE, ariaChecked: "true", wantedEnabled: false },
    ENDPOINT,
    15000,
  );
  assert.match(v.message, /aria-checked/);
  assert.match(v.message, /"true"/);
  assert.match(v.message, /"false"/); // what was asked for
});

test("a request with no response is unanswered — the instance did not answer", () => {
  const v = toggleWriteVerdict({ ...BASE, requestsSeen: 1 }, ENDPOINT, 15000);
  assert.equal(v.kind, "unanswered");
  assert.match(v.message, /^TOGGLE_WRITE_UNANSWERED:/);
  assert.match(v.message, /INSTANCE/);
  assert.match(v.message, /1 /); // the request count
  assert.match(v.message, /15000ms/);
});

test("unanswered refuses to invite a bigger budget", () => {
  // #1648's rule: raising the budget hides the stall the verdict exists to name.
  const v = toggleWriteVerdict({ ...BASE, requestsSeen: 3 }, ENDPOINT, 15000);
  assert.match(v.message, /(do not raise|never raise)/i);
  assert.match(v.message, /#1696/);
});

test("several requests and fewer responses is still unanswered, with both counts", () => {
  // The debounced queue can coalesce or retry, so the pair is what a reader
  // needs: 3 sent / 2 answered is a different story from 3 sent / 0 answered.
  const v = toggleWriteVerdict(
    { ...BASE, requestsSeen: 3, responsesSeen: 2 },
    ENDPOINT,
    15000,
  );
  assert.equal(v.kind, "unanswered");
  assert.match(v.message, /3 /);
  assert.match(v.message, /2 /);
});

test("requestsSeen decides the verdict, never responsesSeen", () => {
  // The load-bearing branch, and the one a refactor would most plausibly break:
  // a response counted without its request would flip the diagnosis from
  // "the UI is broken" to "the instance is slow" and send triage the wrong way.
  assert.equal(
    toggleWriteVerdict({ ...BASE, requestsSeen: 0, responsesSeen: 9 }, ENDPOINT, 15000)
      .kind,
    "not-issued",
  );
  assert.equal(
    toggleWriteVerdict({ ...BASE, requestsSeen: 1, responsesSeen: 0 }, ENDPOINT, 15000)
      .kind,
    "unanswered",
  );
});
