import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { addLegacyComponents } from "../../../helpers/flows/add-legacy-components";

// §2.1 Parameters Panel — field-type edit matrix. For each input type, a
// representative component is added, the field is edited in the panel, and the
// new value is proven to PERSIST by reading it back from the saved flow via the
// REST API (template.<field>.value) — reload-proof, uniform across types.
//
// Phase 1 (#662): six simple-mechanic types (text, dropdown, textarea, int, tab,
// toggle). Phase 2 (#795): float + slider. Phase 3 (#798, below): the four
// modal/complex types — code (ACE editor), table (modal), key-pair (NestedDict
// editor) and input list (SortableList). Two phase-3 components (Python Function,
// Alter Metadata) are `legacy` and need the sidebar Legacy toggle enabled;
// `headers` and `storage_location` are `advanced` fields — shown by default on
// some nightly builds, hidden on others, so the tests reveal them when hidden
// (ensureAdvancedFieldVisible). See docs/core-components/parameters-panel-field-types.md.

// Ids of flows created by each test — deleted id-scoped in afterEach (repo
// convention #490/#681).
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// Create a blank flow via the API (parallel-safe unique name), open it, and add
// the component under test from the sidebar. Returns the flow id.
async function openFlowWithComponent(
  page: Page,
  request: APIRequestContext,
  bearer: string,
  searchTerm: string,
  addButtonTestId: string,
  titleTestId: string,
  opts: { enableLegacy?: boolean } = {},
): Promise<string> {
  const flowId = await createFlow(
    request,
    {
      name: `Params Panel ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      description: "",
      data: { nodes: [], edges: [] },
      is_component: false,
    },
    { headers: { Authorization: bearer } },
  );
  createdFlowIds.push(flowId);

  await page.goto(`/flow/${flowId}`);
  await page
    .getByTestId("sidebar-search-input")
    .waitFor({ state: "visible", timeout: 60000 });
  // Legacy components (Python Function, Alter Metadata) are hidden from the
  // sidebar until the Legacy toggle is on — flip it before searching.
  if (opts.enableLegacy) await addLegacyComponents(page);
  await addComponentFromSidebar(page, searchTerm, addButtonTestId);
  await expect(page.getByTestId(titleTestId)).toBeVisible({ timeout: 15000 });
  return flowId;
}

// Locate a modal (Radix Dialog) by its heading — several dialogs render
// role="dialog" into body-level portals, so scope by the DialogTitle to pin the
// identity. Mirrors the tableDialog helper in api-request-component-regression.
function dialogByHeading(page: Page, title: string): Locator {
  return page
    .locator('[role="dialog"]')
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

// Fill an ag-grid table cell via the "View Text" editor, then assert the value
// renders back in that same cell. Coordinate-clicking the cell is required —
// the grid cell is not a plain input. Mirrors api-request-component-regression.
async function fillTableTextCell(
  page: Page,
  cellLocator: Locator,
  value: string,
): Promise<void> {
  await expect(async () => {
    if (!(await page.getByTestId("textarea").isVisible())) {
      let coords: { x: number; y: number } | null = null;
      try {
        coords = await cellLocator.evaluate((el: Element) => {
          const rect = el.getBoundingClientRect();
          return rect.width
            ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
            : null;
        });
      } catch {
        coords = null;
      }
      if (!coords) throw new Error("Cell not found or not rendered");
      await page.mouse.click(coords.x, coords.y);
      await expect(page.getByTestId("textarea")).toBeAttached({ timeout: 2000 });
    }
    await page.getByTestId("textarea").fill(value, { timeout: 2000 });
    const saveCoords = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const vt = dialogs.find((d) =>
        d.querySelector('[data-testid="textarea"]'),
      );
      if (!vt) return null;
      const btn = Array.from(vt.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Save"),
      );
      if (!btn) return null;
      const rect = (btn as HTMLElement).getBoundingClientRect();
      return rect.width
        ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        : null;
    });
    if (!saveCoords) throw new Error("Save button not found in View Text dialog");
    await page.mouse.click(saveCoords.x, saveCoords.y);
    await expect(page.getByTestId("textarea")).toHaveCount(0, { timeout: 3000 });
    await expect(
      cellLocator.getByRole("button", { name: value, exact: true }),
    ).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 40000 });
}

// Advanced fields render on the node by default on some nightly builds and are
// hidden (opt-in via the component-parameters panel) on others — the nightly
// flip-flops this. Make the field present regardless: use it directly when
// already shown, otherwise reveal it via the panel's "Add <field>" control.
async function ensureAdvancedFieldVisible(
  page: Page,
  checkTestId: string,
  fieldName: string,
): Promise<void> {
  try {
    await page
      .getByTestId(checkTestId)
      .waitFor({ state: "visible", timeout: 4000 });
    return; // already shown on this build
  } catch {
    // hidden on this build — reveal it below
  }
  await page.getByTestId("parameters-button").click();
  await page.getByTestId(`inspector-add-${fieldName}`).click();
  await page.getByTestId("parameters-button").click(); // close the panel
  await page
    .getByTestId(checkTestId)
    .waitFor({ state: "visible", timeout: 10000 });
}

// Read a field's persisted value from the saved flow (single-node flows, so
// nodes[0]). The durable proof the edit was accepted AND autosaved.
async function readFieldValue(
  request: APIRequestContext,
  bearer: string,
  flowId: string,
  field: string,
): Promise<unknown> {
  const res = await request.get(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: bearer },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    data: { nodes: Array<{ data: { node: { template: Record<string, { value: unknown }> } } }> };
  };
  return body.data.nodes[0]?.data?.node?.template?.[field]?.value;
}

// Poll the saved flow until the field reflects the edit (autosave is debounced).
async function expectPersisted(
  request: APIRequestContext,
  bearer: string,
  flowId: string,
  field: string,
  expected: unknown,
): Promise<void> {
  await expect
    .poll(() => readFieldValue(request, bearer, flowId, field), {
      timeout: 15000,
    })
    .toEqual(expected);
}

test.describe("Parameters Panel — field-type edit matrix", () => {
  test(
    "text input field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "API Request",
        "add-component-button-api-request",
        "title-url",
      );
      const url = "https://httpbin.org/get";
      await page.getByTestId("popover-anchor-input-url_input").fill(url);
      await page.getByTestId("popover-anchor-input-url_input").blur();
      await expectPersisted(request, bearer, flowId, "url_input", url);
    },
  );

  test(
    "dropdown field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "API Request",
        "add-component-button-api-request",
        "title-method",
      );
      await page.getByTestId("dropdown_str_method").click();
      await page.getByTestId("POST-1-option").click();
      await expectPersisted(request, bearer, flowId, "method", "POST");
    },
  );

  test(
    "textarea field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "API Request",
        "add-component-button-api-request",
        "title-method",
      );
      // The cURL multiline field only renders under the cURL tab.
      await page.getByTestId("tab_1_curl").click();
      const curl = "curl https://httpbin.org/post -X POST";
      await page.getByTestId("textarea_str_curl_input").fill(curl);
      await page.getByTestId("textarea_str_curl_input").blur();
      await expectPersisted(request, bearer, flowId, "curl_input", curl);
    },
  );

  test(
    "int field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "API Request",
        "add-component-button-api-request",
        "title-API Request",
      );
      // `timeout` is advanced — shown by default on some nightly builds, hidden
      // on others; reveal it when hidden.
      await ensureAdvancedFieldVisible(page, "int_int_timeout", "timeout");
      await page.getByTestId("int_int_timeout").fill("77");
      await page.getByTestId("int_int_timeout").blur();
      await expectPersisted(request, bearer, flowId, "timeout", 77);
    },
  );

  test(
    "tab field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "API Request",
        "add-component-button-api-request",
        "title-mode",
      );
      // Default tab is "URL" (mode="URL"); switch to the cURL tab.
      await page.getByTestId("tab_1_curl").click();
      await expectPersisted(request, bearer, flowId, "mode", "cURL");
    },
  );

  test(
    "toggle field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "Save File",
        "add-component-button-write-file",
        "title-append",
      );
      // append_mode defaults to false; clicking the switch flips it to true.
      await page.getByTestId("toggle_bool_append_mode").click();
      await expectPersisted(request, bearer, flowId, "append_mode", true);
    },
  );

  // ---- Phase 2 (#795): float + slider ----

  test(
    "float field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "Semantic Text Splitter",
        "add-component-button-semantic-text-splitter",
        "title-breakpoint threshold amount",
      );
      await page
        .getByTestId("float_float_breakpoint_threshold_amount")
        .fill("0.42");
      await page.getByTestId("float_float_breakpoint_threshold_amount").blur();
      await expectPersisted(
        request,
        bearer,
        flowId,
        "breakpoint_threshold_amount",
        0.42,
      );
    },
  );

  test(
    "slider field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "Language Model",
        "add-component-button-language-model",
        "title-Language Model",
      );
      // temperature is advanced — shown by default on some nightly builds, hidden
      // on others; reveal it when hidden. It defaults to 0.1; focus the thumb and
      // step it up with the keyboard (deterministic, unlike a pixel drag). Assert
      // it increased — step-agnostic so a future step change does not false-fail.
      await ensureAdvancedFieldVisible(page, "slider_thumb", "temperature");
      await page.getByTestId("slider_thumb").click();
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
      await expect
        .poll(
          () => readFieldValue(request, bearer, flowId, "temperature"),
          { timeout: 15000 },
        )
        .toBeGreaterThan(0.1);
    },
  );

  // ---- Phase 3 (#798): code, table, key-pair, input list ----

  test(
    "code field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "Python Function",
        "add-component-button-python-function",
        "title-Python Function",
        { enableLegacy: true },
      );
      // CodeInput opens an ACE editor modal; fill() does not reach ACE, so set
      // the value through ACE's API, then Save (which runs a Python syntax
      // check — the code must be valid).
      const code =
        'def python_function() -> str:\n    return "E2E_CODE_SENTINEL"\n';
      await page.getByTestId("codearea_code_function_code").click();
      await expect(page.getByTestId("checkAndSaveBtn")).toBeVisible({
        timeout: 15000,
      });
      await page
        .locator(".ace_editor")
        .waitFor({ state: "visible", timeout: 10000 });
      await page.evaluate((value) => {
        const w = window as unknown as {
          ace: {
            edit: (el: Element | null) => {
              setValue: (v: string, cursor: number) => void;
            };
          };
        };
        w.ace.edit(document.querySelector(".ace_editor")).setValue(value, -1);
      }, code);
      await page.getByTestId("checkAndSaveBtn").click();
      await expectPersisted(request, bearer, flowId, "function_code", code);
    },
  );

  test(
    "table field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "API Request",
        "add-component-button-api-request",
        "title-API Request",
      );
      // `headers` is an advanced TableInput — ensure it is shown (reveal it if
      // this build hides advanced fields).
      await ensureAdvancedFieldVisible(page, "div-table_headers", "headers");

      // Settle the node's TableNodeComponent `[value]` effects before touching
      // the grid: switch method to POST and wait for the component-refresh POST.
      // Without this, the grid drops the add-row click / fails to commit cells
      // (mirrors the settle in api-request-component-regression).
      await page.getByTestId("dropdown_str_method").click();
      const refresh = page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/custom_component/update") &&
          r.request().method() === "POST",
        { timeout: 15000 },
      );
      await page.getByTestId("POST-1-option").click();
      await refresh;

      const headersDiv = page.getByTestId("div-table_headers");
      await expect(headersDiv).toBeVisible({ timeout: 15000 });
      await headersDiv.getByRole("button", { name: "Open table" }).click();

      const dialog = dialogByHeading(page, "Headers");
      await expect(dialog).toBeVisible({ timeout: 10000 });
      const dataRows = dialog.locator('[role="treegrid"] [role="row"][row-id]');
      await expect(dataRows).toHaveCount(1, { timeout: 10000 });
      // The grid can drop the add-row click while its TableNodeComponent effects
      // are still settling (#868), so the row count stays 1. Retry the click only
      // while the row has not appeared (the count<2 guard prevents a late-
      // registering click from adding a second, overshooting row).
      await expect(async () => {
        if ((await dataRows.count()) < 2) {
          await dialog.getByTestId("add-row-button").click();
        }
        await expect(dataRows).toHaveCount(2, { timeout: 3000 });
      }).toPass({ timeout: 15000 });

      const newRow = dataRows.last();
      await fillTableTextCell(
        page,
        newRow.locator('[col-id="key"]'),
        "X-E2E-Header",
      );
      await fillTableTextCell(
        page,
        newRow.locator('[col-id="value"]'),
        "e2e-header-value",
      );
      // Save (not Cancel) commits the edited rows so autosave persists them.
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).not.toBeVisible({ timeout: 5000 });

      // headers.value is an array of {key,value} rows — assert the new row landed.
      await expect
        .poll(
          async () => {
            const v = await readFieldValue(request, bearer, flowId, "headers");
            return (
              Array.isArray(v) &&
              (v as Array<{ key?: string; value?: string }>).some(
                (h) =>
                  h.key === "X-E2E-Header" && h.value === "e2e-header-value",
              )
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
    },
  );

  test(
    "key-pair field edit persists",
    { tag: ["@stable", "@components", "@regression"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      const flowId = await openFlowWithComponent(
        page,
        request,
        bearer,
        "Alter Metadata",
        "add-component-button-alter-metadata",
        "title-Alter Metadata",
        { enableLegacy: true },
      );
      // NestedDictInput opens an "Edit Dictionary" editor; set the JSON in text
      // mode (fill avoids the code editor's bracket auto-close) and Save.
      await page
        .locator('button[data-testid="dict_nesteddict_metadata"]')
        .click();
      const dictDialog = dialogByHeading(page, "Edit Dictionary");
      await expect(dictDialog).toBeVisible({ timeout: 10000 });
      // Fill the JSON in text mode, then switch to tree mode BEFORE saving —
      // the mode switch parses and commits the text into the editor's model, so
      // Save persists it (filling alone leaves the model on its "{}" default and
      // Save writes an empty object).
      const editor = dictDialog.getByRole("textbox");
      await editor.fill('{"e2e_key": "E2E_META_SENTINEL"}');
      await dictDialog
        .locator('button[title^="Switch to tree mode"]')
        .click();
      await expect(dictDialog.getByText("e2e_key", { exact: true })).toBeVisible({
        timeout: 5000,
      });
      await dictDialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dictDialog).not.toBeVisible({ timeout: 5000 });
      // metadata.value is an object — assert the edited key→value pair.
      await expectPersisted(request, bearer, flowId, "metadata", {
        e2e_key: "E2E_META_SENTINEL",
      });
    },
  );

  // Input list (`SortableListInput` — Read File `storage_location`) is deferred:
  // its edit mechanic (remove the pre-selected chip → open selection → pick a new
  // option) diverges across nightly builds — the remove control renders as
  // `icon-x` on some and is absent on others — and could not be validated on the
  // build the daily currently runs. Tracked as a follow-up.
});
