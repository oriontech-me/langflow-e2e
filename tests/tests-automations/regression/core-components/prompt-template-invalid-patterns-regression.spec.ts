import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// Run serially to avoid 500 errors from concurrent POST /api/v1/flows/
// when several workers create a blank flow at the same time.
test.describe.configure({ mode: "serial" });

// Verified testids and selectors:
//   add button:          "add-component-button-prompt-template"
//   node title:          "title-Prompt Template"
//   modal open btn:      "button_open_prompt_modal"
//   modal textarea:      "modal-promptarea_prompt_template"
//   modal save btn:      "genericModalBtnSave"
//   dynamic handles:     "handle-prompt template-shownode-{varname}-left"
//   error toast:         CSS class ".error-build-message" (no data-testid;
//                        sourced from src/frontend/src/alerts/error/index.tsx)
//
// Backend contract — POST /api/v1/validate/prompt raises HTTP 500 with
// `detail=str(ValueError(...))` when the f-string parser flags an invalid
// pattern. The frontend's promptModal `onError` callback then calls
// `setErrorData({ title: t("errors.prompt"), list: [error.response.data.detail] })`,
// which renders an `ErrorAlert` toast and keeps the modal in edit mode
// (the modal does NOT close — the textarea remains visible).
//
// See the spec doc's Notes for the rationale on why `{var-name}` and `{}`
// rejection cases from the original issue scope were dropped after probing.

const ERROR_TOAST_TITLE = "There is something wrong with this prompt";
const ERROR_DETAIL_FRAGMENT =
  "Input variables contain invalid characters or formats";

const dynamicHandlesLocator = (page: Page): Locator =>
  page.locator(
    '[data-testid^="handle-prompt template-shownode-"][data-testid$="-left"]',
  );

const errorToastLocator = (page: Page): Locator =>
  page.locator(".error-build-message");

async function addPromptComponent(page: Page): Promise<void> {
  await awaitBootstrapTest(page);
  await expect(page.getByTestId("blank-flow")).toBeAttached({ timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  await page.getByTestId("sidebar-search-input").click();
  await page.getByTestId("sidebar-search-input").fill("prompt");
  await expect(
    page.getByTestId("add-component-button-prompt-template"),
  ).toBeAttached({ timeout: 30000 });
  await page.getByTestId("add-component-button-prompt-template").click();

  await adjustScreenView(page);
  await expect(page.locator(".react-flow__node")).toHaveCount(1, {
    timeout: 10000,
  });
}

// Open the prompt modal, replace its current value with `value`, and click
// save — but do NOT wait for the modal to close. The save round-trip can end
// in one of two states depending on whether validation passes:
//   - success: textarea hides, sanitized preview appears
//   - error:   `setIsEdit(true)` keeps the textarea visible and a toast
//              with class `.error-build-message` is rendered
// Callers assert on the expected state themselves; this helper just submits.
async function fillAndSavePromptTemplate(
  page: Page,
  value: string,
): Promise<void> {
  await page.getByTestId("button_open_prompt_modal").click();

  const textarea = page.getByTestId("modal-promptarea_prompt_template");

  // After a previous save, the modal initially shows the sanitized preview
  // (read-only) instead of the textarea. Clicking the preview re-enters edit
  // mode and mounts the textarea. On the first save of a fresh component the
  // preview is absent — keep the probe short so each test only pays a ~500ms
  // tax instead of 2s.
  const preview = page.getByTestId("edit-prompt-sanitized");
  if (await preview.isVisible({ timeout: 500 }).catch(() => false)) {
    await preview.click();
  }

  await expect(textarea).toBeVisible({ timeout: 10000 });
  await textarea.click();
  await textarea.fill(value);

  await page.getByTestId("genericModalBtnSave").click();
}

// Runs the three-step rejection contract for a single invalid template:
//   1. submit the template via the prompt modal
//   2. assert the error toast carries the upstream ValueError title + detail
//      + the offending variable name (so a stale buffer regression is caught)
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
// `scripts/stable-tests.ts` renders `${expr}` template placeholders as
// `<expr>` and would otherwise collapse the runtime tests into a single,
// vague bullet.
async function runRejectionContract(
  page: Page,
  template: string,
  detailIncludes: string,
): Promise<void> {
  await test.step(
    `Submit \`${template}\` — invalid pattern flagged by _check_input_variables`,
    async () => {
      await fillAndSavePromptTemplate(page, template);
    },
  );

  await test.step(
    "Error toast surfaces the upstream ValueError with the offending variable name",
    async () => {
      // The toast auto-dismisses after 5s — assert it before any other wait.
      // `errors.prompt` title is constant; the detail list carries the upstream
      // message that names the variable in question.
      const toast = errorToastLocator(page);
      await expect(toast).toBeVisible({ timeout: 5000 });
      await expect(toast).toContainText(ERROR_TOAST_TITLE);
      await expect(toast).toContainText(ERROR_DETAIL_FRAGMENT);
      await expect(toast).toContainText(detailIncludes);
    },
  );

  await test.step(
    "Modal stays in edit mode so the user can correct the input",
    async () => {
      await expect(
        page.getByTestId("modal-promptarea_prompt_template"),
      ).toBeVisible();
      await page.keyboard.press("Escape");
    },
  );
}

// Note on the fixture interaction: the save POST /api/v1/validate/prompt
// returns HTTP 500 by design in the rejection scenarios below. The fixture
// (tests/fixtures/fixtures.ts) only fails the test on `flow_error`-type
// events from /build/, /run/, or /events?event_delivery= — HTTP 500s on
// other endpoints are logged as `http_error` and do not fail the test.
// So no `page.allowFlowErrors()` opt-out is needed here.

test(
  "Prompt Template — `{var.attr}` (dot notation) is rejected with an error toast and creates no handle",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await runRejectionContract(page, "Hello {var.attr}", "var.attr");

    // Fourth piece of the rejection contract — kept at the test body level
    // (rather than inside `runRejectionContract`) so each test carries a
    // visible body-level `expect()` for the `playwright/expect-expect` rule.
    await expect(dynamicHandlesLocator(page)).toHaveCount(0);
  },
);

test(
  "Prompt Template — `{var name}` (space inside identifier) is rejected with an error toast and creates no handle",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await runRejectionContract(page, "Hello {var name}", "var name");

    await expect(dynamicHandlesLocator(page)).toHaveCount(0);
  },
);

