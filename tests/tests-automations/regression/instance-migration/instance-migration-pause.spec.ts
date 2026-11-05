import { execFileSync } from "node:child_process";
import { type APIRequestContext, type APIResponse, type Page, request as pwRequest, type Request } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { createWithoutLeak } from "../../../helpers/api/create-without-leak";
import { retryOnDroppedConnection } from "../../../helpers/api/retry-on-dropped-connection";
import { postLogin } from "../../../helpers/auth/login-request";
import { signInThroughForm } from "../../../helpers/auth/sign-in-through-form";
import { createThrowawayUser, deleteThrowawayUser, type ThrowawayUser } from "../../../helpers/auth/throwaway-user";
import { createCatalogFlow } from "../../../helpers/flows/build-catalog-flow";
import {
  applyNodeSpec,
  CUSTOM_COMPONENT_TYPE,
  fetchComponentCatalog,
} from "../../../helpers/flows/build-custom-component-graph";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import {
  instanceMigrationLane,
  resetInstanceMigration,
} from "../../../helpers/instance-migration/instance-migration-lane";
import {
  getMigration,
  type MigrationApi,
  migrationApi,
  prepareBeforePause,
  prepareThroughPause,
  stepOf,
} from "../../../helpers/instance-migration/migration-walk";

// Spec doc: docs/instance-migration/instance-migration-pause.md
// Lane: PW_INSTANCE_MIGRATION=1, against ./scripts/start-langflow-instance-migration.sh
//
// "Pause changes" stops every user of the instance from changing anything, so the copy
// that follows is complete. Test 1 asks for it while a flow is running: the server waits,
// refuses with the run named, and leaves the instance writable; once the run has ended,
// "Check again" pauses. Test 2 walks every write surface measured during the pause and
// checks none of it landed. Test 3 is a regular user signing in during the pause: the
// notice on every page, their flow still open, a refused change explained at once. Test 4
// restarts the source while paused, then lifts the pause and saves what was refused.
//
// Every test starts and ends with the lane's reset, which lifts the pause. What a test
// adds to the source it removes itself, after the reset, in reverse order.
//
// No @stable — no scheduled @instance-migration lane exists (#1010).

const lane = instanceMigrationLane();
// Each test pays two source checks (~20 s each idle, up to ~95 s measured on a loaded
// host), and test 1 waits for a source check the page runs by itself.
const TEST_TIMEOUT_MS = 15 * 60_000;
const CHECK_TIMEOUT_MS = 300_000;
/** What the waiting flow sleeps: long enough to open the page, ask for the pause and read the refusal. */
const WAIT_SECONDS = 25;
const ALL_FLOWS = "/api/v1/flows/?get_all=true&header_flows=true";
/** The server's refusal, `REFUSAL` in `migration_pause.py`. */
const REFUSAL = "This instance is being migrated.";
const NOTICE =
  "Changes are paused on this instance while it moves to a new one. You can look at your work, but changes you make now are not saved.";
/** `createThrowawayUser`'s password, not exported by the helper. */
const THROWAWAY_PASSWORD = "Throwaway!12345";

let api: MigrationApi;
/** What a test added to the source, removed after the reset. Run in reverse order. */
let cleanups: (() => Promise<void>)[] = [];

function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function expectStatus(response: { status(): number; text(): Promise<string> }, status: number, what: string) {
  expect(response.status(), `${what}: ${(await response.text()).slice(0, 300)}`).toBe(status);
}

/** A refused change: `503` and the server's reason, nothing else. */
async function expectRefused(
  response: { status(): number; text(): Promise<string>; json(): Promise<unknown> },
  what: string,
) {
  await expectStatus(response, 503, what);
  expect(await response.json(), `${what}: the body of the refusal`).toEqual({ detail: REFUSAL });
}

