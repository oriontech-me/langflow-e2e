import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { providerSkipReasons } from "../../../../helpers/provider-setup/provider-health";

/**
 * Agent max_tokens (QA-CHECKLIST §6.2 "max_tokens truncates response as
 * configured", §7.7 "Maximum token count — response truncated as configured").
 * The cap is proven at the TOKEN level via the Playground token-usage tooltip:
 *
 *   Test 1 — max_tokens=50 + a ~500-word essay prompt: the response's Output
 *            token count is <= 50. The reply TEXT is not asserted — a thinking
 *            model may spend the whole budget on reasoning and legitimately
 *            render an empty reply ("Message empty." placeholder).
 *   Test 2 — causal control: max_tokens unset (0 = unlimited), same prompt —
 *            Output > 50 and a real essay comes back. Only max_tokens differs.
 *
 * §7.7 "Temperature parameter (verify via network payload)" is NOT covered:
 * the Agent has no temperature parameter on 1.11 (absent from agent.py inputs
 * and from the saved flow; it left with the model-bundle refactor). Flagged on
 * the issue/PR — see the spec doc's Scope note.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

const TOKEN_LIMIT = 50;
const ESSAY_PROMPT =
  "Write a detailed 500-word essay about the history of the ocean. Do not use any tools — answer directly.";

interface ModelRecord {
  provider: string;
  model: string;
}

interface TestTarget {
  label: string;
  options: LoadSimpleAgentOptions;
  skipReason?: string;
}

function getModelsFromJson(): ModelRecord[] {
  const jsonPath = path.resolve(
    __dirname,
    "../../../../helpers/provider-setup/data/models.json",
  );
  if (!fs.existsSync(jsonPath)) {
    console.warn("models.json not found — run collect-models.spec.ts first.");
    return [];
  }
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ModelRecord[];
}

function getTestTargets(): TestTarget[] {
  const skipReasons = providerSkipReasons();

  if (process.env.MODEL_TEST_ID) {
    const model = process.env.MODEL_TEST_ID;
    const allModels = getModelsFromJson();
    const record = allModels.find((m) => m.model === model);
    if (!record) {
      console.warn(`MODEL_TEST_ID="${model}" not found in models.json — provider cannot be inferred.`);
      return [{ label: `model:${model}`, options: { model } }];
    }
    const provider = record.provider as Provider;
    return [{
      label: `${provider} / ${model}`,
      options: { provider, model },
      skipReason: skipReasons.get(provider),
    }];
  }

  const allModels = getModelsFromJson();
  if (allModels.length === 0) {
    const fallbackProvider = Object.keys(providerConfigMap)[0] as Provider;
    console.warn("models.json not found or empty — run collect-models.spec.ts first.");
    return [{
      label: `provider:${fallbackProvider} (fallback)`,
      options: { provider: fallbackProvider },
      skipReason: skipReasons.get(fallbackProvider),
    }];
  }

  let models = allModels;
  if (process.env.MODEL_TEST_PROVIDER) {
    models = models.filter((m) => m.provider === process.env.MODEL_TEST_PROVIDER);
  } else if (process.env.ALL_MODELS !== "true") {
    const seen = new Set<string>();
    models = models.filter((m) => {
      if (seen.has(m.provider)) return false;
      seen.add(m.provider);
      return true;
    });
  }

  return models.map((m) => ({
    label: `${m.provider} / ${m.model}`,
    options: { provider: m.provider as Provider, model: m.model },
    skipReason: skipReasons.get(m.provider),
  }));
}

// Id-scoped flow cleanup via the shared tracker (#1108). It captures every
// `POST /api/v1/flows` → 201 the page makes, which is what the previous
// `afterEach` could not: that one only knew the id `load()` RETURNED, so a
// `load()` throwing AFTER creating the flow leaked it — and the #751/#1072
// credential-settle guard throws exactly there. Measured while working #1059: one
// orphan `Simple Agent` per failed load, on both local bursts.
// SimpleAgentTemplatePage.load() does not wipe existing flows (the cross-worker
// wipe left in #553), and this is never a delete-all sweep either.
let flows: ReturnType<typeof trackCreatedFlows>;

test.beforeEach(({ page }) => {
  flows = trackCreatedFlows(page);
});

test.afterEach(async ({ request }) => {
  await flows.cleanup(request);
  flows.dispose();
});

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  try {
    await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

// Set the Agent's max_tokens in the Controls dialog. Two scouted quirks
// (dev33): (a) the int field rejects Playwright's fill() outright and swallows
// the first keystroke of an immediate pressSequentially — a typed "50" becomes
// a range_spec-clamped "1"; (b) closing the dialog can race the field's commit
// debounce, persisting 0 even though the DOM showed the typed value. So: type
// slowly and verify the DOM, blur to force the commit, and verify the value
// actually PERSISTED via the flows API — reopening the dialog and retrying the
// whole cycle when it did not.
async function setMaxTokens(page: Page, value: string): Promise<void> {
  // dev49: max_tokens is an advanced field — expose it on the node body via the
  // inspector once (replaces the old Controls dialog / edit-button-modal), then
  // fill it on the body. The int field still rejects fill() and swallows a fast
  // first keystroke, so keep the slow-type + DOM-verify + persistence retry.
  await page.locator('[data-testid^="rf__node-Agent"]').first().click();
  await openAdvancedOptions(page);
  await page.getByTestId("inspector-add-max_tokens").click();
  await closeAdvancedOptions(page);
  const field = page.getByTestId("int_int_max_tokens");
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect(field).toBeVisible({ timeout: 15000 });
    await field.scrollIntoViewIfNeeded();
    for (let typeTry = 0; typeTry < 3; typeTry++) {
      await field.click();
      await page.waitForTimeout(600);
      await field.press("ControlOrMeta+a");
      await field.press("Backspace");
      await field.pressSequentially(value, { delay: 150 });
      if ((await field.inputValue()) === value) break;
    }
    await expect(field).toHaveValue(value);
    await field.press("Tab");
    await page.waitForTimeout(800);
    await waitForFlowSaveSettled(page);
    if ((await getSavedMaxTokens(page)) === Number(value)) return;
    console.warn(`setMaxTokens: value did not persist (attempt ${attempt}) — retrying`);
  }
  expect(await getSavedMaxTokens(page)).toBe(Number(value));
}

// Read the Agent node's persisted max_tokens straight from the flows API. The
// int field's quirks make a silently unsaved value possible — the causal pair
// is only trustworthy when the saved value is verified before each run.
async function getSavedMaxTokens(page: Page): Promise<unknown> {
  await page.waitForURL(/\/flow\/[^/?#]+/);
  const flowId = page.url().split("/flow/")[1].split(/[/?#]/)[0];
  const res = await page.request.get(`/api/v1/flows/${flowId}`);
  expect(res.status()).toBe(200);
  const flow = await res.json();
  const agent = flow.data.nodes.find((n: any) => n.id.startsWith("Agent"));
  return agent?.data?.node?.template?.max_tokens?.value;
}

// Seed the prompt on the ChatInput node (the Playground prefill re-injects the
// template default asynchronously and would corrupt typed text — see
// agent-multimodal-image-input.md), then send it and wait for the response to
// complete on a MODEL-AGNOSTIC signal before touching the token-usage badge.
//
// The badge count used to BE the completion gate, which is what made #1059
// unattributable: "still generating", "finished without a badge" and "finished
// with an error" all surfaced as `toHaveCount … Received: 0` after 120 s, with the
// Stop-button wait before it swallowed by a `.catch(() => {})`. #569 had already
// root-caused that exact pattern on memory-history-regression.spec.ts — not every
// model/response emits the badge, so its count cannot mean "done". Gate on the
// same pair that spec uses (the turn mounts, then the generating indicator
// clears), then assert the badge separately so each failure names its own cause.
// No timeout was loosened: the worst case went from ~248 s to ~205 s.
//
// The third state — "finished with an error" — is resolved explicitly at both
// points it can appear, because upstream renders the error card INSTEAD of the
// bot bubble, so every wait keyed on the bubble outlives it (#1188).
async function runPrompt(page: Page): Promise<string> {
  const node = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(node).toBeVisible({ timeout: 15000 });
  await node.click();
  await node.fill(ESSAY_PROMPT);
  await node.blur();
  await waitForFlowSaveSettled(page);

  await page.getByTestId("playground-btn-flow-io").click();
  await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 30000 });

  const messages = page.getByTestId("div-chat-message");
  const errorCard = page.getByTestId("error-card-stack");
  const before = await messages.count();
  await page.getByTestId("button-send").last().click();

  // 1. The turn actually started — guards the "checked completion before
  //    generation started" race that an indicator-only wait returns early on
  //    (#354). `toBeGreaterThan` rather than an exact count, so it holds whether
  //    or not the user bubble carries this testid. An errored turn is accepted
  //    here as a start too: upstream renders `ErrorView` INSTEAD of the bot
  //    bubble (`chat-message.tsx`: `chat.category === "error"`), so a run that
  //    fails before any bubble mounts would otherwise wait the full 60 s for an
  //    element that is never coming (#1188).
  await expect
    .poll(
      async () => (await errorCard.count()) > 0 || (await messages.count()) > before,
      {
        timeout: 60000,
        message: "the run neither started a reply nor rendered an error card",
      },
    )
    .toBe(true);
  await failIfRunErrored(page);
  // 2. Generation finished. This is the completion signal because it is emitted
  //    for every model and every response (#569).
  await expect(page.getByTestId("button-stop")).toBeHidden({ timeout: 120000 });
  await expect(page.getByTestId("button-send").last()).toBeVisible({ timeout: 10000 });
  // The error can also arrive AFTER a bubble mounted, and that is the measured
  // case on 1.12.0.dev10: the bubble is replaced by the error card, so
  // `messages.last()` resolves to nothing and every later step waits on an
  // element the error path does not render (#1188).
  await failIfRunErrored(page);

  // A finished turn that rendered no bubble at all must still reach the badge
  // assertion below — reading `.last()` unguarded is what turned that state into
  // a bare `locator.innerText` timeout with no cause in it.
  const reply =
    (await messages.count()) > 0
      ? (await messages.last().innerText({ timeout: 5000 }).catch(() => "")).trim()
      : "";

  // 3. Only now the observable itself. A finished turn that renders no badge is a
  //    MISSING OBSERVABLE, not a slow model — and the message says so, quoting the
  //    reply that did render instead of timing out blind.
  await expect(
    page.getByTestId("chat-message-token-usage"),
    `the finished response must expose a token-usage badge — it is the max_tokens ` +
      `observable this spec reads. Rendered reply: ${reply.slice(0, 300) || "(none rendered)"}`,
  ).toHaveCount(1, { timeout: 15000 });

  return reply;
}

// An errored run is a real outcome of this spec and must name itself. Without
// this, the run fails several steps later on whatever element the error path
// happens not to render — measured on `main` as `locator.innerText: Timeout
// 20000ms exceeded` with the provider's 400 nowhere in the message (#1188).
async function failIfRunErrored(page: Page): Promise<void> {
  if ((await page.getByTestId("error-card-stack").count()) === 0) return;
  throw new Error(
    `the agent run errored instead of returning a response — ${await readRunError(page)}`,
  );
}

// The provider's message sits in a collapsed accordion inside the error card
// (upstream `error-message.tsx`), so expand it before reading — otherwise the
// failure says "An error occurred" and nothing else, which is the same dead end
// the timeout was.
async function readRunError(page: Page): Promise<string> {
  // `.last()`: the throw is gated on "any error card", so read the newest one.
  const stack = page.getByTestId("error-card-stack").last();
  // Best-effort: expanding is how we reach the provider text, never how we
  // decide the run failed.
  await stack
    .getByText("An error occurred")
    .last()
    .click({ timeout: 5000 })
    .catch(() => {});
  const text = (await stack.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  // Upstream renders the provider message only when the error carries a
  // component (`error-message.tsx`), so a bare label is a real outcome — and it
  // must not read as "here is the cause", or this helper reproduces the dead end
  // it exists to remove.
  return text && text.replace(/an error occurred/i, "").trim().length > 0
    ? text
    : `${text || "(empty error card)"} — the error card carried no provider message; ` +
        `check the run's flow-error advisory in the test log or the flow's build log`;
}

// "1.9K" -> 1900, "46" -> 46, missing/empty -> 0 (a tight cap can be fully
// consumed by reasoning before any visible token — observed with max_tokens=1).
function parseTokenCount(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return 0;
  return raw.trim().toUpperCase().endsWith("K") ? Math.round(n * 1000) : n;
}

// Hover the token-usage badge and read the response's Output token count from
// its tooltip ("Input: 1.0K / Output: 46" layout).
async function readOutputTokens(page: Page): Promise<number> {
  const badge = page.getByTestId("chat-message-token-usage").last();
  await badge.hover();
  const tooltip = page
    .locator('[role="tooltip"], [data-radix-popper-content-wrapper]')
    .first();
  await expect(tooltip).toBeVisible({ timeout: 10000 });
  const text = await tooltip.innerText();
  const match = text.match(/Output:\s*([\d.]+K?)?/i);
  expect(match, `token tooltip must contain an Output entry — got: ${text}`).toBeTruthy();
  return parseTokenCount(match?.[1]);
}

const targets = getTestTargets();

// Each test loads the Simple Agent template (creating a flow) and runs it in the
// shared Playground; serial mode + --workers=1 keeps that shared instance state
// deterministic and avoids named-flow collisions. Flows are deleted id-scoped in
// afterEach from the tracker above (load() does not wipe them — see #553).
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent max_tokens [${label}]`, () => {
    test(
      "max_tokens=50 caps the response's output tokens",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step(`cap max_tokens at ${TOKEN_LIMIT}`, async () => {
          await setMaxTokens(page, String(TOKEN_LIMIT));
          expect(await getSavedMaxTokens(page)).toBe(TOKEN_LIMIT);
        });

        await test.step("run the essay prompt and assert Output tokens <= limit", async () => {
          await runPrompt(page);
          const outputTokens = await readOutputTokens(page);
          // The provider enforces the cap server-side; the reply text is NOT
          // asserted — a thinking model may spend the whole budget on
          // reasoning and render an empty reply, which is still a correct cap.
          expect(outputTokens).toBeLessThanOrEqual(TOKEN_LIMIT);
        });
      },
    );

    test(
      "causal control — unset max_tokens generates freely",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("verify max_tokens is unset (0/empty = unlimited)", async () => {
          // The fresh template ships without a limit; _get_max_tokens_value()
          // maps ""/0 to None (unlimited). Verify instead of assuming.
          const saved = await getSavedMaxTokens(page);
          expect([0, "", null, undefined]).toContain(saved as never);
        });

        await test.step("run the essay prompt and assert unbounded output", async () => {
          await runPrompt(page);
          const outputTokens = await readOutputTokens(page);
          // Only max_tokens differs from Test 1, so its cap is attributable to
          // the parameter, not to the model choosing to answer briefly. The
          // proof is token-level only: a thinking model spends the unbounded
          // budget on reasoning (Output > 50) yet may return a terse visible
          // reply, so the reply TEXT is deliberately NOT asserted — a word-count
          // floor measured model verbosity, not the max_tokens contract, and
          // was a false negative on gemini-2.5-flash (#866). The token floor
          // also subsumes the anti-empty guard: an aborted run yields Output 0.
          expect(outputTokens).toBeGreaterThan(TOKEN_LIMIT);
        });
      },
    );
  });
}
