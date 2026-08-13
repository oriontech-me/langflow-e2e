import * as dotenv from "dotenv";
import path from "path";
import type { Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import {
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  providerConfigMap,
  type Provider,
} from "../../../../helpers/provider-setup";
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

/**
 * Agent multi-tool selection (QA-CHECKLIST §6.2 "Agent with multiple
 * configured tools executes correctly" + §6.4 "Multiple connected tools —
 * agent selects the correct one for each prompt").
 *
 * The Simple Agent template ships with TWO tools wired to the Agent — URL
 * (tool `fetch_content`) and Web Search (tool `perform_search`) — the
 * canonical multi-tool surface. Per prompt, the FIRST tool_use block
 * persisted for the run's session (monitor API, nonce-keyed) must name the
 * expected tool — the first call IS the selection decision. Extra follow-up
 * calls are tolerated: on 2026-07-08 gemini started appending a
 * "verification" search after a correct fetch (provider-side drift, zero
 * Langflow changes — dev34/dev36 fail identically), which retired the
 * original sibling-tool-absent assert (spec doc, "Why first-call" note).
 *
 * The Agent Instructions force exactly one tool call per question WITHOUT
 * naming any tool: tool USE is instructed (a from-memory answer would flake
 * the positive half), tool CHOICE is the agent's — the behavior under test.
 * Search result content is never asserted (non-deterministic); the fetch
 * prompt additionally asserts the URL endpoint's fixed "Sample Slide Show"
 * title reached the reply (see FETCH_URL — httpbin.org by default, go-httpbin
 * in the daily; both serve the identical /json slideshow).
 */

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// URL-tool fetch target. Defaults to the public httpbin.org, overridable via
// ECHO_BASE_URL / HTTPBIN_BASE_URL. httpbin.org is chronically unreliable —
// sustained 503s/timeouts hard-failed this test on the 2026-07-10 daily (#631),
// and broke the API-request suite repeatedly (#383/#407/#462). The daily
// workflow self-hosts a go-httpbin service and exports ECHO_BASE_URL to its
// container IP (see daily-stable.yml + api-request-component-regression.spec.ts),
// so CI fetches an in-network, httpbin-compatible endpoint instead of the flaky
// public host. go-httpbin's /json serves the IDENTICAL "Sample Slide Show"
// slideshow (httpbin/static/sample.json), so the deterministic-title assertion
// below holds against either backend. The env-var names match the ones the daily
// already exports, so no workflow change is needed to pick this up.
const HTTPBIN_BASE = (
  process.env.ECHO_BASE_URL ??
  process.env.HTTPBIN_BASE_URL ??
  "https://httpbin.org"
).replace(/\/$/, "");
const FETCH_URL = `${HTTPBIN_BASE}/json`;
const URL_TOOL = "fetch_content";
const SEARCH_TOOL = "perform_search";
const EXPECTED_TITLE = /Sample Slide Show/i;
const SYSTEM_PROMPT =
  "For every user question you MUST call exactly one tool to obtain the answer - " +
  "never answer from memory and never refuse. Choose the tool that fits the question.";
// Sequence test (Test 3) — must PERMIT multiple tool calls, unlike the
// single-tool selection prompt above; the chained task's data dependency
// (search the title only obtainable by fetching first) drives the order.
const SYSTEM_PROMPT_SEQUENCE =
  "Use the connected tools to complete the task. You may call multiple tools in " +
  "sequence as the task requires; never answer from memory and never refuse.";
// Iteration budget for the sequence test only (#1378). Empirical -- see
// setMaxIterations for the measurements, and for why it bounds the blast radius
// without making this test deterministic.
const MAX_ITERATIONS_SEQUENCE = "8";

// Flows created by each test are tracked here and deleted by id in
// afterEach — loadTemplateByName does NO cleanup (post-#553 contract), and
// SimpleAgentTemplatePage.load() discards the id, so it is re-captured from
// the template-instantiation POST response in parallel with the load.
const createdFlowIds: string[] = [];

async function loadAgent(page: Page, options: LoadSimpleAgentOptions): Promise<void> {
  // Collect EVERY flow id this page creates (POST /api/v1/flows 201): the
  // app can fire more than one flows POST during template load, and only
  // one of them is the flow that persists — deleting all collected ids is
  // still id-scoped (only THIS test's creations), and a 404 on an already-
  // gone transient id is harmless.
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
    await new SimpleAgentTemplatePage(page).load(options);
  } catch (e: any) {
    if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
    throw e;
  }
}

