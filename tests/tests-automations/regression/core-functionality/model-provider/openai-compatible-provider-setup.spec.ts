import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage } from "../../../../pages";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { createFlowFromStarter } from "../../../../helpers/flows/create-flow-from-starter";
import { openFlowById } from "../../../../helpers/flows/open-flow-by-id";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";

/**
 * OpenAI Compatible in the unified provider setup (QA-CHECKLIST §7.8, Langflow
 * 1.11.0 — upstream #13940 / #14199). Spec doc:
 * docs/core-functionality/model-provider/openai-compatible-provider-setup.md
 *
 * Two properties separate this provider from every one already covered, and they
 * are where the asserts live (both read off the running 1.12.0.dev15 build):
 *
 * - It is the suite's first **live-only** provider: contributed by an extension
 *   bundle (`lfx_openai_compatible`) with NO static catalog rows at all
 *   (`get_live_only_providers()`), listed while unconfigured only so its form can
 *   be offered (`langflow/api/v1/models.py :: list_models`). Every model it ever
 *   offers comes from a live `GET <base_url>/v1/models`. So here the model list
 *   IS the connectivity proof — which the provider playbook explicitly denies for
 *   Groq and Mistral, whose live lists overlap a static fallback.
 * - Its API key is OPTIONAL (a local server may need no auth) yet is still the
 *   provider's PRIMARY variable (`get_model_provider_variable_mapping()` prefers
 *   the secret), so it is the key write the backend validates — and that
 *   validation needs the base URL.
 *
 * That coupling is a live defect, measured 3/3 on 1.12.0.dev15 and isolated
 * against the API: the Settings Save fires the two `POST /api/v1/variables/`
 * writes CONCURRENTLY (the frontend logs its own `Duplicate request:
 * /api/v1/variables/`), so the primary key write validates against provider
 * variables that do not yet include the just-created base URL and is rejected
 * `400 {"detail":"Invalid OpenAI-compatible base URL"}`. Sequential writes over
 * the API: 201/201. Concurrent: 201/400. Nothing is surfaced in the UI — no
 * toast, no model count, no disconnect button — so the provider silently ends up
 * with the base URL only, discovery runs keyless, the endpoint answers 401 and
 * the panel reports a configured provider with 0 models.
 *
 * The LAST test asserts the correct behaviour and is `test.fixme` against that
 * defect — the repo's live-defect convention (`api-folders-crud.spec.ts`
 * #965/LE-2020, `mcp-server.spec.ts` #1266): assertions untouched, no `@stable`,
 * and lifting the quarantine is a deliverable of LE-2124. Tests 4-5
 * configure the pair over the API, sequentially, so the discovery and execution
 * coverage does not depend on the broken UI path.
 *
 * False-positive guards that shape the asserts:
 * - the empty live-only catalog is asserted differentially against Azure AI
 *   Foundry's seed catalog on the SAME instance and run, so a catalog-wide or
 *   page-wide regression cannot pass test 1;
 * - `POST /api/v1/models/validate-provider` answers HTTP **200** with
 *   `{"valid": false, "error": …}` for a credential it rejected, so every
 *   validation assert reads the BODY (the trap `ollama-provider.spec.ts` M1 and
 *   the Foundry sibling both call out);
 * - the configured-state markers (`provider-disconnect-button`, `llm-toggle-*`)
 *   are asserted ABSENT while unconfigured, so their later presence is a real
 *   state change;
 * - the model option is addressed by its PROVIDER-QUALIFIED testid
 *   (`OpenAI Compatible-<id>-option`): the endpoint under test serves ids the
 *   OpenAI provider also serves, and an unqualified locator would pass while
 *   exercising the wrong provider.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const PROVIDER_NAME = "OpenAI Compatible";
const PROVIDER_ITEM = `provider-item-${PROVIDER_NAME}`;
const BASE_URL_VAR = "OPENAI_COMPATIBLE_BASE_URL";
const KEY_VAR = "OPENAI_COMPATIBLE_API_KEY";
const BASE_URL_INPUT = `provider-variable-input-${BASE_URL_VAR}`;
const KEY_INPUT = `provider-variable-input-${KEY_VAR}`;

/**
 * The provider whose seed catalog makes test 1's empty list differential. Azure
 * AI Foundry ships 5 suggestion models with no credentials configured
 * (`lfx/base/models/azure_ai_foundry_constants.py`), asserted as a FLOOR — a
 * catalog addition is not a regression (#993's count rule).
 */
