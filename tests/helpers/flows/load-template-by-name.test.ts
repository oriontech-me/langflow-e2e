// Unit tests for loadTemplateByName's concurrency hardening (issue #1002).
// Run with: npm run test:units
//
// Why this helper is unit-tested: 13 spec files load a template through it, and
// when it fails it fails IN SETUP — a random member of whichever template specs
// were running dies before any assertion, which is how it produced 66 entries of
// the 30s-timeout class in reports/daily-history.jsonl. The branches asserted
// here are exactly the ones that only appear under concurrency, so an E2E run
// cannot reach them on demand: the upstream 500 on a same-name creation
// (docs/upstream-bugs/UPSTREAM-BUG-concurrent-flow-create-500.md), the SPA losing
// the navigation after a successful creation, and the cleanup of flows the helper
// created but never handed to the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTemplateByName } from "./load-template-by-name";
import { fakePage } from "./load-template-by-name.fake";

const TEMPLATE = "Basic Prompting";

test("returns the created id on the happy path, without extra picks", async () => {
  const fake = fakePage({ attempts: [{ status: 201, id: "flow-happy" }] });

  const id = await loadTemplateByName(fake.page, TEMPLATE, {
    openModal: fake.openModal,
  });

  assert.equal(id, "flow-happy");
  assert.equal(fake.picks, 1);
  assert.deepEqual(fake.deleted, [], "nothing was created besides the template flow");
});

test("retries the pick when the creation POST answers 500, and returns the successful id", async () => {
  // The upstream name race: the loser of two concurrent same-name creations gets
  // a bare 500 and the SPA stays on the flows list. Pre-fix the helper awaited a
  // 201 only, so this answered nothing and the canvas gate timed out 30s later
  // with no reason attached.
  const fake = fakePage({
    attempts: [
      { status: 500 },
      { status: 201, id: "flow-second-try" },
    ],
  });

  const id = await loadTemplateByName(fake.page, TEMPLATE, {
    openModal: fake.openModal,
  });

  assert.equal(id, "flow-second-try");
  assert.equal(fake.picks, 2, "the failed pick was retried");
  assert.ok(
    fake.gotos.filter((u) => u === "/").length >= 2,
    "the retry restarts from the flows list, not from whatever the failed pick left behind",
  );
});

test("recovers a lost navigation by opening /flow/<id> directly", async () => {
  // The flow WAS created; only the SPA's routing was lost. Waiting longer can
  // never fix that, so the helper navigates to the editor itself.
  const fake = fakePage({
    attempts: [{ status: 201, id: "flow-no-nav", editorOpens: false }],
    recoveryWorks: true,
  });

  const id = await loadTemplateByName(fake.page, TEMPLATE, {
    openModal: fake.openModal,
  });

  assert.equal(id, "flow-no-nav");
  assert.ok(
    fake.gotos.includes("/flow/flow-no-nav"),
    "the recovery navigation happened",
  );
  assert.deepEqual(fake.deleted, [], "a recovered flow must NOT be deleted");
});

test("deletes the flow and names the real reason when the editor never opens", async () => {
  const fake = fakePage({
    attempts: [{ status: 201, id: "flow-doomed", editorOpens: false }],
    recoveryWorks: false,
  });

  await assert.rejects(
    () => loadTemplateByName(fake.page, TEMPLATE, { openModal: fake.openModal }),
    (error: Error) => {
      assert.match(error.message, /flow-doomed/, "the error names the flow");
      assert.match(
        error.message,
        /editor never opened/,
        "the error says what actually failed, not 'waiting for selector'",
      );
      assert.match(error.message, /201/, "the observed POST status is reported");
      return true;
    },
  );

  assert.deepEqual(
    fake.deleted,
    ["flow-doomed"],
    "a created-but-unusable flow is cleaned up instead of leaking (the id never reaches the caller's afterEach)",
  );
});

test("reports the creation status and body when every attempt fails, and creates nothing to leak", async () => {
  const fake = fakePage({
    attempts: [{ status: 500, detail: "An internal error occurred while creating the flow." }],
  });

  await assert.rejects(
    () => loadTemplateByName(fake.page, TEMPLATE, { openModal: fake.openModal }),
    (error: Error) => {
      assert.match(error.message, /never created after 3 attempts/);
      assert.match(error.message, /500/);
      assert.match(error.message, /internal error occurred while creating the flow/);
      return true;
    },
  );

  assert.equal(fake.picks, 3, "all three attempts were used");
  assert.deepEqual(fake.deleted, [], "no flow was created, so none is deleted");
});

test("deletes the flow the entry point creates on its own", async () => {
  // `openNewFlowTemplatesModal` clicks "New Flow", which since 1.10 navigates to
  // a freshly-created flow (the welcome-overlay path) before the modal opens.
  // That id is never the template flow and never reached the caller, so it leaked
  // on EVERY call — measured 14 leftover `New Flow (N)` from 16 runs.
  const fake = fakePage({
    attempts: [{ status: 201, id: "flow-template" }],
    entryPointIds: ["flow-entry-point"],
  });

  const id = await loadTemplateByName(fake.page, TEMPLATE, {
    openModal: fake.openModal,
  });

  assert.equal(id, "flow-template");
  assert.deepEqual(fake.deleted, ["flow-entry-point"]);
});

test("still returns when a recorded response body is never delivered", async () => {
  // The regression this fix originally shipped with. The entry point's creation
  // response is discarded the moment the SPA navigates away, so `resp.json()`
  // pends forever — and awaiting those reads before cleanup (which is required to
  // know the id) hung the helper past the 5-minute test timeout. Measured: the
  // serial control, green for months, timed out at 300s. The read is now capped.
  const fake = fakePage({
    attempts: [{ status: 201, id: "flow-template" }],
    entryPointIds: ["flow-entry-point"],
    entryPointBodyNeverDelivered: true,
  });

  const started = Date.now();
  const id = await loadTemplateByName(fake.page, TEMPLATE, {
    openModal: fake.openModal,
  });
  const elapsed = Date.now() - started;

  assert.equal(id, "flow-template");
  assert.ok(
    elapsed < 30000,
    `the undelivered body must not block the helper (took ${elapsed}ms)`,
  );
  assert.deepEqual(
    fake.deleted,
    [],
    "an id that never arrived cannot be deleted — the helper proceeds instead of hanging",
  );
});

test("cleans up the abandoned flow of a retry that created one before failing", async () => {
  // First attempt creates a flow whose editor never opens; the recovery fails, so
  // that flow is abandoned. Nothing may be left behind.
  const fake = fakePage({
    attempts: [{ status: 201, id: "flow-abandoned", editorOpens: false }],
    recoveryWorks: false,
    entryPointIds: ["flow-entry-point"],
  });

  await assert.rejects(() =>
    loadTemplateByName(fake.page, TEMPLATE, { openModal: fake.openModal }),
  );

  assert.deepEqual(
    [...fake.deleted].sort(),
    ["flow-abandoned", "flow-entry-point"],
    "both the entry-point flow and the abandoned template flow are deleted",
  );
});
