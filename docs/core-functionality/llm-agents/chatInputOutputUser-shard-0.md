# Spec: Send an Image on Chat via the Playground File Upload

**Test file:** `tests/tests-automations/regression/core-functionality/llm-agents/chatInputOutputUser-shard-0.spec.ts`

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev46`)

---

## What this test validates

End-to-end image-upload path through the **Playground** chat: with a Basic Prompting flow loaded, the user opens the Playground, uploads an image via the chat file input, sends it, and confirms the image renders in the chat messages.

The contract under test:

1. The Chat Input inspector panel opens and closes cleanly (dev46 node-inspector model) without disturbing the flow.
2. The Playground exposes a file input that accepts an image (`chain.png`) and shows its preview before sending.
3. After sending, the uploaded image renders in the chat messages (`img[alt$="chain.png"]` — the server prefixes the filename with a timestamp).

---

## Tags

`@release` `@workspace` `@components`

---

## Step by step

1. Bootstrap; open the **Basic Prompting** starter template and wait for the canvas controls.
2. Run `initialGPTsetup` (configures the OpenAI provider/model).
3. Select the **Chat Input** node, open the inspector panel (`parameters-button`) and close it (`inspection-panel-close`) — verifies the dev46 inspector opens/closes without breaking the flow.
4. Open the Playground and wait for the chat input.
5. Upload `chain.png` via the hidden file input; wait for the `img[alt="chain.png"]` preview.
6. Click **Send**.
7. Assert the image (`img[alt$="chain.png"]`) is visible in the chat messages.

---

## Validation criterion

| Step | Criterion |
|---|---|
| After opening/closing the inspector | The Playground opens and the chat file input is available |
| After uploading the image | `img[alt="chain.png"]` preview is visible before sending |
| After sending | `img[alt$="chain.png"]` is visible in the chat messages |

---

## External dependencies

- **OpenAI** — `test.skip` when `OPENAI_API_KEY` is absent. Runs the Basic Prompting flow through an OpenAI model (`initialGPTsetup`).
- `tests/assets/media/chain.png` — the uploaded test image.
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions` / `closeAdvancedOptions` (the dev46 inspector panel via `parameters-button` / `inspection-panel-close`).
- `tests/helpers/other/initialGPTsetup.ts` — provider/model setup on the template.
- `tests/helpers/filesystem/resolve-asset-path.ts` — resolves the image path.

---

## What this test does not cover

- Non-image uploads.
- The model's actual answer content (only that the uploaded image renders).
- Providers other than OpenAI.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `OPENAI_API_KEY` set (otherwise the test skips).

---

## Notes

- No testid rename was needed for issue #818 — the spec only calls `openAdvancedOptions` / `closeAdvancedOptions`, which the shared helper already migrated to the dev46 inspector model. This spec is verified green on dev46 to confirm the migrated helper works here.
- Added id-scoped `afterEach` flow cleanup (POST `/api/v1/flows` → 201 tracking), per repo convention (#490/#681) — the spec builds a flow from the Basic Prompting template.
- Validated on `1.11.0.dev46` (2026-07-19): 1 passed (~1.4m), `--workers=1 --retries=0`, 0 orphan flows.
