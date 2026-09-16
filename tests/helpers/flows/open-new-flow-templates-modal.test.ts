// Unit tests for openNewFlowTemplatesModal's recovery from a blank editor (#1865).
// Run with: npm run test:units
//
// Why this helper is unit-tested: every template-loading spec opens the modal
// through it (144 spec files reach it by import), and when it fails it fails IN
// SETUP, on whichever spec lost the race. The branch asserted here only appears
// when the new flow's types request answers 404 because the creation had not
// committed yet (LE-2598) — CI loses that race under shard load, a local instance
// does not, so an E2E run cannot reach it on demand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openNewFlowTemplatesModal } from "./open-new-flow-templates-modal";
import {
  fakeNewFlowPage,
  type EntryScript,
} from "./open-new-flow-templates-modal.fake";

const TYPES = "/api/v1/all?force_refresh=true&flow_id={id}";

/** The editor loads: its types answer 200, then the welcome overlay renders. */
const OPENS: EntryScript = {
  responses: [{ at: 1000, path: TYPES, status: 200 }],
  welcomeAt: 1500,
};

/** #1865: the types request 404s (flow not committed yet) and nothing ever renders. */
const TYPES_404: EntryScript = {
  responses: [{ at: 1000, path: TYPES, status: 404 }],
};

/** Runs the helper with console.warn captured; never throws. */
async function run(fake: ReturnType<typeof fakeNewFlowPage>) {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    await openNewFlowTemplatesModal(fake.page, { now: fake.now });
    return { warnings, error: undefined };
  } catch (error) {
    return { warnings, error: error as Error };
  } finally {
    console.warn = realWarn;
  }
}

test("opens the modal through the welcome overlay with one click, deleting and navigating nothing", async () => {
  const fake = fakeNewFlowPage([OPENS]);

  const { warnings, error } = await run(fake);

  assert.equal(error, undefined);
  assert.equal(fake.modalOpen, true);
  assert.equal(fake.entries, 1);
  assert.deepEqual(fake.deleted, []);
  assert.deepEqual(fake.gotos, []);
  assert.deepEqual(warnings, []);
  assert.equal(fake.responseListeners, 0, "no response listener is left on the page");
});

test("re-enters New Flow once when the new flow's types request 404s, deleting that blank placeholder", async () => {
  // The daily failure of #1865: the frontend never retries the 404, so waiting
  // longer cannot help — pre-fix this burnt the 8 s probe plus the 30 s wait and
  // threw a bare `expect(received).toBe(expected)`.
  const fake = fakeNewFlowPage([TYPES_404, OPENS]);

  const { warnings, error } = await run(fake);

  assert.equal(error, undefined, `the re-entry reached the modal (${error?.message})`);
  assert.equal(fake.modalOpen, true);
  assert.equal(fake.entries, 2, "exactly one re-entry");
  assert.deepEqual(
    fake.deleted,
    ["flow-1"],
    "the placeholder the 404 named is deleted — it never reaches any caller, so only this helper can",
  );
  assert.deepEqual(fake.gotos, ["/"], "the re-entry starts from the home page");
  assert.equal(warnings.length, 1, "the recovery is announced, once");
  assert.match(warnings[0], /\/api\/v1\/all/);
  assert.match(warnings[0], /flow-1/);
  assert.match(warnings[0], /404/);
  assert.match(warnings[0], /LE-2598/);
  assert.match(warnings[0], /#1865/);
  assert.equal(fake.responseListeners, 0, "no response listener is left on the page");
});

test("re-enters when the 404 lands only after the 8 s probe — a slow runner", async () => {
  const fake = fakeNewFlowPage([
    { responses: [{ at: 9000, path: TYPES, status: 404 }] },
    OPENS,
  ]);

  const { error } = await run(fake);

  assert.equal(error, undefined, `the re-entry reached the modal (${error?.message})`);
  assert.equal(fake.modalOpen, true);
  assert.deepEqual(fake.deleted, ["flow-1"]);
  assert.equal(fake.entries, 2);
});

test("does not re-enter twice: a second 404 fails naming both placeholders, and deletes both", async () => {
  const fake = fakeNewFlowPage([TYPES_404, TYPES_404]);

  const { error } = await run(fake);

  assert.ok(error, "a repeated 404 fails the setup instead of looping");
  assert.match(error.message, /flow-1/);
  assert.match(error.message, /flow-2/);
  assert.match(error.message, /404/);
  assert.match(error.message, /#1865/);
  assert.equal(fake.entries, 2, "one re-entry, never a second");
  assert.deepEqual(fake.gotos, ["/"], "home is visited once: no second re-entry");
  assert.deepEqual(fake.deleted, ["flow-1", "flow-2"], "no blank placeholder is left behind");
  assert.equal(fake.responseListeners, 0, "no response listener is left on the page");
});

test("fails naming the page and an unknown cause, within the old budget, when the editor is blank and no 404 was seen", async () => {
  // Nothing says the flow is gone, so nothing is deleted and nothing is retried:
  // re-entering on an unexplained blank editor would only hide it.
  const fake = fakeNewFlowPage([{}]);

  const { error } = await run(fake);

  assert.ok(error);
  assert.match(error.message, /flow-1/, "the error names the page the app stayed on");
  assert.match(error.message, /cause is unknown/);
  assert.doesNotMatch(error.message, /expect\(received\)/, "not a bare poll timeout");
  assert.equal(fake.entries, 1);
  assert.deepEqual(fake.deleted, []);
  assert.deepEqual(fake.gotos, []);
  assert.ok(
    fake.now() <= 38200,
    `gave up within the 8 s probe + 30 s wait the path always had (took ${fake.now()} ms)`,
  );
  assert.equal(fake.responseListeners, 0, "no response listener is left on the page");
});

test("never deletes a flow the page is not stuck on: a 404 for another flow or another route is not the signature", async () => {
  // A spec's own flow can still have a types request in flight when it goes home
  // and opens the modal; if that one 404s, deleting "the flow the 404 named"
  // would delete the spec's flow.
  const fake = fakeNewFlowPage([
    {
      responses: [
        { at: 800, path: "/api/v1/all?force_refresh=true&flow_id=flow-of-another-page", status: 404 },
        { at: 900, path: "/api/v1/flows/{id}", status: 404 },
      ],
    },
  ]);

  const { error } = await run(fake);

  assert.ok(error);
  assert.match(error.message, /cause is unknown/);
  assert.deepEqual(fake.deleted, []);
  assert.deepEqual(fake.gotos, []);
  assert.equal(fake.entries, 1);
});

test("does not tear down an editor whose types request answered again after the 404", async () => {
  // Only the latest answer decides: an editor that got its types after all is
  // loading, not stuck, however slowly it then renders.
  const fake = fakeNewFlowPage([
    {
      responses: [
        { at: 1000, path: TYPES, status: 404 },
        { at: 2000, path: TYPES, status: 200 },
      ],
      welcomeAt: 12000,
    },
  ]);

  const { error } = await run(fake);

  assert.equal(error, undefined, `the slow editor opened (${error?.message})`);
  assert.equal(fake.modalOpen, true);
  assert.deepEqual(fake.deleted, []);
  assert.equal(fake.entries, 1);
});
