import * as dotenv from "dotenv";
import path from "path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage } from "../../../../pages";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";
import {
  hasProviderEnvKeys,
  keyedProviderNames,
  langflowProviderName,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { waitForProviderRow } from "../../../../helpers/provider-setup/provider-list-state";
import {
  censusForTarget,
  enumerateEnabledModels,
  enumerateModelOptions,
  hasOptionIdentity,
  type ModelOption,
  type PickerCensus,
} from "../../../../helpers/provider-setup/model-option";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Resolve the provider to drive the test. The behavior under test (per-model
// enable/disable toggles in Settings → Model Providers) is provider-agnostic,
// so a single env-configured provider is enough. Priority: MODEL_TEST_PROVIDER
// (when its env keys are set) > first KEYED provider with env keys configured.
//
// Scoped to `keyedProviderNames` rather than the whole map (#1187) to keep this
// selection exactly what it was before a keyless provider existed. `hasProviderEnvKeys`
// answers "are this provider's env vars set", and for Ollama that is a base URL — so
// on a box with OLLAMA_BASE_URL exported and no API key, an unscoped `.find()` would
// silently hand this spec a local provider it was never validated against.
const envProvider = process.env.MODEL_TEST_PROVIDER as Provider | undefined;
const provider: Provider | undefined =
  envProvider && hasProviderEnvKeys(envProvider)
    ? envProvider
    : keyedProviderNames.find(hasProviderEnvKeys);

const skipReason = provider
  ? undefined
  : `No provider has its env keys configured (need one of: ${keyedProviderNames
      .map((p) => missingProviderEnvKeys(p).join("/"))
      .join(" | ")})`;

// The `provider-item-...` testid carries the provider's display name
// ("OpenAI", "Anthropic", …), which is the single source of truth in
// provider-config.ts.
const providerItemTestId = provider
  ? providerConfigMap[provider].providerTestId
  : "";

// The provider as LANGFLOW spells it ("OpenAI", "Google Generative AI") — the same
// string the picker groups its options by (`ModelList` renders
// `data-value="${provider}::${model}"` and the panel `provider-item-${provider}`,
// both from the models API). Derived, never a second table (#1043/#1184).
const providerLabel = provider ? langflowProviderName(provider) : "";

const ENABLED_MODELS_ENDPOINT = "/api/v1/models/enabled_models";

// SimpleAgentTemplatePage.load() does NO cleanup (post-#553 contract) and the
// canvas URL id is transient on 1.11 — track every flow the load actually
// creates (POST /api/v1/flows → 201) and delete those ids in afterEach (#605
// pattern; this file previously leaked 2 flows per run).
const createdFlowIds: string[] = [];

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    await deleteFlow(request, id, { headers: { Authorization: bearer } }).catch(() => {});
  }
});

// Model set to DISABLED by the test body and not yet restored by it.
//
// Test 2 mutates ACCOUNT-GLOBAL state, and until #1464 that mutation was
// unreachable — the provider-prefixed model name made the test skip before the
// disable — so no failure-path restore ever existed. Waking the test makes one
// mandatory: a failure between the disable and the re-enable would otherwise leave
// the model off for every later spec. The sibling setups do re-enable everything
// (`[data-testid^="llm-toggle"]:visible` in setup-openai/anthropic/google), but only
// when a later spec configures the SAME provider in the same lane, which the daily's
// weekday provider rotation does not guarantee — and
// `setup-language-model-openai.ts` enables one model and repairs nothing.
let disabledModel: string | null = null;

