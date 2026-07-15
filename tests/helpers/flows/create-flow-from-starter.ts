import type { APIRequestContext } from "@playwright/test";
import { getAuthToken } from "../auth/get-auth-token";
import { createFlow } from "./create-flow";

type StarterFlow = { name?: string; user_id?: string | null; data?: unknown };

/**
 * Create an isolated user flow from a named starter template and return its id.
 *
 * Fetches the starter graph from the running instance and creates a NEW flow
 * with a caller-supplied unique name via the API (`createFlow` absorbs the
 * concurrent-create 500 Langflow's non-transactional name suffixing emits under
 * parallel load — #588). Use this instead of clicking the shared "<name>"
 * template card in the UI: parallel workers clicking the same template collide
 * on flow name/state and cross-contaminate (a locked flow from one worker was
 * observed by another), and the shared creation path serializes on the SQLite
 * writer. An id-addressed flow (`/flow/{id}`) is fully isolated per worker (#684).
 */
export async function createFlowFromStarter(
  request: APIRequestContext,
  starterName: string,
  uniqueName: string,
): Promise<string> {
  const auth = await getAuthToken(request);
  const headers = auth ? { Authorization: auth } : undefined;

  const res = await request.get("/api/v1/flows/", headers ? { headers } : undefined);
  if (!res.ok()) {
    throw new Error(`GET /api/v1/flows/ -> ${res.status()}`);
  }
  const flows = (await res.json()) as StarterFlow[];
  const starter = flows.find((f) => f.name === starterName && !f.user_id);
  if (!starter?.data) {
    throw new Error(`starter template "${starterName}" not found on the instance`);
  }

  return createFlow(
    request,
    { name: uniqueName, data: starter.data, endpoint_name: null },
    headers ? { headers } : undefined,
  );
}
