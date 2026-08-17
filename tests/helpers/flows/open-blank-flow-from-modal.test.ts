// Unit tests for the blank-flow modal barrier (issue #1468, second failure mode).
// Run with: npm run test:units
//
// What rides on this message: a refused flow creation leaves the templates modal
// open OVER the editor, and every spec that types next reports the covered
// sidebar instead of the refusal. Measured on nightly 1.12.0.dev30 under
// four-way contention — `400 POST /api/v1/flows/` in every reproduction of this
// mode, `role="dialog"` present in all of them and absent in all 16 measured
// successes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import {
  MODAL_DISMISSED_TIMEOUT_MS,
  refusedBlankFlowMessage,
} from "./open-blank-flow-from-modal";

const DETAIL = {
  attempts: 2,
  perAttemptMs: MODAL_DISMISSED_TIMEOUT_MS,
  dialogCount: 1,
};

test("the message names the modal, the click and the 400 to look for", () => {
  const msg = refusedBlankFlowMessage(DETAIL);
  assert.match(msg, /templates modal did not close/);
  assert.match(msg, /blank-flow/);
  assert.match(msg, /400 POST \/api\/v1\/flows\//);
  assert.match(msg, /flow must be unique/);
  assert.match(msg, /#1468/);
});

test("the message says a longer wait cannot help — the modal is not slow", () => {
  // The whole point of retrying the click instead of raising a timeout.
  assert.match(refusedBlankFlowMessage(DETAIL), /NOT a slow modal/);
});

test("the message reports the dialog count it observed", () => {
  assert.match(refusedBlankFlowMessage({ ...DETAIL, dialogCount: 2 }), /present: 2/);
});

test("not classified as infra — a modal that will not close is a product defect", () => {
  assert.equal(classifyInfraError(refusedBlankFlowMessage(DETAIL)), null);
});
