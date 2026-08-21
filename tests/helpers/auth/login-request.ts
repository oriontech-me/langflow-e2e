import type { APIRequestContext, APIResponse } from "@playwright/test";

/**
 * `POST /api/v1/login` with the shared-budget collision absorbed.
 *
 * The login endpoint is rate-limited per CLIENT IP — 5/min, fixed window,
 * counted before authentication, so every attempt spends budget whether it
 * succeeds or fails (measured for `login-rate-limit.spec.ts`, which is the spec
 * that owns asserting the limiter itself). Every auth spec in a sequential run
 * shares that budget: `admin-password-change` alone spends five calls in ~30 s,
 * so the file that runs next can meet a refused window through no fault of its
 * own — a 429 red pointing nowhere near its cause.
 *
 * This helper turns that collision into a wait: on a 429 it sleeps out the
 * window the server names in `retry_after` (falling back to a full window when
 * the body does not parse) and retries. Anything that is not a 429 is returned
 * as-is — including 401, which several callers assert deliberately — so the
 * helper never hides a verdict, it only removes the one status that is about
 * the SUITE's traffic rather than the credentials under test.
 *
 * Deliberately NOT used by `login-rate-limit.spec.ts`: there the 429 is the
 * subject, and absorbing it would assert nothing.
 */

/** One extra full window over the advertised wait absorbs clock skew. */
const FALLBACK_WINDOW_MS = 61_000;
const MAX_BUDGET_RETRIES = 2;

interface LoginRequester {
  post(
    url: string,
    options: {
      form: Record<string, string>;
      failOnStatusCode: boolean;
    },
  ): Promise<APIResponse>;
}

export interface PostLoginOptions {
  /** Unit tests only — a spec must not pass it (same contract as getAuthToken). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Reads the wait the server asked for, in ms. Exported for its unit test.
 *
 * The refusal body carries `retry_after` in seconds (the header `retry-after`
 * exists too, but has been observed truncated — the body field is the one the
 * product's own spec asserts). A missing or unparseable value falls back to a
 * full window: over-waiting costs seconds on a path already refused, while
 * under-waiting spends the retry on a still-closed window.
 */
export function retryAfterMs(body: unknown): number {
  if (body !== null && typeof body === "object" && "retry_after" in body) {
    const seconds = Number((body as { retry_after: unknown }).retry_after);
    if (Number.isFinite(seconds) && seconds > 0) {
      // +1s: the server rounds down and the window edge is exclusive.
      return (seconds + 1) * 1000;
    }
  }
  return FALLBACK_WINDOW_MS;
}

/**
 * POST the login form, waiting out up to two rate-limit windows.
 *
 * Returns the first non-429 response — the caller owns asserting its status
 * (200 for a live credential, 401 for a refused one, …).
 */
export async function postLogin(
  request: APIRequestContext | LoginRequester,
  username: string,
  password: string,
  options: PostLoginOptions = {},
): Promise<APIResponse> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let response = await request.post("/api/v1/login", {
    form: { username, password },
    failOnStatusCode: false,
  });

  for (let retry = 0; retry < MAX_BUDGET_RETRIES; retry++) {
    if (response.status() !== 429) return response;

    const body = await response.json().catch(() => null);
    await sleep(retryAfterMs(body));

    response = await request.post("/api/v1/login", {
      form: { username, password },
      failOnStatusCode: false,
    });
  }

  return response;
}
