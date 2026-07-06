# n_messages — limits the number of retained messages

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The **Number of Messages** control (`n_messages`) limits how many past chat
messages are retrieved from a session's memory (QA-CHECKLIST §6.3, "n_messages
parameter limits the number of retained messages"). The limit is proven by a
**deterministic count**, not by model recall:

1. Seed a session with a known number of messages (5 chat runs → 10 stored
   messages: one `User` + one `AI` per run) via `POST /api/v1/run`.
2. Point a **Message History** component (mode *Retrieve*) at that session and
   run it on the canvas.
3. Count the messages in its output: with `n_messages = 2` exactly the **2 most
   recent** messages come back; with `n_messages = 100` all **10** come back.

Two tests form a **causal pair** — only `n_messages` differs between them, so
the truncation in Test 1 is attributable to the limit and nothing else.

> **Design note — why Message History and not Agent recall (issue #482):** the
> issue targets the Agent's `n_messages`, whose only observable through the
> Agent is *model recall* of an old message. Reproduction on nightly
> 1.11.0.dev33 showed recall at the window threshold is genuinely
> non-deterministic (the retained window's effect on model answers varies
> run-to-run — three sentinel placements all flaked at spec level), making an
> `@stable` recall test untenable. Both the Agent and the Message History
> component resolve memory through the same backend retrieval
> (`aget_messages` with `limit=n_messages`, flow-scoped), so counting the
> Message History output validates the same §6.3 contract deterministically.
> The unit shift is flagged on the issue/PR.

> **Bug status (2026-07-06, nightly 1.11.0.dev33):** issue #482 flagged a
> "confirmed backend bug — value saved by frontend but ignored in backend
> execution" and asked to gate the spec as *expected-fail*. Reproduction on
> dev33 shows the parameter is now **respected** (n=2 → 2 messages; n=100 →
> all 10; Agent recall with n=100 also recalls). The bug appears **fixed**, so
> this is authored as a normal passing `@stable` test, not an expected-fail.
> Flagged on the issue/PR.

If this fails, memory retrieval no longer bounds its history — a memory/cost
regression (and a re-opening of the #482 bug).

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@components`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@regression` — guards the `n_messages` enforcement from regressing
(the bug #482 documented); `@agents` — the §6.3 agent-memory contract this
covers; `@components` — the behavior is exercised through canvas component
configuration (Message History fields + node run).

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- **No provider API key required** — the flow is a Chat Input → Chat Output
  passthrough and the Message History retrieval is model-free.
- No `--workers=1` requirement: each test creates its own uniquely-named flow
  via the API and deletes it afterwards (no template wipe, no shared state).

---

## Step by step *(required)*

Shared setup per test (all data is per-run unique):

1. Create a temporary API key (`POST /api/v1/api_key/`) — the `/run` endpoint
   requires `x-api-key` auth.
2. Create a Chat Input → Chat Output passthrough flow via
   `createRunnableChatFlowViaApi` (unique name, torn down after the test).
3. **Seed** the session: 5 × `POST /api/v1/run/{flowId}` with
   `input_value = "<sentinel>-<i>"` (i = 1…5) and a per-run
   `session_id = nmsg-<Date.now()>-<rand>`. Each run stores 2 messages (User +
   Machine echo) → **10 messages** total.
4. **Verify the seed** via `GET /api/v1/monitor/messages?session_id=…` — the
   count must be exactly 10 before any retrieval assertion (a failed seed must
   fail here, not silently pass an empty-output check later).
5. Open the same flow in the UI (`/flow/{flowId}`) and add the **Message
   History** component from the sidebar (`add-component-button-message-history`;
   node renders as `rf__node-Memory-*`). Retrieval is **flow-scoped**
   (issue #13059 / PR #13087), so the component must live in the same flow that
   seeded the session.
6. Expose the hidden fields via the node's **edit-fields** panel
   (`edit-fields-button` → toggles `shown_messages`, `showsession_id`), then
   fill `int_int_n_messages` and `popover-anchor-input-session_id`; wait for
   the flow save to settle.
7. Run the node (`button_run_message history`, mode tab *Retrieve* is the
   default), wait for **built successfully**.
8. Open the output inspector (`output-inspection-messages-memory`) and read the
   retrieved text from its `textarea`. The default template renders one line
   per message (`{sender_name}: {text}`), so occurrences of the sentinel
   prefix count the retrieved messages exactly.

---

**Test 1 — a small n_messages truncates retrieval to the most recent messages** (§6.3)

- `n_messages = 2`.
- **Validation:** the inspector text contains **exactly 2** sentinel
  occurrences; it contains the newest seed value (`<sentinel>-5`) and does
  **not** contain the oldest (`<sentinel>-1`) — the limit keeps the most
  recent slice, and only that slice.

---

**Test 2 — causal control: a large n_messages retrieves the full history** (§6.3)

- `n_messages = 100`, identical seed (its own fresh flow/session).
- **Validation:** the inspector text contains **exactly 10** sentinel
  occurrences — every seeded message is retrieved. Only `n_messages` differs
  from Test 1, so Test 1's truncation is caused by the limit.

---

## Validation criterion *(required)*

- **Limit enforced (Test 1):** `n_messages=2` → exactly 2 of the 10 seeded
  messages are retrieved (newest present, oldest absent).
- **Causal control (Test 2):** `n_messages=100` → exactly 10 retrieved. The
  pair proves the retrieved-message count is bounded by `n_messages` and
  causal, not coincidental.

## Guarding against false positives *(how)*

- **Exact counts (`=== 2`, `=== 10`)**, never `>=` — an unbounded retrieval
  (the #482 bug) fails Test 1 with count 10; an empty retrieval fails both.
- **Seed pre-verification:** the monitor API must report exactly 10 stored
  messages before retrieval is asserted — an incomplete seed cannot masquerade
  as a working limit.
- **Per-run sentinel prefix** (`NMSG-<Date.now()>-<rand>`): occurrences cannot
  come from another session, another test, or leftover data.
- **Causal pair:** the only difference between the tests is `n_messages`.
- **Force-failure check** (CONTRIBUTING §2) run during VERIFY on each hard
  assertion before `@stable`.

---

## What this test does not cover *(optional)*

- Model-visible recall through the **Agent** (recall at the window threshold is
  non-deterministic — see the design note; the Agent path shares the same
  backend retrieval).
- Exact windowing semantics beyond most-recent-N (sender filters, ordering
  options, `context_id`).
- External memory backends (Redis, Mem0, …) — only Langflow's internal tables.
- Session isolation / persistence across reopen (see
  `memory-history-regression.spec.ts`).

---

## External dependencies *(required)*

- `src/lfx/components/models_and_agents/memory.py` — the Message History
  (`Memory`) component: `retrieve_messages` applies `limit=n_messages` and the
  flow-scoped retrieval this spec depends on; the Agent's memory resolves
  through the same helper.
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/run`
  (seeding) and `GET /api/v1/monitor/messages` (seed verification).
- `src/frontend/src/CustomNodes/GenericNode/` — the node's edit-fields panel
  (`edit-fields-button`, `shown_messages`, `showsession_id`) and field inputs.
- `src/frontend/src/modals/` — the component output inspector
  (`output-inspection-*`, `textarea`).

---

## When to review this test *(optional)*

- If the Message History node type id changes from `Memory` (selector
  `rf__node-Memory-*`) or the sidebar testid
  `add-component-button-message-history` changes.
- If the default retrieve template stops rendering one line per message.
- If message retrieval stops being flow-scoped (the seed strategy relies on
  same-flow visibility).
- If the `/run` endpoint auth model changes (currently `x-api-key` only).

---

## Notes *(optional)*

- **Flow-scoped retrieval is load-bearing:** seeding a session from a
  *different* flow yields an empty retrieval (cross-flow leak fix, PR #13087)
  and a disabled inspector button. Seed and retrieve in the same flow.
- **The output inspector button is disabled until the selected output has
  non-empty data** — asserting it becomes enabled is itself a signal the
  retrieval returned content.
- **`n_messages` keeps the most recent slice** (fetches `DESC` with
  `limit=n_messages`, then re-orders) — hence Test 1 asserts newest-present /
  oldest-absent, not an arbitrary window end. This matches the Agent-recall
  observations from the option-1 investigation (n=100 always recalled).
- Scouted stability: the full scenario ran 3/3 green at ~10s per run (vs
  ~2–3 min per LLM recall run), with zero model dependency.
