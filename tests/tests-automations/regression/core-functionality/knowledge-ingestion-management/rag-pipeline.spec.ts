import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { loadFixtureFlow } from "../../../../helpers/flows/load-fixture-flow";
import {
  assertEmbeddingCredentialConfigured,
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
} from "../../../../helpers/knowledge/knowledge-base";
import { providerSkipGate } from "../../../../helpers/provider-setup/provider-health";

// §5.2.4 — the *complete RAG pipeline* end-to-end. Builds on #673 (Split Text
// chunking) and #674 (vector-store index + query) and adds the final "answer"
// step: the chunk retrieved from a native (core, Chroma-backed) Knowledge Base is
// fed through Parser -> Prompt -> Language Model, and the model's answer is proven
// to be grounded on that retrieved chunk. Uses only core components (no
// vector-store bundle), so it never yields a false failure on a packaging change.
// Spec doc: docs/core-functionality/knowledge-ingestion-management/rag-pipeline.md

// Pre-wired fixture flow, built + configured live on the canvas and validated
// end-to-end on 1.11.0.dev38:
//   Chat Input(the 5-line document) -> Split Text(chunk_size=100, overlap=0) ->
//   Knowledge[Ingest]; and Knowledge[Retrieve](top_k=1, static query) -> Parser ->
//   Prompt{context} -> Language Model(Google gemini-flash-latest, temperature=0) ->
//   Chat Output. The KB name is a placeholder the spec replaces per run.
const FIXTURE_PATH = "tests/assets/flows/rag-pipeline-fixture.json";

// The Knowledge component indexes one chunk per input row; Split Text turns the
// 5-sentence document into exactly 5 rows -> 5 indexed chunks. Asserted after
// ingest as a precondition so a later answer failure is unambiguously answer-side.
const EXPECTED_CHUNKS = 5;

// A fabricated, unguessable token that lives in exactly one chunk (sentence 3:
// "...by the internal ZEPHYR-42 codec."). The static query + prompt ask for that
// codec name. Because ZEPHYR-42 exists only inside the ingested document, the
// answer can contain it ONLY if retrieval fed the chunk into the prompt — proving
// the answer is grounded on the retrieved context, not the model's own knowledge.
const GROUNDING_SENTINEL = "ZEPHYR-42";

// The KB embeds with Google out-of-the-box; GOOGLE_API_KEY is auto-imported as a
// credential and injected in the daily-stable CI. The same key backs the answer
// model (gemini-flash-latest), so the whole spec depends on one provider key.
const EMBEDDING_PROVIDER = "Google Generative AI";
const EMBEDDING_MODEL = "models/gemini-embedding-001";

// The answer model. An alias (not a dated/pinned id) so the spec tracks Google's
// current flash model: pinned ids like `gemini-2.5-flash` return 404 ("no longer
// available to new users") on newer keys as Google retires them, while
// `gemini-flash-latest` always resolves to the live flash model.
const ANSWER_MODEL = "gemini-flash-latest";

// Stable node ids baked into the fixture, so the shared run/duration/inspection
// testids can be scoped to the right node.
const INGEST_NODE = "Knowledge-ingest";
const ANSWER_OUTPUT_NODE = "ChatOutput-answer";

// Ids of the resources each test creates; teardown deletes only these via the API
// (scoped) — never a global wipe, which would remove flows/KBs other parallel
// workers are actively using (#515).
const createdFlowIds: string[] = [];
const createdKbNames: string[] = [];

// Named flows created via the API race on unique-name suffixing under
// parallelism; run the file serially (same rationale as the sibling
// knowledge-ingestion specs).
test.describe.configure({ mode: "serial" });

// Google backs BOTH the embedding of every chunk and the answer model, so a key
// that exists but is drained turns each node run into a live call against a dead
// provider — which blocks the backend past gunicorn's 300s timeout and kills the
// shard's Langflow worker. Gate on the health `collect-models` recorded, not on
// the env var alone (#1029). Reason when it fires: either GOOGLE_API_KEY is
// unset, or the collected `inactive` error (spend cap, revoked key, …).
const googleGate = providerSkipGate("google");
test.skip(googleGate.skip, googleGate.reason);

async function authHeaders(page: Page): Promise<Record<string, string>> {
  const authHeader = await getAuthToken(page.request);
  return authHeader ? { Authorization: authHeader } : {};
}

/**
 * Creates a fresh, uniquely-named Knowledge Base, imports the RAG fixture flow
 * with both Knowledge nodes pointed at that KB, and opens it on the canvas ready
 * for node runs. Records the created KB name and flow id for scoped teardown.
 */
