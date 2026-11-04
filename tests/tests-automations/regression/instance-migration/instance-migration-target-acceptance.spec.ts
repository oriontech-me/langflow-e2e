import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { createWithoutLeak } from "../../../helpers/api/create-without-leak";
import { retryOnDroppedConnection } from "../../../helpers/api/retry-on-dropped-connection";
import {
  createCredentialConsumerFlowViaApi,
  RESOLVED_LEN_PREFIX,
} from "../../../helpers/flows/create-credential-consumer-flow-via-api";
import {
  instanceMigrationLane,
  resetInstanceMigration,
} from "../../../helpers/instance-migration/instance-migration-lane";
import {
  getMigration,
  type MigrationApi,
  migrationApi,
  readyToCopy,
  runStep,
  stepOf,
} from "../../../helpers/instance-migration/migration-walk";
import {
  fillStartSettings,
  parseSettingsText,
  removeNewInstance,
  type StartSetting,
  startNewInstance,
  waitForNewInstance,
} from "../../../helpers/instance-migration/target-instance";

// Spec doc: docs/instance-migration/instance-migration-target-acceptance.md
// Lane: PW_INSTANCE_MIGRATION=1, against ./scripts/start-langflow-instance-migration.sh
//
// A migration's copy steps succeed on the SOURCE; nothing proves the move until a
// Langflow starts on the copy and serves it. Test 1 starts that new instance from the
// settings "Start the new instance" prints and checks it against the user doc's own
// acceptance list. Every assertion reads a surface that FAILS on a target started
// wrong — measured: a wrong secret key, missing storage settings or a missing pgvector
// string still let a user sign in, list the variable, list the knowledge base and export
// the flow, so none of those is offered as proof. Test 2 is the way back: turning changes
// back on before the start leaves the source writable and untouched.
//
// The walk to the start step is #2353's, through the API. Every test starts and ends with
// the lane's reset; the new instance is removed before it, because it holds connections to
// the database the reset drops. What a test adds to the SOURCE it removes itself.
//
// No @stable — no scheduled @instance-migration lane exists (#1010).

const lane = instanceMigrationLane();
// The walk measured ~2 min idle; on a loaded machine the database copy alone took ~6.5 min
// and the new instance took up to ~9.5 min to answer. The budgets are for the second case.
const TEST_TIMEOUT_MS = 30 * 60_000;
const NEW_INSTANCE_BOOT_MS = 12 * 60_000;
const SEED_CHUNK = { id: "seed-001", content: "instance-migration seed chunk 1" };
const ALL_FLOWS = "/api/v1/flows/?get_all=true&header_flows=true";

let api: MigrationApi;
/** What a test added to the source, removed after the reset. Run in reverse order. */
let cleanups: (() => Promise<void>)[] = [];

function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function expectStatus(response: { status(): number; text(): Promise<string> }, status: number, what: string) {
  expect(response.status(), `${what}: ${(await response.text()).slice(0, 300)}`).toBe(status);
}

/**
 * A read, re-dialled once if its pooled socket was closed under it. Reads follow page
 * steps and container waits here, so an idle gap at the server's 2 s keep-alive edge is
 * not something the test controls (tests/helpers/api/retry-on-dropped-connection.ts).
 */
async function get(request: APIRequestContext, url: string, headers: Record<string, string>, timeout?: number) {
  return retryOnDroppedConnection(() => request.get(url, { headers, timeout }));
}

/** A source listing's rows. */
async function sourceRows<T>(path: string): Promise<T[]> {
  const response = await get(api.request, path, api.headers);
  await expectStatus(response, 200, `GET ${path}`);
  return response.json();
}

async function sourceUsers(): Promise<Array<{ id: string; username: string; is_active: boolean }>> {
  const response = await get(api.request, "/api/v1/users/?limit=100", api.headers);
  await expectStatus(response, 200, "GET /api/v1/users/");
  return (await response.json()).users;
}

/** The bearer header of an instance's auto-login: the source or the new instance. */
async function autoLogin(request: APIRequestContext, base: string): Promise<Record<string, string>> {
  const response = await get(request, `${base}/api/v1/auto_login`, {});
  await expectStatus(response, 200, `GET ${base}/api/v1/auto_login`);
  return { Authorization: `Bearer ${(await response.json()).access_token}` };
}

