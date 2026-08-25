import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";

// Memory Base — Memories panel and Create Memory modal (QA-CHECKLIST §20.1–20.2).
// Spec doc: docs/core-functionality/memory/memory-base-panel.md
//
// The read-only half of the memory-base surface: the flow editor's Memories
// panel, and the SHAPE of the Create Memory modal — controls, defaults, submit
// gate, cancel. Nothing here registers a memory base, so nothing here needs a
// provider, an embedding model or an LLM.
//
// Sibling coverage, deliberately not duplicated:
// - memory-base-registration.spec.ts (issue #1399) completes the form and
//   asserts the created memory base against the API; it needs an embeddings
//   provider and skips loudly without one.
// - The Agent's conversation memory is a different surface that shares the word
//   (llm-agents/memory-history-regression.spec.ts, §6.3).

// The panel lists from `/api/v1/memories`, NOT `/api/v1/knowledge_bases` — the
// latter is the Knowledge Base resource (`kb_name`, `/ingest`, `/chunks`) and is
// never touched here, so asserting it empty would prove nothing about a memory
// base. Measured on 1.12.0.dev19: opening the panel fires exactly one request,
// `GET /api/v1/memories?flow_id=…&page=1&size=50`. The route is absent from
// `/openapi.json` — that is not evidence it does not exist.
const MEMORIES_API = "/api/v1/memories";
const KNOWLEDGE_BASES_API = "/api/v1/knowledge_bases/";

// The provider catalog the Embedding Model picker is rendered from. Read by
// test 5's probe and intercepted by tests 6-7; `useGetModelProviders` calls it
// with an optional query string, so it is matched on the PATHNAME (a glob would
// miss those variants) and `/api/v1/models/enabled_models` — a different query,
// left live on purpose — is excluded by the same equality.
const MODELS_API = "/api/v1/models";

// What the widget renders INSTEAD of the picker when it has no provider to
// offer: an enabled button carrying this label, whose click opens the Model
// providers dialog. Harvested from the shipped bundle and confirmed live on
// 1.12.0.dev37 (issue #1569).
const SETUP_PROVIDER_LABEL = "#memory-embedding-model-setup-provider-label";
const SETUP_PROVIDER_BUTTON = `button:has(${SETUP_PROVIDER_LABEL})`;

// The Embedding Model trigger's text when a model COULD be chosen but none is.
// Two strings because the shared widget reads `No Models Enabled` when its
// options are empty and `Select a model` when they are not — both mean unset.
const UNSET_EMBEDDING_MODEL = /^(Select a model|No Models Enabled)$/;

/** One provider row of `GET /api/v1/models`, narrowed to what this file reads. */
interface CatalogProvider {
  is_configured?: boolean;
  is_enabled?: boolean;
  num_models?: number;
  models?: Array<{ metadata?: { model_type?: string } }>;
}

// Whether the instance itself offers an embedding model — the precondition of
// test 5 and of nothing else.
//
// It describes ONE of the picker's three states (a provider exposing an
// `embeddings` model, where the control renders unset), NOT "what makes the
// control render". It used to guard a second test on its negation, and that
// negation covers two states with different DOM: with providers enabled but
// none exposing embeddings the picker still renders, because the widget's
// collapse condition is `!hasEnabledProviders && !showEmptyState &&
// optionCount === 0` and `hasEnabledProviders` is `some(p => p.is_enabled ||
// p.is_configured)` — any provider, not an embeddings-capable one. Tests 6-7
// now name their state through the payload instead of inferring it (#1569).
//
// Probed through the API before the browser opens (repo convention), so the
// state is decided by the environment rather than by whatever the DOM happens
// to show — a `count() === 0` check inside the test would read a genuine
// regression that removes the control as "no provider configured".
async function embeddingModelAvailable(
  request: APIRequestContext,
  token: string,
): Promise<boolean> {
  const res = await request.get(MODELS_API, {
    headers: { Authorization: token },
  });
  if (res.status() !== 200) return false;
  const providers = (await res.json()) as Array<{
    is_configured?: boolean;
    is_enabled?: boolean;
    models?: Array<{ metadata?: { model_type?: string } }>;
  }>;
  return providers.some(
    (p) =>
      p.is_configured === true &&
      p.is_enabled === true &&
      (p.models ?? []).some((m) => m.metadata?.model_type === "embeddings"),
  );
}

