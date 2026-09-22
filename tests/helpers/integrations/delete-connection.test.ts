// Unit tests for deleteConnection and retryAfterMs (#1966).
// Run with: npm run test:units
//
// The load-bearing property is what a teardown does with a 429. Connection
// writes share ONE per-user bucket of 30/minute (measured on 1.13.0.dev19), the
// suite shares one superuser, and a DELETE that answers 404 is counted too — so
// a batch neighbour can exhaust the bucket and the next cleanup is refused.
// Treating that 429 as "done" leaks a connection per refused teardown; treating
// it as a hard failure fails a green test for a scheduling accident. The helper
// waits the advertised window out ONCE and then refuses to loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  MAX_RETRY_AFTER_MS,
  RETRY_AFTER_MARGIN_MS,
  deleteConnection,
  retryAfterMs,
} from "./delete-connection";

interface Call {
  method: string;
  url: string;
  headers?: Record<string, string>;
}

/**
 * A fake APIRequestContext whose DELETE answers the given statuses in order —
 * the last one repeats — recording every call.
 */
function fakeRequest(statuses: number[], headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  let i = 0;
  const request = {
    delete: async (url: string, o: { headers?: Record<string, string> } = {}) => {
      calls.push({ method: "DELETE", url, headers: o.headers });
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return {
        ok: () => status >= 200 && status < 300,
        status: () => status,
        headers: () => (status === 429 ? headers : {}),
        text: async () => (status === 204 ? "" : JSON.stringify({ detail: `status ${status}` })),
      };
    },
  } as unknown as APIRequestContext;
  return { request, calls };
}

/** Records the waits the helper asks for, without waiting. */
function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test("retryAfterMs reads the seconds Langflow advertises and adds the margin", () => {
  assert.equal(retryAfterMs({ "retry-after": "60" }), 60_000 + RETRY_AFTER_MARGIN_MS);
  assert.equal(retryAfterMs({ "retry-after": "7" }), 7_000 + RETRY_AFTER_MARGIN_MS);
});

test("retryAfterMs never waits longer than the one-minute bucket", () => {
  assert.equal(retryAfterMs({ "retry-after": "3600" }), MAX_RETRY_AFTER_MS);
});

test("retryAfterMs falls back to the whole window when the header is missing or unreadable", () => {
  // A missing or garbled header is not "retry now": the bucket is per minute, so
  // the only wait that is guaranteed to clear it is the whole window.
  assert.equal(retryAfterMs({}), MAX_RETRY_AFTER_MS);
  assert.equal(retryAfterMs({ "retry-after": "soon" }), MAX_RETRY_AFTER_MS);
  assert.equal(retryAfterMs({ "retry-after": "-5" }), MAX_RETRY_AFTER_MS);
  // The HTTP-date form is legal HTTP, but Langflow never sends it — the full
  // window is the safe reading.
  assert.equal(retryAfterMs({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), MAX_RETRY_AFTER_MS);
});

test("retryAfterMs treats a zero as one second, not as an immediate retry", () => {
  assert.equal(retryAfterMs({ "retry-after": "0" }), 1_000 + RETRY_AFTER_MARGIN_MS);
});

test("deleteConnection resolves on 204 after one DELETE of the id, with the caller's headers", async () => {
  const { request, calls } = fakeRequest([204]);
  const { waits, sleep } = recordingSleep();
  await deleteConnection(request, "abc", { headers: { Authorization: "Bearer t" }, sleep });
  assert.deepEqual(calls, [
    { method: "DELETE", url: "/api/v1/connections/abc", headers: { Authorization: "Bearer t" } },
  ]);
  assert.deepEqual(waits, []);
});

test("deleteConnection treats 404 as the desired end state", async () => {
  // A test that deleted its own connection (or a UI that did) leaves the
  // teardown nothing to do — that is success, not an error.
  const { request, calls } = fakeRequest([404]);
  const { sleep } = recordingSleep();
  await deleteConnection(request, "gone", { sleep });
  assert.equal(calls.length, 1);
});

test("deleteConnection waits the advertised window out once on 429, then retries", async () => {
  const { request, calls } = fakeRequest([429, 204], { "retry-after": "60" });
  const { waits, sleep } = recordingSleep();
  await deleteConnection(request, "abc", { sleep });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [60_000 + RETRY_AFTER_MARGIN_MS]);
});

test("deleteConnection refuses to loop on a second 429 and names the status", async () => {
  const { request, calls } = fakeRequest([429, 429], { "retry-after": "60" });
  const { waits, sleep } = recordingSleep();
  await assert.rejects(deleteConnection(request, "abc", { sleep }), /429/);
  assert.equal(calls.length, 2);
  assert.equal(waits.length, 1);
});

test("deleteConnection absorbs one transient 5xx", async () => {
  const { request, calls } = fakeRequest([500, 204]);
  const { waits, sleep } = recordingSleep();
  await deleteConnection(request, "abc", { sleep });
  assert.equal(calls.length, 2);
  assert.equal(waits.length, 1);
});

test("deleteConnection throws after a second 5xx, with the status and the body", async () => {
  const { request } = fakeRequest([500, 503]);
  const { sleep } = recordingSleep();
  await assert.rejects(deleteConnection(request, "abc", { sleep }), /503.*status 503/);
});

test("deleteConnection throws at once on a deterministic client error", async () => {
  // 403/422 will not change on retry — waiting on them would only hide the cause.
  for (const status of [401, 403, 422]) {
    const { request, calls } = fakeRequest([status]);
    const { waits, sleep } = recordingSleep();
    await assert.rejects(deleteConnection(request, "abc", { sleep }), new RegExp(String(status)));
    assert.equal(calls.length, 1, `${status} must not be retried`);
    assert.deepEqual(waits, [], `${status} must not wait`);
  }
});