test(
  "Prompt Template — `{var,name}` (comma inside identifier) is rejected with an error toast and creates no handle",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    // Comma is in `_INVALID_CHARACTERS` and users sometimes mistakenly write
    // `{a,b}` thinking it declares multiple variables — this case catches a
    // regression where comma is silently dropped from the set.
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await runRejectionContract(page, "Hello {var,name}", "var,name");

    await expect(dynamicHandlesLocator(page)).toHaveCount(0);
  },
);

test(
  "Prompt Template — `{1var}` (leading digit) is rejected with an error toast and creates no handle",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    // Anchor on "Invalid variables: 1" instead of just "1" — the bare digit
    // could match incidental substrings in the toast (build numbers, icon
    // names, etc.); the full fragment proves the upstream `_fix_variable`
    // leading-digit branch actually fired.
    await runRejectionContract(page, "Hello {1var}", "Invalid variables: 1");

    await expect(dynamicHandlesLocator(page)).toHaveCount(0);
  },
);

test(
  "Prompt Template — `{}` (empty braces) is accepted by the parser and creates no handle",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    // Positive-path-as-defensive coverage: empty braces are auto-numbered
    // positional fields in Python's `Formatter().parse()`, which yields an
    // empty `field_name` that `extract_input_variables_from_prompt` filters
    // out. The save succeeds without raising and no dynamic handle appears.
    // If a future change starts rejecting `{}` (or extracting it as a real
    // variable), this test breaks first.
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step(
      "Save `Plain {} text` — save closes the modal, no error toast, no handle",
      async () => {
        await fillAndSavePromptTemplate(page, "Plain {} text");

        // Save succeeded — textarea hides and the sanitized preview takes over.
        await expect(
          page.getByTestId("modal-promptarea_prompt_template"),
        ).toBeHidden({ timeout: 10000 });

        await expect(errorToastLocator(page)).toHaveCount(0);
        await expect(dynamicHandlesLocator(page)).toHaveCount(0);
      },
    );
  },
);

test(
  "Prompt Template — repeating the same variable produces exactly one handle (deduplication contract)",
  { tag: ["@stable", "@regression", "@components"] },
  async ({ page }) => {
    // Documents the dedup behavior of `extract_input_variables_from_prompt`,
    // which tracks seen field names in a set — repeating `{name}` does not
    // duplicate the handle, even though the template has two placeholders.
    await test.step("Add Prompt Template to a blank flow", async () => {
      await addPromptComponent(page);
    });

    await test.step(
      "Save `Hello {name}, goodbye {name}.` — both placeholders share the `name` slot",
      async () => {
        await fillAndSavePromptTemplate(page, "Hello {name}, goodbye {name}.");

        await expect(
          page.getByTestId("modal-promptarea_prompt_template"),
        ).toBeHidden({ timeout: 10000 });

        await expect(
          page.getByTestId("handle-prompt template-shownode-name-left"),
        ).toBeVisible({ timeout: 10000 });
        await expect(dynamicHandlesLocator(page)).toHaveCount(1);
      },
    );
  },
);
