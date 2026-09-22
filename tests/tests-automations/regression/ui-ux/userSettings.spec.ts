import type {
  APIRequestContext,
  Page,
  Request,
  Response,
} from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlowFromStarter } from "../../../helpers/flows/create-flow-from-starter";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import { waitForPageEntry } from "../../../helpers/other/page-entry-barrier";

/**
 * Settings journeys no other `@stable` spec covers end to end: renaming a global
 * variable, creating a Langflow API key from the UI, the shortcut catalog by name,
 * and leaving Settings back to the flow the user came from. Spec doc:
 * `docs/ui-ux/userSettings.md`.
 *
 * Wave 9 T2 triage (#1909). The inherited file had two defects that shape this one:
 *
 *  - Its global-variables test ticked the grid's HEADER checkbox and deleted, then
 *    asserted "No data available": it deleted every variable of the shared account
 *    — other workers' variables and the provider credentials `collect-models` saves
 *    — and asserted the account held none. Langflow falsifies that on every login:
 *    `/api/v1/auto_login` re-creates FLOW_ID, COMPONENT_ID, FIELD_NAME and
 *    ASTRA_TOKEN, and every other test's page load is a login. 2/3 in the
 *    measurement; 5/5 red on demand under concurrent logins. Everything here is
 *    scoped to the ids a test created.
 *  - It created flows (awaitBootstrapTest's empty-project branch, the back-navigation
 *    template) and one API key per run, and deleted none of them.
 */

// Everything a test creates, by id, so the teardown deletes exactly that — never a
// sweep or a select-all, which is how the inherited file wiped other workers' state.
const created = {
  variableIds: [] as string[],
  apiKeyIds: [] as string[],
  flowIds: [] as string[],
};

test.afterEach(async ({ page, request }) => {
  const variableIds = created.variableIds.splice(0);
  const apiKeyIds = created.apiKeyIds.splice(0);
  const flowIds = created.flowIds.splice(0);
  if (variableIds.length + apiKeyIds.length + flowIds.length === 0) return;

  // Leave the editor before deleting the flow it shows: a mounted editor keeps
  // polling that flow and 404s once it is gone, which the fixture logs as a
  // backend error (#1288).
  if (flowIds.length > 0) await unmountEditorForCleanup(page);

  // Explicit bearer: under AUTO_LOGIN a bare request context is unauthenticated,
  // so an unheadered DELETE 401s and silently leaks.
  const headers = { Authorization: await getAuthToken(request) };
  for (const id of variableIds) {
    await deleteCreated(request, `/api/v1/variables/${id}`, headers);
  }
  for (const id of apiKeyIds) {
    await deleteCreated(request, `/api/v1/api_key/${id}`, headers);
  }
  for (const id of flowIds) {
    await deleteFlow(request, id, { headers });
  }
});

/**
 * DELETE one resource this file created. A 404 is success — the global-variables
 * test deletes its own variable through the UI, so the teardown usually finds it
 * gone. Any other failure is a leak, and is reported rather than swallowed.
 */
async function deleteCreated(
  request: APIRequestContext,
  path: string,
  headers: Record<string, string>,
): Promise<void> {
  const response = await request.delete(path, { headers });
  if (!response.ok() && response.status() !== 404) {
    console.warn(
      `⚠️  cleanup: DELETE ${path} answered ${response.status()} — the resource leaked`,
    );
  }
}

