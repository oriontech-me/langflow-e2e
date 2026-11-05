import { execFileSync } from "node:child_process";
import { type APIRequestContext, type APIResponse, type Page, request as pwRequest, type Response } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { retryOnDroppedConnection } from "../../../helpers/api/retry-on-dropped-connection";
import { signInThroughForm } from "../../../helpers/auth/sign-in-through-form";
import { createThrowawayUser, deleteThrowawayUser, type ThrowawayUser } from "../../../helpers/auth/throwaway-user";
import {
  instanceMigrationLane,
  resetInstanceMigration,
} from "../../../helpers/instance-migration/instance-migration-lane";
import {
  getMigration,
  type MigrationApi,
  migrationApi,
  migrationRouteInventory,
  prepareBeforePause,
  prepareThroughPause,
} from "../../../helpers/instance-migration/migration-walk";

// Spec doc: docs/instance-migration/instance-migration-authorization.md
// Lane: PW_INSTANCE_MIGRATION=1, against ./scripts/start-langflow-instance-migration.sh
//
// Instance migration can pause every write on the instance and hand its whole database
// to another server, so only a superuser may run it. One route is open to every
// signed-in user: GET /api/v1/migration/pause, which feeds the paused notice on every
// page. Test 1 reads the router the source is running and sends every other route to a
// regular user and to a client with no session. Test 2 reads the pause as a regular
// user. Test 3 is a regular user's Settings, in the browser.
//
// Every test starts and ends with the lane's reset. What a test adds to the source it
// removes itself, after the reset, in reverse order.
//
// No @stable — no scheduled @instance-migration lane exists (#1010).

const lane = instanceMigrationLane();
// Each test pays up to two source checks (~20 s each idle, up to ~95 s measured on a
// loaded host).
const TEST_TIMEOUT_MS = 10 * 60_000;
const MIGRATION = "/api/v1/migration";
/** `get_current_active_superuser`'s refusal of a signed-in user who is not one. */
const NOT_A_SUPERUSER = { detail: "The user doesn't have enough privileges" };
/** The refusal of a request that carries no token, no cookie and no API key. */
const NO_CREDENTIALS = { detail: "No authentication credentials provided" };
/** What a route's path parameters are filled with: a real step, and a run that does not exist. */
const PATH_PARAMETERS: Record<string, string> = { "{step_id}": "copy_database", "{run_id}": "0".repeat(32) };
/** `createThrowawayUser`'s password, not exported by the helper. */
const THROWAWAY_PASSWORD = "Throwaway!12345";
const ADMIN_ONLY = "Only admins can move this instance.";

let api: MigrationApi;
/** What a test added to the source, removed after the reset. Run in reverse order. */
let cleanups: (() => Promise<void>)[] = [];

async function expectStatus(response: { status(): number; text(): Promise<string> }, status: number, what: string) {
  expect(response.status(), `${what}: ${(await response.text()).slice(0, 300)}`).toBe(status);
}

/**
 * One request, re-dialled once if its pooled socket was closed under it (the server's
 * 2 s keep-alive, tests/helpers/api/retry-on-dropped-connection.ts). Safe for a refused
 * call too: a server that took the first attempt answers the second with a success,
 * which fails the test as it should.
 */
function call(request: () => Promise<APIResponse>): Promise<APIResponse> {
  return retryOnDroppedConnection(request);
}

/** A body as JSON when it is JSON, else its text — a database download would come back as text and fail the comparison. */
async function bodyOf(response: APIResponse): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 200);
  }
}

/** The migration record, byte for byte, from the source container. */
function migrationRecord(): string {
  return execFileSync("docker", ["exec", lane.containers.source, "cat", `${lane.configDir}/migrations/migration.json`], {
    encoding: "utf8",
  });
}

async function stepStates(): Promise<string[]> {
  const { steps } = await retryOnDroppedConnection(() => getMigration(api));
  return steps.map((s) => `${s.id}: ${s.state}${s.reason ? ` (${s.reason})` : ""}`);
}

/** `GET /api/v1/migration/pause`, as the superuser. */
async function pausedNow(): Promise<boolean> {
  const response = await call(() => api.request.get(`${MIGRATION}/pause`, { headers: api.headers }));
  await expectStatus(response, 200, `GET ${MIGRATION}/pause as the superuser`);
  return (await response.json()).paused;
}

