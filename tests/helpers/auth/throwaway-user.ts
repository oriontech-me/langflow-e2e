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

/**
 * How long the erase queue may go without finishing ANY erasure before the wait
 * gives up — not how long one user may take.
 *
 * The erase is one singleton worker that runs requests one at a time
 * (`services/data_subjects/worker.py`, a 5 s idle tick). Measured on
 * `1.14.0.dev32`: one empty user is erased in ~9–15 s, and six deleted at once come
 * back at 13 / 32 / 47 / 65 / 80 / 91 s — strictly serial. So a fixed budget per
 * user is wrong in proportion to how many users the run deletes together: four
 * workers disposing their owners in the same `afterAll` put the last one ~40 s
 * behind, and the old 30 s budget failed a spec whose every assertion had passed.
 *
 * What a stuck erase looks like is the queue not moving, so that is what is timed:
 * the deadline is this long after the last erasure seen to finish anywhere on the
 * instance. 60 s is four measured erasures; a worker that never started, or one
 * stalled on a request, still fails here, and the message says how deep the queue
 * was and how long it had been still.
 */
export const ERASE_STALL_MS = 60_000;
/**
 * A hard stop however steadily the queue moves: a run must not wait unboundedly on
 * someone else's deletions. Below Playwright's 5-minute budget for the hook or test
 * that calls this (`timeout` in `playwright.config.ts`) on purpose: a ceiling above
 * it could never fire, and the bare Playwright timeout that fired instead would lose
 * the queue diagnostic this wait exists to give.
 */
export const ERASE_CEILING_MS = 4 * 60_000;
const ERASE_POLL_MS = 1_000;

/**
 * The ids the erase queue holds: `GET /api/v1/users/?deletion_requested=true`.
 * `null` when the read fails or the body has no `users` array. A build that ignored
 * the filter would answer the full user list rather than `null`; any user deleted
 * anywhere then still reads as progress, which is a real erasure all the same.
 * (Builds before langflow#15470 answer the delete `200` and never reach this wait.)
 */
async function erasureQueue(request: APIRequestContext, superHeaders: Record<string, string>): Promise<Set<string> | null> {
  try {
    const res = await request.get("/api/v1/users/", {
      headers: superHeaders,
      params: { deletion_requested: "true", limit: 200 },
    });
    if (res.status() !== 200) return null;
    const body = (await res.json()) as { users?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.users)) return null;
    return new Set(body.users.map((user) => String(user.id)));
  } catch {
    return null;
  }
}

/** Whether an erasure finished between two reads of the queue: an id the first held is gone from the second. */
export function queueMoved(previous: Set<string> | null, current: Set<string> | null): boolean {
  if (previous === null || current === null) return false;
  for (const id of previous) if (!current.has(id)) return true;
  return false;
}

/**
 * The wait's verdict at one instant: keep waiting, or the reason to give up. An
 * unreadable queue never counts as progress, so without it the wait degrades to a
 * fixed `stallMs` from the delete — still longer than the old 30 s, never unbounded.
 */
export function eraseWaitVerdict(state: {
  now: number;
  startedAt: number;
  lastProgressAt: number;
  stallMs?: number;
  ceilingMs?: number;
}): { wait: true } | { wait: false; reason: string } {
  const stallMs = state.stallMs ?? ERASE_STALL_MS;
  const ceilingMs = state.ceilingMs ?? ERASE_CEILING_MS;
  if (state.now - state.startedAt >= ceilingMs) {
    return { wait: false, reason: `the erase queue was still moving after ${ceilingMs / 1000}s, the hard ceiling` };
  }
  if (state.now - state.lastProgressAt >= stallMs) {
    return { wait: false, reason: `the erase queue finished no erasure for ${stallMs / 1000}s` };
  }
  return { wait: true };
}

export interface EraseClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: EraseClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Waits until `userId` answers 404, for as long as the erase queue keeps moving (see `ERASE_STALL_MS`). */
export async function waitForUserErased(
  request: APIRequestContext,
  superHeaders: Record<string, string>,
  userId: string,
  clock: EraseClock = REAL_CLOCK,
): Promise<void> {
  const startedAt = clock.now();
  let lastProgressAt = startedAt;
  let queue = await erasureQueue(request, superHeaders);
  let last = "";
  // Erasures of OTHER users seen to finish while waiting. With a stalled verdict
  // this tells "the whole queue stopped" from "others moved on and ours did not" —
  // the target's own erase failing and being retried (30/60/120/240 s) or stuck,
  // while the rest of the queue keeps resetting the stall timer.
  let othersFinished = 0;
  for (;;) {
    const res = await request.get(`/api/v1/users/${userId}`, { headers: superHeaders });
    if (res.status() === 404) return;
    last = `${res.status()}`;
    const current = await erasureQueue(request, superHeaders);
    if (queueMoved(queue, current)) {
      lastProgressAt = clock.now();
      for (const id of queue as Set<string>) if (id !== userId && !(current as Set<string>).has(id)) othersFinished += 1;
    }
    if (current !== null) queue = current;
    const verdict = eraseWaitVerdict({ now: clock.now(), startedAt, lastProgressAt });
    if (!verdict.wait) {
      const depth =
        queue === null
          ? "unreadable"
          : `${queue.size} queued, this user ${queue.has(userId) ? "still in it" : "not listed"}; ` +
            `${othersFinished} other erasure(s) finished meanwhile${othersFinished > 0 ? ", this one did not" : ""}`;
      throw new Error(
        `DELETE /api/v1/users/${userId} answered 202 but the user was not erased: ${verdict.reason} ` +
          `(after ${Math.round((clock.now() - startedAt) / 1000)}s; queue ${depth}; last GET: ${last})`,
      );
    }
    await clock.sleep(ERASE_POLL_MS);
  }
}
