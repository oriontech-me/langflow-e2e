# Agent context_id — switching isolates history between contexts

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev1`)

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

`@stable` was removed and `test.fixme` added at the 2026-08-31 triage (#1643, PR
#1647) while the canvas bottom-overlay intercepted the retrieval click. Both are
restored here: root cause named and fixed (see the overlay note under *Step by
step*), re-validated with clean `--retries=0` runs on nightly `1.13.0.dev0` — the
image `daily-stable.yml` pulls as `:latest` — as well as on `1.12.0.dev39`, where
the geometry above was measured.

---

> **The parametrized test currently fails on some providers (#1689).** On
> `anthropic / claude-haiku-4-5` the message the Agent persists for its own turn
> carries `context_id: null` while every other message of the same session
> carries the configured one — 6 failures out of 6 across `1.12.0.dev45` and
> `1.13.0.dev1`, and **downstream** of the #1060 confirmed-write gate, which
> passes and so excludes a reverted write. On `openai / gpt-4o-mini`, against
> the **same** build `1.13.0.dev1`, the same test passes (3 attempts, twice over
> — measured on CI, which pins openai per #1169). The image is therefore held
> constant and the provider is the axis; what the two paths do differently is
> open in #1689. The related source fact — `agent.py` threads `context_id`
> through the read path (`get_memory_data`) while `_construct_agent_message`
> builds the stored Message without it and `lfx/base/agents/events.py` never
> mentions it — is true but cannot be the whole cause, since it would fail both
> providers. **No annotation is applied:** the test reports the truth per
> provider, red where the defect reproduces and green where it does not.

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (fresh nightly).
- The parametrized test needs `models.json`/`providers.json` (collect-models) + an
  active provider key — **unless the run is routed** (see *Model strategy*), which needs
  no key at all. The "retrieval layer (model-free)" test needs neither.
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
   run the node, **free the canvas bottom-overlay slot** (see the note below),
   read the output inspector.
5. **Assert (A side):** retrieval contains `A-1`, `A-2`, `A-3` and does NOT
   contain any `B-*` sentinel.
6. Update the node's `context_id` field to `CTX-B`, run again, free the
   overlay slot again, read output.
7. **Assert (B side):** retrieval contains `B-1`, `B-2`, `B-3` and does NOT
   contain any `A-*` sentinel.

**Test 2 — switching the Agent's context_id re-tags persisted messages with no cross-tagging (§6.3 switching half)**

1. Load the Simple Agent template (provider/model from `models.json`/`.env`).
2. Set `context_id = CTX-A` (unique per run) on the **Agent**, **Chat Input**
   and **Chat Output** nodes (same advanced-field path as #487), and **confirm
   the write survived** before running the turn (see the confirmed-write note
   below).
3. Seed the ChatInput with nonce N1; open the Playground, send, wait.
4. Switch `context_id` to `CTX-B` on the same three nodes — again **confirmed**
   — seed nonce N2; send a second turn in the same playground session.
5. **Assert (monitor API):** N1 → its session's turn-1 messages ALL carry
   `context_id === CTX-A` and none carry `CTX-B`; N2 → turn-2 messages ALL
   carry `CTX-B` and none carry `CTX-A`. Message sets are keyed by nonce, so
   the two turns are disjoint by construction.
6. No `allowFlowErrors`.

> **Confirmed-write setup (#1060).** The `context_id` write is an API PATCH on
> the flow's nodes, and the editor keeps firing its own debounced
> `PATCH /api/v1/flows/{id}` carrying the store's snapshot after a playground
> turn. That autosave can be *issued* after our PATCH and land last — the
> endpoint has no version check — silently reverting the switch, so the next
> turn runs under the OLD context and the test reports a cross-tagging failure
> that never happened. Reproduced locally at ~8% (1/12 `--retries=0` runs);
> the daily's parallel shards widen the window, which is why every recorded
> occurrence fell on a saturated day. Each turn's setup is therefore
> **PATCH → reload → set the ChatInput → drain the autosave → read the flow
> back**, retried while the server still disagrees, and the turn only runs
> once the server confirms the intended context on all three nodes. If the
> editor wins three times in a row the test fails as an explicit **setup**
> error naming the reverted write — never as a fake isolation defect.

> **Canvas bottom-overlay note (#1643).** Langflow renders two different
> components into ONE fixed container over the canvas —
> `absolute bottom-16 left-1/2 z-50 w-[530px] -translate-x-1/2`: the
> build-status bar (`flowBuildingComponent`, transient — it auto-dismisses 2 s
> after "Flow built successfully" plus a 500 ms exit) and the "Flow needs
> review / N components need updates" banner (`UpdateAllComponents`), which is
> **hidden while the bar is up and takes the slot back the moment it
> dismisses**, then stays indefinitely. Measured on nightly `1.12.0.dev39` at
> the default 1280x720 viewport, the Message History node's
> `output-inspection-messages-memory` button sits at y 585.6-601.0 (centre
> 593.3) while the bar's top edge is y 598 — the click clears it by ~5 px — and
> the banner is 12 px taller, top edge y ~586, i.e. **above** the centre. So the
> identical click passed or was refused purely on which component owned the
> slot, and once the banner owned it no retry could help: on the 2026-08-31
> daily both context-id specs burned the full 20 s `locator.click` budget on all
> three attempts against `<div class="flex items-center justify-between gap-6
> rounded-lg border bg-background px-4 py-3 text-sm shadow-md">`, the banner's
> inner element. The banner is present because the seeded flow comes from
> `tests/assets/flows/chat-io-ok-trace-fixture.json`, whose nodes carry
> `lf_version: 1.7.0` and one of which the 1.12 nightly reports as outdated.
> Refreshing that fixture would silence it only until the next upstream template
> bump — and would leave the build bar's ~5 px margin untouched — so the step
> above frees the slot (`clearCanvasBottomOverlay`, waits the transient occupant
> out and dismisses the persistent one) instead of clicking into it. Both files
> are `mode: "serial"`, so this failure also skipped each file's sibling; with
> it fixed the siblings run again. The serial mode itself stays — it is the
> agent-area rule for a file that loads the Simple Agent template — and the
> coupling is already mitigated the way this file can mitigate it: the model-free
> describe is declared BEFORE the parametrized loop on purpose, so a weak-model or
> missing-provider failure there cannot skip the half that needs no provider. What
> that ordering cannot protect against is a failure in the FIRST describe, which is
> what happened here; the answer is to stop that failure, not to unpick the
> execution mode.

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
- **Setup failures are distinguishable from contract failures** — a reverted
  `context_id` write fails in the setup step naming the reversion, so a
  frontend/backend write race can never masquerade as broken isolation
  (#1060).
- **Force-failure checks** (CONTRIBUTING §2): M1 — test 1 asserts a `B-*`
  sentinel present in the `CTX-A` retrieval (inverted negative) ⇒ must fail;
  M2 — test 1 expects a never-seeded sentinel ⇒ must fail; M3 — test 2
  expects turn-2 messages tagged `CTX-A` (stale context) ⇒ must fail; M4 —
  test 2's confirmed-write gate targets a context the flow never receives
  ⇒ must fail in setup, proving the gate is live.

---

## What this test does not cover *(optional)*

- Multi-turn continuity WITHIN one context and the default-vs-custom
  negative — `agent-context-id-continuity.spec.ts` (#487).
- The Agent's prompt-side consumption of retrieved history (not persisted,
  not observable post-run — see the unit-shift note).
- `n_messages` interaction with the context layer
  (`agent-n-messages-limit.spec.ts`).

---

## Model strategy

- Parameterized per provider/model via the shared
  `resolveTestTargets({ tier: "any-completion" })`
  (`helpers/provider-setup/test-targets.ts`). The parametrized test is the only one the
  tier governs; the "retrieval layer (model-free)" test is declared outside the loop and
  resolves no provider at all.
- **Tier: `any-completion` (#1187).** No assertion depends on the model choosing or
  managing to do anything: the parametrized test reads which `context_id` the PERSISTED
  turns carry after the agent's context is switched, never what the agent replied. The model only has to answer something, so
  the deciding observable is Langflow's context tagging.
- **Measured 7/7** routed against `llama3.2:1b` on the CI lane — the same dispatches
  recorded in `agent-context-id-continuity.md` (which measured 6/7 there; its one failure
  was a canvas-layout helper, not an assertion of its own). Read against the baseline
  rather than as a clean bill: this spec hard-failed on **6 of 22** hosted dailies and was
  flaky on 4 more before any of this. The rate is also necessary and not sufficient —
  `agent-component-regression` passed 5/5 routed and stays `tool-calling` because its
  assertions depend on the model's timing. This is the heavier of the two context-id
  specs — two turns plus up to three reload cycles inside the 5-minute cap — so it carries
  the thinner margin of the pair.
- Consequence: with `ANY_COMPLETION_PROVIDER=ollama` (+ `OLLAMA_TEST_MODEL`) the
  parametrized test runs against a **local, keyless** model — no key, no quota — and that
  routing outranks `MODEL_TEST_ID` / `MODEL_TEST_PROVIDER` for this tier only.
- Run with `--workers=1` locally (the parametrized test loads the Simple Agent
  template — agent-area rule).

---

## External dependencies *(required)*

- **A model that returns text**, for the parametrized test only — two completions, in
  one of two shapes:
  - **Hosted (default):** a provider API key plus collected `providers.json` /
    `models.json`.
  - **Local (routed, #1187):** `ANY_COMPLETION_PROVIDER=ollama` + `OLLAMA_TEST_MODEL`
    and a reachable Ollama — **no key at all**. `globalSetup` configures the provider
    once before any worker (see `preconfigure-routed-provider.ts`).
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models) — test 2.
- No external network for test 1 (API passthrough + local retrieval).
- **Upstream frontend sources the retrieval step now depends on (#1643).** The
  slot-clearing step reads Langflow's own canvas bottom-centre overlay, so a rename
  of either component is a silent break — the selector would match nothing and the
  click would go back to being intercepted. Declared here so
  `watch-upstream-areas.mjs --mode=check-docs` fails the PR that moves them:
  `src/frontend/src/pages/FlowPage/components/flowBuildingComponent/index.tsx` and
  `src/frontend/src/pages/FlowPage/components/UpdateAllComponents/index.tsx`. A
  class-only edit (`w-[530px]`, `bottom-16`) is not caught by that guard, which is
  why `clearCanvasBottomOverlay` additionally fails closed when its selector matches
  nothing at all.
