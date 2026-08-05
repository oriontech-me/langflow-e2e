# Authoring conventions — spec docs, checklist & test code

Distilled from `QA-CHECKLIST.md`, `QA-SCENARIOS-GUIDE.md`, and the 214 existing
specs. Match these shapes so new work reads like the existing suite. **The
naming shapes are patterns, not a fixed registry — always grep the live selector
before using it; upstream renames them.**

## Spec-doc anatomy (what SPECIFY produces)

Mirror the `QA-SCENARIOS-GUIDE.md` scenario shape. Each scenario is a numbered
section `### N.M <title> [status-symbol]` with:

- **File:** — target `.spec.ts` path.
- **Objective:** — one line: what and why.
- **Precondition:** — environment/state required (running instance, provider
  configured, auto-login state, prior flow, etc.).
- **Step by step:** — numbered UI/API actions referencing **real** testids.
- **Validation:** — the single observable pass condition.

Plus the mandatory header block (PR checklist in `CLAUDE.md`): **What this test
validates**, **Tags**, **Validation criterion**, **External dependencies**,
`Last validated` (current release cycle, e.g. `1.11.x`).

## QA-CHECKLIST.md bullet format

One bullet per behavior, grouped under the `#### N.M` subsection that mirrors the
`regression/<area>/` tree:

```
- [x] <behavior in one line> → <area>/<file>.spec.ts
```

Symbols: `[x]` validated (`@stable`) · `[-]` automated, needs validation · `[ ]`
needs automation · `[~]` partial · `[!]` flaky/unstable. **Edit only the
bullets** — the Coverage Summary table and Phase 0 block auto-regenerate.

## Recurring testid shapes (grep to confirm the live one)

- Node title: `title-{Component Name}` (e.g. `title-API Request`, `title-Agent`).
  **To delete a node, click its TITLE then press `Delete`** — a body-center click
  can hit an interactive element (e.g. URLComponent) and fail to select the node;
  confirm with `toHaveCount(0)`. (`title-Web Search`, `title-URL`, …)
- Handles: `handle-{component}-shownode-{port}-{side}` — `side` is `left`
  (input) or `right` (output), e.g. `handle-agent-shownode-response-right`.
- Inputs: `popover-anchor-input-{field}`, `textarea_str_{field}`
  (e.g. `textarea_str_system_prompt`), numeric/toggle fields under their field id.
- Model picker: `value-dropdown-model_model`, footer `connect-other-models`,
  `manage-model-providers` (credentials are global under Settings → Model
  Providers since 1.11 — no inline per-provider fields on the Agent).
- Playground: `playground-btn-flow-io` (open), `input-chat-playground`,
  `button-send`, `div-chat-message`, `playground-close-button`. Chat bubbles
  embed their text: `chat-message-User-{text}` / `chat-message-AI-{text}` — use
  for precise assertions (e.g. `chat-message-AI-Hello`).
- Run controls: **no global run button in 1.11** — run a flow from a terminal
  node's `button_run_{node display name}` (e.g. `button_run_chat output`), which
  builds the whole upstream graph. (`button_run_flow` / `FlowEditorPage.runFlow()`
  are dead code.) Reuse the `runFlow(page, terminalNode)` helper.
- Build success: `node_duration_{node}` badge (e.g. `node_duration_chat output`)
  — renders only on a node's successful build. This is the durable completion
  signal; see the toast caveat below.
- Modals: `genericModalBtnSave` / `save-variable-btn`, prompt editor
  `button_open_prompt_modal`, tables via `div-table_*` → `Open table`.
- Provider mark: `icon-{Provider}`.

## Behavioral conventions

