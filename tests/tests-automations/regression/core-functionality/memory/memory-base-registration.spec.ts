import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../../helpers/flows/unmount-editor-for-cleanup";

// Memory Base — registering a memory base end-to-end (QA-CHECKLIST §20.3).
// Spec doc: docs/core-functionality/memory/memory-base-registration.md
//
// The WRITE half of the memory-base surface. The panel, the modal's controls,
// its defaults and its submit gate are memory-base-panel.spec.ts (#1398) and are
// deliberately not repeated here.
//
// The issue asks for the created memory base to be present "both in
// GET /api/v1/knowledge_bases and in the panel". Measured on 1.12.0.dev22: it is
// NOT in that list, and by design — `list_knowledge_bases` in the shipped source
// skips "KBs that are managed by a Memory Base — those are exposed through the
// Memory Base APIs, not the generic KB list". So the two-sided check the issue
// wanted is made against `/api/v1/memories` (the endpoint the panel itself lists
// from), and the knowledge-base half is asserted as the ABSENCE that the design
// states — which is falsifiable, where presence would fail forever.
const MEMORIES_API = "/api/v1/memories";
const KNOWLEDGE_BASES_API = "/api/v1/knowledge_bases/";
const ENABLED_MODELS_API = "/api/v1/models/enabled_models";

interface EmbeddingChoice {
  /** Provider display name, as `enabled_models` keys it (e.g. `OpenAI`). */
  provider: string;
  /** Model id as the picker lists it (e.g. `text-embedding-3-small`). */
  modelId: string;
  /** The model's enabled flag BEFORE this spec touched it. */
  wasEnabled: boolean;
}

/**
 * An embeddings model this instance could offer the Create Memory picker, or
 * `null` when no provider can.
 *
 * Probed through the API before the browser opens (repo convention): the
 * Embedding Model control is the shared model widget rendered WITHOUT
 * `showEmptyState`, so with no configured provider it is absent from the DOM
 * entirely — a `count() === 0` check inside the test would read a genuine
 * regression removing the control as "no provider configured".
 *
 * Two endpoints, because they answer different questions and only the pair is
 * enough (measured on 1.12.0.dev22 with `OPENAI_API_KEY` configured):
 *
 *  - `GET /api/v1/models` says whether a provider is `is_configured` and
 *    `is_enabled` and carries a `metadata.model_type === "embeddings"` model.
 *    That is the environment precondition this spec cannot create for itself.
 *  - `GET /api/v1/models/enabled_models` says whether that model is enabled,
 *    which is what the picker actually lists from — and every embeddings model
 *    ships `false` there even with the key configured, which is how the picker
 *    reaches the `No Models Enabled` state issue #1399 predicts.
 */
async function findEmbeddingModel(
  request: APIRequestContext,
  token: string,
): Promise<EmbeddingChoice | null> {
  const modelsRes = await request.get("/api/v1/models", {
    headers: { Authorization: token },
  });
  if (modelsRes.status() !== 200) return null;
  const providers = (await modelsRes.json()) as Array<{
    provider?: string;
    is_configured?: boolean;
    is_enabled?: boolean;
    models?: Array<{
      model_name?: string;
      metadata?: { model_type?: string; deprecated?: boolean };
    }>;
  }>;

  const enabledRes = await request.get(ENABLED_MODELS_API, {
    headers: { Authorization: token },
  });
  if (enabledRes.status() !== 200) return null;
  const enabledMap = ((await enabledRes.json()) as {
    enabled_models?: Record<string, Record<string, boolean>>;
  }).enabled_models ?? {};

  for (const provider of providers) {
    if (provider.is_configured !== true || provider.is_enabled !== true) continue;
    const providerName = provider.provider;
    if (!providerName) continue;
    for (const model of provider.models ?? []) {
      if (model.metadata?.model_type !== "embeddings") continue;
      if (model.metadata?.deprecated === true) continue;
      const modelId = model.model_name;
      if (!modelId) continue;
      return {
        provider: providerName,
        modelId,
        wasEnabled: enabledMap[providerName]?.[modelId] === true,
      };
    }
  }
  return null;
}

/**
 * Flips one model's enablement, additively.
 *
 * The handler merges the update into the user's own enabled/disabled variable
 * lists rather than replacing the map (read from the shipped source and
 * measured), so this cannot disturb a parallel worker's model enablement — and
 * the caller restores the previous flag regardless.
 */