test.afterEach(async ({ request }) => {
  if (createdFlowIds.length === 0) return;
  const bearer = await getAuthToken(request);
  for (const id of createdFlowIds.splice(0)) {
    // `deleteFlow` rather than a raw DELETE: it absorbs 404-as-done and one
    // transient 5xx, surfaces a real failure instead of a warning nothing reads,
    // and -- the reason this spec was migrated -- it is where token attribution
    // happens, immediately before the DELETE that 404s the trace (§3.1).
    try {
      await deleteFlow(request, id, { headers: { Authorization: bearer } });
    } catch (error) {
      // Preserving this spec's existing posture: a failed teardown delete warns
      // rather than failing an otherwise-green test. `deleteFlow` throws by
      // contract, so the catch is what keeps that posture unchanged.
      console.warn(`flow cleanup: DELETE ${id} -> ${(error as Error).message}`);
    }
  }
});

// Set the Agent Instructions (system prompt) on the node.
async function setSystemPrompt(page: Page, prompt: string): Promise<void> {
  const field = page.getByTestId("textarea_str_system_prompt");
  await expect(field).toBeVisible({ timeout: 15000 });
  await field.click();
  await field.fill(prompt);
  await field.blur();
}

// Cap the Agent's max_iterations (test 3 only). This test is the only one whose
// instruction permits an open-ended sequence, and the agent does not reliably
// converge on it: when it doesn't, it keeps calling perform_search, and every
// such call injects the Web Search component's whole result set. That component
// caps nothing -- it scrapes each DuckDuckGo hit's full page text (measured on
// 1.12.0.dev20: 10 results, 182,316 chars ~= 45.6k tokens in ONE call; upstream
// langflow-ai/langflow#14469). Since the conversation is re-sent every turn, a
// non-converging run grows without bound and the provider rejects it: #1378
// recorded requests of 206,881/206,902/271,317 tokens in CI and 5,060,863
// locally, after which the run returns no reply at all.
//
// Not a rate-limit tier problem: the local org allows 4M TPM (20x CI's 200k) and
// blew through it anyway, and no model's context window holds 5M tokens. A
// bigger tier or a wider model buys nothing; bounding the iteration count does.
//
// What this cap DOES and DOES NOT do -- read this before trusting it. It bounds
// the worst case (the 5,060,863-token run above cost ~2 min of wall clock and
// real money); it does NOT make this test deterministic. Measured on
// 1.12.0.dev20 / gpt-4o-mini, --retries=0:
//
//     max_iterations   pass rate
//     15 (default)     4/5
//     8 (this value)   5/6   <- same rate within noise, smaller blast radius
//     4                0/2
//
// 4 fails for a DIFFERENT reason and that asymmetry is why the cap cannot be
// tightened into a fix: max_iterations=4 sets a LangGraph recursion_limit of 13,
// the agent hits it ("Recursion limit of 13 reached without hitting a stop
// condition"), and a run that stops that way persists no AI message at all -- so
// the sequence assert fails on absent data rather than wrong data.
//
// UPSTREAM CAP LANDED (2026-08-13) -- langflow-ai/langflow#14489 bounded the
// component (max_results=5, max_content_length=2000). It reached the nightly in
// 1.12.0.dev25, NOT dev24: that image was cut before the merge-back, so reading
// the fix on release-1.12.0 says nothing about the image you are running --
// grep max_results in the INSTALLED wheel instead. Measured on dev25, same
// query: 5 results / 10,000 chars ~= 2.5k tokens, a 17.9x reduction. That kills
// the argument this comment used to make (that ONE search call was itself
// unbounded -- 15,857 / 53,714 / 78,848 tokens across three queries -- so no
// iteration cap could ever guarantee the test): a call now has a hard ceiling,
// and 15 iterations accumulate ~37k tokens of search payload, inside both the
// 128k window and CI's 200k TPM.
//
// The cap still stays at 8. Measured on dev25 / gpt-4o-mini, --retries=0:
// 7/7 at 8 and 4/4 at 15, which is NOT evidence that it is dispensable -- the
// same day, 10/10 passed on dev24 with the component still unbounded, so this
// environment (a 4M TPM org) did not reproduce the failure and the two arms
// cannot discriminate. It costs nothing and it is still what stops a
// non-converging agent from running 15 turns.
// Re-measure before changing this number -- do not re-derive it on paper.
//
// max_iterations is an advanced field: expose it on the node body via the
// inspector, then fill it -- the same handles agent-max-iterations.spec.ts uses.
async function setMaxIterations(page: Page, maxIterations: string): Promise<void> {
  await page.locator('[data-testid^="rf__node-Agent"]').first().click();
  await openAdvancedOptions(page);
  await page.getByTestId("inspector-add-max_iterations").click();
  await closeAdvancedOptions(page);
  const maxIter = page.getByTestId("int_int_max_iterations");
  await expect(maxIter).toBeVisible({ timeout: 15000 });
  await maxIter.scrollIntoViewIfNeeded();
  await maxIter.fill(maxIterations);
  await maxIter.blur();
  // The cap is load-bearing, not cosmetic: a fill that silently no-ops leaves
  // the default 15 in place and re-opens #1378 on a run that still looks green.
  await expect(maxIter).toHaveValue(maxIterations, { timeout: 10000 });
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

async function waitForAgentToFinish(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop" });
  const stopVisible = await stopButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (stopVisible) {
    await expect(stopButton).toBeHidden({ timeout: 120000 });
  }
}

// Open the Playground with the pre-seeded task and send it.
async function openPlaygroundAndSend(page: Page, task: string): Promise<void> {
  await page.getByTestId("playground-btn-flow-io").click();
  const chatInput = page.getByTestId("input-chat-playground").last();
  await expect(chatInput).toBeVisible({ timeout: 30000 });
  await expect(chatInput).toHaveValue(task, { timeout: 15000 });
  await page.getByTestId("button-send").last().click();
  await waitForAgentToFinish(page);
}

// Monitor-API check of tool SELECTION: the FIRST tool_use block persisted
// for THIS run's session (keyed by the nonce in the user message) must be
// `expectedFirstTool` — the first call is the selection decision. A run
// that opens with the wrong tool fails even if the model recovers later;
// extra follow-up calls after a correct first choice are tolerated
// (provider-side style drift the test does not own).
async function expectToolSelectionPersisted(
  request: APIRequestContext,
  nonce: string,
  expectedFirstTool: string,
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/v1/monitor/messages", {
          headers: { Authorization: bearer },
        });
        if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
        const messages = await res.json();
        if (!Array.isArray(messages)) return "monitor payload not a list";

        const userMsg = messages.find(
          (m: any) => m.sender !== "Machine" && (m.text ?? "").includes(nonce),
        );
        if (!userMsg) return "user message with nonce not persisted yet";

        const aiMsg = messages.find(
          (m: any) =>
            m.sender === "Machine" &&
            m.session_id === userMsg.session_id &&
            (m.content_blocks?.length ?? 0) > 0,
        );
        if (!aiMsg) return "AI message for the session not persisted yet";

        const toolNames = (aiMsg.content_blocks as any[])
          .flatMap((b: any) => b.contents ?? [])
          .filter((c: any) => c.type === "tool_use")
          .map((c: any) => c.name as string);
        if (toolNames.length === 0) return "no tool_use blocks persisted yet";

        return toolNames[0] === expectedFirstTool
          ? "correct-tool-selected"
          : `first tool called was "${toolNames[0]}", expected "${expectedFirstTool}"; all: ${JSON.stringify(toolNames)}`;
      },
      { timeout: 30000 },
    )
    .toBe("correct-tool-selected");
}

