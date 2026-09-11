import type { Page } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// QA-CHECKLIST §15.7 Freeze and State. Freeze is an EXECUTION-CACHE control, not a
// visual state: a frozen component must serve its cached output instead of
// recomputing. Measured on 1.12.0.dev8, the product exposes exactly ONE affordance
// (label "Freeze", shortcut F) whose semantics are PATH freeze — it marks the target
// node and every upstream ancestor. Checklist items "Freeze component" and "Freeze
// path" are therefore the same control, told apart by which node is clicked.
//
// Same asset as core-components/nested-grouping-regression.spec.ts: two connected
// non-IO components with explicit positions. Prompt Template is the fixture on
// purpose — it is non-legacy, runs standalone, and its output is deterministically
// its own template text, which is what makes the cache assertion possible with no
// provider key and no model call.
const FLOW_ASSET = path.resolve(
  __dirname,
  "../../../assets/flows/two-non-io-connected.json",
);

// One testid, but its LOCATION depends on the component. In
// `nodeToolbarComponent/index.tsx` the two renders are mutually exclusive:
//
//   {!hasToolMode && <ToolbarButton  … dataTestId="freeze-all-button-modal" />}
//   { hasToolMode && <SelectItem value="freezeAll" data-testid="freeze-all-button-modal">}
//
// So a tool-mode component (Prompt Template) exposes Freeze ONLY in its
// right-click menu, and a component without tool mode (Language Model) ONLY in
// its selection toolbar. Verified on 1.12.0.dev8 in both directions. This is why
// each test states where it expects the control instead of using a `.first()`
// that silently resolves to whichever happens to be mounted.
const FREEZE_CONTROL = "freeze-all-button-modal";

// `icon-Snowflake` is the CANVAS indicator, one per frozen node. `icon-FreezeAll` is
// the control's own icon and is NOT a frozen-state signal — with a node frozen and
// no menu open, Snowflake is 1 and FreezeAll is 0. Asserting the latter is what made
// the inherited freeze.spec.ts a false green (#943).
const FROZEN_INDICATOR = ".react-flow__node [data-testid='icon-Snowflake']";

async function createTwoNodeFlow(page: Page): Promise<string> {
  const raw = JSON.parse(readFileSync(FLOW_ASSET, "utf-8"));
  const body = {
    ...raw,
    name: `freeze-and-state-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`,
  };

  const authToken = await getAuthToken(page.request);
  const res = await page.request.post("/api/v1/flows/", {
    headers: authToken ? { Authorization: authToken } : {},
    data: body,
  });
  if (res.status() !== 201) {
    throw new Error(
      `Flow creation failed: ${res.status()} — ${await res.text()}`,
    );
  }
  const { id } = (await res.json()) as { id: string };

  // Going via the dashboard avoids the stale-cache redirect that
  // `page.goto("/flow/${id}")` triggers right after an API-created flow.
  await page.goto("/");
  await page
    .getByTestId("list-card")
    .filter({
      has: page.getByTestId("flow-name-div").filter({ hasText: body.name }),
    })
    .getByTestId("list-card-open-button")
    .first()
    .click();
  await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId("title-Prompt Template")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByTestId("title-Language Model")).toBeVisible({
    timeout: 15000,
  });
  await adjustScreenView(page);
  return id;
}

// Server truth for the frozen flags, keyed by node id. Canvas mutations are
// autosaved on a debounce, so every backend assertion polls through this — a single
// GET right after the click still returns the pre-click state.
async function readFrozenFlags(
  page: Page,
  flowId: string,
): Promise<Record<string, boolean>> {
  const authToken = await getAuthToken(page.request);
  const res = await page.request.get(`/api/v1/flows/${flowId}`, {
    headers: authToken ? { Authorization: authToken } : {},
  });
  if (!res.ok()) return {};
  const body = (await res.json()) as {
    data?: { nodes?: Array<{ id: string; data?: { node?: { frozen?: boolean } } }> };
  };
  return Object.fromEntries(
    (body.data?.nodes ?? []).map((n) => [n.id, n.data?.node?.frozen === true]),
  );
}