async function setModelEnabled(
  request: APIRequestContext,
  token: string,
  choice: EmbeddingChoice,
  enabled: boolean,
): Promise<void> {
  const res = await request.post(ENABLED_MODELS_API, {
    headers: { Authorization: token },
    data: [
      {
        provider: choice.provider,
        model_id: choice.modelId,
        enabled,
        model_type: "embeddings",
      },
    ],
  });
  expect(
    res.status(),
    `POST ${ENABLED_MODELS_API} (${choice.modelId} -> ${enabled})`,
  ).toBe(200);
}

/** The Memories panel, scoped to the `aside` carrying its own heading. */
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

interface MemoryBaseRecord {
  id: string;
  name: string;
  flow_id: string;
  kb_name: string;
  embedding_model: string;
}

/** Every memory base registered against one flow. */
async function listMemoryBases(
  request: APIRequestContext,
  token: string,
  flowId: string,
): Promise<MemoryBaseRecord[]> {
  const res = await request.get(
    `${MEMORIES_API}?flow_id=${flowId}&page=1&size=50`,
    { headers: { Authorization: token } },
  );
  expect(res.status(), `GET ${MEMORIES_API}?flow_id=${flowId}`).toBe(200);
  return ((await res.json()) as { items: MemoryBaseRecord[] }).items;
}

/**
 * `kb_name` is auto-generated by the server as `<sanitized name>_<8 hex>`, where
 * the sanitizer lowercases and replaces runs of whitespace/hyphens with `_`.
 * Asserting the shape is what lets the knowledge-base check look the backing KB
 * up by the exact string the server chose, rather than by a name we invented.
 */
function expectedKbNamePattern(memoryName: string): RegExp {
  const sanitized = memoryName.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return new RegExp(`^${sanitized}_[0-9a-f]{8}$`);
}

