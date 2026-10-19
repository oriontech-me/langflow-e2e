// Unit tests for createConnectionsOwner (#2295).
// Run with: npm run test:units
//
// The load-bearing properties are about leaks, because a leak here fails no spec:
// a user left behind keeps its connections, and a context left open keeps a
// socket. So every path — success, a failure before the user exists, a failure
// after it exists, a failing delete — must end with the superuser's context
// disposed and no user the helper created still alive.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import type { ThrowawayUser } from "../auth/throwaway-user";
import { createConnectionsOwner, type ConnectionsOwnerDeps } from "./connections-owner";

interface Recorder {
  events: string[];
  newContext: () => Promise<APIRequestContext>;
}

/** Contexts that only know how to be disposed, each recording it by name. */
function contexts(): Recorder {
  const events: string[] = [];
  let n = 0;
  return {
    events,
    newContext: async () => {
      const name = n++ === 0 ? "super" : `ctx${n - 1}`;
      return { dispose: async () => void events.push(`dispose:${name}`) } as unknown as APIRequestContext;
    },
  };
}

const USER: ThrowawayUser = {
  id: "user-1",
  username: "connowner1",
  request: {} as APIRequestContext,
  headers: { Authorization: "Bearer owner-token" },
};

function deps(
  events: string[],
  overrides: Partial<ConnectionsOwnerDeps> = {},
): ConnectionsOwnerDeps {
  return {
    getAuthToken: async () => "Bearer super-token",
    createThrowawayUser: async (_request, options) => {
      options.track(USER);
      events.push(`create:${options.prefix}`);
      return USER;
    },
    deleteThrowawayUser: async (_request, superHeaders, user) => {
      events.push(`delete:${user.id}:${superHeaders.Authorization}`);
    },
    ...overrides,
  };
}

test("the owner carries the user's own token, not the superuser's", async () => {
  const rec = contexts();
  const owner = await createConnectionsOwner(rec.newContext, "connlife", deps(rec.events));
  assert.deepEqual(owner.headers, { Authorization: "Bearer owner-token" });
  assert.equal(owner.userId, "user-1");
  // Nothing is torn down while the owner is in use.
  assert.deepEqual(rec.events, ["create:connlife"]);
});

test("dispose deletes the user as the superuser, then disposes the superuser's context — once", async () => {
  const rec = contexts();
  const owner = await createConnectionsOwner(rec.newContext, "connlife", deps(rec.events));
  await owner.dispose();
  await owner.dispose();
  assert.deepEqual(rec.events, ["create:connlife", "delete:user-1:Bearer super-token", "dispose:super"]);
});

test("a failing delete still disposes the superuser's context, and the failure is not swallowed", async () => {
  const rec = contexts();
  const owner = await createConnectionsOwner(
    rec.newContext,
    "connlife",
    deps(rec.events, {
      deleteThrowawayUser: async () => {
        throw new Error("DELETE /api/v1/users/user-1 answered 202 but the user was not erased within 30s");
      },
    }),
  );
  await assert.rejects(owner.dispose(), /not erased/);
  assert.deepEqual(rec.events, ["create:connlife", "dispose:super"]);
});

test("a failure after the user exists deletes it before rethrowing", async () => {
  const rec = contexts();
  await assert.rejects(
    createConnectionsOwner(
      rec.newContext,
      "connlife",
      deps(rec.events, {
        createThrowawayUser: async (_request, options) => {
          options.track(USER); // created, then the login is refused
          throw new Error("POST /api/v1/login as connowner1 failed: 401");
        },
      }),
    ),
    /login .* failed: 401/,
  );
  assert.deepEqual(rec.events, ["delete:user-1:Bearer super-token", "dispose:super"]);
});

test("a failure before the user exists deletes nothing and still disposes the context", async () => {
  const rec = contexts();
  await assert.rejects(
    createConnectionsOwner(
      rec.newContext,
      "connlife",
      deps(rec.events, {
        createThrowawayUser: async () => {
          throw new Error("POST /api/v1/users/ failed: 500");
        },
      }),
    ),
    /users\/ failed: 500/,
  );
  assert.deepEqual(rec.events, ["dispose:super"]);
});

test("a superuser token that cannot be obtained disposes the context and creates nobody", async () => {
  const rec = contexts();
  await assert.rejects(
    createConnectionsOwner(
      rec.newContext,
      "connlife",
      deps(rec.events, {
        getAuthToken: async () => {
          throw new Error("auto_login refused");
        },
      }),
    ),
    /auto_login refused/,
  );
  assert.deepEqual(rec.events, ["dispose:super"]);
});