/**
 * Serves the provider catalog the picker reads, DERIVED from the live response.
 *
 * The real endpoint is called and its body transformed, never fabricated: a
 * hand-written fixture keeps passing after the backend changes the payload's
 * shape, which is the standing objection to mocking a read; the backend's own
 * object minus one field's worth of content cannot. `route.fulfill({ response,
 * json })` keeps the original headers, as `admin-ui-read-only-policy.spec.ts`
 * does for the policy reads.
 *
 * Only GET is intercepted — a write to this path must reach the backend.
 */
async function serveProviders(
  page: Page,
  transform: (providers: CatalogProvider[]) => CatalogProvider[],
): Promise<void> {
  await page.route(
    (url: URL) => url.pathname.replace(/\/$/, "") === MODELS_API,
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as CatalogProvider[];
      await route.fulfill({ response, json: transform(body) });
    },
  );
}

/** Nothing configured and nothing enabled — the picker collapses (state C). */
const asUnconfigured = (providers: CatalogProvider[]): CatalogProvider[] =>
  providers.map((p) => ({
    ...p,
    is_configured: false,
    is_enabled: false,
    models: [],
    num_models: 0,
  }));

/**
 * Providers untouched, every embeddings model dropped (state B).
 *
 * Both spellings are filtered because the widget accepts both; only the plural
 * occurs in the payload today (measured: 138 `llm`, 18 `embeddings`, no
 * `embedding`), so this is about the widget's contract, not the data.
 */
const withoutEmbeddings = (providers: CatalogProvider[]): CatalogProvider[] =>
  providers.map((p) => {
    const models = (p.models ?? []).filter(
      (m) =>
        m.metadata?.model_type !== "embeddings" &&
        m.metadata?.model_type !== "embedding",
    );
    return { ...p, models, num_models: models.length };
  });

/**
 * Installs the payload and RE-ENTERS the editor so the widget reads it.
 *
 * The shared `beforeEach` already opened the editor, and the providers query is
 * cached in memory with a 5-minute `staleTime`, so a route installed afterwards
 * would not be consulted. A full document load drops that cache; the re-entry
 * measures ~1.2 s on 1.12.0.dev37, and it is the same entry helper the
 * `beforeEach` uses, so nothing about the editor's readiness gating diverges.
 */
async function enterWithProviders(
  page: Page,
  flowId: string,
  transform: (providers: CatalogProvider[]) => CatalogProvider[],
): Promise<void> {
  await serveProviders(page, transform);
  await openFlowById(page, flowId);
  await openMemoriesPanel(page);
}

/**
 * The Memories panel, scoped to the `aside` that carries its own heading.
 *
 * Scoped rather than page-global because the panel's `Create` button and its
 * search input carry NO `data-testid` at all (measured on 1.12.0.dev19), so both
 * resolve by role/placeholder — handles that a second "Create" elsewhere in the
 * editor chrome could collide with.
 */
function memoriesPanel(page: Page) {
  return page
    .locator("aside")
    .filter({ has: page.getByRole("heading", { name: "Memories" }) });
}

/** Opens the Memories panel from the flow editor's left nav. */
async function openMemoriesPanel(page: Page): Promise<void> {
  await page.getByTestId("sidebar-nav-memories").click();
  await expect(memoriesPanel(page)).toBeVisible({ timeout: 15000 });
}

/** Opens the Create Memory modal from the panel and returns its dialog. */
async function openCreateMemoryModal(page: Page) {
  await memoriesPanel(page)
    .getByRole("button", { name: "Create", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15000 });
  return dialog;
}

