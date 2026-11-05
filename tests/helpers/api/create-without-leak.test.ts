// Unit tests for tests/helpers/api/create-without-leak.ts (#2354).
// Run with: npm run test:units
//
// A creating request is re-dialled once on a dropped connection, and must never leave a
// second copy behind: before creating again it asks whether the dropped attempt landed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWithoutLeak } from "./create-without-leak";

/** A creating call that throws `messages[i]` on attempt i, then answers "created-<n>". */
function creating(messages: string[]) {
  let attempt = 0;
  const create = async () => {
    const message = messages[attempt];
    attempt += 1;
    if (message !== undefined) throw new Error(message);
    return `created-${attempt}`;
  };
  return { create, attempts: () => attempt };
}

test("answers what the dropped attempt created, and does not create again", async () => {
  const { create, attempts } = creating(["apiRequestContext.post: socket hang up"]);
  let looked = 0;
  const result = await createWithoutLeak(create, async () => {
    looked += 1;
    return "landed";
  });
  assert.equal(result, "landed");
  assert.equal(attempts(), 1, "it created again although the first attempt had landed");
  assert.equal(looked, 1);
});

test("creates again when the dropped attempt left nothing usable", async () => {
  const { create, attempts } = creating(["read ECONNRESET"]);
  assert.equal(await createWithoutLeak(create, async () => undefined), "created-2");
  assert.equal(attempts(), 2);
});

test("never looks or retries on an error the server answered", async () => {
  // An assertion on a status is not a drop: the request reached the server and was answered.
  const { create, attempts } = creating(["POST /api/v1/flows/: 422 — expected 201"]);
  let looked = 0;
  await assert.rejects(
    createWithoutLeak(create, async () => {
      looked += 1;
      return "x";
    }),
    /422/,
  );
  assert.equal(attempts(), 1);
  assert.equal(looked, 0, "it looked for a resource after an error the server answered");
});

test("re-dials once only: a second drop is reported, not swallowed", async () => {
  const { create } = creating(["socket hang up", "socket hang up"]);
  await assert.rejects(
    createWithoutLeak(create, async () => undefined),
    /socket hang up/,
  );
});

test("a look-up that drops is itself re-dialled before deciding", async () => {
  const { create, attempts } = creating(["socket hang up"]);
  let looks = 0;
  const result = await createWithoutLeak(create, async () => {
    looks += 1;
    if (looks === 1) throw new Error("apiRequestContext.get: socket hang up");
    return "landed";
  });
  assert.equal(result, "landed");
  assert.equal(looks, 2);
  assert.equal(attempts(), 1);
});

test("a successful request is made exactly once, and nothing is looked up", async () => {
  const { create, attempts } = creating([]);
  let looked = 0;
  assert.equal(
    await createWithoutLeak(create, async () => {
      looked += 1;
      return "x";
    }),
    "created-1",
  );
  assert.equal(attempts(), 1);
  assert.equal(looked, 0);
});