async function openRagFlow(page: Page): Promise<void> {
  const headers = await authHeaders(page);

  // The embedding provider key must be a Langflow global variable (not just an
  // env var) or the KB ingest fails with a misleading "embedding model no longer
  // recognized" error surfacing as a 90s node_duration timeout — fail fast and
  // actionably instead. The same GOOGLE_API_KEY also backs the answer model.
  await assertEmbeddingCredentialConfigured(page.request, "GOOGLE_API_KEY", {
    headers,
  });

  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const kbName = await createKnowledgeBase(
    page.request,
    {
      name: `kb_rag_${uniqueSuffix}`,
      embeddingProvider: EMBEDDING_PROVIDER,
      embeddingModel: EMBEDDING_MODEL,
    },
    { headers },
  );
  createdKbNames.push(kbName);

  // The fixture stores a frozen copy of each component's source; hydrate it from
  // the running image before creating the flow, or an upstream refactor of a
  // module that copy imports breaks the run at graph build (#1478).
  const fixture = await loadFixtureFlow(page.request, FIXTURE_PATH, { headers });
  // Point both Knowledge nodes at the freshly-created KB. The DropdownInput only
  // treats a value as a valid selection when it is also present in `options`, so
  // set both — value alone leaves the node showing "Select an option" and it
  // will not run.
  for (const node of fixture.data.nodes) {
    if (node.data?.type === "Knowledge") {
      const kb = node.data.node?.template?.knowledge_base;
      if (!kb) {
        throw new Error(
          `${FIXTURE_PATH}: node ${node.id} (type Knowledge) has no ` +
            `template.knowledge_base field — cannot pin it to the freshly-created ` +
            `KB. If upstream renamed/removed this field, the pin must target the ` +
            `new field instead of silently leaving the node unset.`,
        );
      }
      kb.value = kbName;
      kb.options = [kbName];
    }
    // Point the answer Language Model at ANSWER_MODEL (an alias). The fixture was
    // captured pinned to a dated model that Google is retiring — pinned ids 404
    // ("no longer available") on newer keys. The alias always resolves to the
    // current flash model, so the spec follows Google's model lifecycle instead
    // of false-failing on a retirement. Set the structured `model` selection
    // (from the node's own options) AND the `model_name` string override.
    if (node.data?.type === "LanguageModelComponent") {
      const tmpl = node.data.node?.template;
      // `model`'s `value`/`options` hold structured model-selection objects —
      // `TemplateField.options`/`value` are `unknown[]`/`unknown` precisely to
      // accommodate this, so no computed-key index-signature workaround is
      // needed. Cast each entry once, at the point it is actually shaped.
      if (!tmpl?.model) {
        throw new Error(
          `${FIXTURE_PATH}: node ${node.id} (type LanguageModelComponent) has ` +
            `no template.model field — cannot pin the answer model.`,
        );
      }
      const modelOptions = tmpl.model.options;
      const modelOption = Array.isArray(modelOptions)
        ? (modelOptions as Array<Record<string, unknown>>).find(
            (o) =>
              typeof o === "object" && o !== null && o.name === ANSWER_MODEL,
          )
        : undefined;
      if (!modelOption) {
        throw new Error(
          `${FIXTURE_PATH}: node ${node.id}'s template.model.options has no ` +
            `entry named "${ANSWER_MODEL}" — cannot pin the answer model. If ` +
            `Google's catalog dropped this alias, the pin target must be ` +
            `updated instead of silently falling back to the fixture's dated ` +
            `model id.`,
        );
      }
      tmpl.model.value = [modelOption];
      if (!tmpl.model_name) {
        throw new Error(
          `${FIXTURE_PATH}: node ${node.id} (type LanguageModelComponent) has ` +
            `no template.model_name field — cannot set the string override.`,
        );
      }
      tmpl.model_name.value = ANSWER_MODEL;
      tmpl.model_name.options = [ANSWER_MODEL];
    }
  }

  const flowId = await createFlow(
    page.request,
    {
      name: `RAG Pipeline ${uniqueSuffix}`,
      description: fixture.description,
      data: fixture.data,
      is_component: false,
    },
    { headers },
  );
  createdFlowIds.push(flowId);

  await page.goto(`/flow/${flowId}`);
  await expect(
    page.locator(`[data-id="${INGEST_NODE}"]`).getByTestId("title-knowledge"),
  ).toBeVisible({ timeout: 30000 });

  // Rely on Langflow's auto fit-on-load: it frames all 8 nodes within the viewport
  // so every node run control is rendered and clickable. We deliberately do NOT
  // call adjustScreenView here — its extra zoom-out shifts nodes under the
  // right-hand react-flow panel, which then intercepts the run-button click.
  // Gate on the far answer terminal being rendered too, so the fit-on-load has
  // framed the whole flow before any node run (both ends must be clickable).
  await expect(
    page
      .locator(`[data-id="${ANSWER_OUTPUT_NODE}"]`)
      .getByTestId("button_run_chat output"),
  ).toBeVisible({ timeout: 30000 });

  // Dismiss the outdated-update banner up front (present on load, persists once
  // dismissed) so it never overlays a later node-output click.
  await dismissUpdateBannerIfPresent(page);
}

