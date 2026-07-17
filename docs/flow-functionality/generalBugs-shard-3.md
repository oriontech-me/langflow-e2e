# Spec: Copy code from the playground / API-access modal — generalBugs-shard-3

**Test file:** `tests/tests-automations/regression/flow-functionality/generalBugs-shard-3.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

A user can wire a minimal **Chat Input → OpenAI → Chat Output** flow on the
canvas, open the **Playground**, send a message, and **copy the generated API
code** (Python tab) from the API-access modal — the copied snippet is non-empty
and embeds the sent message.

Active test in this file: **"should copy code from playground modal"** (`@release`).
The second test ("playground button should be enabled or disabled") is
`test.skip` (pre-existing TODO — out of scope for this fix).

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

`@release`

`@release` (happy-path flow-wiring + playground code-copy). Not `@stable` — it
depends on a live OpenAI key (see External dependencies); kept as a `@release`
happy-path check.

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

- **`OPENAI_API_KEY`** — required; the test `test.skip`s without it. The flow is
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

- The **second** test in the file (playground-button enabled/disabled) — it is
  `test.skip` with a standing TODO.
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
