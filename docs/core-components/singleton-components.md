# Spec: Singleton and Mutually-Exclusive Components (Chat Input ↔ Webhook)

**Test file:** `tests/tests-automations/regression/core-components/singleton-components.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

Confirms the canvas constraint that **Chat Input and Webhook are singletons and mutually exclusive**: a flow may contain at most one of them, and while either is present neither can be added again. The rule is enforced across every path a user could take to create a second one:

1. **Sidebar `+` button** — adding the component removes the `+` affordance for *both* Chat Input and Webhook from the sidebar (silent, preventive — there is no toast).
2. **Duplicate shortcut (`Cmd/Ctrl+D`)** — duplicating the selected node is blocked with a toast ("…components were not pasted…").
3. **Copy + paste (`Cmd/Ctrl+C` then `Cmd/Ctrl+V`)** — pasting the copied node is blocked with the same toast.

The behavior is symmetric, so the spec is a `test.describe` block of eight tests: four for Chat Input and four mirroring them for Webhook (singleton, mutual exclusion, duplicate, copy/paste).

A shared `beforeEach` opens a blank flow via `setupBlankFlow` and waits for the sidebar search input; a shared `afterEach` deletes the created flow via the REST API so no orphan flows are left behind.

---

## Tags

`@stable` `@regression` `@components`

---

## Step by step

**beforeEach (all tests)**
1. `setupBlankFlow(page)` — create a blank flow via the REST API and open it (avoids the UI-creation 500 race; returns the flow id for cleanup).
2. Assert the sidebar search input is visible.

**Singleton tests (`allow only one …`)**
1. Search the component; assert its `add-component-button-<name>` has count `1` (baseline — the affordance exists).
2. Add it to the canvas (`addToCanvas`); assert `title-<name>` is visible and `.react-flow__node` count is `1`.
3. Search the same component again; assert its `+` button now has count `0`.

**Mutual-exclusion tests (`should not allow adding X while Y is on the canvas`)**
1. Search the *blocked* component (X); assert its `+` button has count `1` on the empty canvas (baseline).
2. Add the *other* component (Y) to the canvas.
3. Search X again; assert its `+` button now has count `0`.

**Duplicate tests (`should not allow duplicating …`)**
1. Add the component to the canvas.
2. Select the node and press `ControlOrMeta+d`; assert the "components were not pasted" toast is visible.

**Copy/paste tests (`should not allow copying and pasting …`)**
1. Add the component to the canvas.
2. Select the node, press `ControlOrMeta+c` then `ControlOrMeta+v`; assert the "components were not pasted" toast is visible.

**afterEach (all tests)**
1. Navigate to `/` (so background polling does not 404 on the deleted flow), then `DELETE /api/v1/flows/{id}`.

---

## Validation criterion

| Test | Criterion |
|---|---|
| allow only one Chat Input | `add-component-button-chat-input` count `1` before add, `0` after add |
| not allow adding a Webhook while a Chat Input is present | `add-component-button-webhook` count `1` on empty canvas, `0` after adding a Chat Input |
| not allow duplicating a Chat Input | "components were not pasted" toast visible after `Cmd/Ctrl+D` |
| not allow copying and pasting a Chat Input | "components were not pasted" toast visible after `Cmd/Ctrl+C` + `Cmd/Ctrl+V` |
| allow only one Webhook | `add-component-button-webhook` count `1` before add, `0` after add |
| not allow adding a Chat Input while a Webhook is present | `add-component-button-chat-input` count `1` on empty canvas, `0` after adding a Webhook |
| not allow duplicating a Webhook | "components were not pasted" toast visible after `Cmd/Ctrl+D` |
| not allow copying and pasting a Webhook | "components were not pasted" toast visible after `Cmd/Ctrl+C` + `Cmd/Ctrl+V` |

---

## External dependencies

- Sidebar add affordance — `sidebar-search-input` and `add-component-button-<name>` (`chat-input`, `webhook`). The oracle for the `+`-button path is the *absence* of these (`toHaveCount(0)`); the search term must match the component being checked, otherwise the sidebar filter hides it and the assertion becomes a false positive.
- Node title — `title-<display_name>` (`title-Chat Input`, `title-Webhook`), rendered by `CustomNodes/GenericNode/components/NodeName`. Used to confirm the node landed on the canvas.
- React Flow canvas — `.react-flow__node` for node counting and node selection before the keyboard shortcuts.
- Keyboard shortcuts — `ControlOrMeta+d` (duplicate) and `ControlOrMeta+c` / `ControlOrMeta+v` (copy/paste). Clipboard permissions are granted by the Playwright config.
- Toast copy — the i18n strings `flow.duplicateComponentsNotPasted` / `flow.exclusiveComponentsNotPasted` (both contain "components were not pasted"). The test matches on that shared substring.
- `tests/helpers/flows/setup-blank-flow.ts` — API-based flow creation and the `flowId` used for cleanup.

---

## What this test does not cover

- The same constraint for other component types — the rule is Chat Input/Webhook-specific here.
- Importing a flow JSON that already contains two singletons (constraint applies at load/paste rather than add).
- Which specific toast message fires (duplicate vs exclusive) — the assertion only checks the shared substring, not the full localized string.
- Undo/redo after a blocked duplicate or paste.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required (deterministic, no LLM).
- Default Playwright Desktop Chrome viewport with clipboard permissions (from `playwright.config.ts`).

---

## Notes

- Sibling references: `core-components/componentDelete.spec.ts` and `componentHoverAdd.spec.ts` (canvas node lifecycle).
- A single source of truth (`CHAT_INPUT` / `WEBHOOK` descriptors holding name + testids) plus local helpers (`addToCanvas`, `expectAddButtonCount`, `duplicateSelectedNode`, `copyPasteSelectedNode`) keep the eight tests DRY and prevent the testid copy/paste class of bug. Helpers are kept local to the spec.
- The `+`-button path is asserted by *absence of the affordance*, not by an error message — Langflow removes the button rather than showing a toast. The duplicate/paste paths are the opposite: they *do* surface a toast.
- Validated by running the full suite against a live instance (`8 passed`).
