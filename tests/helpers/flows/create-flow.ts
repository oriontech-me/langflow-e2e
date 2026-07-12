import type { APIRequestContext } from "@playwright/test";

/** Total attempts (one initial call plus retries) for a transient create 5xx. */
const MAX_ATTEMPTS = 3;

/**
 * Creates a flow via the Langflow REST API, absorbing the transient
 * `POST /api/v1/flows/` 500 that Langflow emits under concurrent creation.
 *
 * Upstream's unique-name suffixing (`New Flow (N)`) is not transaction-safe, so
 * parallel workers creating flows at the same instant intermittently get a
 * 500 ("An internal error occurred while creating the flow"; see #588). Passing
 * explicit unique names (which every caller here already does) reduces but does
 * not fully remove the race, so a 5xx is retried up to `MAX_ATTEMPTS` times with
 * a short linear backoff to let the DB contention settle. A non-5xx client error
 * (400/401/403/422/…) is deterministic — it won't change on retry — so it throws
 * immediately with its original body.
 *
 * Mirrors the retry philosophy of `deleteFlow` for the create side.
 *
 * Pass `page.request` (browser-context cookie/state auth is reused
 * automatically) or a standalone `request` with an explicit Authorization
 * header via `options.headers`.
 *
 * @param request  A Playwright `APIRequestContext` (`page.request` or the `request` fixture).
 * @param data     The flow creation payload (`name`, `data`, `is_component`, …).
 * @param options  Optional request options, e.g. `{ headers: { Authorization } }`.
 * @returns        The created flow's ID.
 */
export async function createFlow(
  request: APIRequestContext,
  data: Record<string, unknown>,
  options?: { headers?: Record<string, string> },
): Promise<string> {
  const url = "/api/v1/flows/";
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await request.post(url, {
      headers: options?.headers ?? {},
      data,
    });
    if (res.status() === 201) {
      const { id } = (await res.json()) as { id?: string };
      // A 201 without an id is a malformed success: returning `undefined` here
      // lets callers build an `undefined` id handle (e.g. `aria-labelledby*=`)
      // that only fails much later, far from the cause. Surface it right away.
      if (!id) {
        throw new Error(`POST ${url} returned 201 with no flow id`);
      }
      return id;
    }

    lastStatus = res.status();
    lastBody = (await res.text()).slice(0, 200);

    // A 4xx is a deterministic client error (auth, bad payload, unique-name
    // clash) that won't change on retry — surface it right away.
    if (lastStatus < 500) {
      throw new Error(`POST ${url} failed: ${lastStatus} — ${lastBody}`);
    }

    // A 5xx is the transient concurrent-creation race (#588): back off briefly
    // and retry until the attempt budget is spent.
    if (attempt < MAX_ATTEMPTS) {
      await sleep(200 * attempt);
    }
  }

  throw new Error(
    `POST ${url} failed after ${MAX_ATTEMPTS} attempts: ${lastStatus} — ${lastBody}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
