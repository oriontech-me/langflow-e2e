import * as dotenv from "dotenv";
import path from "path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { trackCreatedFlows } from "../../../../helpers/flows/track-created-flows";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { describeMissingUuid } from "../../../../helpers/other/describe-missing-uuid";
import { describeMissingLimit } from "../../../../helpers/other/describe-missing-limit";
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
// One reader for the persisted agent message, because there are now two consumers
// and they had started as a copy: this poll, which asks whether the tool loop was
// entered, and the UUID diagnosis below, which asks what the answer said. The poll
// keeps its own loop and its own wording — only the fetch-and-find moved.
async function readAgentMessage(
  request: APIRequestContext,
  flowId: string,
  bearer: string | undefined,
): Promise<{ problem?: string; aiMsg?: any; toolUses?: any[] }> {
  const res = await request.get(`/api/v1/monitor/messages?flow_id=${flowId}`, {
    headers: bearer ? { Authorization: bearer } : {},
  });
  if (res.status() !== 200) return { problem: `GET monitor -> ${res.status()}` };
  const messages = await res.json();
  if (!Array.isArray(messages)) return { problem: "monitor payload not a list" };

  const aiMsg = messages.find(
    (m: any) => m.sender === "Machine" && (m.content_blocks?.length ?? 0) > 0,
  );
  if (!aiMsg) return { problem: "AI message for this flow not persisted yet" };

  const toolUses = (aiMsg.content_blocks as any[])
    .flatMap((b: any) => b.contents ?? [])
    .filter((c: any) => c.type === "tool_use");

  return { aiMsg, toolUses };
}

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
        const { problem, aiMsg, toolUses } = await readAgentMessage(request, flowId, bearer);
        if (problem) return problem;

        const toolNames = (toolUses ?? []).map((c: any) => c.name as string);

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