const CATALOGED_PROVIDER = "Azure AI Foundry";
const CATALOGED_FLOOR = 3;

// The endpoint under test. Defaults to OpenAI itself — the issue's own "can be
// exercised against any OpenAI-compatible endpoint (including OpenAI)" — so the
// lanes need NO new secret: `OPENAI_API_KEY` is already there.
const TEST_BASE_URL = (
  process.env.OPENAI_COMPATIBLE_TEST_BASE_URL ?? "https://api.openai.com/v1"
).replace(/\/+$/, "");
const TEST_API_KEY =
  process.env.OPENAI_COMPATIBLE_TEST_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const TEST_MODEL = process.env.OPENAI_COMPATIBLE_TEST_MODEL ?? "gpt-4o-mini";

const BOGUS_KEY = "sk-e2e-bogus-openai-compatible-key";

interface EndpointProbe {
  usable: boolean;
  reason: string;
  /** Model ids the endpoint serves, sorted — the live-discovery expectation. */
  ids: string[];
}

/** `<base>/models` when the base already ends in /v1, `<base>/v1/models` otherwise. */
function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Probes the endpoint from the TEST host before opening a browser, so an
 * unreachable endpoint or a drained key is an explicit skip and never a mid-test
 * mystery — and returns the id set Langflow's live discovery must reproduce.
 *
 * Mirrors `lfx_openai_compatible/discovery.py :: _parse_model_names`: an
 * OpenAI-shaped `{"data": [{"id": …}]}` or a bare list.
 */
