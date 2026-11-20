# Templates — Image Sentiment Analysis runs an attached image through a vision model (§11.3)

**File:** `tests/tests-automations/regression/core-functionality/templates/templates-run-image-input.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev29`, `langflowai/langflow-nightly:latest`,
measured 2026-11-16)

Owning issue: #2460 (row **E2** of the planned spec inventory in
`docs/core-functionality/templates/templates-coverage-scope.md`, the #1860 scoping pass) ·
**Siblings:** #2459 (`templates-run-prompts.spec.ts`, **E1**, the rest of §11.3), #2461
(`templates-run-file-input.spec.ts`, **E3**) and #2045 (`templates-run-knowledge.spec.ts`,
**E4**) — the same run shape, sharing `tests/helpers/flows/template-run.ts` (#2467) ·
**Related:** #1452 (`page.flowErrorReport()`), #1372 / #1678 (a run can silently carry a model
nobody picked), #2416 (the Playground attachment tile, renamed by `langflow-ai/langflow#16277`),
#1187 (model tiers), #1864 (**S1**, instantiation)

---

## What this test validates *(required)*

The last template of QA-CHECKLIST §11.3, **Image Sentiment Analysis**, **executes** on an image
attached in the Playground, and the image reaches the vision model the test pinned. One test,
literal title:

- **should run Image Sentiment Analysis on an attached image through its pinned vision model**
  — Chat Input → Language Model (`input_value`) → Chat Output. Three components and a note.

The template's Language Model ships with `model.value: ""` and eight options starting at
`gpt-5.5-pro`; its system prompt asks for a sentiment (Positive / Negative / Neutral) and a
one-sentence description. The template's description says the Language Model "receives the
image natively, so the model actually sees it" — which is what this spec measures.

The test:

1. **Resolves the one model it runs** — `resolveGptModel()` (`gpt-4o-mini` here) and its option
   from `GET /api/v1/model_options/language`, as the siblings do.
2. **Creates the flow from the template as the image registers it** — the entry of
   `GET /api/v1/flows/basic_examples/`, created with `POST /api/v1/flows/` under a unique name,
   after checking the shape the assertions are keyed on (one Language Model, one Chat Input, one
   Chat Output, and a Chat Input → Language Model `input_value` edge). The only field it sets is
   the Language Model's `model`.
3. **Runs it the way a user does** — opens `/flow/{id}` and the Playground, attaches
   `tests/assets/media/chain.png` (512 × 512) through the chat input's own file input (the
   Playground uploads it with `POST /api/v1/files/upload/{flow_id}`), types *"Classify the
   sentiment of this image."* and clicks send. The text is there so the Chat Input has an output
   to inspect: with an image and no text, its output-inspection control stayed disabled after
   the run (measured), which would leave its build unproven.
4. **Sends a control turn** — the same text again in the same session, with no attachment.
5. **Reads the observables** under *Validation criterion*.

### How the spec proves the image reached the model

A reply alone proves nothing: a model answers a text-only message too — and on the control turn
`gpt-4o-mini` did, describing "a blank canvas". Neither does the run request: it shows the page
sent the file, not that the model got it.

The proof is the **input token count the provider reported**. The run stores it on the AI message
(`properties.usage.input_tokens`, read through `GET /api/v1/monitor/messages?flow_id=`), and an
image is billed as input tokens. Measured on `1.14.0.dev29`, the same flow, the same text, the
same session:

| Turn | Run request `files` | Stored user message `files` | `input_tokens` |
|---|---|---|---|
| image | `["flow-<id>/<timestamp>_chain.png"]` | the same path | **8600** |
| control | absent | `[]` | **100** |

With no text at all the counts were 8592 and 92 — the same difference.

The difference, 8500, is exactly what OpenAI bills `gpt-4o-mini` for an image that fits in one
tile (2833 base + 5667 for the tile). The count is the provider's accounting of what it received,
not something the model chooses to say.

The spec asserts the difference is at least **50**. Without the image the two turns are identical
requests, and they differ by 0 (measured: two image-less turns, 92 and 92). With one, every OpenAI vision model bills at
least its base charge, and the smallest documented base is 70 tokens (the gpt-5 family at low
detail; `gpt-4o` is 85). It does not assert 8500, which would tie the spec to one model's billing.