// The wait that did not wait (#1991). `locator.isVisible()` returns immediately and
// Playwright documents the `timeout` option on it as `@deprecated This option is
// ignored`, so the old probe sampled the single instant after the send click: any run
// whose Stop button had not rendered by then skipped the wait entirely and both tests
// went on to assert against a run still in flight.
//
// It was NOT implicated in #1991's own failure — that run finished in 1.29 s — which
// is exactly why it had to be found by reading the path rather than by a red day.
//
// "Never appeared" stays non-fatal on purpose: a run can finish before the button
// renders, and that is a legitimate fast run, not an error to raise here.
async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const appeared = await stopButton
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) {
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

// A missing UUID has two causes that the pattern alone cannot tell apart, and the
// difference decides whether anyone should look at the product: the agent never got
// the value, or it got it and the ANSWER was cut before it finished spelling it out.
// Measured on 1.13.0.dev9 with `google / gemini-2.5-flash` (#1830): the reply stops
// mid-UUID, the backend stores the SAME cut text — so it is not a rendering artifact —
// the tool output inside that very message carries the value in full, `state` reads
// `complete`, and `usage` reports 820 output tokens for a 63-character answer.
//
// Attached to the assertion instead of asserted on: a truncated answer still fails
// the test, because the spec's premise is that the agent answers with the value.
// What changes is that the failure names the cause. Without it the artifact reads as
// "the agent never fetched", which is how it was read for a full day of triage.
//
// Rendering lives in `describeMissingUuid`, pure and unit-tested — this half only
// reads. Nothing here may throw: see the catch.
async function explainMissingUuid(
  request: APIRequestContext,
  flowId: string,
  rendered: string,
): Promise<string | undefined> {
  // Nothing to explain about a pass, and the caller should not have to branch:
  // a conditional in the test body is what this early return buys back.
  if (UUID_SHAPE.test(rendered)) return undefined;

  try {
    const bearer = await getAuthToken(request);
    const { problem, aiMsg, toolUses } = await readAgentMessage(request, flowId, bearer);
    if (problem) return `could not read the persisted message: ${problem}`;

    const toolOutput = JSON.stringify((toolUses ?? []).map((c: any) => c.output));

    return describeMissingUuid({
      rendered,
      stored: String(aiMsg.text ?? ""),
      fetchedUuid: toolOutput.match(UUID_SHAPE)?.[0],
      model: aiMsg.properties?.source?.source,
      usage: aiMsg.properties?.usage,
      outputTokens: aiMsg.properties?.usage?.output_tokens,
    });
  } catch (error) {
    // EVERY branch reports, and that is the whole contract of this function. It is
    // evaluated as an argument, so it runs BEFORE `expect` exists: an escaping throw
    // takes the assertion failure with it and the artifact becomes a bare transport
    // error — strictly less than this spec printed before the diagnosis existed.
    // Both calls above can throw on a wedged backend (#1077): `getAuthToken` lets the
    // original error propagate once its 30 s budget is out, by documented contract,
    // and `res.json()` throws on a non-JSON 200.
    const first = String(error instanceof Error ? error.message : error).split("\n")[0];
    return `the UUID is missing and the diagnosis could not be read (${first}) — ` +
      `the received string below is all the evidence this failure carries`;
  }
}

// `spanModelUsage` is pure, dependency-free ESM under scripts/lib. Same CJS→ESM
// interop path, and the same reasons, as `loadBuildProbe` in
// `helpers/flows/token-attribution.ts` — see the note there.
type SpanModelUsageFn = (spans: unknown) => Array<{ model: string; calls: number }>;

async function loadSpanModelUsage(): Promise<SpanModelUsageFn> {
  // @ts-expect-error -- dynamic import of a dependency-free ESM .mjs module; no .d.ts to resolve
  const mod = await import("../../../../../scripts/lib/token-spans.mjs");
  return mod.spanModelUsage as SpanModelUsageFn;
}

// How many model calls did THIS flow's run make? The number is the whole
// discrimination behind the diagnosis below, and it is not on the persisted message:
// `properties.usage` reports tokens, never a call count. It lives in the trace spans,
// which is where the token sidecar reads it from too.
//
// The trace is addressed DIRECTLY, by the `graph_run_id` the message carries. The
// first version listed `/monitor/traces?flow_id=` and took the newest, and in the
// field it came back with nothing to take — the diagnosis rendered `calls: not
// reported` and fell to the head that chooses nothing, losing exactly the fact it
// exists to establish (#1991, force-fail probe on run 35754140187).
//
// Polled, because the trace is written asynchronously and this runs moments after the
// run ends. Budget is small on purpose: this is a diagnosis on a test that has already
// failed, and a slow one delays the artifact everyone is waiting to read.
//
// Returns undefined rather than 0 on any failure. A diagnosis reporting "0 calls" for
// a trace it could not read would state the opposite of what happened.
async function readModelCalls(
  request: APIRequestContext,
  graphRunId: string | undefined,
  bearer: string | undefined,
): Promise<number | undefined> {
  if (!graphRunId) return undefined;
  const spanModelUsage = await loadSpanModelUsage();

  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await request.get(`/api/v1/monitor/traces/${graphRunId}`, {
      headers: bearer ? { Authorization: bearer } : {},
    });
    if (res.ok()) {
      const detail = await res.json();
      const models = spanModelUsage(detail?.spans);
      if (models.length) {
        return models.reduce((sum, m) => sum + (Number(m.calls) || 0), 0);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

// Did the model emit text BEFORE its first tool call? That ordering is the shape
// that takes the message away from the cap (#1991), and it is visible in the
// persisted content blocks — so the diagnosis reads it instead of assuming it.
//
// `undefined` when the blocks are not readable: "could not look" must never render
// as "looked and found none".
function textPrecedesFirstToolUse(aiMsg: any): boolean | undefined {
  const contents = (aiMsg?.content_blocks as any[] | undefined)?.flatMap(
    (b: any) => b.contents ?? [],
  );
  if (!Array.isArray(contents) || contents.length === 0) return undefined;
  const firstTool = contents.findIndex((c: any) => c?.type === "tool_use");
  if (firstTool < 0) return undefined;
  return contents
    .slice(0, firstTool)
    .some((c: any) => c?.type === "text" && String(c.text ?? "").trim().length > 0);
}

// A missing limit message has three causes that read identically from the pattern
// alone, and the difference decides whether anyone should look at the product:
// the cap fired and was never surfaced, the model declined to call a tool so the cap
// was never reachable, or the run did neither. Measured on 1.13.0.dev19 (#1991): the
// first one, with `state: complete`, `error: false` and the word `limit` absent from
// the entire persisted payload — a cap-terminated run indistinguishable from a
// successful one.
//
// Attached to the assertion instead of asserted on: a run with no limit message still
// fails the test, because the spec's premise is that a capped agent SAYS it stopped.
// What changes is that the failure names the cause, instead of costing the triage pass
// it cost on #1264 and again here.
//
// Rendering lives in `describeMissingLimit`, pure and unit-tested — this half only
// reads. Nothing here may throw: see the catch.
async function explainMissingLimit(
  request: APIRequestContext,
  flowId: string,
  rendered: string,
): Promise<string> {
  try {
    const bearer = await getAuthToken(request);
    const { problem, aiMsg, toolUses } = await readAgentMessage(request, flowId, bearer);
    if (problem) return `could not read the persisted message: ${problem}`;

    return describeMissingLimit({
      rendered,
      stored: String(aiMsg.text ?? ""),
      toolNames: (toolUses ?? []).map((c: any) => c.name as string),
      // `session_metadata.graph_run_id` IS the trace id — verified against the
      // captured monitor payload on #1991. The message has no `error` field on this
      // route at all (only the build/SSE shape carries one), so none is reported:
      // a field that can never be populated prints "unknown" forever and is noise.
      calls: await readModelCalls(request, aiMsg.session_metadata?.graph_run_id, bearer),
      state: aiMsg.properties?.state,
      preambled: textPrecedesFirstToolUse(aiMsg),
      model: aiMsg.properties?.source?.source,
      usage: aiMsg.properties?.usage,
    });
  } catch (error) {
    // EVERY branch reports — the same contract as `explainMissingUuid`, and for the
    // same reason: this runs while an assertion failure is already in hand, and an
    // escaping throw would replace it with a bare transport error.
    const first = String(error instanceof Error ? error.message : error).split("\n")[0];
    return `no limit message was surfaced and the diagnosis could not be read (${first}) — ` +
      `the assertion failure below is all the evidence this run carries`;
  }
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
          //
          // try/catch rather than the `expect(value, message)` form the UUID half
          // uses: there the value is already in hand, so the diagnosis can be built
          // as an argument. Here the assertion is the thing doing the waiting, and
          // building the diagnosis eagerly would both run its reads on every PASS and
          // read the message before the 30 s poll had a chance to see it arrive.
          try {
            await expect(bubble).toContainText(LIMIT_MESSAGE, { timeout: 30000 });
          } catch (error) {
            const rendered = await bubble.innerText().catch(() => "");
            const diagnosis = await explainMissingLimit(request, flowId, rendered);
            // The original failure is KEPT, appended: the diagnosis says which of the
            // three causes happened, the assertion text says what was compared.
            throw new Error(
              `${diagnosis}\n\n${error instanceof Error ? error.message : String(error)}`,
            );
          }
          // run limit (1/1) ties the stop to max_iterations=1.
          await expect(bubble).toContainText(/\(\s*1\s*\/\s*1\s*\)/, { timeout: 10000 });
        });
      },
    );

    test(
      "causal control — a high max iterations does not hit the limit",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const flowId = await loadAgent(page, options);

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
          //
          // A missing UUID has two causes that read identically from the pattern
          // alone, so the assertion carries its own diagnosis (#1830). The helper
          // returns early on a match, so a passing run costs nothing.
          expect(reply, await explainMissingUuid(request, flowId, reply)).toMatch(UUID_SHAPE);
        });
      },
    );
  });
}
