# Spec: Copy code from the playground / API-access modal — generalBugs-shard-3

**Test file:** `tests/tests-automations/regression/flow-functionality/generalBugs-shard-3.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev9`)

---

## What this test validates

A user can wire a minimal **Chat Input → OpenAI → Chat Output** flow on the
canvas, open the **Playground**, send a message, and **copy the generated API
code** (Python tab) from the API-access modal — the copied snippet is non-empty
and embeds the sent message.

Both tests in this file are active and `@stable` since #1791. The second —
**"playground button should be enabled or disabled"** — asserts the Playground
entry point's own gate: with a blank flow the trigger is rendered disabled, and
after one Chat Output is dropped on the canvas the same trigger opens the
Playground dialog. It was quarantined with `test.skip`; see *The quarantine was
right about the failure and wrong about the cause* below.

> **Fix (#614).** The spec failed deterministically on the 1.11 nightly because
> the OpenAI model node's handle testids drifted: the node type id changed from
> `openaimodel` to **`openaimodelcomponent`**, so
> `handle-openaimodel-shownode-input-left` / `-model response-right` never
> appeared and the wiring click timed out. The Chat Input / Chat Output handles
> are unchanged. Fix = update the two OpenAI handle testids; no behavior change.

### Verification model

1. Blank flow → drag Chat Output, Chat Input, and the OpenAI model node.
2. Configure the OpenAI node (`initialGPTsetup`), fill the API key.
3. Wire Chat Input → OpenAI → Chat Output via the node handles (current testids).
4. Open the Playground, send a message, open the API-access Python tab, click
   **Copy code**.
5. Assert the clipboard content is non-empty and contains "Hello" (the sent
   message text embedded in the generated snippet).

---

## Tags

`@stable` `@release` `@workspace` `@playground`

`@playground` is the functional half for both tests (the code-copy modal and the
Playground gate); `@workspace` covers the second test's canvas work. Both are
`@stable` since #1791.

> The previous justification for withholding `@stable` — *"it depends on a live
> OpenAI key"* — does not hold in this repo and is recorded here so it is not
> re-derived. Provider dependence is handled by `providerSkipGate`, which keys on
> key **health**, and the daily runs plenty of `@stable` specs behind it: the
> nearest sibling, `llm-agents/chatInputOutputUser-shard-0.spec.ts`, is `@stable`
> with the identical gate. The second test needs no provider at all.

---

## Validation criterion

After wiring the flow with the **current** handle testids
(`handle-openaimodelcomponent-shownode-input-left`,
`handle-openaimodelcomponent-shownode-model response-right`,
`handle-chatinput-noshownode-chat message-source`,
`handle-chatoutput-noshownode-inputs-target`), sending a playground message and
opening the API-access Python tab, the **Copy code** button yields clipboard
content with length > 0 that contains "Hello".

The test fails if any handle cannot be clicked (wiring drift) or the code cannot
be copied.

---

## External dependencies

- **`OPENAI_API_KEY`** — required by the FIRST test only, which `test.skip`s when `providerSkipGate("openai")` reports the key unusable (health, not mere presence). The second test needs no provider. The flow is
  run in the Playground, so the key must be **active** (not quota-exhausted —
  cf. #772). On a quota-blocked key the send may error and the code-copy step can
  still not be reachable.
- Helpers: `initialGPTsetup`, `clearApiKeyBadges`, `adjustScreenView`,
  `awaitBootstrapTest`.
- Core I/O components (Chat Input / Chat Output) + the OpenAI model bundle node.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.11.x).
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