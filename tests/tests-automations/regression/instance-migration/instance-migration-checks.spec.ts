import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import {
  instanceMigrationLane,
  resetInstanceMigration,
} from "../../../helpers/instance-migration/instance-migration-lane";
import {
  docker,
  getMigration,
  type MigrationApi,
  migrationApi,
  runSourceChecks,
  saveDestinations,
  stepOf,
  verifySecretKey,
} from "../../../helpers/instance-migration/migration-walk";

// Spec doc: docs/instance-migration/instance-migration-checks.md
// Lane: PW_INSTANCE_MIGRATION=1, against ./scripts/start-langflow-instance-migration.sh
//
// "Check this instance" decides whether a migration may start at all. Test 1 is the
// target version gate. Test 2 plants one finding per group and asserts the page sorts
// them, and that an open finding keeps the steps after it shut. Test 3 accepts a finding
// and withdraws it. Test 4 runs the check twice on an unchanged instance.
//
// The lane's seeded source has no finding at all (all 12 checks `ok`, measured), so
// every finding here is planted by the test and removed by it, after the lane's reset.
//
// No @stable — no scheduled @instance-migration lane exists (#1010).

const lane = instanceMigrationLane();
// Each check run takes ~30 s idle and measured up to ~95 s on a loaded host; test 1 pays two.
const TEST_TIMEOUT_MS = 12 * 60_000;
const CHECK_UI_TIMEOUT_MS = 300_000;
const MIGRATION = "/api/v1/migration";

const NO_FINDING = "Nothing stops the move.";
const STEPS_ABOVE_FIRST = "Finish the steps above first.";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  summary: string;
  problems?: string[];
}

let api: MigrationApi;
/** What a test planted on the source, removed after the reset. Run in reverse order. */
let cleanups: (() => Promise<void>)[] = [];

function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function expectStatus(response: { status(): number; text(): Promise<string> }, status: number, what: string) {
  expect(response.status(), `${what}: ${(await response.text()).slice(0, 300)}`).toBe(status);
}

/** The checks of the last report the record holds, in the order the command ran them. */
async function lastReport(): Promise<Check[]> {
  const checks = (await getMigration(api)).record.steps?.check_source?.report?.checks as Check[] | undefined;
  expect(checks, "the record holds a check report").toBeTruthy();
  return checks ?? [];
}

async function stateOf(id: Parameters<typeof stepOf>[1]): Promise<string> {
  const s = stepOf(await getMigration(api), id);
  return s.reason ? `${s.state} (${s.reason})` : s.state;
}

/** `POST /checks` for a version, answered as it came. */
function postChecks(targetVersion: string) {
  return api.request.post(`${MIGRATION}/checks`, {
    headers: api.headers,
    data: { target_version: targetVersion },
    timeout: CHECK_UI_TIMEOUT_MS,
  });
}

async function whoamiId(): Promise<string> {
  const response = await api.request.get("/api/v1/users/whoami", { headers: api.headers });
  await expectStatus(response, 200, "GET /users/whoami");
  return (await response.json()).id;
}

/** A knowledge base of the superuser's, deleted after the test. Its provider is named and never called. */
async function createKnowledgeBase(name: string, embeddingModel: string): Promise<string> {
  const response = await api.request.post("/api/v1/knowledge_bases/", {
    headers: api.headers,
    data: { name, embedding_provider: "OpenAI", embedding_model: embeddingModel },
  });
  await expectStatus(response, 201, `POST /knowledge_bases/ '${name}'`);
  cleanups.push(async () => {
    const gone = await api.request.delete(`/api/v1/knowledge_bases/${name}`, { headers: api.headers });
    if (gone.status() !== 200) throw new Error(`deleting ${name}: ${gone.status()} ${await gone.text()}`);
  });
  return (await response.json()).id;
}

/**
 * "Fix or accept": a knowledge base whose store file this instance cannot open.
 * chmod and not an overwrite: a corrupt store answers 500 to DELETE /knowledge_bases
 * (measured for #2353), and a readable one deletes with 200.
 */
