import { readFileSync } from "fs";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { retryOnDroppedConnection } from "../../../../helpers/api/retry-on-dropped-connection";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { postLogin } from "../../../../helpers/auth/login-request";
import { createThrowawayUser, deleteThrowawayUser, type ThrowawayUser } from "../../../../helpers/auth/throwaway-user";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

// Database maintenance mode (#2568, upstream #16181 / #16583).
// Spec doc: docs/api/instance/api-maintenance-mode.md
//
// Maintenance is instance-global: while it is on, every non-superuser write on the
// instance is refused. So every test that turns it on is @destructive (the serial lane)
// and turns it off in a `finally`, and `afterAll` turns it off again whatever happened.
// The one test that never turns it on (the superuser gate) runs in the normal lane.
//
// Measured (`1.14.0.dev39`): the refusal is per caller, not per route. A superuser's
// writes still go through ("Administrators can still make changes"); a regular user's
// get `503 "This instance is in maintenance mode."` from the middleware, before any
// route runs, so even their `POST /maintenance/off` gets that 503 rather than the 403.

/** `MAINTENANCE_REFUSAL` in `services/maintenance/state.py`. */
const REFUSAL = "This instance is in maintenance mode.";
const NOT_SUPERUSER = "The user doesn't have enough privileges";
/** `settings.maintenance.notice` (en), the changes-paused notice on every signed-in page. */
const NOTICE = "Ordinary changes and flow runs are paused for maintenance. Administrators can still make changes.";
/** `createThrowawayUser`'s password, not exported by the helper. */
const THROWAWAY_PASSWORD = "Throwaway!12345";
/** A checker report with no flows: it opens the report view, where the maintenance controls live, without a check. */
const EMPTY_REPORT = "tests/assets/api/upgrade-report-empty.json";

type MaintenanceRead = {
  maintenance: boolean;
  reason: string | null;
  set_by: string | null;
  set_at: string | null;
  queued_jobs: number;
  running_jobs: number;
  paused: boolean;
  migration: boolean;
};

