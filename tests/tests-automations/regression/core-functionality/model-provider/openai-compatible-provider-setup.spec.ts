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
 * That coupling WAS a live defect (LE-2124), measured 3/3 on 1.12.0.dev15 and
 * isolated against the API: the Settings Save fires the two `POST /api/v1/variables/`
 * writes CONCURRENTLY (the frontend logs its own `Duplicate request:
 * /api/v1/variables/`), so the primary key write validated against provider
 * variables that did not yet include the just-created base URL and was rejected
 * `400 {"detail":"Invalid OpenAI-compatible base URL"}`, with nothing surfaced in
 * the UI. Sequential writes over the API: 201/201. Concurrent: 201/400.
 *
 * FIXED upstream by 1.12.0.dev19: concurrent API writes now answer 201/201 3/3, and
 * the LAST test — which asserts the correct behaviour and whose assertions were never
 * relaxed — passes 3/3 through the UI. Its `test.fixme` quarantine is lifted and it
 * carries `@stable` (measured while working #1334). Tests 4-5 still configure the pair
 * over the API, sequentially: their subject is discovery and execution, not the save.
 *
 * A SECOND property of being live-only shapes every read in tests 4-5, and is what
 * #1364 measured: the catalog is recomputed on every request, so the endpoint's
 * latency is inside the assertion. `discovery.py` fetches once per model type with a
 * 5 s timeout and degrades to `[]` on any failure without raising, so one stalled call
 * halves `num_models` (248 → 124) and two empty it — silently, and permanently rather
 * than only while warming up. Measured on 1.12.0.dev23 a minute after configuring:
 * 22 of 30 reads complete, 7 partial, 1 empty, against 4 of 20 endpoint calls taking
 * ≥ 20 s from inside the container. Hence every read here is POLLED on the shape it
 * must terminate at, and the panel — which makes its own uncached request — is reopened
 * rather than waited on. Nothing is softened by that: the poll cannot reach `2 × ids`
 * if the second registration ever really stops.
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
 *   exercising the wrong provider;
 * - the run test gates on the PERSISTED node's `provider`, and enables its model for
 *   the provider itself rather than inheriting ambient model-status (#1334 — see
 *   `persistedModelBinding` and `setModelEnabled`).
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
 * A `400` on the key write whose reason is the endpoint being unreachable RIGHT NOW —
 * the backend validates the key by calling the endpoint, so a stalled network answers
 * `Connection to the OpenAI-compatible endpoint … timed out` / `DNS resolution failed`.
 *
 * Kept strictly separate from `Invalid OpenAI-compatible base URL`, which is the
 * LE-2124 class and a real defect: this predicate must never swallow that one.
 */
function isTransportRejection(body: string): boolean {
  return /timed out|DNS resolution failed|Could not connect to the OpenAI-compatible endpoint/i.test(
    body,
  );
}

/**
 * Creates the pair SEQUENTIALLY — the base URL write is awaited before the key
 * write starts, which is exactly what the Settings UI does not do (test 4). This
 * is setup, not the behaviour under test, so it takes the path that works.
 *
 * Returns a skip reason when the write cannot complete because the ENDPOINT is
 * unreachable at that moment, and `""` when the pair is stored. Setup that fails on
 * transport is an environment abort, not a spec verdict (#1074's rule, and this file's
 * own convention that an unusable endpoint skips with a reason rather than reds a test
 * with a confusing message). One retry first, because the stall is transient — measured
 * on a degraded local network as ~2 calls in 12 taking 20-25 s while the rest take 0.6 s.
 * A `400` that is NOT transport-shaped (`Invalid OpenAI-compatible base URL`) still
 * fails loudly: that is the defect this file exists to catch.
 */
async function configureProviderViaApi(request: APIRequestContext): Promise<string> {
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

  for (let attempt = 0; attempt < 2; attempt++) {
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
    if (keyRes.status() === 201) return "";
    const body = await keyRes.text();
    if (!isTransportRejection(body)) {
      expect(keyRes.status(), `POST /variables/ ${KEY_VAR} -> ${keyRes.status()} ${body}`).toBe(
        201,
      );
    }
    console.log(
      `[openai-compatible] ${KEY_VAR} write rejected on transport (attempt ${attempt + 1}/2): ${body}`,
    );
  }
  return `the endpoint under test was unreachable while storing ${KEY_VAR} — setup could not complete, so this is an environment abort and not a spec verdict`;
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
 * The Language Model node's model binding, as PERSISTED — the state the run actually
 * builds from.
 *
 * `template.model.value` is an ARRAY of model objects on the 1.11+ unified selector
 * (the shape `helpers/flows/agent-credential-settle.ts` documents for the Agent node),
 * each carrying a `name` and the `provider` Langflow spells it under. Tolerant of
 * partial payloads: it runs inside a poll, so a transient shape must read as "not
 * settled yet" rather than throw. The node is located by its `model_name` template
 * field — the Language Model component is the only node the Basic Prompting template
 * carries with one.
 *
 * `credential` (`template.api_key.value`) is REPORTED, never asserted (#1334, the same
 * call `agent-credential-settle.ts` made for the Agent node under #1274). Upstream
 * #14311 ("stop automatic provider field binding", on the 1.12 line since 2026-08-04)
 * deleted the block that wrote the variable NAME into it, so it reads `""` on every
 * build from mount onward — measured here on 1.12.0.dev18 for the OpenAI Compatible
 * selection AND, identically, for a plain OpenAI one, which is what proves the empty
 * value is build-wide rather than a persistence failure on this provider. It stays on
 * the probe because the poll prints it, and a reader who knows the old behaviour needs
 * to see that it really is empty rather than wonder whether it was checked.
 */
async function persistedModelBinding(
  request: APIRequestContext,
  flowId: string,
): Promise<{ models: string[]; providers: string[]; credential: string }> {
  const bearer = await getAuthToken(request);
  const res = await request.get(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: bearer },
  });
  if (res.status() !== 200) {
    return { models: [], providers: [], credential: `GET flow -> ${res.status()}` };
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
  // A bare string is a model NAME and says nothing about the provider — the
  // pre-unified-selector shape, tolerated so a stale payload degrades to "no provider
  // observed" rather than to a wrong one.
  const pairs = entries.map((entry) => {
    if (typeof entry === "string") return { name: entry, provider: "" };
    const record = entry as Record<string, unknown> | null;
    const str = (key: string) =>
      typeof record?.[key] === "string" ? (record[key] as string) : "";
    return { name: str("name"), provider: str("provider") };
  });
  const credential =
    typeof template?.api_key?.value === "string" ? template.api_key.value : "";
  return {
    models: pairs.map((p) => p.name).filter((name) => name.length > 0),
    providers: pairs.map((p) => p.provider).filter((provider) => provider.length > 0),
    credential,
  };
}

/**
 * Model-level enablement for one id (`POST /api/v1/models/enabled_models`), the call
 * the Azure AI Foundry sibling in this folder already makes.
 *
 * Test 5 needs it because the node's model dropdown is built from the
 * **default-enabled or explicitly enabled** ids only
 * (`lfx/base/models/unified_models/model_catalog.py`), and `gpt-4o-mini` carries
 * `default: false` in this provider's live catalog — only the first five ids
 * alphabetically are defaults. Measured 2/2 on a clean 1.12.0.dev18:
 * `OpenAI Compatible-gpt-4o-mini-option` never renders and the click times out, well
 * before the binding assertion is reached. It passed in CI only because the daily's
 * shared instance carries model-status written by other specs — ambient state this
 * spec never declared, so it declares it now (#1334).
 */
/** `GET /api/v1/models/enabled_models` → the provider's `{model_name: enabled}` map. */
async function enabledModelsFor(
  request: APIRequestContext,
  provider: string,
): Promise<Record<string, boolean>> {
  const bearer = await getAuthToken(request);
  const res = await request.get("/api/v1/models/enabled_models", {
    headers: { Authorization: bearer },
  });
  if (res.status() !== 200) return {};
  const body = (await res.json().catch(() => ({}))) as {
    enabled_models?: Record<string, Record<string, boolean>>;
  };
  return body.enabled_models?.[provider] ?? {};
}

async function setModelEnabled(
  request: APIRequestContext,
  model: string,
  enabled: boolean,
): Promise<number> {
  const bearer = await getAuthToken(request);
  const res = await request.post("/api/v1/models/enabled_models", {
    headers: { Authorization: bearer, "Content-Type": "application/json" },
    data: [{ provider: PROVIDER_NAME, model_id: model, enabled, model_type: "llm" }],
  });
  if (res.status() !== 200) {
    // A bare "expected 200, received 400" is an unattributed red: the backend puts the
    // reason in `detail` (the Foundry sibling's note, same endpoint).
    const body = await res.text();
    console.log(
      `POST /api/v1/models/enabled_models ${model} enabled=${enabled} -> ${res.status()} ${body.slice(
        0,
        200,
      )}${isTransportRejection(body) ? " [transport — the endpoint was unreachable]" : ""}`,
    );
  }
  return res.status();
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
 *
 * The budget below is NOT the suite's usual 15 s, and the difference is this
 * provider's doing: the page builds its list from `GET /api/v1/models`, which runs
 * live discovery for every configured live-only provider inside the request. Timed on
 * 1.12.0.dev23 with the pair stored, 20 samples: p50 5.0 s, p90 8.9 s, **max 14.6 s**
 * — so a 15 s wait sits ON the observed maximum and reds on the tail, which is what
 * run 5 of #1364's validation burst did (`provider-list` not found, 15 s, on a healthy
 * provider). 45 s covers it with room and costs nothing on the fast path or on the
 * unconfigured tests, where discovery returns immediately for want of a base URL.
 */
const PANEL_TIMEOUT_MS = 45000;

async function openProviderPanel(page: Page, providerItemTestId: string): Promise<void> {
  await new SettingsPage(page).navigate();
  await page.getByTestId("sidebar-nav-Model Providers").click();
  await expect(page.getByTestId("settings_menu_header").last()).toContainText(
    "Model Providers",
    { timeout: 15000 },
  );
  await expect(page.getByTestId("provider-list")).toBeVisible({
    timeout: PANEL_TIMEOUT_MS,
  });
  await page.getByTestId(providerItemTestId).click();
  await expect(page.getByTestId(BASE_URL_INPUT)).toBeVisible({
    timeout: PANEL_TIMEOUT_MS,
  });
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
  const enabledModels: string[] = [];

  test.afterEach(async ({ request }) => {
    // Model status is account-wide too, and `model_status_contains` matches a BARE
    // entry for ANY provider — so a leftover enable is exactly the ambient state
    // #1334 was about. Disable before the credentials go: the write validates against
    // the configured provider.
    for (const model of enabledModels.splice(0)) {
      await setModelEnabled(request, model, false).catch(() => 0);
    }

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
        // The bearer can only be judged if the endpoint was REACHED. When it was not,
        // the validator answers its transport message instead, and asserting the auth
        // text there measures the network, not the product — so skip with the reason,
        // the same rule the setup writes in tests 4-5 follow. `valid: false` above is
        // still asserted in both cases: a reachable-or-not endpoint must never validate
        // a bogus key.
        test.skip(
          isTransportRejection(body.error ?? ""),
          `the endpoint under test was unreachable, so the bearer was never judged: ${body.error ?? ""}`,
        );
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

  // Quarantined at triage (daily #1361) on the reading that discovery had stopped
  // registering each served model twice. Refuted and un-quarantined under #1364:
  // both halves are registered, and a `num_models` of 124 is one of the two live
  // fetches having timed out on that request — see the comment inside step 1.
  test(
    "the configured provider discovers exactly the models its endpoint serves",
    { tag: ["@stable", "@api", "@model-provider", "@settings"] },
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
      const setupSkip = await configureProviderViaApi(request);
      test.skip(setupSkip !== "", setupSkip);

      await test.step("the llm catalog equals the endpoint's own /v1/models ids", async () => {
        // Live discovery runs PER REQUEST, and a stalled endpoint silently costs a
        // whole half of the catalog. `GET /api/v1/models` calls
        // `fetch_live_openai_compatible_models` once per model type, each a fresh
        // `GET <base>/v1/models` with `_TIMEOUT_SECONDS = 5`, and ANY failure returns
        // `[]` instead of raising (`lfx_openai_compatible/discovery.py`, whose
        // docstring states the degrade). So one read is 248 when both calls answer in
        // time, 124 when either times out, and 0 when both do — with nothing in the
        // response saying which happened.
        //
        // Measured on 1.12.0.dev23 (#1364), 30 consecutive reads taken a full MINUTE
        // after configuring, so this is not a warm-up window that converges: 22× 248,
        // 6× `{llm}` only, 1× `{embeddings}` only, 1× empty. Which half is missing
        // varies, which is what rules out "the second registration stopped happening".
        // The cause is on the wire: 20 authenticated `GET https://api.openai.com/v1/
        // models` from inside the container measured 16 at 0.6-1.1 s and 4 at ≥ 20 s.
        //
        // Poll the TERMINAL shape, and assert it in ONE comparison, so a partial read
        // reads as "the endpoint stalled on this request" rather than as a wrong
        // catalog. A real removal of the second registration still reds: the poll can
        // never reach `2 × ids` and fails with the full expected-vs-received shape.
        //
        // Nothing static can satisfy the id set: the provider ships no catalog rows, so
        // these ids exist only at the operator's endpoint. `/v1/models` does not
        // distinguish chat from embedding, so every served model is registered once per
        // type (`discovery.py`) — the doubling is the documented contract, and #14199's
        // embedding discovery rides on it.
        await expect
          .poll(
            async () => {
              const entry = await providerCatalog(request, PROVIDER_NAME);
              return {
                llmIds: entry.models
                  .filter((m) => m.metadata?.model_type === "llm")
                  .map((m) => m.model_name ?? "")
                  .filter(Boolean)
                  .sort(),
                num_models: entry.num_models,
                is_configured: entry.is_configured,
              };
            },
            { timeout: 60000 },
          )
          .toEqual({
            llmIds: probe.ids,
            num_models: probe.ids.length * 2,
            is_configured: true,
          });
      });

      await test.step("the panel renders the discovered models as toggles", async () => {
        await awaitBootstrapTest(page, { skipModal: true });

        // The first MIN_DEFAULT_MODELS ids (alphabetically, as discovery sorts
        // them) are the default-enabled set, so the first one always has a toggle.
        const firstToggle = page.getByTestId(`llm-toggle-${probe.ids[0]}`);

        // The panel issues its OWN catalog request, subject to the same per-request
        // stall as the poll above — and it does not refetch. A page that loaded on an
        // embeddings-only read renders no `llm-toggle-*` at all, so a bare
        // `toBeVisible` would sit out its whole timeout against a provider the step
        // above just proved complete (1 read in 30 above, and 1 more empty). Reopen
        // the panel up to 3 times, each logged; the LAST attempt is not caught, so a
        // page that genuinely cannot render reds with its own error, and the
        // assertions after the loop are unconditional either way.
        for (let attempt = 0; attempt < 3; attempt++) {
          const lastAttempt = attempt === 2;
          try {
            await openProviderPanel(page, PROVIDER_ITEM);
          } catch (e) {
            if (lastAttempt) throw e;
            console.log(
              `[openai-compatible] the provider panel did not render — the page's own catalog read stalled (attempt ${attempt + 1}/3): ${
                (e as Error).message.split("\n")[0]
              }`,
            );
            continue;
          }
          const rendered = await firstToggle
            .waitFor({ state: "visible", timeout: 20000 })
            .then(() => true)
            .catch(() => false);
          if (rendered) break;
          console.log(
            `[openai-compatible] llm-toggle-${probe.ids[0]} absent — the panel's own catalog read returned no llm half (attempt ${attempt + 1}/3)`,
          );
        }

        await expect(page.getByTestId("llm-models-section")).toBeVisible({ timeout: 30000 });
        await expect(firstToggle).toBeVisible({ timeout: 30000 });
        await expect(page.getByTestId(PROVIDER_ITEM)).toContainText(/\d+ models/);
      });
    },
  );

  test(
    "a discovered model runs a flow through the OpenAI Compatible provider",
    { tag: ["@stable", "@model-provider", "@components", "@playground"] },
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

      const setupSkip = await configureProviderViaApi(request);
      test.skip(setupSkip !== "", setupSkip);

      // Writing the two variables does not mean live discovery has run: the catalog
      // fills on a later request, so enabling a model the provider has not discovered
      // yet is a 200 that changes nothing. Gate on the model being DISCOVERED first —
      // measured once in 8 validation runs as `OpenAI Compatible-gpt-4o-mini-option`
      // still absent after 20 s.
      await expect
        .poll(
          async () =>
            (await providerCatalog(request, PROVIDER_NAME)).models.some(
              (m) => m.model_name === TEST_MODEL && m.metadata?.model_type === "llm",
            ),
          { timeout: 60000 },
        )
        .toBe(true);

      // The dropdown offers default-enabled or explicitly enabled ids only, and
      // TEST_MODEL need not be a default (`gpt-4o-mini` is not) — so enable it here
      // instead of inheriting whatever the instance happens to carry (#1334).
      //
      // This write validates against the live endpoint too, so it gets the same
      // treatment as the credential write: a transport rejection is retried once and
      // then skips with the reason, while any other non-200 fails loudly.
      let enableStatus = await setModelEnabled(request, TEST_MODEL, true);
      if (enableStatus !== 200) enableStatus = await setModelEnabled(request, TEST_MODEL, true);
      test.skip(
        enableStatus === 400,
        `the endpoint under test was unreachable while enabling ${TEST_MODEL} — setup could not complete, so this is an environment abort and not a spec verdict`,
      );
      expect(
        enableStatus,
        `enabling ${TEST_MODEL} for ${PROVIDER_NAME} must succeed — the option is not offered otherwise`,
      ).toBe(200);
      enabledModels.push(TEST_MODEL);
      // And gate on the write having taken effect, so a slow status refresh is a wait
      // rather than a missing option 20 s later inside the UI step.
      await expect
        .poll(async () => (await enabledModelsFor(request, PROVIDER_NAME))[TEST_MODEL] === true, {
          timeout: 30000,
        })
        .toBe(true);

      // Per-run sentinel: a cached or stale chat message cannot satisfy the
      // assert. Logged, never used to judge model quality.
      const token = `OC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.log(`[openai-compatible] sentinel=${token} model=${TEST_MODEL}`);

      await awaitBootstrapTest(page, { skipModal: true });

      /** Opens the model selector and picks THIS provider's entry for TEST_MODEL. */
      const selectTestModel = async (): Promise<void> => {
        await page.getByTestId("model_model").first().click();
        // Provider-QUALIFIED option (scouted live on 1.12.0.dev15): the endpoint
        // under test serves ids the OpenAI provider also serves, so an
        // unqualified locator could pass while running the wrong provider.
        const option = page.getByTestId(`${PROVIDER_NAME}-${TEST_MODEL}-option`).first();
        // The option list comes from the component's CACHED build config
        // (`update_model_options_in_build_config`), which can predate the enable write
        // above even though the catalog and the enabled-models map already agree —
        // measured once in 7 runs as a 20 s click timeout on an id the API reported
        // discovered AND enabled. The dropdown ships the repair itself: "Refresh List"
        // rebuilds the options. Bounded at 3 tries, each logged, then the click's own
        // timeout reds the test.
        for (let attempt = 0; attempt < 3; attempt++) {
          // `waitFor`, not `isVisible({ timeout })` — the latter's timeout is ignored.
          const visible = await option
            .waitFor({ state: "visible", timeout: 10000 })
            .then(() => true)
            .catch(() => false);
          if (visible) break;
          console.log(
            `[openai-compatible] ${PROVIDER_NAME}-${TEST_MODEL}-option not offered yet — refreshing the list (attempt ${attempt + 1}/3)`,
          );
          await page.getByRole("button", { name: "Refresh List" }).first().click();
          // The refresh closes the popover on some builds; reopen when it did.
          if (!(await option.isVisible().catch(() => false))) {
            await page.getByTestId("model_model").first().click();
          }
        }
        await option.click();
        // The selection autosaves with a debounce; the Playground builds the
        // PERSISTED flow.
        await waitForFlowSaveSettled(page);
      };

      let flowId = "";

      await test.step("point a Basic Prompting flow at the discovered model", async () => {
        // Basic Prompting ships Chat Input → Language Model → Chat Output WIRED;
        // a blank canvas leaves them unconnected and the run persists the user
        // turn with no reply — indistinguishable from a provider failure. Copied
        // over the API rather than clicked in the templates modal, which creates a
        // blank `New Flow` placeholder first (#1005).
        flowId = await createFlowFromStarter(
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

        await selectTestModel();
        await expect(page.getByTestId("value-dropdown-model_model")).toContainText(TEST_MODEL, {
          timeout: 15000,
        });

        // The widget is NOT the contract — the run builds the PERSISTED flow, and the
        // two disagreed on every failing run above (1 selection in 5 still lands on the
        // editor's mount default, `claude-opus-5` / Anthropic). Gate on what the
        // database holds: the unified selector stores `template.model.value` as an
        // ARRAY of model objects (same shape `agent-credential-settle.ts` reads for the
        // Agent node), each carrying the model NAME and its PROVIDER. Both must be this
        // provider's, or a green run could be someone else's model.
        //
        // The provider — not a stored credential name — is the axis, because it is what
        // the runtime derives the key from: `instantiation.py` reads
        // `model.value[0].provider` and calls `get_api_key_for_provider`, which with an
        // empty `api_key` resolves `get_provider_secret_variable_key(provider)`.
        // Measured causally on 1.12.0.dev18: dropping ONLY OPENAI_COMPATIBLE_API_KEY
        // while a valid OPENAI_API_KEY stays configured account-wide turns this same run
        // into `401 Incorrect API key provided: EMPTY` (#1334).
        //
        // `toMatchObject`, not `toEqual`: the probe also carries `credential`, which is
        // printed in this poll's failure diagnostic and asserted in NEITHER direction —
        // requiring it empty would swap one dated premise (#14311 removed the binding)
        // for another and break a `manual.yml` dispatch at a pre-#14311 build.
        await expect
          .poll(async () => persistedModelBinding(request, flowId), { timeout: 30000 })
          .toMatchObject({ models: [TEST_MODEL], providers: [PROVIDER_NAME] });
      });

      await test.step("the playground gets a real answer from the endpoint", async () => {
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({
          timeout: 30000,
        });

        // Re-read the binding at the LAST moment the run can still be influenced, so a
        // failure below is attributed rather than mysterious. This is evidence, not a
        // repair: measured twice in 12 runs on 1.12.0.dev19, the run died on
        // `404 … This is not a chat model … Did you mean to use v1/completions?` — the
        // signature of an EMPTY model field falling back to the provider's first
        // default-enabled id (`babbage-002`) — while this very read still returned
        // `gpt-4o-mini` / `OpenAI Compatible`. So the substitution is NOT a persistence
        // reversion, and re-selecting cannot fix it: the `POST /api/v2/workflows` run
        // did not build what the database holds. Keeping the read makes the next
        // occurrence say that in one line instead of implying a stale selection.
        expect(
          await persistedModelBinding(request, flowId),
          "the persisted binding must still be this provider's model when the run is sent — if the run then executes another model, the run did not build the persisted flow",
        ).toMatchObject({ models: [TEST_MODEL], providers: [PROVIDER_NAME] });
        await page
          .getByTestId("input-chat-playground")
          .last()
          .fill(`Repeat this token exactly and nothing else: ${token}`);
        await page.getByTestId("button-send").last().click();

        // Deterministic completion signal (never a "did Stop appear?" probe).
        await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 180000 });
        await expect(page.getByTestId("button-send").last()).toBeVisible({ timeout: 30000 });

        // An account with no credits is an environment abort, not a spec verdict — and
        // it is invisible to `probeEndpoint`, because `GET /v1/models` answers 200 for a
        // drained key (measured). Left unattributed it surfaces 90 s later as "AI reply
        // for the session not persisted yet", which reads like a product failure: that
        // is exactly how it presented on a 2.2 min red. The run renders the provider's
        // own message, so read it here and skip with it.
        //
        // Deliberately narrow: this matches a DRAINED ACCOUNT, never a rate limit. A
        // 429 that says `rate_limit_exceeded` still reds the test, because that one the
        // suite should see.
        const pageText = await page.locator("body").innerText();
        const quota = pageText.match(
          /(?:You (?:have )?(?:exceeded your current quota|have no credits remaining)|insufficient_quota|billing_not_active)[^\n]{0,160}/i,
        );
        test.skip(
          quota !== null,
          `the endpoint's account cannot serve completions, so the run produced no reply: ${quota?.[0] ?? ""}`,
        );

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

  // QUARANTINE LIFTED on 1.12.0.dev19 (LE-2124 fixed upstream).
  //
  // This test was `test.fixme` against a confirmed Langflow defect: saving a base URL
  // + API key from Settings → Model Providers persisted ONLY the base URL, because the
  // frontend fires the two `POST /api/v1/variables/` writes concurrently (it logs its
  // own `Duplicate request: /api/v1/variables/`) and the PRIMARY key write validated
  // against provider variables that did not yet include the base URL its sibling
  // request was creating — rejected `400 {"detail":"Invalid OpenAI-compatible base
  // URL"}`, with nothing surfaced in the UI. Measured 3/3 through the UI on
  // 1.12.0.dev15 and isolated against the API: sequential writes 201/201, concurrent
  // 201/400. The asserts were never relaxed while it was quarantined.
  //
  // Re-measured on 1.12.0.dev19 while working #1334: concurrent API writes answer
  // 201/201 3/3, and this test passes 3/3 through the UI. So the quarantine comes off
  // (`test.fixme` removed, `@stable` added) — LE-2124's own lift condition.
  // Evidence: docs/core-functionality/model-provider/openai-compatible-provider-setup.md
  // → "Finding this spec encodes".
  //
  // Declared LAST on purpose: `mode: "serial"` skips the rest of the describe after
  // a failure, so in its narrative position (4th) its red cost the discovery and
  // execution tests their run — measured, not hypothesised.
  test(
    "saving a base URL and an API key through Settings persists BOTH variables",
    { tag: ["@stable", "@regression", "@model-provider", "@settings"] },
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

      // Every rejected variable write the Save fires, with its body — the ONLY thing
      // that separates the two ways this test can end with just the base URL stored.
      // LE-2124 answers `400 Invalid OpenAI-compatible base URL` (the concurrency race,
      // which is the defect under test); an endpoint that is unreachable at that moment
      // answers `400 … timed out` / `DNS resolution failed`, which is the environment.
      // Without this the end state is identical and the red means nothing.
      const writeRejections: string[] = [];
      page.on("response", (r) => {
        if (!r.url().includes("/api/v1/variables/")) return;
        const method = r.request().method();
        if (method !== "POST" && method !== "PATCH") return;
        if (r.status() < 400) return;
        void r
          .text()
          .then((body) => writeRejections.push(body))
          .catch(() => writeRejections.push(`<body unavailable, status ${r.status()}>`));
      });

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
        // THIS is the step that failed on 1.12.0.dev15: the key write was rejected
        // 400 `Invalid OpenAI-compatible base URL` because it validated against
        // provider variables that did not yet include the base URL created by its
        // own sibling request — and the UI reported nothing. Fixed by 1.12.0.dev19.
        // Do not "fix" a future red by relaxing the assert: a half-configured
        // provider is the defect, and this pair is what "configured" means.
        //
        // Polled by hand rather than with `expect.poll` so the rejection bodies can be
        // consulted BEFORE the verdict: an unreachable endpoint leaves exactly the same
        // end state as the race, and calling that a defect would be a false positive.
        const expected = [KEY_VAR, BASE_URL_VAR].sort();
        let names: string[] = [];
        const deadline = Date.now() + 30000;
        do {
          names = await ocVariableNames(request);
          if (names.length === expected.length) break;
          await page.waitForTimeout(1000);
        } while (Date.now() < deadline);

        const transport = writeRejections.filter(isTransportRejection);
        test.skip(
          names.length !== expected.length && transport.length > 0,
          `the endpoint under test was unreachable while the Save stored the pair, so the write never reached the concurrency path this test is about: ${transport[0]}`,
        );
        expect(
          names,
          writeRejections.length
            ? `variable writes rejected during the Save: ${JSON.stringify(writeRejections)}`
            : "the Save stored no rejection — the pair simply never completed",
        ).toEqual(expected);
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