test.describe("core-functionality/memory — registering a memory base", () => {
  let token: string;
  let flowId: string;
  let flowName: string;
  /** Memory bases this test registered, deleted id-scoped in afterEach. */
  let createdMemoryIds: string[];
  /** Set only when the test flipped a model's enablement, to restore it. */
  let flippedModel: EmbeddingChoice | null;

  test.beforeEach(async ({ request }) => {
    token = await getAuthToken(request);
    createdMemoryIds = [];
    flippedModel = null;
    flowName = `memory-reg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    flowId = await createFlow(
      request,
      {
        name: flowName,
        description: "Empty flow for the §20.3 memory-base registration tests",
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
      { headers: { Authorization: token } },
    );
  });

  test.afterEach(async ({ page, request }) => {
    // Leave the editor BEFORE deleting the flow: an editor mounted over a
    // deleted flow 404s its own polls into the fixture's HTTP log.
    await unmountEditorForCleanup(page);
    for (const memoryId of createdMemoryIds) {
      const res = await request.delete(`${MEMORIES_API}/${memoryId}`, {
        headers: { Authorization: token },
      });
      expect(res.status(), `DELETE ${MEMORIES_API}/${memoryId}`).toBe(204);
    }
    if (flippedModel) {
      await setModelEnabled(request, token, flippedModel, flippedModel.wasEnabled);
    }
    await deleteFlow(request, flowId, { headers: { Authorization: token } });
  });

  test("registering a memory base from the Create Memory modal persists it",
    { tag: ["@release", "@workspace", "@ui-ux", "@model-provider"] },
    async ({ page, request }) => {
      const choice = await findEmbeddingModel(request, token);
      test.skip(
        choice === null,
        "no configured, enabled provider exposes an embeddings model on this instance — the Embedding Model picker cannot offer one, so registration is unreachable here",
      );
      const embedding = choice as EmbeddingChoice;

      // Enabled BEFORE the page loads: the frontend caches the model list, so
      // enabling it later leaves the picker reading `No Models Enabled` until
      // `refresh-model-list` is clicked. Restored in afterEach.
      if (!embedding.wasEnabled) {
        await setModelEnabled(request, token, embedding, true);
        flippedModel = embedding;
      }

      const memoryName = `mb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      await openFlowById(page, flowId);
      await openMemoriesPanel(page);
      const dialog = await openCreateMemoryModal(page);
      const submit = dialog.getByRole("button", { name: "Create Memory" });

      await test.step("the form is completed with a name and an embedding model", async () => {
        await page.locator("#memory-name").fill(memoryName);
        await page.locator("#memory-embedding-model").click();
        await page
          .getByRole("option", { name: embedding.modelId, exact: true })
          .click();
        // Both halves of "a model is chosen": the trigger carries the id, and
        // the `Provider:` line renders only once one is.
        await expect(page.locator("#memory-embedding-model")).toHaveText(
          embedding.modelId,
          { timeout: 15000 },
        );
        await expect(dialog.getByText(/^Provider: /)).toBeVisible();
      });

      await test.step("Create Memory becomes enabled and answers 201", async () => {
        // The gate the sibling spec pins as disabled with Name alone: what
        // released it here is the embedding model, and nothing else changed.
        await expect(submit).toBeEnabled({ timeout: 15000 });
        const [created] = await Promise.all([
          page.waitForResponse(
            (res) =>
              res.url().includes(MEMORIES_API) &&
              res.request().method() === "POST",
            { timeout: 30000 },
          ),
          submit.click(),
        ]);
        expect(created.status()).toBe(201);
        const body = (await created.json()) as MemoryBaseRecord;
        createdMemoryIds.push(body.id);
        expect(body.name).toBe(memoryName);
        expect(body.flow_id).toBe(flowId);
        expect(body.embedding_model).toBe(embedding.modelId);
        // The server-assigned backing KB name, not one the test could predict.
        expect(body.kb_name).toMatch(expectedKbNamePattern(memoryName));
        await expect(dialog).toBeHidden({ timeout: 15000 });
      });

      await test.step("the memory base is listed in the panel", async () => {
        await expect(
          memoriesPanel(page).getByText(memoryName, { exact: true }),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("the API reports it for this flow", async () => {
        // The endpoint the panel lists from — the panel alone could be showing
        // optimistic local state, which is the failure mode #1399 names.
        const items = await listMemoryBases(request, token, flowId);
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe(createdMemoryIds[0]);
        expect(items[0].name).toBe(memoryName);
        expect(items[0].kb_name).toMatch(expectedKbNamePattern(memoryName));
      });

      await test.step("it survives a full page reload", async () => {
        // The decisive half: client state cannot survive a reload, so a memory
        // base rendered only into the store disappears here.
        await page.reload();
        await openMemoriesPanel(page);
        await expect(
          memoriesPanel(page).getByText(memoryName, { exact: true }),
        ).toBeVisible({ timeout: 30000 });
      });
    });

  test("a registered memory base is exposed through the Memory Base API, never through the knowledge-base list",
    { tag: ["@stable", "@api", "@workspace", "@files"] },
    async ({ request }) => {
      // Registered through the API rather than the UI: this assertion is about
      // the resource boundary, not about the form, and creating it this way
      // needs no provider — so this half of the file has coverage on every
      // instance, including one where test 1 skips.
      const memoryName = `mb-api-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let kbName = "";

      await test.step("POST /api/v1/memories registers it", async () => {
        const res = await request.post(MEMORIES_API, {
          headers: { Authorization: token },
          data: {
            name: memoryName,
            flow_id: flowId,
            embedding_model: "text-embedding-3-small",
            threshold: 1,
          },
        });
        expect(res.status()).toBe(201);
        const body = (await res.json()) as MemoryBaseRecord;
        createdMemoryIds.push(body.id);
        kbName = body.kb_name;
        expect(kbName).toMatch(expectedKbNamePattern(memoryName));
      });

      await test.step("the Memory Base API lists it", async () => {
        const items = await listMemoryBases(request, token, flowId);
        expect(items.map((item) => item.name)).toContain(memoryName);
      });

      await test.step("the generic knowledge-base list does not", async () => {
        // Documented upstream behaviour, asserted rather than assumed:
        // `list_knowledge_bases` skips KBs managed by a Memory Base. Issue #1399
        // asks for the opposite; if upstream ever starts surfacing them here,
        // this fails and the spec doc is revisited — which is the point.
        const res = await request.get(KNOWLEDGE_BASES_API, {
          headers: { Authorization: token },
        });
        expect(res.status()).toBe(200);
        const kbs = (await res.json()) as Array<{ name?: string }>;
        // By kb_name, the exact string the server assigned — matching on the
        // memory's own name would pass even if the KB were listed under it.
        expect(kbs.map((kb) => kb.name)).not.toContain(kbName);
        expect(await res.text()).not.toContain(memoryName);
      });
    });
});
