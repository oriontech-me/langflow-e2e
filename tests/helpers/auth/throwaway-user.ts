import type { APIRequestContext } from "@playwright/test";
import { postLogin } from "./login-request";

/**
 * A user created for one test and deleted after it (#2044).
 *
 * Global variables (`OLLAMA_BASE_URL`, `GOOGLE_API_KEY`, …) are per user, and every
 * spec in a lane runs as the same superuser: `collect-models` imports the provider
 * keys there and `ollama-provider.spec.ts` sets and deletes `OLLAMA_BASE_URL`. A test
 * that needs one of them absent — or set to its own value — cannot own that state on
 * the superuser without racing the rest of the suite. A fresh user can.
 *
 * The user is driven through its OWN request context: the login sets cookies, and
 * they must never reach the superuser's `request`. The same shape as
 * `connections-page.spec.ts`, which predates this helper.
 *
 * One `POST /api/v1/login` per user — OSS limits it to 5/min per client IP, and
 * `postLogin` waits out a refused window rather than failing on the suite's traffic.
 */

export interface ThrowawayUser {
  id: string;
  username: string;
  /** Isolated context carrying nothing of the superuser's. */
  request: APIRequestContext;
  headers: Record<string, string>;
}

export async function createThrowawayUser(
  request: APIRequestContext,
  options: {
    superHeaders: Record<string, string>;
    newContext: () => Promise<APIRequestContext>;
    /** Letters and digits only; a timestamp and a random suffix are appended. */
    prefix: string;
    /** Called as soon as the user exists, so a later failure still deletes it. */
    track: (user: ThrowawayUser) => void;
  },
): Promise<ThrowawayUser> {
  const username = `${options.prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = "Throwaway!12345";
  const created = await request.post("/api/v1/users/", {
    headers: options.superHeaders,
    data: { username, password },
  });
  if (created.status() !== 201) {
    throw new Error(`POST /api/v1/users/ failed: ${created.status()} — ${(await created.text()).slice(0, 200)}`);
  }
  const user: ThrowawayUser = {
    id: ((await created.json()) as { id: string }).id,
    username,
    request: await options.newContext(),
    headers: {},
  };
  options.track(user);

  // A user created through the API arrives inactive and cannot log in yet.
  const activated = await request.patch(`/api/v1/users/${user.id}`, {
    headers: options.superHeaders,
    data: { is_active: true },
  });
  if (activated.status() !== 200) {
    throw new Error(`PATCH /api/v1/users/${user.id} failed: ${activated.status()} — ${await activated.text()}`);
  }
  const login = await postLogin(user.request, username, password);
  if (login.status() !== 200) {
    throw new Error(`POST /api/v1/login as ${username} failed: ${login.status()} — ${await login.text()}`);
  }
  user.headers = { Authorization: `Bearer ${((await login.json()) as { access_token: string }).access_token}` };
  return user;
}

/**
 * Deletes the user (its global variables go with it) and disposes its context.
 *
 * 1.12.x answers 200. Since langflow-ai/langflow#15470 (1.13.0.dev36) the delete is
 * asynchronous: 202 "User deletion started", the account deactivated at once and its
 * data erased in the background, the user row last. A 202 alone proves only that the
 * request was taken: an erase that stalls, or a worker that never started, still
 * answers 202 and leaks the user. So on 202 this waits for the user to answer 404,
 * as upstream's own E2E helper does (#2228).
 */
export async function deleteThrowawayUser(
  request: APIRequestContext,
  superHeaders: Record<string, string>,
  user: ThrowawayUser,
): Promise<void> {
  try {
    const res = await request.delete(`/api/v1/users/${user.id}`, { headers: superHeaders });
    if (res.status() !== 200 && res.status() !== 202 && res.status() !== 404) {
      throw new Error(`DELETE /api/v1/users/${user.id} failed: ${res.status()} — ${await res.text()}`);
    }
    if (res.status() === 202) await waitForUserErased(request, superHeaders, user.id);
  } finally {
    await user.request.dispose();
  }
}

const ERASE_TIMEOUT_MS = 30_000;
const ERASE_POLL_MS = 500;

async function waitForUserErased(
  request: APIRequestContext,
  superHeaders: Record<string, string>,
  userId: string,
): Promise<void> {
  const deadline = Date.now() + ERASE_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const res = await request.get(`/api/v1/users/${userId}`, { headers: superHeaders });
    if (res.status() === 404) return;
    last = `${res.status()}`;
    await new Promise((resolve) => setTimeout(resolve, ERASE_POLL_MS));
  }
  throw new Error(
    `DELETE /api/v1/users/${userId} answered 202 but the user was not erased within ${ERASE_TIMEOUT_MS / 1000}s (last GET: ${last})`,
  );
}