/** The seed file's id on the source, by the name the start script gave it. */
async function seedFileId(): Promise<string> {
  const file = (await sourceRows<{ id: string; name: string }>("/api/v2/files")).find((f) => f.name === lane.seed.fileName);
  expect(file, `the seed file '${lane.seed.fileName}' on the source`).toBeDefined();
  return file!.id;
}

/** Everything a migration copies, as the source's API lists it, in a stable order. */
async function sourceListing(): Promise<Record<string, unknown>> {
  const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const flows = await sourceRows<{ id: string; name: string }>(ALL_FLOWS);
  const variables = await sourceRows<{ id: string; name: string; type: string }>("/api/v1/variables/");
  const files = await sourceRows<{ id: string; name: string; size: number }>("/api/v2/files");
  const kbs = await sourceRows<Record<string, unknown> & { id: string }>("/api/v1/knowledge_bases/");
  const users = await sourceUsers();
  return {
    flows: byId(flows.map(({ id, name }) => ({ id, name }))),
    variables: byId(variables.map(({ id, name, type }) => ({ id, name, type }))),
    files: byId(files.map(({ id, name, size }) => ({ id, name, size }))),
    knowledgeBases: byId(
      kbs.map(({ id, name, chunks, backend_type, storage_state }) => ({ id, name, chunks, backend_type, storage_state })),
    ),
    users: byId(users.map(({ id, username, is_active }) => ({ id, username, is_active }))),
  };
}

/** Every step from the backup on, through "Check the copy": the start step is then the current one. */
async function migrateEverything(): Promise<void> {
  await readyToCopy(api, lane, { location: `e2e target acceptance ${unique()}` });
  for (const runStepId of ["copy_database", "copy_knowledge_bases", "copy_files", "check_target"] as const) {
    await runStep(api, runStepId);
  }
  expect(stepOf(await getMigration(api), "start_target").state).toBe("current");
}

async function openMigrationPage(page: Page): Promise<void> {
  await page.goto("/settings/migration");
  await expect(page.getByTestId("migration-step-start_target")).toBeVisible({ timeout: 30_000 });
}

