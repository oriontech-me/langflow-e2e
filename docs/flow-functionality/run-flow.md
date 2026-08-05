# Flow Functionality — Run Flow

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev6`)

---

## What this test validates *(required)*

Validates the **Run Flow** component end-to-end: a pipeline flow (ChatInput → ChatOutput) is built, then a second flow uses the Run Flow component to invoke the pipeline. The test verifies that the output of the pipeline matches the input text — confirming that the Run Flow component correctly chains flows together.

The built flow is renamed to a unique name so it can be selected deterministically by name in the Run Flow "Flow Name" dropdown, rather than by the fragile first-option (`dropdown-option-0`) position that failed when the instance held other flows (issue #340).

If this breaks, users cannot compose flows via the Run Flow component — a core Langflow orchestration feature.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression` `@api`

---

## Step by step *(required)*

1. Bootstrap the app and create a blank flow
2. Add ChatOutput and ChatInput components to the canvas
3. Connect: ChatInput → ChatOutput
4. Rename the built flow to a unique name (for deterministic selection later)
5. Return to main page with `leaveFlowEditor(page)` — the `icon-ChevronLeft`
   click, preceded by a save barrier and followed by an attributed throw if the
   exit is blocked (#1153) — and create a second blank flow
6. Add the Run Flow component to the second flow
7. Open the flow name dropdown in Run Flow and refresh the list
8. Select the built flow by its unique name from the dropdown
9. Fill the `chatinput` textarea with `"THIS IS A TEST FOR RUN FLOW COMPONENT"`
10. Click `button_run_run flow`
11. Wait for "built successfully" notification
12. Click the output inspection button (`output-inspection-*`)
13. Assert the "Empty" placeholder input value equals `"THIS IS A TEST FOR RUN FLOW COMPONENT"`

---

## Validation criterion *(required)*

- "built successfully" notification appears after running
- Output inspection shows the exact input text echoed back through the pipeline
- Step 5 (return to the main page, then open the templates modal again) reaches the
  templates modal — the flake fixed in #966 died here, before the second flow was
  ever created

---

## Flake history — #966 (recurrent; quarantine partially lifted, `@stable` still off)

Failed the dailies of **2026-07-16** and **2026-07-27** with the same signature at
`run-flow.spec.ts:98` (step 5 above): neither the `FlowBuilderWelcome` overlay nor
the templates modal surfaced, so the reconciliation poll inside
`helpers/flows/open-new-flow-templates-modal.ts` exhausted its 30 s. Quarantined
at triage in PR #973 (`test.fixme` + `@stable` removed) and **lifted by the #966
fix**.

**Root cause (PRODUCT defect — filed upstream as [LE-2019](https://datastax.jira.com/browse/LE-2019); evidence on nightly `1.12.0.dev6`):** the flows list is
still loading when `new-project-btn` becomes visible after the `icon-ChevronLeft`
SPA back-navigation, and a click landed in that window is a **no-op**. Measured:

| Arm | Result |
|---|---|
| Click straight after a page load (`goto` → click) | overlay opened **5/5** in ~550 ms |
| Click immediately after `icon-ChevronLeft` back-navigation | nothing opened **3/5** within 15 s (page still on the list, entry point still visible) |
| Same, then re-clicking up to 4× | still nothing in 2/4 iterations; the re-clicks began failing with `locator.click: Timeout 15000ms` once the list rendered mid-click |
| Back-navigation + 3 s settle, single click | opened **4/4** on the first click |
| Back-navigation + wait for one `list-card`, single click | opened **4/4** on the first click |

In the failing window the DOM says the control is fine — `list-card` count **0**,
`cards-wrapper` present, `disabled=false`, `aria-disabled` unset,
`pointer-events: auto`, `__reactProps.onClick` a function, no skeletons — which is
exactly why Playwright's actionability checks pass and why the #420 swallowed-click
retry cannot recover it.

**Fix:** `openNewFlowTemplatesModal` now gates on the flows list having finished
rendering before its first click — first `list-card` visible, or the empty-page CTA
visible, or `cards-wrapper` absent (not a list page at all). The gate is bounded
and non-fatal: it never decides pass/fail, the authoritative 30 s modal wait still
does. Shared-helper blast radius (`awaitBootstrapTest`,
`addFlowToTestOnEmptyLangflow`, `loadTemplateByName`, `autoLogin`, `bulk-actions`,
`settings-shortcuts-edit`, this spec): the gate only adds a wait that resolves in
milliseconds once the list is rendered and returns immediately on non-list pages,
so no consumer's behavior changes.

**Verdict: product defect, not a test defect.** An enabled button with a wired
`onClick` whose click is a no-op while the list loads is broken behavior — invisible
to a human (who takes more than a second to move the mouse), fatal to a test that
clicks within 100 ms. Filed upstream as
[LE-2019](https://datastax.jira.com/browse/LE-2019); full evidence, version
archaeology and the confirmation runs still open live in
`docs/upstream-bugs/UPSTREAM-BUG-new-flow-dead-click.md`.

It is **not** a 1.12 regression: the nightly frontend tree is byte-identical to the
1.11.x releases, and the create-then-navigate path on this button arrived in 1.10.1
via upstream PR #12575 (1.10.0 opened the templates modal and created nothing).

**Consequence for this spec's tags:** `test.fixme` is lifted so the scenario runs
again (it carries `@release`, so parking it left a release-gate path unverified),
but **`@stable` stays off** until LE-2019 lands on the nightly and this spec is
re-validated there. The helper gate keeps the suite out of the broken window; it
does not fix the product, and the suite must not claim a validated behavior that
upstream still breaks. `#966` stays open tracking that.

### A second product defect on the same back-navigation (issue #1153)

Distinct from LE-2019 above and with a different mechanism: LE-2019 is a click
that lands and does nothing while the list loads; this one is a click that lands,
starts the navigation, and is then held by react-router's `useBlocker` behind
`SaveChangesModal`. In autosave mode that dialog renders **no confirm and no
cancel**, so only `FlowPage.handleSave` can complete the navigation — and it
calls `saveFlow()` with **no `.catch()`**, so a save that fails or never settles
leaves `proceed` false and the dialog up indefinitely. Reproduced
deterministically on 1.12.0.dev10 by aborting every flow-save PATCH: the modal
appears, does not clear in 30 s, and the URL stays on `/flow/{id}`.

Why it matters here specifically: this call site had **nothing** waiting on the
navigation, so a blocked exit surfaced downstream inside
`openNewFlowTemplatesModal` — wearing LE-2019's signature on a run where LE-2019
was not what happened.

Step 5 now goes through `leaveFlowEditor(page)`, which drains in-flight flow
saves before the click (prevention — `changesNotSaved` is exactly what
`useBlocker` gates on) and throws with the mechanism named if the dialog is still
up after 15 s. That 15 s is charged **only** to a dialog that is demonstrably on
screen; an exit where nothing has rendered yet is an ordinary in-flight
navigation and keeps the full 30 s the listing assertion has always had —
otherwise a slow-but-healthy exit would be reported as the swallowed-click class
above, which is the same mis-attribution with a more confident label.
The recovery-by-page-load that helper also offers is deliberately
**not** enabled here: everything the rest of this spec asserts lives in the flow
built on the canvas, so discarding it would trade a clean failure at the exit for
an inscrutable one at the Run Flow dropdown.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/flow_controls/run_flow.py` — the Run Flow component itself; its `flow_name` input is what the dropdown populates
- `src/frontend/src/components/core/dropdownComponent/` — the flow name dropdown UI (`dropdown-option-*` options and the refresh button)
- `src/backend/base/langflow/api/v1/flows.py` — flow listing API used by the dropdown refresh
- `src/backend/base/langflow/processing/` — flow execution chain that runs the pipeline
- `tests/helpers/flows/leave-flow-editor.ts` — the editor exit: drains in-flight flow saves, clicks `icon-ChevronLeft`, and distinguishes the #1153 blocker deadlock from a swallowed click. It depends on upstream `src/frontend/src/pages/FlowPage/index.tsx` (`useBlocker` / `handleSave`), `src/frontend/src/modals/saveChangesModal/index.tsx`, and the `flow.unsavedChangesTitle` string in `src/frontend/src/locales/en.json` — if that title is reworded the dialog stops being recognised and every deadlock silently reclassifies as a swallowed click

---

## What this test does not cover *(optional)*

- Run Flow with input/output mapping customization
- Error handling when the referenced flow is deleted
- Run Flow with multiple chained flows

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- No LLM required — ChatInput → ChatOutput echo requires no AI calls

---

## Notes *(optional)*

- `dotenv.config()` is called at the start only in non-CI environments to load `.env` variables; in CI, environment variables are injected directly.
- The test uses `getByTestId(/^textarea_str_chatinput.*/)` (regex) because the testid includes a dynamic suffix.
- Final assertion uses Playwright-native `await expect(value).toHaveValue("...")` (auto-waiting) instead of `expect(await ...inputValue()).toBe("...")`.
- Test body is wrapped in `try { ... } finally { /* API cleanup */ }` that deletes the 2 most-recently-created flows via `getAuthToken` + `DELETE /api/v1/flows/{id}`. Cleanup is best-effort (errors swallowed) so original test failures aren't masked by cleanup errors.
