import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import {
  createThrowawayUser,
  deleteThrowawayUser,
  type ThrowawayUser,
} from "../auth/throwaway-user";

/**
 * A throwaway user that owns one spec file's connections (#2295).
 *
 * Connection writes (30/minute), `/test` (5/minute) and `/health` (5/minute) are
 * rate-limited **per user**, and every spec in a lane runs as the same superuser.
 * Measured on `1.13.0.dev47`: the five batch-1 connection specs together spend 37
 * superuser writes per run, so running them side by side on one instance with two
 * workers refused a UI PATCH with `429` and failed a `@stable` test. A spec whose
 * subject is the API needs no superuser, so it owns its rows through a user of its
 * own and spends that user's buckets — fresh on every run, shared with no one.
 *
 * Send `headers` on the **test's own** `request`, never on a context of the
 * user's: the `apiCoverage` fixture records only the test-scoped context, and the
 * Authorization header is what decides who the caller is (the test's context has
 * no session cookie unless something logs it in).
 *
 * Created once per worker in `beforeAll`: one `POST /api/v1/login` each, which OSS
 * limits to 5/minute per client IP — `createThrowawayUser` waits a refused window
 * out rather than failing. Deleting the user takes its connections with it
 * (measured in #1969), so `dispose()` is also the last line of cleanup.
 */
export interface ConnectionsOwner {
  /** `{ Authorization: "Bearer <the owner's token>" }`. */
  headers: Record<string, string>;
  /** The owner's id — what `owner_id` reads on every row it creates. */
  userId: string;
  /** Deletes the user (its rows go with it) and disposes the contexts. Idempotent. */
  dispose(): Promise<void>;
}

/** The three calls the owner is built from — injectable so the lifecycle is unit-testable. */
export interface ConnectionsOwnerDeps {
  getAuthToken: (request: APIRequestContext) => Promise<string>;
  createThrowawayUser: typeof createThrowawayUser;
  deleteThrowawayUser: typeof deleteThrowawayUser;
}

const DEFAULT_DEPS: ConnectionsOwnerDeps = { getAuthToken, createThrowawayUser, deleteThrowawayUser };

export async function createConnectionsOwner(
  newContext: () => Promise<APIRequestContext>,
  prefix: string,
  deps: ConnectionsOwnerDeps = DEFAULT_DEPS,
): Promise<ConnectionsOwner> {
  // The superuser's own context, kept until dispose(): the delete needs it.
  const superRequest = await newContext();
  let superHeaders: Record<string, string>;
  let user: ThrowawayUser;
  try {
    superHeaders = { Authorization: await deps.getAuthToken(superRequest) };
    let tracked: ThrowawayUser | undefined;
    try {
      user = await deps.createThrowawayUser(superRequest, {
        superHeaders,
        newContext,
        prefix,
        track: (created) => {
          tracked = created;
        },
      });
    } catch (error) {
      // The user may exist already (a failed activation or login): never leave it.
      if (tracked) {
        await deps.deleteThrowawayUser(superRequest, superHeaders, tracked).catch((cleanup) => {
          console.warn(`⚠️ Orphan user left behind (${tracked?.id}): ${cleanup}`);
        });
      }
      throw error;
    }
  } catch (error) {
    await superRequest.dispose();
    throw error;
  }

  let disposed = false;
  return {
    headers: user.headers,
    userId: user.id,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await deps.deleteThrowawayUser(superRequest, superHeaders, user);
      } finally {
        await superRequest.dispose();
      }
    },
  };
}