test.describe("Instance migration — the new instance serves the copy, and turning changes back on loses nothing", () => {
  test.beforeEach(async ({ request }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    removeNewInstance(lane);
    resetInstanceMigration();
    cleanups = [];
    api = await migrationApi(request);
  });

  test.afterEach(async () => {
    // The new instance first: it holds connections to the database the reset drops.
    removeNewInstance(lane);
    // The reset lifts the pause: the source refuses writes until it does.
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
    "the new instance started from the printed settings serves the copied users, credential, flow, knowledge base and files",
    { tag: ["@instance-migration", "@settings", "@database", "@files"] },
    async ({ page, request }) => {
      const id = unique();
      const secret = `e2e-im-target-credential-${id}`;
      const variableName = `IM_TARGET_CREDENTIAL_${id}`;
      const username = `im-target-user-${id}`;
      const password = `im-target-password-${id}`;
      const attachmentName = `im-target-attachment-${id}.txt`;
      let flowId = "";
      let nodeId = "";
      let flowName = "";
      let apiKey = "";
      /** The attachment as stored: the server prefixes a timestamp to the uploaded name. */
      let storedName = "";
      let fileId = "";
      const sourceBytes: { file?: Buffer; attachment?: Buffer } = {};

      await test.step("Setup on the source (API): a credential, a user, a flow that reads the credential, an API key, an attachment", async () => {
        // Each creating POST goes through createWithoutLeak: a pooled socket can be closed by
        // the server at the instant it is reused (a 2 s keep-alive), and measured, this setup's
        // flow POST died of it in 1 of 5 runs. A blind retry could create a second copy.
        const variableId = await createWithoutLeak(
          async () => {
            const variable = await api.request.post("/api/v1/variables/", {
              headers: api.headers,
              data: { name: variableName, value: secret, type: "Credential", default_fields: [] },
            });
            await expectStatus(variable, 201, "POST /api/v1/variables/");
            return (await variable.json()).id as string;
          },
          async () => (await sourceRows<{ id: string; name: string }>("/api/v1/variables/")).find((v) => v.name === variableName)?.id,
        );
        cleanups.push(async () => {
          const r = await api.request.delete(`/api/v1/variables/${variableId}`, { headers: api.headers });
          if (r.status() !== 204) throw new Error(`deleting the variable answered ${r.status()}`);
        });

        const userId = await createWithoutLeak(
          async () => {
            const user = await api.request.post("/api/v1/users/", { headers: api.headers, data: { username, password } });
            await expectStatus(user, 201, "POST /api/v1/users/");
            return (await user.json()).id as string;
          },
          async () => (await sourceUsers()).find((u) => u.username === username)?.id,
        );
        cleanups.push(async () => {
          const r = await api.request.delete(`/api/v1/users/${userId}`, { headers: api.headers });
          if (![200, 202, 204].includes(r.status())) throw new Error(`deleting the user answered ${r.status()}`);
          // The delete is asynchronous (202): wait it out, so the next test's listing of the
          // source cannot catch this user halfway gone.
          await expect
            .poll(
              async () => (await sourceUsers()).some((u) => u.id === userId),
              { timeout: 60_000, message: "the user created on the source is still listed" },
            )
            .toBe(false);
        });
        await expectStatus(
          await retryOnDroppedConnection(() =>
            api.request.patch(`/api/v1/users/${userId}`, { headers: api.headers, data: { is_active: true } }),
          ),
          200,
          "activating the user",
        );

        const flowsBefore = new Set((await sourceRows<{ id: string }>(ALL_FLOWS)).map((f) => f.id));
        const flow = await createWithoutLeak(
          () => createCredentialConsumerFlowViaApi(api.request, api.headers, [{ fieldName: "gateway_pin", variableName }]),
          async () => {
            // The helper names the flow itself, so what the dropped attempt created is found
            // by difference — and removed, because its handle went down with the response.
            for (const { id: leaked } of (await sourceRows<{ id: string }>(ALL_FLOWS)).filter((f) => !flowsBefore.has(f.id))) {
              await retryOnDroppedConnection(() => api.request.delete(`/api/v1/flows/${leaked}`, { headers: api.headers }));
            }
            return undefined;
          },
        );
        flowId = flow.flowId;
        nodeId = flow.fields[0].nodeId;
        cleanups.push(() => flow.deleteFlow());
        const stored = await retryOnDroppedConnection(() => api.request.get(`/api/v1/flows/${flowId}`, { headers: api.headers }));
        await expectStatus(stored, 200, "GET the flow");
        flowName = (await stored.json()).name;

        const keyName = `im-target-${id}`;
        const created = await createWithoutLeak(
          async () => {
            const key = await api.request.post("/api/v1/api_key/", { headers: api.headers, data: { name: keyName } });
            await expectStatus(key, 200, "POST /api/v1/api_key/");
            return (await key.json()) as { id: string; api_key: string };
          },
          async () => {
            // The key's secret travels only in the create response, so a key that landed with
            // its response lost is useless: remove it and create another.
            const listed = await retryOnDroppedConnection(() => api.request.get("/api/v1/api_key/", { headers: api.headers }));
            for (const { id: leaked } of ((await listed.json()).api_keys as Array<{ id: string; name: string }>).filter(
              (k) => k.name === keyName,
            )) {
              await retryOnDroppedConnection(() => api.request.delete(`/api/v1/api_key/${leaked}`, { headers: api.headers }));
            }
            return undefined;
          },
        );
        apiKey = created.api_key;
        cleanups.push(async () => {
          const r = await api.request.delete(`/api/v1/api_key/${created.id}`, { headers: api.headers });
          if (r.status() !== 200) throw new Error(`deleting the API key answered ${r.status()}`);
        });

        storedName = await createWithoutLeak(
          async () => {
            const upload = await api.request.post(`/api/v1/files/upload/${flowId}`, {
              headers: api.headers,
              multipart: {
                file: { name: attachmentName, mimeType: "text/plain", buffer: Buffer.from(`instance-migration target attachment ${id}\n`) },
              },
            });
            await expectStatus(upload, 201, "uploading the chat attachment");
            // `<namespace>/<timestamp>_<name>`. The namespace measured `<flowId>` on 1.14.0.dev14
            // and `flow-<flowId>` on dev16 (langflow-ai/langflow#15982, LE-3242), and every route
            // below takes the flow id and resolves it — so this spec addresses the attachment by
            // flow id and stored name, and leaves the layout to the files specs (#2338).
            const filePath = (await upload.json()).file_path as string;
            expect(filePath, "the stored attachment's path").toMatch(new RegExp(`/[^/]+_${attachmentName.replace(/\./g, "\\.")}$`));
            return filePath.slice(filePath.lastIndexOf("/") + 1);
          },
          async () => {
            // The server prefixes the name with a timestamp; the name itself is the run's.
            const listed = await retryOnDroppedConnection(() => api.request.get(`/api/v1/files/list/${flowId}`, { headers: api.headers }));
            return ((await listed.json()).files as string[]).find((f) => f.endsWith(`_${attachmentName}`));
          },
        );
        cleanups.push(async () => {
          const r = await api.request.delete(`/api/v1/files/delete/${flowId}/${storedName}`, { headers: api.headers });
          if (r.status() !== 200) throw new Error(`deleting the attachment answered ${r.status()}`);
        });
      });

      await test.step("Baseline on the source: the flow reads the credential, and both files download", async () => {
        const run = await retryOnDroppedConnection(() =>
          request.post(`/api/v1/run/${flowId}`, {
            headers: { "x-api-key": apiKey },
            data: { input_value: "probe", input_type: "text", output_type: "debug" },
          }),
        );
        await expectStatus(run, 200, "running the flow on the source");
        expect(await vertexText(run, nodeId)).toBe(`${RESOLVED_LEN_PREFIX}${secret.length}`);

        fileId = await seedFileId();
        const file = await get(api.request, `/api/v2/files/${fileId}`, api.headers);
        await expectStatus(file, 200, "downloading the seed file from the source");
        sourceBytes.file = await file.body();
        const attachment = await get(api.request, `/api/v1/files/download/${flowId}/${storedName}`, api.headers);
        await expectStatus(attachment, 200, "downloading the attachment from the source");
        sourceBytes.attachment = await attachment.body();
        expect(sourceBytes.file.length, "the seed file is not empty").toBeGreaterThan(0);
      });

      await test.step("Walk (API): backup, the three copies and Check the copy", async () => {
        await migrateEverything();
      });

      let printed: StartSetting[] = [];

      await test.step("Read the settings from the page: they are the API's, and five placeholders hold the secrets", async () => {
        printed = (await getMigration(api)).start.settings;
        await openMigrationPage(page);
        const start = page.getByTestId("migration-step-start_target");
        await start.getByRole("button", { name: "Show the settings" }).click();
        await page.getByRole("dialog", { name: "Start the new instance?" }).getByRole("button", { name: "Continue" }).click();
        const shown = page.getByTestId("migration-start-settings");
        await expect(shown).toContainText("LANGFLOW_SECRET_KEY=<secret key>");
        expect(parseSettingsText(await shown.innerText())).toEqual(printed.map(({ name, value }) => ({ name, value })));
        const placeholders = printed.flatMap(({ value }) => value.match(/<[^<>]+>/g) ?? []);
        expect([...new Set(placeholders)].sort()).toEqual(
          ["<access key id>", "<password>", "<secret access key>", "<secret key>", "<user>"].sort(),
        );
      });

      await test.step("Start the new instance from those settings, filled in", async () => {
        startNewInstance(lane, fillStartSettings(printed, lane));
        const version = await waitForNewInstance(request, lane, { timeoutMs: NEW_INSTANCE_BOOT_MS });
        const source = await (await retryOnDroppedConnection(() => request.get("/api/v1/version"))).json();
        expect(version.version, "the new instance runs the source's version").toBe(source.version);
      });

      const target = lane.newInstance.url;

      await test.step("Sign in: the source's user signs in with its password, and a wrong one is refused", async () => {
        // Signing in creates nothing, so a dropped connection is simply re-dialled.
        const login = await retryOnDroppedConnection(() => request.post(`${target}/api/v1/login`, { form: { username, password } }));
        await expectStatus(login, 200, "signing the source's user in on the new instance");
        const token = (await login.json()).access_token as string;
        const me = await get(request, `${target}/api/v1/users/whoami`, { Authorization: `Bearer ${token}` });
        await expectStatus(me, 200, "GET whoami on the new instance");
        expect((await me.json()).username).toBe(username);
        const wrong = await retryOnDroppedConnection(() =>
          request.post(`${target}/api/v1/login`, { form: { username, password: `${password}-wrong` } }),
        );
        expect(wrong.status(), "a wrong password on the new instance").toBe(401);
      });

      await test.step("The flow opens on the new instance's canvas, by the source's id", async () => {
        await page.goto(`${target}/flow/${flowId}`);
        await expect(page.getByTestId(`${nodeId}-main-node`)).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId("flow_name")).toHaveText(flowName);
      });

      await test.step("The credential decrypts into the component, and the flow runs, with the migrated API key", async () => {
        // The run comes after a page step of several seconds, the gap a pooled socket dies in.
        const run = await retryOnDroppedConnection(() =>
          request.post(`${target}/api/v1/run/${flowId}`, {
            headers: { "x-api-key": apiKey },
            data: { input_value: "probe", input_type: "text", output_type: "debug" },
          }),
        );
        await expectStatus(run, 200, "running the flow on the new instance");
        // A credential that did not decrypt reaches the component EMPTY, and the run still
        // answers 200 (measured: resolved_len=0). Only the length tells them apart.
        expect(await vertexText(run, nodeId), "the credential as the component received it").toBe(
          `${RESOLVED_LEN_PREFIX}${secret.length}`,
        );
      });

      const targetAuth = await autoLogin(request, target);

      await test.step("The knowledge base answers from pgvector with the seeded chunk", async () => {
        const list = await get(request, `${target}/api/v1/knowledge_bases/`, targetAuth);
        await expectStatus(list, 200, "GET /knowledge_bases/ on the new instance");
        const kb = ((await list.json()) as Array<{ name: string; backend_type: string }>).find(
          (k) => k.name === lane.seed.knowledgeBaseName,
        );
        expect(kb?.backend_type, "where the new instance keeps the seed knowledge base").toBe("postgres");
        const chunks = await get(
          request,
          `${target}/api/v1/knowledge_bases/${lane.seed.knowledgeBaseName}/chunks?search=${encodeURIComponent("seed chunk 1")}`,
          targetAuth,
        );
        await expectStatus(chunks, 200, "reading the seed knowledge base's chunks on the new instance");
        const body = (await chunks.json()) as { total: number; chunks: Array<{ id: string; content: string }> };
        expect(body.total).toBe(1);
        expect(body.chunks.map(({ id, content }) => ({ id, content }))).toEqual([SEED_CHUNK]);
      });

      await test.step("The uploaded file and the chat attachment download with the source's bytes, read from S3", async () => {
        // The first S3 read of a new instance measured ~2 min on a loaded machine (the client is built cold).
        const file = await get(request, `${target}/api/v2/files/${fileId}`, targetAuth, 180_000);
        await expectStatus(file, 200, "downloading the seed file from the new instance");
        expect((await file.body()).equals(sourceBytes.file!), "the seed file's bytes on the new instance").toBe(true);
        const attachment = await get(request, `${target}/api/v1/files/download/${flowId}/${storedName}`, targetAuth, 180_000);
        await expectStatus(attachment, 200, "downloading the attachment from the new instance");
        expect((await attachment.body()).equals(sourceBytes.attachment!), "the attachment's bytes on the new instance").toBe(true);
      });
    },
  );

  test(
    "turning changes back on before the start leaves this instance writable, with its data unchanged",
    { tag: ["@instance-migration", "@settings", "@database", "@files"] },
    async ({ page }) => {
      let before: Record<string, unknown> = {};
      let seedBytes: Buffer = Buffer.alloc(0);
      let fileId = "";

      await test.step("Before: what the source holds", async () => {
        before = await sourceListing();
        fileId = await seedFileId();
        const file = await get(api.request, `/api/v2/files/${fileId}`, api.headers);
        await expectStatus(file, 200, "downloading the seed file");
        seedBytes = await file.body();
      });

      await test.step("Walk (API) to the last step before the start; writes are refused", async () => {
        await migrateEverything();
        // Refused, so nothing can leak: a dropped connection is simply re-dialled.
        const write = await retryOnDroppedConnection(() =>
          api.request.post("/api/v1/variables/", {
            headers: api.headers,
            data: { name: `IM_PROBE_PAUSED_${unique()}`, value: "x", type: "Generic", default_fields: [] },
          }),
        );
        expect(write.status(), "a write while changes are paused").toBe(503);
      });

      await test.step("Turn changes back on, from the banner, and confirm", async () => {
        await openMigrationPage(page);
        const banner = page.getByRole("status").filter({ hasText: "Changes are paused on this instance." });
        await expect(banner).toBeVisible();
        await banner.getByRole("button", { name: "Turn changes back on" }).click();
        const dialog = page.getByRole("dialog", { name: "Turn changes back on?" });
        await expect(dialog).toContainText("The backup and any copies made so far become out of date");
        await dialog.getByRole("button", { name: "Resume" }).click();
        await expect(banner).toHaveCount(0);
      });

      await test.step("The source is writable again, and the migration is back at the pause", async () => {
        const { steps } = await retryOnDroppedConnection(() => getMigration(api));
        expect(steps.find((s) => s.id === "pause")?.state).toBe("current");
        const after = steps.slice(steps.findIndex((s) => s.id === "pause") + 1);
        expect(after.map((s) => `${s.id}: ${s.state}`)).toEqual(after.map((s) => `${s.id}: locked`));
        const probe = `IM_PROBE_RESUMED_${unique()}`;
        const probeId = await createWithoutLeak(
          async () => {
            const write = await api.request.post("/api/v1/variables/", {
              headers: api.headers,
              data: { name: probe, value: "x", type: "Generic", default_fields: [] },
            });
            await expectStatus(write, 201, "a write after turning changes back on");
            return (await write.json()).id as string;
          },
          async () => (await sourceRows<{ id: string; name: string }>("/api/v1/variables/")).find((v) => v.name === probe)?.id,
        );
        const removed = await retryOnDroppedConnection(() =>
          api.request.delete(`/api/v1/variables/${probeId}`, { headers: api.headers }),
        );
        expect(removed.status(), "removing the probe variable").toBe(204);
      });

      await test.step("Nothing on the source changed: listing, knowledge base and file", async () => {
        expect(await sourceListing()).toEqual(before);
        const chunks = await get(
          api.request,
          `/api/v1/knowledge_bases/${lane.seed.knowledgeBaseName}/chunks?search=${encodeURIComponent("seed chunk 1")}`,
          api.headers,
        );
        await expectStatus(chunks, 200, "reading the seed knowledge base on the source");
        const body = (await chunks.json()) as { chunks: Array<{ id: string; content: string }> };
        expect(body.chunks.map(({ id, content }) => ({ id, content }))).toEqual([SEED_CHUNK]);
        const file = await get(api.request, `/api/v2/files/${fileId}`, api.headers);
        await expectStatus(file, 200, "downloading the seed file after resuming");
        expect((await file.body()).equals(seedBytes), "the seed file's bytes after resuming").toBe(true);
      });
    },
  );
});

/** The text one vertex of an `output_type: "debug"` run produced, by node id. */
async function vertexText(run: { json(): Promise<unknown> }, nodeId: string): Promise<string | undefined> {
  const body = (await run.json()) as {
    outputs?: Array<{ outputs?: Array<{ component_id?: string; outputs?: { output?: { message?: string } } }> }>;
  };
  return (body.outputs ?? [])
    .flatMap((group) => group.outputs ?? [])
    .find((vertex) => vertex.component_id === nodeId)?.outputs?.output?.message;
}
