// Unit tests for the sidebar-add post-condition (issue #1304).
// Run with: npm run test:units
//
// What rides on these functions: whether a dropped sidebar click is REPAIRED and
// named, or shows up as some caller's generic "the node is not visible" timeout.
//
// Measured on nightly 1.12.0.dev17 (issue #1304): 4 of 20 adds of the Language
// Model component produced no node within 4 s, and in all 4 an identical second
// fill+click produced it — with the "+" button still visible, the search input
// still holding the term, and no POST/PATCH /api/v1/flows write after the first
// click in 3 of the 4. So the click is accepted by the DOM and the app never
// registers the add: the swallowed-click class (#420/#966) one layer later, on the
// surface #537 already recorded as re-rendering while its catalog streams in.
//
// On the 2026-08-05 daily (run 30997773754) that drop cost three specs on one
// shard inside 100 s — `stop-building.spec.ts:24` (`div-generic-node`),
// `langflowShortcuts.spec.ts:47` ("the Chat Output component should be on the
// canvas") and `modelInputComponent.spec.ts:106` on all 3 attempts — three
// different messages for one mechanism, none of which named it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  ADD_LANDED_TIMEOUT_MS,
  classifyAddOutcome,
  duplicatedAddMessage,
  lostNodeMessage,
  swallowedAddMessage,
} from "./add-component-from-sidebar";

const DETAIL = {
  searchTerm: "language model",
  addButtonTestId: "add-component-button-language-model",
  before: 0,
  after: 0,
  perAttemptMs: ADD_LANDED_TIMEOUT_MS,
  buttonStillVisible: true,
  searchValue: "language model",
};

test("one more node than before the click is a landed add", () => {
  assert.equal(classifyAddOutcome(0, 1), "landed");
  assert.equal(classifyAddOutcome(3, 4), "landed");
});

test("an unchanged node count is a swallowed click, not a slow one", () => {
  assert.equal(classifyAddOutcome(0, 0), "swallowed");
  assert.equal(classifyAddOutcome(2, 2), "swallowed");
});

test("more than one new node is reported as duplicated, never as landed", () => {
  // The re-issue is what can produce this: a first click delivered late, right
  // as the second one lands. Reading it as "landed" would hand the caller a
  // canvas with two nodes and let its own count assertion fail somewhere else.
  assert.equal(classifyAddOutcome(0, 2), "duplicated");
  assert.equal(classifyAddOutcome(1, 5), "duplicated");
});

test("a node count that DROPPED is not silently treated as a swallowed click", () => {
  // Nothing in the suite should delete a node during an add. If it happens, the
  // canvas is in a state this helper must not paper over.
  assert.equal(classifyAddOutcome(2, 1), "lost");
});

test("the swallowed-click message names the mechanism, the click and the budget", () => {
  const msg = swallowedAddMessage({ ...DETAIL, attempts: 2 });

  assert.match(msg, /swallowed/i);
  assert.match(msg, /add-component-button-language-model/);
  assert.match(msg, /language model/);
  // Both the number of clicks issued and the per-attempt budget, so a reader can
  // tell "the add never landed in 2 x 12 s" from "the test did not wait".
  assert.match(msg, /2 attempt/);
  assert.match(msg, /12000ms|12 ?s/);
});

test("the swallowed-click message reports the observed sidebar state", () => {
  // These three facts are what separate "the click did nothing" from "the sidebar
  // was gone / the search was reset", and they are unrecoverable after the fact.
  const msg = swallowedAddMessage({
    ...DETAIL,
    attempts: 2,
    buttonStillVisible: false,
    searchValue: "",
  });

  assert.match(msg, /button still visible: no/i);
  assert.match(msg, /search input: ""/);
  assert.match(msg, /node count: 0 before, 0 after/);
});

test("the swallowed-click message is NOT classifiable as an infra failure", () => {
  // Same rule as the page-entry barrier (#1262): claiming infra here would exempt
  // the failure from @stable auto-removal and hide a genuine add regression.
  assert.equal(classifyInfraError(swallowedAddMessage({ ...DETAIL, attempts: 2 })), null);
});

test("the lost-node message blames the canvas, not the click", () => {
  // A canvas that ENDS with fewer nodes than it started with is a different
  // problem, and calling it a swallowed click would send triage the wrong way.
  const msg = lostNodeMessage({ ...DETAIL, before: 2, after: 1, attempts: 1 });

  assert.match(msg, /lost/i);
  assert.doesNotMatch(msg, /swallowed/i);
  assert.match(msg, /node count: 2 before, 1 after/);
});

test("the duplicated-add message states BOTH causes instead of claiming a product double-add", () => {
  const msg = duplicatedAddMessage({ ...DETAIL, after: 2, attempts: 2 });

  assert.match(msg, /2 nodes/);
  // The late-first-click reading must be offered, or this message reads as a
  // Langflow defect the evidence does not support.
  assert.match(msg, /late|delayed/i);
  assert.match(msg, /re-issued|second click/i);
});