// Restored over the API, not the UI: after a mid-test failure the page can be
// anywhere, and a restore that needs Settings to render is a restore that fails
// exactly when it is needed. Payload shape shared with
// model-provider/openai-compatible-provider-setup.spec.ts.
test.afterEach(async ({ request }) => {
  const model = disabledModel;
  if (!model || !provider) {
    disabledModel = null;
    return;
  }

  // Retried HERE rather than deferred to a later test's hook. Test 2 is the only
  // test that arms this flag and it is the LAST test in a serial file, so "the next
  // afterEach will retry" describes a hook that never runs — the transient 5xx or
  // transport throw has to be survived on the spot or not at all.
  let lastOutcome = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const bearer = await getAuthToken(request);
      const res = await request.post(ENABLED_MODELS_ENDPOINT, {
        headers: { Authorization: bearer, "Content-Type": "application/json" },
        data: [
          {
            provider: providerLabel,
            model_id: model,
            enabled: true,
            model_type: "llm",
          },
        ],
      });
      if (res.status() === 200) {
        disabledModel = null;
        return;
      }
      lastOutcome = `${res.status()} ${(await res.text()).slice(0, 200)}`;
    } catch (error) {
      lastOutcome = `threw: ${(error as Error)?.message ?? String(error)}`;
    }
  }

  // Left ARMED deliberately. Nothing in this file will act on it today, but a test
  // added after Test 2 would restore it in its own teardown, and an armed flag costs
  // nothing when nothing follows. Loud, never swallowed: a silent failure hands every
  // later spec a disabled model with nothing in the log naming why (#1012).
  console.log(
    `⚠️  could not restore "${model}" for ${providerLabel} after 3 attempts — POST ` +
      `${ENABLED_MODELS_ENDPOINT} -> ${lastOutcome}. Later specs pinning it may skip or fail.`,
  );
});