// The fixture was captured on an older nightly, so on a newer build its
// components resolve to outdated updates and a bottom-centered "N components need
// updates" banner overlays the node output controls, intercepting the
// output-inspection click. It is noise for this spec (outdated notifications are
// covered by outdated-component-notification.spec.ts), so dismiss it before
// reading a node's output.
async function dismissUpdateBannerIfPresent(page: Page): Promise<void> {
  // The outdated diff resolves asynchronously after the flow loads, so the banner
  // can appear a beat late; wait briefly for it (the fixture is deliberately
  // behind the nightly, so it always appears within this window) before
  // dismissing. If a future fixture refresh removes the outdated state, this
  // just times out and no-ops — the test still runs in full, never skips.
  const dismissAll = page.getByRole("button", { name: "Dismiss All" });
  if (await dismissAll.isVisible({ timeout: 6000 }).catch(() => false)) {
    await dismissAll.click();
    await expect(dismissAll).toBeHidden({ timeout: 5000 });
  }
}

/** Runs a node (scoped by id) via its run button and waits for the success badge. */
async function runNode(
  page: Page,
  nodeId: string,
  runButtonTestId: string,
): Promise<void> {
  const node = page.locator(`[data-id="${nodeId}"]`);
  await node.getByTestId(runButtonTestId).click({ timeout: 15000 });
  await expect(node.locator('[data-testid^="node_duration"]')).toBeVisible({
    timeout: 90000,
  });
}

test.afterEach(async ({ page }) => {
  const flowIds = createdFlowIds.splice(0);
  const kbNames = createdKbNames.splice(0);
  if (flowIds.length === 0 && kbNames.length === 0) return;
  // Navigate off the editor first so the unmounted flow page stops polling a flow
  // we are about to delete, then pass an explicit auth header — page.request is
  // unauthenticated under AUTO_LOGIN and would 401 otherwise.
  await page.goto("/");
  const headers = await authHeaders(page);
  // Delete every resource independently and collect failures, so a throw while
  // deleting one can never skip the rest — otherwise the KB, a persistent
  // instance resource that MUST be deleted to avoid orphans, would leak.
  const failures: string[] = [];
  for (const id of flowIds) {
    try {
      await deleteFlow(page.request, id, { headers });
    } catch (e) {
      failures.push(String(e));
    }
  }
  for (const name of kbNames) {
    try {
      await deleteKnowledgeBase(page.request, name, { headers });
    } catch (e) {
      failures.push(String(e));
    }
  }
  if (failures.length > 0) {
    throw new Error(`Teardown cleanup failed: ${failures.join("; ")}`);
  }
});

test(
  "Full RAG pipeline grounds the model answer on the retrieved chunk",
  { tag: ["@stable", "@release", "@components", "@files"] },
  async ({ page }) => {
    await test.step("open the pre-wired RAG pipeline fixture flow", async () => {
      await openRagFlow(page);
    });

    await test.step("run the Knowledge (Ingest) node", async () => {
      await runNode(page, INGEST_NODE, "button_run_knowledge");
    });

    await test.step("the Knowledge Base holds exactly the expected chunks", async () => {
      // Precondition proof the ingest embedded + indexed the document, so a later
      // answer failure is unambiguously answer-side rather than a broken ingest.
      const kbName = createdKbNames[createdKbNames.length - 1];
      const headers = await authHeaders(page);
      const kb = await getKnowledgeBase(page.request, kbName, { headers });
      expect(kb.chunks).toBe(EXPECTED_CHUNKS);
    });

    await test.step("run the answer path via the Chat Output node", async () => {
      // Running Chat Output builds only its upstream (Retrieve -> Parser -> Prompt
      // -> Language Model -> Chat Output); the ingest branch is not upstream, so
      // it does not re-run. Retrieve reads the KB just populated by the ingest.
      await runNode(page, ANSWER_OUTPUT_NODE, "button_run_chat output");
    });

    await test.step("the answer is grounded on the retrieved chunk", async () => {
      await page
        .locator(`[data-id="${ANSWER_OUTPUT_NODE}"]`)
        .getByTestId("output-inspection-output message-chatoutput")
        .click();
      // The Component Output dialog shows the answer in a textarea. The verbatim
      // fabricated token can only be present if retrieval fed the chunk into the
      // prompt — proving the end-to-end RAG grounding (a model answering from its
      // own knowledge, or an empty/wrong retrieval, cannot produce ZEPHYR-42).
      // Scope past the onboarding tooltip, which also carries role="dialog".
      const answer = page
        .locator('[role="dialog"]:not([data-testid="assistant-onboarding-tooltip"])')
        .locator("textarea");
      await expect(answer).toBeVisible({ timeout: 15000 });
      await expect(answer).toHaveValue(new RegExp(GROUNDING_SENTINEL), {
        timeout: 15000,
      });
    });
  },
);
