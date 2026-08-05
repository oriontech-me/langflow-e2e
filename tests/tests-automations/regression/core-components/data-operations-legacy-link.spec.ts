import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import { addComponentFromSidebar } from "../../../helpers/flows/add-component-from-sidebar";
import { addLegacyComponents } from "../../../helpers/flows/add-legacy-components";
import { seedAssistantDiscovered } from "../../../helpers/ui/assistant-onboarding";

// §3.10 Data Operations (1.11.0) — the OTHER half of the section: what happens to
// the three components the unified node replaced. JSON Operations
// (`DataOperations`), Table Operations (`DataFrameOperations`) and Text
// Operations (`TextOperations`) were kept as `legacy = True` with
// `replacement = ["processing.Operations"]`, and upstream #14118 wired that
// pointer into the UI. Per-operation coverage of the REPLACEMENT lives in
// `data-operations-component.spec.ts` (#1191).
//
// The banner text is the assertion surface, and it is sharper than a UI string
// usually is: `NodeLegacyComponent` does not print `replacement` raw — it
// resolves it through `useGetReplacementComponents`, which splits
// "processing.Operations" into category + name and looks up
// `data.processing.Operations.display_name` in the types store. Only a
// successful lookup renders `Use <display name>.`; anything else falls back to
// the literal `No direct replacement.`. So asserting the positive string proves
// the whole chain, and asserting the fallback's ABSENCE is what catches the
// silent degradation a rename would cause (the node still renders, nothing
// errors).
//
// Not to be confused with
// `flow-functionality/general-bugs-frontend-crashing-on-invalid-replace.spec.ts`,
// which proves the fallback path itself works for a custom component with a
// bogus replacement. That one asserts the fallback happens; this one asserts
// these three components are not on it.
//
// No provider key, no models.json. See
// docs/core-components/data-operations-legacy-link.md.

const REPLACEMENT_BANNER = "Use Data Operations.";
// The literal `NodeLegacyComponent` renders when the replacement pointer cannot
// be resolved to a component in the types store.
const UNRESOLVED_BANNER = "No direct replacement.";

// The three legacy components of §3.10, with the sidebar handles scouted live.
// Their testids keep the ORIGINAL class names (`TextOperations`, …), never
// `Operations` — so they can never collide with the unified component's.
// `label` is the human name (step titles, failure messages); every other field is
// a selector. Keeping them apart matters here because the display name and its
// testid differ only by a prefix, and interpolating the testid into a step title
// is what makes a Playwright report read `title-JSON Operations carries …`.
const LEGACY_COMPONENTS = [
  {
    label: "JSON Operations",
    search: "json operations",
    addButton: "add-component-button-json-operations",
    titleTestId: "title-JSON Operations",
  },
  {
    label: "Table Operations",
    search: "table operations",
    addButton: "add-component-button-table-operations",
    titleTestId: "title-Table Operations",
  },
  {
    label: "Text Operations",
    search: "text operations",
    addButton: "add-component-button-text-operations",
    titleTestId: "title-Text Operations",
  },
] as const;

// Named rather than indexed at the call sites: which legacy component a test
// drives is part of what the test means, and `LEGACY_COMPONENTS[2]` hides it.
const JSON_OPERATIONS = LEGACY_COMPONENTS[0];
const TEXT_OPERATIONS = LEGACY_COMPONENTS[2];

// Ids of the flows each test creates via the REST API — deleted id-scoped in
// afterEach (#490/#681/#515), never a global/name/diff-scoped wipe (#553).
const createdFlowIds: string[] = [];

// Before the first document load — the only point at which the assistant
// onboarding tooltip can be suppressed (#1220). It overlays canvas chrome, and
// test 2 clicks inside a node's banner.
test.beforeEach(async ({ page }) => {
  await seedAssistantDiscovered(page);
});

test.afterEach(async ({ page, request }) => {
  const ids = createdFlowIds.splice(0);
  if (ids.length === 0) return;
  // Leave the editor before deleting: a mounted editor keeps polling
  // `GET /flows/{id}/events` and 404s once the flow is gone, which the fixture
  // logs as `🚨 Backend Error` (#1023/#1103/#1288).
  await unmountEditorForCleanup(page);
  const bearer = await getAuthToken(request);
  for (const id of ids) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } });
  }
});

