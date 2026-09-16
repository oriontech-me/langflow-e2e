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
  /**
   * The generated, unique project name.
   *
   * Returned because the name is the only handle a UI caller has: a screen that
   * lists projects offers their names, not their ids, and re-reading it with a
   * `GET` would ask the API for something this helper already knows.
   */
  name: string;
  /** Deletes the project created by this helper. Safe to call in `finally`. */
  deleteProject: (reqOverride?: APIRequestContext) => Promise<void>;
}

/**
 * The number of characters of a project name that Langflow's derived MCP server
 * name preserves: it registers one server per project as
 * `lf-${sanitize_mcp_name(project_name)[: MAX_MCP_SERVER_NAME_LENGTH - 4]}`, with
 * `MAX_MCP_SERVER_NAME_LENGTH = 30` (`lfx/base/mcp/constants.py`). Two projects
 * whose names agree on this prefix collide on that derived name, and the SECOND
 * `POST /api/v1/projects/` is refused with `409` naming an MCP server the caller
 * never created — the product defect in #1409.
 */
const MCP_DERIVED_NAME_BUDGET = 26;

/**
 * Normalises a caller's prefix to the character class that survives Langflow's
 * `sanitize_mcp_name` unchanged in LENGTH, so the budget arithmetic below is
 * exact rather than optimistic.
 *
 * That function replaces runs of hyphens/whitespace with a single `_`, drops
 * everything outside `[\w\s-]`, collapses repeated `_`, and lowercases — all of
 * which SHORTEN a string, never lengthen it. Shortening is safe here (it only
 * lets more of the discriminator survive the cut), so the one case that needs
 * handling is the single transform that LENGTHENS: a name starting with a digit
 * gets an `_` prepended. `startsWithDigit` below pays for that character.
 */
function normalizePrefix(namePrefix: string): string {
  return namePrefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds a project name whose first {@link MCP_DERIVED_NAME_BUDGET} characters are
 * unique for ANY caller prefix — long, variable, or empty.
 *
 * **Why this is not the caller's job.** The obvious fix for #1409 is "pass a
 * shorter prefix", and it was rejected: `api-projects-transfer.spec.ts` passes a
 * VARIABLE (`namePrefix: label`), so no hand edit can reach it; a prefix short
 * enough to be safe is too short to identify whose orphan a leftover project is,
 * which is the prefix's whole job; and it protects no future call site, this
 * helper's own default (`e2e-project`) included.
 *
 * **The discriminator goes first in the budget, not the prefix.** The timestamp is
 * base-36 (8 characters until 2059, against 13 in decimal) purely to buy the
 * prefix more room; the calendar date of an orphan is readable from the API's
 * `created_at` and does not need to be in the name. What the name must carry is
 * the spec it came from, and a truncated prefix is still worth more than a
 * readable timestamp.
 *
 * **Uniqueness is unchanged** — `Date.now()` plus five base-36 characters, the
 * same convention as `createRunnableChatFlowViaApi`, because Langflow enforces
 * unique names per user and two parallel creations in the same millisecond would
 * otherwise race. What changes is only that the pair now survives truncation.
 */
export function uniqueProjectName(namePrefix: string): string {
  const discriminator = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  const prefix = normalizePrefix(namePrefix);
  // A leading digit costs one character to Langflow's sanitiser, which prepends
  // `_` so the name does not start with one. Pay for it here rather than letting
  // it push the discriminator's last character past the cut.
  const startsWithDigit = /^[0-9]/.test(prefix) ? 1 : 0;
  const budget =
    MCP_DERIVED_NAME_BUDGET - discriminator.length - 1 - startsWithDigit;
  const trimmed = budget > 0 ? prefix.slice(0, budget) : "";
  return trimmed ? `${trimmed}-${discriminator}` : discriminator;
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
  const name = uniqueProjectName(namePrefix);

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
    name,
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
