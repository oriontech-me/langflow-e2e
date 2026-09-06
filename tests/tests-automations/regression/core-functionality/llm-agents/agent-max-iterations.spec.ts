import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { setAgentMaxIterations } from "../../../../helpers/ui/set-agent-max-iterations";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

/**
 * Agent Max Iterations (QA-CHECKLIST §6.2 "Agent stops when maximum number of
 * iterations is reached" and §7.7 "Maximum agent iterations").
 *
 *   Test 1 — max_iterations=1 on a task that makes the agent attempt a tool call:
 *            the attempt exceeds the limit and the agent returns
 *            "Model call limits exceeded: run limit (1/1)".
 *   Test 2 — causal control: the SAME task with a high max_iterations finishes
 *            WITHOUT the limit message — only the cap differs, so Test 1's stop
 *            is attributable to the cap, not an unrelated failure.
 *
 * Issue #481 flagged a backend bug (parameter ignored) and asked to gate this
 * expected-fail. Reproduction on 1.11.0.dev33 shows the parameter is RESPECTED
 * (1 → run limit (1/1); high → finishes), so this is a normal passing @stable test.
 *
 * #1264 read as "the cap is no longer enforced" and quarantined Test 1. Its FIRST
 * pass blamed this spec's fetch target (an SSRF-blocked URL putting every run on
 * the tool-error path). That is refuted as an explanation: the test recurred on
 * the 2026-08-13 daily with the fix already merged, and that run's job log records
 * `ECHO_BASE_URL: http://172.18.0.5:8080` — the target WAS reachable.
 *
 * The real dependence: `ModelCallLimitMiddleware.before_model` compares
 * `run_count >= run_limit` BEFORE the next call (`after_model` increments after),
 * so `run_limit = 1` can only fire on the SECOND `before_model` — reachable only
 * through the tools node. The second model call is therefore ELECTED BY THE MODEL,
 * and nothing in the product forces it: `max_iterations` is declared with
 * `range_spec(min=1)` and the Agent component exposes no `tool_choice` (Langflow
 * dropped the legacy hardcoded `tool_choice='required'`, which WatsonX rejects).
 * On 08-13 claude-haiku-4-5 answered in prose — `calls: 1` in that run's token
 * artifact — so no limit message was ever produced.
 *
 * Hence the two changes here: the Agent Instructions state an ordering rule the
 * old wording left satisfiable by an announcement, and Test 1 asserts the tool
 * step SEPARATELY so model non-compliance cannot masquerade as a broken cap.
 * The product itself is correct — measured on 1.12.0.dev39, see the spec doc.
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Data the model CANNOT fabricate, so calling the URL tool is the only way to
// answer. `/uuid` returns a fresh random UUID per request: unknowable (unlike a
// famous page like example.com, whose contents the model has memorised, or an
// arithmetic task it computes inline) AND not derivable from the URL itself
// (unlike an echoed/base64 sentinel, which a model decodes without fetching).
//
// This RAISES compliance; it does not force it, and an earlier version of this
// comment claimed it did ("so it must call the URL tool — guaranteeing a second
// model call"). Nothing in the product guarantees a tool call — see the header —
// which is why `expectToolLoopEntered` asserts the outcome instead.
//
// The fetch must also SUCCEED. "The attempt consumes the iteration" is true but
// insufficient: a tool that can never succeed gives the model nothing to finish
// on, so the run's length stops being a property of the cap and becomes a property
// of the model's appetite for retrying. gemini-3.5-flash retried address variants
// until LangGraph's recursion_limit (max_iterations * 2 + 5 -> 45) killed the run:
// 733,990 tokens over 11 calls on one trace, 94% of that day's whole-suite spend
// (2026-08-12 daily, run 31581590030). Cost hygiene, and history — that model id
// is now retired (404) and the runaway does not reproduce on 1.12.0.dev39, where
// the same blocked target yields one tool call and a plain-text SSRF error. With a
// reachable target a normal run is exactly two model calls.
//
// CI resolves ECHO_BASE_URL to the lane's in-network go-httpbin (#1128); locally
// it falls back to the public host, same contract as agent-multi-tool-selection.
const ECHO_BASE = (
  process.env.ECHO_BASE_URL ||
  process.env.HTTPBIN_BASE_URL ||
  "https://httpbin.org"
).replace(/\/$/, "");
const TARGET_URL = `${ECHO_BASE}/uuid`;
// Stated as an ORDERING rule, not as a capability reminder. The previous wording
// ("To answer any question about a URL you MUST call the URL fetch tool") is
// satisfiable by announcing the intent, and that is exactly what
// claude-haiku-4-5 did on the 2026-08-13 daily — one model call, no tool_use, so
// the cap had no second `before_model` to fire on (#1264). The instruction cannot
// FORCE the call (no `tool_choice` on the Agent component), which is why Test 1
// also asserts the resulting tool step; this only removes the reading under which
// a bare announcement is compliant.
const SYSTEM_PROMPT =
  "You have web tools. Your FIRST action MUST be a tool call — never reply with text before you have called a tool. To answer any question about a URL you MUST call the URL fetch tool. Never guess or invent responses.";
// The template's URL tool (default) is the forcer — no extra tool needs enabling.
const TASK = `Fetch ${TARGET_URL} and tell me the exact "uuid" value it returns.`;
const LIMIT_MESSAGE = /model call limits exceeded/i;
// The value only the fetch can supply — guards the causal control against a
// refusal or a blank run passing its negative assertion.
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Headroom only has to exceed the two calls a successful fetch needs. It also
// sets LangGraph's recursion_limit (cap * 2 + 5), so a low cap bounds the blast
// radius of any future model that does loop: 15 graph steps instead of 45.
const HIGH_LIMIT = "5";

// Id-scoped cleanup for every flow this spec's page creates (#1108's shared
// tracker, never a delete-all sweep — #553). This spec had NO cleanup at all: the
// flow it ran the agent on was left behind, which cost twice. It leaked an orphan
// `Simple Agent` per test on the shared instance, and — because token attribution
// lives on the delete path (#1197) — its tokens reached the platform with no spec
// to claim them. Measured on the 2026-08-06 daily (#1346): trace `e7c60610`,
// 2,266 tokens over 2 `claude-haiku-4-5` calls, in the run's `unattributed`
// bucket. The `attrib_cost` record this spec DID produce came from
// `loadTemplateByName`'s own cleanup of the surplus flows it creates — those never
// ran, so they carried no traces and the attribution read came back empty.
//
// The tracker rather than the returned id: `load()` can throw AFTER creating the
// flow (the #751/#1072 credential-settle guard throws exactly there), and an id
// captured from the creation POST survives that.
let flows: ReturnType<typeof trackCreatedFlows>;

test.beforeEach(({ page }) => {
  flows = trackCreatedFlows(page);
});

// Attribution is derived from the running test by `cleanup` itself (#1197 §1.1) —
// no explicit `attribution` option is needed, and the whole sidecar stays inert
// unless the lane sets TOKENS_ATTRIB.
test.afterEach(async ({ request }) => {
  await flows.cleanup(request);
});

// Returns the created flow's id so Test 1 can scope its monitor-API read to THIS
// run. Cleanup stays on the tracker above and must not be re-pointed at this id:
// `load()` can throw AFTER creating the flow, and `loadTemplateByName` creates
// surplus flows of its own (#1002), so the tracker's set is the superset that has
// to be deleted while this single id is the one that ran.
async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<string> {
  try {
    return await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

// The precondition Test 1's cap assertion depends on, asserted separately so the
// two outcomes stay distinguishable (#1264).
//
// `ModelCallLimitMiddleware.before_model` compares `run_count >= run_limit` BEFORE
// the next call and `after_model` increments afterwards, so `run_limit = 1` can
// only fire on the SECOND `before_model` — which the graph reaches only through
// the tools node. A model that answers in prose ends the run after one call and no
// limit message is ever produced. That is what the 2026-08-13 daily recorded
// (`calls: 1`, status ok, `claude-haiku-4-5`, bubble reading "I'll fetch that URL
// for you."), and reading it back through the missing limit message made a
// declined tool call look like a broken cap for two triage passes.
//
// The monitor API rather than the DOM: the "Agent Steps" disclosure is collapsed,
// so its text is NOT in the bubble's `innerText` — measured on 1.12.0.dev39, a
// passing bubble is 43 characters, the limit message alone. Same route, poll shape
// and budget as `expectToolSelectionPersisted` in `agent-multi-tool-selection.spec.ts`.
//
// ANY tool counts, not specifically `fetch_content`: the cap is reached by
// entering the tool loop, whichever of the template's two tools (URLComponent /
// UnifiedWebSearch) the model picks, and pinning the name would add a second
// election dependency for no gain — tool SELECTION is the sibling spec's
// assertion. The names actually called are reported in the failure text.
async function expectToolLoopEntered(
  request: APIRequestContext,
  flowId: string,
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, {
          headers: bearer ? { Authorization: bearer } : {},
        });
        if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
        const messages = await res.json();
        if (!Array.isArray(messages)) return "monitor payload not a list";

        const aiMsg = messages.find(
          (m: any) => m.sender === "Machine" && (m.content_blocks?.length ?? 0) > 0,
        );
        if (!aiMsg) return "AI message for this flow not persisted yet";

        const toolNames = (aiMsg.content_blocks as any[])
          .flatMap((b: any) => b.contents ?? [])
          .filter((c: any) => c.type === "tool_use")
          .map((c: any) => c.name as string);

        return toolNames.length > 0
          ? "tool-loop-entered"
          : `the model answered without calling any tool, so the cap was never reachable — ` +
              `it fires only on the SECOND model call and the graph reaches that only ` +
              `through the tools node. This is model non-compliance with the Agent ` +
              `Instructions, NOT a broken max_iterations (#1264). Persisted reply: ` +
              `${JSON.stringify(String(aiMsg.text ?? "").slice(0, 200))}`;
      },
      { timeout: 30000 },
    )
    .toBe("tool-loop-entered");
}

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Set the Agent Instructions (system prompt) on the node.
async function setSystemPrompt(page: Page, prompt: string): Promise<void> {
  const field = page.getByTestId("textarea_str_system_prompt");
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(prompt);
  await field.blur();
}

// Set the task on the ChatInput node (the Playground prompt pre-fills from it;
// typing into the Playground races an async default re-injection).
async function setChatInputText(page: Page, text: string): Promise<void> {
  const field = page.locator(
    '[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]',
  );
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(text);
  await field.blur();
}

// Run the configured flow through the Playground and return the AI message
// bubble locator. Callers assert with toContainText (auto-retrying) — reading
// innerText once can catch a partially-streamed message right after the run ends.
async function runAndGetBubble(page: Page) {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  await expect(chatInput).toHaveValue(TASK, { timeout: 15000 });
  await page.getByTestId("button-send").last().click();
  await waitForAgentToFinish(page);
  const bubble = page.getByTestId("div-chat-message").last();
  await expect(bubble).toBeVisible({ timeout: 30000 });
  return bubble;
}

const targets = resolveTestTargets({ tier: "tool-calling" });

// Serial mode + --workers=1 keeps the shared instance state deterministic. Note
// that `SimpleAgentTemplatePage.load()` does NOT wipe existing flows — the
// cross-worker delete-all was removed in #553 — so cleanup is id-scoped, in the
// `afterEach` above.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Max Iterations [${label}]`, () => {
    // The cap IS enforced (#1264) — measured on 1.12.0.dev39 with
    // google/gemini-3.6-flash: exactly one bubble reading `Model call limits
    // exceeded: run limit (1/1)`, with an executed tool_use (`fetch_content`) in
    // its Agent Steps block. Wording unchanged, and the injected message IS the
    // last bubble, which rules out "the cap fired but did not render last".
    //
    // This is the half of the pair whose assertion depends on the model electing
    // to call a tool (see the header), so its `@stable` follows a measured rate,
    // not the fix landing — #1187's rule. See the spec doc's Tags section for the
    // numbers behind the tag this test currently carries.
    test(
      "agent stops when max iterations is reached",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const flowId = await loadAgent(page, options);

        await test.step("force a tool call, cap max_iterations at 1, set the task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setAgentMaxIterations(page, "1");
          await setChatInputText(page, TASK);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run and assert the agent stops at the limit", async () => {
          const bubble = await runAndGetBubble(page);
          // Precondition FIRST: the cap is only reachable once the agent has
          // entered its tool loop, and entering it is the model's decision. Read
          // it separately so "the model declined to call a tool" never arrives
          // disguised as "the cap is broken" (#1264).
          await expectToolLoopEntered(request, flowId);
          // Limit enforced: the agent stopped at the configured cap of 1.
          await expect(bubble).toContainText(LIMIT_MESSAGE, { timeout: 30000 });
          // run limit (1/1) ties the stop to max_iterations=1.
          await expect(bubble).toContainText(/\(\s*1\s*\/\s*1\s*\)/, { timeout: 10000 });
        });
      },
    );

    test(
      "causal control — a high max iterations does not hit the limit",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        await loadAgent(page, options);

        await test.step("force a tool call, allow a high max_iterations, set the task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setAgentMaxIterations(page, HIGH_LIMIT);
          await setChatInputText(page, TASK);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run and assert the run finishes without hitting the limit", async () => {
          const bubble = await runAndGetBubble(page);
          const reply = (await bubble.innerText()).trim();
          // Same task as Test 1, but with headroom to iterate: the agent finishes
          // its two calls WITHOUT the limit message. Only max_iterations differs
          // between the two tests — so the stop in Test 1 is attributable to the
          // cap, not an unrelated failure.
          expect(reply.length).toBeGreaterThan(0);
          expect(reply).not.toMatch(LIMIT_MESSAGE);
          // Positive half: the fetched UUID. A negative assertion alone passes on a
          // refusal ("I cannot fetch URLs") or a blank run — both of which also
          // carry no limit message, and neither of which exercises the cap.
          expect(reply).toMatch(UUID_SHAPE);
        });
      },
    );
  });
}
