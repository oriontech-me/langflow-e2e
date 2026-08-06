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
//
// THE POST-CONDITION IS A SET DIFFERENCE, NOT A COUNT DELTA, and that is a
// correction this file's first version paid for. It required `after === before + 1`
// and hard-failed anything else as a duplicated add. CI run 31048371247 refuted it
// immediately: `agent-context-id-isolation.spec.ts:512` navigates to an
// API-seeded flow and waits only for `sidebar-search-input`, so the canvas is
// still mounting the flow's OWN nodes when the baseline is taken — one legitimate
// click then took the count from 0 to 3 and a healthy add was reported as
// "left 3 nodes on the canvas instead of 1". A baseline that can grow on its own
// is no evidence of a double add, so overshoot is not an outcome this helper
// judges: exact counts belong to the callers, which already assert them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  ADD_LANDED_TIMEOUT_MS,
  classifyAddOutcome,
  newNodeIds,
  swallowedAddMessage,
} from "./add-component-from-sidebar";

const DETAIL = {
  searchTerm: "language model",
  addButtonTestId: "add-component-button-language-model",
  beforeCount: 0,
  afterCount: 0,
  attempts: 2,
  perAttemptMs: ADD_LANDED_TIMEOUT_MS,
  buttonStillVisible: true,
  searchValue: "language model",
};

test("a node id that was not there before is a landed add", () => {
  assert.deepEqual(newNodeIds(["rf__node-a"], ["rf__node-a", "rf__node-b"]), [
    "rf__node-b",
  ]);
  assert.equal(
    classifyAddOutcome(["rf__node-a"], ["rf__node-a", "rf__node-b"]),
    "landed",
  );
});

test("an unchanged node set is a swallowed click, not a slow one", () => {
  assert.equal(classifyAddOutcome([], []), "swallowed");
  assert.equal(
    classifyAddOutcome(["rf__node-a", "rf__node-b"], ["rf__node-b", "rf__node-a"]),
    "swallowed",
  );
});

test("a canvas still mounting a loaded flow's own nodes is a landed add, not a duplicate", () => {
  // The regression from CI run 31048371247: one legitimate click on
  // `add-component-button-message-history` against an API-seeded flow whose two
  // nodes had not rendered when the baseline was taken. A count delta read this
  // as "3 nodes instead of 1" and hard-failed a healthy add.
  assert.equal(
    classifyAddOutcome(
      [],
      ["rf__node-Memory-x", "rf__node-ChatInput-y", "rf__node-ChatOutput-z"],
    ),
    "landed",
  );
});

test("a node vanishing while a new one appears is still a landed add", () => {
  // Same count before and after, different members: the add landed. A delta-based
  // check would call this swallowed and re-click, adding a second node.
  assert.equal(
    classifyAddOutcome(["rf__node-a"], ["rf__node-b"]),
    "landed",
  );
});

test("the swallowed-click message names the mechanism, the click and the budget", () => {
  const msg = swallowedAddMessage(DETAIL);

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
    buttonStillVisible: false,
    searchValue: "",
  });

  assert.match(msg, /button still visible: no/i);
  assert.match(msg, /search input: ""/);
  assert.match(msg, /node count: 0 before, 0 after/);
});

test("a swallowed DRAG is reported as a drag, on its own measured evidence", () => {
  // #1335, second half. Same product defect, different gesture — and the reader
  // has to be sent to the right line. Naming the click would point at a "+"
  // button the spec never touches.
  const msg = swallowedAddMessage({
    ...DETAIL,
    gesture: "drag",
    addButtonTestId: "data_sourceAPI Request",
    searchTerm: "api request",
  });

  assert.match(msg, /drag add was swallowed/);
  assert.match(msg, /dragTo\(\) from getByTestId\("data_sourceAPI Request"\)/);
  assert.match(msg, /onto the canvas/);
  // The click path's 4/20 was measured on the click surface; quoting it for a
  // drag would attribute a number to a surface it was never taken on.
  assert.match(msg, /1\/5 on nightly 1\.12\.0\.dev18/);
  assert.doesNotMatch(msg, /4\/20/);
  assert.doesNotMatch(msg, /The click\(s\) were accepted/);
  // A drag has no "+" button to report on.
  assert.doesNotMatch(msg, /"\+" button still visible/);
  assert.match(msg, /sidebar entry still visible/);
});

test("the gesture defaults to click, so the pre-#1335 message is unchanged", () => {
  // The 34 existing call sites never pass a gesture. If the default drifted, all
  // of them would start reporting a drag they never performed.
  const withoutGesture = swallowedAddMessage(DETAIL);
  const explicitClick = swallowedAddMessage({ ...DETAIL, gesture: "click" });

  assert.equal(withoutGesture, explicitClick);
  assert.match(withoutGesture, /click add was swallowed/);
  assert.match(withoutGesture, /4\/20/);
});

test("a swallowed drag stays unclassifiable as infra, like the click one", () => {
  // #1262's rule reaches the new gesture too: a real add regression must stay
  // eligible for @stable auto-removal.
  assert.equal(
    classifyInfraError(swallowedAddMessage({ ...DETAIL, gesture: "drag" })),
    null,
  );
});

test("a tab with no search box reports no term and no input, not an empty one", () => {
  // #1335: the MCP tab (`sidebar-nav-mcp`) adds entries straight from its list,
  // so there is no term to name and no input to read back. `search input: ""` is
  // a real observation on the Components tab (the input was reset) and must not
  // read the same as "this tab has no input" — otherwise the reader is told the
  // search was cleared by a surface that never had one.
  const msg = swallowedAddMessage({
    ...DETAIL,
    searchTerm: null,
    searchValue: null,
    addButtonTestId: "add-component-button-lf-starter_project",
  });

  assert.match(msg, /no search box/i);
  assert.match(msg, /search input: <none on this tab>/);
  assert.doesNotMatch(msg, /after filling the sidebar search/);
  assert.doesNotMatch(msg, /search input: ""/);
  // Still names the click and the budget — the two facts the message exists for.
  assert.match(msg, /add-component-button-lf-starter_project/);
  assert.match(msg, /2 attempt/);
});

test("the no-search message stays unclassifiable as infra, like the search one", () => {
  // Same rule as below: a swallowed add on the MCP tab is a real add regression
  // and must stay eligible for @stable auto-removal (#1262).
  assert.equal(
    classifyInfraError(
      swallowedAddMessage({ ...DETAIL, searchTerm: null, searchValue: null }),
    ),
    null,
  );
});

test("the swallowed-click message is NOT classifiable as an infra failure", () => {
  // Same rule as the page-entry barrier (#1262): claiming infra here would exempt
  // the failure from @stable auto-removal and hide a genuine add regression.
  assert.equal(classifyInfraError(swallowedAddMessage(DETAIL)), null);
});
