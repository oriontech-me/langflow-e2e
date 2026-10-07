# Agent reply persistence — every text item of a merged reply reaches the stored message

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev35`, #2200)

---

## What this test validates *(required)*

When an agent round ends, Langflow stores the reply the model streamed. This spec
asserts that the stored message carries **all** of that reply's text, whatever shape
the provider's chunks took. It is the deterministic, LLM-free coverage for #2176
(upstream [LE-2919](https://datastax.jira.com/browse/LE-2919)).

**The defect.** `handle_on_chat_model_end` builds a round's stored text through
`_coerce_ai_message_blocks`, which keeps only the `dict` items of a list
`AIMessage.content` and drops every plain-string item. LangChain's `merge_content`
produces a mixed list when a list-content chunk is followed by a string chunk, or
the other way round. `langchain-google-genai` switches shape mid-answer (a part
carrying a thought signature is a dict, the rest are strings), so a Gemini reply was
stored as `"Echo: hello m"`, or as `""`, while the trace kept the full text.

**Why a custom component and not a model.** That provider trigger did not reproduce
on demand (0 of about 175 runs), so the only spec able to see it,
`mcp-client-agent-gemini-tool-regression.spec.ts`, catches it a few times a month at
best. This spec removes the provider. A custom component builds the exact merged
`AIMessageChunk` that LangChain produces for each chunk sequence, feeds it to the real
`process_agent_events` as an `on_chat_model_end` event, and persists through the
component's own `send_message`. Everything after the event (the handler, the
coercion, `Message.text`, the database write) is Langflow's code, unchanged.

Measured inside the nightly container (`lfx` `1.13.0.dev35`), both in Python and end
to end through this spec's flow:

| Case | Chunk sequence | Merged `content` | Persisted `text` |
|---|---|---|---|
| Control | text dict, text dict | `[dict, dict]` | `"Echo: hello mcp (<sentinel>)"` (full) |
| String after dict | text dict with a signature, string | `[dict, str]` | `"Echo: hello m"` |
| Empty dict after strings | string, string, empty text dict with a signature | `[str, dict]` | `""` |

The issue that requested this spec described the control's merged content as a
single dict. Measured, it stays two dicts. The persisted text is full either way, so
the control's contract does not change.

---

## Tags *(required)*

`@api` `@regression` `@agents` `@stable`

- `@api`: the spec creates, runs and reads back through the REST API only. No page
  is opened.
- `@agents`: the behavior under test is the agent event pipeline
  (`process_agent_events`).
- `@regression`: guards a filed upstream regression (LE-2919, introduced by
  langflow#13391).
- `@stable`: every test carries it, including the two declared failing, following
  the #1896 pattern (`graph-execution-contract.spec.ts`).

**Tests 2 and 3 are declared failing with `test.fail()` against LE-2919.** Their
assertion is the correct contract, and it fails while the defect is live. The
declaration is the alarm in both directions. While the defect is live, the test
passes by failing as expected. The day upstream fixes it, the run reports *"expected
to fail, but passed"*, and the lift is: delete `test.fail()` and its comment, keep
`@stable`, flip the §6.5 bullet, and record the fix in `REGRESSIONS.md`.

`test.fail()` turns **any** failure green, including a broken harness. That is what
Test 1 is for: it runs the identical harness (same component, same flow, same run,
same read-back), and only the chunk sequence differs. A harness that stops working
reddens Test 1, so a green Test 2 or 3 always means the defect, never the harness.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` with
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`. The nightly image defaults it to `false`,
  and then the catalog omits `CustomComponent` (#668/#746). The spec fails naming
  that cause instead of timing out.
- No provider key, no `collect-models`, no external network.

---

## Step by step *(required)*

Each test runs the same steps. Only the chunk sequence in step 1 differs.

1. **Build the probe component.** A `CustomComponent` whose code:
   - merges the case's chunk sequence with LangChain (`AIMessageChunk` addition),
     ending in a unique sentinel `cp (<sentinel>)`;
   - yields one `on_chat_model_end` event whose output is that merged chunk;
   - calls `process_agent_events(events, agent_message, self.send_message)` and
     returns the result.
2. **Create the flow** via `POST /api/v1/flows/`, built from the live catalog
   (`build-catalog-flow.ts`): the probe's `Message` output
   connected to a `ChatOutput`. The connection is what makes `send_message` persist,
   the same topology as an Agent wired to a Chat Output (`_should_skip_message`).
3. **Run it** via `POST /api/v2/workflows` (`mode: "sync"`) with a fresh
   `session_id`. It has to be a UUID: the probe stores with the graph's session
   id, and `send_message` parses it as one.
4. **Read back** via `GET /api/v1/monitor/messages?session_id=<id>`.
5. **Clean up**: delete the flow by id in `afterEach`.

---

## Validation criterion *(required)*

In every test:

- the run answers `200` with `status: "completed"` and no errors;
- the session holds **exactly one** message, belonging to this flow (the Chat Output
  reuses the agent message's id, so there is no duplicate to pick from);
- that message's `text` is **exactly** `"Echo: hello mcp (<sentinel>)"`.

The session id is unique per test, so the read-back cannot pick up another test's
message. The message is found by session rather than by sentinel on purpose: in the
defective cases the sentinel is exactly the part that gets dropped.

Expected on the current nightly: Test 1 passes; Tests 2 and 3 fail on the last
assertion (`"Echo: hello m"` and `""`), which `test.fail()` reports as passed.

---

## Guarding against false positives *(how)*

- **Exact equality, not `toContain`.** The truncated text is a prefix of the full
  text, so a substring check on the head would pass the defect.
- **The sentinel is in the dropped part.** In the defective shapes it is the string
  item after the dict (Test 2) or inside the strings before the empty dict (Test 3),
  so the full-text assertion cannot pass while that item is dropped.
- **Attribution control.** Test 1 shares every step with Tests 2 and 3, see Tags.
- **No dependence on a model.** The chunk shapes are fixed in code, so the result is
  identical on every run, and a provider outage cannot skip or redden it.
- **Force-failure checks** (CONTRIBUTING §2):
  - M1: Test 1 expects a different sentinel, so it must fail.
  - M2: Test 2's sequence is replaced by the all-dict one, so it must report
    *"expected to fail, but passed"*.
  - M3: Test 3's sequence is replaced by the all-dict one, with the same expectation
    as M2.
  - M4: the Chat Output is removed from the flow, so `send_message` persists
    nothing, and Test 1 must fail on the message count (0, not 1). Removing only
    the edge is not this mutation: the Chat Output then fails the run with
    "Input data cannot be None", which tests the run status, not persistence.

---

## What this test does not cover *(optional)*

- **The provider trigger.** Whether a given provider (Gemini today) emits mixed chunk
  shapes is provider behavior. `mcp-client-agent-gemini-tool-regression.spec.ts`
  covers the real stream and names the #2176 signature when it fires.
- **The Playground rendering.** The frontend accumulates streamed tokens itself, so
  the chat view can show the full reply while the stored message is truncated. This
  spec asserts the stored message only.
- **Tool-use blocks.** Only `text` items are exercised. `tool_use` items take the
  same coercion path but are not part of LE-2919.

---

## External dependencies *(required)*

- **Langflow API**: `GET /api/v1/all`, `POST /api/v1/flows/`, `POST /api/v2/workflows`,
  `GET /api/v1/monitor/messages`, `DELETE /api/v1/flows/{id}`.
- **Upstream source**: `src/lfx/src/lfx/base/agents/events.py`
  (`process_agent_events`, `handle_on_chat_model_end`, `_coerce_ai_message_blocks`,
  where the plain-string items are dropped) and
  `src/lfx/src/lfx/custom/custom_component/component.py` (`send_message`,
  `_should_skip_message`, which decides whether the message is persisted).
- **LangChain**: `AIMessageChunk` addition and `merge_content`, which produce the
  mixed list. The spec depends on their output shape, measured on `langchain-core`
  `1.5.1`.
- **Custom components**: `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (#668/#746).
- **No external network, no provider account.**