// Load the Simple Agent template with the configured provider. This configures
// the provider's API key globally and enables all of its models — the known
// baseline both tests start from. MODEL_NOT_AVAILABLE (a model present in
// models.json but absent from the picker) is turned into a skip.
async function loadAgentWithProvider(page: Page): Promise<void> {
  page.on("response", (resp) => {
    if (
      resp.url().includes("/api/v1/flows") &&
      resp.request().method() === "POST" &&
      resp.status() === 201
    ) {
      resp
        .json()
        .then((body: { id?: string }) => {
          if (body?.id) createdFlowIds.push(body.id);
        })
        .catch(() => {}); // non-JSON / batch payloads
    }
  });
  try {
    await new SimpleAgentTemplatePage(page).load({ provider });
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

// Navigate to Settings → Model Providers and expand the configured provider so
// its model toggles render. Clicking the provider item toggles its selection,
// so this assumes the panel was freshly navigated (nothing selected yet).
async function openProviderModelList(page: Page): Promise<void> {
  await navigateSettingsPages(page, "Settings", "Model Providers");
  await expect(page.getByTestId("settings_menu_header").last()).toContainText(
    "Model Providers",
    { timeout: 10000 },
  );
  // Through waitForProviderRow (#1648). The 10 s budget is unchanged and
  // deliberately NOT raised: on the 2026-08-31 daily this line failed twice with
  // `waiting for getByTestId('provider-item-OpenAI') to be visible` while the
  // page was showing "Loading providers..." — an instance stall the run had no
  // way to say. Raising the budget would hide it; naming it is the fix.
  const providerItem = await waitForProviderRow(page, providerItemTestId, 10000);
  await providerItem.click();
  await page
    .getByTestId("model-provider-selection")
    .waitFor({ state: "visible", timeout: 10000 });
  await page
    .getByTestId("llm-models-section")
    .waitFor({ state: "visible", timeout: 10000 });
}

// Filter the model list down to a single model via the search field so its
// toggle is always rendered and on-screen (long provider lists otherwise push
// rows below the scroll fold). Returns the toggle locator.
async function toggleForModel(page: Page, modelName: string): Promise<Locator> {
  const search = page.getByTestId("model-search-input");
  await search.fill(modelName);
  const toggle = page.getByTestId(`llm-toggle-${modelName}`);
  await toggle.waitFor({ state: "visible", timeout: 10000 });
  return toggle;
}

// Flip a toggle and wait for the optimistic UI change plus the debounced POST
// that persists it (useModelToggleQueue debounces the write by 1000ms).
async function setToggle(
  page: Page,
  toggle: Locator,
  enabled: boolean,
): Promise<void> {
  const current = (await toggle.getAttribute("aria-checked")) === "true";
  if (current === enabled) return;
  const save = page.waitForResponse(
    (resp) =>
      resp.url().includes(ENABLED_MODELS_ENDPOINT) &&
      resp.request().method() === "POST",
    { timeout: 15000 },
  );
  await toggle.click();
  // Optimistic update — the switch reflects the new state immediately.
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
  await save;
}

// Reads the OPEN model picker and counts what it establishes about the target.
//
// The classification is `censusForTarget` — pure, in the shared helper, and unit
// tested there, because the branch that must never regress ("a `target: 0` verdict
// is trustworthy ONLY with `total > 0` and `providerOthers > 0`") is otherwise
// reachable only from a live run of a spec that mutates global state.
//
// `timeout` matters and is the caller's business: `enumerateModelOptions` waits for
// the first option and SWALLOWS that timeout, so a long budget inside a poll
// predicate lets one call consume the whole poll deadline (#1464 review).
async function readPickerCensus(
  page: Page,
  target: ModelOption,
  providerModels: Set<string>,
  timeout: number,
): Promise<PickerCensus> {
  return censusForTarget(
    await enumerateModelOptions(page, timeout),
    target,
    providerModels,
  );
}

// Named template loads collide under parallelism — this file is serial and
// the folder is run with --workers=1 (agent-family convention).
test.describe.configure({ mode: "serial" });

test.describe("Model Provider Model Toggle", () => {
  test(
    "model toggle changes immediately and persists across reopen",
    {
      tag: ["@stable", "@regression", "@components", "@model-provider"],
    },
    async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");

      await test.step("configure provider and enable all its models", async () => {
        await loadAgentWithProvider(page);
      });

      let modelName = "";
      let toggle: Locator;

      await test.step("open Model Providers and pick an enabled model", async () => {
        await openProviderModelList(page);
        const firstToggle = page
          .locator('[data-testid^="llm-toggle-"]:visible')
          .first();
        await firstToggle.waitFor({ state: "visible", timeout: 10000 });
        const testId = await firstToggle.getAttribute("data-testid");
        modelName = (testId ?? "").replace("llm-toggle-", "");
        expect(modelName.length).toBeGreaterThan(0);
        toggle = await toggleForModel(page, modelName);
        await expect(toggle).toHaveAttribute("aria-checked", "true");
      });

      await test.step("disable the model — change is immediate and persisted", async () => {
        await setToggle(page, toggle, false);
      });

      await test.step("reopen Model Providers — disabled state persisted", async () => {
        await page.goto("/");
        await openProviderModelList(page);
        const reopened = await toggleForModel(page, modelName);
        await expect(reopened).toHaveAttribute("aria-checked", "false");

        // Restore the baseline so the model stays enabled for other specs.
        await setToggle(page, reopened, true);
        await expect(reopened).toHaveAttribute("aria-checked", "true");
      });
    },
  );

  test(
    "disabling a model removes it from a component model dropdown",
    {
      tag: ["@stable", "@regression", "@components", "@agents", "@model-provider"],
    },
    async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");

      const modelTrigger = page.getByTestId("model_model");
      const modelValue = page.getByTestId("value-dropdown-model_model");

      let flowUrl = "";
      let dropdownOptions: ModelOption[] = [];
      let dropdownSelected = "";
      let providerModels = new Set<string>();
      let target: ModelOption;
      let targetModel = "";

      await test.step("load Agent with configured provider and capture model options", async () => {
        await loadAgentWithProvider(page);
        await expect(modelTrigger).toBeVisible({ timeout: 30000 });
        flowUrl = page.url();

        dropdownSelected = (await modelValue.innerText()).trim();
        await modelTrigger.click();
        // Read every option through the shared identity reader (#1463) rather
        // than deriving a name from the raw testid. The picker's testid is
        // `${provider}-${model}-option` (ModelList.getModelOptionTestId), so the
        // `-option`-suffix strip this used to run yielded "OpenAI-gpt-4.1" and
        // could never intersect the provider panel's bare `llm-toggle-gpt-4.1` —
        // the skip that made this test pass without ever running (#1464).
        dropdownOptions = await enumerateModelOptions(page);
        const seenProviders = [
          ...new Set(dropdownOptions.map((o) => o.provider ?? "(unparsed)")),
        ].join(", ");
        // Scoped to THIS provider, not to the picker as a whole. An all-provider
        // count passes on Anthropic's and Google's options while the test's own
        // provider is absent, and the run then dies further down on a toggle
        // `waitFor` timeout that names no cause — the misattribution a repo with
        // three recorded drained-key incidents cannot afford (#772/#1029/#1169).
        const ownOptions = dropdownOptions.filter(
          (option) => option.provider === providerLabel,
        );
        expect(
          ownOptions.length,
          `the Agent's model picker offers no ${providerLabel} option, so nothing about ` +
            `removal can be proven — ${dropdownOptions.length} option(s) enumerated across ` +
            `[${seenProviders}]. Either the provider was not configured (a rejected or ` +
            `drained key leaves the credential unsaved) or its list never loaded. Reported ` +
            `as a FAILURE, not a skip: zero observations prove nothing (#1461)`,
        ).toBeGreaterThan(0);
        await page.keyboard.press("Escape");
      });

      await test.step("disable the target model in Settings → Model Providers", async () => {
        await openProviderModelList(page);
        // The component dropdown mixes models from EVERY configured provider
        // (#597: with Google configured by sibling specs it listed
        // gemini-3.5-flash first while this test's provider was OpenAI, and
        // the toggle lookup below never resolves). Pick the target from the
        // intersection of the dropdown options and THIS provider's own model
        // list — the attached llm-toggle-* testids Settings just rendered —
        // and never the currently selected model (disabling the active
        // selection would entangle the test with selection-reset logic).
        await page
          .locator('[data-testid^="llm-toggle-"]')
          .first()
          .waitFor({ state: "attached", timeout: 10000 });
        providerModels = new Set(await enumerateEnabledModels(page));
        const ownOptions = dropdownOptions.filter(
          (option) => option.provider === providerLabel,
        );
        // `option.provider === providerLabel` is load-bearing, not decoration. The
        // panel's toggles are BARE model ids, so an id-only intersection also
        // matches an option belonging to a DIFFERENT provider that happens to ship
        // the same id — and that is a configured state in this suite, not a
        // hypothetical: `model-provider/openai-compatible-provider-setup.spec.ts`
        // deliberately enables `OpenAI Compatible::gpt-4o-mini` over the API so its
        // option renders, and the Azure sibling seeds `gpt-4o`/`gpt-4o-mini`/
        // `gpt-4.1` — both `@stable`, same account, `workers: 2`. Without the
        // provider clause the foreign option can become the target, the toggle then
        // gets flipped in the WRONG panel, the removal poll never sees its option
        // leave, and OpenAI's `gpt-4o-mini` is left disabled account-wide.
        //
        // Deprecated models are excluded, not because they cannot be toggled but
        // because their row lives inside the collapsed `*-deprecated-disclosure`
        // section: `toggleForModel` waits for a VISIBLE toggle and would time out
        // on a cause that has nothing to do with the behavior under test.
        const providerOptions = ownOptions.filter(
          (option) =>
            option.model !== null &&
            providerModels.has(option.model) &&
            !option.deprecated,
        );
        // Loud rather than skipped, but claiming LESS than it used to. The picker is
        // a FILTERED subset of the panel by design — the Agent declares a
        // `tool_calling` filter and only enabled models are offered — so an empty
        // intersection is not necessarily a defect, and the message no longer says it
        // is. What justifies failing is narrower and holds regardless of the cause:
        // zero comparable models means the behavior was never exercised, and a test
        // that exercised nothing must not read as coverage (#1461/#1012).
        expect(
          providerOptions.length,
          `none of the ${ownOptions.length} ${providerLabel} option(s) the picker offers is a ` +
            `non-deprecated model the provider panel also lists (${providerModels.size} ` +
            `llm-toggle-* rendered, every state and deprecated rows included), so there is ` +
            `nothing whose removal this test could observe. The picker is a filtered subset ` +
            `of the panel, so this is not necessarily a defect — it fails rather than skips ` +
            `because a test that exercised nothing must not count as coverage`,
        ).toBeGreaterThan(0);

        const candidates = providerOptions.filter(
          (option) => option.model !== dropdownSelected,
        );
        // The one legitimately untestable state, and it is degenerate: the
        // provider offers a single non-deprecated model and it is the one the
        // Agent has selected. The reason names the counts so it cannot be read
        // as the blanket skip it replaces.
        test.skip(
          candidates.length === 0,
          `${providerLabel} offers exactly ${providerOptions.length} non-deprecated model(s) in ` +
            `the picker and the only one is the selected "${dropdownSelected}" — removing the ` +
            `active selection would entangle this test with selection-reset logic.`,
        );
        target = candidates[0];
        targetModel = target.model ?? "";
        // Refused HERE, before anything is polled against it: a target carrying
        // neither `data-value` nor `data-testid` matches no option at all, so every
        // later "it is no longer offered" verdict about it is vacuous. Review
        // reproduced exactly that by blanking both attributes — the removal step
        // PASSED, and the run only reddened 25 s later at the re-enable, blaming the
        // product for a suite defect.
        expect(
          hasOptionIdentity(target),
          `the target option carries neither data-value nor data-testid (visible label ` +
            `"${target.visibleLabel}"), so nothing can be matched against it and every ` +
            `removal verdict below would be vacuous`,
        ).toBe(true);
        expect(
          targetModel.length,
          `the target option resolved no model id (testid "${target.testId}", ` +
            `data-value "${target.value}")`,
        ).toBeGreaterThan(0);

        const toggle = await toggleForModel(page, targetModel);
        await setToggle(page, toggle, false);
        // Armed for the failure-path restore in afterEach; disarmed by the re-enable
        // step below when the test completes normally.
        disabledModel = targetModel;
      });

      await test.step("target model no longer appears in the component dropdown", async () => {
        await page.goto(flowUrl);
        await expect(modelTrigger).toBeVisible({ timeout: 30000 });
        await modelTrigger.click();

        // Asserted BEFORE the poll, and that order is the whole point.
        // `enumerateModelOptions` waits for the first option and swallows its own
        // timeout, so with the same budget on both, ONE predicate call consumes the
        // poll's entire deadline and `expect.poll` aborts as "Timeout 10000ms
        // exceeded while waiting on the predicate" — no Expected/Received, no cause.
        // Review proved this by removing the click above: the guard below never ran.
        const opened = await readPickerCensus(page, target, providerModels, 10000);
        expect(
          opened.total,
          `the Agent's model picker rendered ZERO options — it did not open, or the ` +
            `catalog is empty; either way it proves nothing about "${targetModel}"`,
        ).toBeGreaterThan(0);

        // ONE read decides all three figures. Polling `target` and re-reading for the
        // guards let a transient empty read satisfy the poll while a later populated
        // read — still containing the target — satisfied the guards, so the step could
        // go green with the model still offered. `census` therefore holds exactly the
        // read that satisfied the matcher, and a short inner timeout keeps each
        // iteration cheap.
        let census = opened;
        await expect
          .poll(
            async () => {
              census = await readPickerCensus(page, target, providerModels, 2000);
              return census.target;
            },
            { timeout: 10000 },
          )
          .toBe(0);

        // That zero is evidence of removal only if the picker was populated and this
        // provider's OTHER models still resolve by identity (#1012).
        expect(
          census.total,
          `"${targetModel}" is absent from a picker that rendered ZERO options — ` +
            `that proves nothing about the toggle`,
        ).toBeGreaterThan(0);
        expect(
          census.providerOthers,
          `"${targetModel}" is absent, but so is every OTHER model of ${providerLabel} — ` +
            `the ${census.total} option(s) offered are [${census.labels.join(", ")}], so the ` +
            `absence is not attributable to the toggle`,
        ).toBeGreaterThan(0);
        await page.keyboard.press("Escape");
      });

      await test.step("re-enabling the model brings it back to the dropdown", async () => {
        await openProviderModelList(page);
        const toggle = await toggleForModel(page, targetModel);
        await setToggle(page, toggle, true);
        // Restored by the test itself — the afterEach net is no longer needed.
        disabledModel = null;

        await page.goto(flowUrl);
        await expect(modelTrigger).toBeVisible({ timeout: 30000 });
        await modelTrigger.click();
        // Same pre-poll guard as the removal step. This step cannot go vacuously
        // green (an empty picker never yields `target: 1`), but without the guard a
        // popover that never opened fails here as "expected 1, received 0" — which
        // reads as a product claim that re-enabling did not work.
        const opened = await readPickerCensus(page, target, providerModels, 10000);
        expect(
          opened.total,
          `the Agent's model picker rendered ZERO options after re-enabling ` +
            `"${targetModel}" — it did not open, or the catalog is empty`,
        ).toBeGreaterThan(0);
        await expect
          .poll(
            async () =>
              (await readPickerCensus(page, target, providerModels, 2000)).target,
            { timeout: 15000 },
          )
          .toBe(1);
        await page.keyboard.press("Escape");
      });
    },
  );
});
