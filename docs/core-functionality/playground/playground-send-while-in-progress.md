# Playground — send a message while a response is in progress (wait/queue)

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Covers QA-CHECKLIST §9.1: sending a message **while a previous response is still
in progress** must not corrupt state — the Playground makes a second send
impossible until the in-flight run finishes.

Scouted live on 1.11.0.dev49, the Playground's "wait" mechanism is:

- **Idle:** the chat input (`input-chat-playground`) is enabled and `button-send`
  is present.
- **While a response is in progress:** `button-send` is **removed** and replaced
  by `button-stop`, **and the chat input is `disabled`** — so the user physically
  cannot type or submit a second message. This is the "wait" behavior (block the
  input until the run settles), which prevents a second concurrent run from
  corrupting the session.
- **After the run completes:** `button-send` returns and the input re-enables;
  exactly one response was produced.

The **distinctive observable** is this tri-state transition of the input —
**enabled → disabled (in progress) → enabled** — paired with the
`button-send`↔`button-stop` swap, plus the fact that exactly **one** response is
rendered (no duplicate/interleaved run from the blocked second send).

The in-progress window is created **deterministically without an LLM**: the test
intercepts the run request (`POST /api/v2/workflows`) and **holds** it open until
the assertions run, then releases it. A passthrough ChatInput → ChatOutput flow
is used, so no provider key is required.

If this fails, the Playground no longer blocks input during a run — a regression
that would let a second send corrupt or interleave the session.

---

## Tags *(required)*

`@regression` `@playground`

`@stable` withheld initially — added only after multiple clean `--retries=0`
runs on the fresh nightly. `@regression` — guards the in-progress input-lock;
`@playground` — the behavior lives entirely in the Playground chat.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- No LLM / provider key — a passthrough ChatInput → ChatOutput flow is used, and
  the in-progress window is created by holding the run request, not by a slow
  model.

---

## Step by step *(required)*

1. Create a passthrough ChatInput → ChatOutput flow via API
   (`createRunnableChatFlowViaApi`); open it in the editor (`/flow/{id}`) and open
   the Playground.
2. Assert the **baseline**: `input-chat-playground` is **enabled** and
   `button-send` is visible.
3. Install a route on `POST /api/v2/workflows` that **holds** the request until
   the test releases it (a promise the test resolves later).
4. Fill the input with the first message and click `button-send`.
5. Assert **in progress**: `button-stop` is visible, `button-send` is hidden, and
   `input-chat-playground` is **disabled**.
6. Attempt to send a second message: the input is disabled, so it cannot be
   filled or submitted — assert `input-chat-playground` `toBeDisabled()` (a second
   run cannot be started).
7. **Release** the held request and unroute so the run completes.
8. Assert **recovery**: `button-send` is visible again, `input-chat-playground` is
   **enabled**, and exactly one response (`div-chat-message`) is present — the
   session is intact, with no duplicate/interleaved run from the blocked send.

---

## Validation criterion *(required)*

The chat input is **enabled** before the send, **disabled** while the run is in
progress (with `button-stop` shown and `button-send` hidden), and **enabled**
again after the run completes — and exactly one response is rendered. The
disabled state during the run is what blocks a second send; the return to enabled
proves the block is tied to the in-progress state, not a permanent lock.

## Guarding against false positives *(how)*

- **Tri-state transition:** asserting enabled → disabled → enabled (not just
  "disabled once") proves the block is caused by the in-progress run, not by an
  input that is simply always disabled.
- **Deterministic hold:** the run request is held by the test and released on
  cue, so the in-progress window exists reliably without depending on model
  latency — no flake from a fast/slow LLM.
- **Single response:** asserting exactly one `div-chat-message` after completion
  catches a regression where the blocked second send actually leaked a duplicate
  or interleaved run.
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY on the
  in-progress `toBeDisabled` assertion.

---

## What this test does not cover *(optional)*

- The Stop button actually aborting a build — covered by
  `stop-button-playground.spec.ts`.
- SSE streaming transport — covered by `playground-response-streaming-sse.spec.ts`.
- Empty-message send behavior — covered by `playground-empty-message-send.spec.ts`.
- A true server-side **queue** of the second message (the product blocks input
  rather than queueing; this spec pins the block contract).

---

## External dependencies *(required)*

- `src/frontend/src/.../playground` — the chat input disabled state and the
  `button-send`/`button-stop` swap during a run.
- `POST /api/v2/workflows` — the run endpoint held to create the in-progress
  window (matched by path; an upstream move requires updating the route regex).
- ChatInput / ChatOutput passthrough — must keep running without a provider.

---

## When to review this test *(optional)*

- If the run endpoint path changes (`/api/v2/workflows`).
- If the Playground changes how it gates input during a run (e.g. switches from
  disabling the input to a real queue) — update the contract.

---

## Notes *(optional)*

- **Scouted mechanism (1.11.0.dev49):** during a run, `document` shows no
  `button-send` (replaced by `button-stop`) and `input-chat-playground.disabled
  === true`; after completion both revert. The run streams from
  `POST /api/v2/workflows`; holding that request keeps the UI in the in-progress
  state for as long as needed.
- **Cleanup:** the created flow is deleted by id in `afterEach` (scoped, never
  `cleanAllFlows`).
