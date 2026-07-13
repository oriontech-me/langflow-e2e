# Spec: A misconfigured flow surfaces an appropriate build-error message (§8.4)

**Test file:** `tests/tests-automations/regression/core-functionality/observability-monitoring/flow-error-message.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

When a flow fails to build because a component is **misconfigured** (a required
field left empty), Langflow surfaces an **appropriate, specific** error message
that names the actual problem — not a generic "something went wrong". This is
the §8.4 "Flow with error displays appropriate message" guarantee: the user is
told *what* to fix.

The vehicle is the **API Request** component with an empty **URL** field. Running
it fails the build in ~0.3s (no network call — the validation happens before any
request), and the UI shows both:

- a **"Flow build failed"** banner (the generic failure signal), and
- the **specific, actionable message "URL cannot be empty"** (the appropriate
  part — it names the exact field/reason).

## Why this scope (distinct from the §8.4 siblings)

Two neighbouring specs already exist; this one deliberately does NOT overlap:

- `core-components/validate-raise-errors-components.spec.ts` — a **Custom
  Component that `raise`s a Python `ValueError`**; asserts the raised message
  surfaces. That is the "Component that raises Python error" bullet.
- `ui-ux/execution-error-notification.spec.ts` — a **mocked network 500 /
  timeout**; asserts generic error feedback appears. That is the "Network error
  during execution" bullet.

This spec is the third, distinct case: a **configuration/validation error** (no
Python raise, no network mock) where the value of the test is that the message
is *appropriate* — it names the missing field. A generic "build failed" alone
would not satisfy it.

---

## Tags

`@stable` `@release` `@components` `@observability`

(`@observability`: user-facing error surfacing is the subject. `@components`:
the error originates from a component's field validation. Created `@stable` by
#695 after deterministic validation.)

---

## Step by step

1. Bootstrap to the templates modal and open a **blank flow**
   (`awaitBootstrapTest` → `blank-flow`); wait for the sidebar
   (`sidebar-search-input`) to be interactive.
2. `page.allowFlowErrors()` — the build failure is intentional; without this
   the fixture's flow-error monitor would fail the test itself.
3. Add the **API Request** component (search "API Request" →
   `add-component-button-api-request`). Leave the **URL** field empty.
4. Run the component from its terminal run button (`button_run_api request`).
5. Assert the **generic** failure banner "Flow build failed" is visible.
6. Assert the **appropriate specific** message "URL cannot be empty" is visible
   — this is the distinctive observable.

---

## Validation criterion

| Step | Criterion |
|---|---|
| After running the URL-less API Request | "Flow build failed" banner visible |
| Same | "URL cannot be empty" specific message visible (within a few seconds; the build fails in ~0.3s, no network) |

The specific-message assertion is what makes this a §8.4 "appropriate message"
test — a regression that degrades the message to a generic failure, or removes
the field-level validation, fails the specific assertion while the banner may
still pass.

---

## External dependencies

- Component testids: `add-component-button-api-request`,
  `button_run_api request` (scouted live on 1.11.0.dev41).
- Error copy: "Flow build failed" (banner) and "URL cannot be empty"
  (API Request URL validation) — both live on 1.11; a change to either breaks
  the corresponding assertion.
- **No external network or provider** — the empty-URL validation fails before
  any HTTP request, so the test is hermetic and deterministic.

---

## What this test does not cover

- Component-level Python `raise` errors (covered by
  `validate-raise-errors-components.spec.ts`).
- Network 500 / timeout during execution (covered by
  `execution-error-notification.spec.ts`).
- Execution-timeout messaging (separate §8.4 bullet).
- The Retry/Dismiss affordances on the failure banner.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (auto_login).

---

## Flow cleanup

The test creates one blank flow. Its id is captured via the **Pattern A
response accumulator** (`page.on("response")` collecting every `POST
/api/v1/flows` 201 id) — never `page.url()`, since `awaitBootstrapTest` creates
a competing bootstrap flow whose id the URL would carry (#681). `afterEach`
deletes all captured ids (404-tolerant). Behavioral force-fail: no-op the
cleanup and the flow count grows.