/**
 * One request, re-dialled once if its pooled socket was closed under it (the server's
 * 2 s keep-alive, tests/helpers/api/retry-on-dropped-connection.ts). Safe for a refused
 * change too: a server that took the first attempt answers the second with a success,
 * which fails the test as it should.
 */
function call(request: () => Promise<APIResponse>): Promise<APIResponse> {
  return retryOnDroppedConnection(request);
}

async function sourceRows<T>(path: string): Promise<T[]> {
  const response = await call(() => api.request.get(path, { headers: api.headers }));
  await expectStatus(response, 200, `GET ${path}`);
  return response.json();
}

async function apiKeyIds(): Promise<string[]> {
  const response = await call(() => api.request.get("/api/v1/api_key/", { headers: api.headers }));
  await expectStatus(response, 200, "GET /api/v1/api_key/");
  return ((await response.json()).api_keys as Array<{ id: string }>).map((k) => k.id).sort();
}

async function usernames(): Promise<string[]> {
  const response = await call(() => api.request.get("/api/v1/users/?limit=100", { headers: api.headers }));
  await expectStatus(response, 200, "GET /api/v1/users/");
  return ((await response.json()).users as Array<{ username: string }>).map((u) => u.username);
}

/** `GET /api/v1/migration/pause`, as the superuser. */
async function pausedNow(): Promise<boolean> {
  const response = await call(() => api.request.get("/api/v1/migration/pause", { headers: api.headers }));
  await expectStatus(response, 200, "GET /api/v1/migration/pause");
  return (await response.json()).paused;
}

async function pauseStepState(): Promise<string> {
  const step = stepOf(await retryOnDroppedConnection(() => getMigration(api)), "pause");
  return step.reason ? `${step.state} (${step.reason})` : step.state;
}

/** A source flow of the superuser's, removed after the test. */
async function createFlow(name: string, description = ""): Promise<string> {
  const flowId = await createWithoutLeak(
    async () => {
      const response = await api.request.post("/api/v1/flows/", {
        headers: api.headers,
        data: { name, description, data: { nodes: [], edges: [] } },
      });
      await expectStatus(response, 201, `POST /api/v1/flows/ '${name}'`);
      return (await response.json()).id as string;
    },
    async () => (await sourceRows<{ id: string; name: string }>(ALL_FLOWS)).find((f) => f.name === name)?.id,
  );
  cleanups.push(() => retryOnDroppedConnection(() => deleteFlow(api.request, flowId, { headers: api.headers })));
  return flowId;
}

/** A file uploaded through `POST /api/v2/files`, removed after the test. The server drops the extension from `name`. */
async function uploadFile(name: string, bytes: Buffer): Promise<string> {
  const fileId = await createWithoutLeak(
    async () => {
      const response = await api.request.post("/api/v2/files", {
        headers: api.headers,
        multipart: { file: { name: `${name}.txt`, mimeType: "text/plain", buffer: bytes } },
      });
      await expectStatus(response, 201, "POST /api/v2/files");
      return (await response.json()).id as string;
    },
    async () => (await sourceRows<{ id: string; name: string }>("/api/v2/files")).find((f) => f.name === name)?.id,
  );
  cleanups.push(async () => {
    const r = await call(() => api.request.delete(`/api/v2/files/${fileId}`, { headers: api.headers }));
    if (!r.ok() && r.status() !== 404) throw new Error(`deleting the file answered ${r.status()}`);
  });
  return fileId;
}

/** A Generic global variable of the superuser's, removed after the test. */
async function createVariable(name: string, value: string): Promise<string> {
  const variableId = await createWithoutLeak(
    async () => {
      const response = await api.request.post("/api/v1/variables/", {
        headers: api.headers,
        data: { name, value, type: "Generic", default_fields: [] },
      });
      await expectStatus(response, 201, "POST /api/v1/variables/");
      return (await response.json()).id as string;
    },
    async () => (await sourceRows<{ id: string; name: string }>("/api/v1/variables/")).find((v) => v.name === name)?.id,
  );
  cleanups.push(async () => {
    const r = await call(() => api.request.delete(`/api/v1/variables/${variableId}`, { headers: api.headers }));
    if (!r.ok() && r.status() !== 404) throw new Error(`deleting the variable answered ${r.status()}`);
  });
  return variableId;
}

