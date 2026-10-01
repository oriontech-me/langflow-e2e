# Playground — Audio input (speech-to-text button)

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev29`, #2132)

---

## What this test validates *(required)*

The **editor playground's `audio-button`**: the microphone control in the chat input
that dictates text through the browser's speech recognition. It replaced the
voice-assistant button in the new chat input (the voice button survives only on the
public playground — `docs/ui-ux/voice-assistant.md`, #1915), and until #2132 no spec
asserted it.

Four behaviours, all of them the control's contract with the user:

1. in a browser with **no** speech recognition API the button is disabled and says
   so (`aria-label` "Voice input not supported in this browser");
2. a click **starts** recognition (`aria-pressed=true`, "Stop recording"), and a
   second click stops it and returns to idle;
3. the **final** transcript is **appended** to whatever the input already holds,
   separated by a space — interim results are not;
4. stopping with **no speech** raises the "Voice Input Error" alert and leaves the
   input untouched.

If this broke, a user dictating into the playground would lose the text, see it
replace what they had typed, or get no feedback when nothing was heard.

### Why the browser API is stubbed

Recognition is entirely client-side: `hooks/use-audio-recording.ts` instantiates
`window.SpeechRecognition ?? window.webkitSpeechRecognition` and reads its events —
no backend call. Chromium exposes the API, but a headless run has no microphone and
no access to the recognition service, so the real one can never deliver a
transcript. The tests therefore install a minimal fake with `page.addInitScript`
before the page loads: `start()` fires `onstart`, `stop()` fires `onend`, and a page
helper fires `onresult` with a chosen transcript and `isFinal` flag. That is the
exact surface the hook consumes, so the assertions cover the hook and the button, not
the fake. Test 1 instead **removes** the API, which is the unsupported-browser path.

Measured on `1.13.0.dev29` while scouting (editor playground, Basic Prompting):

| Scenario | `aria-label` | `aria-pressed` | disabled | input |
|---|---|---|---|---|
| native Chromium (API present) | Voice input | false | no | — |
| API removed | Voice input not supported in this browser | false | **yes** | — |
| stub, idle | Voice input | false | no | — |
| stub, after click | Stop recording | **true** | no | — |
| stub, final result + stop | Voice input | false | no | `"Hello hello from the stub"` (appended to the pre-filled `Hello`) |
| stub, stop with no result | — | — | — | unchanged; alert "Voice Input Error / No speech was detected. Please try again." |

---

## Tags *(required)*

`@stable` `@release` `@playground`

---

## Step by step *(required)*

Common setup, per test:

1. Install the init script — the fake recognition, or (test 1) the API removal
2. Create a flow from the **Basic Prompting** starter over the API and keep its id
3. Open `/flow/{id}`, click `playground-btn-flow-io`, wait for `audio-button`

**Test 1 — the button is disabled in a browser without speech recognition**

4. Assert `audio-button` is disabled and its `aria-label` is
   "Voice input not supported in this browser"

**Test 2 — a click starts recognition and a second click stops it**

4. Assert idle: `aria-label` "Voice input", `aria-pressed="false"`
5. Click; assert `aria-pressed="true"`, `aria-label` "Stop recording", and that the
   fake's `start()` ran exactly once
6. Emit one final result, then click again; assert back to `aria-pressed="false"` /
   "Voice input". The result is there so the stop takes the transcript path: a stop
   with nothing heard is test 4's error path, and would raise its alert here

**Test 3 — the final transcript is appended to the text already typed**

4. Fill `input-chat-playground` with `existing text` (replacing the Input Text
   pre-fill, so the expected value is the test's own)
5. Click `audio-button`; wait for `aria-pressed="true"`
6. Emit an **interim** result (`isFinal: false`) and then a **final** one, each with a
   distinct per-run token
7. Click `audio-button` to stop
8. Assert the input value is exactly `existing text <final token>` — so the interim
   token is absent and the text was appended with one space, not replaced

**Test 4 — stopping with no speech shows the error and leaves the input alone**

4. Fill the input with `untouched text`
5. Click `audio-button`, wait for `aria-pressed="true"`, click again without emitting
6. Assert the alert text "Voice Input Error" and
   "No speech was detected. Please try again." are visible, the input still reads
   `untouched text`, and the button is back to idle

Cleanup: `deleteFlow` on the created id in `afterEach`, authenticated.

---

## Validation criterion *(required)*

- unsupported browser → `audio-button` disabled, with the not-supported label
- click → `aria-pressed="true"` and recognition started once; second click → idle
- final transcript appended to existing text with one space; interim result ignored
- no speech → "Voice Input Error" / "No speech was detected" alert, input unchanged

---

## Guarding against false positives *(how)*

- Test 3's expected value is exact, built from per-run tokens: a transcript that
  replaced the text, an interim result that leaked in, or nothing landing at all each
  fail it.
- Test 2 asserts the fake's `start()` count, so a button that toggled its own state
  without starting recognition fails.
- The alert in test 4 has no testid and is located by its text; the browser locale is
  pinned to `en-US` (`tests/fixtures/locale.ts`).

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/audio-button.tsx` — the `audio-button` testid, its disabled/`aria-label`/`aria-pressed` states
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/hooks/use-audio-recording.ts` — the speech recognition lifecycle: `isSupported`, final-only accumulation, the no-speech error on `onend`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/chat-input.tsx` — `handleTranscriptionComplete` (append with a space) and `handleAudioError` (the alert)
- `src/frontend/src/locales/en.json` — the `chat.voiceInput*`, `chat.stopRecording`, `chat.noSpeechDetected` strings the labels and alert carry

---

## What this test does not cover *(optional)*

- real speech recognition (microphone + recognition service) — not reachable headless
- the other recognition errors (`not-allowed`, `audio-capture`, `network`), which map
  to their own messages in the hook
- the button being disabled while the flow is building

---

## Preconditions *(optional)*

- None. No provider key: nothing is sent.

---

## When to review this test *(optional)*

- The chat input stops using the browser speech recognition API (e.g. moves to a
  backend transcription endpoint) — the stub would then test nothing
- The voice-input strings are reworded
