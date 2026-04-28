# Spec: Playground Output – Image Upload

**Test file:** `tests/tests-automations/regression/core-functionality/playground/playground-output-image.spec.ts`

## What this test validates

Verifies that the Playground correctly handles image uploads via the chat input:

1. After attaching an image, a compact preview appears in the input area before sending.
2. After sending the message, the image is rendered in the user message bubble in the chat history.

## Tags

`@stable` `@regression` `@playground`

## Validation criterion

| Test | Criterion |
|---|---|
| Compact preview in input | `img[alt="chain.png"]` visible inside `[data-testid="input-wrapper"]` after `setInputFiles()` |
| Image rendered in user message | `img[src*="/files/images/"]` visible after sending and bot response — the server prefixes the filename with a timestamp, so the selector uses `src` instead of `alt` |

## External dependencies

None. The flow uses only ChatInput → ChatOutput (echo) — no API key or LLM is required.

## Last validated

1.10.x
