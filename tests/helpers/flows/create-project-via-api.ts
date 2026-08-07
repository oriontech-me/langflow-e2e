import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";
import { deleteProject } from "./delete-project";

/**
 * Creates a project (folder) via `POST /api/v1/projects/` and returns its id plus
 * an id-scoped teardown callback — the project-level sibling of
 * `createRunnableChatFlowViaApi`.
 *
 * The only API-level project creator in the suite: `create-project-through-sidebar`
 * drives the UI, which cannot set `auth_settings` at all.
 *
 * `authSettings` is what makes this more than a convenience. A project's
 * `auth_settings.auth_type` (`"none"` | `"apikey"` | `"oauth"`) is the single
 * source of truth for both the MCP and the A2A transports: it decides what an
 * agent card advertises (`resolve_card_security`) and what the JSON-RPC route
 * enforces (`_enforce_a2a_auth`). A test that needs a restricted project must
 * create its own — flipping the shared superuser's default project would restrict
 * every flow on the instance and break specs running in parallel.
 *
 * Teardown delegates to `deleteProject`, which retries the `500` that
 * `DELETE /api/v1/projects/{id}` returns under write contention (#965). A bare
 * `request.delete` here would silently leak a project per failed teardown.
 *
 * **Teardown also sweeps the API key Langflow mints on its own.** Creating a
 * project *with* `auth_settings` makes the backend issue a key named
 * `MCP Project <project name> - default`, and `DELETE /api/v1/projects/{id}`
 * answers `204` while leaving that key behind — measured on `1.12.0.dev18`, in
 * both directions (a project created without `auth_settings` mints no key, so the
 * trigger is the auth settings, not project creation). Without this sweep every
 * run of every spec using a restricted project leaves one orphan key on the shared
 * account, forever. The sweep matches on the generated project name, which is
 * unique per call, so it cannot touch another spec's key.
 */

export interface CreatedProject {
  /** The id of the created project, usable as a flow's `folder_id`. */
  projectId: string;
  /** Deletes the project created by this helper. Safe to call in `finally`. */
  deleteProject: (reqOverride?: APIRequestContext) => Promise<void>;
}

export async function createProjectViaApi(
  request: APIRequestContext,
  headers: Record<string, string>,
  {
    namePrefix = "e2e-project",
    description = "Created by an E2E test",
    authSettings,
  }: {
    namePrefix?: string;
    description?: string;
    /** e.g. `{ auth_type: "apikey" }`. Omitted entirely when undefined — an
     *  explicit `null` is not the same as absent to the API. */
    authSettings?: Record<string, unknown>;
  } = {},
): Promise<CreatedProject> {
  // Same uniqueness convention as createRunnableChatFlowViaApi: Langflow enforces
  // unique names per user, and two parallel creations in the same millisecond
  // would otherwise race.
  const name = `${namePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const data: Record<string, unknown> = { name, description };
  if (authSettings !== undefined) data.auth_settings = authSettings;

  const res = await request.post("/api/v1/projects/", { headers, data });
  expect(
    res.status(),
    `POST /api/v1/projects/ — ${await res.text()}`,
  ).toBe(201);

  const body = await res.json();
  const projectId = body.id as string;
  expect(projectId, "project creation returns an id").toBeTruthy();

  // Asserted here rather than in the caller: a silently-dropped auth_settings
  // would turn a security test into a test of an unrestricted project that still
  // passes its negative steps. Failing at creation names the real cause.
  if (authSettings !== undefined) {
    expect(
      body.auth_settings,
      "the API persisted auth_settings as sent",
    ).toEqual(authSettings);
  }

  return {
    projectId,
    deleteProject: async (reqOverride?: APIRequestContext) => {
      const req = reqOverride ?? request;
      await deleteProject(req, projectId, { headers });
      // After the project, never before: the sweep is cleanup, and a failure here
      // must not prevent the project itself from being deleted.
      await sweepProjectApiKeys(req, headers, name);
    },
  };
}

/**
 * Deletes the API keys Langflow auto-created for a project, identified by the
 * project's (unique) name. Best-effort by design — this is teardown for a defect,
 * so it warns rather than throwing and never masks the caller's own failure.
 */
async function sweepProjectApiKeys(
  request: APIRequestContext,
  headers: Record<string, string>,
  projectName: string,
): Promise<void> {
  try {
    const res = await request.get("/api/v1/api_key/", { headers });
    if (!res.ok()) return;
    const body = await res.json();
    const keys: Array<{ id: string; name: string }> = body?.api_keys ?? [];
    for (const key of keys.filter((k) => k?.name?.includes(projectName))) {
      const del = await request.delete(`/api/v1/api_key/${key.id}`, { headers });
      if (!del.ok() && del.status() !== 404) {
        console.warn(
          `⚠️ Could not delete the project's auto-created API key "${key.name}": ${del.status()}`,
        );
      }
    }
  } catch (e) {
    console.warn(`⚠️ API key sweep failed for project "${projectName}": ${e}`);
  }
}
