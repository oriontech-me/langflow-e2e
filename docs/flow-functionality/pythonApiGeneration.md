# Flow Functionality — Python API Generation

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that Langflow's **API access modal** generates a valid Python `requests` snippet that callers can run against `/api/v1/run/{flow_id}` to execute a flow programmatically. The test asserts the structural shape of the generated code, not just that the clipboard received some text.

If this breaks, integrators copying the Python snippet will hit malformed requests, missing imports, broken auth, or a wrong URL — silently breaking the documented Python integration path that ships with every flow.

---

## Tags *(required)*

`@release` `@workspace` `@stable`

---

## Step by step *(required)*

1. Bootstrap the app and open the Templates page (`side_nav_options_all-templates`)
2. Open the `Basic Prompting` template
3. Click the publish button and open the API access item
4. Switch to the `Python` tab (`api_tab_python`)
5. Click the Copy icon and read `navigator.clipboard`
6. Assert the structural shape of the Python snippet (see Validation criterion)

---

## Validation criterion *(required)*

The clipboard content must satisfy **all** of the following:

- Starts with `import requests`
- Contains `import uuid`
- Contains `api_key = 'YOUR_API_KEY_HERE'`
- Contains `url = "<base>/api/v1/run/<UUID>"` (UUID matched by `[0-9a-f-]{36}`)
- Contains `"input_value": "Hello"` (the default value carried over from the Basic Prompting template's ChatInput)
- Contains `"output_type": "chat"` and `"input_type": "chat"`
- Contains `payload["session_id"] = str(uuid.uuid4())`
- Contains `headers = {"x-api-key": api_key}`
- Contains `requests.request("POST", url, json=payload, headers=headers)`

A bare "clipboard is non-empty" check is insufficient — the previous version of the test was passing while only asserting `length > 0`, which would silently accept an empty buffer or a different language's snippet.

---

## External dependencies *(required)*

- `src/frontend/src/modals/apiModal/utils/get-python-api-code.tsx` — `getNewPythonApiCode` builds the Python snippet for both the no-files path (used here) and the multi-step file-upload path
- `src/frontend/src/modals/apiModal/codeTabs/code-tabs.tsx` — renders the Python tab and registers `data-testid="api_tab_python"`; the platform sub-tab is gated to cURL only, so Python is deterministic across machines
- `src/frontend/src/customization/utils/custom-code-samples.ts` — `getBaseUrl()` and `getApiSampleHeaders("python")` shape the URL and headers when API key auth is disabled
- `src/backend/base/langflow/api/v1/endpoints.py` — owns `/api/v1/run/{flow_id}`; the URL shape encoded in the snippet must keep matching this route

---

## What this test does not cover *(optional)*

- The multi-step file-upload variant (`hasFileTweaks(tweaks) === true`) which produces a different snippet with `requests.post(...files=...)` calls
- Actually executing the generated code against the running backend (covered by API tests under `api/flows/`)
- The cURL and JavaScript snippets in the same modal (covered by `curlApiGeneration.spec.ts` and `jsApiGeneration.spec.ts`)
- The "no API key" variant (`shouldDisplayApiKey === false`) — Basic Prompting always renders with the auth section

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- No LLM credentials required — only the snippet generator is exercised
- `clipboard-read` permission is granted globally in `playwright.config.ts`

---

## When to review this test *(optional)*

- `getNewPythonApiCode` is refactored to switch to `httpx`, drop the `try/except` wrapper, or change auth header construction
- The `/api/v1/run/{flow_id}` route is renamed or namespaced
- The Basic Prompting template's default ChatInput value changes from `"Hello"` — the assertion `"input_value": "Hello"` will need to track it
- The Python tab gains a sub-tab (e.g., `requests` vs `httpx`) — the test would need to pin one variant explicitly, the same way `curlApiGeneration.spec.ts` pins macOS/Linux

---

## Notes *(optional)*

- Unlike the cURL variant, the Python snippet has no platform sub-tab (the OS sub-tabs render only when `selectedTab === "cURL"` in `code-tabs.tsx`), so the test does not need to pin a platform.
- The previous version of this test asserted only `clipboardContent.length > 0`, which would pass even if the wrong tab's content or an empty buffer was copied. The structural assertions guard against that class of false positive.
