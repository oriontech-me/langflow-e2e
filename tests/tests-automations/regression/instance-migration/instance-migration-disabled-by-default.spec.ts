import type { APIRequestContext, APIResponse, Page, Response } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Instance migration is off unless LANGFLOW_FEATURE_INSTANCE_MIGRATION=true is set at
// process start. This spec runs on the NORMAL lane, where the flag is unset, and asserts
// that nothing of the feature is reachable there (#2348). Spec doc:
// docs/instance-migration/instance-migration-disabled-by-default.md
//
// No `@instance-migration` tag: that lane turns the flag on, so this spec is the one
// instance-migration spec that belongs to the default build — and can be `@stable`.

/** Any path under /api/ that no router serves: the control "not mounted" is compared to. */
const NO_SUCH_ROUTE = "/api/v1/im-2348-no-such-route";

const MIGRATION_PREFIX = "/api/v1/migration";

const NOT_DEFAULT_BUILD =
  "this instance has instance migration turned on (LANGFLOW_FEATURE_INSTANCE_MIGRATION) — " +
  "the spec asserts the DEFAULT build; run it on the normal lane";

/** The page's own GET of `pathname` — the next one after this call. */
function pageGet(page: Page, pathname: string): Promise<Response> {
  return page.waitForResponse(
    (r) => r.request().method() === "GET" && new URL(r.url()).pathname === pathname,
  );
}

/** The page's own GET /api/v1/config, which carries the feature flags the frontend reads. */
function configResponse(page: Page): Promise<Response> {
  return pageGet(page, "/api/v1/config");
}

/**
 * What a response says about whether a route exists: its status, its body and, for a
 * 405, which methods the matched path allows. `allow` is a set — its order changed
 * between two nightlies (`GET, HEAD` on 1.14.0.dev14, `HEAD, GET` on dev17).
 */
async function shapeOf(res: APIResponse) {
  const allow = res.headers()["allow"];
  return {
    status: res.status(),
    body: await res.text(),
    allow: allow === undefined ? null : allow.split(",").map((m) => m.trim()).sort(),
  };
}

async function migrationFlagOverApi(request: APIRequestContext, authToken: string): Promise<unknown> {
  const res = await request.get("/api/v1/config", { headers: { Authorization: authToken } });
  expect(res.status(), "GET /api/v1/config").toBe(200);
  return (await res.json()).feature_flags?.instance_migration;
}

