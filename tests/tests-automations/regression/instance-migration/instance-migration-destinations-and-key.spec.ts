import { execFileSync, spawnSync } from "node:child_process";
import type { APIRequestContext, Locator, Page, Response } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { retryOnDroppedConnection } from "../../../helpers/api/retry-on-dropped-connection";
import {
  instanceMigrationLane,
  resetInstanceMigration,
} from "../../../helpers/instance-migration/instance-migration-lane";
import {
  followRun,
  getMigration,
  type MigrationApi,
  migrationApi,
  readyToCopy,
  type RunStepId,
  runSourceChecks,
  startRun,
  stepOf,
  type StepId,
  targetSql,
} from "../../../helpers/instance-migration/migration-walk";

// Spec doc: docs/instance-migration/instance-migration-destinations-and-key.md
// Lane: PW_INSTANCE_MIGRATION=1, against ./scripts/start-langflow-instance-migration.sh
//
// "Where your data goes" is given a database password and S3 keys, which the server holds
// only in the memory of the worker that saved them. "Hand over the secret key" proves the
// new instance holds LANGFLOW_SECRET_KEY through a 12-character fingerprint, so the key never
// enters the page. Test 1 checks that each destination failure names its cause. Test 2
// searches everything the server answers or writes for the lane's planted secrets and the
// fingerprint. Test 3 restarts the source: the secrets are asked for again, never replayed.
// Test 4 walks the secret key step.
//
// Every test starts and ends with the lane's reset. The reset does not forget the secrets
// the worker holds, so each test saves its own destinations before relying on them.
//
// No @stable — no scheduled @instance-migration lane exists (#1010).

const lane = instanceMigrationLane();
// Each test pays one or two source checks (~20 s idle, up to ~95 s measured on a loaded
// host), and tests 2 and 3 run copies (the database copy measured ~6.5 min under load).
const TEST_TIMEOUT_MS = 25 * 60_000;
const MIGRATION = "/api/v1/migration";
const target = new URL(lane.target.databaseUrl);
/** Where the record says the lane's database is: host, port and name, never the user or the password. */
const TARGET_LOCATION = `${target.hostname}:${target.port}${target.pathname}`;
const SUMMARY = `Database: ${TARGET_LOCATION} · Knowledge bases: PostgreSQL · Files: ${lane.target.bucket}`;
const ENTER_AGAIN =
  "Langflow no longer holds the passwords and keys of the new instance. If it runs more than one worker, restart it with one worker. Then enter them again in 'Where your data goes'.";
const MISMATCH =
  "This doesn't match this instance's key. Paste all 12 characters as printed. If it still doesn't match, the new instance has a different or empty key.";

let api: MigrationApi;
/** What a test added, removed after the reset. Run in reverse order. */
let cleanups: (() => Promise<void> | void)[] = [];

function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function expectStatus(response: { status(): number; text(): Promise<string> }, status: number, what: string) {
  expect(response.status(), `${what}: ${(await response.text()).slice(0, 300)}`).toBe(status);
}

/** A request re-dialled once if its pooled socket was closed under it (tests/helpers/api/retry-on-dropped-connection.ts). */
function call<T>(request: () => Promise<T>): Promise<T> {
  return retryOnDroppedConnection(request);
}

/** The lane's destinations, with any part replaced. */
function destinations(over: { database_url?: string; files?: Record<string, unknown> } = {}) {
  return {
    database_url: over.database_url ?? lane.target.databaseUrl,
    vectors: { kind: "pgvector" },
    files: {
      bucket: lane.target.bucket,
      prefix: "langflow",
      access_key_id: lane.target.accessKeyId,
      secret_access_key: lane.target.secretAccessKey,
      endpoint_url: lane.target.s3Endpoint,
      ...over.files,
    },
  };
}

/** The lane's database address with another password. */
function withPassword(password: string): string {
  const url = new URL(lane.target.databaseUrl);
  url.password = password;
  return url.toString();
}

interface Saved {
  text: string;
  results: Record<string, { ok: boolean; code?: string; reason?: string }>;
}

