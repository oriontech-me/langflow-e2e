// Unit tests for the missing-entry-point attribution (issue #1335).
// Run with: npm run test:units
//
// What rides on this function: whether the failure names the cause or repeats the
// mis-attribution that cost two dailies. The 3 s `click()` it replaced produced a
// call log of exactly one line — `waiting for getByTestId('mcp-server-dropdown')`
// — which reads as "the dropdown is late" and led the issue to propose raising
// the budget to 15–30 s. The failing attempt's own error-context snapshot showed
// an empty `application "Flow canvas"` with "Minimize all" disabled: there was no
// MCP component node, so neither entry point could ever render and no budget
// would have helped. Measured on nightly 1.12.0.dev17: 4 of 8 sidebar adds on the
// MCP tab were swallowed, all 4 repaired by an identical second click, while a
// landed add's entry point appeared 6–15 ms later, enabled, in 8 of 8.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  MCP_SERVER_ENTRY_TIMEOUT_MS,
  NODE_LIST_DIALOG_ATTEMPTS,
  NODE_LIST_DIALOG_ATTEMPT_MS,
  SIDEBAR_MODAL_ATTEMPTS,
  SIDEBAR_MODAL_ATTEMPT_MS,
  missingMcpServerEntryMessage,
  nodeListDialogNeverOpenedMessage,
  sidebarModalNeverOpenedMessage,
} from "./open-add-mcp-server-modal";

test("an empty canvas is reported as a swallowed add, not as a slow widget", () => {
  const msg = missingMcpServerEntryMessage({
    waitedMs: MCP_SERVER_ENTRY_TIMEOUT_MS,
    canvasNodes: 0,
  });

  assert.match(msg, /NO node on the canvas/);
  assert.match(msg, /swallowed/i);
  // The reader must be pointed at the repair, since waiting is the wrong answer.
  assert.match(msg, /add-component-from-sidebar/);
  assert.match(msg, /no wait fixes it/i);
});

test("a populated canvas is reported as a widget change, not as a swallowed add", () => {
  // The other side of the split: with the node present, the entry point really is
  // missing from the component's server field — a Langflow change, and telling the
  // reader to repair the add would send them at the wrong layer.
  const msg = missingMcpServerEntryMessage({
    waitedMs: MCP_SERVER_ENTRY_TIMEOUT_MS,
    canvasNodes: 2,
  });

  assert.match(msg, /2 node\(s\) are on the canvas/);
  assert.match(msg, /Langflow change/);
  assert.doesNotMatch(msg, /swallowed/i);
});

test("the message names both entry points and the budget actually waited", () => {
  // Naming both is what tells a reader the wait covered the empty-list branch too
  // — the previous failure named only the dropdown, which does not exist when no
  // server is registered.
  const msg = missingMcpServerEntryMessage({ waitedMs: 15000, canvasNodes: 0 });

  assert.match(msg, /add-mcp-server-simple-button/);
  assert.match(msg, /mcp-server-dropdown/);
  assert.match(msg, /15000ms/);
  assert.match(msg, /openAddMcpServerModal/);
});

test("neither verdict is classifiable as an infra failure", () => {
  // Same rule as the sidebar-add message (#1262): claiming infra would exempt the
  // failure from @stable auto-removal and hide a genuine MCP regression.
  for (const canvasNodes of [0, 3]) {
    assert.equal(
      classifyInfraError(
        missingMcpServerEntryMessage({ waitedMs: 15000, canvasNodes }),
      ),
      null,
    );
  }
});

// ---- sidebar entry point (#1422) ----

test("a sidebar modal that never opens is reported as a dropped click, not a slow modal", () => {
  // The assertion this replaced said `element(s) not found` for
  // `add-mcp-server-button` after 15 s — indistinguishable from a late modal,
  // which is what sent the reader at the budget. The repo has measured the real
  // class four times over (#1304: 14 of 14 dropped adds repaired by an
  // identical second click), so the message has to name the retries as spent.
  const msg = sidebarModalNeverOpenedMessage({
    trigger: "sidebar-add-mcp-server-button",
    attempts: SIDEBAR_MODAL_ATTEMPTS,
    perAttemptMs: SIDEBAR_MODAL_ATTEMPT_MS,
  });

  assert.match(msg, /sidebar-add-mcp-server-button/);
  assert.match(msg, /dropped sidebar click/i);
  assert.match(msg, /not as a slow modal/i);
  assert.match(msg, new RegExp(`${SIDEBAR_MODAL_ATTEMPTS} click\\(s\\)`));
});

test("the message names WHICH of the two triggers was clicked", () => {
  // The two variants render on mutually exclusive states (no server registered
  // vs one or more), so a failure that does not say which one it used leaves
  // the reader unable to reproduce the state that produced it.
  const msg = sidebarModalNeverOpenedMessage({
    trigger: "add-mcp-server-button-sidebar",
    attempts: 3,
    perAttemptMs: 8000,
  });

  assert.match(msg, /add-mcp-server-button-sidebar/);
  assert.doesNotMatch(msg, /sidebar-add-mcp-server-button"/);
});

// ---- node entry point: the server-list dialog (#1447) ----

test("a node list dialog that never opens is reported as a dropped dropdown click", () => {
  // Before #1447 this state produced no failure at all: the helper's page-wide
  // `getByText("Add MCP Server").last()` resolved to the SIDEBAR's button — the
  // only match until the dialog renders (measured on 1.13.0.dev30) — and opened
  // the sidebar's modal, which never binds the node. Failing here, naming the
  // dropdown, is what replaces that silent detour.
  const msg = nodeListDialogNeverOpenedMessage({
    attempts: NODE_LIST_DIALOG_ATTEMPTS,
    perAttemptMs: NODE_LIST_DIALOG_ATTEMPT_MS,
  });

  assert.match(msg, /mcp-server-dropdown/);
  assert.match(msg, new RegExp(`${NODE_LIST_DIALOG_ATTEMPTS} click\\(s\\)`));
  assert.match(msg, new RegExp(`${NODE_LIST_DIALOG_ATTEMPT_MS}ms each`));
  assert.match(msg, /dropped/i);
});

test("the message says why the sidebar button is not an acceptable fallback", () => {
  // The next reader's first instinct is "just click whichever Add MCP Server is
  // visible". The message has to carry the reason that is wrong: the sidebar's
  // modal registers the server but never binds the node, so the test would go on
  // asserting against the previously selected server with no error (#1447).
  const msg = nodeListDialogNeverOpenedMessage({ attempts: 3, perAttemptMs: 5000 });

  assert.match(msg, /sidebar-add-mcp-server-button/);
  assert.match(msg, /never binds the node/i);
  assert.match(msg, /#1447/);
});

test("a dropped dropdown click is not classifiable as an infra failure", () => {
  // Same rule as the other two messages (#1262): an infra verdict would exempt
  // the failure from @stable auto-removal and hide a genuine MCP regression.
  assert.equal(
    classifyInfraError(
      nodeListDialogNeverOpenedMessage({ attempts: 3, perAttemptMs: 5000 }),
    ),
    null,
  );
});