test.describe("core-functionality/memory — Memories panel and Create Memory modal", () => {
  let token: string;
  let flowId: string;
  let flowName: string;

  test.beforeEach(async ({ page, request }) => {
    token = await getAuthToken(request);
    // Unique name per test: the modal's description echoes it, which is what
    // makes the flow-scoping assertion falsifiable rather than a prefix match.
    flowName = `memory-panel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    flowId = await createFlow(
      request,
      {
        name: flowName,
        description: "Empty flow for the §20.1–20.2 Memories panel tests",
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
      { headers: { Authorization: token } },
    );

    // openFlowById seeds the assistant-onboarding flag before the load (the
    // welcome overlay otherwise leaves the editor chrome present-but-hidden) and
    // gates on the canvas plus the writable header.
    await openFlowById(page, flowId);
    await openMemoriesPanel(page);
  });

  test.afterEach(async ({ page, request }) => {
    // Leave the editor BEFORE deleting: an editor mounted over a deleted flow
    // 404s its own polls into the fixture's HTTP log.
    await unmountEditorForCleanup(page);
    await deleteFlow(request, flowId, { headers: { Authorization: token } });
  });

  test("the Memories panel opens with its empty state, a Create action and a search field",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const panel = memoriesPanel(page);

      await test.step("the empty state renders, not a blank panel", async () => {
        // Asserted by element id, not by text: the visible strings come from the
        // `memory.noMemorySelected*` i18n keys and move under a locale change
        // (#1400), while these ids are in the shipped markup.
        await expect(page.locator("#no-memory-selected-title")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.locator("#no-memory-selected-title")).toHaveText(
          "No memory selected",
        );
        await expect(
          page.locator("#no-memory-selected-description"),
        ).toBeVisible();
      });

      await test.step("the panel offers Create and a search field", async () => {
        await expect(
          panel.getByRole("button", { name: "Create", exact: true }),
        ).toBeVisible();
        // Enabled is the assertion that matters: the button is rendered
        // `disabled` without a `currentFlowId`, so this also pins that the panel
        // knows which flow it is in.
        await expect(
          panel.getByRole("button", { name: "Create", exact: true }),
        ).toBeEnabled();
        await expect(
          panel.getByPlaceholder("Search memories..."),
        ).toBeVisible();
      });
    });

  test("the Create Memory modal is scoped to the current flow",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const dialog = await openCreateMemoryModal(page);

      await test.step("the modal titles itself Create Memory", async () => {
        // The submit button carries the same label, so the title is asserted as
        // a heading — never as page text, which both would satisfy.
        await expect(
          dialog.getByRole("heading", { name: /Create Memory/ }),
        ).toBeVisible();
      });

      await test.step("the description names THIS flow", async () => {
        // The exact name this test created, not the literal prefix: a prefix
        // match would pass against any flow and prove nothing about scoping.
        await expect(
          dialog.getByText(`Create a memory for "${flowName}"`, {
            exact: true,
          }),
        ).toBeVisible({ timeout: 15000 });
      });
    });

  test("the Create Memory modal exposes its five controls",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const dialog = await openCreateMemoryModal(page);

      await test.step("all five controls are labelled as required", async () => {
        // The labels are asserted for all five — including Embedding Model,
        // whose CONTROL is provider-dependent (see embeddingModelAvailable) but
        // whose label and required marker render unconditionally.
        for (const label of [
          "Name",
          "Embedding Model",
          "Vector Database",
          "Batch Size",
          "LLM Preprocessing",
        ]) {
          await expect(
            dialog.getByText(label, { exact: false }).first(),
          ).toBeVisible({ timeout: 15000 });
        }
      });

      await test.step("the four provider-independent controls render", async () => {
        await expect(page.locator("#memory-name")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.locator("#memory-db-provider")).toBeVisible();
        await expect(page.locator("#memory-batch-size")).toBeVisible();
        await expect(page.locator("#llm-preprocessing-switch")).toBeVisible();
      });

      await test.step("the preprocessing branch stays collapsed while the toggle is off", async () => {
        // The two extra required fields only exist with the toggle on. Asserted
        // as absent so test 5's Name-only gate cannot be explained by them.
        await expect(page.locator("#llm-preprocessing-switch")).toHaveAttribute(
          "data-state",
          "unchecked",
        );
        await expect(
          page.locator("#memory-preprocessing-model"),
        ).toHaveCount(0);
        await expect(page.locator("#preprocessing-prompt")).toHaveCount(0);
      });
    });

  test("Vector Database defaults to Chroma Local and Batch Size to 1",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      await openCreateMemoryModal(page);

      await test.step("both defaults are the shipped ones", async () => {
        // `chroma` ships `defaultEnabled` with no config fields, so this holds
        // on an instance with nothing configured under DB Providers.
        await expect(page.locator("#memory-db-provider")).toHaveText(
          "Chroma Local",
          { timeout: 15000 },
        );
        await expect(page.locator("#memory-batch-size")).toHaveValue("1");
      });
    });

  // The Embedding Model control has THREE states, and each gets its own test.
  //
  // The first reads the instance's real provider state and skips when that state
  // does not hold; the other two SERVE the state through the providers payload,
  // so they run on every lane no matter what is configured. That split is the
  // point of #1569: the second test used to be guarded on the first's negation,
  // which covers two states with different DOM — so it never ran on any lane
  // that configures a provider (4 of 4 retained dailies), and would have failed
  // on a lane whose only provider ships no embeddings model (`anthropic` does
  // not). Driving it per page keeps the file off `@destructive`, which an
  // instance-global provider change would have forced (#1010).
  test("Embedding Model carries no default model when a provider offers embeddings",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const available = await embeddingModelAvailable(request, token);
      test.skip(
        !available,
        "no configured, enabled provider exposes an embeddings model — the control is not rendered at all on this instance (see the sibling test)",
      );

      const dialog = await openCreateMemoryModal(page);

      await test.step("the control renders with no model chosen", async () => {
        // The absence of the `Provider:` line is the second half of "unset" — it
        // renders only once a model is selected, so a picker pre-filled with a
        // provider's default could not pass both assertions.
        await expect(page.locator("#memory-embedding-model")).toHaveText(
          UNSET_EMBEDDING_MODEL,
          { timeout: 15000 },
        );
        await expect(dialog.getByText(/^Provider: /)).toHaveCount(0);
      });
    });

  test("the Embedding Model picker is replaced by a provider-setup affordance when no provider is configured",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      await enterWithProviders(page, flowId, asUnconfigured);
      const dialog = await openCreateMemoryModal(page);

      await test.step("the required label renders with no picker under it", async () => {
        await expect(
          dialog.locator("label").filter({ hasText: "Embedding Model" }),
        ).toBeVisible({ timeout: 15000 });
        await expect(page.locator("#memory-embedding-model")).toHaveCount(0);
        await expect(
          page.getByTestId("value-dropdown-memory-embedding-model"),
        ).toHaveCount(0);
        await expect(dialog.getByText(/^Provider: /)).toHaveCount(0);
      });

      // Absence alone is not the finding, and asserting only the two counts
      // above is what let this test claim a dead end for a modal that offers a
      // way out: it passes both on the working empty state and on a regression
      // that removed the picker outright. What distinguishes them is that
      // something usable stands in its place.
      await test.step("an enabled provider-setup affordance stands in its place", async () => {
        await expect(page.locator(SETUP_PROVIDER_LABEL)).toHaveText(
          "Select embedding model",
          { timeout: 15000 },
        );
        await expect(page.locator(SETUP_PROVIDER_BUTTON)).toBeEnabled();
        // Read before the click, because opening the providers dialog makes the
        // Create Memory modal inert.
        await expect(
          dialog.getByRole("button", { name: "Create Memory" }),
        ).toBeDisabled();
      });

      await test.step("clicking it opens the Model providers dialog", async () => {
        await page.locator(SETUP_PROVIDER_BUTTON).click();
        await expect(
          page.getByRole("heading", { name: "Model providers" }),
        ).toBeVisible({ timeout: 15000 });
      });
    });

  test("the Embedding Model picker still renders when the configured providers expose no embeddings model",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      await enterWithProviders(page, flowId, withoutEmbeddings);
      const dialog = await openCreateMemoryModal(page);

      // The third state, and the one the old guard silently folded into the
      // second: the widget's collapse needs BOTH no options and no enabled
      // provider, so with providers enabled the picker renders with nothing to
      // offer. A test asserting the collapsed DOM here fails against a healthy
      // instance — which is what made the old guard a latent red rather than
      // merely dead coverage.
      await test.step("the picker renders, unset, with no model chosen", async () => {
        await expect(page.locator("#memory-embedding-model")).toHaveText(
          UNSET_EMBEDDING_MODEL,
          { timeout: 15000 },
        );
        await expect(dialog.getByText(/^Provider: /)).toHaveCount(0);
      });

      await test.step("the provider-setup affordance is NOT shown", async () => {
        await expect(page.locator(SETUP_PROVIDER_LABEL)).toHaveCount(0);
      });
    });

  test("Create Memory stays disabled with an empty form and with only the Name filled",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const dialog = await openCreateMemoryModal(page);
      const submit = dialog.getByRole("button", { name: "Create Memory" });

      await test.step("the submit button is disabled on open", async () => {
        await expect(submit).toBeDisabled({ timeout: 15000 });
      });

      await test.step("it stays disabled after the Name is filled", async () => {
        await page.locator("#memory-name").fill(`memory-${Date.now()}`);
        // The fill is observed before the gate is re-read, so a still-disabled
        // button cannot be explained by the value never landing.
        await expect(page.locator("#memory-name")).not.toHaveValue("");
        // This is the gate, not the initial render: Name is filled, Vector
        // Database and Batch Size hold their defaults, and the only unset
        // required control left is the Embedding Model.
        await expect(submit).toBeDisabled();
      });
    });

  test("cancelling the Create Memory modal creates no memory base",
    { tag: ["@stable", "@release", "@workspace", "@ui-ux"] },
    async ({ page, request }) => {
      const dialog = await openCreateMemoryModal(page);

      await test.step("a filled Name is discarded by Cancel", async () => {
        await page.locator("#memory-name").fill(`cancelled-${Date.now()}`);
        await page.getByTestId("btn-cancel-modal").click();
        await expect(dialog).toBeHidden({ timeout: 15000 });
      });

      await test.step("no memory base exists for this flow, per the API", async () => {
        // Asserted against the endpoint the panel itself lists from — the UI
        // alone could be rendering nothing simply because it never refetched.
        const listed = await request.get(
          `${MEMORIES_API}?flow_id=${flowId}&page=1&size=50`,
          { headers: { Authorization: token } },
        );
        expect(listed.status()).toBe(200);
        const body = (await listed.json()) as {
          items: unknown[];
          total: number;
        };
        expect(body.total).toBe(0);
        expect(body.items).toEqual([]);
      });

      await test.step("no knowledge base was created either", async () => {
        // Secondary and flow-independent: this endpoint is a DIFFERENT resource
        // that a memory base would eventually back onto, and it is account-wide,
        // so the assertion is only that THIS flow's name is absent from it —
        // never that the list is empty (parallel workers own rows here).
        const kbs = await request.get(KNOWLEDGE_BASES_API, {
          headers: { Authorization: token },
        });
        expect(kbs.status()).toBe(200);
        expect(await kbs.text()).not.toContain(flowName);
      });
    });
});