// Execution check via the persisted monitor messages (nonce-keyed), NOT the
// live playground bubble. The bubble renders the empty placeholder
// ("Message empty.", the frontend's EMPTY_OUTPUT_SEND_MESSAGE) while the agent is
// mid-tool-execution, and a multi-tool run can take 40s+; asserting the live
// bubble therefore races the stream and the run's own completion signal
// (`waitForAgentToFinish` can return between tool phases) — the #631
// "Message empty." failure mode. The persisted messages appear only once the run
// completes, so polling them is both the completion gate AND a race-free assert.
//
// The observable is the `fetch_content` tool_use block's OUTPUT matching
// `expectedOutput` — proving the tool actually fetched the real endpoint payload.
// This is the sharp #631 signal: the root cause was httpbin unreachable from the
// backend, so the tool returned an error/nothing, never the slideshow. Asserting
// the tool OUTPUT, not the model's prose, is deliberate: the slideshow title is a
// famous httpbin fixture a model can recite from memory, so a prose check could
// false-pass even if Langflow dropped the tool output (the product-bug masking
// #631's mandate warns against). Mirrors `agent-current-date-tool.spec.ts`
// (assert the tool output, never prose). We deliberately do NOT also require a
// non-empty final reply: a completed-but-empty final turn ("Message empty.") is a
// rare, model-side behavior tracked separately as a flake in #634 — coupling it
// here would re-import that flakiness into a test whose contract is tool
// selection + execution, both fully proven by the selection assert + this one.
async function expectFetchToolReturned(
  request: APIRequestContext,
  nonce: string,
  toolName: string,
  expectedOutput: RegExp,
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/v1/monitor/messages", {
          headers: { Authorization: bearer },
        });
        if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
        const messages = await res.json();
        if (!Array.isArray(messages)) return "monitor payload not a list";

        const userMsg = messages.find(
          (m: any) => m.sender !== "Machine" && (m.text ?? "").includes(nonce),
        );
        if (!userMsg) return "user message with nonce not persisted yet";

        const aiMsgs = messages.filter(
          (m: any) => m.sender === "Machine" && m.session_id === userMsg.session_id,
        );
        if (aiMsgs.length === 0) return "AI message for the session not persisted yet";

        const toolOutputs = aiMsgs
          .flatMap((m: any) => (m.content_blocks ?? []) as any[])
          .flatMap((b: any) => (b.contents ?? []) as any[])
          .filter((c: any) => c.type === "tool_use" && c.name === toolName)
          .map((c: any) => JSON.stringify(c.output ?? ""));
        if (toolOutputs.length === 0)
          return `no ${toolName} tool_use block persisted yet`;

        return toolOutputs.some((o) => expectedOutput.test(o))
          ? "fetch-tool-returned-expected"
          : `${toolName} output did not contain ${expectedOutput}: ${toolOutputs[0].slice(0, 200)}`;
      },
      { timeout: 90000 },
    )
    .toBe("fetch-tool-returned-expected");
}