async function probeEndpoint(request: APIRequestContext): Promise<EndpointProbe> {
  if (!TEST_API_KEY) {
    return {
      usable: false,
      ids: [],
      reason:
        "no bearer for the endpoint: set OPENAI_COMPATIBLE_TEST_API_KEY or OPENAI_API_KEY",
    };
  }
  try {
    const res = await request.get(modelsUrl(TEST_BASE_URL), {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      timeout: 20000,
    });
    if (res.status() !== 200) {
      return {
        usable: false,
        ids: [],
        reason: `GET ${modelsUrl(TEST_BASE_URL)} answered ${res.status()}`,
      };
    }
    const payload = (await res.json().catch(() => null)) as
      | { data?: Array<{ id?: string }> }
      | string[]
      | null;
    const ids = Array.isArray(payload)
      ? payload.filter((m): m is string => typeof m === "string")
      : (payload?.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    if (ids.length === 0) {
      return {
        usable: false,
        ids: [],
        reason: `${modelsUrl(TEST_BASE_URL)} returned no model ids`,
      };
    }
    if (!ids.includes(TEST_MODEL)) {
      return {
        usable: false,
        ids: [],
        // Never fall back to another id: the execution assert would then run a
        // model nobody asked for and report success (#1169's silent-skip trap).
        reason: `${TEST_MODEL} is not served by ${TEST_BASE_URL} (set OPENAI_COMPATIBLE_TEST_MODEL)`,
      };
    }
    return { usable: true, ids: [...ids].sort(), reason: "" };
  } catch (e) {
    return {
      usable: false,
      ids: [],
      reason: `${TEST_BASE_URL} unreachable from the test host: ${(e as Error).message}`,
    };
  }
}

async function listVariables(
  request: APIRequestContext,
): Promise<Array<{ id: string; name: string }>> {
  const bearer = await getAuthToken(request);
  const res = await request.get("/api/v1/variables/", {
    headers: { Authorization: bearer },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as Array<{ id: string; name: string }>;
}

async function ocVariables(
  request: APIRequestContext,
): Promise<Array<{ id: string; name: string }>> {
  return (await listVariables(request)).filter(
    (v) => v.name === BASE_URL_VAR || v.name === KEY_VAR,
  );
}

async function ocVariableNames(request: APIRequestContext): Promise<string[]> {
  return (await ocVariables(request)).map((v) => v.name).sort();
}

/**
 * Deletes the pair, tolerating a write that is still in flight.
 *
 * One list-then-delete pass is not enough: Save issues two separate variable
 * writes, so a cleanup running between them leaves the second behind — and a
 * leftover then makes the NEXT run's unconfigured-state tests SKIP instead of
 * run, which is the worse half of the failure (measured on the Foundry sibling).
 * Bounded at 3 passes; callers still assert the end state.
 */
async function purgeOcCredentials(request: APIRequestContext): Promise<void> {
  const bearer = await getAuthToken(request);
  for (let pass = 0; pass < 3; pass++) {
    const stored = await ocVariables(request);
    if (stored.length === 0 && pass > 0) return;
    for (const variable of stored) {
      await request
        .delete(`/api/v1/variables/${variable.id}`, { headers: { Authorization: bearer } })
        .catch(() => {});
    }
  }
}

/**
 * Creates the pair SEQUENTIALLY — the base URL write is awaited before the key
 * write starts, which is exactly what the Settings UI does not do (test 4). This
 * is setup, not the behaviour under test, so it takes the path that works.
 */
async function configureProviderViaApi(request: APIRequestContext): Promise<void> {
  const bearer = await getAuthToken(request);
  const headers = { Authorization: bearer, "Content-Type": "application/json" };

  const baseRes = await request.post("/api/v1/variables/", {
    headers,
    data: {
      name: BASE_URL_VAR,
      value: TEST_BASE_URL,
      type: "Global",
      default_fields: [],
      category: "Global",
    },
  });
  expect(
    baseRes.status(),
    `POST /variables/ ${BASE_URL_VAR} -> ${baseRes.status()} ${await baseRes.text()}`,
  ).toBe(201);

  const keyRes = await request.post("/api/v1/variables/", {
    headers,
    data: {
      name: KEY_VAR,
      value: TEST_API_KEY,
      type: "Credential",
      default_fields: [],
      category: "Global",
    },
  });
  expect(
    keyRes.status(),
    `POST /variables/ ${KEY_VAR} -> ${keyRes.status()} ${await keyRes.text()}`,
  ).toBe(201);
}

interface ProviderEntry {
  provider: string;
  num_models: number;
  is_configured: boolean;
  models: Array<{ model_name?: string; metadata?: { model_type?: string } }>;
}

/** `GET /api/v1/models?provider=<name>` — the unified catalog entry for one provider. */
async function providerCatalog(
  request: APIRequestContext,
  provider: string,
): Promise<ProviderEntry> {
  const bearer = await getAuthToken(request);
  const res = await request.get(
    `/api/v1/models?provider=${encodeURIComponent(provider)}`,
    { headers: { Authorization: bearer } },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ProviderEntry[];
  const entry = body.find((p) => p.provider === provider);
  expect(
    entry,
    `GET /api/v1/models?provider=${provider} did not list the provider at all (got ${JSON.stringify(
      body.map((p) => p.provider),
    )})`,
  ).toBeTruthy();
  return entry as ProviderEntry;
}

/**
 * The Language Model node's model + credential binding, as PERSISTED — the state
 * the run actually builds from.
 *
 * `template.model.value` is an ARRAY of model objects on the 1.11+ unified
 * selector (the shape `helpers/flows/agent-credential-settle.ts` documents for the
 * Agent node), and `template.api_key.value` holds the NAME of the global variable,
 * never the secret. Tolerant of partial payloads: it runs inside a poll, so a
 * transient shape must read as "not settled yet" rather than throw. The node is
 * located by its `model_name` template field — the Language Model component is the
 * only node the Basic Prompting template carries with one.
 */
async function persistedModelBinding(
  request: APIRequestContext,
  flowId: string,
): Promise<{ models: string[]; credential: string }> {
  const bearer = await getAuthToken(request);
  const res = await request.get(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: bearer },
  });
  if (res.status() !== 200) {
    return { models: [], credential: `GET flow -> ${res.status()}` };
  }
  const flow = (await res.json().catch(() => null)) as {
    data?: {
      nodes?: Array<{
        data?: { node?: { template?: Record<string, { value?: unknown } | undefined> } };
      }>;
    };
  } | null;
  const nodes = flow?.data?.nodes ?? [];
  const template = nodes.find(
    (n) => n?.data?.node?.template?.model_name !== undefined,
  )?.data?.node?.template;
  const rawModel = template?.model?.value;
  const entries = Array.isArray(rawModel) ? rawModel : [rawModel];
  const models = entries
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const name = (entry as { name?: unknown } | null)?.name;
      return typeof name === "string" ? name : "";
    })
    .filter((name) => name.length > 0);
  const credential =
    typeof template?.api_key?.value === "string" ? template.api_key.value : "";
  return { models, credential };
}

