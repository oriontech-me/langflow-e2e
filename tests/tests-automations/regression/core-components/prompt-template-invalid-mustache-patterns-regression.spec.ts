import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import {
  addPromptComponent,
  dynamicHandlesLocator,
  errorToastLocator,
  fillPromptTemplate,
  setUseDoubleBrackets,
} from "../../../helpers/ui/prompt-template";

// Run serially to avoid 500 errors from concurrent POST /api/v1/flows/
// when several workers create a blank flow at the same time.
test.describe.configure({ mode: "serial" });

// Backend contract — POST /api/v1/validate/prompt with `mustache: true` raises
// HTTP 500 with `detail=str(ValueError(...))` when `validate_mustache_template`
// flags a forbidden pattern. The mustache modal's `onError` callback
// (src/frontend/src/modals/mustachePromptModal/index.tsx:148-153) calls
// `setErrorData({ title: t("errors.prompt"), list: [error.response.data.detail] })`,
// which renders the same `ErrorAlert` toast used by the f-string sibling spec
// and sets `isEdit=true` so the modal stays open in edit mode.
//
// The four rejection cases below come from two distinct branches of
// `validate_mustache_template` (src/lfx/src/lfx/utils/mustache_security.py):
//   - DANGEROUS_PATTERNS regex hits (sections, triple braces) → "Complex mustache
//     syntax is not allowed. ..."
//   - SIMPLE_VARIABLE_PATTERN per-pattern match miss (spaces, dot notation) →
//     "Invalid mustache variable: {{...}}. Only simple variable names ..."
// Both branches were probed against the live endpoint on Langflow 1.10.x before
// this spec was written.

const ERROR_TOAST_TITLE = "There is something wrong with this prompt";
const COMPLEX_SYNTAX_FRAGMENT =
  "Complex mustache syntax is not allowed";
const INVALID_VARIABLE_FRAGMENT = "Invalid mustache variable";

// Runs the three-step rejection contract for a single invalid mustache template:
//   1. submit the template via the mustache prompt modal
//   2. assert the error toast carries the `errors.prompt` title + the upstream
//      ValueError fragment (which branch of validate_mustache_template fired)
//   3. assert the modal stays in edit mode (frontend sets isEdit=true on error)
//
// The fourth contract piece — "no dynamic handle was created on the node" —
// lives at the test body level instead of inside the helper so that each
// `test()` carries a visible body-level `expect()` for the
// `playwright/expect-expect` lint rule.
//
// The four rejection tests below intentionally remain as separate `test()`
// declarations (not a parameterised loop) so the auto-generated `Phase 0 —
// Validated` block in QA-CHECKLIST.md surfaces one bullet per case —
// `scripts/stable-tests.ts` renders `${expr}` template placeholders as `<expr>`
// and would otherwise collapse the runtime tests into a single, vague bullet.
async function runMustacheRejectionContract(
  page: Page,
  template: string,
  detailIncludes: string,
): Promise<void> {
  await test.step(
    `Submit \`${template}\` — invalid pattern flagged by validate_mustache_template`,
    async () => {
      await fillPromptTemplate(page, template, {
        mode: "mustache",
        waitForHide: false,
      });
    },
  );

  await test.step(
    "Error toast surfaces the upstream ValueError with the expected fragment",
    async () => {
      // The toast auto-dismisses after 5s — assert visibility once, then snapshot
      // the text in a single read so the title + detail assertions can't race the
      // dismissal timer. `toContainText`'s auto-retry would otherwise poll past
      // the 5s window if the first call landed near the dismissal boundary.
      const toast = errorToastLocator(page);
      await expect(toast).toBeVisible({ timeout: 5000 });
      const toastText = (await toast.textContent()) ?? "";
      expect(toastText).toContain(ERROR_TOAST_TITLE);
      expect(toastText).toContain(detailIncludes);
    },
  );

  await test.step(
    "Modal stays in edit mode so the user can correct the input",
    async () => {
      // Bound to the toast's 5s lifetime — if `setIsEdit(true)` is broken, the
      // textarea is already gone by the time we assert. Default expect timeout
      // is 5s but pinning explicitly makes the intent visible.
      await expect(
        page.getByTestId("modal-mustachepromptarea_mustache_template"),
      ).toBeVisible({ timeout: 5000 });
      await page.keyboard.press("Escape");
    },
  );
}