async function plantUnreadableKnowledgeBase(): Promise<string> {
  const name = `im-checks-unreadable-${unique()}`;
  const kbId = await createKnowledgeBase(name, "text-embedding-3-small");
  const folder = (await getMigration(api)).instance.knowledge_bases?.folder;
  const store = docker([
    "exec",
    lane.containers.source,
    "find",
    `${folder}/sqlite/${await whoamiId()}/${kbId}`,
    "-name",
    "vectors.sqlite3",
  ]).trim();
  expect(store, "the knowledge base's store file").toMatch(/vectors\.sqlite3$/);
  docker(["exec", lane.containers.source, "chmod", "000", store]);
  // Pushed after the delete above, so it runs first: the store is readable again before the delete.
  cleanups.push(async () => {
    docker(["exec", lane.containers.source, "chmod", "600", store]);
  });
  return name;
}

/** "Read these": a knowledge base that records no embedding model. */
async function plantKnowledgeBaseWithoutModel(): Promise<string> {
  const name = `im-checks-nomodel-${unique()}`;
  await createKnowledgeBase(name, "");
  return name;
}

const CORRUPT_CIPHERTEXT = [
  "import sqlite3, sys",
  "c = sqlite3.connect(sys.argv[1])",
  "n = c.execute(\"UPDATE variable SET value = 'gAAAAABnot-a-valid-token' WHERE id = ?\", (sys.argv[2],)).rowcount",
  "c.commit()",
  "print(n)",
].join("\n");

/** "Fix these": a Credential variable whose ciphertext no key opens. Deleted over the API (measured 204). */
async function plantUndecryptableCredential(): Promise<string> {
  const name = `IM_CHECKS_${unique().toUpperCase()}`;
  const response = await api.request.post("/api/v1/variables/", {
    headers: api.headers,
    data: { name, value: "im-checks-probe", type: "Credential", default_fields: [] },
  });
  await expectStatus(response, 201, "POST /api/v1/variables/");
  const variableId: string = (await response.json()).id;
  cleanups.push(async () => {
    const gone = await api.request.delete(`/api/v1/variables/${variableId}`, { headers: api.headers });
    if (!gone.ok() && gone.status() !== 404) throw new Error(`deleting the variable answered ${gone.status()}`);
  });
  const dbPath = (await getMigration(api)).instance.database.path;
  expect(dbPath, "the source's SQLite path").toBeTruthy();
  // SQLite stores the uuid as 32 hex characters, without dashes (measured).
  const updated = docker([
    "exec",
    lane.containers.source,
    "python",
    "-c",
    CORRUPT_CIPHERTEXT,
    String(dbPath),
    variableId.replaceAll("-", ""),
  ]).trim();
  expect(updated.split("\n").at(-1), "rows whose ciphertext was overwritten").toBe("1");
  return name;
}

/**
 * A locked step renders no body at all: its title is muted and "Finish the steps above
 * first." exists only in an `sr-only` span, for screen readers (upstream `index.tsx`).
 * So what a user sees is the absence of the step's form, and what assistive technology
 * reads is the notice; both are asserted, and neither alone.
 */
async function expectShut(card: Locator): Promise<void> {
  await expect(card.getByRole("textbox"), "a locked step shows no form").toHaveCount(0);
  await expect(card.getByRole("button", { name: "Test and save" })).toHaveCount(0);
  await expect(card, "the screen-reader notice of a locked step").toContainText(STEPS_ABOVE_FIRST);
}

/** The step's form is there, and the locked notice is gone. */
async function expectOpen(card: Locator): Promise<void> {
  await expect(card.getByRole("button", { name: "Test and save" })).toBeVisible();
  await expect(card).not.toContainText(STEPS_ABOVE_FIRST);
}

function stepCard(page: Page, id: string): Locator {
  return page.getByTestId(`migration-step-${id}`);
}

/** A done step collapses to its title; the title opens it again (as instance-migration-copy.spec.ts does). */
async function openStep(card: Locator): Promise<void> {
  const toggle = card.getByRole("heading").getByRole("button");
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}

async function openMigrationPage(page: Page): Promise<void> {
  await page.goto("/settings/migration");
  await expect(stepCard(page, "check_source")).toBeVisible({ timeout: 30_000 });
}

/**
 * Type a version and click the button; answers the page's own `POST /checks`. A refusal
 * comes back at once, but a check's NDJSON stream fires its response only with the first
 * event, ~30 s after the click (measured), so the wait gets the check's whole budget.
 */
