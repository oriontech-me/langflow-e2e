import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  SUPERUSER_PASSWORD,
  SUPERUSER_USERNAME,
} from "../../../../helpers/auth/credentials";

/**
 * The login rate limiter (see docs/core-functionality/auth/login-rate-limit.md).
 *
 * `@destructive` because the budget is keyed on the CLIENT ADDRESS and is
 * instance-global: it cannot be isolated per user or per test, and eight specs
 * in this suite authenticate through this endpoint. Exhausting the window in a
 * shared run would hand them a 429 — a red pointing nowhere near its cause.
 *
 * The counters are deliberately loose. `check_rate_limit` runs before
 * authentication, so every attempt counts; but the window is fixed per minute
 * rather than sliding per client, and the limiter is per worker process
 * (`memory://` storage), so the attempt on which the refusal arrives depends on
 * how much of the current window was already spent and on how many workers the
 * instance runs. Measured on one instance minutes apart: refused on the 6th
 * attempt, then on the 5th. Asserting a position would be asserting the
 * environment.
 */
const MAX_ATTEMPTS = 15;
const WINDOW_POLL_MS = 5_000;
const WINDOW_POLL_ATTEMPTS = 24;

function login(request: APIRequestContext, password: string): Promise<APIResponse> {
  return request.post("/api/v1/login", {
    form: { username: SUPERUSER_USERNAME, password },
    // The refusal IS the subject here, so a non-2xx must reach the assertions
    // instead of throwing.
    failOnStatusCode: false,
  });
}

/** Attempt until refused, returning the refusal. Fails if it never comes. */
async function burstUntilRefused(
  request: APIRequestContext,
  password: string,
): Promise<APIResponse> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await login(request, password);
    if (response.status() === 429) return response;
  }
  throw new Error(
    `the login endpoint accepted ${MAX_ATTEMPTS} attempts without refusing. Either the rate limit is not ` +
      "being enforced, or the worker recycled mid-burst and took its in-memory counter with it — check the " +
      "instance log for a worker restart before reading this as a product defect.",
  );
}

/**
 * Wait out the current window.
 *
 * Polls rather than sleeping a constant: the window is the product's to define,
 * and a hardcoded 60 s would turn a product-side change into a spec failure with
 * a misleading cause. Each successful poll spends one unit of the NEXT window,
 * which is why the callers below assert "refused within N", never "on the Nth".
 */
async function waitForWindow(request: APIRequestContext): Promise<void> {
  for (let attempt = 1; attempt <= WINDOW_POLL_ATTEMPTS; attempt++) {
    const response = await login(request, SUPERUSER_PASSWORD);
    if (response.status() === 200) return;
    await new Promise((resolve) => setTimeout(resolve, WINDOW_POLL_MS));
  }
  throw new Error(
    "the login endpoint never reopened — the limiter is not releasing its window",
  );
}

test.describe.configure({ mode: "serial" });

test.describe("Auth — login rate limit", () => {
  test(
    "repeated failed logins are refused with usable retry information",
    { tag: ["@destructive", "@api", "@auth", "@regression"] },
    async ({ request }) => {
      const refusal = await burstUntilRefused(request, "definitely-not-the-password");

      const body = await refusal.json();
      expect(body.detail, "the refusal must say why").toBeTruthy();
      expect(body.retry_after, "a client cannot comply without knowing when").toBeTruthy();

      // Read through headers(), which lower-cases the names. A case-sensitive
      // lookup of "Retry-After" against a raw header map finds nothing here —
      // uvicorn emits it lower-cased — which is how a first probe of this
      // endpoint wrongly concluded the header was missing.
      const header = refusal.headers()["retry-after"];
      expect(header, "the Retry-After header must be present").toBeTruthy();
      expect(header).toBe(String(body.retry_after));
    },
  );

  test(
    "a successful login does not reset or bypass the counter",
    { tag: ["@destructive", "@api", "@auth", "@regression"] },
    async ({ request }) => {
      await waitForWindow(request);

      // Correct credentials this time. The limiter runs before authentication,
      // so these must count too — otherwise interleaving one good login would
      // make brute force free.
      const refusal = await burstUntilRefused(request, SUPERUSER_PASSWORD);
      expect(refusal.status()).toBe(429);
    },
  );

  test(
    "the limiter reopens after the window it advertised",
    { tag: ["@destructive", "@api", "@auth", "@regression"] },
    async ({ request }) => {
      await waitForWindow(request);

      const response = await login(request, SUPERUSER_PASSWORD);
      expect(response.status()).toBe(200);
      // "Accepted" must mean authenticated, not merely un-refused.
      expect((await response.json()).access_token).toBeTruthy();
    },
  );
});
