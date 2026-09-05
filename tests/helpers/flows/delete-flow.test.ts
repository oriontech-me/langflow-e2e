// Unit tests for deleteFlow's attribution hook (§1.1, §2.2, §2.3).
// Run with: npm run test:units
//
// deleteFlow is the lever: 157 specs call it, directly or through
// setupPlayground / setupBlankFlow / loadTemplateByName /
// createRunnableChatFlowViaApi. Hooking it is what takes attribution from 2
// specs to 148 without a spec edit.
//
// Its own contract is unusual and must survive intact: deleteFlow THROWS on a
// failed deletion on purpose (#545 -- an unchecked cleanup call lets a failed
// delete pass silently and the suite quietly re-accumulates leftover flows). The
// hook may not add a throw path, and may not remove the existing one.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { deleteFlow } from "./delete-flow";
import { resetAttributedFlows } from "./token-attribution";
import { makeTempDir } from "../../../scripts/lib/tmp-dir";

// One mechanism, not two (round-1 review): a per-test reset line is a line
// someone forgets when adding test number ten, and four of the tests below
// assert an ABSENCE (no gets, no file, no warnings) that would pass vacuously
// -- silently, forever -- if "f1" were already in the attempted set from a
// prior test. `token-attribution.test.ts` made this same fix one commit
// before this file existed; this converts to the identical single-`beforeEach`
// shape rather than repeating the per-test line ten times.
beforeEach(() => {
  resetAttributedFlows();
});

function tmpFile(): string {
  return path.join(makeTempDir("delflow-"), "token-attrib.jsonl");
}

/** A request whose DELETE succeeds and whose monitor GETs return one trace. */
function fakeRequest(opts: { deleteStatus?: number; traces?: unknown[] } = {}) {
  const gets: string[] = [];
  const deletes: string[] = [];
  const status = opts.deleteStatus ?? 204;
  const request = {
    get: async (url: string) => {
      gets.push(url);
      if (url.includes("?flow_id=")) {
        return { ok: () => true, status: () => 200, json: async () => ({ traces: opts.traces ?? [{ id: "t1", totalTokens: 88 }] }) };
      }
      return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
    },
    delete: async (url: string) => {
      deletes.push(url);
      return { ok: () => status < 400, status: () => status, text: async () => "boom" };
    },
  } as unknown as APIRequestContext;
  return { request, gets, deletes };
}

const INFO = () => ({
  title: "a test that spent tokens",
  file: "/repo/tests/tests-automations/regression/x.spec.ts",
  project: { testDir: "/repo/tests" },
});

test("attributes the flow before deleting it, deriving test and file (§1.1)", async () => {
  const out = tmpFile();
  process.env.TOKENS_ATTRIB = out;
  try {
    const { request, deletes } = fakeRequest();
    await deleteFlow(request, "f1", undefined, { info: INFO });
    assert.deepEqual(deletes, ["/api/v1/flows/f1"], "the delete still happens");
    // The artifact carries the sidecar's own cost record too (§4.3, one per call,
    // `kind: "attrib_cost"`), so pick the TRACE line rather than parsing the file
    // as a single object.
    const records = fs
      .readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // Exactly ONE trace line and exactly one cost record. The count matters: this
    // assertion used to be a whole-file `JSON.parse`, which implicitly proved the
    // artifact held a single line — dropping it would let the sidecar duplicate every
    // trace line with all of this file's tests still green (fix round 3, item 3).
    assert.equal(records.length, 2, JSON.stringify(records));
    const traceLines = records.filter((r) => r.kind !== "attrib_cost");
    assert.equal(traceLines.length, 1, "one trace, one line");
    assert.equal(records.filter((r) => r.kind === "attrib_cost").length, 1, "one call, one cost record");
    const line = traceLines[0];
    assert.equal(line.test, "a test that spent tokens");
    assert.equal(line.file, "tests-automations/regression/x.spec.ts");
    assert.equal(line.flow_id, "f1");
    assert.equal(line.total_tokens, 88);
  } finally {
    delete process.env.TOKENS_ATTRIB;
  }
});

