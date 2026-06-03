import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";

/**
 * Regression for PR #13471 — "Fix timestamp rendering for expires_at in API Key model".
 *
 * Bug: API key timestamps (created_at / expires_at / last_used_at) were serialized
 * by the backend as naive UTC instants WITHOUT a timezone offset (e.g.
 * "2026-06-10T23:59:59"). The frontend's DateReader does `new Date(str)`, and JS
 * parses an offset-less ISO string as LOCAL time — so no UTC→local conversion
 * happened and the UI displayed the raw UTC wall-clock.
 *
 * Fix: backend `_as_utc_iso()` now always emits the "+00:00" offset (and strips
 * microseconds); dedicated CreatedAtCellRender / LastUsedAtCellRender render via
 * DateReader, which now correctly converts to the viewer's local timezone.
 *
 * Two layers are asserted:
 *  - @api  : the serializer contract (offset present, no microseconds, null stays null).
 *  - @ui-ux: the table renders the local-converted wall clock, "Never" and ∞ states.
 *
 * The UI test pins the browser timezone to America/Sao_Paulo (UTC−03:00, no DST in
 * Brazil since 2019) so the expected local value is deterministic on any CI machine:
 * a key expiring at 23:59:59 UTC must display as 20:59:59 local. Pre-fix it showed
 * 23:59:59 (raw UTC) — that mismatch is what this test guards against.
 */

// Intended UTC instant for the expiring key. Pinned-TZ local equivalent below.
const EXPIRES_AT_UTC = "2026-06-10T23:59:59+00:00";
const EXPIRES_AT_LOCAL_SAO_PAULO = "2026-06-10 20:59:59"; // 23:59:59 UTC − 03:00
const UI_TIMEZONE = "America/Sao_Paulo";

// Resolve an auth token across environments: auto_login when enabled, otherwise a
// form login. Credentials come from env (LF_TEST_USERNAME / LF_TEST_PASSWORD) so the
// spec is portable between the auto_login CI image and a superuser dev instance.
async function resolveBearer(request: APIRequestContext): Promise<string> {
  const auto = await request.get("/api/v1/auto_login");
  if (auto.ok()) {
    const body = await auto.json();
    if (body?.access_token) return `Bearer ${body.access_token}`;
  }
  const form = new URLSearchParams();
  form.append("username", process.env.LF_TEST_USERNAME ?? "langflow");
  form.append("password", process.env.LF_TEST_PASSWORD ?? "langflow");
  const res = await request.post("/api/v1/login", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: form.toString(),
  });
  expect(res.status(), "form login should succeed").toBe(200);
  const data = await res.json();
  expect(data.access_token, "login should return an access token").toBeTruthy();
  return `Bearer ${data.access_token}`;
}

// Mirror resolveBearer for the UI: land on the app logged in regardless of auth mode.
// Do not branch on page.url() — the SPA redirect to /login happens after the goto
// resolves, so we wait for whichever lands first (the login form or the main page).
async function ensureLoggedInUI(page: Page): Promise<void> {
  await page.goto("/");
  const usernameField = page.getByPlaceholder(/Username|usu[aá]rio/i).first();
  const mainTitle = page.getByTestId("mainpage_title");
  await expect(usernameField.or(mainTitle).first()).toBeVisible({
    timeout: 30000,
  });

  if ((await usernameField.count()) > 0) {
    await usernameField.fill(process.env.LF_TEST_USERNAME ?? "langflow");
    await page
      .locator('input[type="password"]')
      .first()
      .fill(process.env.LF_TEST_PASSWORD ?? "langflow");
    await page.getByRole("button", { name: /Sign In|Conectar/i }).click();
  }
  await expect(mainTitle).toBeVisible({ timeout: 30000 });
}

// Read a single AG-Grid cell for the row whose name column matches `keyName`.
function gridCell(page: Page, keyName: string, colId: string) {
  const row = page.locator(".ag-row", {
    has: page.locator('[col-id="name"]', { hasText: keyName }),
  });
  return row.locator(`[col-id="${colId}"]`);
}

