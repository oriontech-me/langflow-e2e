import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { getAuthToken, DEFAULT_RETRY_DELAYS_MS } from "./get-auth-token";

/**
 * The helper is called by 135 specs, and the daily's shared backend goes
 * unresponsive mid-run (#1074/#1077) on a ~1-minute scale — long enough that
 * every one of Playwright's test-level attempts died on `auto_login` for one
 * target of daily #1057. These tests pin the contract that keeps that from
 * killing an unrelated spec: a thrown request is retried across a bounded
 * budget, a non-ok answer is not retried at all, and a budget that runs out
 * surfaces the ORIGINAL error — never an empty token that would send the
 * caller on unauthenticated (#1086).
 */

interface FakeResponse {
  ok: () => boolean;
  json: () => Promise<unknown>;
}

// Each entry is one scripted outcome for the next call: a response or a throw.
function fakeRequest(outcomes: Array<FakeResponse | Error>): {
  request: APIRequestContext;
  calls: () => number;
} {
  let calls = 0;
  const request = {
    get: async () => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
      calls++;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  } as unknown as APIRequestContext;
  return { request, calls: () => calls };
}

const okResponse = (token: string): FakeResponse => ({
  ok: () => true,
  json: async () => ({ access_token: token }),
});

const timeout = () =>
  new Error("apiRequestContext.get: Timeout 20000ms exceeded.\n  - → GET /api/v1/auto_login");

test("returns the Bearer header on the first successful call", async () => {
  const { request, calls } = fakeRequest([okResponse("abc")]);
  assert.equal(await getAuthToken(request), "Bearer abc");
  assert.equal(calls(), 1);
});

test("a non-ok response still yields the empty-token fallback, with no retry", async () => {
  // An environment without auth answers 401/403 immediately — that is not an
  // outage, so retrying it would only slow every caller down. The budget is
  // deliberately NON-empty here: with `[]` the assertion would hold even if
  // the helper retried answered responses, and the check would prove nothing.
  const { request, calls } = fakeRequest([{ ok: () => false, json: async () => ({}) }]);
  assert.equal(await getAuthToken(request, { retryDelaysMs: [0, 0, 0] }), "");
  assert.equal(calls(), 1, "an answered request must not consume the retry budget");
});

test("an ok response without a token yields the empty-token fallback, with no retry", async () => {
  const { request, calls } = fakeRequest([{ ok: () => true, json: async () => ({}) }]);
  assert.equal(await getAuthToken(request, { retryDelaysMs: [0, 0, 0] }), "");
  assert.equal(calls(), 1);
});

test("survives a worker recycle: one throw, then the token", async () => {
  const { request, calls } = fakeRequest([timeout(), okResponse("xyz")]);
  assert.equal(await getAuthToken(request, { retryDelaysMs: [0] }), "Bearer xyz");
  assert.equal(calls(), 2);
});

test("keeps retrying across the whole budget — the outage outlasts one attempt", async () => {
  // Daily #1057's shape: the first attempts find nothing, a later one lands
  // after the backend is back. A single retry would have failed here.
  const { request, calls } = fakeRequest([timeout(), timeout(), okResponse("late")]);
  assert.equal(await getAuthToken(request, { retryDelaysMs: [0, 0, 0] }), "Bearer late");
  assert.equal(calls(), 3);
});

test("a backend that never comes back rethrows the ORIGINAL error, never an empty token", async () => {
  const { request, calls } = fakeRequest([timeout(), timeout()]);
  await assert.rejects(
    () => getAuthToken(request, { retryDelaysMs: [0] }),
    /Timeout 20000ms exceeded/,
  );
  // An empty token here would send 135 specs on unauthenticated and surface as
  // a far worse failure than the timeout it replaced.
  assert.equal(calls(), 2);
});

test("the budget is bounded — it gives up instead of looping forever", async () => {
  const { request, calls } = fakeRequest([timeout()]);
  await assert.rejects(() => getAuthToken(request, { retryDelaysMs: [0, 0, 0] }));
  assert.equal(calls(), 4, "one initial attempt plus one per configured delay");
});

test("waits between attempts so a booting worker is not hammered", async () => {
  const { request } = fakeRequest([timeout(), okResponse("slow")]);
  const started = Date.now();
  assert.equal(await getAuthToken(request, { retryDelaysMs: [50] }), "Bearer slow");
  assert.ok(Date.now() - started >= 50, "expected the helper to wait before retrying");
});

test("the default budget spans the observed ~1-minute outage", async () => {
  // Guards the sizing decision itself: shrinking the default back to a single
  // short retry would silently reintroduce the #1086 failures. Asserted on the
  // module's own default, with no injected override.
  const { request, calls } = fakeRequest([timeout(), timeout(), timeout(), okResponse("late")]);
  const budgetMs = DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.ok(budgetMs >= 25000, `default backoff sums to ${budgetMs}ms — too short for the observed outage`);
  assert.equal(DEFAULT_RETRY_DELAYS_MS.length, 3);
  // …and the helper really uses one attempt per configured delay.
  assert.equal(await getAuthToken(request, { retryDelaysMs: [0, 0, 0] }), "Bearer late");
  assert.equal(calls(), 4);
});