test("reads the traces BEFORE issuing the delete — every read must fully resolve, not just start, before the delete fires", async () => {
  const out = tmpFile();
  process.env.TOKENS_ATTRIB = out;
  try {
    const order: string[] = [];
    const request = {
      get: async (url: string) => {
        order.push("get:start");
        // A microtask tick between start and resolution, standing in for
        // network latency. Round-1 review: the previous version of this test
        // pushed a "get" marker SYNCHRONOUSLY on call, so a fire-and-forget
        // refactor (issuing the reads without awaiting them before the
        // delete -- a plausible "make teardown faster" change, and Task 6 of
        // this plan is explicitly about speed) would still record "get"
        // before "delete" and this test would stay green while the reads
        // raced the DELETE. Asserting against the RESOLUTION marker instead
        // of the call marker is what makes that race visible.
        await Promise.resolve();
        order.push("get:resolved");
        if (url.includes("?flow_id=")) {
          return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1", totalTokens: 5 }] }) };
        }
        return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
      },
      delete: async () => {
        order.push("delete");
        return { ok: () => true, status: () => 204, text: async () => "" };
      },
    } as unknown as APIRequestContext;
    await deleteFlow(request, "f1", undefined, { info: INFO });
    assert.ok(order.includes("get:resolved"), "at least one read must have completed");
    assert.ok(
      order.lastIndexOf("get:resolved") < order.indexOf("delete"),
      `every read must fully RESOLVE before the delete fires, not just start; got ${JSON.stringify(order)}`,
    );
  } finally {
    delete process.env.TOKENS_ATTRIB;
  }
});

test("makes no request and touches no file when TOKENS_ATTRIB is unset (Global Constraints)", async () => {
  delete process.env.TOKENS_ATTRIB;
  const { request, gets, deletes } = fakeRequest();
  await deleteFlow(request, "f1", undefined, { info: INFO });
  // Every LOCAL run pays nothing, unconditionally — nothing outside CI sets
  // TOKENS_ATTRIB. Not the PR lane, though: pr-validation.yml:711 sets it on
  // purpose, since the PR lane is the one place a cost regression is catchable
  // before merge. This assertion is about the variable, not about any lane.
  assert.deepEqual(gets, [], "with TOKENS_ATTRIB unset, every local run must pay nothing");
  assert.deepEqual(deletes, ["/api/v1/flows/f1"]);
});

test("deletes normally with no running test, and does not pretend it attributed (§2.3)", async () => {
  const out = tmpFile();
  process.env.TOKENS_ATTRIB = out;
  try {
    const { request, deletes } = fakeRequest();
    await deleteFlow(request, "f1", undefined, {
      info: () => {
        throw new Error("test.info() can only be called while test is running");
      },
    });
    assert.deepEqual(deletes, ["/api/v1/flows/f1"], "the delete is unaffected");
    assert.equal(fs.existsSync(out), false, "no attribution line without a test to name");
  } finally {
    delete process.env.TOKENS_ATTRIB;
  }
});

