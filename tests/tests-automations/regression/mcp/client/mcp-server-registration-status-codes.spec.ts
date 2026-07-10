import { randomUUID } from "crypto";
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
// the formal, dated record (reports/daily-history.jsonl + QA Platform + daily-failure
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
//   • 404 for missing resources — 145+ call sites across the API. (Langflow
//     resolves a missing DELETE to 404, not an idempotent 204/200.)
// The 500s in `api/v2/mcp.py` are the anomaly.
//
// Each assertion checks BOTH the status code AND the response `detail`: a status
// alone can pass for the wrong reason — e.g. a renamed/removed route makes the
// framework return a bare 404 "Not Found", which would masquerade as the
// resource-level "Server not found." Matching the specific detail string ties the
// pass to the intended code path.
//
// Pure `page.request` (APIRequestContext) is used deliberately: it runs outside
// the browser page, so the intentional 5xx does NOT trip the fixture's
// `page.on("response")` backend-error monitor — no `allowFlowErrors()` needed.

// Unique, collision-proof names. Worker index + timestamp disambiguate parallel
// workers; the random UUID also rules out two independent invocations sharing the
// same backend colliding in the same millisecond (e.g. a local run against the
// instance the daily is using).
const WORKER = process.env.TEST_WORKER_INDEX ?? "0";
const UNIQUE = `${WORKER}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const DUP_SERVER_NAME = `dup-status-${UNIQUE}`;
const MISSING_SERVER_NAME = `missing-status-${UNIQUE}`;
// Registration is lazy — Langflow persists the config without probing the URL —
// so an unreachable port-1 URL still registers successfully (matches the sibling
// mcp-client-regression.spec.ts convention).
const HTTP_URL = "http://localhost:1/mcp";

// Reads the response `detail` field defensively (body may be non-JSON on some
// error paths); returns "" so a failed parse never masks the status assertion.
async function readDetail(resp: {
  json: () => Promise<unknown>;
}): Promise<string> {
  try {
    const body = (await resp.json()) as { detail?: unknown };
    return typeof body?.detail === "string" ? body.detail : "";
  } catch {
    return "";
  }
}

test.describe("MCP v2 server registration — HTTP status codes", () => {
  test(
    "registering an already-existing MCP server returns 409 Conflict",
    { tag: ["@mcp", "@regression", "@api", "@stable"] },
    async ({ page }) => {
      const authHeader = await getAuthToken(page.request);
      expect(
        authHeader,
        "Auth token is empty — the instance did not return an access_token; " +
          "the status assertions below would fail for an auth reason, not the contract",
      ).toBeTruthy();
      const headers = {
        Authorization: authHeader,
        "Content-Type": "application/json",
      };
      const path = `/api/v2/mcp/servers/${DUP_SERVER_NAME}`;

      await test.step("Pre-clean: delete any server this worker left from a prior attempt/retry", async () => {
        // The name is stable within a worker process, so a Playwright retry that
        // crashed after registering (before the finally below) would otherwise
        // hit "already exists" on the first POST. Cross-invocation leftovers have
        // a different name and are not the target here.
        await page.request.delete(path, { headers });
      });

      try {
        await test.step("First registration succeeds (2xx)", async () => {
          const first = await page.request.post(path, {
            headers,
            data: { url: HTTP_URL },
          });
          // Accept any 2xx: creation is conventionally 200 or 201, and the code
          // under test is the duplicate 409 below — not the create status.
          expect(
            first.status(),
            "First registration of a fresh name should succeed (2xx)",
          ).toBeLessThan(300);
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
          expect(
            await readDetail(second),
            "409 must be the duplicate-name conflict, not an unrelated 409",
          ).toMatch(/already exists/i);
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
      expect(
        authHeader,
        "Auth token is empty — the instance did not return an access_token; " +
          "the status assertion below would fail for an auth reason, not the contract",
      ).toBeTruthy();
      const headers = { Authorization: authHeader };
      // MISSING_SERVER_NAME is unique and never registered, so no guard/pre-clean
      // is needed — the resource is absent by construction.
      const path = `/api/v2/mcp/servers/${MISSING_SERVER_NAME}`;

      await test.step("Deleting a missing server is rejected with 404 Not Found", async () => {
        const resp = await page.request.delete(path, { headers });
        expect(
          resp.status(),
          "Deleting a non-existent MCP server must return 404 Not Found " +
            "(Langflow currently returns 500 — issue #396)",
        ).toBe(404);
        // Guard against a route-level 404 (bare "Not Found") masquerading as the
        // resource-level "Server not found." — a renamed/removed endpoint would
        // otherwise pass this test silently.
        expect(
          await readDetail(resp),
          "404 must be the resource-not-found case, not a missing/renamed route",
        ).toMatch(/server not found/i);
      });
    },
  );
});