/**
 * The persisting write, awaited instead of guessed at.
 *
 * The canvas is optimistic and the autosave is debounced: measured on
 * `1.13.0.dev9`, a toggle flips `icon-Snowflake` in ~110 ms while the PATCH that
 * persists it is issued ~2.1 s later. Polling `GET /api/v1/flows/{id}` against a
 * fixed budget therefore asserts a write nothing waited for — and when that write
 * ran late (#1791, on the 2-worker CI lane) the poll expired with the canvas
 * already released and the server still frozen. That reads as a freeze-propagation
 * defect and is not one: the same PATCH, once it lands, writes the expected flags,
 * which is what a forced 25 s delay on exactly this request reproduced.
 *
 * Arm it BEFORE the click, await it before reading the server. It weakens nothing —
 * a write that never happens now fails HERE, naming the PATCH that never came,
 * instead of surfacing 20 s later as a deep-equality diff that blames the product.
 * Matching on the payload's own flags rather than on any PATCH to this flow is
 * deliberate: a debounced write still in flight from an earlier edit (the template
 * rewrite in the third test) would otherwise satisfy the wait.
 */
function awaitFrozenWrite(
  page: Page,
  flowId: string,
  expected: Record<string, boolean>,
): Promise<unknown> {
  return page.waitForResponse(
    (res) => {
      if (res.request().method() !== "PATCH") return false;
      if (new URL(res.url()).pathname !== `/api/v1/flows/${flowId}`) return false;
      if (!res.ok()) return false;
      let body: {
        data?: { nodes?: Array<{ id: string; data?: { node?: { frozen?: boolean } } }> };
      };
      try {
        body = JSON.parse(res.request().postData() ?? "");
      } catch {
        return false;
      }
      const flags = Object.fromEntries(
        (body.data?.nodes ?? []).map((n) => [n.id, n.data?.node?.frozen === true]),
      );
      return Object.entries(expected).every(([id, value]) => flags[id] === value);
    },
    { timeout: 60000 },
  );
}

// The control toggles: the same entry unfreezes, and its label stays "Freeze" even
// while the node is frozen — it never reads "Unfreeze".
//
// Tool-mode component: Freeze lives in the right-click menu and NOT in the toolbar.
// Both halves are asserted, so a future move of the entry fails loudly here instead
// of silently changing what the test drives.
async function toggleFreezeFromContextMenu(
  page: Page,
  nodeTitleTestId: string,
): Promise<void> {
  await page.getByTestId(nodeTitleTestId).click();
  await expect(page.getByTestId(FREEZE_CONTROL)).toHaveCount(0);

  await page.getByTestId(nodeTitleTestId).click({ button: "right" });
  const control = page
    .locator("[data-radix-popper-content-wrapper]")
    .getByTestId(FREEZE_CONTROL);
  await expect(control).toBeVisible({ timeout: 5000 });
  await control.click();
  await expect(
    page.locator("[data-radix-popper-content-wrapper]"),
  ).toHaveCount(0, { timeout: 10000 });
}

// Component without tool mode: Freeze lives in the selection toolbar and NOT in the
// right-click menu.
async function toggleFreezeFromToolbar(
  page: Page,
  nodeTitleTestId: string,
): Promise<void> {
  await page.getByTestId(nodeTitleTestId).click();
  const control = page.getByTestId(FREEZE_CONTROL);
  await expect(control).toBeVisible({ timeout: 10000 });
  await control.click();
}

// Runs a single component from its node and returns the text its output panel shows.
async function runComponentAndReadOutput(
  page: Page,
  runTestId: string,
  outputTestId: string,
): Promise<string> {
  await page.getByTestId(runTestId).click();
  await page.getByTestId(outputTestId).click();
  const output = page.locator("[role=dialog] textarea").first();
  await expect(output).toBeVisible({ timeout: 30000 });
  const text = (await output.inputValue()).trim();
  await page.getByTestId("btn-close-modal").click();
  await expect(page.locator("[role=dialog]")).toHaveCount(0, { timeout: 10000 });
  return text;
}