// Global Constraints: degrading must never look like "nothing to attribute".
// deleteFlow returns void, so the sidecar's `skipped` list has nowhere to go --
// discarding it would make a wedged monitor endpoint indistinguishable from "no
// traces yet" (#1197 review, finding I8). Warning is what cleanup() already does
// with the same list.
test("names an attribution failure on the console rather than swallowing it (§2.3)", async () => {
  process.env.TOKENS_ATTRIB = tmpFile();
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    const request = {
      get: async () => ({ ok: () => false, status: () => 403, json: async () => ({ detail: "Not authenticated" }) }),
      delete: async () => ({ ok: () => true, status: () => 204, text: async () => "" }),
    } as unknown as APIRequestContext;
    await deleteFlow(request, "f1", undefined, { info: INFO });
    assert.ok(
      warnings.some((w) => w.includes("403")),
      `a 403 on the monitor endpoint must be named; got ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = realWarn;
    delete process.env.TOKENS_ATTRIB;
  }
});

// Round-1 review, item 5: deleteFlow's own `isDone()` treats a 404 on the
// DELETE as the desired end state (a concurrent worker's sweep, or an
// already-idempotent cleanup), not a failure. A 404 from the MONITOR endpoint
// racing that same deletion is the identical, expected shape -- so it must not
// print a warning on the teardown path of every idempotent/raced delete in the
// suite. It still counts toward the sidecar's own `skipped` result (that part
// is `recordTokenAttribution`'s own contract, covered in
// token-attribution.test.ts); this test is only about deleteFlow's console.
//
// Caveat, stated rather than assumed: this does NOT assert what Langflow's real
// `/api/v1/monitor/traces` endpoint returns for an unknown/already-deleted
// `flow_id` -- that was not verified against a live backend. It asserts
// deleteFlow's own handling GIVEN a 404, whatever produces one.
test("does not warn about a 404 from the monitor endpoint (§2.3)", async () => {
  process.env.TOKENS_ATTRIB = tmpFile();
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    const request = {
      get: async () => ({ ok: () => false, status: () => 404, json: async () => ({ detail: "Not found" }) }),
      delete: async () => ({ ok: () => true, status: () => 204, text: async () => "" }),
    } as unknown as APIRequestContext;
    await deleteFlow(request, "f1", undefined, { info: INFO });
    assert.deepEqual(
      warnings,
      [],
      "a 404 on the monitor endpoint is the same expected shape as a 404 on the DELETE itself, and must not warn",
    );
  } finally {
    console.warn = realWarn;
    delete process.env.TOKENS_ATTRIB;
  }
});

// The inverse: no running test is an EXPECTED state, not a failure. deleteFlow is
// reachable from module scope and from setup helpers, so warning there would fire
// across the whole suite for no reason.
test("stays silent when there is simply no test to name (§2.3)", async () => {
  process.env.TOKENS_ATTRIB = tmpFile();
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    const { request } = fakeRequest();
    await deleteFlow(request, "f1", undefined, {
      info: () => {
        throw new Error("test.info() can only be called while test is running");
      },
    });
    assert.deepEqual(warnings, [], "no running test is not a failure worth a line");
  } finally {
    console.warn = realWarn;
    delete process.env.TOKENS_ATTRIB;
  }
});

test("an attribution failure never changes whether deleteFlow throws (§2.3)", async () => {
  process.env.TOKENS_ATTRIB = tmpFile();
  // Round-1 review, item 4: the wedged-backend scenario below drives the
  // skipped-warning branch, which used to print
  // "⚠️  token attribution skipped 1 flow(s): f1: backend wedged" straight
  // into a green test run. Stub it like the other warn-asserting tests, and
  // restore it in `finally` -- a leaked stub here would corrupt every test
  // that runs after this one in the file and the failure would look like
  // something else entirely.
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    // The monitor endpoint is wedged; the delete succeeds.
    const request = {
      get: async () => {
        throw new Error("backend wedged");
      },
      delete: async () => ({ ok: () => true, status: () => 204, text: async () => "" }),
    } as unknown as APIRequestContext;
    await deleteFlow(request, "f1", undefined, { info: INFO });

    // And the inverse: attribution succeeds, the delete fails, and the delete's
    // own error still surfaces unchanged. That throw is the whole point of this
    // helper (#545). No extra reset needed here: "f2" is a different id from
    // "f1" above, so the attempted-flow guard has nothing to do with this
    // assertion.
    const failing = fakeRequest({ deleteStatus: 422 });
    await assert.rejects(
      () => deleteFlow(failing.request, "f2", undefined, { info: INFO }),
      /Flow cleanup failed: 422/,
    );
  } finally {
    console.warn = realWarn;
    delete process.env.TOKENS_ATTRIB;
  }
});

test("attribute: false suppresses the hook entirely — the cleanAllFlows case (§2.2)", async () => {
  const out = tmpFile();
  process.env.TOKENS_ATTRIB = out;
  try {
    const { request, gets, deletes } = fakeRequest();
    await deleteFlow(request, "f1", undefined, { attribute: false, info: INFO });
    assert.deepEqual(gets, [], "a global sweep must not read traces it would misname");
    assert.deepEqual(deletes, ["/api/v1/flows/f1"]);
    assert.equal(fs.existsSync(out), false);
  } finally {
    delete process.env.TOKENS_ATTRIB;
  }
});

test("passes the caller's Authorization header through to the sidecar", async () => {
  const out = tmpFile();
  process.env.TOKENS_ATTRIB = out;
  try {
    const seen: Array<Record<string, string> | undefined> = [];
    const request = {
      get: async (url: string, opts?: { headers?: Record<string, string> }) => {
        seen.push(opts?.headers);
        if (url.includes("?flow_id=")) {
          return { ok: () => true, status: () => 200, json: async () => ({ traces: [{ id: "t1", totalTokens: 5 }] }) };
        }
        return { ok: () => true, status: () => 200, json: async () => ({ spans: [] }) };
      },
      delete: async () => ({ ok: () => true, status: () => 204, text: async () => "" }),
    } as unknown as APIRequestContext;
    await deleteFlow(request, "f1", { headers: { Authorization: "Bearer xyz" } }, { info: INFO });
    // A 403 on the monitor endpoint reads exactly like "no traces yet" (#1197
    // review, finding I8), so the bearer the caller already holds must reach it.
    assert.deepEqual(seen[0], { Authorization: "Bearer xyz" });
  } finally {
    delete process.env.TOKENS_ATTRIB;
  }
});