// Sequence check (§6.4 "Agent executes multiple tools in sequence"): the run's
// persisted tool_use blocks, in call order, must include every tool in
// `expectedOrder` with earlier tools appearing strictly before later ones.
// Only names and relative order are asserted — tool output content (web search)
// is non-deterministic. Same nonce-keyed monitor lookup as the selection assert;
// AI messages are sorted by timestamp so the flattened tool_use list preserves
// the true call order across any multi-message split.
async function expectToolSequencePersisted(
  request: APIRequestContext,
  nonce: string,
  expectedOrder: string[],
): Promise<void> {
  const bearer = await getAuthToken(request);
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/v1/monitor/messages", {
          headers: { Authorization: bearer },
        });
        if (res.status() !== 200) return `GET monitor -> ${res.status()}`;
        const messages = await res.json();
        if (!Array.isArray(messages)) return "monitor payload not a list";

        const userMsg = messages.find(
          (m: any) => m.sender !== "Machine" && (m.text ?? "").includes(nonce),
        );
        if (!userMsg) return "user message with nonce not persisted yet";

        const aiMsgs = messages
          .filter(
            (m: any) => m.sender === "Machine" && m.session_id === userMsg.session_id,
          )
          .sort((a: any, b: any) =>
            String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")),
          );
        if (aiMsgs.length === 0) return "AI message for the session not persisted yet";

        const toolNames = aiMsgs
          .flatMap((m: any) => (m.content_blocks ?? []) as any[])
          .flatMap((b: any) => (b.contents ?? []) as any[])
          .filter((c: any) => c.type === "tool_use")
          .map((c: any) => c.name as string);
        if (toolNames.length < expectedOrder.length)
          return `only ${toolNames.length} tool_use block(s) so far: ${JSON.stringify(toolNames)}`;

        const indices = expectedOrder.map((t) => toolNames.indexOf(t));
        if (indices.some((i) => i < 0))
          return `not all expected tools called; got ${JSON.stringify(toolNames)}, expected ${JSON.stringify(expectedOrder)}`;
        const inOrder = indices.every((v, i) => i === 0 || indices[i - 1] < v);
        return inOrder
          ? "tool-sequence-in-order"
          : `tools out of order: ${JSON.stringify(toolNames)} (indices ${JSON.stringify(indices)}), expected ${JSON.stringify(expectedOrder)}`;
      },
      { timeout: 90000 },
    )
    .toBe("tool-sequence-in-order");
}

const targets = resolveTestTargets({ tier: "tool-calling" });

