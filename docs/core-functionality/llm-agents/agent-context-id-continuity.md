# Agent context_id — continuity between session messages

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev7`)

---

## What this test validates *(required)*

QA-CHECKLIST §6.3 "Agent uses custom context_id — continuity between session
messages". `context_id` is an advanced MessageTextInput on the Agent (and on
ChatInput/ChatOutput/Message History) that "adds an extra layer to the local
memory": stored messages are tagged with it (`chat.py`/`chat_output.py`), and
the Agent's history retrieval resolves through
`aget_agent_chat_history(session_id, flow_id, context_id, n_messages)`
(`agent.py → get_memory_data`) — the same context-scoped layer the Message
History component's Retrieve mode reads.

Two halves, one test each — both **deterministic** (no model-recall
assertion; lesson from #482, where three recall designs flaked at spec
level):

1. **Agent run writes into the custom context layer.** A Simple Agent run
   with `context_id = CTX` on Agent + ChatInput + ChatOutput persists the
   turn's messages tagged `context_id = CTX` (monitor API, nonce-keyed).
2. **The context layer keeps continuity across turns.** Messages seeded
   across MULTIPLE runs under the same (session, CTX) all come back from a
   context-scoped retrieval — a Message History node (Retrieve,
   explicit session + CTX) returns every seeded sentinel — while a control
   message stored in the SAME session **without** the context is NOT
   returned. Retrieval count/content is exact, not model-mediated.

> **Unit-shift note (same deviation class as #482, flagged on the PR).** The
> Agent's own use of retrieved history is invisible post-run (injected into
> the prompt, never persisted), so test 2 observes the context layer through
> Message History's Retrieve — which resolves through the same context-scoped
> backend retrieval as the Agent's `get_memory_data`. Test 1 keeps the Agent
> itself in the loop on the write side.

Boundary: switching BETWEEN two custom contexts (isolation) is #488's bullet
— this spec proves continuity within one context plus the minimal
default-vs-custom negative needed for falsifiability.

If this test fails, custom-context conversations either don't persist their
tag or don't accumulate history — the agent memory layering contract dies.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@components`

`@stable` added after 4 clean `--retries=0` runs on the fresh nightly
(1.11.0.dev36; issue #487's "Done when" includes `@stable`). `@regression` — guards
the context tagging + scoped-retrieval wiring; `@agents` — Agent memory
surface; `@components` — Message History node drives the retrieval assert.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (fresh nightly).
- Test 1 needs `models.json`/`providers.json` (collect-models) + an active
  provider key; test 2 is model-free (passthrough seeding).
- Run with `--workers=1` — test 1 loads the Simple Agent template (agent-area
  rule). Flows are id-scoped-deleted in cleanup (`deleteFlow` helper).

---

## Step by step *(required)*

**Test 1 — agent run persists messages tagged with the custom context (§6.3 write half)**

1. Load the Simple Agent template (provider/model from `models.json`/`.env`).
2. Set `context_id = CTX` (unique per run, `ctx-<nonce>`) on the **Agent**,
   **Chat Input** and **Chat Output** nodes (advanced field — controls
   dialog / exposed field; real testids confirmed in PLAN).
3. Seed the ChatInput task with a nonce; open the Playground, send, wait.
4. **Assert (monitor API):** nonce → session; every persisted message of the
   session (user AND AI) carries `context_id === CTX`.
5. No `allowFlowErrors`.

**Test 2 — context-scoped retrieval returns the full multi-turn history (§6.3 continuity half; model-free)**

1. Create a passthrough Chat Input → Chat Output flow via API
   (`createRunnableChatFlowViaApi`), PATCH its ChatInput/ChatOutput nodes to
   set `context_id = CTX`.
2. Seed N=3 runs via `POST /api/v1/run` with a fixed custom `session_id` and
   sentinel texts `S-1..S-3` (6 stored messages); poll the monitor API to
   the exact expected count (failed seed fails HERE, not as a silent empty
   retrieval later).
3. Store one CONTROL message in the same session with **no** context (PATCH
   context back to empty for one extra run, sentinel `S-CTRL`).
4. On the flow canvas, add a Message History node (Retrieve), expose and set
   `session_id` = the custom session, `context_id = CTX`, `n_messages=100`;
   run the node (`button_run`), open the output inspector.
5. **Assert:** the rendered retrieval contains `S-1`, `S-2` AND `S-3`
   (continuity across all turns of the context) and does NOT contain
   `S-CTRL` (the retrieval is genuinely context-filtered — the negative that
   makes the positive falsifiable).

---

## Validation criterion *(required)*

Write half: every message persisted by an agent run configured with
`context_id = CTX` carries exactly that tag in the monitor API. Continuity
half: a context-scoped Message History retrieval over a session seeded with
3 tagged turns returns **all three** sentinels and **not** the untagged
control sentinel from the same session. Counts and containment are exact
string checks on persisted/rendered data — no model judgment anywhere.

## Guarding against false positives *(how)*

- **No model-recall asserts** — the #482 lesson applied at design time; the
  model is only used where it must be (test 1's agent run) and never as the
  observable.
- **Control sentinel (test 2)** — without `S-CTRL`, an unfiltered
  retrieve-everything bug would still return `S-1..S-3` and pass; the
  negative pins the assert to the context filter itself.
- **Seed verified before retrieval** — the exact monitor-count poll after
  seeding separates "seed failed" from "retrieval broken".
- **Unique CTX + session per run** — monitor rows persist across flow
  deletion; per-run identifiers pin every lookup to THIS run.
- **Force-failure checks** (CONTRIBUTING §2): M1 — test 1 expects
  `context_id === "wrong-ctx"` ⇒ must fail; M2 — test 2 asserts `S-CTRL`
  present (inverted negative) ⇒ must fail; M3 — test 2 expects a 4th,
  never-seeded sentinel ⇒ must fail.

---

## What this test does not cover *(optional)*

- Switching between two custom contexts / cross-context isolation on the
  Agent surface — #488 (`agent-context-id-isolation.spec.ts`).
- The Agent's prompt-side consumption of retrieved history (not persisted,
  not observable post-run — see the unit-shift note).
- `n_messages` interaction with the context layer
  (`agent-n-messages-limit.spec.ts` owns the limit contract).

---

## External dependencies *(required)*

- **LLM provider API** (test 1 only): one completion.
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models) — test 1.
- No external network for test 2 (API passthrough + local retrieval).
