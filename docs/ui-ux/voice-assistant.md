# UI/UX — Voice Assistant (public playground)

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev29`, #1915)

---

## What this test validates *(required)*

The **voice mode** affordance of the **public (shareable) playground**,
`/playground/:id`, in both directions:

- with `voice_mode_available: true` in `GET /api/v1/config`, the chat input shows a
  voice button, and clicking it opens the voice-assistant container with its
  settings popover asking for the OpenAI key; cancelling the popover and closing the
  assistant restores the plain chat input;
- with `voice_mode_available: false`, no voice button is rendered at all.

If this broke, a visitor of a shared flow on an instance with voice mode enabled
would have no way to start a voice conversation — or would see a voice control on an
instance that cannot serve it.

### Where the surface lives — and why #1915 first read it as gone

The two playgrounds render **different chat inputs**, and only one carries voice:

| Surface | Chat input | Voice control |
|---|---|---|
| Editor playground (`playground-btn-flow-io`) | `components/core/playgroundComponent/chat-view/chat-input` | none — an `audio-button` (browser speech-to-text) instead |
| Public playground (`/playground/:id`) | the older `modals/IOModal/.../chatInput` | `voice-button`, gated on `voice_mode_available` |

Measured on `1.13.0.dev29`, with the config mock confirmed to fire:

| Surface | `voice_mode_available` | `voice-button` | `audio-button` |
|---|---|---|---|
| public | `true` | **1** | 0 |
| public | `false` | 0 | 0 |
| editor | `true` | 0 | **1** |
| editor | `false` | 0 | 1 |

The park recorded on `1.13.0.dev15` (all three tests `test.fixme`) measured only the
editor playground, and grepped only the asset `index.html` references. The public
page is a `lazy()` route, so its chunk is loaded dynamically and never named in
`index.html`: across all 1,864 served JS chunks, `voice-button` and
`voice_mode_available` occur in exactly one (the public playground's), and
`audio-button` in a different one. The entry point never left the product.

### What `voice_mode_available` really reports

`Settings.voice_mode_available` is `True` only when the backend can import both
`openai` and `webrtcvad`. The nightly ships `openai` and not `webrtcvad`, so the
**real** config reports `false` on every lane and the button is hidden for real
visitors. The tests therefore mock the flag — merged into the real config response,
never replacing it — which is a test of the frontend gate, not of a working voice
backend.

---

## Tags *(required)*

`@stable` `@release` `@playground`

`@playground` is the functional area (the shareable playground). The previous
`@workspace` / `@api` tags described neither: nothing here manages flows through the
workspace UI, and the only API calls are setup.

---

## Step by step *(required)*

Common setup, per test:

1. Create a flow from the **Basic Prompting** starter over the API
   (`createFlowFromStarter`) and keep its id
2. `PATCH /api/v1/flows/{id}` with `access_type: "PUBLIC"` — assert 2xx, or the
   public route would not serve it
3. Route `**/api/v1/config`: fetch the real response and fulfill it with
   `voice_mode_available` overridden; count how many times the route fired
4. Open `/playground/{id}/` and wait for the chat input (`input-wrapper`) **and**
   `button-send` — the load signal that makes an absence assertion meaningful
5. Assert the config route fired at least once (the mock was in effect)

**Test 1 — the voice assistant opens and closes from the public playground**
(`voice_mode_available: true`)

6. Click `voice-button`
7. Assert `voice-assistant-container` is visible, together with the settings popover:
   `voice-assistant-settings-modal-header` and the OpenAI key field
   `popover-anchor-openai-api-key` (no key is stored, so the popover asks for one)
8. Press **Escape**; assert the popover header is gone. Not the popover's **Cancel**
   button: upstream it only leaves key-editing mode (`setIsEditingOpenAIKey(false)` in
   `audio-settings-dialog.tsx`) and the popover stays open while no key is stored —
   measured, the first draft of this step clicked Cancel and the header stayed visible
9. Click `voice-assistant-close-button`; assert the container is gone and
   `input-wrapper` is visible again

**Test 2 — the voice button is shown when voice mode is available**
(`voice_mode_available: true`): assert `voice-button` is visible.

**Test 3 — the voice button is absent when voice mode is not available**
(`voice_mode_available: false`): after the load signal, assert `voice-button` has
count 0.

Cleanup: `deleteFlow` on the created id in `afterEach`, authenticated with the same bearer the setup used, after
`page.unrouteAll({ behavior: "ignoreErrors" })` so the config mock cannot fire on a
closing page.

---

## Validation criterion *(required)*

- `voice-button` is visible on the public playground when the config reports voice
  mode available, and has count 0 when it does not — the same page, the same load
  signal, only the flag differs, so either assertion fails if the gate inverts
- clicking it opens `voice-assistant-container` with the settings popover
  (`voice-assistant-settings-modal-header`, `popover-anchor-openai-api-key`)
- dismissing the popover (Escape) removes its header; closing the assistant removes
  the container and restores `input-wrapper`

---

## Guarding against false positives *(how)*

- Test 3 asserts absence **only after** `input-wrapper` and `button-send` render, so
  an unloaded page cannot pass it, and on the public surface — where the button does
  render under `true` — inverting the mock turns it red. Both are force-failed.
- Every test asserts the config route fired, so a mock that silently stopped
  matching cannot leave the real `false` doing the work for test 3.
- The flow is the test's own (created per test, id-scoped delete); a neighbour
  worker's flow can neither be shown nor removed.

---

## External dependencies *(required)*

- `src/frontend/src/pages/Playground/index.tsx` — the public `/playground/:id` page; it mounts `CustomIOModal`, i.e. the older chat input that carries the voice button
- `src/frontend/src/customization/components/custom-new-modal.tsx` — maps `CustomIOModal` to `modals/IOModal/playground-modal`
- `src/frontend/src/modals/IOModal/components/chatView/chatInput/components/input-wrapper.tsx` — gates `VoiceButton` on `ENABLE_VOICE_ASSISTANT && config.voice_mode_available`
- `src/frontend/src/modals/IOModal/components/chatView/chatInput/components/voice-assistant/components/voice-button.tsx` — owns the `voice-button` testid
- `src/frontend/src/modals/IOModal/components/chatView/chatInput/components/voice-assistant/components/audio-settings/audio-settings-dialog.tsx` — the settings popover: its header, the OpenAI key field, and a Cancel that does not close it
- `src/frontend/src/customization/feature-flags.ts` — `ENABLE_VOICE_ASSISTANT`, the build-time half of the gate
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/input-wrapper.tsx` — the editor playground's chat input, which has no voice button (an `audio-button` instead)
- `src/lfx/src/lfx/services/settings/base.py` — `voice_mode_available`, true only when `openai` and `webrtcvad` import
- `src/backend/base/langflow/api/v1/schemas/__init__.py` — declares `voice_mode_available` on the config response the spec mocks

---

## What this test does not cover *(optional)*

- a real voice conversation: the nightly has no `webrtcvad`, so the voice websocket
  (`/api/v1/voice/ws/...`) cannot serve, and the tests never store an OpenAI key
- the microphone selector inside the settings popover, which renders only once a key
  is stored — storing one would leave a global variable behind
- `audio-button`, the editor playground's speech-to-text control — tracked separately
- ElevenLabs voice selection

---

## Preconditions *(optional)*

- No provider key: nothing here calls a model.

---

## When to review this test *(optional)*

- The public playground is moved onto the new chat input — the voice button would
  then disappear from it too, and these tests go red by design
- The image starts shipping `webrtcvad` (real `voice_mode_available` becomes `true`)
