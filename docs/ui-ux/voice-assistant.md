# UI/UX — Voice Assistant (PARKED)

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev15`)

> **Parked, not pending.** All three tests are `test.fixme` and run in no lane.
> The surface they assert — the playground's voice-assistant button and its
> settings popover — does not exist in the image this suite tests. The park is
> owned by issue **#1915**; the triage rows are
> `docs/triage/inherited-spec-triage.md` (T2, the three `ui-ux/voice-assistant.spec.ts`
> rows), filed as #1913.

---

## What this test validates *(required)*

The playground's **voice mode** affordance, in both directions:

- with `voice_mode_available: true` in `GET /api/v1/config`, the chat input shows a
  voice button, opens the voice-assistant container, and its settings popover exposes
  a microphone selector and a header;
- with `voice_mode_available: false`, no voice button is rendered at all.

If this broke, a user on an instance with voice mode enabled would have no way to
start a voice conversation from the playground.

**As of `1.13.0.dev15` it validates none of that, and cannot.** See *Why it is parked*.

---

## Tags *(required)*

`@release` `@workspace` `@api`

`@stable` is **absent deliberately**: the three tests are `test.fixme` pending
**#1915**. Promoting any of them would put a test that cannot pass — or, for one of
them, a test that cannot fail — into the daily.

---

## Step by step *(required)*

1. Intercept `**/api/v1/config` and fulfill it with `{ voice_mode_available: <true|false> }`
2. Bootstrap the app
3. Open the templates side-nav and pick the **Basic Prompting** template
4. Open the playground (`playground-btn-flow-io`)
5. Assert `voice-button` is visible (`true` cases) or absent (the `false` case)
6. For the full interaction test: click the voice button, fill the OpenAI key if the
   settings popover asks for one, then assert the voice-assistant container, its
   settings icon, the microphone select and the modal header — and that closing it
   restores the plain chat input

---

## Validation criterion *(required)*

- `voice-button` is visible when the config reports voice mode available, and absent
  when it does not
- `voice-assistant-container` opens on click
- `voice-assistant-settings-modal-microphone-select` and
  `voice-assistant-settings-modal-header` are visible inside the settings popover
- closing the assistant restores `input-wrapper`

---

## Why it is parked *(the measurement, `1.13.0.dev15`)*

**The voice-assistant entry point is not in the shipped frontend.** Measured two
independent ways on the running nightly:

1. **The served bundle.** `index.html` references a single JS asset and no lazy
   chunks. Grepped for the literals the spec targets: `voice-button` **0**,
   `voice_mode_available` **0**, `voice-assistant` **0**. For contrast, in the same
   file `playground-btn-flow-io` is present, `data-testid` occurs 649 times, and
   `input-wrapper` is present — so testids are not stripped and the absence is real.
2. **The live DOM.** With `voice_mode_available: true` mocked and the route
   confirmed to fire once, the open playground reports `voice-button` **0**,
   `voice-assistant-container` **0**, `audio-button` **1**, `input-wrapper` **1**.

The cause is a component swap, not a feature flag. `ENABLE_VOICE_ASSISTANT` is still
`true` in `customization/feature-flags.ts`, and the **old** chat input
(`modals/IOModal/.../chatInput/components/input-wrapper.tsx`) still gates a
`VoiceButton` on it. The shipped playground renders the **new** chat input
(`components/core/playgroundComponent/chat-view/chat-input/components/input-wrapper.tsx`),
whose button row holds an `AudioButton` (`data-testid="audio-button"`, browser
speech-to-text) and no voice button at all. The voice store, the i18n strings and
`api/v1/voice_mode.py` all still ship; only the way in is gone.

**The one row measured `3/3 green` is the finding, not the promotion candidate.**
`user should not be able to see voice button if voice mode is not available` asserts
`not.toBeVisible()` on an element that cannot exist under **any** config value, so it
passes for a reason unrelated to its subject. Both mutations were executed rather than
argued: with the mock inverted to `true` it passes (5.2 s), and with the route mock
deleted outright it passes (5.0 s). It is not falsifiable on this image, and is parked
with its two siblings rather than promoted.

`audio-button` — the surface that replaced it — is covered by no spec today. That gap
is named in #1915; closing it is not this file's job.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/input-wrapper.tsx` — the chat-input row the shipped playground renders; it is what decides whether any voice affordance exists
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/audio-button.tsx` — the `audio-button` that took the voice button's place
- `src/frontend/src/modals/IOModal/components/chatView/chatInput/components/input-wrapper.tsx` — the older chat input that still gates `VoiceButton` on `ENABLE_VOICE_ASSISTANT && config.voice_mode_available`; if the playground is pointed back at it, this spec becomes runnable again
- `src/frontend/src/modals/IOModal/components/chatView/chatInput/components/voice-assistant/components/voice-button.tsx` — owns the `voice-button` testid the spec waits for
- `src/frontend/src/customization/feature-flags.ts` — `ENABLE_VOICE_ASSISTANT`, the build-time half of the gate
- `src/backend/base/langflow/api/v1/schemas/__init__.py` — declares `voice_mode_available` on the config response the spec mocks
- `src/backend/base/langflow/api/v1/voice_mode.py` — the voice websocket route behind the feature

---

## What this test does not cover *(optional)*

- `audio-button`, the speech-to-text control the playground ships instead — no spec asserts it
- the voice websocket itself (`/api/v1/voice/ws/...`): the spec never reaches a call
- ElevenLabs voice selection inside the settings popover

---

## Preconditions *(optional)*

- An instance whose playground renders the voice-assistant chat input. No release
  line the nightly is cut from does today.
- `OPENAI_API_KEY`, for the interaction test only.

---

## When to review this test *(optional)*

- The playground chat input is refactored again, or `voice-button` reappears in the
  served bundle — check with a grep of the asset `index.html` references
- `#1915` is closed