test.describe("API key timestamp timezone handling (PR #13471)", () => {
  // Shared API keys are created once in beforeAll and read by both tests.
  test.describe.configure({ mode: "serial" });
  test.use({ timezoneId: UI_TIMEZONE });

  let bearer: string;
  let expiringKeyId: string;
  let foreverKeyId: string;
  const expiringKeyName = `tz-regression-expires-${Date.now()}`;
  const foreverKeyName = `tz-regression-forever-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    bearer = await resolveBearer(request);

    const expiring = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearer },
      data: { name: expiringKeyName, expires_at: EXPIRES_AT_UTC },
    });
    expect(expiring.status()).toBe(200);
    expiringKeyId = (await expiring.json()).id;

    const forever = await request.post("/api/v1/api_key/", {
      headers: { Authorization: bearer },
      data: { name: foreverKeyName },
    });
    expect(forever.status()).toBe(200);
    foreverKeyId = (await forever.json()).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [expiringKeyId, foreverKeyId]) {
      if (id) {
        await request.delete(`/api/v1/api_key/${id}`, {
          headers: { Authorization: bearer },
        });
      }
    }
  });

  test(
    "serializes created_at/expires_at with UTC offset and no microseconds",
    { tag: ["@regression", "@api", "@settings", "@stable"] },
    async ({ request }) => {
      const keys = await test.step("fetch the API key list", async () => {
        const res = await request.get("/api/v1/api_key/", {
          headers: { Authorization: bearer },
        });
        expect(res.status()).toBe(200);
        return (await res.json()).api_keys as Array<{
          name: string;
          created_at: string;
          expires_at: string | null;
          last_used_at: string | null;
        }>;
      });

      const expiring = keys.find((k) => k.name === expiringKeyName);
      const forever = keys.find((k) => k.name === foreverKeyName);
      expect(expiring, "expiring key should be present").toBeTruthy();
      expect(forever, "forever key should be present").toBeTruthy();

      await test.step("timestamps carry a UTC offset and no microseconds", async () => {
        const utcIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;
        expect(expiring!.created_at).toMatch(utcIso);
        expect(forever!.created_at).toMatch(utcIso);
        // The instant must round-trip exactly — this is the value the UI converts.
        expect(expiring!.expires_at).toBe(EXPIRES_AT_UTC);
      });

      await test.step("null expiry / never-used stay null", async () => {
        expect(forever!.expires_at).toBeNull();
        expect(expiring!.last_used_at).toBeNull();
        expect(forever!.last_used_at).toBeNull();
      });
    },
  );

  test(
    "renders API key timestamps in the viewer's local timezone",
    { tag: ["@regression", "@ui-ux", "@settings", "@stable"] },
    async ({ page, request }) => {
      const createdUtcWallClock = await test.step(
        "read the serialized created_at (UTC)",
        async () => {
          // created_at is "now" — fetch it so we can prove the rendered value
          // was shifted off the raw UTC wall clock (the pre-fix bug).
          const listRes = await request.get("/api/v1/api_key/", {
            headers: { Authorization: bearer },
          });
          expect(listRes.status()).toBe(200);
          const key = (
            (await listRes.json()).api_keys as Array<{
              name: string;
              created_at: string;
            }>
          ).find((k) => k.name === expiringKeyName);
          expect(key, "expiring key should exist before UI check").toBeTruthy();
          return key!.created_at.slice(0, 19).replace("T", " ");
        },
      );

      await test.step("open Settings → API Keys", async () => {
        await ensureLoggedInUI(page);
        await page.goto("/settings/api-keys");
        await expect(page.locator(".ag-row").first()).toBeVisible({
          timeout: 30000,
        });
        await expect(gridCell(page, expiringKeyName, "name")).toBeVisible({
          timeout: 15000,
        });
      });

      await test.step("expires_at renders in local time (23:59:59 UTC → 20:59:59)", async () => {
        await expect(gridCell(page, expiringKeyName, "expires_at")).toHaveText(
          EXPIRES_AT_LOCAL_SAO_PAULO,
        );
      });

      await test.step("created_at is converted off the raw UTC wall clock", async () => {
        const createdCell = gridCell(page, expiringKeyName, "created_at");
        await expect(createdCell).toHaveText(
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
        );
        await expect(createdCell).not.toHaveText(createdUtcWallClock);
      });

      await test.step('"Never" (unused) and ∞ (no expiry) states', async () => {
        await expect(gridCell(page, expiringKeyName, "last_used_at")).toHaveText(
          "Never",
        );
        await expect(gridCell(page, foreverKeyName, "expires_at")).toHaveText(
          "∞",
        );
      });
    },
  );
});