// Note on the fixture interaction: the save POST /api/v1/validate/prompt
// returns HTTP 500 by design in the rejection scenarios below. The fixture
// (tests/fixtures/fixtures.ts) only fails the test on `flow_error`-type
// events from /build/, /run/, or /events?event_delivery= — HTTP 500s on
// other endpoints are logged as `http_error` and do not fail the test.
// So no `page.allowFlowErrors()` opt-out is needed here (same as the f-string
// sibling spec).

test(
  "Prompt Template — mustache `{{ var }}` (spaces inside braces) is rejected with an error toast and creates no handle",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template and enable mustache mode", async () => {
      await addPromptComponent(page);
      await setUseDoubleBrackets(page, true);
    });

    // Spaces inside the braces fail SIMPLE_VARIABLE_PATTERN's per-pattern match.
    // The error detail names the offending pattern verbatim — assert on the
    // "Invalid mustache variable" prefix plus the literal pattern.
    await runMustacheRejectionContract(
      page,
      "Hello {{ var }}",
      `${INVALID_VARIABLE_FRAGMENT}: {{ var }}`,
    );

    // Fourth piece of the rejection contract — kept at the test body level
    // (rather than inside the helper) so each test carries a visible body-level
    // `expect()` for the `playwright/expect-expect` rule.
    await expect(dynamicHandlesLocator(page)).toHaveCount(0);
  },
);

test(
  "Prompt Template — mustache `{{var.attr}}` (dot notation) is rejected with an error toast and creates no handle",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template and enable mustache mode", async () => {
      await addPromptComponent(page);
      await setUseDoubleBrackets(page, true);
    });

    // Dot notation is intentionally unsupported — `safe_mustache_render` has no
    // dot-path lookup, so the validator rejects via the SIMPLE_VARIABLE_PATTERN
    // miss branch. Anchor on the literal `{{var.attr}}` to prove the offending
    // pattern survived round-trip into the detail.
    await runMustacheRejectionContract(
      page,
      "Hello {{var.attr}}",
      `${INVALID_VARIABLE_FRAGMENT}: {{var.attr}}`,
    );

    await expect(dynamicHandlesLocator(page)).toHaveCount(0);
  },
);

test(
  "Prompt Template — mustache `{{#section}}{{/section}}` is rejected with the complex-syntax message and creates no handle",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template and enable mustache mode", async () => {
      await addPromptComponent(page);
      await setUseDoubleBrackets(page, true);
    });

    // `{{#` and `{{/` are both in DANGEROUS_PATTERNS — the first match short-
    // circuits with the constant "Complex mustache syntax is not allowed"
    // message (the pattern itself is not echoed back in this branch).
    await runMustacheRejectionContract(
      page,
      "{{#section}}{{/section}}",
      COMPLEX_SYNTAX_FRAGMENT,
    );

    await expect(dynamicHandlesLocator(page)).toHaveCount(0);
  },
);

test(
  "Prompt Template — mustache `{{{var}}}` (triple braces) is rejected with the complex-syntax message and creates no handle",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template and enable mustache mode", async () => {
      await addPromptComponent(page);
      await setUseDoubleBrackets(page, true);
    });

    // Triple braces are the mustache "unescaped HTML" sigil and are blocked by
    // the `{{{` regex in DANGEROUS_PATTERNS — same constant message as the
    // section case. Keeping it as its own test surfaces the case explicitly in
    // the Phase 0 — Validated block in QA-CHECKLIST.md.
    await runMustacheRejectionContract(
      page,
      "Hello {{{var}}}",
      COMPLEX_SYNTAX_FRAGMENT,
    );

    await expect(dynamicHandlesLocator(page)).toHaveCount(0);
  },
);
