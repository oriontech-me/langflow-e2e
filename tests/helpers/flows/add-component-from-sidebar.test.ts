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
  SEARCH_ENTRY_TIMEOUT_MS,
  classifyAddOutcome,
  classifySearchFill,
  newNodeIds,
  noMatchingEntryMessage,
  searchResetMessage,
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

test("the dedicated Custom Component button names no term, but still reports its input", () => {
  // #1301. The Components tab HAS a search box; this button just does not use it.
  // Reporting it as `no-search-box` (the MCP-tab clause) would tell the reader the
  // surface has no input when it does — and `search input: ""` on a tab that owns
  // one is a real observation about the sidebar, so it must still be read back.
  const msg = swallowedAddMessage({
    ...DETAIL,
    surface: "dedicated-button",
    searchTerm: null,
    searchValue: "",
    addButtonTestId: "sidebar-custom-component-button",
  });

  assert.match(msg, /without typing a search term/);
  assert.match(msg, /sidebar-custom-component-button/);
  assert.match(msg, /search input: ""/);
  assert.doesNotMatch(msg, /no search box/i);
  assert.doesNotMatch(msg, /after filling the sidebar search/);
  // It is not a "+" button — naming it one sends the reader to the wrong control.
  assert.match(msg, /custom-component button still visible/);
  assert.doesNotMatch(msg, /"\+" button still visible/);
});

