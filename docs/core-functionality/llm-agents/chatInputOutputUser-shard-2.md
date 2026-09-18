# Spec: Chat Input/Output — Playground Interaction with Custom Sender Names

**Test file:** `tests/tests-automations/regression/core-functionality/llm-agents/chatInputOutputUser-shard-2.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev15`)

---

## What this test validates

End-to-end Playground interaction on the Basic Prompting flow, plus the
**custom sender name** feature of the Chat Input / Chat Output components:

1. A first Playground turn ("Hello, how are you?") echoes the user message and
   produces a non-empty AI reply — the default sender labels (`User` / `AI`).
2. After exposing and setting a custom `sender_name` on both Chat Input
   (`TestSenderNameUser`) and Chat Output (`TestSenderNameAI`), a second turn
   ("Are you doing ok?") renders the messages tagged with the **custom** sender
   names — `chat-message-TestSenderNameUser` / `chat-message-TestSenderNameAI`.

### dev46 node-inspector model

The nightly removed the inspect-panel on/off toggle and the old `show<field>`
toggles. The advanced `sender_name` field is exposed on each node body via the
inspector: `openAdvancedOptions` (`parameters-button`) → `inspector-add-sender_name`
→ `closeAdvancedOptions`. The field's input (`popover-anchor-input-sender_name`)
then renders on the node body (the Basic Prompting Chat Input/Output nodes are
expanded, so the input is directly fillable).

---

## Tags

`@stable` `@release` `@components` `@agents` `@playground`

---

## Step by step

1. `providerSkipGate("openai")` decides whether the test runs. It skips when
   `OPENAI_API_KEY` is absent **or** when `collect-models` recorded the provider
   `inactive` — the missing key is reported first, and the two are alternatives,
   not a conjunction. The gate exists because the flow makes a real completion
   and a dead key blocks the backend past gunicorn's timeout (#1029). It fails
   **open**: no `providers.json` (it is gitignored, so a fresh clone and any
   targeted local run have none), an unreadable one, no `openai` record in it, or
   `IGNORE_PROVIDER_HEALTH=1` all let the test run — which is deliberate (#980),
   and is why a drained key with no health record still reaches the flow.
   Bootstrap; open the **Basic
   Prompting** template; `initialGPTsetup`. Every flow created is captured from
   its `POST /api/v1/flows → 201` and deleted id-scoped in `afterEach`.
2. Open the Playground; send "Hello, how are you?"; wait for the build to finish;
   assert the user message text and a non-empty AI reply. Close the Playground.
3. Select **Chat Input**, `openAdvancedOptions`, `inspector-add-sender_name`,
   `closeAdvancedOptions`. Repeat for **Chat Output**.
4. Fill `popover-anchor-input-sender_name` nth 0 = `TestSenderNameUser`, nth 1 =
   `TestSenderNameAI`.
5. Open the Playground; send "Are you doing ok?"; wait for the build.
6. Assert `chat-message-TestSenderNameUser` has the sent text and
   `chat-message-TestSenderNameAI` is non-empty. Close the Playground.

---

## Validation criterion

| Turn | Criterion |
|---|---|
| Default sender names | `chat-message-User` = "Hello, how are you?"; `chat-message-AI` non-empty |
| Custom sender names | `chat-message-TestSenderNameUser` = "Are you doing ok?"; `chat-message-TestSenderNameAI` non-empty |

The custom-sender assertions fail if `sender_name` was not exposed/applied — the
messages would fall back to the default `User`/`AI` labels.

---

## External dependencies

- **OpenAI** — a real completion, so the gate is `providerSkipGate("openai")`
  (health, not the env var alone); the flow runs an OpenAI model via
  `initialGPTsetup`.
- Basic Prompting starter template (Chat Input → … → Chat Output).
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions` /
  `closeAdvancedOptions` (dev46 inspector).
- `tests/helpers/other/initialGPTsetup.ts` — provider/model setup.

---

## What this test does not cover

- The AI reply's content (only that it is non-empty).
- Providers other than OpenAI.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`; `OPENAI_API_KEY` set. A
  `providers.json` recording `openai` as `inactive` skips the test, but the file
  is **not** required — the gate fails open on its absence, so a targeted local
  run needs no `collect-models` first. Nothing here establishes that the key can
  actually complete; that gap is #1904.

---

## Notes

- dev46 migration (issue #818): removed the dead `enable`/`disableInspectPanel`
  calls (the inspect-panel toggle feature was removed upstream) and swapped
  `showsender_name` → `inspector-add-sender_name` on both Chat Input and Chat
  Output. Added id-scoped `afterEach` flow cleanup (the spec had none).
- Validated on `1.11.0.dev46` (2026-07-20): 3/3 green (~59s), `--workers=1
  --retries=0`, 0 orphan flows. Force-fail: breaking `inspector-add-sender_name`
  fails the custom-sender-name assertions.
- Promoted to `@stable` on `1.13.0.dev15` (2026-09-18, issue #1905). Re-measured
  for the promotion: burst **3/3 green** (13.0s / 12.2s / 13.3s), `--workers=1
  --retries=0`, no `🚨 Backend Error` and no provider-outage verdict; flow-leak
  audit **28 flows before → 28 after**, 0 orphans. Force-fail, both assertion
  groups, both coupled to what the product rendered rather than to the
  expectation itself: sending a different first-turn message reddens the
  default-label assertion on its text, and filling a different `sender_name`
  reddens the custom-label assertion with `element(s) not found`.
- The promotion was blocked once and the reason was the credential, not the spec:
  PR #1797 dropped it from Wave 8's T1 batch on a `429 insufficient_quota` and
  promised a follow-up that was never filed (#1905). The tag has never been on
  `main` before this commit — `git log -S "@stable"` over this file returns it
  alone — so 2026-09-10 is the date the spec lost its *owner*, not a date it left
  a lane it had been running in. The gate reading that let it run against a dead
  key is #1904.