/** `PUT /destinations` through the API. It answers 200 whatever the tests found; the verdict is in `results`. */
async function putDestinations(request: APIRequestContext, data: unknown, what: string): Promise<Saved> {
  const response = await call(() => request.put(`${MIGRATION}/destinations`, { headers: api.headers, data, timeout: 60_000 }));
  await expectStatus(response, 200, `PUT /destinations — ${what}`);
  const text = await response.text();
  return { text, results: JSON.parse(text).results };
}

async function stepState(id: StepId): Promise<string> {
  const step = stepOf(await call(() => getMigration(api)), id);
  return step.reason ? `${step.state} (${step.reason})` : step.state;
}

async function savedDestinations(): Promise<Record<string, any>> {
  return (await call(() => getMigration(api))).record.destinations;
}

/** Settings > Migration, once the page's own requests have settled: a form filled earlier can lose its submit (measured). */
async function openMigration(page: Page): Promise<void> {
  await page.goto("/settings/migration");
  await expect(page.getByTestId("migration-step-connect_target")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

async function fillDestinations(step: Locator, databaseUrl: string): Promise<void> {
  const field = (name: string) => step.locator(`#migration-destination-${name}`);
  await field("database_url").fill(databaseUrl);
  await field("bucket").fill(lane.target.bucket);
  await field("prefix").fill("langflow");
  await field("access_key_id").fill(lane.target.accessKeyId);
  await field("secret_access_key").fill(lane.target.secretAccessKey);
  await field("endpoint_url").fill(lane.target.s3Endpoint);
}

/** "Test and save" on the page, and the server's answer to the page's own `PUT`. */
async function saveOnPage(page: Page, step: Locator): Promise<Saved> {
  const answer = page.waitForResponse(
    (r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `${MIGRATION}/destinations`,
    { timeout: 60_000 },
  );
  await step.getByRole("button", { name: "Test and save" }).click();
  const response = await answer;
  await expectStatus(response, 200, "the page's PUT /destinations");
  const text = await response.text();
  return { text, results: JSON.parse(text).results };
}

/** Each API answer a page receives, as raw text, read as it arrives. */
function captureResponses(page: Page): () => Promise<string[]> {
  const reads: Promise<string>[] = [];
  page.on("response", (response: Response) => {
    if (!new URL(response.url()).pathname.startsWith("/api/")) return;
    reads.push(response.text().then((body) => `${response.url()}\n${body}`, () => ""));
  });
  return async () => (await Promise.all(reads)).filter(Boolean);
}

/** The planted values found in a text, as a list: an empty one is the pass. */
function plantedIn(text: string, planted: string[]): string[] {
  return planted.filter((value) => text.includes(value));
}

/** A run's events, as the raw text the server sent, read to their end whatever the outcome. */
async function runEventsText(request: APIRequestContext, step: RunStepId): Promise<string> {
  const started = await startRun(api, step);
  await expectStatus(started, 202, `starting ${step}`);
  const { run_id: runId } = await started.json();
  const events = await request.get(`${MIGRATION}/steps/${step}/runs/${runId}/events`, { headers: api.headers, timeout: 600_000 });
  await expectStatus(events, 200, `GET the events of ${step}`);
  const text = await events.text();
  expect(text, `the events of ${step} end`).toContain('"event": "end"');
  return text;
}

function restartSource(): void {
  execFileSync("docker", ["restart", lane.containers.source], { stdio: "ignore", timeout: 180_000 });
}

async function waitForSource(request: APIRequestContext): Promise<void> {
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
}

test.describe("Instance migration — destinations and the secret key name every failure and never leak a secret", () => {
  test.beforeEach(async ({ request }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    resetInstanceMigration();
    cleanups = [];
    api = await migrationApi(request);
  });

  test.afterEach(async () => {
    resetInstanceMigration();
    const errors: string[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (errors.length > 0) throw new Error(`cleanup left data behind:\n${errors.join("\n")}`);
  });

  test(
    "each destination failure names its cause, on the API and on the page",
    { tag: ["@instance-migration", "@settings", "@api", "@ui-ux"] },
    async ({ page, request }) => {
      const id = unique();
      const noVector = `im_novector_${id}`;
      const step = page.getByTestId("migration-step-connect_target");

      await test.step("Setup: check this instance (API), and a database without the vector extension", async () => {
        await runSourceChecks(api);
        targetSql(lane, `create database "${noVector}"`);
        cleanups.push(() => {
          targetSql(lane, `drop database if exists "${noVector}"`);
        });
      });

      await test.step("On the page, a wrong password is refused with the server's reason", async () => {
        await openMigration(page);
        await fillDestinations(step, withPassword(`e2e-im-wrong-pg-password-${id}`));
        const { results } = await saveOnPage(page, step);
        expect(results.database).toMatchObject({ ok: false, code: "db_unreachable" });
        const line = step.locator("#migration-probe-database");
        await expect(line).toContainText("Can't connect to this database.");
        await expect(line).toContainText(`password authentication failed for user "${target.username}"`);
        await expect(step.locator("#migration-destination-database_url")).toHaveAttribute("aria-invalid", "true");
        expect(await stepState("connect_target")).toBe("blocked (db_unreachable)");
      });

      await test.step("With the right password, the step saves and closes on its summary", async () => {
        await fillDestinations(step, lane.target.databaseUrl);
        const { results } = await saveOnPage(page, step);
        expect(results).toEqual({ database: { ok: true }, vectors: { ok: true }, files: { ok: true } });
        await expect(step).toContainText(SUMMARY);
        expect(await stepState("connect_target")).toBe("done");
      });

      const failures: Array<{ what: string; data: unknown; part: string; code: string; reason: RegExp }> = [
        {
          what: "a host that does not exist",
          data: destinations({ database_url: `postgresql://${target.username}:${target.password}@im-no-such-host:5432/${target.pathname.slice(1)}` }),
          part: "database",
          code: "db_unreachable",
          reason: /failed to resolve host 'im-no-such-host'/,
        },
        {
          what: "a database without the vector extension",
          data: destinations({ database_url: `postgresql://${target.username}:${target.password}@${target.host}/${noVector}` }),
          part: "vectors",
          code: "pgvector_missing",
          reason: /^Run CREATE EXTENSION vector; in this database, then test again\.$/,
        },
        {
          what: "a bucket that does not exist",
          data: destinations({ files: { bucket: `im-no-such-bucket-${id}` } }),
          part: "files",
          code: "bucket_missing",
          reason: /\(404\) when calling the HeadBucket operation/,
        },
      ];
      for (const failure of failures) {
        await test.step(`Through the API, ${failure.what} is refused with its own code and reason`, async () => {
          const { results } = await putDestinations(request, failure.data, failure.what);
          expect(results[failure.part], failure.what).toMatchObject({ ok: false, code: failure.code });
          expect(results[failure.part].reason).toMatch(failure.reason);
          expect(await stepState("connect_target")).toBe(`blocked (${failure.code})`);
          // The record keeps how the test ended, never the driver's words, which can name the user.
          expect((await savedDestinations()).results[failure.part]).toEqual({ ok: false, code: failure.code });
        });
      }

      await test.step("The lane's destinations save, and the record keeps where each part is", async () => {
        const { results } = await putDestinations(request, destinations(), "the lane's destinations");
        expect(results).toEqual({ database: { ok: true }, vectors: { ok: true }, files: { ok: true } });
        expect(await stepState("connect_target")).toBe("done");
        expect(await savedDestinations()).toMatchObject({
          database: { location: TARGET_LOCATION },
          vectors: { kind: "pgvector" },
          files: { bucket: lane.target.bucket, prefix: "langflow", endpoint_url: lane.target.s3Endpoint },
          results: { database: { ok: true }, vectors: { ok: true }, files: { ok: true } },
          saved_by: "langflow",
        });
      });
    },
  );

  test(
    "no destination secret or key leaves the server",
    { tag: ["@instance-migration", "@settings", "@api"] },
    async ({ page, request }) => {
      const id = unique();
      const wrongPassword = `e2e-im-wrong-pg-password-${id}`;
      const endpointSecret = `e2e-im-endpoint-secret-${id}`;
      const atPassword = `e2e-im-at@password-${id}`;
      const planted = [...lane.sentinels, lane.secretKeyFingerprint, wrongPassword, endpointSecret, atPassword];
      // Docker reads the time on the VM's clock; a minute of margin keeps the logs this test wrote.
      const since = new Date(Date.now() - 60_000).toISOString();
      const pageAnswers = captureResponses(page);
      const putAnswers: string[] = [];
      const events: Record<string, string> = {};
      const step = page.getByTestId("migration-step-connect_target");

      await test.step("Check this instance (API); on the page, a refused save and a saved one", async () => {
        await runSourceChecks(api);
        await openMigration(page);
        await fillDestinations(step, withPassword(wrongPassword));
        const refused = await saveOnPage(page, step);
        expect(refused.results.database).toMatchObject({ ok: false, code: "db_unreachable" });
        putAnswers.push(refused.text);
        await fillDestinations(step, lane.target.databaseUrl);
        const saved = await saveOnPage(page, step);
        expect(saved.results.files).toEqual({ ok: true });
        putAnswers.push(saved.text);
        await expect(step).toContainText(SUMMARY);
      });

      await test.step("Through the API, an endpoint with credentials is refused and not kept", async () => {
        const answer = await putDestinations(
          request,
          destinations({ files: { endpoint_url: `http://e2e:${endpointSecret}@${new URL(lane.target.s3Endpoint).host}` } }),
          "an endpoint with credentials",
        );
        putAnswers.push(answer.text);
        expect(answer.results.files).toMatchObject({ ok: false, code: "bucket_unreachable" });
        expect(answer.results.files.reason).toContain("A user, a password or a query in it is not accepted.");
        expect((await savedDestinations()).files.endpoint_url, "the endpoint the record keeps").toBeNull();
      });

      await test.step("Through the API, a password with an unescaped @ is refused and the address is not read", async () => {
        const answer = await putDestinations(
          request,
          { database_url: `postgresql://${target.username}:${atPassword}@${target.host}${target.pathname}` },
          "a password with an @",
        );
        putAnswers.push(answer.text);
        expect(answer.results.database).toMatchObject({ ok: false, code: "db_unreachable" });
        expect(answer.results.database.reason).toContain("write it as %40");
        expect((await savedDestinations()).database.location, "the location the record keeps").toBeNull();
        putAnswers.push((await putDestinations(request, destinations(), "the lane's destinations again")).text);
      });

      await test.step("Verify the key, pause, back up, and run the three copies (API)", async () => {
        await expectStatus(
          await call(() => request.post(`${MIGRATION}/secret-key/verify`, { headers: api.headers, data: { fingerprint: lane.secretKeyFingerprint } })),
          200,
          "POST /secret-key/verify",
        );
        await expectStatus(await call(() => request.post(`${MIGRATION}/pause`, { headers: api.headers, data: {} })), 200, "POST /pause");
        await runSourceChecks(api);
        await expectStatus(await request.post(`${MIGRATION}/backup/database`, { headers: api.headers }), 200, "POST /backup/database");
        await expectStatus(
          await request.post(`${MIGRATION}/steps/backup/confirm`, { headers: api.headers, data: { location: `e2e #2351 ${id}` } }),
          200,
          "the backup's confirmation",
        );
        // Read whatever the copy's outcome: on a host short of disk the files copy fails (#2396),
        // and its events still carry everything it was given.
        for (const copy of ["copy_database", "copy_knowledge_bases", "copy_files"] as const) {
          events[copy] = await runEventsText(request, copy);
        }
      });

      await test.step("No planted secret, key or fingerprint is in anything the server answered or wrote", async () => {
        const state = await (await call(() => request.get(MIGRATION, { headers: api.headers }))).text();
        expect(state, "GET /api/v1/migration holds the saved destinations").toContain(TARGET_LOCATION);
        expect.soft(plantedIn(state, planted), "GET /api/v1/migration").toEqual([]);

        expect.soft(plantedIn(putAnswers.join("\n"), planted), "the PUT /destinations answers").toEqual([]);

        await page.reload();
        await expect(step).toContainText(SUMMARY, { timeout: 30_000 });
        expect.soft(plantedIn(await page.content(), planted), "the page's HTML").toEqual([]);
        expect.soft(plantedIn(await page.locator("body").innerText(), planted), "the page's text").toEqual([]);
        const answers = await pageAnswers();
        expect(answers.length, "API answers the page received").toBeGreaterThan(0);
        expect.soft(plantedIn(answers.join("\n"), planted), "the API answers the page received").toEqual([]);

        const record = execFileSync("docker", ["exec", lane.containers.source, "cat", `${lane.configDir}/migrations/migration.json`], {
          encoding: "utf8",
        });
        expect(JSON.parse(record).destinations.files.bucket, "migration.json holds the saved destinations").toBe(lane.target.bucket);
        expect.soft(plantedIn(record, planted), "migration.json on disk").toEqual([]);

        for (const [copy, text] of Object.entries(events)) {
          expect.soft(plantedIn(text, planted), `the events of ${copy}`).toEqual([]);
        }

        const logs = spawnSync("docker", ["logs", "--since", since, lane.containers.source], { encoding: "utf8" });
        expect(logs.status, `docker logs: ${logs.stderr.slice(0, 200)}`).toBe(0);
        const written = `${logs.stdout}\n${logs.stderr}`;
        expect(written, "the logs hold the destination tests").toContain("tested the destination");
        expect.soft(plantedIn(written, planted), "the source's logs").toEqual([]);
      });
    },
  );

  test(
    "after a restart the passwords are asked for again, never replayed",
    { tag: ["@instance-migration", "@settings", "@api", "@ui-ux"] },
    async ({ page, request }) => {
      // The copy is refused with 409 on the page on purpose.
      (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();
      const dest = page.getByTestId("migration-step-connect_target");
      const copy = page.getByTestId("migration-step-copy_database");

      await test.step("Setup (API): every step up to the copies", async () => {
        await readyToCopy(api, lane, { location: `e2e #2351 restart ${unique()}` });
        expect(await stepState("copy_database")).toBe("current");
      });

      await test.step("Restart the source container", async () => {
        restartSource();
        await waitForSource(request);
        api = await migrationApi(request);
      });

      await test.step("The step still reads done: the record survives, the secrets do not", async () => {
        expect(await stepState("connect_target")).toBe("done");
        expect((await savedDestinations()).database.location).toBe(TARGET_LOCATION);
        const refused = await call(() => startRun(api, "copy_database"));
        await expectStatus(refused, 409, "starting the database copy after the restart");
        expect(await refused.json()).toEqual({ detail: { code: "secrets_missing" } });
      });

      await test.step("On the page, the copy says to enter the passwords and keys again", async () => {
        await openMigration(page);
        const answer = page.waitForResponse(
          (r) => r.request().method() === "POST" && new URL(r.url()).pathname === `${MIGRATION}/steps/copy_database/runs`,
        );
        await copy.getByRole("button", { name: "Copy the database" }).click();
        expect((await answer).status()).toBe(409);
        await expect(copy).toContainText(ENTER_AGAIN);
      });

      await test.step("Change or enter again brings back no password and no key", async () => {
        await dest.getByRole("button", { name: "Where your data goes" }).click();
        await expect(dest).toContainText(/Saved .+ by langflow\./);
        await expect(dest).toContainText("If Langflow restarts, you'll enter them again.");
        await dest.getByRole("button", { name: "Change or enter again" }).click();
        const field = (name: string) => dest.locator(`#migration-destination-${name}`);
        await expect(field("bucket")).toHaveValue(lane.target.bucket);
        await expect(field("prefix")).toHaveValue("langflow");
        await expect(field("endpoint_url")).toHaveValue(lane.target.s3Endpoint);
        await expect(field("database_url")).toHaveValue("");
        await expect(field("access_key_id")).toHaveValue("");
        await expect(field("secret_access_key")).toHaveValue("");
      });

      await test.step("Entered again, they save, and the copy runs to its end", async () => {
        await fillDestinations(dest, lane.target.databaseUrl);
        const { results } = await saveOnPage(page, dest);
        expect(results).toEqual({ database: { ok: true }, vectors: { ok: true }, files: { ok: true } });
        await expect(dest).toContainText(SUMMARY);
        const answer = page.waitForResponse(
          (r) => r.request().method() === "POST" && new URL(r.url()).pathname === `${MIGRATION}/steps/copy_database/runs`,
        );
        await copy.getByRole("button", { name: "Copy the database" }).click();
        const started = await answer;
        expect(started.status()).toBe(202);
        const run = await followRun(api, "copy_database", (await started.json()).run_id);
        expect(run.end.status).toBe("done");
      });
    },
  );

  test(
    "the secret key step names where the key is, never the key, and cannot be skipped",
    { tag: ["@instance-migration", "@settings", "@api", "@ui-ux"] },
    async ({ page, request }) => {
      // The refused fingerprints answer 400 on the page on purpose.
      (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();
      const planted = [lane.secretKey, lane.secretKeyFingerprint];
      const pageAnswers = captureResponses(page);
      const key = page.getByTestId("migration-step-secret_key");
      const field = key.getByLabel("What the command printed");
      const locked = { detail: { code: "locked", reason: "earlier_step" } };
      const pauseRefused = async () => {
        const response = await call(() => request.post(`${MIGRATION}/pause`, { headers: api.headers, data: {} }));
        await expectStatus(response, 409, "POST /pause before the key is verified");
        expect(await response.json()).toEqual(locked);
      };
      const verifyOnPage = async (fingerprint: string) => {
        await field.fill(fingerprint);
        const answer = page.waitForResponse(
          (r) => r.request().method() === "POST" && new URL(r.url()).pathname === `${MIGRATION}/secret-key/verify`,
        );
        await key.getByRole("button", { name: "Verify" }).click();
        return answer;
      };

      await test.step("Setup (API): check this instance and save the destinations", async () => {
        await runSourceChecks(api);
        const { results } = await putDestinations(request, destinations(), "the lane's destinations");
        expect(results.database).toEqual({ ok: true });
      });

      await test.step("Until the key is verified, the pause and the copies are refused", async () => {
        expect(await stepState("secret_key")).toBe("current");
        await pauseRefused();
        const copy = await call(() => startRun(api, "copy_database"));
        await expectStatus(copy, 409, "starting the database copy before the key is verified");
        expect(await copy.json()).toEqual(locked);
        expect((await call(() => getMigration(api))).instance.secret_key).toEqual({ source: "env" });
      });

      await test.step("The page says where the key is and how to print its fingerprint", async () => {
        await openMigration(page);
        await expect(key).toContainText("This instance's secret key is set in its LANGFLOW_SECRET_KEY environment variable.");
        await expect(key).toContainText(`printf '%s' "$LANGFLOW_SECRET_KEY" | sha256sum | cut -c1-12`);
      });

      await test.step("A key pasted whole is cut to 12 characters, and refused", async () => {
        const answer = await verifyOnPage(lane.secretKey);
        await expect(field).toHaveValue(lane.secretKey.slice(0, 12));
        expect(answer.request().postDataJSON()).toEqual({ fingerprint: lane.secretKey.slice(0, 12) });
        expect(answer.request().postData() ?? "", "the request the page sent").not.toContain(lane.secretKey);
        expect(answer.status()).toBe(400);
        expect(await answer.json()).toEqual({ detail: { code: "fingerprint_mismatch" } });
        await expect(key.getByRole("alert")).toHaveText(MISMATCH);
        await expect(field).toHaveAttribute("aria-invalid", "true");
        expect(await stepState("secret_key")).toBe("blocked (fingerprint_mismatch)");
        await pauseRefused();
      });

      await test.step("The right fingerprint, in uppercase, is accepted", async () => {
        const answer = await verifyOnPage(lane.secretKeyFingerprint.toUpperCase());
        expect(answer.status()).toBe(200);
        expect(await stepState("secret_key")).toBe("done");
        expect(await stepState("pause")).toBe("current");
      });

      await test.step("Through the API, a wrong fingerprint reopens the step, and the right one closes it", async () => {
        const verify = (fingerprint: string) =>
          call(() => request.post(`${MIGRATION}/secret-key/verify`, { headers: api.headers, data: { fingerprint } }));
        await expectStatus(await verify("abcdefabcdef"), 400, "a wrong fingerprint after the right one");
        expect(await stepState("secret_key")).toBe("blocked (fingerprint_mismatch)");
        await expectStatus(await verify(`  ${lane.secretKeyFingerprint}  `), 200, "the right fingerprint with spaces around it");
        expect(await stepState("secret_key")).toBe("done");
      });

      await test.step("Neither the key nor the fingerprint is on the page or in an answer it received", async () => {
        expect(plantedIn(await page.content(), planted), "the page's HTML").toEqual([]);
        const answers = await pageAnswers();
        expect(answers.length, "API answers the page received").toBeGreaterThan(0);
        expect(plantedIn(answers.join("\n"), planted), "the API answers the page received").toEqual([]);
      });
    },
  );
});