/**
 * Settings → Model Providers → <provider>, with the detail panel open.
 *
 * The panel is anchored on the provider's OWN base-URL input, not on
 * `model-provider-selection` the way the Foundry sibling does: for a live-only
 * provider with nothing configured that container renders EMPTY
 * (`<div data-testid="model-provider-selection"></div>`), so it is present in the
 * DOM but zero-sized, and `toBeVisible` fails on it — measured on 1.12.0.dev15.
 * Foundry escapes that only because its seed catalog fills the container.
 */
async function openProviderPanel(page: Page, providerItemTestId: string): Promise<void> {
  await new SettingsPage(page).navigate();
  await page.getByTestId("sidebar-nav-Model Providers").click();
  await expect(page.getByTestId("settings_menu_header").last()).toContainText(
    "Model Providers",
    { timeout: 15000 },
  );
  await expect(page.getByTestId("provider-list")).toBeVisible({ timeout: 15000 });
  await page.getByTestId(providerItemTestId).click();
  await expect(page.getByTestId(BASE_URL_INPUT)).toBeVisible({ timeout: 15000 });
}

/** The provider's `validate-provider` response, armed BEFORE the Save click. */
function armValidateResponse(page: Page) {
  return page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/models/validate-provider") &&
      r.request().method() === "POST",
    { timeout: 60000 },
  );
}

// Serial + --workers=1: every test drives the same account-wide Settings state
// (the provider's credentials), so parallel execution would have them read each
// other's writes.
test.describe.configure({ mode: "serial" });