/** Letters and digits only, so a name is also safe inside a RegExp. */
function uniqueName(): string {
  return `us${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Match the response to one exact REST call, by method and pathname. */
function isCall(method: string, pathname: string) {
  return (response: Response) =>
    response.request().method() === method &&
    new URL(response.url()).pathname === pathname;
}

/** Open Settings from the profile menu and wait for a section header. */
async function openSettingsFromMenu(page: Page): Promise<void> {
  await page.getByTestId("user-profile-settings").click();
  await page.getByTestId("menu_settings_button").click();
  await expect(page.getByTestId("settings_menu_header")).toBeVisible({
    timeout: 15000,
  });
}

/**
 * Enter a Settings section the way a user does — home page, profile menu, the
 * section's sidebar link — and wait for the section's own header.
 *
 * Deliberately not `awaitBootstrapTest`: on an empty project it creates two flows
 * (`New Flow`, `Basic Prompting`) that a journey needing no flow would then have to
 * find and delete. Its attributed page-entry barrier is kept.
 */
async function openSettingsSection(page: Page, section: string): Promise<void> {
  await page.goto("/");
  await waitForPageEntry(page, '[data-testid="mainpage_title"]', 30000);
  await openSettingsFromMenu(page);
  await page.getByRole("link", { name: section, exact: true }).click();
  await expect(page.getByTestId("settings_menu_header")).toContainText(section, {
    timeout: 15000,
  });
}

/** A variables-grid name cell holding exactly `name`, relative to `.ag-row`. */
function nameCellSelector(page: Page, name: string) {
  return page
    .locator('[col-id="name"]')
    .filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) });
}

/** The name cell of a variables-grid row, matched on the whole cell text. */
function variableNameCell(page: Page, name: string) {
  return page.locator(".ag-row").locator(nameCellSelector(page, name));
}

/** The variables-grid row holding `name`. */
function variableRow(page: Page, name: string) {
  return page.locator(".ag-row").filter({ has: nameCellSelector(page, name) });
}

/**
 * Scroll the variables grid until `name`'s row is rendered, and return its name
 * cell. ag-grid keeps only the rows in its window in the DOM and appends a new
 * variable last, so on an account holding more variables than fit (18 at 1280×720)
 * the row exists in the grid's data but not in the page (#1303).
 */
async function revealVariableRow(page: Page, name: string) {
  const cell = variableNameCell(page, name);
  await expect
    .poll(
      async () => {
        await page
          .locator(".ag-body-viewport")
          .evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          })
          .catch(() => {
            /* the grid is not rendered yet — reported by the poll */
          });
        return cell.isVisible();
      },
      {
        timeout: 15000,
        message: `"${name}" never rendered in the variables grid`,
      },
    )
    .toBe(true);
  return cell;
}

// Apply To Fields candidates: fields of components no spec in this suite places
// (DataStax HCD, Oracle, IBM Db2, Amazon Bedrock). While this test's variable exists,
// Langflow applies it to that field on any newly placed component, so a common field
// — the inherited list reached `Anthropic API Key` on the 1.13 nightly, which no
// longer offers the three fields it listed first — would reach into another
// worker's flow. Four vendor distributions, so one packaging change cannot empty
// the list; if one ever does, the failure names what IS offered.
const APPLY_TO_FIELD_CANDIDATES = [
  "HCD Password",
  "Wallet Password",
  "SSL Certificate Password",
  "AWS Session Token",
];

/**
 * Pick the first offered candidate in the open variable modal's Apply To Fields.
 *
 * The options arrive asynchronously: until the component catalog
 * (`GET /api/v1/all`) has loaded, the modal offers a placeholder list
 * (`System`, `System Message`, `System Prompt`) and swaps in the real fields when it
 * lands. So the choice is polled, and a failure names what was last offered —
 * which separates "the catalog never loaded" from "these components left the image".
 */
async function chooseApplyToField(page: Page): Promise<string> {
  await page.getByTestId("popover-anchor-apply-to-fields").click();
  const options = page.locator("[cmdk-item]");
  const offered = async () =>
    (await options.allTextContents()).map((text) => text.trim());
  // ANY candidate, not all: `arrayContaining` with a single `stringMatching` holds
  // when at least one offered field matches — and a failure prints the whole list
  // that WAS offered.
  await expect
    .poll(offered, {
      timeout: 30000,
      message:
        "Apply To Fields must offer one of the candidate fields. A placeholder list " +
        "(System, System Message, System Prompt) means the component catalog never " +
        "loaded; a real list without them means their components left the image — " +
        "pick another field whose component no spec places",
    })
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^(${APPLY_TO_FIELD_CANDIDATES.join("|")})$`)),
      ]),
    );
  const offeredNow = await offered();
  const field = APPLY_TO_FIELD_CANDIDATES.find((candidate) =>
    offeredNow.includes(candidate),
  ) as string; // the poll above only resolves once one is offered
  await options.filter({ hasText: new RegExp(`^\\s*${field}\\s*$`) }).click();
  // Closes the options popover only; the variable modal stays open.
  await page.keyboard.press("Escape");
  return field;
}

/**
 * Rename a variable from its Update Variable modal and assert the rename is a
 * rename: a PATCH of the same id carrying the new name, the new name in the grid
 * and the old one gone.
 */