- **Entering the flow editor — gate on the editor, not just the POST.** After a
  `blank-flow`/template click, `page.waitForResponse(POST /api/v1/flows → 201)`
  confirms the flow exists server-side but NOT that the SPA finished routing into
  the editor. An occasional navigation race leaves the app on the flows list, and
  a wait for an editor-only element (`sidebar-search-input`, `canvas_controls_dropdown`)
  then times out with a misleading message. Gate on the destination state:
  `await page.waitForURL(/\/flow\/[^/?#]+/)` + `expect(canvas_controls_dropdown).toBeVisible()`
  before touching editor elements (fixed in `helpers/flows/setup-playground.ts`, #746).
- **Custom components are OFF by default on the nightly image.** The nightly ships
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false` (from ~1.11.0.dev42): the sidebar
  **"New Custom Component"** button (`sidebar-custom-component-button`) is not
  rendered (footer shows "Discover more components"/Bundles) and
  `POST /api/v1/custom_component` returns 403. The E2E instance must set the flag
  `true` (SKILL.md docker run, `scripts/start-langflow-docker.sh`, all CI service
  containers — #668/#746). Even with the flag on, that button lives in the
  Components sidebar section and is occasionally hidden on flow entry (~9% flake);
  use `helpers/ui/ensure-custom-component-button.ts` (`ensureCustomComponentButton(page)`)
  — it waits for the button, re-activating the Components nav only if still hidden,
  before you click it.
- **Flow cleanup is id-scoped — never a pre-test wipe.** Create your flow,
  keep the id from the creation `POST /api/v1/flows/` 201 response
  (`loadTemplateByName` returns it; the canvas URL id is transient on 1.11),
  and delete ONLY that id in `afterEach`. `cleanAllFlows` — and even a
  name-scoped delete — as pre-test cleanup kills flows other parallel workers
  are actively driving: the victim's page starts 404ing "Flow not found" and
  its run request never fires (#553's daily flaky). Duplicate template names
  don't justify a wipe either: the backend auto-suffixes copies
  ("Memory Chatbot (1)"), and callers should hold the id, not the name.
- **Home cards: never `nth(0)`/`first()` — anchor by id.** The home list
  sorts by `updated_at` DESC, so under parallel CI position 0 is whatever
  flow ANY worker touched last. Locate the own card with
  `getByTestId("list-card").filter({ has: getByTestId(\`flow-name-${id}\`) })`
  and act inside it. Extra trap: the export modal serializes the CARD's
  client-side data (no server fetch) — exporting a neighbor's fresh blank
  card yields `nodes: []` with a healthy backend (#518).
- **"Save settled" needs server truth, not network silence.**
  `waitForFlowSaveSettled` resolves after 700ms without a flow PATCH — which
  also happens when the debounced PATCH hasn't FIRED yet (starved frontend).
  To gate on persistence, poll `GET /api/v1/flows/{id}` until the expected
  state (e.g. `data.nodes.length > 0`) instead (#518, closes the #384 race).
- **Diff-based cleanup is a wiper too.** "Snapshot the flows list in
  beforeEach, delete the difference in afterEach" deletes flows PARALLEL
  workers created during the test window — same destructive class as
  `cleanAllFlows` (#553). Track ids from the page's own flow-creating POST
  responses and delete exactly those (#518).
- **Force-fail EVERY test in a serial file individually** — `mode: "serial"`
  skips the remaining tests once one fails, so a single mutated run only
  proves the first test's falsifiability (#518: test 3's FF needed its own
  isolated run).
- **Custom Component as a deterministic probe tool.** For agent behaviors
  needing a tool that fails/behaves exactly on command, paste a Custom
  Component (sidebar `sidebar-custom-component-button` → node
  `code-button-modal`) whose output method does what you need (e.g.
  `raise RuntimeError(f"TOOL_BOOM attempt={CALLS['n']}")` with a
  module-level counter — the module re-imports per build, so the counter
  is per-run). Enable tool mode (`tool-mode-button`) and wire
  `handle-<name>-shownode-toolset-right` → `handle-agent-shownode-tools-left`.
  Caveat: component-tool exceptions become ToolMessage CONTENT
  (`handle_tool_error=True` hardcoded in `component_tool.py`) — they show in
  monitor-API `tool_use` output but never escape as exceptions (#496).
- **The code editor is ACE** — `fill()`/`insertText` don't reach it. Set the
  value via `page.evaluate`: `window.ace.edit(document.querySelector('.ace_editor')).setValue(code, -1)`,
  then click `checkAndSaveBtn` (#496).
- **HTTP component specs** hit `https://httpbin.org/<verb>` — each endpoint only
  accepts its own verb (others return 405); `/status/{code}` for error paths.
- **Autosave debounce ≈ 4 s** — wait for it before asserting DB persistence or
  POSTing to a freshly-created webhook endpoint.
- **Intentional failures:** call `page.allowFlowErrors()` first — the fixture
  otherwise fails the test on any backend 4xx/5xx or flow-build error.
- **Mock backend** with `page.route` for deterministic edge cases (invalid key →
  500, empty response, malformed JSON) instead of relying on a live provider.
- **Unique sentinels** for memory/isolation assertions
  (e.g. `TESTNAME_XY9Z`, `SECRET-SENTINEL-…`) so a match can't be coincidental.
- **Soft checks:** model-dependent indicators (reasoning steps, `Finished in Xs`)
  are optional — assert only when present; never fail because a fast model
  skipped them.
- **Self-skip** when a local precondition is absent (e.g. both providers not
  configured, Stop button never appeared) rather than hard-failing.
- **Singleton components** (Chat Input, Webhook): adding one removes the other's
  sidebar `+`; they can't be duplicated (`Cmd/Ctrl+D`) or copy/pasted.
- **Webhook** needs a temporary `x-api-key` (`WEBHOOK_AUTH_ENABLE` defaults
  `True` since 1.9.2+); create it via `POST /api/v1/api_key/` and delete it in a
  `finally`.
- **Agent / provider / MCP-execution specs:** load `Simple Agent` via
  `SimpleAgentTemplatePage` + `models.json`, and run with `--workers=1` (named
  flows collide under parallelism).
- **Agent-with-tools execution is ~20% flaky — strip tools for provider/execution
  proofs.** The Simple Agent template ships Web Search + URL tools; executing it on
  `gpt-4o-mini` transiently fails ~1 in 5 runs (backend `ComponentBuildError` in the
  tool / structured-output orchestration), even spaced ~60 s apart. When a spec only
  needs to prove an agent *executes* (provider config works, key valid, model
  selected — not tool behavior), delete the tool nodes so the agent is a
  deterministic single LLM call; keep tool-execution coverage in
  `agent-component-regression.spec.ts`. The Playground/canvas build reads the
  *persisted* flow, so follow the deletion with `waitForFlowSaveSettled` (same class
  as the autosave race below). Root-caused via `docker logs` (agent build errors ride
  the SSE stream and never surface as `🚨 Backend Error`).
- **Anchor build completion on the node badge, not the toast.** The
  `built successfully` toast is transient — it fades and flakes the wait,
  especially headed/under load. Assert `node_duration_{node}` (persistent, only
  on success) instead. This is the repo's canonical flake fix (#506 / #507).
- **`[role="dialog"]` is ambiguous** — the first-run `assistant-onboarding-tooltip`
  also carries `role="dialog"`. Scope any dialog locator with
  `:not([data-testid="assistant-onboarding-tooltip"])` to avoid strict-mode.
- **Readiness gate before canvas interaction.** Without `adjustScreenView`, wait
  for the target testid (e.g. the run button) to be visible before clicking — a
  bare `page.goto('/flow/{id}')` can race canvas hydration.
- **Teardown before delete:** the open editor polls `GET /flows/{id}/events`;
  deleting the flow mid-poll 404s (logged by the fixture). `await page.goto("/")`
  to unmount the editor, then `DELETE`.
- **Timed-out runs leak flows.** A test that hits the Playwright timeout is
  aborted mid-execution, so its `finally` / `afterAll` cleanup never runs and the
  API-created flow is orphaned in the workspace. Normal pass/fail cleans up; only
  timeouts leak. After a debugging session full of timeouts, sweep the workspace
  via API — `GET /api/v1/flows/?remove_example_flows=true&header_flows=true`, then
  `DELETE` every flow whose name matches a test prefix (`Runnable Chat Flow `,
  `e2e-blank-`, `scout-`, `crud-`, `New Flow`), preserving real/starter flows.
- **A canvas run's output shows in the same flow's Playground** — open
  `playground-btn-flow-io` after a terminal-node run to verify the output bubble;
  no need to re-send via the Playground.
- **Don't type the prompt into the Playground input — set it on the ChatInput
  node.** The Playground chat input **re-injects the template default
  (`Hello, how are you?`) asynchronously** and races any text typed directly into
  it (`.fill`/`pressSequentially`), corrupting the value mid-type (observed: the
  default reappears prepended). Instead fill the **ChatInput node's** field
  (`[data-testid^="rf__node-ChatInput"] [data-testid="textarea_str_input_value"]`),
  `waitForFlowSaveSettled`, then open the Playground — it pre-fills from the node
  (assert `toHaveValue(prompt)` before sending). Deterministic, no race
  (`agent-multimodal-image-input` #497, `agent-max-iterations` #481).
- **Read the streamed agent reply with `toContainText`, not `innerText()` once.**
  Reading `bubble.innerText()` right after the Stop button hides catches a
  **partially-streamed** message → flake. Return the bubble locator and assert
  `await expect(bubble).toContainText(/…/, { timeout })` (auto-retries until the
  text renders); read `innerText()` only after that for a negative check
  (`agent-max-iterations` #481).
- **Force-failing a test in a `serial` describe: run it in isolation with
  `--grep`.** In `test.describe.configure({ mode: "serial" })`, a failed earlier
  test **skips** the rest — so breaking a *later* test's assertion for the
  CONTRIBUTING §2 force-fail check won't run it. Verify that assertion has teeth
  by running just that test: `--grep "<its title>"` (`agent-empty-refusal` #494,
  `agent-max-iterations` #481).
- **Docker VM disk-full masquerades as a bootstrap flake.** Intermittent
  `awaitBootstrapTest` failures — `modal-title` timing out, or 500 "An internal
  error occurred while creating the flow" on `POST /flows/` — are often the Docker
  Desktop **VM** disk being full (host disk can be fine; the VM has its own). The
  "New Flow" bootstrap click creates a flow server-side; a failed SQLite write
  there means the templates modal never opens. Check `docker system df`
  (RECLAIMABLE) and the container logs for `No space left on device` / `Errno 28`;
  free space (`docker rmi` unused images / `docker system prune -f`) and restart
  fresh. Don't chase it as a selector bug — my spec passed in isolation while the
  shared bootstrap flaked under disk pressure.
- **Cleanup for UI-created flows: capture the REAL id from the create response,
  delete only that one.** Two traps, both hit live on 1.11 (#505 — the instance
  had accumulated 199 leaked flows):
  1. **The canvas URL carries a TRANSIENT id** — `page.url()` after
     `blank-flow`/template-open gives an id that 404s on delete; the persisted
     flow has a different one. Capture the real id by registering
     `page.waitForResponse(r => r.url().includes("/api/v1/flows/") &&
     r.request().method() === "POST" && r.status() < 300)` **before** the
     click that creates the flow, then `(await r.json()).id`.
     **When `awaitBootstrapTest` (or any helper that itself creates a flow)
     runs before the click, do NOT use `page.url()` AND do NOT tie capture to
     a single `waitForResponse` — the bootstrap flow's own `POST /flows`
     competes and the URL id is the STALE bootstrap id.** Use the Pattern A
     accumulator below (`page.on("response")` collecting EVERY `POST /flows`
     201 id, delete them all in `afterEach`) — it captures the real
     just-created flow regardless of the bootstrap race. URL capture has now
     bitten twice (#490, #681 — the latter deleted the bootstrap flow and
     leaked the renamed one, 8 orphans).
  2. **`page.request` carries only browser cookies** — the flows API wants the
     Bearer token, so an `afterEach` delete via bare `page.request.delete(...)`
     401s and a trailing `.catch(() => {})` swallows it (flows leak silently).
     Use `getAuthToken(request)` + explicit `Authorization` header.
  Use a **targeted** delete, NOT `cleanAllFlows`, which under the suite's
  parallelism would nuke concurrent tests' flows. Verify flow-neutrality by
  listing flows via API after a full run. The one-time `Basic Prompting` flow
  that `addFlowToTestOnEmptyLangflow` creates on a *freshly empty* instance is
  shared bootstrap state, not yours to delete. (Reference implementation:
  `modelInputComponent.spec.ts` / `language-model-regression.spec.ts`.)
- **Provider key Save performs a REAL 1-token inference to validate**
  (`lfx/base/models/unified_models/credentials.py` — `llm.invoke("test")`,
  `max_tokens=1`). Consequences: a positive add-key test needs a real,
  **funded** key (valid-but-unfunded fails like a fake one); a fake key is a
  **deterministic negative control** — Save rejects it, no global variable is
  created, no "N models" badge appears (#505).
- **NEVER delete→re-add a real provider credential in a test.** The cycle
  passes its own assertions (validation succeeds, badge back, variable stored)
  but leaves a **stale server-side credential cache**: subsequent flow builds
  receive the WRONG provider's key (observed: OpenAI node sent the Google key,
  401) until the backend restarts. Reproduced 4/4 on dev33; suspected Langflow
  bug, flagged on #505/PR #541. Validate the add surface via the fake-key
  negative + the Replace edit surface (disabled with empty input → enabled
  when typed → disabled when cleared — typing writes nothing).
- **Autosave-debounce race on model selection:** running a flow right after a
  provider/model setup helper builds the template's **DEFAULT** model, not the
  selected one (observed: `gpt-5.5-pro` 403 instead of the chosen gemini).
  Always `waitForFlowSaveSettled(page)` between the setup helper and the run
  click (`language-model-regression` #505).
- **Force-fail mutations must be verified as applied.** A `sed` whose pattern
  silently doesn't match leaves the file untouched — the test then passes and
  reads as a force-fail FALSE-GREEN (caught on #505 by a suspiciously fast
  duration). Mutate with a checked replace (python `assert old in s`, or grep
  the file for the mutated text) before trusting the run's result, and grep
  again after restoring.
- **Message retrieval is flow-scoped** (upstream cross-flow-leak fix, PR #13087):
  a Message History / Agent memory read only sees messages whose `flow_id` matches
  the flow it runs in — a matching `session_id` alone is NOT enough. Seeding a
  session from one flow and reading it from another yields an **empty** retrieval
  (and a disabled output inspector). Seed and retrieve in the **same flow**
  (`agent-n-messages-limit` #482).
- **Node hidden (advanced) fields:** select the node → `edit-fields-button` →
  a panel of `show<field_name>` toggles (e.g. `shown_messages`, `showsession_id`)
  → `Escape` → the field inputs render on the node (`int_int_<name>`,
  `popover-anchor-input-<name>`). The **output inspector button**
  (`output-inspection-<output>-<node>`) stays `disabled` until the selected
  output has **non-empty** data — `expect(btn).toBeEnabled()` is itself a
  non-empty-retrieval assertion; the inspected text lives in the dialog's
  `textarea` (read `inputValue()`, not `innerText()`).
- **Deterministic message seeding via API — memory tests need no LLM.**
  `POST /api/v1/run/{flowId}` on a Chat Input → Chat Output passthrough
  (`createRunnableChatFlowViaApi`) with a custom `session_id` stores exactly
  2 messages per run (User + Machine echo). Auth is `x-api-key` **only**
  (Bearer → 403): mint a temp key via `POST /api/v1/api_key/`, delete it in
  `finally`. **Pre-verify the seed** with
  `GET /api/v1/monitor/messages?session_id=…` (Bearer) polling to the **exact**
  expected count before asserting anything downstream — a broken seed must fail
  the seed step, not pass an empty-output check. Model-free ⇒ no provider key,
  no `--workers=1`, ~8s/run (`agent-n-messages-limit` #482).
- **Monitor-API asserts need a per-run key — messages SURVIVE flow wipes.**
  `GET /api/v1/monitor/messages` returns history across all past runs, so an
  assert like "some AI message has X in its tool output" passes vacuously off
  an earlier run of the same spec. Embed a nonce (`probe-${Date.now()}`) in
  the user message, find that message, and scope every assert to its
  `session_id` (`agent-tool-error-handling` #489). Rich per-run payloads live
  in the AI message's `content_blocks[].contents[]` (`tool_use` blocks carry
  `name`/`output`/`error`).
- **Deterministic tool-error generator: fetch an internal URL.** SSRF
  protection (intentional security feature) blocks `http://localhost:7860/…`
  always, instantly, offline, with the stable message `SSRF Protection: …` —
  no external network/DNS variance. With `handle_tool_error=True` (all
  component tools) the exception becomes a normal tool OUTPUT ("Executed
  **tool**"); the `Error using` streaming header does NOT fire on that path —
  assert the persisted output, not the transient header (#489).
- **Text fields that must PERSIST need real keystrokes — `fill()` lies.**
  Three related 1.11 quirks (#485, root-caused over ~15 runs):
  (1) the Controls-dialog textarea is a controlled input — a `fill()`ed edit
  passes a `toHaveValue` check yet is silently DROPPED on dialog close
  (~50% of runs); (2) the node-level textarea + `fill()`/blur does not
  trigger autosave at all (0/5 persisted — older specs only persist it
  because a subsequent build flushes the whole flow); (3) select-all fired
  before focus settles selects nothing, landing the typed value in front of
  the default. Reliable setter: click → 600ms settle → Ctrl+A/Backspace →
  `pressSequentially` → verify `inputValue()`, in a retry loop — then
  confirm via the flows API before asserting anything downstream.

## Flow cleanup — MANDATORY for any spec that creates flows

`SimpleAgentTemplatePage.load()` / `loadTemplateByName` do NO cleanup and
discard the created flow id (post-#553 contract). Any spec that creates a
flow ships an **id-scoped** cleanup — never name-based, never delete-all
(cross-worker wiper class, #553/#520). Two proven patterns, pick by shape:

**A — template load (id not directly observable):** collect every
`POST /api/v1/flows` → 201 id via a `page.on("response")` listener installed
before the load, delete them all in `test.afterEach` (transient ids 404
harmlessly — `deleteFlow` treats 404 as done). Reference:
`agent-context-id-isolation.spec.ts`, `anthropic-provider.spec.ts`.

**B — blank flow (id observable):** capture the id from the `blank-flow`
click's `POST /flows` 201 response, delete in `finally` (runs even on
failure). Reference: `ollama-provider.spec.ts`, `groq-provider.spec.ts`,
`mistral-provider.spec.ts`. **If `awaitBootstrapTest` runs first, use A, not
B** — the bootstrap flow's `POST /flows` competes with the blank-flow click
and `page.url()` returns the stale bootstrap id (#681).

**The teardown's unmount navigation WARNS and carries on — it neither throws
nor swallows** (#1288). Both patterns leave the editor before deleting (an
editor mounted over a deleted flow 404s its `GET /flows/{id}/events` poll and
the fixture logs each one), and both obvious ways to write that are wrong:
letting the rejection propagate aborts the hook **before** the delete and leaks
the flow — strictly worse than the noise the navigation prevents — while
`.catch(() => {})` discards the one line that would attribute the 404 burst to
its cause. Log the first line of the error and continue to the deletes.
`trackCreatedFlows.cleanup()` does this for you and also returns it as
`unmountError`, alongside `authError`, so a spec on the shared helper needs no
teardown code of its own. 26 spec-local copies still carry the silent form;
migrate one as you touch it rather than sweeping them.

Validation contract (both patterns): (1) a **behavioral force-fail** of the
cleanup itself — no-op the delete, run green, count surviving orphans (>0),
revert, count again (0); (2) checking the instance's user-flow count after
the final green run is part of the pre-report checklist. Learned the hard
way: pair-1 specs and #503 all shipped the leak and the user had to ask.

**This rule applies to EVERY spec you TOUCH, not only specs you author.**
On any fix / promote / validate issue whose spec creates flows, auditing the
cleanup is part of the issue's scope: grep the file for `afterEach` +
`deleteFlow`; if absent, add pattern A/B in the same PR and purge the
orphans the file already leaked. Legacy specs predate the rule — a stale
"load() deletes all flows" comment is the tell (it has been false since
#553). The user has had to ask "os flows são limpos no final?" on #503 AND
#597 — never make them ask a third time: before ANY report, run
`GET /api/v1/flows/?remove_example_flows=true&header_flows=true` and state
the orphan count.

## Probe-gated skips for external providers

Any spec depending on an external provider API (key, credits, catalog,
reachability) probes the provider **directly, before opening the browser**,
and turns every unusable state into an explicit `test.skip` with the concrete
reason — never a silent green, never a mid-test mystery failure:

```ts
async function probeX(request): Promise<{reachable: boolean; reason: string}> {
  if (!KEY) return { reachable: false, reason: "X_API_KEY not set" };
  const res = await request.get(`${API}/models`, { headers: …, timeout: 10000 });
  if (res.status() !== 200) return { reachable: false, reason: `X API answered ${res.status()}` };
  if (!models.includes(TEST_MODEL)) return { reachable: false, reason: `model "${TEST_MODEL}" not in the live catalog` };
  return { reachable: true, reason: "" };
}
```

Zero-credit trap (#503, live): a valid-but-unfunded Anthropic key passes
Langflow's configure/validate and lists all models, but every inference fails
with a billing error. Only a probe that exercises the paid surface (or
`collect-models`' real 1-token inference for the keyed family) catches it
up front. References: `groq-provider.spec.ts`, `mistral-provider.spec.ts`,
`ollama-provider.spec.ts` (`probeOllama`).

## Force-fail mutation menu (provider/component specs)

Executed force-fails per class — pick from the menu instead of inventing
(all proven red on merged specs):

| Class | Mutation | Proves |
|---|---|---|
| Key validity | fill a garbage key instead of the env key | the causal waiter / authenticated inference actually depends on THIS key |
| Selection | exact-name assert → nonexistent model name | the exact-name check has bite (esp. when the component has a DEFAULT — e.g. Mistral's `codestral-latest` — a skipped selection must fail) |
| Cleanup | no-op the delete (`flowId = ""` / early return) | behavioral: run stays green but orphans survive → revert → 0 |
| Switch/state | after switching, assert the OLD value still present | the state actually changed (stale-dropdown guard) |
| Save causality | pre-existing-state variant: reset the stored variable via API first | Test-1-style request asserts can't pass on a no-op save (Save disabled on unchanged value — #498) |

Marker: every mutation carries `// FF-MUTATION` — revert is proven by
`grep -c` = 0 plus one final green run.

## Waiting for "either of two elements" — poll, never race or or().first()

Proven on #599 (`open-new-flow-templates-modal.ts`), with live measurements:

- **`Promise.race(waitForSelector×2)` pollutes traces**: the losing wait is
  recorded as a red ✗ step in every trace that takes the other branch — it
  reads like a recurring failure and costs a triage cycle to rule out.
- **`locator.or(other).first().waitFor({state:"visible"})` is a timeout
  trap**: `.first()` resolves by DOM ORDER, not by who appears first. An
  attached-but-hidden element sitting before the visible one pins the wait
  to the full timeout (measured: 26s → 96s per run).
- **Correct shape** — `expect.poll` over `isVisible()`:
  ```ts
  await expect
    .poll(async () =>
      (await a.isVisible().catch(() => false)) ||
      (await b.isVisible().catch(() => false)),
      { timeout: 30000 })
    .toBe(true);
  ```
- Related: branch on `isVisible()`, never `count() > 0` — attached-hidden
  matches count and leads to clicking an equally hidden control.
- **Always duration-check a helper change**: run the spec before/after plus a
  control run on clean main on the same instance — the or().first() trap
  shipped green and was only caught because durations were compared.

## Instance-state degradation — suspect it before blaming the test (#599)

A locally-degrading spec (green run 1, progressively failing after) on a
long-lived instance is an INSTANCE symptom: accumulated flows + SQLite lock
contention (`database is locked` in `delete_multiple_flows` during the 1.11
deployment-attachment prune) degrade the UI (element timeouts, then raw
i18n keys in the DOM — the symptom MUTATES with degradation depth). Restart
the container fresh and re-baseline before debugging the spec; and check
`docker logs` for the lock signature when element waits time out en masse.

That `database is locked` 500 on the bulk `DELETE /api/v1/flows/` (the frontend
prunes a temp flow on blank-flow entry) trips the fixture's backend-error
monitor as LOGGED noise (~9%) — it does NOT fail the test (only flowErrors
throw). The `@stable` bar is **per-spec determinism** (a `--retries=0` burst of
that one spec, which the pipeline VALIDATE runs), NOT a clean back-to-back run of
many heavy specs at `--retries=0` on one stressed instance — that surfaces a
DIFFERENT ambient flake per run (nav race, build-stop timing, the lock) that all
pass in isolation and that the daily's parallel + `retries=2` execution absorbs.
Don't chase per-run cluster flakes as test defects; harden only the ones with a
concrete, reproducible mechanism (e.g. the hidden custom-component button, the
editor-nav race above).

## `.env.example` convention for new providers

Every new provider spec adds its env block next to the existing ones, with a
comment naming the spec, the probe/skip contract, and the defaults:

```
# <Provider> provider (<file>.spec.ts). The test probes the <Provider> API
# directly and skips with a reason when the key is missing/invalid or
# <PROVIDER>_TEST_MODEL (default: <model>) is not in the live catalog.
<PROVIDER>_API_KEY=
<PROVIDER>_TEST_MODEL=
```

## Serial shared-page journeys (dependent multi-test flows)

For one journey split into several `test()` blocks that must NOT restart between
steps (e.g. run → verify build → verify output), use a serial describe with a
page created once in `beforeAll`:

```ts
test.describe("…", () => {
  test.describe.configure({ mode: "serial" });
  let page: Page;
  test.beforeAll(async ({ browser, request }) => {
    /* create flow via API */  page = await browser.newPage();  /* navigate once */
  });
  test.afterAll(async () => { await page.goto("/").catch(() => {}); /* delete */ await page.close(); });
  test("1 - …", async () => { /* uses shared page */ });
});
```

**Tradeoff:** a `browser.newPage()` page is NOT the fixture-wrapped `page`, so the
automatic backend-error monitor doesn't apply — rely on explicit happy-path
assertions (which fail on a real flow error) and note it in the JSDoc.

## Scouting live testids without a global `playwright-cli`

When `playwright-cli` isn't on PATH, drop a throwaway `.mjs` at the **repo root**
(so it resolves `node_modules`), launch `@playwright/test` chromium, create the
flow via API, navigate, and dump `[data-testid]`s (filter by keyword). Run it,
read the real selectors, then delete the file. Ground every selector this way
before writing the spec — never invent one.

### `playwright-cli` canvas-scouting recipes (learned on #499, applied on #500)

The Langflow canvas fights naive `playwright-cli` usage. Recipes that cut a
~10-min scout to ~4 min:

- **Snapshot refs go stale after ANY navigation/modal** — re-snapshot before
  every click; better, skip refs entirely for reads (next bullet).
- **Harvest testids in one `eval`** instead of grepping snapshots:
  `playwright-cli eval "() => Array.from(document.querySelectorAll('[data-testid]')).map(e=>e.getAttribute('data-testid')).filter(t=>t.includes('<kw>'))"`.
  Scope to the node: prefix selectors with `.react-flow__node `.
- **Never `type` without confirmed focus** — keystrokes land on the canvas as
  hotkeys (typing "groq" blind opened the API-access dialog). Click the field
  first, or set the value via eval.
- **React inputs ignore plain `.value=`** — use the native setter + input
  event: `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true}))`.
- **Verify request behavior live** during the scout (`playwright-cli requests`
  | grep `custom_component/update`) — it decides the spec's causal waiter
  (Groq's api_key refreshes the catalog; Mistral's doesn't).
- **Delete the scout flow** (grab the id from `window.location.pathname`,
  DELETE via API) — scouts leak flows exactly like specs do.

## Test-code conventions (from the existing `.spec.ts`)

- **Imports:** `import { expect, test } from "<rel>/fixtures/fixtures";` — never
  pull `test`/`expect` from `@playwright/test`. Type-only imports
  (`import type { Page } from "@playwright/test"`) are fine.
- **File-top JSDoc** stating what the spec exercises and, crucially, what
  **sibling specs already cover** so behavior isn't duplicated.
- **Serial mode when autosaves can collide:**
  `test.describe.configure({ mode: "serial" });` with a one-line comment on why
  (parallel autosaves throw `flow must be unique` 400s).
- **Tags as the options object:**
  `test("name", { tag: ["@stable", "@regression", "@components"] }, async ({ page }) => …)`.
- **Title on the same line as `test(`** — keep the test name string on the same
  line as the `test(` call (don't wrap the title onto its own line), so the test
  name is immediately visible when scanning the file:
  ```ts
  test("user can run a flow from the canvas; every node reaches build success",
    { tag: ["@stable", "@release", "@workspace", "@regression"] },
    async ({ page, request }) => { … });
  ```
  (Repo uses eslint + `tsc` as CI gates, not Prettier, so this layout is not
  reformatted away.) **Applies to legacy specs too** — when you edit a file that
  still wraps the title onto its own line, retrofit all its `test(` calls to the
  same-line form as part of the change.
- **`test.step("…")`** around each logical group — the labels trace back 1:1 to
  the spec-doc steps.
- **Unique names** with a `${Date.now()}` suffix for any created flow/folder/
  variable, so parallel workers don't clash.
- **Explicit per-assertion timeouts** tuned to the action (sidebar search
  ~30 s, node render ~15 s, flow build ~45 s) — don't rely on the global default.
- **File-local helpers** at the top: small, idempotent, future-proofed against
  upstream default changes (e.g. no-op if the node is already expanded).
- **Deterministic setup via the `request` fixture + `getAuthToken`** — when the
  UI action needs a known target, create it through the REST API first (POST the
  folder/flow), then exercise the UI; tear temp resources down in `finally`.
- **Wait on real signals**, not timeouts: `built successfully` toast,
  `toBeAttached` before clicking an inspector, edge-count assertions after a
  connect. Prefer POMs (`MainPage`, `SimpleAgentTemplatePage`, …) and
  `helpers/` (`awaitBootstrapTest`, `adjustScreenView`, `zoomOut`,
  `cleanAllFlows`, …) over raw Playwright.
- **Comment the non-obvious** — especially assertions deliberately *not* made
  (e.g. not asserting a generic name is gone because a parallel worker may hold
  it) and why the full dialog text is read instead of one inner node.
