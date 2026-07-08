# Agent context_id — switching isolates history between contexts

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

QA-CHECKLIST §6.3 "Switching `context_id` isolates history between distinct
sessions" and §7.7 "Use of custom `context_id` for memory isolation".
`context_id` is an advanced MessageTextInput on the Agent (and on
ChatInput/ChatOutput/Message History) that "adds an extra layer to the local
memory": stored messages are tagged with it, and history retrieval resolves
through `aget_agent_chat_history(session_id, flow_id, context_id, n_messages)`
— the context-scoped layer proven for continuity by
`agent-context-id-continuity.spec.ts` (#487). This spec proves the OTHER half
of the contract: two different `context_id` values are **mutually invisible**.

Two halves, one test each — both **deterministic** (no model-recall
assertion; lesson from #482):

1. **Read-side isolation (model-free).** One session seeded under TWO
   contexts (`CTX-A` then `CTX-B`, sentinels `A-1..3` / `B-1..3`); a
   context-scoped Message History retrieval with `CTX-A` returns every `A-*`
   and **zero** `B-*`, and the mirrored retrieval with `CTX-B` returns every
   `B-*` and **zero** `A-*`. The negatives are symmetric — a leak in either
   direction fails.
2. **Write-side isolation on the Agent (switching).** A Simple Agent run
   with `context_id = CTX-A`, then the SAME flow **switched** to `CTX-B` and
   run again in the same playground session: every message persisted by turn
   1 carries exactly `CTX-A`, every message persisted by turn 2 carries
   exactly `CTX-B` (monitor API, nonce-keyed) — switching re-tags the write
   path with no cross-tagging.

> **Unit-shift note (same deviation class as #482/#487, flagged on the PR).**
> The Agent's prompt-side consumption of retrieved history is invisible
> post-run (injected into the prompt, never persisted), so read-side
> isolation is observed through Message History's Retrieve — which resolves
> through the same context-scoped backend retrieval as the Agent's
> `get_memory_data`. Test 2 keeps the Agent itself in the loop on the write
> side, where switching is directly observable in persisted tags.

Boundary: continuity WITHIN one context (multi-turn accumulation +
default-vs-custom negative) is #487's spec
(`agent-context-id-continuity.spec.ts`) — this spec proves the wall between
two custom contexts.

If this test fails, distinct `context_id` values share history — the memory
isolation contract dies and "context as a memory layer" is a fiction.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@components` (test 1)
`@stable` `@regression` `@agents` `@playground` (test 2)

`@stable` added after 4 clean `--retries=0` runs on the fresh nightly
(issue #488's "Done when" includes `@stable`). `@regression` — guards the
context tagging + scoped-retrieval isolation wiring; `@agents` — Agent memory
surface; `@components` — Message History node drives the read-side assert;
`@playground` — test 2 switches contexts across live playground turns.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (fresh nightly).
- Test 2 needs `models.json`/`providers.json` (collect-models) + an active
  provider key; test 1 is model-free (passthrough seeding).
- Run with `--workers=1` — test 2 loads the Simple Agent template (agent-area
  rule). Flows are id-scoped-deleted in cleanup (`deleteFlow` helper).

---

## Step by step *(required)*

**Test 1 — mirrored context-scoped retrievals are mutually blind (§6.3/§7.7 read half; model-free)**

1. Create a passthrough Chat Input → Chat Output flow via API
   (`createRunnableChatFlowViaApi`), PATCH its ChatInput/ChatOutput nodes to
   set `context_id = CTX-A`.
2. Seed 3 runs via `POST /api/v1/run` with a fixed custom `session_id` and
   sentinels `A-1..A-3`; poll the monitor API to the exact expected count.
3. PATCH the flow's `context_id` to `CTX-B`; seed 3 more runs, sentinels
   `B-1..B-3`; poll to the new exact total (12 stored messages).
4. On the flow canvas, add a Message History node (Retrieve), expose and set
   `session_id` = the custom session, `context_id = CTX-A`, `n_messages=100`;
   run the node, read the output inspector.
5. **Assert (A side):** retrieval contains `A-1`, `A-2`, `A-3` and does NOT
   contain any `B-*` sentinel.
6. Update the node's `context_id` field to `CTX-B`, run again, read output.
7. **Assert (B side):** retrieval contains `B-1`, `B-2`, `B-3` and does NOT
   contain any `A-*` sentinel.

**Test 2 — switching the Agent's context_id re-tags persisted messages with no cross-tagging (§6.3 switching half)**

1. Load the Simple Agent template (provider/model from `models.json`/`.env`).
2. Set `context_id = CTX-A` (unique per run) on the **Agent**, **Chat Input**
   and **Chat Output** nodes (same advanced-field path as #487).
3. Seed the ChatInput with nonce N1; open the Playground, send, wait.
4. Switch `context_id` to `CTX-B` on the same three nodes; seed nonce N2;
   send a second turn in the same playground session.
5. **Assert (monitor API):** N1 → its session's turn-1 messages ALL carry
   `context_id === CTX-A` and none carry `CTX-B`; N2 → turn-2 messages ALL
   carry `CTX-B` and none carry `CTX-A`. Message sets are keyed by nonce, so
   the two turns are disjoint by construction.
6. No `allowFlowErrors`.

---

## Validation criterion *(required)*

Read half: a Message History retrieval scoped to `CTX-A` over a session
seeded under both contexts returns **all** `A-*` sentinels and **no** `B-*`
sentinel, and the `CTX-B` retrieval mirrors it exactly. Write half: after
switching the Agent's `context_id` between two turns, each turn's persisted
messages carry **exactly** the context active at that turn, with zero
cross-tagging. Containment and tag equality are exact string checks on
persisted/rendered data — no model judgment anywhere.

## Guarding against false positives *(how)*

- **No model-recall asserts** — the #482 lesson applied at design time; the
  model runs only in test 2's agent turns and is never the observable.
- **Symmetric negatives (test 1)** — a retrieve-everything bug returns both
  sentinel families and fails BOTH directions; a retrieve-nothing bug fails
  the positives. Either defect is caught.
- **Seed verified before retrieval** — exact monitor-count polls after each
  seeding block separate "seed failed" from "isolation broken".
- **Unique CTX-A/CTX-B/session per run** — monitor rows persist across flow
  deletion; per-run identifiers pin every lookup to THIS run.
- **Force-failure checks** (CONTRIBUTING §2): M1 — test 1 asserts a `B-*`
  sentinel present in the `CTX-A` retrieval (inverted negative) ⇒ must fail;
  M2 — test 1 expects a never-seeded sentinel ⇒ must fail; M3 — test 2
  expects turn-2 messages tagged `CTX-A` (stale context) ⇒ must fail.

---

## What this test does not cover *(optional)*

- Multi-turn continuity WITHIN one context and the default-vs-custom
  negative — `agent-context-id-continuity.spec.ts` (#487).
- The Agent's prompt-side consumption of retrieved history (not persisted,
  not observable post-run — see the unit-shift note).
- `n_messages` interaction with the context layer
  (`agent-n-messages-limit.spec.ts`).

---

## External dependencies *(required)*

- **LLM provider API** (test 2 only): two completions.
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models) — test 2.
- No external network for test 1 (API passthrough + local retrieval).