/**
 * An API key, removed after the test. A key whose creating response was lost cannot be
 * used — only that response carried its secret — so one found on the re-dial is deleted
 * and the key is made again.
 */
async function createKey(name: string): Promise<string> {
  const created = await createWithoutLeak(
    async () => {
      const response = await api.request.post("/api/v1/api_key/", { headers: api.headers, data: { name } });
      await expectStatus(response, 200, "POST /api/v1/api_key/");
      return (await response.json()) as { id: string; api_key: string };
    },
    async () => {
      const listed = await call(() => api.request.get("/api/v1/api_key/", { headers: api.headers }));
      for (const { id } of ((await listed.json()).api_keys as Array<{ id: string; name: string }>).filter((k) => k.name === name)) {
        await call(() => api.request.delete(`/api/v1/api_key/${id}`, { headers: api.headers }));
      }
      return undefined;
    },
  );
  cleanups.push(async () => {
    const r = await call(() => api.request.delete(`/api/v1/api_key/${created.id}`, { headers: api.headers }));
    if (!r.ok() && r.status() !== 404) throw new Error(`deleting the API key answered ${r.status()}`);
  });
  return created.api_key;
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

/** A browser request to one API path, by method and exact pathname. */
function postTo(pathname: string) {
  return (req: Request) => req.method() === "POST" && new URL(req.url()).pathname === pathname;
}

/** The page's answer to that request. */
function answerTo(page: Page, pathname: string) {
  return page.waitForResponse((r) => postTo(pathname)(r.request()), { timeout: 30_000 });
}

async function openMigrationPage(page: Page) {
  await page.goto("/settings/migration");
  const step = page.getByTestId("migration-step-pause");
  await expect(step).toBeVisible({ timeout: 30_000 });
  return step;
}

test.describe("Instance migration — the pause refuses every write, keeps reads and sign-in, and lifts cleanly", () => {
  test.beforeEach(async ({ request }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    resetInstanceMigration();
    cleanups = [];
    api = await migrationApi(request);
  });

  test.afterEach(async () => {
    // The reset lifts the pause: the source refuses the deletes below until it does.
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
    "the pause waits for a running flow, names it, and begins once it has ended",
    { tag: ["@instance-migration", "@settings", "@api", "@ui-ux"] },
    async ({ page }) => {
      // The 409 is the subject of this test; during the pause the page's own
      // POST /api/v1/authz/me/permissions answers 503 too (see the spec doc).
      (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();
      const id = unique();
      const waitingName = `im-pause-waits-${id}`;
      const input = `im-pause-run-${id}`;
      let waitingFlowId = "";
      let plainFlowId = "";
      let apiKey = "";

      await test.step("Setup (API): the steps before the pause, a flow that waits, a plain flow and an API key", async () => {
        await prepareBeforePause(api, lane);
        const catalog = await fetchComponentCatalog(api.request, api.headers);
        waitingFlowId = await createWithoutLeak(
          () =>
            createCatalogFlow(
              api.request,
              catalog,
              {
                nodes: [
                  { id: "ChatInput-w", type: "ChatInput" },
                  {
                    id: "CustomComponent-w",
                    type: CUSTOM_COMPONENT_TYPE,
                    configure: (c) => {
                      applyNodeSpec(c, { id: "Waits", kind: "echo", fields: ["in_text"], delayS: WAIT_SECONDS });
                    },
                  },
                  { id: "ChatOutput-w", type: "ChatOutput" },
                ],
                edges: [
                  { source: "ChatInput-w", output: "message", target: "CustomComponent-w", field: "in_text" },
                  { source: "CustomComponent-w", output: "output", target: "ChatOutput-w", field: "input_value" },
                ],
              },
              { name: waitingName, headers: api.headers },
            ),
          async () => (await sourceRows<{ id: string; name: string }>(ALL_FLOWS)).find((f) => f.name === waitingName)?.id,
        );
        cleanups.push(() => retryOnDroppedConnection(() => deleteFlow(api.request, waitingFlowId, { headers: api.headers })));
        plainFlowId = await createFlow(`im-pause-plain-${id}`);
        // /api/v1/run takes an API key; on auto-login it refuses a bearer token.
        apiKey = await createKey(`im-pause-waits-${id}`);
      });

      const pauseStep = await test.step("Open Settings > Migration on the pause step", () => openMigrationPage(page));

      const { run } = await test.step("Start a run of the waiting flow and see it in flight", async () => {
        // Not awaited here: the run is what the pause has to wait for. Settled into a
        // value so a failure surfaces where it is awaited, not as an unhandled rejection.
        const started = api.request
          .post(`/api/v1/run/${waitingFlowId}?stream=false`, {
            headers: { "x-api-key": apiKey },
            data: { input_value: input, input_type: "chat", output_type: "chat" },
            timeout: 120_000,
          })
          .then(
            (response) => ({ response, error: undefined }),
            (error: unknown) => ({ response: undefined, error }),
          );
        // The user's message is stored when the run starts (measured at ~0.3 s), so the
        // run is known to be under way before the pause is asked for.
        await expect
          .poll(
            async () => {
              const r = await call(() =>
                api.request.get(`/api/v1/monitor/messages?flow_id=${waitingFlowId}`, { headers: api.headers }),
              );
              return ((await r.json()) as Array<{ text: string }>).map((m) => m.text);
            },
            { timeout: 15_000, intervals: [250, 500, 1000] },
          )
          .toContain(input);
        // Wrapped: a promise returned on its own would be awaited by test.step, run and all.
        return { run: started };
      });

      const job = await test.step("Pause changes on the page: the server refuses with jobs_active, naming the run", async () => {
        const answer = answerTo(page, "/api/v1/migration/pause");
        await pauseStep.getByRole("button", { name: "Pause changes" }).click();
        const dialog = page.getByRole("dialog", { name: "Pause changes now?" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Pause", exact: true }).click();
        const refused = await answer;
        await expectStatus(refused, 409, "POST /api/v1/migration/pause during a run");
        const { detail } = await refused.json();
        expect(detail.code).toBe("jobs_active");
        expect(detail.jobs, "the jobs the pause waits for").toHaveLength(1);
        expect(detail.jobs[0]).toMatchObject({ flow_name: waitingName, owner: "langflow", state: "in_progress" });
        expect(detail.changes, "the requests the pause waits for").toContainEqual(
          expect.objectContaining({ kind: "request", method: "POST", path: expect.stringContaining(`/api/v1/run/${waitingFlowId}`) }),
        );
        return detail.jobs[0] as { id: string };
      });

      await test.step("The page names the run and offers Check again", async () => {
        const row = pauseStep.getByTestId(`migration-job-${job.id}`);
        await expect(row).toContainText(waitingName);
        await expect(row).toContainText("Running");
        await expect(pauseStep.getByTestId("migration-change-0")).toBeVisible();
        await expect(pauseStep.getByText(/^Still running: 1\./)).toBeVisible();
        await expect(pauseStep.getByRole("button", { name: "Check again" })).toBeVisible();
      });

      await test.step("The refused pause did not begin: the instance takes changes", async () => {
        expect(await pausedNow(), "GET /api/v1/migration/pause after the refusal").toBe(false);
        expect(await pauseStepState()).toBe("current");
        const saved = await call(() =>
          api.request.patch(`/api/v1/flows/${plainFlowId}`, { headers: api.headers, data: { name: `im-pause-plain-${id}-saved` } }),
        );
        await expectStatus(saved, 200, "PATCH a flow after the refused pause");
      });

      await test.step("Once the run has ended, Check again begins the pause", async () => {
        const ran = await run;
        expect(ran.error, "the waiting flow's run threw").toBeUndefined();
        await expectStatus(ran.response!, 200, "the waiting flow's run");
        const answer = answerTo(page, "/api/v1/migration/pause");
        await pauseStep.getByRole("button", { name: "Check again" }).click();
        await expectStatus(await answer, 200, "POST /api/v1/migration/pause after the run");
        expect(await pausedNow(), "GET /api/v1/migration/pause after Check again").toBe(true);
      });

      await test.step("The page checks the instance again during the pause, and the step is done", async () => {
        await expect(page.getByText(/Paused .+ by langflow\./)).toBeVisible({ timeout: 30_000 });
        await expect
          .poll(pauseStepState, { timeout: CHECK_TIMEOUT_MS, intervals: [1000, 3000] })
          .toBe("done");
      });
    },
  );

  test(
    "every change is refused with the reason, none of it lands, and reads and sign-in still work",
    { tag: ["@instance-migration", "@settings", "@api"] },
    async ({ request, baseURL }) => {
      const id = unique();
      const prefix = `im-pause-refused-${id}`;
      const signupName = `impausesignup${id}`;
      let flowId = "";
      let variableId = "";
      let apiKey = "";
      let user: ThrowawayUser;
      let before: { files: string[]; variables: string[]; apiKeys: string[] };

      await test.step("Setup (API): a flow, a file, a global variable, an API key and a regular user", async () => {
        flowId = await createFlow(`${prefix}-N0`);
        await uploadFile(`${prefix}-file`, Buffer.from(`instance-migration pause ${id}`));
        variableId = await createVariable(`IM_PAUSE_${id.toUpperCase()}`, `value-${id}`);
        apiKey = await createKey(`${prefix}-key`);
        user = await createRegularUser(request, baseURL, "impause");
        before = {
          files: (await sourceRows<{ id: string }>("/api/v2/files")).map((f) => f.id).sort(),
          variables: (await sourceRows<{ id: string }>("/api/v1/variables/")).map((v) => v.id).sort(),
          apiKeys: await apiKeyIds(),
        };
      });

      await test.step("Pause (API), with the check again during it", async () => {
        await prepareThroughPause(api, lane);
        expect(await pausedNow()).toBe(true);
      });

      const anonymous = await pwRequest.newContext({ baseURL });
      cleanups.push(() => anonymous.dispose());
      const headers = api.headers;
      const txt = (name: string) => ({ file: { name, mimeType: "text/plain", buffer: Buffer.from(`refused ${id}`) } });
      const surfaces: Array<[string, () => Promise<APIResponse>]> = [
        ["Save a flow: PATCH /api/v1/flows/{id}", () => request.patch(`/api/v1/flows/${flowId}`, { headers, data: { name: `${prefix}-N1` } })],
        [
          "Create a flow: POST /api/v1/flows/",
          () => request.post("/api/v1/flows/", { headers, data: { name: `${prefix}-created`, data: { nodes: [], edges: [] } } }),
        ],
        [
          "Run a flow: POST /api/v1/run/{id} with an API key",
          () =>
            request.post(`/api/v1/run/${flowId}?stream=false`, {
              headers: { "x-api-key": apiKey },
              data: { input_value: "refused", input_type: "chat", output_type: "chat" },
            }),
        ],
        ["Run a flow (v2): POST /api/v2/workflows", () => request.post("/api/v2/workflows", { headers, data: { flow_id: flowId, inputs: {} } })],
        ["Upload a file: POST /api/v2/files", () => request.post("/api/v2/files", { headers, multipart: txt(`${prefix}-refused.txt`) })],
        [
          "Upload a chat attachment: POST /api/v1/files/upload/{flow_id}",
          () => request.post(`/api/v1/files/upload/${flowId}`, { headers, multipart: txt(`${prefix}-attachment.txt`) }),
        ],
        [
          "Sign up: POST /api/v1/users/ with no session",
          () => anonymous.post("/api/v1/users/", { data: { username: signupName, password: "Signup!12345" } }),
        ],
        [
          "Create a global variable: POST /api/v1/variables/",
          () =>
            request.post("/api/v1/variables/", {
              headers,
              data: { name: `IM_PAUSE_REFUSED_${id.toUpperCase()}`, value: "x", type: "Generic", default_fields: [] },
            }),
        ],
        ["Delete a global variable: DELETE /api/v1/variables/{id}", () => request.delete(`/api/v1/variables/${variableId}`, { headers })],
        ["Create an API key: POST /api/v1/api_key/", () => request.post("/api/v1/api_key/", { headers, data: { name: `${prefix}-refused-key` } })],
      ];
      for (const [surface, send] of surfaces) {
        await test.step(`Refused with the reason — ${surface}`, async () => {
          await expectRefused(await call(send), surface);
        });
      }

      await test.step("Reads answer during the pause", async () => {
        for (const path of [ALL_FLOWS, `/api/v1/flows/${flowId}`, "/api/v2/files", "/api/v1/variables/"]) {
          await expectStatus(await call(() => request.get(path, { headers })), 200, `GET ${path}`);
        }
      });

      await test.step("None of the refused changes landed", async () => {
        const flow = await call(() => request.get(`/api/v1/flows/${flowId}`, { headers }));
        expect((await flow.json()).name, "the saved flow's name").toBe(`${prefix}-N0`);
        const flows = await sourceRows<{ id: string; name: string }>(ALL_FLOWS);
        expect(flows.filter((f) => f.name.startsWith(prefix)).map((f) => f.id), "the test's flows").toEqual([flowId]);
        expect((await sourceRows<{ id: string }>("/api/v2/files")).map((f) => f.id).sort(), "files").toEqual(before.files);
        const variables = (await sourceRows<{ id: string }>("/api/v1/variables/")).map((v) => v.id).sort();
        expect(variables, "global variables, the one DELETE asked to remove included").toEqual(before.variables);
        expect(variables).toContain(variableId);
        expect(await apiKeyIds(), "API keys").toEqual(before.apiKeys);
        expect(await usernames(), "users").not.toContain(signupName);
      });

      await test.step("A regular user signs in, refreshes, reads the pause and signs out", async () => {
        const login = await postLogin(user.request, user.username, THROWAWAY_PASSWORD);
        await expectStatus(login, 200, "POST /api/v1/login during the pause");
        const token = (await login.json()).access_token as string;
        expect(token, "the login's access token").toBeTruthy();
        await expectStatus(await call(() => user.request.post("/api/v1/refresh")), 200, "POST /api/v1/refresh during the pause");
        const pause = await call(() =>
          user.request.get("/api/v1/migration/pause", { headers: { Authorization: `Bearer ${token}` } }),
        );
        await expectStatus(pause, 200, "GET /api/v1/migration/pause as a regular user");
        expect((await pause.json()).paused).toBe(true);
        await expectStatus(await call(() => user.request.post("/api/v1/logout")), 200, "POST /api/v1/logout during the pause");
      });
    },
  );

  test(
    "a regular user who signs in during the pause is told on every page, opens their flow, and a change fails at once",
    { tag: ["@instance-migration", "@settings", "@auth", "@ui-ux"] },
    async ({ page, request, baseURL }) => {
      // The refused POST /api/v1/variables/ is the subject; the page's
      // POST /api/v1/authz/me/permissions answers 503 during the pause as well.
      (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();
      const id = unique();
      const flowName = `im-pause-regular-${id}`;
      const variableName = `IM_PAUSE_UI_${id.toUpperCase()}`;
      let user: ThrowawayUser;
      let flowId = "";

      await test.step("Setup (API): a regular user and a flow of their own", async () => {
        user = await createRegularUser(request, baseURL, "impauseui");
        const created = await user.request.post("/api/v1/flows/", {
          headers: user.headers,
          data: { name: flowName, data: { nodes: [], edges: [] } },
        });
        await expectStatus(created, 201, "POST /api/v1/flows/ as the regular user");
        flowId = (await created.json()).id;
        cleanups.push(async () => {
          const r = await call(() => user.request.delete(`/api/v1/flows/${flowId}`, { headers: user.headers }));
          if (!r.ok() && r.status() !== 404) throw new Error(`deleting the regular user's flow answered ${r.status()}`);
        });
      });

      await test.step("Pause (API), with the check again during it", async () => {
        await prepareThroughPause(api, lane);
      });

      await test.step("Sign in during the pause, as the regular user", async () => {
        // The lane runs auto-login, and the frontend would become the superuser on every
        // load. This context alone answers the way an instance with auto-login off does
        // (login.py), so the user signs in through the form; nothing asserted below
        // passes through this route.
        await page.context().route("**/api/v1/auto_login", (route) =>
          route.fulfill({ status: 403, json: { detail: { message: "Auto login is disabled.", auto_login: false } } }),
        );
        const whoami = page.waitForResponse(
          (r) => new URL(r.url()).pathname === "/api/v1/users/whoami" && r.status() === 200,
          { timeout: 30_000 },
        );
        await page.goto("/login");
        expect(await signInThroughForm(page, user.username, THROWAWAY_PASSWORD), "POST /api/v1/login").toBe(200);
        expect(await (await whoami).json()).toMatchObject({ username: user.username, is_superuser: false });
      });

      const notice = page.getByRole("status").filter({ hasText: NOTICE });
      for (const path of ["/", "/settings/general", "/settings/global-variables"]) {
        await test.step(`The pause notice is shown on ${path}`, async () => {
          await page.goto(path);
          await expect(notice).toBeVisible({ timeout: 30_000 });
          await expect(page, "still signed in").not.toHaveURL(/\/login/);
        });
      }

      await test.step("The user's flow opens on the canvas, with the pause notice", async () => {
        await page.goto(`/flow/${flowId}`);
        await expect(page.getByTestId("flow_name")).toHaveText(flowName, { timeout: 30_000 });
        await expect(notice).toBeVisible();
      });

      await test.step("Back on Settings > Global Variables", async () => {
        await page.goto("/settings/global-variables");
        await expect(notice).toBeVisible({ timeout: 30_000 });
      });

      await test.step("Adding a global variable fails at once with the server's reason, after one request", async () => {
        const posts: Request[] = [];
        page.on("request", (r) => {
          if (postTo("/api/v1/variables/")(r)) posts.push(r);
        });
        const answer = answerTo(page, "/api/v1/variables/");
        await page.getByTestId("api-key-button-store").click(); // "Add New"
        await page.getByPlaceholder("Enter a name for the variable...").fill(variableName);
        await page.getByPlaceholder("Enter a value for the variable...").fill(`value-${id}`);
        await page.getByTestId("save-variable-btn").click();
        await expectRefused(await answer, "POST /api/v1/variables/ from the page");
        await expect(page.getByText(REFUSAL).first()).toBeVisible({ timeout: 5_000 });
        // An ordinary 5xx is retried after 1 s (request-processor.ts); this refusal must
        // not be. Three seconds covers that first retry with room to spare.
        await page.waitForTimeout(3_000);
        expect(posts, "POST /api/v1/variables/ requests the page sent").toHaveLength(1);
        const listed = await call(() => user.request.get("/api/v1/variables/", { headers: user.headers }));
        await expectStatus(listed, 200, "GET /api/v1/variables/ as the regular user");
        expect(((await listed.json()) as Array<{ name: string }>).map((v) => v.name)).not.toContain(variableName);
      });
    },
  );

  test(
    "a restart keeps the pause, and turning changes back on lets the refused save through and loses nothing",
    { tag: ["@instance-migration", "@settings", "@api", "@database"] },
    async ({ request }) => {
      const id = unique();
      const n0 = `im-pause-restart-${id}-N0`;
      const n1 = `im-pause-restart-${id}-N1`;
      const description = `im-pause-restart sentinel ${id}`;
      const bytes = Buffer.from(`instance-migration pause restart ${id}`);
      const variableName = `IM_PAUSE_RESTART_${id.toUpperCase()}`;
      let flowId = "";
      let fileId = "";
      let variableId = "";
      let frozenAt = "";
      const rename = () =>
        call(() => request.patch(`/api/v1/flows/${flowId}`, { headers: api.headers, data: { name: n1 } }));

      await test.step("Setup (API): a flow with a sentinel description, a file and a global variable", async () => {
        flowId = await createFlow(n0, description);
        fileId = await uploadFile(`im-pause-restart-${id}`, bytes);
        variableId = await createVariable(variableName, `value-${id}`);
      });

      await test.step("Pause (API): the rename is refused", async () => {
        await prepareThroughPause(api, lane);
        frozenAt = (await getMigration(api)).record.pause?.frozen_at;
        expect(frozenAt, "the record's pause.frozen_at").toBeTruthy();
        await expectRefused(await rename(), "PATCH the flow's name during the pause");
      });

      await test.step("Restart the source container", async () => {
        execFileSync("docker", ["restart", lane.containers.source], { stdio: "ignore", timeout: 180_000 });
        await expect
          .poll(
            async () => {
              try {
                return (await request.get("/api/v1/version", { timeout: 5_000 })).status();
              } catch {
                return 0;
              }
            },
            { timeout: 180_000, intervals: [1000, 3000] },
          )
          .toBe(200);
        api = await migrationApi(request);
      });

      await test.step("Still paused after the restart, from the same moment", async () => {
        expect(await pausedNow(), "GET /api/v1/migration/pause after the restart").toBe(true);
        await expectRefused(await rename(), "PATCH the flow's name after the restart");
        expect((await getMigration(api)).record.pause?.frozen_at, "the record's pause.frozen_at").toBe(frozenAt);
      });

      await test.step("Turn changes back on (API)", async () => {
        await expectStatus(await call(() => request.delete("/api/v1/migration/pause", { headers: api.headers })), 200, "DELETE /api/v1/migration/pause");
        expect(await pausedNow(), "GET /api/v1/migration/pause after the resume").toBe(false);
        expect(await pauseStepState()).toBe("current");
      });

      await test.step("The refused rename now goes through", async () => {
        await expectStatus(await rename(), 200, "PATCH the flow's name after the resume");
        const flow = await call(() => request.get(`/api/v1/flows/${flowId}`, { headers: api.headers }));
        expect((await flow.json()).name).toBe(n1);
      });

      await test.step("Nothing written before the pause was lost", async () => {
        const flow = await call(() => request.get(`/api/v1/flows/${flowId}`, { headers: api.headers }));
        expect((await flow.json()).description, "the flow's description").toBe(description);
        const file = await call(() => request.get(`/api/v2/files/${fileId}`, { headers: api.headers }));
        await expectStatus(file, 200, `GET /api/v2/files/${fileId}`);
        expect((await file.body()).equals(bytes), "the file's bytes").toBe(true);
        const variables = await sourceRows<{ id: string; name: string }>("/api/v1/variables/");
        expect(variables.find((v) => v.id === variableId)?.name, "the global variable").toBe(variableName);
      });
    },
  );
});