// Serial mode + --workers=1 keeps the shared instance state deterministic
// (area rule for agent specs). Cleanup is id-scoped in afterEach — nothing
// here wipes flows, so parallel neighbors are never victims.
test.describe.configure({ mode: "serial" });

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? (Object.keys(providerConfigMap)[0] as Provider);

  test.describe(`Agent Multi-Tool Selection [${label}]`, () => {
    test(
      "agent selects the URL tool for a fetch prompt",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        const task = `Fetch ${FETCH_URL} and tell me the exact slideshow title it returns. (${nonce})`;

        await loadAgent(page, options);

        await test.step("force tool use (not tool choice), seed the fetch task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run — no allowFlowErrors: a crashed run fails via the fixture", async () => {
          await openPlaygroundAndSend(page, task);
        });

        await test.step("execution: fetch_content's output carries the deterministic slideshow title", async () => {
          // A reply bubble renders in the Playground (interaction observable)…
          const bubble = page.getByTestId("div-chat-message").last();
          await expect(bubble).toBeVisible({ timeout: 30000 });
          // …but assert the title on the PERSISTED fetch tool OUTPUT (monitor),
          // not the live bubble (empty placeholder mid-run, #631) nor the model's
          // prose (recitable from memory): the tool output proves the real fetch.
          await expectFetchToolReturned(request, nonce, URL_TOOL, EXPECTED_TITLE);
        });

        await test.step("selection: the FIRST tool call is fetch_content", async () => {
          await expectToolSelectionPersisted(request, nonce, URL_TOOL);
        });
      },
    );

    test(
      "agent selects the Web Search tool for a search prompt",
      { tag: ["@stable", "@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        const task = `Search the web for recent news about the Playwright test framework and summarize one headline. (${nonce})`;

        await loadAgent(page, options);

        await test.step("force tool use (not tool choice), seed the search task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT);
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run — no allowFlowErrors: a crashed run fails via the fixture", async () => {
          await openPlaygroundAndSend(page, task);
        });

        await test.step("execution: the run produced a final, non-empty reply", async () => {
          // Search result content is inherently non-deterministic — the
          // selection assert below is the concrete observable (spec doc,
          // "Guarding against false positives").
          const bubble = page.getByTestId("div-chat-message").last();
          await expect(bubble).toBeVisible({ timeout: 30000 });
          await expect(bubble).not.toHaveText("", { timeout: 30000 });
        });

        await test.step("selection: the FIRST tool call is perform_search", async () => {
          await expectToolSelectionPersisted(request, nonce, SEARCH_TOOL);
        });
      },
    );

    test(
      "agent runs the URL then Web Search tools in sequence for a chained prompt",
      { tag: ["@regression", "@agents", "@playground"] },
      async ({ page, request }) => {
        test.skip(!!skipReason, skipReason ?? "");
        test.skip(
          !hasProviderEnvKeys(provider),
          `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
        );

        const nonce = `probe-${Date.now()}`;
        // The second step (search the title) can only run after the first
        // (fetch the title) — the data dependency forces fetch_content BEFORE
        // perform_search, making the ordered sequence deterministic without
        // asserting any non-deterministic content.
        const task =
          `First fetch ${FETCH_URL} and read its exact slideshow title. ` +
          `Then search the web for that title and summarize one result. (${nonce})`;

        await loadAgent(page, options);

        await test.step("permit a multi-tool sequence, seed the chained task", async () => {
          await setSystemPrompt(page, SYSTEM_PROMPT_SEQUENCE);
          // Bound the run BEFORE it starts: this is the only test whose
          // instruction permits an open-ended sequence, so it is the only one
          // that can accumulate Web Search payloads past the model's context
          // window (#1378 — see setMaxIterations).
          await setMaxIterations(page, MAX_ITERATIONS_SEQUENCE);
          await setChatInputText(page, task);
          await waitForFlowSaveSettled(page);
        });

        await test.step("run — no allowFlowErrors: a crashed run fails via the fixture", async () => {
          await openPlaygroundAndSend(page, task);
        });

        // No reply-bubble assert here, unlike tests 1-2. Their contract includes
        // a completed reply; this test's contract is the ordered tool_use list
        // and the spec doc never specified a bubble assert for it. The code
        // carried one anyway and it was the line that failed on every context
        // blow-up, reporting "element(s) not found" instead of the real cause.
        // A crashed run is still caught -- by the fixture, which owns that
        // verdict (no allowFlowErrors above), not by a proxy on the bubble.
        await test.step("sequence: fetch_content is called before perform_search", async () => {
          await expectToolSequencePersisted(request, nonce, [URL_TOOL, SEARCH_TOOL]);
        });
      },
    );
  });
}