async function renameVariable(
  page: Page,
  id: string,
  from: string,
  to: string,
): Promise<void> {
  await (await revealVariableRow(page, from)).locator(".ag-cell-value").click();
  await expect(page.getByRole("heading", { name: "Update Variable" })).toBeVisible({
    timeout: 10000,
  });
  await page.getByPlaceholder("Enter a name for the variable...").fill(to);

  const patched = page.waitForResponse(isCall("PATCH", `/api/v1/variables/${id}`));
  await page.getByTestId("save-variable-btn").click();
  const response = await patched;
  expect(response.status(), `renaming "${from}" to "${to}" must return 200`).toBe(
    200,
  );
  expect(
    await response.json(),
    "a rename must update the same variable, never create another one",
  ).toMatchObject({ id, name: to });

  await expect(await revealVariableRow(page, to)).toBeVisible();
  await expect(
    variableNameCell(page, from),
    `"${from}" must be gone from the grid after the rename`,
  ).toHaveCount(0);
}

/** Record the pathname of every DELETE the page sends to the variables API. */
function recordVariableDeletes(page: Page) {
  const paths: string[] = [];
  const onRequest = (request: Request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === "DELETE" && pathname.startsWith("/api/v1/variables/")) {
      paths.push(pathname);
    }
  };
  page.on("request", onRequest);
  return { paths, stop: () => page.off("request", onRequest) };
}

/** The documented shortcut catalog, as Settings → Shortcuts names it on 1.13 (27). */
const DOCUMENTED_SHORTCUTS = [
  "Parameters",
  "Search Components on Sidebar",
  "Minimize",
  "Code",
  "Copy",
  "Duplicate",
  "Docs",
  "Changes Save",
  "Save Component",
  "Delete",
  "Open Playground",
  "Undo",
  "Redo",
  "Redo (alternative)",
  "Group",
  "Cut",
  "Paste",
  "API",
  "Download",
  "Update",
  "Freeze",
  "Flow Share",
  "Play",
  "Output Inspection",
  "Tool Mode",
  "Toggle Sidebar",
  "AI Assistant",
];

/** The expected names absent from `listed` (cell texts, whitespace-trimmed). */
function missingFrom(expected: readonly string[], listed: string[]): string[] {
  const present = new Set(listed.map((text) => text.trim()));
  return expected.filter((name) => !present.has(name));
}

test(
  "should interact with global variables",
  { tag: ["@stable", "@release", "@workspace", "@api", "@settings"] },
  async ({ page }) => {
    const name = uniqueName();
    const renamed = uniqueName();
    const renamedAgain = uniqueName();
    let variableId = "";
    let field = "";

    await test.step("open Settings → Global Variables", async () => {
      await openSettingsSection(page, "Global Variables");
    });

    await test.step("create a Generic variable with an Apply To Fields choice", async () => {
      await page.getByTestId("api-key-button-store").click();
      await page.getByTestId("generic-tab").click();
      await page.getByPlaceholder("Enter a name for the variable...").fill(name);
      await page
        .getByPlaceholder("Enter a value for the variable...")
        .fill("user-settings-generic-value");
      field = await chooseApplyToField(page);

      const createdResponse = page.waitForResponse(isCall("POST", "/api/v1/variables/"));
      await page.getByTestId("save-variable-btn").click();
      const response = await createdResponse;
      expect(response.status(), `creating "${name}" must return 201`).toBe(201);
      const body = await response.json();
      expect(typeof body.id, `creating "${name}" returned no id`).toBe("string");
      variableId = body.id;
      created.variableIds.push(variableId);
      expect(
        body,
        "the create must save the name and the Apply To Fields choice",
      ).toMatchObject({ name, default_fields: [field] });
    });

    await test.step("the grid lists it with the chosen field", async () => {
      await expect(await revealVariableRow(page, name)).toBeVisible();
      await expect(
        variableRow(page, name).locator('[col-id="default_fields"]'),
      ).toHaveText(field);
    });

    await test.step("rename it twice from the Update Variable modal", async () => {
      await renameVariable(page, variableId, name, renamed);
      await renameVariable(page, variableId, renamed, renamedAgain);
    });

    await test.step("delete its row — and only its row", async () => {
      const deletes = recordVariableDeletes(page);
      // The row's own checkbox, never the header's: the header selects EVERY
      // variable of the account, which is the inherited test's defect.
      await variableRow(page, renamedAgain).locator(".ag-selection-checkbox").click();
      await expect(page.getByTestId("delete-row-button")).toBeEnabled({
        timeout: 5000,
      });

      const deleted = page.waitForResponse(
        isCall("DELETE", `/api/v1/variables/${variableId}`),
      );
      await page.getByTestId("delete-row-button").click();
      expect((await deleted).ok(), "deleting the row must succeed").toBe(true);
      await expect(variableNameCell(page, renamedAgain)).toHaveCount(0, {
        timeout: 15000,
      });
      deletes.stop();
      expect(
        deletes.paths,
        "deleting one row must send exactly that row's DELETE",
      ).toEqual([`/api/v1/variables/${variableId}`]);
    });
  },
);

