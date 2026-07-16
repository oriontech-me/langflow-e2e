import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";

// §2.1 Parameters Panel — field-type edit matrix. For each input type, a
// representative component is added, the field is edited in the panel, and the
// new value is proven to PERSIST by reading it back from the saved flow via the
// REST API (template.<field>.value) — reload-proof, uniform across types.
//
// Phase 1 (this spec): the six simple-mechanic types (text, dropdown, textarea,
// int, tab, toggle). The complex/modal types (slider drag, code editor, table
// modal, key-pair NestedDict, input-list SortableList, float) are a tracked
// follow-up — see docs/core-components/parameters-panel-field-types.md.

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
  await addComponentFromSidebar(page, searchTerm, addButtonTestId);
  await expect(page.getByTestId(titleTestId)).toBeVisible({ timeout: 15000 });
  return flowId;
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
        "title-timeout",
      );
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
});
