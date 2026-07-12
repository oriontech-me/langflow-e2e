import type { Page } from "@playwright/test";
import { deleteFlow } from "./delete-flow";

/**
 * Deletes all user-created flows via the Langflow REST API.
 *
 * The UI dropdown that previously handled this is a Radix UI portal element
 * that detaches from the DOM mid-click under page re-renders, making it
 * unreliable for cleanup. The API approach is deterministic and fast.
 *
 * Works in the default auto_login mode; falls back gracefully if the token
 * endpoint is unavailable (flows simply won't be deleted in that case).
 *
 * WARNING: destructive across parallel workers. This deletes EVERY user
 * flow on the shared instance, including flows another worker is actively
 * using — in the fully-parallel CI suite that kills the neighbor's test
 * mid-flight (its page starts 404ing "Flow not found"; see #553). Do NOT
 * call this as pre-test cleanup in specs that run in the parallel suite;
 * create your flow, keep its id, and delete only that id in your cleanup.
 *
 * DEPRECATED — scoped teardown is the default (#515/#589). Every parallel-suite
 * spec has been migrated to capture its own flow id and delete only that id
 * (see `setup-blank-flow.ts` and the `deleteFlow`-based `afterEach` in the loop,
 * mcp-client and playground-session-clear specs). The ONE legitimate remaining
 * caller is `user-progress-track.spec.ts`, whose assertions require the shared
 * superuser's flow space to be *globally empty* (empty getting-started state +
 * progress reset) — a need scoped teardown cannot express. That spec is
 * inherently incompatible with concurrent neighbors; per-worker user isolation
 * (#589 item 3) is the structural fix that would let it drop this helper and let
 * this file be deleted. Do NOT add new callers.
 */
export const cleanAllFlows = async (page: Page) => {
  // Obtain a bearer token via auto_login (no credentials required in dev/test).
  const loginRes = await page.request.get("/api/v1/auto_login");
  let headers: Record<string, string> = {};
  if (loginRes.ok()) {
    const body = await loginRes.json();
    if (body?.access_token) {
      headers = { Authorization: `Bearer ${body.access_token}` };
    }
  }

  // List only user-created flows (remove_example_flows excludes starter projects).
  const listRes = await page.request.get("/api/v1/flows/", {
    headers,
    params: { get_all: "true", remove_example_flows: "true" },
  });

  if (!listRes.ok()) return;

  const raw = await listRes.json();
  const flows: Array<{ id: string }> = Array.isArray(raw) ? raw : (raw.flows ?? []);
  if (flows.length === 0) return;

  // Best-effort bulk sweep: keep deleting the rest even if one fails, then
  // surface any failures at the end so a silently-incomplete cleanup is visible.
  const failures: string[] = [];
  for (const flow of flows) {
    try {
      await deleteFlow(page.request, flow.id, { headers });
    } catch (err) {
      failures.push(`${flow.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `cleanAllFlows: ${failures.length} of ${flows.length} flow deletion(s) failed:\n${failures.join("\n")}`,
    );
  }
};
