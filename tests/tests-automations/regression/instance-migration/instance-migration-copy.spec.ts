import { readFileSync } from "node:fs";
import type { Download, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import {
  instanceMigrationLane,
  resetInstanceMigration,
} from "../../../helpers/instance-migration/instance-migration-lane";
import {
  bucketObjects,
  confirmBackup,
  docker,
  downloadDatabase,
  followRun,
  getMigration,
  type MigrationApi,
  migrationApi,
  prepareThroughPause,
  readyToCopy,
  runSourceChecks,
  runStep,
  type RunStepId,
  sourceSql,
  startRun,
  stepOf,
  targetRowCount,
  targetSql,
  targetVectorTables,
} from "../../../helpers/instance-migration/migration-walk";

// Spec doc: docs/instance-migration/instance-migration-copy.md
// Lane: PW_INSTANCE_MIGRATION=1, against ./scripts/start-langflow-instance-migration.sh
//
// The second half of an instance migration — backup, the three copies, "Check the
// copy", the start and the migration record — asserted against what each step left
// in the destinations themselves (PostgreSQL, its pgvector tables, the bucket), not
// only against what the page says about them. A copy that reports success while
// leaving data behind is the failure this exists to catch.
//
// The steps before the backup are other specs' subject (#2349–#2352), so each test
// reaches its step through the API. Every test starts and ends with the lane's reset;
// what a test adds to the SOURCE it removes itself, after the reset has lifted the
// pause (a paused source refuses every write).
//
// No @stable — no scheduled @instance-migration lane exists (#1010).

const lane = instanceMigrationLane();
// A test walks up to ten steps; each check takes ~20 s and each run ~20 s (measured).
const WALK_TIMEOUT_MS = 6 * 60_000;
const RUN_UI_TIMEOUT_MS = 120_000;

let api: MigrationApi;
/** What a test added to the source, removed after the reset. Run in reverse order. */
let cleanups: (() => Promise<void>)[] = [];

function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The UTC day a download is named for, read around the click so midnight cannot flake it. */
function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

async function download(page: Page, click: () => Promise<void>): Promise<{ file: Download; bytes: Buffer; days: string[] }> {
  const before = utcDay();
  const [file] = await Promise.all([page.waitForEvent("download"), click()]);
  const path = await file.path();
  const days = [...new Set([before, utcDay()])];
  return { file, bytes: readFileSync(path), days };
}

function step(page: Page, id: string): Locator {
  return page.getByTestId(`migration-step-${id}`);
}

/** A done step collapses to its title; the title opens it again. */
async function openStep(stepLocator: Locator): Promise<void> {
  const toggle = stepLocator.getByRole("heading").getByRole("button");
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}

async function openMigrationPage(page: Page): Promise<void> {
  await page.goto("/settings/migration");
  await expect(step(page, "start_target")).toBeVisible({ timeout: 30_000 });
}

async function whoami(): Promise<{ id: string; username: string }> {
  const response = await api.request.get("/api/v1/users/whoami", { headers: api.headers });
  expect(response.status(), "GET /users/whoami").toBe(200);
  return response.json();
}

async function stateOf(id: Parameters<typeof stepOf>[1]): Promise<string> {
  const s = stepOf(await getMigration(api), id);
  return s.reason ? `${s.state}: ${s.reason}` : s.state;
}

async function sourceFlowCount(): Promise<number> {
  const { instance } = await getMigration(api);
  const rows = sourceSql(lane, instance.database.path ?? "", "select count(*) from flow");
  return Number(rows[0][0]);
}

async function expectRefused(stepId: RunStepId, code: string, dryRun = false): Promise<void> {
  const response = await startRun(api, stepId, dryRun);
  expect(response.status(), `starting ${stepId}${dryRun ? " (test run)" : ""}`).toBe(409);
  expect((await response.json()).detail?.code, `why ${stepId} is refused`).toBe(code);
}

test.describe("Instance migration — backup, copies, Check the copy, start and record", () => {
  test.beforeEach(async ({ request }) => {
    test.setTimeout(WALK_TIMEOUT_MS);
    resetInstanceMigration();
    cleanups = [];
    api = await migrationApi(request);
  });

  test.afterEach(async () => {
    // The reset lifts the pause first: the source refuses writes until it does.
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
    "the backup is a real copy of this instance, needs the download first, and needs a location",
    { tag: ["@instance-migration", "@settings", "@database", "@files"] },
    async ({ page }) => {
      await test.step("Setup (API): every step before the backup", async () => {
        await prepareThroughPause(api, lane);
        expect(await stateOf("backup")).toBe("current");
      });

      const backup = step(page, "backup");
      const confirm = backup.getByRole("button", { name: "I've backed up everything" });
      const location = backup.getByLabel("Where is the backup?");

      await test.step("Before any download, the confirmation is disabled and says why", async () => {
        await openMigrationPage(page);
        await expect(confirm).toBeDisabled();
        await expect(backup).toContainText("Download the database first.");
      });

      await test.step("The server holds the same rule: confirming before a download is refused", async () => {
        const early = await confirmBackup(api, "too early");
        expect(early.status()).toBe(409);
        expect((await early.json()).detail?.code).toBe("database_not_downloaded");
      });

      await test.step("Download the database: a SQLite file of this instance, named for the day", async () => {
        const { file, bytes, days } = await download(page, () =>
          backup.getByRole("button", { name: "Download the database" }).click(),
        );
        expect(days.map((day) => `langflow-backup-${day}.db`)).toContain(file.suggestedFilename());
        expect(bytes.subarray(0, 16).toString("latin1"), "the SQLite header").toBe("SQLite format 3\u0000");
        // The seed flow's name is stored in the file: it is this instance's database, not an empty one.
        expect(bytes.includes(Buffer.from(lane.seed.flowName)), "the seed flow is in the download").toBe(true);
        await expect(backup).toContainText(/Downloaded .+\./);
        await expect(confirm).toBeEnabled();
      });

      await test.step("The location is required, on the page and on the server", async () => {
        await expect(location).toHaveValue("");
        await confirm.click();
        expect(await location.evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
        expect(await stateOf("backup"), "an empty form confirms nothing").toBe("current");
        for (const blank of ["", "   "]) {
          const refused = await confirmBackup(api, blank);
          expect(refused.status(), `a location of ${JSON.stringify(blank)}`).toBe(422);
          expect(JSON.stringify(await refused.json())).toContain("string_too_short");
        }
      });

      await test.step("Confirm with a location: it is recorded, and the copies open", async () => {
        const where = `e2e instance-migration vault ${unique()}`;
        await location.fill(where);
        await confirm.click();
        await expect.poll(() => stateOf("backup")).toBe("done");
        const { record } = await getMigration(api);
        expect(record.backup?.location).toBe(where);
        expect(record.backup?.confirmed_by).toBe((await whoami()).username);
        expect(Number.isNaN(Date.parse(record.backup?.confirmed_at))).toBe(false);
        expect(await stateOf("copy_database")).toBe("current");
        await expect(backup).toContainText(`to ${where}.`);
      });
    },
  );

  test(
    "a stopped database copy keeps nothing and runs again; a repeated copy duplicates nothing",
    { tag: ["@instance-migration", "@settings", "@database", "@files"] },
    async ({ page }) => {
      let sourceFlows = 0;

      await test.step("Setup (API): every step up to the backup", async () => {
        await readyToCopy(api, lane);
        sourceFlows = await sourceFlowCount();
        expect(sourceFlows).toBeGreaterThan(0);
      });

      const copy = step(page, "copy_database");

      await test.step("Start the copy and stop it while it runs", async () => {
        await openMigrationPage(page);
        await copy.getByRole("button", { name: "Copy the database", exact: true }).click();
        await copy.getByRole("button", { name: "Stop" }).click();
        await page
          .getByRole("dialog", { name: "Stop copying?" })
          .getByRole("button", { name: "Stop", exact: true })
          .click();
        await expect(copy.getByRole("alert")).toContainText("Stopped before it finished. Run it again.", {
          timeout: RUN_UI_TIMEOUT_MS,
        });
      });

      await test.step("The stopped copy is recorded as cancelled and left no rows", async () => {
        expect(await stateOf("copy_database")).toBe("blocked: cancelled");
        expect((await getMigration(api)).record.steps.copy_database.error?.code).toBe("cancelled");
        expect(targetRowCount(lane, "flow"), "flow rows in the target after the stop").toBe(0);
      });

      let firstRun = "";
      let firstRows = 0;

      await test.step("Copy again into the same database, with no reset: it completes", async () => {
        await copy.getByRole("button", { name: "Copy again" }).click();
        await expect(copy).toContainText(/Tables: [\d,]+\. Rows: [\d,]+\./, { timeout: RUN_UI_TIMEOUT_MS });
        await expect.poll(() => stateOf("copy_database")).toBe("done");
        const run = (await getMigration(api)).record.steps.copy_database;
        expect(run.report?.ok).toBe(true);
        firstRun = run.run_id;
        firstRows = run.report?.rows_copied;
        expect(firstRows).toBeGreaterThan(0);
        expect(targetRowCount(lane, "flow"), "flow rows in the target").toBe(sourceFlows);
      });

      await test.step("Copy again once more: same rows, nothing duplicated", async () => {
        await openStep(copy);
        await copy.getByRole("button", { name: "Copy again" }).click();
        await expect
          .poll(
            async () => {
              const run = (await getMigration(api)).record.steps.copy_database;
              return run.run_id !== firstRun && run.status === "done" ? run.report?.rows_copied : null;
            },
            { timeout: RUN_UI_TIMEOUT_MS },
          )
          .toBe(firstRows);
        expect(await stateOf("copy_database")).toBe("done");
        expect(targetRowCount(lane, "flow"), "flow rows in the target after the repeat").toBe(sourceFlows);
      });
    },
  );

  test(
    "an out-of-date copy says it needs a new database, and copying into the old one changes nothing (#15814)",
    { tag: ["@instance-migration", "@settings", "@database", "@files"] },
    async ({ page }) => {
      const name = `im-stale-${unique()}`;
      let flowId = "";

      await test.step("Setup (API): a flow of this run on the source, then copy the database", async () => {
        const created = await api.request.post("/api/v1/flows/", {
          headers: api.headers,
          data: { name, data: { nodes: [], edges: [] } },
        });
        expect(created.status(), "POST /flows/").toBe(201);
        flowId = (await created.json()).id;
        cleanups.push(async () => {
          const gone = await api.request.delete(`/api/v1/flows/${flowId}`, { headers: api.headers });
          if (![200, 204, 404].includes(gone.status())) throw new Error(`deleting ${name}: ${gone.status()}`);
        });
        await readyToCopy(api, lane);
        await runStep(api, "copy_database");
        expect(targetSql(lane, `select count(*) from flow where id = '${flowId}'`), "the run's flow was copied").toBe("1");
      });

      let targetFlows = 0;

      await test.step("Turn changes back on, delete the run's flow on the source, pause again", async () => {
        const resumed = await api.request.delete("/api/v1/migration/pause", { headers: api.headers });
        expect(resumed.status(), "DELETE /pause").toBe(200);
        const deleted = await api.request.delete(`/api/v1/flows/${flowId}`, { headers: api.headers });
        expect([200, 204], `deleting ${name} on the source`).toContain(deleted.status());
        const paused = await api.request.post("/api/v1/migration/pause", { headers: api.headers, data: {} });
        expect(paused.status(), "POST /pause").toBe(200);
        await runSourceChecks(api);
        await downloadDatabase(api);
        expect((await confirmBackup(api, "e2e instance-migration walk")).status()).toBe(200);
        expect(await stateOf("copy_database"), "the copy step after the second pause").toBe("current");
        targetFlows = targetRowCount(lane, "flow");
      });

      const copy = step(page, "copy_database");

      await test.step("Before anything runs, the step says the copy is out of date and needs a new database", async () => {
        await openMigrationPage(page);
        await expect(copy).toContainText("This copy is out of date, so it no longer counts. Copy again.");
        await expect(copy).toContainText(
          "To copy the database again, save a new, empty database in 'Where your data goes' first.",
        );
      });

      await test.step("Copy again into the old database: it fails naming the table", async () => {
        await copy.getByRole("button", { name: "Copy again" }).click();
        const alert = copy.getByRole("alert");
        await expect(alert).toContainText(
          "The new instance's database holds an earlier copy that no longer matches this instance.",
          { timeout: RUN_UI_TIMEOUT_MS },
        );
        const details = (await alert.textContent()) ?? "";
        const said = /flow: source has (\d+) rows, target has (\d+) after copy/.exec(details);
        expect(said, `the details name the table: ${details}`).not.toBeNull();
        expect(Number(said?.[2])).toBe(Number(said?.[1]) + 1);
      });

      await test.step("The step is blocked and the target is as it was", async () => {
        expect(await stateOf("copy_database")).toBe("blocked: count_mismatch");
        expect(targetRowCount(lane, "flow"), "flow rows in the target").toBe(targetFlows);
        expect(targetSql(lane, `select count(*) from flow where id = '${flowId}'`), "the deleted flow's copy").toBe("1");
      });
    },
  );

  test(
    "knowledge base and file test runs write nothing; the copies land vectors and files; an unreadable knowledge base is left behind and reported (#15777)",
    { tag: ["@instance-migration", "@settings", "@database", "@files"] },
    async ({ page }) => {
      const kbName = `im-unreadable-${unique()}`;
      let kbId = "";
      let userId = "";
      let flowId = "";
      let attachment = { name: "", size: 0 };
      let seedFileSize = 0;

      await test.step("Setup (API + container): an unreadable knowledge base and a chat attachment", async () => {
        userId = (await whoami()).id;
        const created = await api.request.post("/api/v1/knowledge_bases/", {
          headers: api.headers,
          data: { name: kbName, embedding_provider: "OpenAI", embedding_model: "text-embedding-3-small" },
        });
        expect(created.status(), "POST /knowledge_bases/").toBe(201);
        kbId = (await created.json()).id;
        const folder = (await getMigration(api)).instance.knowledge_bases?.folder;
        const store = docker(["exec", lane.containers.source, "find", `${folder}/sqlite/${userId}/${kbId}`, "-name", "vectors.sqlite3"]).trim();
        expect(store, "the knowledge base's store file").toMatch(/vectors\.sqlite3$/);
        // chmod and not an overwrite: a corrupt store answers 500 to DELETE /knowledge_bases (measured).
        docker(["exec", lane.containers.source, "chmod", "000", store]);
        cleanups.push(async () => {
          docker(["exec", lane.containers.source, "chmod", "600", store]);
          const gone = await api.request.delete(`/api/v1/knowledge_bases/${kbName}`, { headers: api.headers });
          if (gone.status() !== 200) throw new Error(`deleting ${kbName}: ${gone.status()} ${await gone.text()}`);
        });

        const flows = await api.request.get("/api/v1/flows/?header_flows=true", { headers: api.headers });
        flowId = ((await flows.json()) as { id: string; name: string }[]).find((f) => f.name === lane.seed.flowName)?.id ?? "";
        expect(flowId, "the seed flow").not.toBe("");
        const bytes = Buffer.from(`chat attachment ${kbName}\n`);
        const uploaded = await api.request.post(`/api/v1/files/upload/${flowId}`, {
          headers: api.headers,
          multipart: { file: { name: `im-attachment-${unique()}.txt`, mimeType: "text/plain", buffer: bytes } },
        });
        expect(uploaded.status(), "POST /files/upload/{flow_id}").toBe(201);
        attachment = { name: String((await uploaded.json()).file_path).split("/").pop() ?? "", size: bytes.length };
        cleanups.push(async () => {
          const gone = await api.request.delete(`/api/v1/files/delete/${flowId}/${attachment.name}`, { headers: api.headers });
          if (gone.status() !== 200) throw new Error(`deleting the attachment: ${gone.status()}`);
        });

        const files = await api.request.get("/api/v2/files", { headers: api.headers });
        seedFileSize =
          ((await files.json()) as { name: string; size: number }[]).find((f) => f.name === lane.seed.fileName)?.size ?? 0;
        expect(seedFileSize, "the seed file's size").toBeGreaterThan(0);
      });

      await test.step("Setup (API): accept the planted finding and walk up to the database copy", async () => {
        await readyToCopy(api, lane, { acceptFindings: ["source: knowledge bases"] });
        await runStep(api, "copy_database");
      });

      const bases = step(page, "copy_knowledge_bases");
      const files = step(page, "copy_files");

      await test.step("Knowledge bases test run: reports what it would do and writes nothing", async () => {
        await openMigrationPage(page);
        await bases.getByRole("button", { name: "Test run" }).click();
        await expect(bases).toContainText(
          "Test run: nothing was copied. To copy: 1. Already copied: 0. Can't be copied: 1.",
          { timeout: RUN_UI_TIMEOUT_MS },
        );
        expect(targetVectorTables(lane), "pgvector tables after the test run").toEqual([]);
        await expect(files.getByRole("button")).toHaveCount(0);
      });

      await test.step("Copy knowledge bases: the seed lands, the unreadable one is reported and blocks", async () => {
        await bases.getByRole("button", { name: "Copy knowledge bases" }).click();
        await expect(bases.getByRole("alert")).toContainText("Some were not copied. Each one below says why.", {
          timeout: RUN_UI_TIMEOUT_MS,
        });
        await expect(bases).toContainText(kbName);
        await expect(bases).toContainText("This instance can't read its store. Details says why.");
        await expect(bases).toContainText("Copied: 1. Already copied: 0. Not copied: 1.");
        expect(await stateOf("copy_knowledge_bases")).toBe("blocked: kb_source_unreadable");
        const tables = targetVectorTables(lane);
        expect(tables, "one pgvector table").toHaveLength(1);
        expect(targetRowCount(lane, tables[0]), "vectors in it").toBe(lane.seed.knowledgeBaseChunks);
      });

      await test.step("Leave it behind: the step completes and the decision is recorded", async () => {
        await bases.getByRole("checkbox", { name: `Leave it behind, ${kbName}` }).click();
        await expect.poll(() => stateOf("copy_knowledge_bases")).toBe("done");
        const { record } = await getMigration(api);
        expect(record.decisions).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "leave_behind", subject: kbId })]),
        );
      });

      await test.step("Files test run: reports two files and writes nothing", async () => {
        await files.getByRole("button", { name: "Test run" }).click();
        await expect(files).toContainText("Test run: nothing was copied. To copy: 2.", { timeout: RUN_UI_TIMEOUT_MS });
        expect(await bucketObjects(api.request, lane), "the bucket after the test run").toEqual([]);
      });

      await test.step("Copy files: the upload and the chat attachment land at their sizes", async () => {
        await files.getByRole("button", { name: "Copy files" }).click();
        await expect(files).toContainText("Copied: 2. Already copied: 0. Not copied: 0.", { timeout: RUN_UI_TIMEOUT_MS });
        expect(await stateOf("copy_files")).toBe("done");
        const objects = await bucketObjects(api.request, lane);
        expect(objects.sort((a, b) => a.key.localeCompare(b.key))).toEqual(
          [
            { key: `langflow/${userId}/${lane.seed.fileName}.txt`, size: seedFileSize },
            { key: `langflow/${flowId}/${attachment.name}`, size: attachment.size },
          ].sort((a, b) => a.key.localeCompare(b.key)),
        );
      });
    },
  );

  test(
    "Check the copy matches a clean copy and names a deleted row; the start shows no secret; the record holds none",
    { tag: ["@instance-migration", "@settings", "@database", "@files"] },
    async ({ page }) => {
      const id = unique();
      const variable = { name: `IM_SENTINEL_CREDENTIAL_${id}`, value: `e2e-im-sentinel-credential-${id}` };
      const where = `e2e instance-migration vault ${id}`;
      const sentinels = [...lane.sentinels, variable.value];

      await test.step("Setup (API): a credential with a sentinel value, then every step and the three copies", async () => {
        const created = await api.request.post("/api/v1/variables/", {
          headers: api.headers,
          data: { name: variable.name, value: variable.value, type: "Credential", default_fields: [] },
        });
        expect(created.status(), "POST /variables/").toBe(201);
        const variableId = (await created.json()).id;
        cleanups.push(async () => {
          const gone = await api.request.delete(`/api/v1/variables/${variableId}`, { headers: api.headers });
          if (![200, 204].includes(gone.status())) throw new Error(`deleting ${variable.name}: ${gone.status()}`);
        });
        await readyToCopy(api, lane, { location: where });
        for (const copyStep of ["copy_database", "copy_knowledge_bases", "copy_files"] as const) {
          await runStep(api, copyStep);
        }
        expect(await stateOf("check_target")).toBe("current");
      });

      const check = step(page, "check_target");

      await test.step("Check the copy: a clean copy matches", async () => {
        await openMigrationPage(page);
        await check.getByRole("button", { name: "Check the copy" }).click();
        await expect.poll(() => stateOf("check_target"), { timeout: RUN_UI_TIMEOUT_MS }).toBe("done");
        await expect(check).toContainText("Everything matches.");
        const report = (await getMigration(api)).record.steps.check_target.report;
        expect(report.ok).toBe(true);
        expect(report.checks.length).toBeGreaterThan(0);
        expect(report.checks.filter((c: { same: boolean }) => !c.same)).toEqual([]);
      });

      let here = "";
      let there = "";

      await test.step("Delete the credential's row from the copy and check again: the difference is named", async () => {
        expect(targetSql(lane, `delete from variable where name = '${variable.name}'`)).toBe("DELETE 1");
        // Once a check matches, its step has no body and no "Check again" (measured): the page offers a new
        // check only when a step above changes, and a row deleted straight from the database is not one.
        await expect(check.getByRole("button", { name: "Check again" })).toHaveCount(0);
        const started = await startRun(api, "check_target");
        expect(started.status(), "starting the check again").toBe(202);
        await followRun(api, "check_target", (await started.json()).run_id);
        await page.reload();
        await expect(check.getByRole("alert")).toContainText("The copy differs from this instance: 1.", {
          timeout: RUN_UI_TIMEOUT_MS,
        });
        const credentials = (await getMigration(api)).record.steps.check_target.report.checks.find(
          (c: { name: string }) => c.name === "credentials",
        );
        here = credentials.here.summary;
        there = credentials.there.summary;
        const count = (summary: string) => Number(/^(\d+) encrypted values/.exec(summary)?.[1]);
        expect(count(there), `${there} against ${here}`).toBe(count(here) - 1);
        const difference = page.getByTestId("migration-difference-credentials");
        await expect(difference).toContainText(here);
        await expect(difference).toContainText(there);
        expect(await stateOf("check_target")).toBe("blocked: differences");
        expect(await stateOf("start_target")).toBe("locked: earlier_step");
      });

      await test.step("Accept the difference: the step completes and records what was accepted", async () => {
        await check.getByRole("checkbox").click();
        await check.getByRole("button", { name: "Continue" }).click();
        await expect.poll(() => stateOf("check_target")).toBe("done");
        expect((await getMigration(api)).record.steps.check_target.accepted_differences).toEqual(["credentials"]);
      });

      await test.step("Show the settings: placeholders where a secret would go, and no sentinel on the page", async () => {
        const start = step(page, "start_target");
        await start.getByRole("button", { name: "Show the settings" }).click();
        const gate = page.getByRole("dialog", { name: "Start the new instance?" });
        await expect(gate).toContainText(`Backup confirmed: ${where}`);
        await gate.getByRole("button", { name: "Continue" }).click();
        const settings = page.getByTestId("migration-start-settings");
        await expect(settings).toContainText(
          `LANGFLOW_DATABASE_URL=postgresql://<user>:<password>@${lane.containers.database}:5432/`,
        );
        await expect(settings).toContainText("LANGFLOW_SECRET_KEY=<secret key>");
        await expect(settings).toContainText("AWS_ACCESS_KEY_ID=<access key id>");
        await expect(settings).toContainText("AWS_SECRET_ACCESS_KEY=<secret access key>");
        const html = await page.content();
        for (const sentinel of sentinels) expect(html, "a planted secret on the page").not.toContain(sentinel);
      });

      await test.step("The new instance is running: the move closes and nothing copies again", async () => {
        await step(page, "start_target").getByRole("button", { name: "The new instance is running" }).click();
        await expect(page.getByTestId("migration-complete")).toContainText("Move complete.");
        const { steps } = await getMigration(api);
        expect(steps.filter((s) => s.state !== "done").map((s) => s.id)).toEqual([]);
        for (const runStepId of ["copy_database", "copy_knowledge_bases", "copy_files", "check_target"] as const) {
          await expectRefused(runStepId, "new_instance_started");
        }
        await expectRefused("copy_files", "new_instance_started", true);
      });

      await test.step("Download the migration record: the steps and decisions, and none of the secrets", async () => {
        const { file, bytes, days } = await download(page, () =>
          page.getByRole("button", { name: "Download the migration record (for support)" }).click(),
        );
        expect(days.map((day) => `langflow-migration-${day}.json`)).toContain(file.suggestedFilename());
        const text = bytes.toString("utf8");
        const saved = JSON.parse(text);
        expect(saved.steps).toHaveLength(10);
        expect(saved.steps.filter((s: { state: string }) => s.state !== "done")).toEqual([]);
        expect(saved.record.backup.location).toBe(where);
        expect(saved.record.steps.check_target.accepted_differences).toEqual(["credentials"]);
        expect(saved.record.steps.start_target.confirmed_by).toBe((await whoami()).username);
        for (const sentinel of sentinels) expect(text, "a planted secret in the record").not.toContain(sentinel);
      });
    },
  );
});