function unique(label: string): string {
  return `E2E maintenance ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** One request, re-dialled once if the server's 2 s keep-alive closed its pooled socket. */
function call(request: () => Promise<APIResponse>): Promise<APIResponse> {
  return retryOnDroppedConnection(request);
}

async function expectStatus(res: APIResponse, status: number, what: string): Promise<string> {
  const raw = await res.text();
  expect(res.status(), `${what} — ${raw.slice(0, 300)}`).toBe(status);
  return raw;
}

/** A write refused by maintenance: `503` and exactly the refusal body. */
async function expectRefused(res: APIResponse, what: string): Promise<void> {
  const raw = await expectStatus(res, 503, what);
  expect(JSON.parse(raw), `${what}: the body of the refusal`).toEqual({ detail: REFUSAL });
}

test.describe("Instance API — database maintenance mode", () => {
  let headers: Record<string, string>;
  let adminId: string;
  const users: ThrowawayUser[] = [];
  const adminFlowIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    headers = { Authorization: await getAuthToken(request) };
    const me = await request.get("/api/v1/users/whoami", { headers });
    adminId = JSON.parse(await expectStatus(me, 200, "GET /api/v1/users/whoami")).id;
  });

  test.afterAll(async ({ request }) => {
    const failures: string[] = [];
    // Never leave the instance paused, whatever a test did.
    await turnOffIfOn(request).catch((e: unknown) => failures.push(String(e)));
    for (const id of adminFlowIds.splice(0)) {
      await deleteFlow(request, id, { headers }).catch((e: unknown) => failures.push(String(e)));
    }
    for (const user of users.splice(0)) {
      await deleteThrowawayUser(request, headers, user).catch((e: unknown) => failures.push(String(e)));
    }
    expect(failures, "teardown leaves nothing behind").toEqual([]);
  });

  async function status(request: APIRequestContext, as = headers): Promise<MaintenanceRead> {
    const res = await call(() => request.get("/api/v1/maintenance/status", { headers: as }));
    return JSON.parse(await expectStatus(res, 200, "GET /api/v1/maintenance/status")) as MaintenanceRead;
  }

  async function turnOffIfOn(request: APIRequestContext): Promise<void> {
    if (!(await status(request)).maintenance) return;
    const off = await call(() => request.post("/api/v1/maintenance/off", { headers }));
    await expectStatus(off, 200, "POST /api/v1/maintenance/off (cleanup)");
  }

  async function regularUser(
    request: APIRequestContext,
    newContext: () => Promise<APIRequestContext>,
  ): Promise<ThrowawayUser> {
    return createThrowawayUser(request, {
      superHeaders: headers,
      newContext,
      prefix: "maintenance",
      track: (u) => users.push(u),
    });
  }

  async function createOwnFlow(req: APIRequestContext, as: Record<string, string>, name: string): Promise<APIResponse> {
    return call(() => req.post("/api/v1/flows/", { headers: as, data: { name, data: { nodes: [], edges: [] } } }));
  }

  test(
    "a regular user can read the status but cannot turn maintenance on or off",
    { tag: ["@stable", "@api", "@database"] },
    async ({ request, playwright, baseURL }) => {
      const user = await regularUser(request, () => playwright.request.newContext({ baseURL }));

      await test.step("the status is readable by a regular user, without who set it", async () => {
        const read = await status(user.request, user.headers);
        expect(read.maintenance, "maintenance is off in the normal lane").toBe(false);
        expect(read.paused).toBe(false);
        expect(read.set_by, "set_by is a superuser detail").toBeNull();
      });

      for (const route of ["on", "off"] as const) {
        await test.step(`POST /api/v1/maintenance/${route} → 403`, async () => {
          const res = await call(() =>
            user.request.post(`/api/v1/maintenance/${route}`, {
              headers: user.headers,
              data: route === "on" ? { reason: "a regular user tries" } : undefined,
            }),
          );
          const raw = await expectStatus(res, 403, `POST /maintenance/${route} as a regular user`);
          expect(JSON.parse(raw).detail).toBe(NOT_SUPERUSER);
        });
      }

      await test.step("maintenance is still off", async () => {
        expect((await status(request)).maintenance).toBe(false);
      });
    },
  );

  test(
    "while on, a regular user's writes and runs are refused, reads and sign-in work, and a superuser can still write",
    { tag: ["@destructive", "@api", "@database"] },
    async ({ request, playwright, baseURL }) => {
      const user = await regularUser(request, () => playwright.request.newContext({ baseURL }));
      const ownName = unique("own flow");
      const created = await createOwnFlow(user.request, user.headers, ownName);
      const userFlowId = JSON.parse(await expectStatus(created, 201, "the user's flow, created before maintenance")).id;
      const reason = unique("reason");

      try {
        await test.step("turning it on records the reason and the superuser who set it", async () => {
          const on = await call(() => request.post("/api/v1/maintenance/on", { headers, data: { reason } }));
          const body = JSON.parse(await expectStatus(on, 200, "POST /api/v1/maintenance/on")) as MaintenanceRead;
          expect(body).toMatchObject({ maintenance: true, paused: true, migration: false, reason, set_by: adminId });
          expect(await status(request)).toMatchObject({ maintenance: true, paused: true, reason, set_by: adminId });
        });

        await test.step("a regular user reads it on, with the reason and without who set it", async () => {
          expect(await status(user.request, user.headers)).toMatchObject({
            maintenance: true,
            paused: true,
            reason,
            set_by: null,
          });
        });

        await test.step("a regular user's flow update, flow create and variable create are refused", async () => {
          await expectRefused(
            await call(() =>
              user.request.patch(`/api/v1/flows/${userFlowId}`, { headers: user.headers, data: { name: `${ownName} renamed` } }),
            ),
            "PATCH /api/v1/flows/{id} as a regular user",
          );
          await expectRefused(
            await createOwnFlow(user.request, user.headers, unique("refused flow")),
            "POST /api/v1/flows/ as a regular user",
          );
          await expectRefused(
            await call(() =>
              user.request.post("/api/v1/variables/", {
                headers: user.headers,
                data: { name: `E2E_MAINTENANCE_${Date.now()}`, value: "v", type: "Generic", default_fields: [] },
              }),
            ),
            "POST /api/v1/variables/ as a regular user",
          );
        });

        await test.step("a regular user's run is refused at admission", async () => {
          await expectRefused(
            await call(() => user.request.post(`/api/v1/build/${userFlowId}/flow`, { headers: user.headers, data: {} })),
            "POST /api/v1/build/{id}/flow as a regular user",
          );
        });

        await test.step("a regular user cannot lift it: the middleware refuses before the superuser gate", async () => {
          await expectRefused(
            await call(() => user.request.post("/api/v1/maintenance/off", { headers: user.headers })),
            "POST /api/v1/maintenance/off as a regular user, while on",
          );
          expect((await status(request)).maintenance, "still on").toBe(true);
        });

        await test.step("reads work: the user's flow is unchanged and listed", async () => {
          const one = await call(() => user.request.get(`/api/v1/flows/${userFlowId}`, { headers: user.headers }));
          expect(JSON.parse(await expectStatus(one, 200, "GET /api/v1/flows/{id}")).name, "the refused rename left no trace").toBe(
            ownName,
          );
          const list = await call(() =>
            user.request.get("/api/v1/flows/?get_all=true&header_flows=true", { headers: user.headers }),
          );
          const ids = (JSON.parse(await expectStatus(list, 200, "GET /api/v1/flows/")) as Array<{ id: string }>).map(
            (f) => f.id,
          );
          expect(ids).toContain(userFlowId);
        });

        await test.step("sign-in works for a regular user", async () => {
          const login = await postLogin(user.request, user.username, THROWAWAY_PASSWORD);
          const raw = await expectStatus(login, 200, "POST /api/v1/login as a regular user, while on");
          expect(JSON.parse(raw).access_token, "the login issues a token").toBeTruthy();
        });

        await test.step("a superuser still creates and updates a flow", async () => {
          const name = unique("admin flow");
          const res = await createOwnFlow(request, headers, name);
          const adminFlowId = JSON.parse(await expectStatus(res, 201, "POST /api/v1/flows/ as the superuser")).id as string;
          adminFlowIds.push(adminFlowId);
          const patch = await call(() =>
            request.patch(`/api/v1/flows/${adminFlowId}`, { headers, data: { name: `${name} renamed` } }),
          );
          expect(JSON.parse(await expectStatus(patch, 200, "PATCH /api/v1/flows/{id} as the superuser")).name).toBe(
            `${name} renamed`,
          );
        });

        await test.step("turning it off lifts it", async () => {
          const off = await call(() => request.post("/api/v1/maintenance/off", { headers }));
          const body = JSON.parse(await expectStatus(off, 200, "POST /api/v1/maintenance/off")) as MaintenanceRead;
          expect(body).toMatchObject({ maintenance: false, paused: false, reason: null });
          expect(await status(user.request, user.headers)).toMatchObject({ maintenance: false, paused: false });
        });

        await test.step("the regular user's writes go through again", async () => {
          const patch = await call(() =>
            user.request.patch(`/api/v1/flows/${userFlowId}`, { headers: user.headers, data: { name: `${ownName} renamed` } }),
          );
          expect(JSON.parse(await expectStatus(patch, 200, "PATCH /api/v1/flows/{id} after off")).name).toBe(
            `${ownName} renamed`,
          );
          const variable = await call(() =>
            user.request.post("/api/v1/variables/", {
              headers: user.headers,
              data: { name: `E2E_MAINTENANCE_${Date.now()}`, value: "v", type: "Generic", default_fields: [] },
            }),
          );
          await expectStatus(variable, 201, "POST /api/v1/variables/ after off");
        });
      } finally {
        await turnOffIfOn(request);
      }
      // The user's flow and variable go with the user, in afterAll.
    },
  );

  test(
    "turning maintenance on and off from the upgrade reports page shows and removes the paused notice",
    { tag: ["@destructive", "@settings", "@database"] },
    async ({ page, request }) => {
      const reason = unique("page reason");
      let reportId = "";
      let flowId = "";

      await test.step("import an empty report, and a flow to open in the editor", async () => {
        const imported = await call(() =>
          request.post("/api/v1/upgrade-reports", { headers, data: readFileSync(EMPTY_REPORT) }),
        );
        reportId = JSON.parse(await expectStatus(imported, 201, "POST /api/v1/upgrade-reports")).id;
        const flow = await createOwnFlow(request, headers, unique("editor flow"));
        flowId = JSON.parse(await expectStatus(flow, 201, "POST /api/v1/flows/")).id;
        adminFlowIds.push(flowId);
      });

      const notice = page.getByRole("region", { name: "Maintenance status" }).getByTestId("changes-paused-notice");

      try {
        await test.step("the report page shows maintenance off, and no notice", async () => {
          await page.goto(`/settings/upgrade-reports?report=${reportId}`);
          await expect(page.getByText("Maintenance is off.")).toBeVisible({ timeout: 60_000 });
          await expect(notice).toHaveText("");
        });

        await test.step("turn it on from the page, with a reason", async () => {
          await page.getByRole("button", { name: "Turn maintenance on" }).click();
          const dialog = page.getByRole("dialog", { name: "Turn maintenance on" });
          await expect(dialog).toContainText("Ordinary changes and new flow runs will pause for everyone.");
          await dialog.getByRole("textbox", { name: "Reason (optional)" }).fill(reason);
          await dialog.getByRole("button", { name: "Turn maintenance on" }).click();
          await expect(dialog).toBeHidden();
          expect(await status(request)).toMatchObject({ maintenance: true, reason, set_by: adminId });
        });

        await test.step("the page shows it on with the reason, and the notice appears", async () => {
          await expect(page.getByText("Maintenance is on.")).toBeVisible();
          await expect(page.getByText(reason, { exact: true })).toBeVisible();
          await expect(notice).toHaveText(NOTICE);
        });

        await test.step("the flow editor shows the notice too", async () => {
          await page.goto(`/flow/${flowId}`);
          await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
          await expect(notice).toHaveText(NOTICE);
        });

        await test.step("turn it off from the page; the notice disappears", async () => {
          await page.goto(`/settings/upgrade-reports?report=${reportId}`);
          await page.getByRole("button", { name: "Turn maintenance off" }).click();
          const dialog = page.getByRole("dialog", { name: "Turn maintenance off" });
          await expect(dialog).toContainText("Ordinary changes and new flow runs will resume for everyone.");
          await dialog.getByRole("button", { name: "Turn maintenance off" }).click();
          await expect(dialog).toBeHidden();
          await expect(page.getByText("Maintenance is off.")).toBeVisible();
          await expect(notice).toHaveText("");
          expect(await status(request)).toMatchObject({ maintenance: false, paused: false });
        });
      } finally {
        await page.goto("about:blank");
        await turnOffIfOn(request);
      }
    },
  );
});