### What it is **not**

- **Not the model's wording or its sentiment verdict.** Neither reply is read beyond "not
  empty".
- **Not the attachment UI.** Previews, deleting a tile and non-image attachments are
  `core-functionality/playground/playground-attachments-management.spec.ts`,
  `playground-output-image.spec.ts` and `playground-non-image-attachment.spec.ts`. Here the
  attachment is only the input.
- **Not instantiation** — S1's contract, as for the siblings.

---

## Tags *(required)*

`@stable` `@release` `@templates` `@playground`.

- `@templates` is the area and `@playground` the surface the run is driven from — the scope doc's
  tag rule for execution specs. No `@agents`: the model node is a Language Model, not an Agent.
- `@release`: a starter template a user picks to try image input; a happy path that must work
  before a deploy.
- `@stable` from the first PR (`CONTRIBUTING.md` → *Tag @stable*): no lane selector, no known
  product defect, and no assertion that depends on what the model decides to say.

---

## Validation criterion *(required)*

The test passes only when all of the following hold, in this order:

1. **The image run carried the attachment and the pinned model.** The Playground's
   `POST /api/v2/workflows` request is captured; its `files` must equal the `file_path` the
   upload returned, its `input_value` the typed text, its live-canvas `data` must carry `gpt-4o-mini` / `OpenAI` on the Language
   Model (#1372, #1678), and its `edges` must still wire the Chat Input into the Language Model's
   `input_value`.
2. **Both turns replied.** One AI message (`[data-testid^="chat-message-AI-"]`) after the image
   turn and two after the control turn, each neither blank nor the *"Message empty."*
   placeholder. The control turn's run request carries the same text and no `files`.
3. **The image reached the model.** The two AI messages stored for the flow, in time order, carry
   `properties.usage.input_tokens`; the image turn's count minus the control turn's is **≥ 50**
   (see above). A message with no `usage` fails naming it, since that would leave the check with
   nothing to read.
4. **The backend stored the image on the user's message.** The image turn's stored user message
   lists the uploaded `file_path` in its `files`; the control turn's lists none.
5. **Every component built.** The output-inspection controls of Chat Input, Language Model and
   Chat Output are disabled before the first send (after the editor finishes loading,
   `canvas_controls_dropdown`, up to 60 s) and enabled after the replies.
6. **The flow-error report is evaluated and clean** — `evaluated > 0` and `clean` (#1452).

**What would turn it red.** An attachment the page does not send (1); a run that drops it on the
way to the provider, or a model that cannot take images (3); a silently swapped model (1); a
model that errors (2, 6); a lost edge or a component that does not build (1, 5); a backend that
loses the attachment from the message history (4).

**Force-fails** (run on `1.14.0.dev29` with `--retries=0`, each red at the step named, then
reverted):

| Mutation | Red at |
|---|---|
| A `page.route` on `POST /api/v2/workflows` that removes `files` from the image turn's body before it leaves the browser — the attachment removed from the request, as #2460 asks | step 3: *"input tokens: image turn 100, control turn 100"*, expected ≥ 50, received 0. Step 1 still passed: the page did send the file, and only the token count showed it never reached the model. |
| The cleanup's attachment `DELETE` no-opped | teardown: *"attachments left behind: …_chain.png"* — and on disk, that run's `flow-<id>/` was the only one holding a file |

**Cleanup** (#515, #553): `afterEach` leaves the editor (`unmountEditorForCleanup`), lists the
flow's attachments (`GET /api/v1/files/list/{flow_id}`), deletes each one
(`DELETE /api/v1/files/delete/{flow_id}/{name}`), checks the list is empty, and then deletes the
flow by id. The attachments go first because deleting the flow does **not** delete them, and the
file routes need the flow to exist: measured, after a flow delete its attachment stayed on disk
under `flow-<id>/` and no route could reach it. The stored messages go with the flow (measured: 0
left). Deleting the attachment leaves its now empty `flow-<id>/` directory behind; nothing in it
is test data.

**Parallel-safe, no serial mode.** The flow carries a nonce in its name, the attachment lives in
the flow's own storage, and every locator is scoped to the test's own node ids or to the
Playground.

---

## External dependencies *(required)*

- **OpenAI**, gated by `providerSkipGate("openai")`; the key is the `OPENAI_API_KEY` global
  variable `collect-models` imports. The pinned model is `resolveGptModel()` and its option comes
  from `GET /api/v1/model_options/language`; a missing catalog or a model that is not enabled fails
  naming `collect-models`.
- **Why `gpt-4o-mini` is the right model.** OpenAI documents it as taking text and image input.
  `resolveGptModel()` prefers it, then `gpt-4o` and `gpt-4.1`, all vision models. No Langflow
  surface states vision support for OpenAI models: the model options carry no capability field,
  and the `vision` flag in `lfx`'s models.dev catalog is not applied to the OpenAI constants. So
  step 3 also serves as the capability check: a model that cannot take the image either errors
  (steps 2 and 6) or bills nothing for it (step 3).
- **Tier (#1187): not routable.** The assertion is plumbing, not model quality, which would make
  it `any-completion` — but it needs a **vision** model, and the keyless model that tier is routed
  to (`ollama-e2e`'s `llama3.2:1b`) takes text only. The spec therefore does not go through
  `resolveTestTargets()` at all, as for the siblings: one OpenAI model, no `MODEL_TEST_*` pin, no
  daily rotation.
- **Cost** per run: two `gpt-4o-mini` calls, ~8.7k input tokens in all — about a tenth of a cent.
  **Runtime** (send → reply, measured): ~2 s per turn.
- **Fixture:** `tests/assets/media/chain.png` (512 × 512, 32 KB), the image the Playground image
  specs attach.
- **Routes** (all `/api/v1` unless noted): `flows/basic_examples/`; `flows` create/delete;
  `model_options/language`; `files/upload/{flow_id}`, `files/list/{flow_id}`,
  `files/delete/{flow_id}/{name}`; `monitor/messages`; and `POST /api/v2/workflows`, the
  Playground run.
- **Upstream source** the assertions derive from: the template,
  `src/backend/base/langflow/initial_setup/starter_projects/Image Sentiment Analysis.json`; the
  Language Model component, `src/lfx/src/lfx/components/models_and_agents/language_model.py`, and
  its base `src/lfx/src/lfx/base/models/model.py` (which records the reply's token usage); the
  message schema, `src/lfx/src/lfx/schema/message.py` (an image file becomes image content for the
  model) and `src/lfx/src/lfx/schema/token_usage.py`; the attachment routes,
  `src/backend/base/langflow/api/v1/files.py`; the message listing,
  `src/backend/base/langflow/api/v1/monitor.py`; the options listing,
  `src/backend/base/langflow/api/v1/model_options.py`; and the run request's `files` and `data`,
  `src/backend/base/langflow/api/v2/workflow.py`.

---

## Notes

### Measured on `1.14.0.dev29` (scout, 2026-11-16)

- The Playground's chat input has no prefilled text for this template, and a send with only an
  attachment runs the flow — but then the Chat Input's output-inspection control stays disabled
  after both turns (its message has no text to show), while the Language Model's and the Chat
  Output's turn enabled. With text, all three turn enabled. The attachment tile reads *"Delete chain.png"* (the
  `langflow-ai/langflow#16277` label, #2416) and clears after the send, so the second send carries
  no attachment.
- The upload answers `201` with `{flowId, file_path: "flow-<id>/<timestamp>_chain.png"}`; that
  `file_path` is what the run request's `files` and the stored user message carry.
- The Language Model keeps no history (no Memory component), so the control turn's input tokens
  equal a first turn without an image — measured both as a first turn and as a second (92 each,
  with no text).
- Replies, for the record and never asserted: *"Sentiment: Neutral, Description: An illustration
  of two chains, each consisting of interconnected links."* with the image; *"…The image shows a
  blank canvas with no visible content."* without it.

### Validation runs (`1.14.0.dev29`, 2026-11-16, `--workers=1 --retries=0`)

- One run, then a `--repeat-each=5` burst **5/5** (10–11 s each), then — after the force-fails
  were reverted — a `--repeat-each=3` burst **3/3** (~10 s each).
- Zero `🚨 Backend Error`. After every run: zero flows, zero files and no attachment left in the
  instance's `flow-*` storage.
- The first run went red on the Chat Input's build check: with no text, its output-inspection
  control stays disabled (see *Measured* below). The spec now types a text on both turns.
