// Unit tests for the busy-database retry (issue #2400).
// Run with: npm run test:units
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATABASE_BUSY_DETAIL,
  MAX_BUSY_RETRIES,
  RETRY_BUSY_MS,
  describeBusyRetries,
  isDatabaseBusy,
  retryBusyDatabase,
  type ResponseLike,
} from "./retry-busy-database";

function response(status: number, body: unknown): ResponseLike {
  return {
    status: () => status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const busy = () => response(503, { detail: DATABASE_BUSY_DETAIL });
const migrationPause = () => response(503, { detail: "This instance is being migrated." });

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

test("the retry is the UI's: once, after 700 ms", () => {
  // use-restore-version.ts: RETRY_BUSY_MS = 700, one more activate.
  assert.equal(RETRY_BUSY_MS, 700);
  assert.equal(MAX_BUSY_RETRIES, 1);
});

test("only a 503 carrying the exact busy detail is retryable", async () => {
  assert.equal(await isDatabaseBusy(busy()), true);
  assert.equal(await isDatabaseBusy(migrationPause()), false);
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
    text: async () => {
      throw new Error("No data found for resource with given identifier");
    },
  };
  assert.equal(await isDatabaseBusy(unreadable), false);
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

test("a busy answer is sent again once, after 700 ms", async () => {
  const ok = response(200, { id: "f" });
  const s = scripted(busy(), ok);
  const result = await retryBusyDatabase(s.send, { sleep: s.sleep });
  assert.equal(result.response, ok);
  assert.equal(s.calls, 2);
  assert.deepEqual(s.waits, [700]);
  assert.deepEqual(result.retries, [{ attempt: 1, delayMs: 700 }]);
});

test("a second busy answer is returned, not retried", async () => {
  const second = busy();
  const s = scripted(busy(), second, response(200, {}));
  const result = await retryBusyDatabase(s.send, { sleep: s.sleep });
  assert.equal(s.calls, 2);
  assert.equal(result.response, second);
  assert.equal(result.retries.length, 1);
  assert.equal(await isDatabaseBusy(result.response), true);
});

test("a first 503 that is not the busy one is returned at once", async () => {
  // The UI would retry this one; the helper is narrower so the assertion sees it.
  const pause = migrationPause();
  const s = scripted(pause, response(200, {}));
  const result = await retryBusyDatabase(s.send, { sleep: s.sleep });
  assert.equal(result.response, pause);
  assert.equal(s.calls, 1);
  assert.deepEqual(s.waits, []);
});

test("the description names every retry", () => {
  assert.equal(describeBusyRetries([]), "no busy retry");
  assert.equal(
    describeBusyRetries([{ attempt: 1, delayMs: 700 }]),
    "1 busy retry (attempt 1 busy, waited 700 ms)",
  );
});
