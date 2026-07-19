# Spec: Send an Image on Chat via the Chat Input Advanced `files` Field

**Test file:** `tests/tests-automations/regression/flow-functionality/general-bugs-shard-3836.spec.ts`

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev46`)

---

## What this test validates

Regression test covering the end-to-end image-upload path through the **Chat Input** component's advanced `files` field. The user adds the advanced `files` input to the Chat Input node, uploads an image, removes and re-uploads it, runs the flow, and confirms the image and the user message render in the Playground.

The contract under test:

1. The advanced `files` field can be added to the Chat Input node body from the node inspector.
2. An uploaded file (`chain.png`) shows on the upload button and can be removed (hovering reveals the `icon-X`, clicking removes it — the filename disappears).
3. After re-uploading and running the flow, the Playground shows the uploaded image (`img[alt$="chain.png"]`) and the user message (`chat-message-User-<question>`).

### dev46 node-inspector model

The dev46 nightly replaced the old "Controls" edit modal with a node inspector side-panel: `openAdvancedOptions` opens it via `parameters-button`, and the advanced `files` field is added to the node body with `inspector-add-files` (the modern equivalent of the old `showfiles` toggle). `closeAdvancedOptions` closes it via `inspection-panel-close`.

---

## Tags

`@release` `@components`

---

## Step by step

1. Bootstrap; open the **Basic Prompting** starter template and run `initialGPTsetup` (configures the OpenAI provider/model).
2. Select the **Chat Input** node, open the inspector, click `inspector-add-files` to add the advanced `files` field to the node body, then close the inspector.
3. Fill the chat input text with the question `"What is this image?"`.
4. Upload `chain.png`; hover the upload button, assert the `icon-X` is fully opaque, click it, and assert the filename is no longer visible (removal works).
5. Re-upload `chain.png`.
6. Run the Chat Output component and open the Playground.
7. Assert the uploaded image (`img[alt$="chain.png"]`) is visible and the user message (`chat-message-User-What is this image?`) is present.

---

## Validation criterion

| Step | Criterion |
|---|---|
| After adding `files` to the node body | The Chat Input file upload widget is available (upload succeeds) |
| After removing the uploaded file | `chain.png` text is no longer visible |
| After running the flow | Playground shows `img[alt$="chain.png"]` visible |
| After running the flow | `chat-message-User-What is this image?` is present |

---

## External dependencies

- **OpenAI** — `test.skip` when `OPENAI_API_KEY` is absent. Runs the Basic Prompting flow through an OpenAI model (`initialGPTsetup`).
- `src/backend/base/langflow/components/input_output/chat.py` — Chat Input component; the advanced `files` field must exist as an addable inspector field for step 2 to find `inspector-add-files`.
- `tests/assets/media/chain.png` — the uploaded test image.
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions` / `closeAdvancedOptions` (the inspector panel).
- `tests/helpers/other/initialGPTsetup.ts` — provider/model setup on the template.

---

## What this test does not cover

- Non-image file uploads.
- The multimodal model's actual answer content (only that the image + user message render).
- Providers other than OpenAI.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `OPENAI_API_KEY` set (otherwise the test skips).

---

## Notes

- Migrated to the dev46 node-inspector model (issue #818): swapped `showfiles` → `inspector-add-files`.
- Added id-scoped `afterEach` flow cleanup (POST `/api/v1/flows` → 201 tracking), per repo convention (#490/#681) — the spec builds a flow from the Basic Prompting template.
- Validated on `1.11.0.dev46` (2026-07-19): 1 passed (~24s), `--workers=1 --retries=0`, 0 orphan flows.
