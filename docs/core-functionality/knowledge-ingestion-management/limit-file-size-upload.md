# File Size Limit on Playground Upload — §5.1 File Upload

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that the playground **rejects a file larger than the configured upload
limit** and tells the user the exact ceiling. The limit is driven by
`max_file_size_upload` from `GET /api/v1/config`; the check is enforced
**client-side** before any send, so an oversized file never reaches the backend.

The test mocks the config to a tiny limit (`0.001` MB ≈ 1.02 KB) and attempts to
upload a ~32 KB image — the UI must surface the size error with the computed
ceiling.

If this breaks, users can attach files that exceed the server limit — the upload
fails later (or silently), instead of being caught with a clear message up front.

---

## Tags *(required)*

`@stable` `@release` `@api` `@files`

`@api` — mocks `/api/v1/config`. `@files` — file upload surface.

---

## Step by step *(required)*

1. Mock `GET /api/v1/config` → `{ max_file_size_upload: 0.001 }` (≈ 1.02 KB)
2. Bootstrap the app (`awaitBootstrapTest`), open a **blank flow**, add a **Chat
   Input** component (the playground's file-upload affordance comes from Chat
   Input)
3. Open the playground (`playground-btn-flow-io`); wait for
   `input-chat-playground`
4. Set an oversized file (`tests/assets/media/chain.png`, ~32 KB) on the
   playground's `input[type="file"]`
5. Assert the error **"The file size is too large. Please select a file smaller
   than 1.02 KB."** is visible (ceiling = `max_file_size_upload * 1024`, 2 dp)

Every flow this page creates is captured from its `POST /api/v1/flows → 201`
response and deleted id-scoped in `afterEach`.

---

## Validation criterion *(required)*

- After setting an oversized file, the exact text **"The file size is too large.
  Please select a file smaller than 1.02 KB."** renders — the ceiling is computed
  from the mocked `max_file_size_upload`, so the assertion is tied to the config
  value, not a hardcoded string.

A mutated assertion (wrong ceiling, or expecting success) fails deterministically.

---

## External dependencies *(required)*

- `GET /api/v1/config` — mocked with a tiny `max_file_size_upload` (the surface
  under test).
- `data-testid="input_outputChat Input"` / `input_output_chat input_draggable` /
  `add-component-button-chat-input` / `sidebar-search-input` — add Chat Input.
- `data-testid="playground-btn-flow-io"` / `input-chat-playground` — open
  playground.
- `input[type="file"]` — the playground upload input.
- `tests/assets/media/chain.png` (~32 KB) — the oversized fixture.
- **No API key / no LLM** — the file is rejected client-side before any run, so
  no provider is exercised (the prior spec's OpenAI setup + `test.skip` on
  `OPENAI_API_KEY` were removed — see Notes).

---

## What this test does not cover *(optional)*

- Server-side enforcement of the size limit (this asserts the client-side guard).
- The Read File / Write File component upload path (covered by
  `upload-via-component.spec.ts`).
- Files at or just under the limit (only the over-limit rejection is asserted).

---

## Notes *(optional)*

- **Removed the OpenAI dependency (hardening for promotion).** The pre-promotion
  spec loaded the **Basic Prompting** template + `initialGPTsetup` (OpenAI model
  pinning) and guarded with `test.skip(!OPENAI_API_KEY)`. The file-size check is
  purely client-side (config-driven) and never runs the flow, so the model setup
  was unnecessary coupling — and the skip meant the `@stable` daily run would
  **silently skip** (blinding §5.1 coverage) whenever the OpenAI secret was
  absent. Redesigned to a blank flow + Chat Input: hermetic, no key, never skips.
  Confirmed live on 1.11.0.dev41 (message "smaller than 1.02 KB").
- **Flow cleanup.** ids captured from `POST /api/v1/flows → 201` (Pattern-A
  accumulator; `page.url()` races the bootstrap flow id — #490/#681) and deleted
  in `afterEach`. The prior spec left a Basic Prompting flow behind.
- **No inspect-panel toggling.** The prior spec disabled/enabled the inspect
  panel around advanced-options clicks that are irrelevant to the size check;
  the redesign drops them.
