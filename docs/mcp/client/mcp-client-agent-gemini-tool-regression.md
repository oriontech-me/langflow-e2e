# MCP Client – Gemini Tool-Calling Regression (#440)

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev33`, #2176)
**Tracking issue:** oriontech-me/langflow-e2e #858 · **Upstream bug:** langflow-ai/langflow #440
**Open product defect:** #2176, filed upstream as
[LE-2919](https://datastax.jira.com/browse/LE-2919) — the persisted reply can lose
the tail of the streamed answer (see *Known product defect* below)

---

## What this test validates *(required)*

Guards the **Gemini × MCP tool-calling** path in isolation: a Google/Gemini
agent connected to an MCP tool must actually **invoke** that tool, not answer
from memory. This is the exact behavior broken by upstream bug **#440** — on
1.11.0 `gemini-2.5-flash` calls native Langflow tools (URL, Web Search,
Calculator) but silently does **not** call MCP tools (`echo`).

The behavior was invisible to the existing suite for three compounding reasons,
all confirmed against `reports/daily-history.jsonl`:

1. **Serial-skip cascade.** `mcp-client-agent.spec.ts` runs its three provider
   variants (openai → anthropic → google) under a single file-scope
   `mode: "serial"` group. The OpenAI variant runs first and flakes almost
   daily on an unrelated `toBeHidden` (Stop button) timeout; in serial mode a
   failure **skips every later test**, so the Gemini variant — the only one that
   exercises #440 — is skipped before it runs (matches the 46–53 daily skips).
2. **No provider label in the signal.** The daily history records only the bare
   `test()` title (no `[provider/model]`), so even the one day the true #440
   signature fired (2026-07-13, `"agent answered without invoking any tool"`) it
   was indistinguishable from a generic/OpenAI failure.
3. **Signal drowned in flake noise.** The same test fails most days with a
   different (`toBeHidden`) signature, so the real #440 line reads as "that
   flaky MCP test again."

This guard neutralizes all three: its own file (no shared serial group),
Gemini pinned and named in the test title (self-attributing signal), and a
unique assertion read from the monitor API (backend truth, immune to frontend
selector drift and to the `toBeHidden` flake).

**Direction of the assert.** #440 is **FIXED** as of Langflow **1.12.0.dev5**
(validated under #947, `gemini-flash-latest`, 3/3 deterministic: `echoToolUseCount`
= 1 with the reply carrying the echoed payload). The test now asserts the
**fixed** behavior — the agent runs, answers, **and invokes** the `echo` MCP tool
at least once. It is a **forward regression**: it flips red if Langflow ever
regresses Gemini × MCP tool-calling (the `echo` tool_use count drops back to 0,
the #440 state).

`test.fail()` was deliberately **rejected**. It converts *any* failure (a broken
bootstrap, a down instance, an unregistered MCP server) into a green "expected
failure" — proven live during authoring, where the test went green without ever
reaching the #440 assertion because the template load timed out. That reproduces
the very signal-masking this guard exists to escape. Instead, all setup asserts
stay **loud** (infra breakage goes genuinely red), and only the final monitor-API
check encodes the expected #440 state.

---

## Tags *(required)*

`@mcp` `@agents` `@regression` `@model-provider`

> **`@stable` is off while #2176 is open.** It comes back when the upstream fix
> for the defect described under *Known product defect* (LE-2919) lands in the
> nightly and is re-validated there. It is not restored on a test-side change, because the
> test is right to fail when the defect fires.

> **`@stable` — promoted under #947** after #440 was confirmed fixed on
> 1.12.0.dev5 and the positive assertion (Gemini invokes `echo`) ran clean
> `--workers=1 --retries=0` with a per-test force-failure check.
>
> **Removed and restored under #1386.** The daily of 2026-08-10 (run 31373880200)
> auto-removed the tag on a failure that never executed the test: this file's
> `test.describe` title interpolates `resolveGeminiModel()`, resolved at module
> load, and the shard's own `collect-models.spec.ts` rewrote `models.json` after
> the runner had computed the title — so the worker reported `Test not found in
> the worker process` with `duration 0` and `workerIndex -1`. The cause is fixed
> at the source (the catalog is frozen for the whole run —
> `tests/helpers/provider-setup/catalog-snapshot.ts`), and the assertion itself
> was re-validated 3/3 with `--retries=0` on 1.12.0.dev22 with Google configured.
>
> **Quarantined and restored under #2095.** The guard-tripped VM daily of
> 2026-09-29 (`1.13.0.dev27`) failed step 8 on every attempt with
> `turn.replyText` received `""`, and PR #2101 removed `@stable` and added
> `test.fixme`. The run had not finished when the reply was read. The Stop-button
> probe that preceded the monitor poll ignored its timeout (`locator.isVisible()`
> does not wait), so the poll started while the turn was still in flight and
> accepted the first AI row of the session, whose text was still empty. #2123
> moved the send into `sendAndAwaitPlaygroundTurn` (step 7), so the poll now
> starts only after the turn has finished. #2095 re-measured the test on
> `1.13.0.dev30` with a live Google key and lifted the quarantine.
>
> **Quarantined under #2176, `test.fixme` lifted with `@stable` still off.** The
> VM daily failed step 8 on its first attempt twice, on 2026-09-10
> (`1.13.0.dev8`) and on 2026-10-05 (`1.13.0.dev33`). Both times `turn.replyText`
> was exactly `"Echo: hello m"` and the retry passed. PR #2180 removed `@stable`
> and added `test.fixme`. #2176 traced it to a Langflow defect, not to the test
> (see *Known product defect*). The test runs again in every lane that is not
> `@stable`-filtered, so the defect stays visible. `@stable` waits for the upstream fix.

---

## Step by step *(required)*

1. Pin the Gemini model via `resolveGeminiModel()`; `test.skip` on
   `MODEL_NOT_AVAILABLE` or missing Google env key. All setup steps below use
   loud asserts — infra breakage fails the test genuinely.
2. Load Simple Agent template via `SimpleAgentTemplatePage` with
   `{ provider: "google", model: <resolved gemini> }`.
3. Delete any existing `everything` MCP server via API, then register via the
   JSON tab; poll `GET /api/v2/mcp/servers?action_count=true` until `toolsCount`
   is non-null.
4. Add MCPTools to canvas; enable tool mode (`tool-mode-button`) — verify a new
   "toolset" badge appears.
5. Connect MCPTools toolset output handle → Agent tools input handle.
6. Open Playground and send `"Use the 'echo' tool to echo: hello mcp (<nonce>)"`
   (atomic set-value + send, per the #226 prefill-race hardening).
7. The atomic send runs inside `sendAndAwaitPlaygroundTurn` (`send` option), which
   waits for the turn to mount and `button-stop` to clear; then poll `GET /api/v1/monitor/messages` until the
   agent turn for this session (keyed by the nonce) is persisted.
8. Assert (pipeline ran): the final reply contains the echoed payload
   (`hello mcp`). When it does not, the failure message must say why. It
   carries the persisted reply, the `echo` tool output persisted in the same
   message's `tool_use` block, and whether the reply is a strict prefix of that
   output. A strict prefix is the #2176 signature, and the message names it as
   such. It also carries, for each LLM call of the session, the text the call
   returned and the `model_name` it reported. Both come from the `llm` spans of
   the native trace (`GET /api/v1/monitor/traces?flow_id=…&session_id=…`, then
   `/traces/{id}`), read before teardown deletes the flow. Traces cascade with
   the flow. An LLM text that holds the payload beside a persisted reply that
   does not proves the text was lost inside Langflow. A `model_name` without
   `gemini-3` points at the trigger described below. On an instance with
   tracing off there are no spans, and the message says so instead of
   omitting the line. The diagnostic adds evidence to the failure and never
   changes the verdict: the assertion is the same `toMatch(/hello mcp/i)`.
9. Assert (**the #440 fix**): the count of persisted `tool_use` blocks named
   `/echo/i` for the session is **> 0** — Gemini invoked the `echo` MCP tool.

---

## Validation criterion *(required)*

- **#440 fixed (current):** step 8 passes (a reply with `hello mcp` is produced)
  **and** step 9's `echoToolUseCount > 0` holds → the test **passes**, proving
  Gemini invoked the `echo` MCP tool. A false pass is prevented by step 8 (the
  persisted reply proves the agent completed a turn) and by the loud setup asserts
  (a broken bootstrap / MCP registration fails before reaching step 9).
- **If #440 regresses:** no `echo` `tool_use` block is persisted →
  `echoToolUseCount === 0` → step 9 **fails loudly**, signalling Gemini × MCP
  tool-calling has regressed to the #440 state.
- **If the #2176 defect fires:** the persisted reply is a strict prefix of the
  `echo` tool output. The observed case was `"Echo: hello m"` against
  `"Echo: hello mcp (<nonce>)"`. Step 8 **fails**, never passes, and its message
  names the #2176 signature with the observables from step 8: the persisted
  reply, the tool output, and each LLM call's text and `model_name`. A failure
  of step 8 that is **not** a strict prefix is reported as a different cause.

---

## Known product defect (#2176, LE-2919)

Langflow can persist only part of the agent's final answer. The cut lands
mid-word, and the rest of the streamed text is gone from the stored message.

**Mechanism, proven against `lfx` `1.13.0.dev33`.**
`handle_on_chat_model_end` in `lfx/base/agents/events.py` builds the persisted
text from the round's aggregated `AIMessage.content` through
`_coerce_ai_message_blocks`. That function keeps only `dict` items of type
`text`/`tool_use` and drops every plain-string item. LangChain's own
`merge_content` produces exactly such a list when one streamed chunk's content is
a list and the next one is a string. It appends the string as a new list
element. The result:

| Streamed chunks | Merged `content` | Persisted `text` |
|---|---|---|
| all text dicts | one dict, full text | `Echo: hello mcp (…)` |
| first chunk a signed dict, the rest strings | `[{text: "Echo: hello m"}, "cp (…)"]` | `Echo: hello m` |
| strings, then a signed empty dict | `["Echo: hello mcp (…)", {text: ""}]` | `""` |

The second row reproduces the 2026-09-10 and 2026-10-05 failures byte for byte.
The third row is the empty-reply shape. The function was added in
langflow-ai/langflow#13391 (2026-07-10). It is present on `release-1.11.2`,
`v1.12.0`, `release-1.13.0` and `main`. The path it replaced extracted text with
`_extract_output_text`, which keeps string items.

**Trigger, not reproduced on demand.** `langchain-google-genai` 4.1.3 emits a
text part as a dict when the response's `model_version` names a Gemini 3 model
or the part carries a thought signature. Otherwise it emits a plain string. A
stream that switches shape mid-answer triggers the drop. Measured under #2176,
on both the local nightly and the QA VM venv: `gemini-flash-latest` reported
`model_version` `gemini-3.8-flash` on every chunk, and 0 of about 175 runs
truncated. Those runs covered the UI spec, the API, the bare round two after the
tool call, and tracing on and off. The trigger is intermittent and comes from the
provider. That is why step 8 records each LLM call's text and `model_name`
when it fails: the next occurrence then carries its own evidence.

**Ruled out by measurement:** the test reading early (the persisted text was the
same right after the turn and 8 s later), model-side truncation (the tool input
and the model output were complete in every run), event loss on the v2 stream
(the queue fails loudly on overflow), and a library-version difference between
lanes.

---

## External dependencies *(required)*

- `tests/pages/SimpleAgentTemplatePage.ts` — loads Simple Agent template with configured provider/model
- `tests/helpers/provider-setup/resolve-gemini-model.ts` — pins a deterministic Gemini flash model
- `tests/helpers/provider-setup/` — provider env-key validation (`hasProviderEnvKeys`)
- `tests/helpers/ui/playground-turn.ts` — `sendAndAwaitPlaygroundTurn`, the completion gate before the monitor poll
- `src/frontend/src/modals/addMcpServerModal/index.tsx` — JSON tab; testids `json-tab`, `json-input`, `add-mcp-server-button`
- `src/backend/base/langflow/api/v2/mcp.py` — `GET /api/v2/mcp/servers?action_count=true`, `DELETE /api/v2/mcp/servers/{name}`
- `src/frontend/src/components/core/parameterRenderComponent/components/mcpComponent/index.tsx` — tool mode toggle and toolset handle
- `GET /api/v1/monitor/messages` — persisted session messages; `content_blocks[].contents[]` with `type: "tool_use"` is the #440 observable
- `src/lfx/src/lfx/base/agents/events.py` — `handle_on_chat_model_end` / `_coerce_ai_message_blocks`, where the #2176 defect drops plain-string content items
- `src/backend/base/langflow/api/v1/monitor.py` — `GET /api/v1/monitor/traces` and `/traces/{trace_id}`, the source of each LLM call's text and `model_name` in step 8's failure message
- PyPI `langchain-google-genai` (`_parse_response_candidate`) — decides per chunk whether Gemini text arrives as a string or a dict, the #2176 trigger
- npm package `@modelcontextprotocol/server-everything` — launched via `npx` (provides `echo`)
- **Upstream bug #440** — Langflow: Gemini does not invoke MCP tools (the behavior under guard)

---

## What this test does not cover *(optional)*

- Native tool calling with Gemini (URL / Web Search / Calculator) — already green
  in `agent-multi-tool-selection.spec.ts`; #440 is MCP-specific.
- Other providers × MCP (OpenAI, Anthropic) — covered by `mcp-client-agent.spec.ts`.
- Whether the Langflow fix is model-side or integration-side — the guard only
  asserts the observable (tool invoked).

---

## Preconditions *(optional)*

- `npx playwright test tests/collect-models.spec.ts` has populated
  `models.json` with at least one Google/Gemini model.
- `GOOGLE_API_KEY` present in the environment (daily provides it).
- Run with `--workers=1` (agent specs create named flows).