// Rewrites the Prompt Template's text through its edit modal.
async function setPromptTemplate(page: Page, value: string): Promise<void> {
  await page.getByTestId("button_open_prompt_modal").first().click();
  const editor = page.getByTestId("modal-promptarea_prompt_template");
  await expect(editor).toBeVisible({ timeout: 10000 });
  await editor.fill(value);
  await page.getByTestId("genericModalBtnSave").click();
  await expect(page.locator("[role=dialog]")).toHaveCount(0, { timeout: 10000 });
}

const PROMPT_NODE = "Prompt-t2oaK";
const MODEL_NODE = "LanguageModelComponent-FLeYF";
const RUN_PROMPT = "button_run_prompt template";
const INSPECT_PROMPT = "output-inspection-prompt-prompt";

test.describe.configure({ mode: "serial" });

test.describe("Freeze and State", () => {
  let createdFlowId: string | null = null;

  test.afterEach(async ({ page }) => {
    if (createdFlowId) {
      await deleteFlow(page.request, createdFlowId);
      createdFlowId = null;
    }
  });

  test(
    "a frozen component serves its cached output instead of recomputing",
    {
      tag: [
        "@stable",
        "@release",
        "@regression",
        "@components",
        "@workspace",
        "@ui-ux",
      ],
    },
    async ({ page }) => {
      const sentinel = `FROZEN-SENTINEL-${Date.now()}`;
      let cachedOutput = "";

      await test.step("Create the two-node flow and run the Prompt Template once to populate its cache", async () => {
        createdFlowId = await createTwoNodeFlow(page);
        cachedOutput = await runComponentAndReadOutput(
          page,
          RUN_PROMPT,
          INSPECT_PROMPT,
        );
        // The Prompt Template's output IS its template text — this is what makes
        // the assertion below deterministic without a model.
        expect(cachedOutput.length).toBeGreaterThan(0);
        expect(cachedOutput).not.toContain(sentinel);
      });

      await test.step("Change the template to a sentinel and confirm the new value reached the backend", async () => {
        await setPromptTemplate(page, sentinel);
        await expect
          .poll(
            async () => {
              const authToken = await getAuthToken(page.request);
              const res = await page.request.get(
                `/api/v1/flows/${createdFlowId}`,
                { headers: authToken ? { Authorization: authToken } : {} },
              );
              if (!res.ok()) return null;
              const body = (await res.json()) as {
                data?: {
                  nodes?: Array<{
                    id: string;
                    data?: { node?: { template?: { template?: { value?: string } } } };
                  }>;
                };
              };
              return (
                body.data?.nodes?.find((n) => n.id === PROMPT_NODE)?.data?.node
                  ?.template?.template?.value ?? null
              );
            },
            { timeout: 20000, message: "the new template text should persist" },
          )
          .toBe(sentinel);
      });

      await test.step("Freeze the Prompt Template and assert the frozen state on canvas and on the server", async () => {
        const written = awaitFrozenWrite(page, createdFlowId!, {
          [PROMPT_NODE]: true,
          [MODEL_NODE]: false,
        });
        await toggleFreezeFromContextMenu(page, "title-Prompt Template");

        await expect(page.locator(FROZEN_INDICATOR)).toHaveCount(1, {
          timeout: 10000,
        });
        await written;
        // Only this node freezes: it is the upstream-most component, so its path
        // is itself. The downstream model must stay untouched.
        await expect
          .poll(async () => readFrozenFlags(page, createdFlowId!), {
            timeout: 20000,
            message: "only the Prompt Template should be frozen",
          })
          .toEqual({ [PROMPT_NODE]: true, [MODEL_NODE]: false });
      });

      await test.step("Run it again — the output must still be the cached one, not the sentinel", async () => {
        const outputWhileFrozen = await runComponentAndReadOutput(
          page,
          RUN_PROMPT,
          INSPECT_PROMPT,
        );
        // The stored input is the sentinel; serving the OLD text is the only
        // observable that proves the cached result was reused.
        expect(outputWhileFrozen).toBe(cachedOutput);
        expect(outputWhileFrozen).not.toContain(sentinel);
      });
    },
  );

  test(
    "freezing a component also freezes every component upstream of it",
    {
      tag: [
        "@stable",
        "@release",
        "@regression",
        "@components",
        "@workspace",
        "@ui-ux",
      ],
    },
    async ({ page }) => {
      await test.step("Create the two-node flow and confirm nothing starts frozen", async () => {
        createdFlowId = await createTwoNodeFlow(page);
        await expect(page.locator(FROZEN_INDICATOR)).toHaveCount(0);
        await expect
          .poll(async () => readFrozenFlags(page, createdFlowId!), {
            timeout: 20000,
            message: "the fresh flow should have no frozen node",
          })
          .toEqual({ [PROMPT_NODE]: false, [MODEL_NODE]: false });
      });

      let frozenWritten: Promise<unknown>;

      await test.step("Freeze the DOWNSTREAM Language Model", async () => {
        frozenWritten = awaitFrozenWrite(page, createdFlowId!, {
          [PROMPT_NODE]: true,
          [MODEL_NODE]: true,
        });
        await toggleFreezeFromToolbar(page, "title-Language Model");
      });

      await test.step("Assert both nodes are frozen — the upstream Prompt Template by association", async () => {
        await expect(page.locator(FROZEN_INDICATOR)).toHaveCount(2, {
          timeout: 10000,
        });
        await frozenWritten;
        // Asserting both at once is the point: checking only the clicked node
        // would pass identically for a component-only freeze.
        await expect
          .poll(async () => readFrozenFlags(page, createdFlowId!), {
            timeout: 20000,
            message: "freezing downstream should freeze the whole upstream path",
          })
          .toEqual({ [PROMPT_NODE]: true, [MODEL_NODE]: true });
      });
    },
  );

  test(
    "unfreezing releases the whole path and the component recomputes",
    {
      tag: [
        "@stable",
        "@release",
        "@regression",
        "@components",
        "@workspace",
        "@ui-ux",
      ],
    },
    async ({ page }) => {
      const sentinel = `UNFROZEN-SENTINEL-${Date.now()}`;
      let cachedOutput = "";

      await test.step("Create the flow, cache an output, change the template, then freeze the path", async () => {
        createdFlowId = await createTwoNodeFlow(page);
        cachedOutput = await runComponentAndReadOutput(
          page,
          RUN_PROMPT,
          INSPECT_PROMPT,
        );
        await setPromptTemplate(page, sentinel);

        const frozenWritten = awaitFrozenWrite(page, createdFlowId!, {
          [PROMPT_NODE]: true,
          [MODEL_NODE]: true,
        });
        await toggleFreezeFromToolbar(page, "title-Language Model");
        await frozenWritten;
        await expect
          .poll(async () => readFrozenFlags(page, createdFlowId!), {
            timeout: 20000,
            message: "the whole path should be frozen before unfreezing",
          })
          .toEqual({ [PROMPT_NODE]: true, [MODEL_NODE]: true });
      });

      let releaseWritten: Promise<unknown>;

      await test.step("Click the same control again to unfreeze", async () => {
        releaseWritten = awaitFrozenWrite(page, createdFlowId!, {
          [PROMPT_NODE]: false,
          [MODEL_NODE]: false,
        });
        await toggleFreezeFromToolbar(page, "title-Language Model");
      });

      await test.step("Assert the whole path is released, on canvas and on the server", async () => {
        await expect(page.locator(FROZEN_INDICATOR)).toHaveCount(0, {
          timeout: 10000,
        });
        await releaseWritten;
        await expect
          .poll(async () => readFrozenFlags(page, createdFlowId!), {
            timeout: 20000,
            message: "unfreezing downstream should release the whole path",
          })
          .toEqual({ [PROMPT_NODE]: false, [MODEL_NODE]: false });
      });

      await test.step("Run the Prompt Template — it recomputes from the current input", async () => {
        const outputAfterUnfreeze = await runComponentAndReadOutput(
          page,
          RUN_PROMPT,
          INSPECT_PROMPT,
        );
        expect(outputAfterUnfreeze).toBe(sentinel);
        expect(outputAfterUnfreeze).not.toBe(cachedOutput);
      });
    },
  );
});
