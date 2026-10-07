# Spec: Copy code from the playground / API-access modal — generalBugs-shard-3

**Test file:** `tests/tests-automations/regression/flow-functionality/generalBugs-shard-3.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev34`)

---

## What this test validates

A user can wire a minimal **Chat Input → OpenAI → Chat Output** flow on the
canvas, open the **Playground**, send a message, and **copy the generated API
code** (Python tab) from the API-access modal — the copied snippet is non-empty
and embeds the sent message.

Both tests in this file are active and `@stable`. The second —
**"playground button should be enabled or disabled"** — asserts the Playground
entry point's own gate: with a blank flow the trigger is rendered disabled, and
after one Chat Output is dropped on the canvas the same trigger opens the
Playground dialog. It has been quarantined twice, for two unrelated causes: with
`test.skip` until #1791 (a stale expectation — see *The quarantine was right about
the failure and wrong about the cause*), and with `test.fixme` for #2197 (the
dropped Chat Output never reached the canvas — see *#2197: the drop that never
landed*).

> **Fix (#614).** The spec failed deterministically on the 1.11 nightly because
> the OpenAI model node's handle testids drifted: the node type id changed from
> `openaimodel` to **`openaimodelcomponent`**, so
> `handle-openaimodel-shownode-input-left` / `-model response-right` never
> appeared and the wiring click timed out. The Chat Input / Chat Output handles
> are unchanged. Fix = update the two OpenAI handle testids; no behavior change.

### Verification model

**Test 1 — "should copy code from playground modal"**

1. Blank flow → drag Chat Output, Chat Input, and the OpenAI model node. Each
   drag is issued only once its sidebar entry is draggable — the editor's
   write-permission verdict has resolved (see *#2197* below) — and each is
   verified to have added one node of its type before the next step.
2. Configure the OpenAI node (`initialGPTsetup`), fill the API key.
3. Wire Chat Input → OpenAI → Chat Output via the node handles (current testids).
4. Open the Playground, send a message, open the API-access Python tab, click
   **Copy code**.
5. Assert the clipboard content is non-empty and contains "Hello" (the sent
   message text embedded in the generated snippet).

**Test 2 — "playground button should be enabled or disabled"**

1. Open a blank flow. The editor mounts twice on the way in, and between the two
   mounts the toolbar is not in the DOM at all, so the first assertion is given
   the editor-mount budget (30 s) rather than the 5 s default.
2. Assert the Playground trigger is the **disabled twin** `playground-btn-flow`
   (disabled), and the Playground dialog (`role="dialog"`, name "Playground") is
   hidden.
3. Search the sidebar for **Chat Output** and wait until its entry is draggable
   (`draggable="true"`) — the editor's write-permission verdict has resolved,
   and before that the entry refuses the gesture by design. Then drag it onto
   the canvas once and verify the drop **landed**: exactly one Chat Output node
   is on the canvas. A drop that does not land is reported as such, by name —
   never as the Playground trigger that later fails to appear.
4. Assert the enabled trigger `playground-btn-flow-io` is rendered and enabled
   and the disabled twin is gone — the state change is waited on, not the click.
5. Click `playground-btn-flow-io` and assert the Playground dialog is visible.

---

## Tags

`@stable` `@release` `@workspace` `@playground`

`@playground` is the functional half for both tests (the code-copy modal and the
Playground gate); `@workspace` covers the second test's canvas work. Both are
`@stable` since #1791; the second lost the tag to the #2197 quarantine and gets it
back with that fix.

> The previous justification for withholding `@stable` — *"it depends on a live
> OpenAI key"* — does not hold in this repo and is recorded here so it is not
> re-derived. Provider dependence is handled by `providerSkipGate`, which keys on
> key **health**, and the daily runs plenty of `@stable` specs behind it: the
> nearest sibling, `llm-agents/chatInputOutputUser-shard-0.spec.ts`, is `@stable`
> with the identical gate. The second test needs no provider at all.

---

## Validation criterion

**Test 1.** After wiring the flow with the **current** handle testids
(`handle-openaimodelcomponent-shownode-input-left`,
`handle-openaimodelcomponent-shownode-model response-right`,
`handle-chatinput-noshownode-chat message-source`,
`handle-chatoutput-noshownode-inputs-target`), sending a playground message and
opening the API-access Python tab, the **Copy code** button yields clipboard
content with length > 0 that contains "Hello".

The test fails if any handle cannot be clicked (wiring drift) or the code cannot
be copied.

**Test 2.** On a ready blank flow the Playground trigger is the disabled twin
`playground-btn-flow` and no Playground dialog is open; once **one Chat Output
node is verified on the canvas**, `playground-btn-flow-io` is rendered **enabled**
(the disabled twin gone), and clicking it opens `getByRole("dialog", { name:
"Playground" })`.

The test fails, each with its own message, when: the blank-flow trigger is not
the disabled twin (the gate regressed open); the Chat Output sidebar entry never
becomes draggable (the editor never leaves its permission-pending, read-only
state); the drop of a draggable entry does not land on the canvas (the add
regressed); a Chat Output node is on the canvas and the
enabled trigger never replaces the disabled one (the gate regressed closed); or
the enabled trigger does not open the Playground dialog.

---

## External dependencies

- **`OPENAI_API_KEY`** — required by the FIRST test only, which `test.skip`s when `providerSkipGate("openai")` reports the key unusable (health, not mere presence). The second test needs no provider. The flow is
  run in the Playground, so the key must be **active** (not quota-exhausted —
  cf. #772). On a quota-blocked key the send may error and the code-copy step can
  still not be reachable.
- Helpers: `initialGPTsetup`, `clearApiKeyBadges`, `adjustScreenView`,
  `awaitBootstrapTest`, `fillSidebarSearch`.
- `POST /api/v1/authz/me/permissions` — the editor's write-permission verdict.
  Every sidebar drag in both tests waits for it, read off the entry's
  `draggable` attribute — upstream
  `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarDraggableComponent.tsx`
  and `src/frontend/src/contexts/permissionsContext.tsx`.
- Core I/O components (Chat Input / Chat Output) + the OpenAI model bundle node.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.13.x).
- Auth via `auto_login` (repo default).
- Active `OPENAI_API_KEY` in `.env` / CI secrets.

---

## What this test does not cover

- Whether the Playground's chat is usable for a flow with **no** Chat Input — the
  second test asserts the dialog opens, not what it can do once open.
- Actual model-answer correctness — the assertion is on the copied API snippet,
  not the model's chat response.

---

## Notes

- **Handle testid drift (#614):** `openaimodel` → `openaimodelcomponent` on the
  1.11 nightly; the Chat Input / Chat Output handles are unchanged. Confirmed
  live on `1.11.0.dev46` during the fix scout.
- The spec builds the flow via UI drag (legacy shard); it does not persist a
  named flow beyond the bootstrap one — cleanup follows the file's existing
  pattern.

### The quarantine was right about the failure and wrong about the cause

The `test.skip` carried a TODO reading *"the test started failing — indicating that
the current Langflow behavior may not match what was originally expected"*, and
proposed checking whether `playground-btn-flow` *should* be disabled on an empty
flow. Unmuted for the #1784 measurement it came back **0/3**, always at
`getByText('Langflow Chat')` → *element(s) not found*, at the 5 s default.

Measured on `1.13.0.dev9`, the product is fine and the **expectation** was stale.
`"Langflow Chat"` is the value of the i18n key `misc.chatTitle`, and that key occurs
**exactly once in the whole frontend bundle** — inside the translation dictionary,
with **zero call sites**. Nothing renders it, so no timeout could have helped; the
same dead-key shape as the `viewExchange` case recorded elsewhere in this repo.
Everything else the test drives is live: `playground-btn-flow-io` is the Playground
trigger that 10+ specs already click, and `playground-btn-flow` is its disabled
twin, rendered with `cursor-not-allowed text-muted-foreground` — which is precisely
what the first assertion wants, so the TODO's own open question is answered *yes*.

The repair is to assert the modal by its own dialog role and accessible name
(`getByRole("dialog", { name: "Playground" })`) in both directions — hidden before,
visible after. Two smaller things went with it, both of which had been hiding the
real signal: the `{ force: true }` on the trigger click (a force-click bypasses
actionability, so a genuinely dead button would still have "clicked"), and a stray
`page.mouse.up()` / `page.mouse.down()` pair left after the `dragTo`, which ended
the test with the mouse button held down. The test also creates a flow through
`blank-flow` and had **no cleanup at all**; it now calls the file's tracker, as the
first test already did.

### #2197: the drop that never landed

Quarantined again at triage after the same signature recurred on the VM lane —
`TimeoutError: locator.click: Timeout 20000ms exceeded.` on
`getByTestId('playground-btn-flow-io')`, 2026-09-15 (`1.13.0.dev12`) and
2026-10-06 (`1.13.0.dev34`). `reports/daily-history.jsonl` holds two more the
triage did not count, on the **Actions** daily: 2026-09-17 (`1.13.0.dev15`) and
2026-09-23 (`1.13.0.dev21`), plus a third shape on 2026-09-22 (VM,
`1.13.0.dev19`) — `toBeDisabled` on the disabled twin, the test's first assertion.
Five flaky days out of the 33 dailies (both lanes, 2026-09-12 → 2026-10-06) since the test regained
`@stable` in #1791, every one green on retry, and no outage overlapping any of
them. The first test, which drags three components the same way, has one of its
own: 2026-09-14 (VM), the same `locator.click: Timeout 20000ms`.

**The enabled trigger was never rendered because the Chat Output never reached
the canvas.** Measured on `1.13.0.dev34` with an instrumented copy of the test
that samples the canvas every 20 ms and keeps observing for 8 s after the drag:
in **3 of 8** iterations the `dragTo` completed, the canvas still held **zero**
`rf__node-*` nodes 8 s later, and the toolbar still showed the disabled twin —
so `playground-btn-flow-io` could not appear at any timeout. No iteration showed
a node that appeared and was then removed, and none showed a node on the canvas
beside a disabled trigger: the gate itself behaved, the add did not.

The same sampling explains the 2026-09-22 shape. Right after the blank flow
opens, the toolbar renders the disabled twin, **unmounts it** and renders it
again — in the measured runs the gap where **neither** trigger was in the DOM
lasted up to ~4.3 s. An unbarriered `toBeDisabled` (5 s default) lands inside
that window on a loaded host and reports *element(s) not found*.

**Why the drop never landed: the editor refuses it while its permission verdict
is in flight — by design.** Upstream's `sidebarDraggableComponent.tsx` renders each
sidebar entry with `draggable={!error && !isUnavailable}`, where `isUnavailable`
includes `useIsFlowReadOnly(currentFlowId)`, and `permissionsContext.tsx` makes
that predicate **fail closed while `POST /api/v1/authz/me/permissions` is
pending** (*"so a denied user cannot briefly mutate the in-memory canvas"*). The
entry is styled `cursor-not-allowed` with a *permissions pending* tooltip for that
window, and `useAddComponent` refuses the "+" path on the same predicate. A drag
issued then produces no native drag session at all: Playwright's mouse gesture
completes, but no `dragstart` / `drop` event ever fires, so Langflow has nothing to
discard. That is a test-timing defect, not a product regression — the product
announces the state, and the old test never waited for it.

The visible state is itself recent, which is why the history reads the way it
does. langflow#14068 (2026-07-15) made every add fail closed during the pending
check; langflow#14523 (merged 2026-08-14, `LE-2176`) added the missing half — the
affordance — because until then *"the user clicked and the action was discarded
with no toast, no cursor change … The node simply never appeared"*. The same PR
bounds the window: a transient 5xx on the first permissions call is retried 5
times with `min(1000 * 2 ** n, 30000)` backoff, so the editor can stay read-only
for roughly half a minute. The wait below is budgeted at 45 s for that reason,
not for one round trip.

Measured on `1.13.0.dev34`, three ways:

- **Correlation, unforced** — 20 iterations recording DOM drag events and the
  in-flight `/api/` requests at the moment of the gesture: in all 19 that landed
  a node, `dragstart` fired *after* the permissions response (the closest pair
  within a few ms, read across the page and test-runner clocks); the one gesture that ended before it (1661–1758 ms,
  response at 1766 ms) recorded **zero** drag events and no node.
- **Forced race** — holding the permissions response for 4 s with `page.route`:
  the old sequence read `draggable="false"` at the drag and lost the drop **4 of
  4**, ending exactly in #2197's state (no node, `playground-btn-flow` still
  rendered, `playground-btn-flow-io` absent); a fifth run died earlier on
  `toBeDisabled` → *element(s) not found*, the 2026-09-22 shape, because the
  delay also stretches the gap between the two editor mounts.
- **The fix under the same forced race** — wait for `draggable="true"` first
  (it turned after 1.2–3.1 s), drag once: **5 of 5** landed in 6–31 ms, the
  enabled trigger replaced the disabled one, and the 30 s budget on the first
  `toBeDisabled` absorbed the mount gap every time.

Two choices follow from that. The wait is on the **state** (`draggable="true"`),
not a retry: a drag re-issued blind would also have "repaired" this, but would
equally hide a drop the editor discards while the entry *is* draggable — which is
now its own failure, reported by name. And `canvas_controls_dropdown` was
**rejected** as the readiness barrier the first draft of this doc named: the
controls render on the editor's *first* mount and vanish with it, so they are
present before the permission verdict exists.
