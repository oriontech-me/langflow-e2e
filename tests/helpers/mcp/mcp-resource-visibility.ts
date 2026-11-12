import type { APIRequestContext } from "@playwright/test";
import { servedVersion, versionAtLeast } from "../other/served-version";

/**
 * Whether a Langflow build scopes a PROJECT MCP server's resources to the flows
 * exposed on it (#2426).
 *
 * langflow-ai/langflow#16127 (*"honor MCP flow visibility for project
 * resources"*, `4254effcc3`, 2026-11-04) added `Flow.mcp_enabled == True` to the
 * project-scoped query of `handle_list_resources` and `handle_read_resource`, so
 * the files of a flow that is not `mcp_enabled` are no longer listed or served by
 * `/api/v1/mcp/project/{id}/…`. Before it, every flow of the project was. The
 * change reached the two release lines a lane may run at different builds:
 *
 * - **1.14 line:** from `1.14.0.dev23`. The fix entered `release-1.14.0` in the
 *   merge of 2026-11-10 20:23Z; tag `v1.14.0.dev22` does not contain the commit
 *   and `v1.14.0.dev23` does (checked with `git merge-base --is-ancestor`).
 * - **1.13 line:** from `1.13.2rc0`. The fix was committed on `release-1.13.2`
 *   the day after the bump to 1.13.2, and `1.13.2rc0` is the first 1.13.2 build
 *   published; nothing below it is known to carry the fix, so a hypothetical
 *   earlier 1.13.2 pre-release reads as "before" — the side where the negative
 *   assertions are skipped rather than wrongly asserted.
 * - Every later line carries it; every earlier one does not.
 *
 * Decided from the VERSION the instance declares and never from the response, for
 * the reason `served-version.ts` gives: asking "is the unexposed file absent?"
 * would pass a build that lost the filter by accident, which is the regression
 * this exists to catch. An unreadable version throws instead of picking a side.
 */
export function projectResourcesFollowMcpVisibility(version: unknown): boolean {
  if (versionAtLeast(version, "1.14.0.dev23")) return true;
  if (versionAtLeast(version, "1.14.0.dev0")) return false;
  return versionAtLeast(version, "1.13.2rc0");
}

/** `projectResourcesFollowMcpVisibility` against the instance's own `GET /api/v1/version`. */
export async function servedProjectResourcesFollowMcpVisibility(
  request: APIRequestContext,
): Promise<boolean> {
  return projectResourcesFollowMcpVisibility(await servedVersion(request));
}
