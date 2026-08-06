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
  missingMcpServerEntryMessage,
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