test(
  "should see shortcuts",
  { tag: ["@stable", "@release", "@settings"] },
  async ({ page }) => {
    await test.step("open Settings → Shortcuts", async () => {
      await openSettingsSection(page, "Shortcuts");
    });

    await test.step("every documented shortcut is listed by name", async () => {
      // `.ag-row` keeps the column header ("Functionality") out of the list.
      const names = page.locator('.ag-row [col-id="display_name"]');
      await expect(names.first()).toBeVisible({ timeout: 10000 });
      await expect
        .poll(
          async () => missingFrom(DOCUMENTED_SHORTCUTS, await names.allTextContents()),
          {
            timeout: 10000,
            message: "documented shortcuts missing from Settings → Shortcuts",
          },
        )
        .toEqual([]);
    });
  },
);

test(
  "should interact with API Keys",
  { tag: ["@stable", "@release", "@api", "@settings"] },
  async ({ page }) => {
    const keyName = uniqueName();
    let apiKey = "";

    await test.step("open Settings → Langflow API Keys", async () => {
      await openSettingsSection(page, "Langflow API Keys");
    });

    await test.step("generate a key", async () => {
      await page.getByTestId("api-key-button-store").click();
      await page.getByPlaceholder("My API Key").fill(keyName);

      const createdResponse = page.waitForResponse(isCall("POST", "/api/v1/api_key/"));
      await page.getByTestId("secret_key_modal_submit_button").click(); // "Generate API Key"
      const response = await createdResponse;
      expect(response.status(), "creating the API key must return 200").toBe(200);
      const body = await response.json();
      expect(typeof body.id, "the key create returned no id").toBe("string");
      created.apiKeyIds.push(body.id);
      expect(body.name).toBe(keyName);
      expect(typeof body.api_key, "the key create returned no secret").toBe("string");
      apiKey = body.api_key;
    });

    await test.step("the key shown is the key created, and copy copies it verbatim", async () => {
      // Assertion AND readiness gate: the modal switches to this view before the
      // create answers, and copying is a silent no-op while the field is empty —
      // the race the inherited test lost (it clicked as soon as the button showed).
      await expect(page.getByTestId("api-key-input")).toHaveValue(apiKey);
      await page.getByTestId("btn-copy-api-key").click();
      await expect(page.getByText("API Key copied!", { exact: true })).toBeVisible({
        timeout: 10000,
      });
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
          message: "the clipboard must hold the generated key",
        })
        .toBe(apiKey);
    });

    await test.step("the key is listed under its name", async () => {
      await page.getByTestId("secret_key_modal_submit_button").click(); // "Done"
      await expect(
        page.locator('.ag-row [col-id="name"]').filter({ hasText: keyName }),
      ).toBeVisible({ timeout: 10000 });
    });
  },
);

test(
  "should navigate back to flow from global variables",
  { tag: ["@stable", "@release", "@workspace", "@settings"] },
  async ({ page }) => {
    let flowId = "";

    await test.step("open a flow of this test's own", async () => {
      // Over the API and by id, not through the templates modal: the modal path
      // creates a placeholder flow first and left the template flow behind on
      // every run of the inherited file.
      flowId = await createFlowFromStarter(
        page.request,
        "Basic Prompting",
        `user-settings-back ${uniqueName()}`,
      );
      created.flowIds.push(flowId);
      await openFlowById(page, flowId);
    });

    await test.step("go to Settings → Global Variables from the flow", async () => {
      await openSettingsFromMenu(page);
      await page.getByRole("link", { name: "Global Variables", exact: true }).click();
      await expect(page.getByTestId("settings_menu_header")).toContainText(
        "Global Variables",
        { timeout: 15000 },
      );
    });

    await test.step("the back button returns to that same flow", async () => {
      await page.getByTestId("back_page_button").click();
      await expect(
        page,
        "back must land on the flow the user left, not on another Settings section",
      ).toHaveURL(new RegExp(`/flow/${flowId}(?:[?#].*)?$`));
      await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
        timeout: 30000,
      });
    });
  },
);