test.describe("OpenAI Compatible — unified provider setup", () => {
  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    // The provider's credentials are account-wide: a leftover pair would make the
    // next run's unconfigured-state tests skip (silent coverage loss), so purge
    // unconditionally, not only on the tests that wrote them.
    await purgeOcCredentials(request);

    if (createdFlowIds.length === 0) return;
    // page.request carries only browser cookies — the flows API wants the Bearer
    // token, so authenticate explicitly (a silent 401 here leaks flows).
    const bearer = await getAuthToken(request);
    // No `.catch()` on purpose: deleteFlow throws on a failed deletion and
    // swallowing that is how a leak goes silent.
    for (const id of createdFlowIds.splice(0)) {
      await deleteFlow(request, id, { headers: { Authorization: bearer } });
    }
  });

  test(
    "the provider is offered with two variables and a live-only, empty catalog",
    { tag: ["@stable", "@api", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const stored = await ocVariables(request);
      test.skip(
        stored.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored
          .map((v) => v.name)
          .join(", ")}) — the unconfigured-state asserts below would not apply`,
      );

      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("the provider is searchable in Settings → Model Providers", async () => {
        await new SettingsPage(page).navigate();
        await page.getByTestId("sidebar-nav-Model Providers").click();
        await expect(page.getByTestId("provider-list")).toBeVisible({ timeout: 15000 });

        // Searching, not scrolling: the list renders a subset (provider playbook
        // step 0), so a scroll-only check can miss a provider that IS there.
        await page.getByTestId("provider-search-input").fill("compatible");
        await expect(page.getByTestId(PROVIDER_ITEM)).toBeVisible({ timeout: 15000 });
        await page.getByTestId("provider-search-input").fill("");
      });

      await test.step("its form asks for a REQUIRED base URL and an OPTIONAL key", async () => {
        await page.getByTestId(PROVIDER_ITEM).click();
        await expect(page.getByTestId(BASE_URL_INPUT)).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId(KEY_INPUT)).toBeVisible();

        const save = page.getByRole("button", { name: /^Save$/ }).first();
        await expect(save).toBeDisabled();

        // Which of the two is required is observable, and asymmetric: the key
        // alone leaves Save disabled, the base URL alone enables it. Asserting
        // both directions is what makes this a contract rather than a screenshot.
        await page.getByTestId(KEY_INPUT).fill(BOGUS_KEY);
        await expect(save).toBeDisabled();
        await page.getByTestId(KEY_INPUT).fill("");
        await page.getByTestId(BASE_URL_INPUT).fill(TEST_BASE_URL);
        await expect(save).toBeEnabled();
        // Leave the form clean — nothing was saved, and the next step reads the API.
        await page.getByTestId(BASE_URL_INPUT).fill("");
      });

      await test.step("unconfigured, it contributes ZERO models — and nothing is stored", async () => {
        const entry = await providerCatalog(request, PROVIDER_NAME);
        expect(entry.num_models).toBe(0);
        expect(entry.models).toEqual([]);
        expect(entry.is_configured).toBe(false);
        expect(await ocVariableNames(request)).toEqual([]);

        // The configured-state markers must be absent NOW, so their presence in
        // tests 4-5 is a real state change and not the page's resting state.
        await expect(page.locator('[data-testid^="llm-toggle-"]')).toHaveCount(0);
        await expect(page.getByTestId("provider-disconnect-button")).toHaveCount(0);
      });

      await test.step("the empty catalog is live-only, not a page-wide failure", async () => {
        // Same instance, same run: a provider WITH a static catalog still lists
        // its seed models. Empty-here / non-empty-there is the live-only
        // property; a catalog-wide regression fails this step instead of passing
        // the one above.
        const cataloged = await providerCatalog(request, CATALOGED_PROVIDER);
        expect(cataloged.is_configured).toBe(false);
        expect(cataloged.num_models).toBeGreaterThanOrEqual(CATALOGED_FLOOR);
      });
    },
  );

  test(
    "an unreachable base URL is rejected and nothing is persisted",
    { tag: ["@stable", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const stored = await ocVariables(request);
      test.skip(
        stored.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored
          .map((v) => v.name)
          .join(", ")}) — saving a bogus base URL would overwrite a real one`,
      );

      await awaitBootstrapTest(page, { skipModal: true });
      await openProviderPanel(page, PROVIDER_ITEM);

      // RFC 6761 reserves `.invalid`: it can never resolve, so this is a
      // deterministic failure with no external dependency. Unique per run so no
      // DNS cache can answer it.
      const unreachable = `https://e2e-openai-compatible-${Date.now()}.invalid/v1`;

      await test.step("save an unresolvable endpoint", async () => {
        await page.getByTestId(BASE_URL_INPUT).fill(unreachable);

        const validatePromise = armValidateResponse(page);
        await page.getByRole("button", { name: /^Save$/ }).first().click();
        const validateResp = await validatePromise;

        // HTTP 200 is NOT the verdict: the endpoint answers 200 with valid:false
        // for a credential it rejected, so the BODY is the assert.
        expect(validateResp.status()).toBe(200);
        const body = (await validateResp.json()) as { valid?: boolean; error?: string };
        expect(body.valid).toBe(false);
        // The message names the transport failure the bundle's validator raises
        // (`discovery.py :: validate_openai_compatible_credentials`) — proof the
        // provider's own branch ran, not a generic reject.
        expect(body.error ?? "").toMatch(
          /DNS resolution failed|Could not connect to the OpenAI-compatible endpoint|timed out/i,
        );
      });

      await test.step("no variable is stored and the provider stays unconfigured", async () => {
        await expect
          .poll(async () => ocVariableNames(request), { timeout: 15000 })
          .toEqual([]);
        expect((await providerCatalog(request, PROVIDER_NAME)).is_configured).toBe(false);
        await expect(page.locator('[data-testid^="llm-toggle-"]')).toHaveCount(0);
      });
    },
  );

  test(
    "a reachable endpoint with a bogus key is rejected as an authentication failure",
    { tag: ["@stable", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const stored = await ocVariables(request);
      test.skip(
        stored.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored
          .map((v) => v.name)
          .join(", ")}) — saving a bogus key would overwrite a real one`,
      );

      await awaitBootstrapTest(page, { skipModal: true });
      await openProviderPanel(page, PROVIDER_ITEM);

      await test.step("save a real base URL with an invalid bearer", async () => {
        await page.getByTestId(BASE_URL_INPUT).fill(TEST_BASE_URL);
        await page.getByTestId(KEY_INPUT).fill(BOGUS_KEY);

        const validatePromise = armValidateResponse(page);
        await page.getByRole("button", { name: /^Save$/ }).first().click();
        const validateResp = await validatePromise;

        expect(validateResp.status()).toBe(200);
        const body = (await validateResp.json()) as { valid?: boolean; error?: string };
        expect(body.valid).toBe(false);
        // This exact message is only reachable when the endpoint SAW the bearer
        // and answered 401/403 — so it proves the key is actually used for the
        // probe, which a "rejected somehow" assert would not.
        expect(body.error ?? "").toContain(
          "Authentication failed for the OpenAI-compatible endpoint",
        );
      });

      await test.step("no variable is stored and the provider stays unconfigured", async () => {
        await expect
          .poll(async () => ocVariableNames(request), { timeout: 15000 })
          .toEqual([]);
        expect((await providerCatalog(request, PROVIDER_NAME)).is_configured).toBe(false);
      });
    },
  );

  // Quarantined at triage (daily #1361): discovery stopped registering each
  // served model twice, so `num_models` reads 124 where the contract is 248
  // — see #1364.
  test.fixme(
    "the configured provider discovers exactly the models its endpoint serves",
    { tag: ["@api", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const probe = await probeEndpoint(request);
      test.skip(!probe.usable, `OpenAI-compatible endpoint not usable: ${probe.reason}`);

      const stored = await ocVariables(request);
      test.skip(
        stored.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored
          .map((v) => v.name)
          .join(", ")}) — this test would overwrite and then delete a credential it does not own`,
      );

      // Setup over the API and SEQUENTIALLY — the UI's concurrent save cannot
      // persist the key on 1.12.0.dev15 (test 4 owns that verdict), and this test
      // is about discovery, not about the save path.
      await configureProviderViaApi(request);

      await test.step("the llm catalog equals the endpoint's own /v1/models ids", async () => {
        // Live discovery runs per request against the endpoint; poll until the
        // catalog filled rather than assuming the first read is warm.
        await expect
          .poll(async () => (await providerCatalog(request, PROVIDER_NAME)).num_models, {
            timeout: 60000,
          })
          .toBeGreaterThan(0);
        const entry = await providerCatalog(request, PROVIDER_NAME);

        const llmIds = entry.models
          .filter((m) => m.metadata?.model_type === "llm")
          .map((m) => m.model_name ?? "")
          .filter(Boolean)
          .sort();

        // Nothing static can satisfy this: the provider ships no catalog rows, so
        // these ids exist only at the operator's endpoint.
        expect(llmIds).toEqual(probe.ids);

        // `/v1/models` does not distinguish chat from embedding, so every served
        // model is registered once per type (`discovery.py`) — the doubling is the
        // documented contract, and #14199's embedding discovery rides on it.
        expect(entry.num_models).toBe(probe.ids.length * 2);
        expect(entry.is_configured).toBe(true);
      });

      await test.step("the panel renders the discovered models as toggles", async () => {
        await awaitBootstrapTest(page, { skipModal: true });
        await openProviderPanel(page, PROVIDER_ITEM);

        await expect(page.getByTestId("llm-models-section")).toBeVisible({ timeout: 30000 });
        // The first MIN_DEFAULT_MODELS ids (alphabetically, as discovery sorts
        // them) are the default-enabled set, so the first one always has a toggle.
        await expect(page.getByTestId(`llm-toggle-${probe.ids[0]}`)).toBeVisible({
          timeout: 30000,
        });
        await expect(page.getByTestId(PROVIDER_ITEM)).toContainText(/\d+ models/);
      });
    },
  );

  test(
    "a discovered model runs a flow through the OpenAI Compatible provider",
    { tag: ["@model-provider", "@components", "@playground"] },
    async ({ page, request }) => {
      const probe = await probeEndpoint(request);
      test.skip(!probe.usable, `OpenAI-compatible endpoint not usable: ${probe.reason}`);

      const stored = await ocVariables(request);
      test.skip(
        stored.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored
          .map((v) => v.name)
          .join(", ")}) — this test would overwrite and then delete a credential it does not own`,
      );

      await configureProviderViaApi(request);

      // Per-run sentinel: a cached or stale chat message cannot satisfy the
      // assert. Logged, never used to judge model quality.
      const token = `OC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.log(`[openai-compatible] sentinel=${token} model=${TEST_MODEL}`);

      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("point a Basic Prompting flow at the discovered model", async () => {
        // Basic Prompting ships Chat Input → Language Model → Chat Output WIRED;
        // a blank canvas leaves them unconnected and the run persists the user
        // turn with no reply — indistinguishable from a provider failure. Copied
        // over the API rather than clicked in the templates modal, which creates a
        // blank `New Flow` placeholder first (#1005).
        const flowId = await createFlowFromStarter(
          page.request,
          "Basic Prompting",
          `openai-compatible ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        createdFlowIds.push(flowId);
        await openFlowById(page, flowId);

        await expect(page.getByTestId("title-Language Model")).toBeVisible({ timeout: 30000 });
        // Settle the MOUNT autosave before touching the selector, not only after.
        // Opening a flow fits the viewport and schedules its own debounced
        // `PATCH /api/v1/flows/{id}`; the endpoint has no version check and the
        // frontend applies whichever response lands LAST, so a selection made
        // while that PATCH is in flight is silently reverted
        // (`wait-for-flow-save-settled.ts`). Measured here 2/2: the run then
        // executed `chat-latest` — the provider's first default-enabled id, the
        // fallback for an empty selection — which rejects the template's
        // `temperature: 0.1` (`Unsupported value: 'temperature' … Only the default
        // (1) value is supported`), while the widget still read `gpt-4o-mini`.
        await waitForFlowSaveSettled(page);

        await page.getByTestId("model_model").first().click();
        // Provider-QUALIFIED option (scouted live on 1.12.0.dev15): the endpoint
        // under test serves ids the OpenAI provider also serves, so an
        // unqualified locator could pass while running the wrong provider.
        await page.getByTestId(`${PROVIDER_NAME}-${TEST_MODEL}-option`).first().click();
        // The selection autosaves with a debounce; the Playground builds the
        // PERSISTED flow.
        await waitForFlowSaveSettled(page);
        await expect(page.getByTestId("value-dropdown-model_model")).toContainText(TEST_MODEL, {
          timeout: 15000,
        });

        // The widget is NOT the contract — the run builds the PERSISTED flow, and
        // the two disagreed on every failing run above. Gate on what the database
        // holds: the unified selector stores `template.model.value` as an ARRAY of
        // model objects (same shape `agent-credential-settle.ts` reads for the
        // Agent node) and binds `api_key` to the provider's credential NAME. Both
        // must be this provider's, or a green run could be someone else's model.
        await expect
          .poll(async () => persistedModelBinding(request, flowId), { timeout: 30000 })
          .toEqual({ models: [TEST_MODEL], credential: KEY_VAR });
      });

      await test.step("the playground gets a real answer from the endpoint", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 30000,
        });
        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill(`Repeat this token exactly and nothing else: ${token}`);
        await page.getByTestId("button-send").last().click();

        // Deterministic completion signal (never a "did Stop appear?" probe).
        await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 180000 });
        await expect(page.getByTestId("button-send").last()).toBeVisible({ timeout: 30000 });

        // Assert on the PERSISTED reply: the live bubble renders the empty
        // placeholder mid-stream (#634 race).
        const bearer = await getAuthToken(request);
        await expect
          .poll(
            async () => {
              const res = await request.get("/api/v1/monitor/messages", {
                headers: { Authorization: bearer },
              });
              if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
              const messages = (await res.json()) as Array<{
                sender?: string;
                session_id?: string;
                text?: string;
              }>;
              if (!Array.isArray(messages)) return "monitor payload not a list";
              const userMsg = messages.find(
                (m) => m.sender !== "Machine" && (m.text ?? "").includes(token),
              );
              if (!userMsg) return "user message with token not persisted yet";
              const replies = messages
                .filter((m) => m.sender === "Machine" && m.session_id === userMsg.session_id)
                .map((m) => (m.text ?? "").trim());
              if (replies.length === 0) return "AI reply for the session not persisted yet";
              if (replies.every((t) => t === "")) return "AI reply persisted but still empty";
              return replies.some((t) => t.includes(token))
                ? "reply-contains-token"
                : `reply did not echo the token: ${JSON.stringify(
                    replies.map((t) => t.slice(0, 80)),
                  )}`;
            },
            { timeout: 90000 },
          )
          .toBe("reply-contains-token");
      });
    },
  );

  // QUARANTINED — confirmed Langflow defect on 1.12.0.dev15, not a test defect.
  // Saving a base URL + API key from Settings → Model Providers persists ONLY the
  // base URL: the frontend fires the two `POST /api/v1/variables/` writes
  // concurrently (it logs its own `Duplicate request: /api/v1/variables/`), so the
  // PRIMARY key write validates against provider variables that do not yet include
  // the base URL its sibling request is creating, and is rejected
  // `400 {"detail":"Invalid OpenAI-compatible base URL"}` — with nothing surfaced
  // in the UI (no toast, no model count, no disconnect button). Measured 3/3
  // through the UI and isolated against the API on the same instance: sequential
  // writes 201/201, concurrent 201/400. Consequence: an authenticated
  // OpenAI-compatible endpoint cannot be configured through Settings at all.
  //
  // The asserts below are the CORRECT contract and stay untouched. Following the
  // repo's live-defect convention (`api-folders-crud.spec.ts` #965/LE-2020,
  // `mcp-server.spec.ts` #1266): `test.fixme` without `@stable` until the fix
  // reaches `langflowai/langflow-nightly:latest`. Lifting it (remove `test.fixme`,
  // add `@stable`) is a deliverable of LE-2124
  // (https://datastax.jira.com/browse/LE-2124), filed from this evidence.
  // Evidence: docs/core-functionality/model-provider/openai-compatible-provider-setup.md
  // → "Finding this spec encodes".
  //
  // Declared LAST on purpose: `mode: "serial"` skips the rest of the describe after
  // a failure, so in its narrative position (4th) its red cost the discovery and
  // execution tests their run — measured, not hypothesised.
  test.fixme(
    "saving a base URL and an API key through Settings persists BOTH variables",
    { tag: ["@regression", "@model-provider", "@settings"] },
    async ({ page, request }) => {
      const probe = await probeEndpoint(request);
      test.skip(!probe.usable, `OpenAI-compatible endpoint not usable: ${probe.reason}`);

      const stored = await ocVariables(request);
      test.skip(
        stored.length > 0,
        `this instance already has ${PROVIDER_NAME} configured (${stored
          .map((v) => v.name)
          .join(", ")}) — this test would overwrite and then delete a credential it does not own`,
      );

      await awaitBootstrapTest(page, { skipModal: true });
      await openProviderPanel(page, PROVIDER_ITEM);

      await test.step("the credentials validate", async () => {
        await page.getByTestId(BASE_URL_INPUT).fill(TEST_BASE_URL);
        await page.getByTestId(KEY_INPUT).fill(TEST_API_KEY);

        // Armed BEFORE the click so the pass is caused by THIS save, never by a
        // pre-existing configured state.
        const validatePromise = armValidateResponse(page);
        const persistPromise = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/variables/") &&
            (r.request().method() === "POST" || r.request().method() === "PATCH"),
          { timeout: 60000 },
        );

        await page.getByRole("button", { name: /^Save$|^Replace$/ }).first().click();

        const [validateResp] = await Promise.all([validatePromise, persistPromise]);
        expect(validateResp.status()).toBe(200);
        const validateBody = (await validateResp.json()) as {
          valid?: boolean;
          error?: string;
        };
        expect(
          validateBody.valid,
          `validate-provider rejected the credentials: ${validateBody.error ?? "(no error)"}`,
        ).toBe(true);
      });

      await test.step("both variables are stored", async () => {
        // Poll for the PAIR, not for one response: a two-variable provider issues
        // two separate writes and waiting on the first is a race the Foundry
        // sibling measured losing ~1 run in 3. The pair is the backend fact
        // "this provider is configured", independent of how many requests the
        // frontend chose to make.
        //
        // THIS is the step that fails on 1.12.0.dev15: the key write is rejected
        // 400 `Invalid OpenAI-compatible base URL` because it validates against
        // provider variables that do not yet include the base URL created by its
        // own sibling request — and the UI reports nothing. Do not "fix" it by
        // relaxing the assert: a half-configured provider is the defect.
        await expect
          .poll(async () => ocVariableNames(request), { timeout: 30000 })
          .toEqual([KEY_VAR, BASE_URL_VAR].sort());
      });

      await test.step("the panel reflects a configured provider", async () => {
        await expect(page.getByTestId("provider-disconnect-button")).toBeVisible({
          timeout: 30000,
        });
        await expect(page.getByTestId(PROVIDER_ITEM)).toContainText(/\d+ models/, {
          timeout: 30000,
        });
      });
    },
  );
});
