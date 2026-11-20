import type { APIRequestContext } from "@playwright/test";

/**
 * Revokes the API keys Langflow minted for projects a test created and has
 * since deleted (#2512).
 *
 * **Why a test has to do this at all.** Creating a project makes Langflow issue
 * an account API key named `MCP Project <project name> - default`, used by the
 * project's auto-registered MCP server, and `DELETE /api/v1/projects/{id}`
 * answers `204` while leaving that key behind (`cleanup_mcp_on_delete` removes
 * the server entry and never the key). The key carries `user_id` and no project
 * reference, never expires, and stays active. On `1.12.0.dev18` only a project
 * created WITH `auth_settings` minted one; on `1.14.0.dev32` a project created
 * with none does too, because the default MCP auth is `apikey` unless the
 * superuser skips auth under `AUTO_LOGIN`. Measured on `1.14.0.dev32`: four
 * `@stable` specs left 18 keys per run on the shared account, enough to push a
 * spec's own rows out of the rendered Settings › API Keys grid (#2505).
 *
 * **Which name to pass.** The key is named after the project's name AT CREATION
 * and keeps that name when the project is renamed (measured: after a `PATCH` to
 * a new name the MCP server is renamed and the key is not). So callers pass the
 * name from the creation response (which carries any `(1)` suffix Langflow added
 * for a duplicate), never a later name.
 *
 * **Why it cannot revoke a key another test still uses.** A name is revoked
 * only when no project of the user currently carries it, and the key list is
 * read BEFORE the project list. A project and its key are written in the same
 * transaction, so any key in the first read whose project still exists is
 * matched by the second read and kept. Names that are not unique (the UI's
 * `New Project`) are covered by the same rule: while any `New Project` exists,
 * no `New Project` key is touched.
 *
 * **What a non-unique name costs, in both directions.** Langflow appends `(N)`
 * only while the exact name is taken, so once a project created as `New
 * Project` is renamed, the next sidebar create is `New Project` again, and the
 * two keys share one name. The helper cannot tell them apart, and this is the
 * NORMAL case under parallel workers, not a corner: several specs create a
 * `New Project` and rename it at once. So (a) when no project is named `New
 * Project`, every such key is revoked, including that of another worker's
 * project which was renamed and still exists; its auto-registered MCP server
 * loses its key, which nothing in the suite reads (the API returns it only
 * masked, `********`). And (b) while any project is named `New Project`, none
 * is revoked, so those keys are left for a later teardown. Unique names (every
 * API-created project in the suite) have neither problem.
 *
 * Best-effort by design: this is teardown for a product defect, so every
 * failure is logged and nothing throws, never masking the test's own result.
 * When the project list cannot be read, nothing is revoked: an unknown is not
 * proof that a key is orphaned.
 *
 * @param request  A Playwright `APIRequestContext`.
 * @param headers  Auth headers, e.g. `{ Authorization }`.
 * @param projectNames  The creation-time names of projects the caller created.
 */
export async function revokeProjectMintedKeys(
  request: APIRequestContext,
  headers: Record<string, string>,
  projectNames: Iterable<string>,
): Promise<void> {
  const wanted = new Set(
    [...projectNames].filter((n) => typeof n === "string" && n.length > 0),
  );
  if (wanted.size === 0) return;

  try {
    // Keys first, projects second: the ordering is what makes the guard below
    // safe against a project created between the two reads.
    const keysRes = await request.get("/api/v1/api_key/", { headers });
    if (!keysRes.ok()) {
      console.warn(
        `⚠️ Could not list API keys to revoke project-minted keys: ${keysRes.status()}`,
      );
      return;
    }
    const keys: Array<{ id: string; name: string }> =
      (await keysRes.json())?.api_keys ?? [];

    const byName = new Map<string, string>();
    for (const name of wanted) byName.set(mintedKeyName(name), name);
    const candidates = keys.filter((k) => byName.has(k?.name));
    if (candidates.length === 0) return;

    const projectsRes = await request.get("/api/v1/projects/", { headers });
    const projects: unknown = projectsRes.ok() ? await projectsRes.json() : null;
    if (!Array.isArray(projects)) {
      console.warn(
        `⚠️ Could not list projects (${projectsRes.status()}); left ${candidates.length} project-minted key(s) in place rather than guess they are orphaned`,
      );
      return;
    }
    const liveNames = new Set(
      projects.map((p) => (p as { name?: unknown })?.name),
    );

    for (const key of candidates) {
      if (liveNames.has(byName.get(key.name))) continue;
      const del = await request.delete(`/api/v1/api_key/${key.id}`, { headers });
      if (!del.ok() && del.status() !== 404) {
        console.warn(
          `⚠️ Could not delete the project's auto-created API key "${key.name}": ${del.status()}`,
        );
      }
    }
  } catch (e) {
    console.warn(`⚠️ Revoking project-minted API keys failed: ${e}`);
  }
}

/** The name Langflow gives the key it mints for a project. */
export function mintedKeyName(projectName: string): string {
  return `MCP Project ${projectName} - default`;
}