// Create a blank flow through the REST API (unique name → parallel-safe), open
// it, and optionally reveal the legacy components in the sidebar.
//
// `showLegacy` is localStorage-backed (`getBooleanFromStorage("showLegacy",
// false)`, flowSidebarComponent), so flipping it is scoped to this browser
// context and cannot reach a parallel worker — which is also why test 3 can rely
// on the OFF default without resetting anything.
async function openFlowWithLegacy(
  page: Page,
  request: APIRequestContext,
  bearer: string,
  { enableLegacy = false }: { enableLegacy?: boolean } = {},
): Promise<string> {
  const flowId = await createFlow(
    request,
    {
      name: `Legacy Ops ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  if (enableLegacy) await addLegacyComponents(page);
  return flowId;
}

// Add one component and gate on the node count, so a component that never
// arrives fails here — naming the component — instead of further down in an
// assertion about a node that was never added.
async function addNode(
  page: Page,
  search: string,
  addButton: string,
): Promise<void> {
  const before = await page.locator(".react-flow__node").count();
  await addComponentFromSidebar(page, search, addButton);
  await expect(
    page.locator(".react-flow__node"),
    `adding "${search}" should put one more node on the canvas`,
  ).toHaveCount(before + 1, { timeout: 15000 });
}

// Locate a node by its own title testid — the three nodes are added stacked and
// are never told apart by position.
function nodeByTitleTestId(page: Page, titleTestId: string): Locator {
  return page
    .locator(".react-flow__node")
    .filter({ has: page.getByTestId(titleTestId) });
}

test(
  "All three legacy operations components name Data Operations as their replacement",
  { tag: ["@stable", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const bearer = await getAuthToken(request);

    await test.step("Open a flow with the legacy components revealed", async () => {
      await openFlowWithLegacy(page, request, bearer, { enableLegacy: true });
    });

    await test.step("Add JSON, Table and Text Operations", async () => {
      for (const component of LEGACY_COMPONENTS) {
        await addNode(page, component.search, component.addButton);
      }
      // The nodes are deliberately left stacked: this test only reads text and
      // testids inside each node, so the pointer-interception problem that
      // forces `separateOverlappingNodes` elsewhere does not apply.
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
    });

    for (const component of LEGACY_COMPONENTS) {
      await test.step(`${component.label} carries the Legacy banner pointing at Data Operations`, async () => {
        const node = nodeByTitleTestId(page, component.titleTestId);
        await expect(
          node,
          `${component.label} should be on the canvas exactly once`,
        ).toHaveCount(1, { timeout: 15000 });
        // The banner itself — its Dismiss control is the only testid it exposes.
        await expect(node.getByTestId("dismiss-warning-bar")).toBeAttached({
          timeout: 15000,
        });
        // The pointer RESOLVED: `useGetReplacementComponents` found
        // `processing.Operations` in the types store and rendered its display
        // name.
        await expect(node).toContainText(REPLACEMENT_BANNER, {
          timeout: 15000,
        });
        // …and did not degrade to the fallback, which is what a renamed or moved
        // replacement would silently produce.
        await expect(node).not.toContainText(UNRESOLVED_BANNER);
      });
    }
  },
);

test(
  "The legacy banner link filters the sidebar to Data Operations",
  { tag: ["@stable", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const bearer = await getAuthToken(request);

    await test.step("Open a flow with one legacy JSON Operations node", async () => {
      await openFlowWithLegacy(page, request, bearer, { enableLegacy: true });
      await addNode(page, JSON_OPERATIONS.search, JSON_OPERATIONS.addButton);
    });

    await test.step("Click the Data Operations link inside the banner", async () => {
      const node = nodeByTitleTestId(page, JSON_OPERATIONS.titleTestId);
      // The link carries no testid; match it by accessible name, scoped to the
      // node so it can never resolve to the sidebar entry of the same name.
      await node
        .getByRole("button", { name: "Data Operations", exact: true })
        .click();
    });

    await test.step("The sidebar is filtered to the replacement, not to the legacy origin", async () => {
      // `setFilterComponent` puts the sidebar in filtered mode — the reset
      // control only exists while a filter is active.
      await expect(page.getByTestId("sidebar-filter-reset")).toBeVisible({
        timeout: 15000,
      });
      await expect(
        page.getByTestId("add-component-button-data-operations"),
      ).toBeVisible({ timeout: 15000 });
      // The negative half: the filter narrowed to the REPLACEMENT. Without it
      // the assertion would also pass on a sidebar that simply showed both.
      await expect(page.getByTestId(JSON_OPERATIONS.addButton)).toHaveCount(0);
    });
  },
);

test(
  "Searching a legacy operations name surfaces Data Operations with legacy components hidden",
  { tag: ["@stable", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const bearer = await getAuthToken(request);

    await test.step("Open a flow with the Legacy toggle in its default OFF state", async () => {
      // No `enableLegacy`: the point of this test is the default experience.
      await openFlowWithLegacy(page, request, bearer);
    });

    for (const component of LEGACY_COMPONENTS) {
      await test.step(`Searching "${component.search}" offers Data Operations only`, async () => {
        await page.getByTestId("sidebar-search-input").fill(component.search);
        // The unified component carries the three legacy names in
        // `metadata.keywords` (operations.py), so the old name leads to the
        // replacement even for a user who never enables the Legacy toggle.
        await expect(
          page.getByTestId("add-component-button-data-operations"),
        ).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId(component.addButton)).toHaveCount(0);
      });
    }
  },
);

test(
  "A legacy operations component still builds and returns its result",
  { tag: ["@stable", "@components", "@ui-ux"] },
  async ({ page, request }) => {
    const bearer = await getAuthToken(request);
    const TEXT = "legacy still works abc123";

    await test.step("Open a flow with one legacy Text Operations node", async () => {
      await openFlowWithLegacy(page, request, bearer, { enableLegacy: true });
      await addNode(page, TEXT_OPERATIONS.search, TEXT_OPERATIONS.addButton);
    });

    const node = page.locator(".react-flow__node").first();

    await test.step("Configure Case Conversion → uppercase", async () => {
      await node.getByTestId("textarea_str_text_input").fill(TEXT);
      await node
        .getByTestId(
          "button_open_list_selection_sortablelist_sortablelist_operation",
        )
        .click();
      await page.getByTestId("list_item_case_conversion").click();
      await expect(page.getByTestId("list_item_case_conversion")).toHaveCount(
        0,
        { timeout: 15000 },
      );
      await node.getByTestId("value-dropdown-dropdown_str_case_type").click();
      await page.getByRole("option", { name: "uppercase", exact: true }).click();
      await expect(
        node.getByTestId("value-dropdown-dropdown_str_case_type"),
      ).toHaveText("uppercase", { timeout: 15000 });
    });

    await test.step("Run the legacy node and assert its Message output", async () => {
      // Dispatched at the event level: the node's controls can sit under
      // `main_canvas_controls` / the build toast, which intercept hit-tested
      // clicks. The assertion right after is the guard against a no-op dispatch
      // (same pattern as `data-operations-component.spec.ts`).
      await node.getByTestId("button_run_text operations").dispatchEvent("click");
      await expect(
        node.getByTestId("node_duration_text operations"),
      ).toBeVisible({ timeout: 60000 });

      // The output testid keeps the LEGACY class name (`textoperations`), which
      // is what makes it distinguishable from the unified component's.
      await node
        .getByTestId("output-inspection-message-textoperations")
        .dispatchEvent("click");
      const modal = page.locator('[role="dialog"]').last();
      await expect(modal).toBeVisible({ timeout: 15000 });
      // `text_operations.py` → `_case_conversion` → `str.upper`.
      await expect(modal.locator("textarea").first()).toHaveValue(
        TEXT.toUpperCase(),
        { timeout: 15000 },
      );

      await page.getByTestId("btn-close-modal").click();
      await expect(page.getByTestId("btn-close-modal")).toHaveCount(0, {
        timeout: 15000,
      });
    });
  },
);