/** A regular user, in a request context of their own, deleted after the test. */
async function createRegularUser(request: APIRequestContext, baseURL: string | undefined, prefix: string): Promise<ThrowawayUser> {
  return createThrowawayUser(request, {
    superHeaders: api.headers,
    newContext: () => pwRequest.newContext({ baseURL }),
    prefix,
    track: (user) => cleanups.push(() => deleteThrowawayUser(api.request, api.headers, user)),
  });
}

/** A request context with no token, no cookie and no API key. */
async function noCredentials(baseURL: string | undefined): Promise<APIRequestContext> {
  const context = await pwRequest.newContext({ baseURL });
  cleanups.push(() => context.dispose());
  return context;
}

/** The address a route answers at, with its path parameters filled in. */
function addressOf(path: string): string {
  return `/api/v1${path.replace(/\{[^}]+\}/g, (name) => PATH_PARAMETERS[name] ?? name)}`;
}

/** The page's own GET of `pathname` — the next one after this call. */
function pageGet(page: Page, pathname: string): Promise<Response> {
  return page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === pathname, {
    timeout: 30_000,
  });
}

test.describe("Instance migration — only a superuser can reach it, and a regular user reads nothing sensitive", () => {
  test.beforeEach(async ({ request }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    resetInstanceMigration();
    cleanups = [];
    api = await migrationApi(request);
  });

  test.afterEach(async () => {
    // The reset lifts any pause: the source refuses the deletes below until it does.
    resetInstanceMigration();
    const errors: string[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (errors.length > 0) throw new Error(`cleanup left data on the source:\n${errors.join("\n")}`);
  });

  test(
    "every superuser route refuses a regular user and a client with no session, and a refusal changes nothing",
    { tag: ["@instance-migration", "@auth", "@api"] },
    async ({ request, baseURL }) => {
      let user: ThrowawayUser;
      let anonymous: APIRequestContext;
      let recordBefore = "";
      let stepsBefore: string[] = [];

      await test.step("Setup (API): every step before the pause, a regular user and a client with no credentials", async () => {
        // The check, the destinations and the verified key: a record with something to protect.
        await prepareBeforePause(api, lane);
        user = await createRegularUser(request, baseURL, "imauthz");
        anonymous = await noCredentials(baseURL);
      });

      const guarded = await test.step("The router inside the source: only GET /migration/pause is open to a non-superuser", async () => {
        const routes = migrationRouteInventory(lane);
        const open = routes.filter((r) => !r.superuser).flatMap((r) => r.methods.map((m) => `${m} ${r.path}`));
        expect(open, "routes not guarded by get_current_active_superuser").toEqual(["GET /migration/pause"]);
        expect(
          routes.find((r) => r.path === "/migration/pause" && r.methods.includes("GET"))?.signedIn,
          "GET /migration/pause is guarded by get_current_active_user",
        ).toBe(true);
        const guardedRoutes = routes.filter((r) => r.superuser).flatMap((r) => r.methods.map((method) => ({ method, path: r.path })));
        // Controls: the inventory read the routes the issue names, the download included.
        expect(guardedRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(
          expect.arrayContaining(["GET /migration", "PUT /migration/destinations", "POST /migration/backup/database"]),
        );
        return guardedRoutes;
      });

      await test.step("Snapshot the migration record and the step states", async () => {
        recordBefore = migrationRecord();
        stepsBefore = await stepStates();
        expect(JSON.parse(recordBefore).destinations?.files?.bucket, "the record holds the saved destinations").toBe(
          lane.target.bucket,
        );
      });

      for (const { method, path } of guarded) {
        await test.step(`${method} ${path}: 403 for a regular user and for no credentials`, async () => {
          const address = addressOf(path);
          expect(address, "every path parameter is filled").not.toMatch(/[{}]/);
          const send = (context: APIRequestContext, headers: Record<string, string>) =>
            call(() => context.fetch(address, { method, headers, data: method === "GET" ? undefined : {}, timeout: 30_000 }));

          const asUser = await send(user.request, user.headers);
          expect.soft(asUser.status(), `${method} ${address} as a regular user`).toBe(403);
          expect.soft(await bodyOf(asUser), `${method} ${address} as a regular user: the body`).toEqual(NOT_A_SUPERUSER);

          const asNobody = await send(anonymous, {});
          expect.soft(asNobody.status(), `${method} ${address} with no credentials`).toBe(403);
          expect.soft(await bodyOf(asNobody), `${method} ${address} with no credentials: the body`).toEqual(NO_CREDENTIALS);
        });
      }

      await test.step("Nothing changed: the record byte for byte, the step states, and no pause", async () => {
        expect(migrationRecord(), "migration.json after every refused call").toBe(recordBefore);
        expect(await stepStates(), "the step states after every refused call").toEqual(stepsBefore);
        expect(await pausedNow(), "a pause after every refused call").toBe(false);
      });
    },
  );

  test(
    "a regular user reads only whether changes are paused, and cannot change that",
    { tag: ["@instance-migration", "@auth", "@api"] },
    async ({ request, baseURL }) => {
      let user: ThrowawayUser;
      let anonymous: APIRequestContext;

      await test.step("Setup (API): a regular user, a client with no credentials, and every step through the pause", async () => {
        // The user first: during the pause, POST /api/v1/users/ is refused with 503.
        user = await createRegularUser(request, baseURL, "imauthzpause");
        anonymous = await noCredentials(baseURL);
        await prepareThroughPause(api, lane);
      });

      await test.step("The regular user reads exactly {\"paused\":true}, and nothing the superuser sees", async () => {
        const response = await call(() => user.request.get(`${MIGRATION}/pause`, { headers: user.headers }));
        await expectStatus(response, 200, `GET ${MIGRATION}/pause as a regular user`);
        const body = await response.text();
        expect(body, "the raw body").toBe('{"paused":true}');

        const state = await retryOnDroppedConnection(() => getMigration(api));
        const superuserView = JSON.stringify(state);
        const checkNames = state.acceptable_checks ?? [];
        // Control: what the superuser reads does name the destination and the checks.
        expect(checkNames.length, "the superuser's state names the checks").toBeGreaterThan(0);
        expect(superuserView, "the superuser's state names the bucket").toContain(lane.target.bucket);
        const sensitive = [
          ...lane.sentinels,
          lane.secretKeyFingerprint,
          lane.containers.database,
          lane.target.bucket,
          lane.configDir,
          state.instance.database.path ?? "",
          ...checkNames,
        ].filter(Boolean);
        expect(
          sensitive.filter((s) => body.includes(s)),
          "secrets, destinations, the source's paths and check names in the regular user's body",
        ).toEqual([]);
      });

      await test.step("The regular user can neither lift the pause nor start another, and nothing changes", async () => {
        const before = migrationRecord();
        for (const method of ["DELETE", "POST"]) {
          const response = await call(() =>
            user.request.fetch(`${MIGRATION}/pause`, { method, headers: user.headers, data: {} }),
          );
          await expectStatus(response, 403, `${method} ${MIGRATION}/pause as a regular user`);
          expect(await response.json(), `${method} ${MIGRATION}/pause as a regular user: the body`).toEqual(NOT_A_SUPERUSER);
        }
        expect(await pausedNow(), "still paused").toBe(true);
        expect(migrationRecord(), "migration.json after the refused calls").toBe(before);
      });

      await test.step("A client with no credentials cannot read the pause state", async () => {
        const response = await call(() => anonymous.get(`${MIGRATION}/pause`));
        await expectStatus(response, 403, `GET ${MIGRATION}/pause with no credentials`);
        expect(await response.json()).toEqual(NO_CREDENTIALS);
      });
    },
  );

  test(
    "Settings shows a regular user no way into the migration",
    { tag: ["@instance-migration", "@auth", "@settings", "@ui-ux"] },
    async ({ page, browser, request, baseURL }) => {
      let user: ThrowawayUser;
      // Recorded for the whole test, in the regular user's browser.
      const migrationCalls: string[] = [];
      page.on("response", (r) => {
        const { pathname } = new URL(r.url());
        if (pathname.startsWith(MIGRATION)) migrationCalls.push(`${r.request().method()} ${pathname} ${r.status()}`);
      });

      await test.step("Control: the superuser's Settings has the Migration entry and its steps", async () => {
        // A second browser context, on the lane's auto-login: the superuser. It pins the
        // two test ids whose absence the regular user's page is checked for below.
        const admin = await browser.newContext({ baseURL });
        cleanups.push(() => admin.close());
        const adminPage = await admin.newPage();
        await adminPage.goto("/settings/messages");
        await expect(adminPage.getByTestId("sidebar-nav-Migration")).toBeVisible({ timeout: 30_000 });
        await adminPage.goto("/settings/migration");
        await expect(adminPage.getByTestId("migration-step-check_source")).toBeVisible({ timeout: 30_000 });
      });

      await test.step("Sign in through the form, as a regular user", async () => {
        user = await createRegularUser(request, baseURL, "imauthzui");
        // The lane runs auto-login, and the frontend would become the superuser on every
        // load. This context alone answers the way an instance with auto-login off does
        // (login.py), so the user signs in through the form; nothing asserted below
        // passes through this route.
        await page.context().route("**/api/v1/auto_login", (route) =>
          route.fulfill({ status: 403, json: { detail: { message: "Auto login is disabled.", auto_login: false } } }),
        );
        await page.goto("/login");
        expect(await signInThroughForm(page, user.username, THROWAWAY_PASSWORD), "POST /api/v1/login").toBe(200);
        // The browser's session, read with its cookies: the page does not always ask for
        // /users/whoami after a sign-in (measured: absent within 30 s on some runs), so
        // that request is not waited for.
        const session = await page.request.get("/api/v1/session");
        await expectStatus(session, 200, "GET /api/v1/session after the sign-in");
        expect((await session.json()).user, "the browser is signed in as the regular user").toMatchObject({
          username: user.username,
          is_superuser: false,
        });
      });

      await test.step("The Settings sidebar has no Migration entry, with the feature on", async () => {
        // The entry needs both the flag, from /config, and a superuser. On a load after a
        // sign-in, the user comes from GET /api/v1/session, not /users/whoami (measured).
        // The absence is read only once both are in, and the page is quiet.
        const config = pageGet(page, "/api/v1/config");
        const session = pageGet(page, "/api/v1/session");
        await page.goto("/settings/messages");
        await Promise.all([config, session]);
        // eslint-disable-next-line playwright/no-networkidle
        await page.waitForLoadState("networkidle");
        // Read again with the browser's own cookies: the load can start over once, and the
        // body of the first answer is gone by then (measured).
        const read = async (path: string) => {
          const response = await page.request.get(path);
          await expectStatus(response, 200, `GET ${path} with the browser's session`);
          return response.json();
        };
        expect((await read("/api/v1/config")).feature_flags?.instance_migration, "the feature is on").toBe(true);
        expect((await read("/api/v1/session")).user, "the viewer is the regular user").toMatchObject({
          username: user.username,
          is_superuser: false,
        });
        await expect(page.getByTestId("sidebar-nav-Messages")).toBeVisible();
        await expect(page.getByTestId("sidebar-nav-Migration")).toHaveCount(0);
        await expect(page.locator('a[href="/settings/migration"]')).toHaveCount(0);
      });

      await test.step("Opened directly, /settings/migration shows only the admin-only line", async () => {
        await page.goto("/settings/migration");
        await expect(page.getByText(ADMIN_ONLY)).toBeVisible({ timeout: 30_000 });
        await expect(page).toHaveURL(/\/settings\/migration$/);
        await expect(page.getByText("Move to a new instance", { exact: true })).toBeVisible();
        // A quiet period after the page is up: a request for the state would leave at
        // mount, so the absences below are read only once anything it sent has answered.
        // (The pause is fetched on mount and navigation, not on a timer — measured.)
        // eslint-disable-next-line playwright/no-networkidle
        await page.waitForLoadState("networkidle");
        await expect(page.locator('[data-testid^="migration-step-"]')).toHaveCount(0);
      });

      await test.step("The page asked the server only whether changes are paused", async () => {
        expect(migrationCalls.length, "the page polled the pause at least once").toBeGreaterThan(0);
        expect(
          migrationCalls.filter((c) => c !== `GET ${MIGRATION}/pause 200`),
          "migration requests other than an answered GET of the pause",
        ).toEqual([]);
      });
    },
  );
});