test("the dedicated button quotes ONLY the rate measured on it", () => {
  // Each surface has its own measurement. #1304's 4/20 was taken on the
  // Components-tab "+" buttons and #1335's 1/5 on the drag; quoting either here
  // would attribute a number to a surface it was never taken on.
  const msg = swallowedAddMessage({
    ...DETAIL,
    surface: "dedicated-button",
    searchTerm: null,
    searchValue: "",
  });

  assert.match(msg, /issue #1301/);
  assert.match(msg, /9 of 10/);
  assert.match(msg, /14 of 14/);
  assert.match(msg, /1\.12\.0\.dev23/);
  assert.doesNotMatch(msg, /4\/20/);
  assert.doesNotMatch(msg, /1\/5/);
});

test("the surface defaults to what searchTerm implies, so every pre-#1301 message is unchanged", () => {
  // 34+ call sites never pass a surface. If the default drifted, all of them would
  // start describing a control they never clicked.
  assert.equal(
    swallowedAddMessage(DETAIL),
    swallowedAddMessage({ ...DETAIL, surface: "search" }),
  );
  const noSearchBox = { ...DETAIL, searchTerm: null, searchValue: null };
  assert.equal(
    swallowedAddMessage(noSearchBox),
    swallowedAddMessage({ ...noSearchBox, surface: "no-search-box" }),
  );
});

test("the dedicated-button message stays unclassifiable as infra", () => {
  // #1262's rule reaches the new surface too: a genuine regression in adding a
  // Custom Component must stay eligible for @stable auto-removal.
  assert.equal(
    classifyInfraError(
      swallowedAddMessage({
        ...DETAIL,
        surface: "dedicated-button",
        searchTerm: null,
        searchValue: "",
      }),
    ),
    null,
  );
});

test("the swallowed-click message is NOT classifiable as an infra failure", () => {
  // Same rule as the page-entry barrier (#1262): claiming infra here would exempt
  // the failure from @stable auto-removal and hide a genuine add regression.
  assert.equal(classifyInfraError(swallowedAddMessage(DETAIL)), null);
});

// ---------------------------------------------------------------------------
// The sidebar search RESET (#1518) — a layer EARLIER than the swallowed click.
//
// The four @stable specs of #1518 never reached a click at all: they died waiting
// for the filtered entry, over budgets of 10 s / 20 s / 20 s / 30 s, on four
// different components. Measured on nightly 1.12.0.dev33 with an instrumented
// scout (fill -> poll -> capture -> re-fill), the cause is not a slow sidebar and
// not a catalog still streaming (#537): the FILL RACES THE FLOW PAGE MOUNT and
// loses, and the mount resets `sidebar-search-input` to "". The term is already
// gone the instant `fill()` returns — `readbackAfterFill=""` — nothing ever
// re-applies the filter, and the sidebar still holds ZERO entries after 12 s AND
// after 25 s of polling. So nothing arrives late and no caller timeout could have
// helped. An identical re-fill repairs it in ~320 ms (2 of 2).
//
// Rate: 4 of 22 runs (~18 %) in the helper's own shape — fill straight after the
// `blank-flow` click — against 0 of 25 with a `waitForURL` + input-visible gate
// before the fill. That direction is why the repair is a READBACK, not another
// gate: `loop-component-regression.spec.ts` already has the strictest of the four
// gates and still failed on daily run 32349515682, where a loaded mount outruns
// it. Corroborating: the three rows that failed once and passed on the next
// attempt of that run were repaired by the retry re-filling from scratch — the
// same repair, paid at the price of a whole test.
//
// The two failure messages are kept apart because they route the reader
// differently: a wiped term is this race, while a term that SURVIVED its whole
// budget with no entry is a component that is absent, renamed or reparented — and
// re-filling that three times would be a mute.

test("an entry that appeared settles the fill, whatever the input now reads", () => {
  // The entry is the observable that matters; if it rendered, a differing input
  // value is not a problem to report.
  assert.equal(
    classifySearchFill({ entryPresent: true, inputValue: "", term: "chat output" }),
    "entry-visible",
  );
});

test("an input that no longer holds the term is a reset, not a slow list", () => {
  assert.equal(
    classifySearchFill({ entryPresent: false, inputValue: "", term: "chat output" }),
    "term-lost",
  );
});

test("an input that is gone entirely counts as a reset", () => {
  // The mount can take the input with it; a re-fill re-waits for it, which is the
  // right move — and `null` must never read as "the term is held".
  assert.equal(
    classifySearchFill({ entryPresent: false, inputValue: null, term: "chat output" }),
    "term-lost",
  );
});

test("the term still held with no entry is NOT this race", () => {
  assert.equal(
    classifySearchFill({
      entryPresent: false,
      inputValue: "chat output",
      term: "chat output",
    }),
    "term-held-no-entry",
  );
});

const FILL_DETAIL = {
  searchTerm: "chat output",
  addButtonTestId: "add-component-button-chat-output",
  attempts: 3,
  perAttemptMs: SEARCH_ENTRY_TIMEOUT_MS,
  lastSearchValue: "",
  sidebarEntryCount: 0,
};

test("the reset message names the wipe, the term, the target and the attempts", () => {
  const msg = searchResetMessage(FILL_DETAIL);
  assert.match(msg, /sidebar search was reset/i);
  assert.match(msg, /"chat output"/);
  assert.match(msg, /add-component-button-chat-output/);
  assert.match(msg, /3 fill\(s\)/);
  assert.match(msg, /#1518/);
});

test("the reset message reports the value it read back, and an empty one is not a missing one", () => {
  assert.match(searchResetMessage(FILL_DETAIL), /read back: ""/);
  assert.match(
    searchResetMessage({ ...FILL_DETAIL, lastSearchValue: null }),
    /read back: <gone>/,
  );
});

test("the no-entry message says the term SURVIVED, so a renamed component is not re-filled blindly", () => {
  const msg = noMatchingEntryMessage({ ...FILL_DETAIL, lastSearchValue: "chat output" });
  assert.match(msg, /held "chat output"/);
  assert.match(msg, /no sidebar entry/i);
  // It must NOT send the reader after the reset race — that is the other message.
  assert.doesNotMatch(msg, /was reset/i);
  // The entry count is the evidence that separates "this term matches nothing"
  // from "the sidebar rendered nothing at all".
  assert.match(msg, /0 component entr/);
});

test("neither search-fill message is classifiable as an infra failure", () => {
  // #1262's rule: an infra-classified failure is exempt from @stable
  // auto-removal, so a real regression in the sidebar must not claim it.
  assert.equal(classifyInfraError(searchResetMessage(FILL_DETAIL)), null);
  assert.equal(classifyInfraError(noMatchingEntryMessage(FILL_DETAIL)), null);
});
