import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// ─── Purpose ────────────────────────────────────────────────────────────────
//
// Regression guard for the HTTP status codes of the MCP v2 server-registration
// API (`/api/v2/mcp/servers/{name}`). These are pure-API assertions of the
// CORRECT, spec-conformant behavior:
//
//   • POST an already-registered name  → 409 Conflict  (duplicate resource)
//   • DELETE a non-existent server      → 404 Not Found
//
// KNOWN-DEFECT WATCHDOG (issue #396): on current Langflow builds these endpoints
// return **500** for both conditions (`api/v2/mcp.py` — "Server already exists."
// / "Server not found."), so these tests are EXPECTED TO FAIL against the
// nightly until the defect is fixed upstream. That failure is intentional and is
// the formal, dated record (daily-history.jsonl + QA Platform + daily-failure
// issue) that the suite detected the bug. On the first daily failure the daily
// workflow auto-removes `@stable` from these tests; once upstream returns the
// correct codes, restore `@stable` and the tests become forward regression
// guards.
//
// Why 409/404 are the correct codes (not just REST theory): Langflow itself uses
//   • 409 for uniqueness conflicts — `flows_helpers.py` ("Name must be unique"),
//     `authz_*`, `deployments`, and notably the sibling project-scoped MCP
//     endpoint `api/v1/projects_mcp_helpers.py` already returns 409 for a
//     duplicate server name;
//   • 404 for missing resources — 145+ call sites across the API.
// The 500s in `api/v2/mcp.py` are the anomaly.
//
// Pure `page.request` (APIRequestContext) is used deliberately: it runs outside
// the browser page, so the intentional 5xx does NOT trip the fixture's
// `page.on("response")` backend-error monitor — no `allowFlowErrors()` needed.

// Unique, worker-scoped names so parallel workers / sibling MCP specs never
// collide on a shared server name.
const WORKER = process.env.TEST_WORKER_INDEX ?? "0";
const DUP_SERVER_NAME = `dup-status-${WORKER}-${Date.now()}`;
const MISSING_SERVER_NAME = `missing-status-${WORKER}-${Date.now()}`;
const HTTP_URL = "http://localhost:1/mcp";

test.describe("MCP v2 server registration — HTTP status codes", () => {
  test(
    "registering an already-existing MCP server returns 409 Conflict",
    { tag: ["@mcp", "@regression", "@api", "@stable"] },
    async ({ page }) => {
      const authHeader = await getAuthToken(page.request);
      const headers = {
        Authorization: authHeader,
        "Content-Type": "application/json",
      };
      const path = `/api/v2/mcp/servers/${DUP_SERVER_NAME}`;

      await test.step("Pre-clean: remove the server if a prior run left it", async () => {
        await page.request.delete(path, { headers });
      });

      try {
        await test.step("First registration succeeds (200)", async () => {
          const first = await page.request.post(path, {
            headers,
            data: { url: HTTP_URL },
          });
          expect(first.status()).toBe(200);
        });

        await test.step("Second registration of the same name is rejected with 409 Conflict", async () => {
          const second = await page.request.post(path, {
            headers,
            data: { url: HTTP_URL },
          });
          expect(
            second.status(),
            "Duplicate MCP server registration must return 409 Conflict " +
              "(Langflow currently returns 500 — issue #396)",
          ).toBe(409);
        });
      } finally {
        await test.step("Cleanup: delete the registered server", async () => {
          await page.request.delete(path, { headers });
        });
      }
    },
  );

  test(
    "deleting a non-existent MCP server returns 404 Not Found",
    { tag: ["@mcp", "@regression", "@api", "@stable"] },
    async ({ page }) => {
      const authHeader = await getAuthToken(page.request);
      const headers = { Authorization: authHeader };
      const path = `/api/v2/mcp/servers/${MISSING_SERVER_NAME}`;

      await test.step("Guard: ensure the target server does not exist", async () => {
        // Idempotent — best effort; a 404/500 here does not affect the assertion.
        await page.request.delete(path, { headers });
      });

      await test.step("Deleting a missing server is rejected with 404 Not Found", async () => {
        const resp = await page.request.delete(path, { headers });
        expect(
          resp.status(),
          "Deleting a non-existent MCP server must return 404 Not Found " +
            "(Langflow currently returns 500 — issue #396)",
        ).toBe(404);
      });
    },
  );
});
