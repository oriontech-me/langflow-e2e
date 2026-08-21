import assert from "node:assert/strict";
import { test } from "node:test";
import { postLogin, retryAfterMs } from "./login-request";

/** Minimal APIResponse stand-in — only what postLogin reads. */
function response(status: number, body: unknown = null) {
  return {
    status: () => status,
    json: async () => {
      if (body === null) throw new Error("no body");
      return body;
    },
  };
}

/** A requester scripted with a queue of responses; records its calls. */
function requester(queue: ReturnType<typeof response>[]) {
  const calls: Array<Record<string, string>> = [];
  return {
    calls,
    post: async (_url: string, options: { form: Record<string, string> }) => {
      calls.push(options.form);
      const next = queue.shift();
      if (!next) throw new Error("requester queue exhausted");
      return next as never;
    },
  };
}

test("a non-429 response is returned untouched, first try, no sleep", async () => {
  const slept: number[] = [];
  const r = requester([response(401)]);
  const res = await postLogin(r, "u", "wrong", {
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(res.status(), 401);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(slept, []);
});

test("a 429 waits the advertised retry_after and retries — the retry's verdict wins", async () => {
  const slept: number[] = [];
  const r = requester([response(429, { retry_after: 7 }), response(200)]);
  const res = await postLogin(r, "u", "p", {
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(res.status(), 200);
  assert.equal(r.calls.length, 2);
  // +1s over the server's figure — the window edge is exclusive.
  assert.deepEqual(slept, [8000]);
});

test("an unparseable 429 body falls back to a full window", async () => {
  const slept: number[] = [];
  const r = requester([response(429, null), response(401)]);
  const res = await postLogin(r, "u", "p", {
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(res.status(), 401);
  assert.deepEqual(slept, [61_000]);
});

test("the budget is two retries — a third consecutive 429 is returned, not retried forever", async () => {
  const r = requester([
    response(429, { retry_after: 1 }),
    response(429, { retry_after: 1 }),
    response(429, { retry_after: 1 }),
  ]);
  const res = await postLogin(r, "u", "p", { sleep: async () => {} });
  assert.equal(res.status(), 429);
  assert.equal(r.calls.length, 3);
});

test("retryAfterMs: seconds are converted with the +1s edge margin", () => {
  assert.equal(retryAfterMs({ retry_after: 42 }), 43_000);
  assert.equal(retryAfterMs({ retry_after: "9" }), 10_000);
});

test("retryAfterMs: zero, negative, NaN and missing all fall back", () => {
  for (const body of [
    { retry_after: 0 },
    { retry_after: -3 },
    { retry_after: "soon" },
    {},
    null,
    "429",
  ]) {
    assert.equal(retryAfterMs(body), 61_000, JSON.stringify(body));
  }
});
