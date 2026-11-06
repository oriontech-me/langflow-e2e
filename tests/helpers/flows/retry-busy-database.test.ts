// Unit tests for the busy-database retry (issue #2400).
// Run with: npm run test:units
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATABASE_BUSY_DETAIL,
  MAX_BUSY_RETRIES,
  describeBusyRetries,
  isDatabaseBusy,
  retryAfterMs,
  retryBusyDatabase,
  type ResponseLike,
} from "./retry-busy-database";

function response(status: number, body: unknown, headers: Record<string, string> = {}): ResponseLike {
  return {
    status: () => status,
    headers: () => headers,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** `null` sends no `Retry-After` header at all. */
const busy = (retryAfter: string | null = "1") =>
  response(503, { detail: DATABASE_BUSY_DETAIL }, retryAfter === null ? {} : { "retry-after": retryAfter });

/** Answers the queued responses in order and counts the calls. */
function scripted(...answers: ResponseLike[]) {
  let calls = 0;
  const waits: number[] = [];
  return {
    send: async () => answers[Math.min(calls++, answers.length - 1)],
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    get calls() {
      return calls;
    },
    waits,
  };
}

test("only a 503 carrying the exact busy detail is retryable", async () => {
  assert.equal(await isDatabaseBusy(busy()), true);
  assert.equal(await isDatabaseBusy(response(503, { detail: "This instance is being migrated." })), false);
  assert.equal(await isDatabaseBusy(response(503, { detail: `${DATABASE_BUSY_DETAIL} ` })), false);
  assert.equal(await isDatabaseBusy(response(500, { detail: DATABASE_BUSY_DETAIL })), false);
  assert.equal(await isDatabaseBusy(response(200, { detail: DATABASE_BUSY_DETAIL })), false);
  assert.equal(await isDatabaseBusy(response(503, "not json")), false);
  assert.equal(await isDatabaseBusy(response(503, "")), false);
  assert.equal(await isDatabaseBusy(response(503, "null")), false);
});

test("a body that cannot be read is not retryable, and does not throw", async () => {
  const unreadable: ResponseLike = {
    status: () => 503,
    headers: () => ({}),
    text: async () => {
      throw new Error("No data found for resource with given identifier");
    },
  };
  assert.equal(await isDatabaseBusy(unreadable), false);
});

test("Retry-After in seconds, a 1 s default, and a 5 s cap", () => {
  assert.equal(retryAfterMs("1"), 1000);
  assert.equal(retryAfterMs("0"), 0);
  assert.equal(retryAfterMs("2.5"), 2500);
  assert.equal(retryAfterMs("60"), 5000);
  assert.equal(retryAfterMs(undefined), 1000);
  assert.equal(retryAfterMs(""), 1000);
  assert.equal(retryAfterMs("-1"), 1000);
  assert.equal(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"), 1000);
});

test("a first answer that is not busy is used as is, with no wait", async () => {
  const ok = response(200, { id: "f" });
  const s = scripted(ok);
  const result = await retryBusyDatabase(s.send, { sleep: s.sleep });
  assert.equal(result.response, ok);
  assert.deepEqual(result.retries, []);
  assert.equal(s.calls, 1);
  assert.deepEqual(s.waits, []);
});

test("busy answers are retried until a different answer comes back", async () => {
  const ok = response(200, { id: "f" });
  const s = scripted(busy("1"), busy(null), ok);
  const result = await retryBusyDatabase(s.send, { sleep: s.sleep });
  assert.equal(result.response, ok);
  assert.equal(s.calls, 3);
  assert.deepEqual(s.waits, [1000, 1000]);
  assert.deepEqual(result.retries, [
    { attempt: 1, retryAfter: "1", delayMs: 1000 },
    { attempt: 2, retryAfter: undefined, delayMs: 1000 },
  ]);
});

test("a different error after a busy answer is returned, not retried", async () => {
  const refused = response(500, { detail: "Database error while activating version. Please try again." });
  const s = scripted(busy(), refused, response(200, {}));
  const result = await retryBusyDatabase(s.send, { sleep: s.sleep });
  assert.equal(result.response, refused);
  assert.equal(s.calls, 2);
});

test(`retries stop after ${MAX_BUSY_RETRIES} and the last busy answer is returned`, async () => {
  const last = busy();
  const s = scripted(busy(), busy(), busy(), last, response(200, {}));
  const result = await retryBusyDatabase(s.send, { sleep: s.sleep });
  assert.equal(MAX_BUSY_RETRIES, 3);
  assert.equal(s.calls, MAX_BUSY_RETRIES + 1);
  assert.equal(result.response, last);
  assert.equal(result.retries.length, MAX_BUSY_RETRIES);
  assert.equal(await isDatabaseBusy(result.response), true);
});

test("maxRetries 0 sends once", async () => {
  const s = scripted(busy(), response(200, {}));
  const result = await retryBusyDatabase(s.send, { sleep: s.sleep, maxRetries: 0 });
  assert.equal(s.calls, 1);
  assert.deepEqual(result.retries, []);
});

test("the description names every retry", () => {
  assert.equal(describeBusyRetries([]), "no busy retry");
  assert.equal(
    describeBusyRetries([{ attempt: 1, retryAfter: "1", delayMs: 1000 }]),
    "1 busy retry: attempt 1 busy (Retry-After 1, waited 1000 ms)",
  );
  assert.match(
    describeBusyRetries([
      { attempt: 1, retryAfter: "1", delayMs: 1000 },
      { attempt: 2, retryAfter: undefined, delayMs: 1000 },
    ]),
    /^2 busy retries: attempt 1 .*; attempt 2 busy \(Retry-After absent, waited 1000 ms\)$/,
  );
});