async function runChecksOnPage(page: Page, version: string) {
  const answered = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === `${MIGRATION}/checks`,
    { timeout: CHECK_UI_TIMEOUT_MS },
  );
  await page.getByTestId("migration-target-version").fill(version);
  await page.getByTestId("migration-run-checks").click();
  return answered;
}

/** The check names a group lists, from each row's test id. */
async function namesIn(group: Locator): Promise<string[]> {
  const ids = await group.locator('[data-testid^="migration-check-"]').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-testid") ?? ""),
  );
  return ids.map((id) => id.replace(/^migration-check-/, "")).sort();
}

test.describe("Instance migration — Check this instance gates the version, sorts its findings, and blocks a migration that cannot succeed", () => {
  test.beforeEach(async ({ request }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    resetInstanceMigration();
    cleanups = [];
    api = await migrationApi(request);
  });

  test.afterEach(async () => {
    // A failed reset must not skip the cleanups: the lane's reset never repairs the
    // source, so an undecryptable credential left behind would block every later spec.
    const errors: string[] = [];
    try {
      resetInstanceMigration();
    } catch (error) {
      errors.push(`reset: ${String(error)}`);
    }
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
    "the target version gate refuses an older or malformed version and runs an equal or newer one",
    { tag: ["@instance-migration", "@settings", "@api", "@ui-ux"] },
    async ({ page }) => {
      // The 422s are the subject of this test.
      (page as unknown as { allowHttpErrors: () => void }).allowHttpErrors();
      const source = (await getMigration(api)).instance.version;
      const field = page.getByTestId("migration-target-version");
      const error = page.locator("#migration-target-version-error");

      await test.step("The field offers the source's version as its placeholder", async () => {
        await openMigrationPage(page);
        await expect(field).toHaveAttribute("placeholder", source);
      });

      await test.step("An older version is refused, naming the source's version; the field keeps the typed one", async () => {
        // Status only: Chromium does not keep these bodies for a later read (measured). The
        // API step below asserts each body.
        const answer = await runChecksOnPage(page, "1.0.0");
        expect(answer.status(), "POST /checks with 1.0.0").toBe(422);
        await expect(field).toHaveAttribute("aria-invalid", "true");
        await expect(error).toHaveText(`Older than this instance. Use ${source} or newer. Preview builds of that version count as older.`);
        await expect(field).toHaveValue("1.0.0");
      });

      await test.step("A malformed version is refused as input", async () => {
        const answer = await runChecksOnPage(page, "not-a-version");
        expect(answer.status(), "POST /checks with not-a-version").toBe(422);
        await expect(error).toHaveText(`Enter a version such as ${source}.`);
      });

      await test.step("Over the API, each refusal carries its code, and a refused version changes nothing", async () => {
        for (const version of ["1.0.0", "0.9.0"]) {
          const older = await postChecks(version);
          await expectStatus(older, 422, `POST /checks with ${version}`);
          expect(await older.json()).toEqual({ detail: { code: "version_older", source_version: source } });
        }
        for (const version of ["not-a-version", ""]) {
          const invalid = await postChecks(version);
          await expectStatus(invalid, 422, `POST /checks with '${version}'`);
          expect(await invalid.json()).toEqual({ detail: { code: "version_invalid" } });
        }
        expect(await stateOf("check_source")).toBe("current");
        expect((await getMigration(api)).record.steps?.check_source ?? null, "a check run in the record").toBeNull();
      });

      await test.step("A newer version runs the check, and its version check says so", async () => {
        const newer = await postChecks("99.0.0");
        await expectStatus(newer, 200, "POST /checks with 99.0.0");
        await newer.body();
        const version = (await lastReport()).find((c) => c.name === "version");
        expect(version?.status).toBe("ok");
        expect(version?.summary).toContain(`the target runs Langflow 99.0.0, newer than this instance's ${source}`);
      });

      await test.step("The admin's paste of an equal version runs the check to a clean summary", async () => {
        await openMigrationPage(page);
        // The newer run above left the step done, which collapses it to its title.
        await openStep(stepCard(page, "check_source"));
        const answer = await runChecksOnPage(page, `Langflow v${source}`);
        expect(answer.status(), "POST /checks with the pasted version").toBe(200);
        const summary = page.getByTestId("migration-checks-summary");
        await expect(summary).toContainText(NO_FINDING, { timeout: CHECK_UI_TIMEOUT_MS });
        await expect(summary).toContainText(`against Langflow ${source}`);
        expect(await stateOf("check_source")).toBe("done");
        const version = (await lastReport()).find((c) => c.name === "version");
        expect(version?.summary).toBe(`source and target both run Langflow ${source}`);
      });
    },
  );

  test(
    "planted findings land in their four groups, and an open finding blocks the next step",
    { tag: ["@instance-migration", "@settings", "@api", "@ui-ux"] },
    async ({ page }) => {
      await test.step("Setup (API + container): one finding for each of Fix these, Fix or accept and Read these", async () => {
        await plantUndecryptableCredential();
        await plantUnreadableKnowledgeBase();
        await plantKnowledgeBaseWithoutModel();
      });

      const source = (await getMigration(api)).instance.version;

      await test.step("Run the check on the page: two problems stop the move", async () => {
        await openMigrationPage(page);
        const answer = await runChecksOnPage(page, source);
        expect(answer.status(), "POST /checks").toBe(200);
        await expect(page.getByTestId("migration-checks-summary")).toContainText("Problems that stop the move: 2", {
          timeout: CHECK_UI_TIMEOUT_MS,
        });
      });

      await test.step("Each finding is in its group, and every check is in exactly one", async () => {
        const fix = page.getByTestId("migration-group-fix");
        const decide = page.getByTestId("migration-group-decide");
        const read = page.getByTestId("migration-group-read");
        const passed = page.getByTestId("migration-group-passed");
        expect(await namesIn(fix), "Fix these").toEqual(["source: credentials"]);
        expect(await namesIn(decide), "Fix or accept").toEqual(["source: knowledge bases"]);
        expect(await namesIn(read), "Read these").toEqual(["embedding models"]);
        await expect(fix.getByRole("checkbox"), "a Fix these finding offers no acceptance").toHaveCount(0);
        await expect(decide.getByRole("checkbox")).not.toBeChecked();

        const report = await lastReport();
        const listed = [...(await namesIn(fix)), ...(await namesIn(decide)), ...(await namesIn(read)), ...(await namesIn(passed))];
        expect(listed.sort(), "the page's groups against the report").toEqual(report.map((c) => c.name).sort());
        expect(
          report.filter((c) => c.status !== "ok").map((c) => `${c.name}: ${c.status}`).sort(),
          "what the report says is not ok",
        ).toEqual(["embedding models: warn", "source: credentials: fail", "source: knowledge bases: fail"]);
      });

      await test.step("The server blocks on the two failures, not on the warning", async () => {
        expect([...(await getMigration(api)).blocking_findings].sort()).toEqual([
          "source: credentials",
          "source: knowledge bases",
        ]);
        expect(await stateOf("check_source")).toBe("blocked (blocking_findings)");
      });

      await test.step("The next step on the page stays shut", async () => {
        const next = stepCard(page, "connect_target");
        await expectShut(next);
      });

      await test.step("A Fix these finding cannot be accepted over the API", async () => {
        const refused = await api.request.post(`${MIGRATION}/accepted-findings`, {
          headers: api.headers,
          data: { name: "source: credentials" },
        });
        await expectStatus(refused, 400, "accepting source: credentials");
        expect(await refused.json()).toEqual({ detail: { code: "not_acceptable" } });
      });

      await test.step("With destinations and key saved, the pause is still refused: the finding is all that is in the way", async () => {
        await saveDestinations(api, lane);
        await verifySecretKey(api, lane);
        const state = await getMigration(api);
        expect(stepOf(state, "connect_target").state).toBe("done");
        expect(stepOf(state, "secret_key").state).toBe("done");
        expect(stepOf(state, "pause")).toMatchObject({ state: "locked", reason: "earlier_step" });
        const pause = await api.request.post(`${MIGRATION}/pause`, { headers: api.headers, data: {} });
        await expectStatus(pause, 409, "POST /pause");
        expect(await pause.json()).toEqual({ detail: { code: "locked", reason: "earlier_step" } });
      });
    },
  );

  test(
    "accepting a finding records it and opens the next step; withdrawing it blocks again",
    { tag: ["@instance-migration", "@settings", "@api", "@ui-ux"] },
    async ({ page }) => {
      let kbName = "";
      await test.step("Setup (API + container): an unreadable knowledge base, and the check run", async () => {
        kbName = await plantUnreadableKnowledgeBase();
        await runSourceChecks(api);
        expect((await getMigration(api)).blocking_findings).toEqual(["source: knowledge bases"]);
      });

      const row = page.getByTestId("migration-check-source: knowledge bases");
      const checkbox = row.getByRole("checkbox");
      const next = stepCard(page, "connect_target");

      await test.step("Accept it on the page: the page posts the acceptance", async () => {
        await openMigrationPage(page);
        await expectShut(next);
        const posted = page.waitForResponse(
          (r) => r.request().method() === "POST" && new URL(r.url()).pathname === `${MIGRATION}/accepted-findings`,
        );
        await checkbox.click();
        expect((await posted).status(), "POST /accepted-findings").toBe(200);
        await expect(checkbox).toBeChecked();
      });

      await test.step("The record holds the acceptance, and the next step opens", async () => {
        const state = await getMigration(api);
        const report = await lastReport();
        const finding = report.find((c) => c.name === "source: knowledge bases");
        const accepted = state.record.accepted_findings as Record<string, unknown>[];
        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toMatchObject({
          name: "source: knowledge bases",
          summary: finding?.summary,
          problems: finding?.problems,
          accepted_by: "langflow",
        });
        expect(typeof accepted[0].accepted_at, "accepted_at is recorded").toBe("string");
        expect(Number.isNaN(Date.parse(String(accepted[0].accepted_at))), "accepted_at is a time").toBe(false);
        expect((finding?.problems ?? []).join("\n"), "the acceptance names the planted knowledge base").toContain(kbName);
        expect(state.blocking_findings).toEqual([]);
        expect(await stateOf("check_source")).toBe("done");
        expect(await stateOf("connect_target")).toBe("current");

        await expect(row).toContainText("Accepted by langflow on ");
        await expect(page.getByTestId("migration-checks-summary")).toContainText(NO_FINDING);
        await expectOpen(next);
      });

      await test.step("Withdraw it on the page: the page deletes the acceptance and the step shuts again", async () => {
        const deleted = page.waitForResponse(
          (r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === `${MIGRATION}/accepted-findings`,
        );
        await checkbox.click();
        const answer = await deleted;
        expect(answer.status(), "DELETE /accepted-findings").toBe(200);
        expect(new URL(answer.url()).searchParams.get("name")).toBe("source: knowledge bases");
        await expect(checkbox).not.toBeChecked();

        const state = await getMigration(api);
        expect(state.record.accepted_findings).toEqual([]);
        expect(state.blocking_findings).toEqual(["source: knowledge bases"]);
        expect(await stateOf("check_source")).toBe("blocked (blocking_findings)");
        await expectShut(next);
      });
    },
  );

  test(
    "running the check twice on an unchanged instance produces the same findings, and an acceptance carries over",
    { tag: ["@instance-migration", "@settings", "@api"] },
    async () => {
      let first: Check[] = [];
      await test.step("Setup (API + container): an unreadable knowledge base; run the check and accept the finding", async () => {
        await plantUnreadableKnowledgeBase();
        await runSourceChecks(api);
        first = await lastReport();
        expect(first.filter((c) => c.status !== "ok").map((c) => c.name)).toEqual(["source: knowledge bases"]);
        const accepted = await api.request.post(`${MIGRATION}/accepted-findings`, {
          headers: api.headers,
          data: { name: "source: knowledge bases" },
        });
        await expectStatus(accepted, 200, "accepting source: knowledge bases");
      });

      await test.step("The second run reports every check exactly as the first did", async () => {
        await runSourceChecks(api);
        const second = await lastReport();
        const shape = (checks: Check[]) =>
          checks.map(({ name, status, summary, problems }) => ({ name, status, summary, problems: problems ?? [] }));
        expect(shape(second)).toEqual(shape(first));
      });

      await test.step("The acceptance still counts: nothing blocks", async () => {
        expect((await getMigration(api)).blocking_findings).toEqual([]);
        expect(await stateOf("check_source")).toBe("done");
      });
    },
  );
});
