import type { Page } from "@playwright/test";

/**
 * Deletes all user-created flows via the Langflow REST API.
 *
 * The UI dropdown that previously handled this is a Radix UI portal element
 * that detaches from the DOM mid-click under page re-renders, making it
 * unreliable for cleanup. The API approach is deterministic and fast.
 *
 * Works in the default auto_login mode; falls back gracefully if the token
 * endpoint is unavailable (flows simply won't be deleted in that case).
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

  const flows: Array<{ id: string }> = await listRes.json();
  if (!Array.isArray(flows) || flows.length === 0) return;

  for (const flow of flows) {
    await page.request.delete(`/api/v1/flows/${flow.id}`, { headers });
  }
};