test.describe("Instance migration is off by default", () => {
  test(
    "Settings shows no Migration entry, its address falls back to General, and no page asks about a migration",
    { tag: ["@stable", "@settings", "@ui-ux"] },
    async ({ page }) => {
      // Recorded for the whole test: with the flag on, every page — the home page
      // included — sends GET /api/v1/migration/pause to feed the pause notice.
      const migrationRequests: string[] = [];
      page.on("request", (req) => {
        const { pathname } = new URL(req.url());
        if (pathname.startsWith(MIGRATION_PREFIX)) migrationRequests.push(`${req.method()} ${pathname}`);
      });

      await test.step("the server reports the flag off, to a viewer who is a superuser", async () => {
        // The Migration entry needs BOTH: the flag, from /config, and a superuser, from
        // /users/whoami. The two arrive in either order (measured: whoami 3 ms after the
        // config on one instance, 24 ms before it on another), so the absence below is
        // checked only once both are in.
        const config = configResponse(page);
        const whoami = pageGet(page, "/api/v1/users/whoami");
        // Messages, not General: the sidebar is the same on every Settings page, and
        // General loads every profile picture (116 requests, quiet only after ~11 s,
        // against 38 and ~3.4 s here), which the quiet period below would wait out.
        await page.goto("/settings/messages");
        const flags = (await (await config).json()).feature_flags;
        expect(flags?.instance_migration, NOT_DEFAULT_BUILD).toBe(false);
        expect(
          (await (await whoami).json()).is_superuser,
          "the viewer is a superuser, so the entry's absence is the flag's doing",
        ).toBe(true);
      });

      await test.step("the Settings sidebar has no Migration entry once the flags and the user are in", async () => {
        // A quiet period after both responses: the store updates and the sidebar
        // re-renders after the response is received, so checking at once could beat the
        // render that would add the entry.
        // eslint-disable-next-line playwright/no-networkidle
        await page.waitForLoadState("networkidle");
        await expect(page.getByTestId("sidebar-nav-General")).toBeVisible();
        await expect(page.getByTestId("sidebar-nav-Migration")).toHaveCount(0);
        await expect(page.locator('a[href="/settings/migration"]')).toHaveCount(0);
      });

      await test.step("opening /settings/migration directly lands on General", async () => {
        // A full load: the page shows a spinner until the flags arrive, and decides to
        // redirect only then. Waiting for the config first keeps a slow config response
        // (measured: one run in a loaded host) from reading as "did not redirect".
        const config = configResponse(page);
        await page.goto("/settings/migration");
        await config;
        await expect(page).toHaveURL(/\/settings\/general$/);
        await expect(page.getByTestId("settings_menu_header")).toContainText("General");
      });

      await test.step("the home page loads without asking about a migration", async () => {
        const config = configResponse(page);
        await page.goto("/");
        await config;
        // An absence needs a quiet period to mean anything: with the flag on, the pause
        // request leaves shortly AFTER the config response, so stopping at the config
        // would pass on any build. Force-failed against the flag-on lane.
        // eslint-disable-next-line playwright/no-networkidle
        await page.waitForLoadState("networkidle");
      });

      await test.step("no request to /api/v1/migration* left the page", async () => {
        expect(migrationRequests, "requests the frontend sends only when the feature is on").toEqual([]);
      });
    },
  );

  test(
    "the migration routes are not mounted: they answer exactly as a route that does not exist",
    { tag: ["@stable", "@api", "@settings"] },
    async ({ request }) => {
      // The superuser's token on every request: a MOUNTED route would serve exactly this
      // request, while an unauthenticated one could be refused for a different reason.
      const authToken = await getAuthToken(request);
      const headers = { Authorization: authToken };

      await test.step("the server reports the instance_migration flag off", async () => {
        expect(await migrationFlagOverApi(request, authToken), NOT_DEFAULT_BUILD).toBe(false);
      });

      const control = await test.step("control: a GET and a POST to a path no router serves", async () => {
        const get = await shapeOf(await request.get(NO_SUCH_ROUTE, { headers }));
        const post = await shapeOf(await request.post(NO_SUCH_ROUTE, { headers }));
        // Sanity only — the assertions below compare against the control, not these.
        expect(get.status, `GET ${NO_SUCH_ROUTE}`).toBeGreaterThanOrEqual(400);
        expect(post.status, `POST ${NO_SUCH_ROUTE}`).toBeGreaterThanOrEqual(400);
        return { get, post };
      });

      await test.step("GET /api/v1/migration and GET /api/v1/migration/pause answer as the control GET", async () => {
        for (const path of [MIGRATION_PREFIX, `${MIGRATION_PREFIX}/pause`]) {
          expect(await shapeOf(await request.get(path, { headers })), `GET ${path}`).toEqual(control.get);
        }
      });

      await test.step("POST /api/v1/migration/pause answers as the control POST", async () => {
        const path = `${MIGRATION_PREFIX}/pause`;
        expect(await shapeOf(await request.post(path, { headers })), `POST ${path}`).toEqual(control.post);
      });
    },
  );

  test(
    "a normal write succeeds on the default build",
    { tag: ["@stable", "@api", "@database", "@settings"] },
    async ({ request }) => {
      const authToken = await getAuthToken(request);
      const headers = { Authorization: authToken };
      const stamp = Date.now();
      const original = `IM-2348 write ${stamp}`;
      const renamed = `IM-2348 write ${stamp} renamed`;

      const flowId = await test.step("create a flow", async () => {
        const res = await request.post("/api/v1/flows/", {
          headers,
          data: { name: original, data: { nodes: [], edges: [] }, is_component: false },
        });
        expect(res.status(), "POST /api/v1/flows/").toBe(201);
        return (await res.json()).id as string;
      });

      try {
        await test.step("rename it: 200, not the 503 a pause gives every write", async () => {
          const res = await request.patch(`/api/v1/flows/${flowId}`, { headers, data: { name: renamed } });
          expect(res.status(), `PATCH /api/v1/flows/${flowId}: ${await res.text()}`).toBe(200);
        });

        await test.step("the new name is read back, so the write was saved", async () => {
          const res = await request.get(`/api/v1/flows/${flowId}`, { headers });
          expect(res.status(), `GET /api/v1/flows/${flowId}`).toBe(200);
          expect((await res.json()).name).toBe(renamed);
        });
      } finally {
        await test.step("cleanup: delete the flow", async () => {
          await deleteFlow(request, flowId, { headers });
        });
      }
    },
  );
});
