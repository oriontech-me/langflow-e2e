# Flow Functionality — cURL API Generation

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that Langflow's **API access modal** generates a valid macOS/Linux `curl` command that callers can execute against `/api/v1/run/{flow_id}` to run a flow programmatically. The test asserts the structural shape of the generated command, not just that the clipboard received some text.

If this breaks, integrators copying the snippet will hit malformed requests, missing headers, or a wrong URL — silently breaking the documented integration path that ships with every flow.

---

## Tags *(required)*

`@release` `@workspace` `@stable`

---

## Step by step *(required)*

1. Bootstrap the app and open the Templates page (`side_nav_options_all-templates`)
2. Open the `Basic Prompting` template
3. Click the publish button and open the API access item
4. Switch to the `cURL` tab (`api_tab_curl`)
5. Switch the platform sub-tab to `macOS/Linux` to make the output deterministic
6. Click the Copy icon and read `navigator.clipboard`
7. Assert the structural shape of the curl command (see Validation criterion)

---

## Validation criterion *(required)*

The clipboard content must satisfy **all** of the following:

- Starts with `curl --request POST`
- Contains `--url '<base>/api/v1/run/<UUID>?stream=false'` (UUID matched by `[0-9a-f-]{36}`)
- Contains `--header 'Content-Type: application/json'`
- Contains `x-api-key: YOUR_API_KEY_HERE`
- Contains `--data`
- Contains `"input_value": "Hello"` (the default value carried over from the Basic Prompting template's ChatInput)
- Contains `"session_id"` and `"output_type": "chat"`

A bare "clipboard is non-empty" check is insufficient — the previous version of the test was passing while silently copying the PowerShell variant.

---

## External dependencies *(required)*

- `src/frontend/src/modals/apiModal/utils/get-curl-code.tsx` — `getNewCurlCode` builds the command for both `unix` and `powershell` platforms
- `src/frontend/src/modals/apiModal/codeTabs/code-tabs.tsx` — renders the cURL tab and the macOS/Linux ↔ Windows platform switch (default driven by `getOS()`)
- `src/frontend/src/utils/utils.ts` — `getOS()` reads `navigator.platform` to pick the default platform tab
- `src/backend/base/langflow/api/v1/endpoints.py` — owns `/api/v1/run/{flow_id}`; the URL shape encoded in the curl must keep matching this route

---

## What this test does not cover *(optional)*

- The Windows/PowerShell variant (different syntax: `$jsonData = @'...'@`, `curl.exe`, backtick line-continuation)
- Tweaks payload encoding for flows with file-upload nodes (multi-step curl)
- Actually executing the generated command against the running backend (covered by API tests under `api/flows/`)
- The Python and JavaScript snippets in the same modal (covered by `pythonApiGeneration.spec.ts`)

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- No LLM credentials required — only the snippet generator is exercised
- `clipboard-read` permission is granted globally in `playwright.config.ts`

---

## When to review this test *(optional)*

- The cURL tab gains a new platform option (e.g., a `bash`-only sub-tab) — the explicit `macOS/Linux` click may need to change
- `getNewCurlCode` is refactored to drop `--request POST` in favor of `-X POST`, or to switch quoting style
- The `/api/v1/run/{flow_id}` route is renamed or namespaced
- The Basic Prompting template's default ChatInput value changes from `"Hello"` — the assertion `"input_value": "Hello"` will need to track it

---

## Notes *(optional)*

- The platform switch is required because `getOS()` is driven by `navigator.platform`, which can differ between local Chromium runs and CI runners. Without explicitly clicking macOS/Linux, the generated snippet is non-deterministic.
- The previous version of this test asserted only `clipboardContent.length > 0`, which would pass even if the wrong (PowerShell) variant or empty content was copied. The structural assertions guard against that class of false positive.
