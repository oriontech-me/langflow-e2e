import type { APIRequestContext } from "@playwright/test";

/**
 * Fails fast when the instance under test has the A2A surface disabled.
 *
 * A2A ships OFF by default (`LANGFLOW_A2A_ENABLED`, `lfx` settings
 * `a2a_enabled=False`) and its router is **always mounted**: a per-request guard
 * answers `404` on every `/api/v1/a2a/*` route while the flag is off, so a
 * disabled server is deliberately indistinguishable from an unmounted one
 * (`langflow/api/router.py`). Every A2A spec would therefore fail on a bare
 * "expected 200, got 404" that reads like a product regression.
 *
 * #1240 set the flag on every CI lane and in both start scripts, but a lane is not
 * an instance: a local Langflow started before that PR — or any host
 * `PLAYWRIGHT_BASE_URL` points at — can still have it off. Call this from the
 * `beforeAll`/first step of every A2A spec so the failure names its own cause.
 *
 * **Must be given an authenticated context.** `GET /api/v1/config` returns two
 * different shapes: authenticated (`type: "full"`, carries `a2a_enabled`) and
 * anonymous (`type: "public"`, omits the field entirely — measured on
 * `1.12.0.dev14`). An absent field is treated as **disabled**, because an
 * unevaluated precondition is unknown, not clean.
 */
export async function requireA2aEnabled(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<void> {
  const res = await request.get("/api/v1/config", { headers });

  if (!res.ok()) {
    throw new Error(
      `Could not read GET /api/v1/config to check the A2A precondition: HTTP ${res.status()}. ` +
        "The instance is unreachable or unhealthy — this is not a verdict on the A2A flag.",
    );
  }

  const config = (await res.json()) as { a2a_enabled?: unknown; type?: unknown };

  if (config.a2a_enabled === true) return;

  // Missing vs. explicitly false are different mistakes with the same symptom, so
  // the message has to separate them: one is a wrong request, the other a wrong
  // instance.
  const detail =
    config.a2a_enabled === undefined
      ? `the response carried no "a2a_enabled" field at all (type=${String(config.type)}). ` +
        "Only the AUTHENTICATED config response exposes it — pass the same auth headers the " +
        "spec uses (getAuthToken), since the anonymous response omits the field."
      : `a2a_enabled=false.`;

  throw new Error(
    `A2A is not enabled on the instance under test: ${detail} ` +
      "Every /api/v1/a2a/* route answers 404 while the flag is off, so this spec would " +
      "assert against a disabled surface. Restart the instance with LANGFLOW_A2A_ENABLED=true " +
      "— ./scripts/start-langflow-docker.sh sets it by default since #1240.",
  );
}
