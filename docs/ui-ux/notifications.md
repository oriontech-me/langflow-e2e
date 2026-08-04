# Notifications — Build-Success Entry in the Notifications Tab

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that running a component surfaces a notification, and that the
Notifications tab opened from the header bell renders that entry:

1. A blank flow with a single **Chat Input** is built successfully.
2. Clicking the notification bell (`notification_button`) opens the Notifications
   tab, which shows the **"Flow built successfully"** entry alongside the
   per-notification delete (Trash2) control.

If this breaks, users lose visibility into build outcomes — the notification
center either fails to open or does not record successful builds.

---

## Tags *(required)*

`@stable` `@release` `@ui-ux`

---

## Step by step *(required)*

1. Bootstrap app (`awaitBootstrapTest`) and create a blank flow
2. Search the sidebar for `chat input` and add the **Chat Input** component
3. Assert the canvas has exactly 1 node
4. Click the node title and expand it (Chat Input is added minimized, so the run
   button is not in the DOM until expanded — `expandFocusedNode`)
5. Click the component run button (`button_run_chat input`)
6. Wait for the **"built successfully"** toast
7. Click the notification bell (`notification_button`)
8. Assert the Notifications tab shows the "Notifications" heading, a Trash2
   delete icon, and the **"Flow built successfully"** entry

---

## Validation criterion *(required)*

- The "built successfully" toast appears after running Chat Input
- After opening the Notifications tab: the "Notifications" label, a `icon-Trash2`
  control, and the exact text **"Flow built successfully"** are all visible
- **Assistant onboarding tooltip**: suppressed before the first document load via `seedAssistantDiscovered(page)` in `beforeEach` — the only point at which it can be suppressed, since upstream reads the flag at mount of the canvas-controls bar and then arms a 10 s timer. `expandFocusedNode` asserts the seed ran and fails loudly, naming the fix, if a test added later forgets it. This replaces a `dismissOnboardingIfPresent` probe that #1220 measured firing ~2 s after that mount, catching the tooltip in 0 of 39 executions on 1.12.0.dev15.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/` — notifications dropdown / alert center
- `data-testid="notification_button"` — header notification bell
- `data-testid="icon-Trash2"` — per-notification delete control
- `data-testid="input_outputChat Input"` / `add-component-button-chat-input` /
  `button_run_chat input` — Chat Input sidebar entry, add button, run button
- No API key required — Chat Input builds without an LLM call

---

## What this test does not cover *(optional)*

- Clearing/deleting notifications (the Trash2 control is asserted visible but not
  clicked)
- Error and warning notifications (only the build-success path is exercised)
- Notification persistence across reload

---

## Notes *(optional)*

- Migrated from **Text Input** to **Chat Input**: Langflow marked Text I/O as
  `legacy: true` on 1.10.0 and the sidebar hides legacy components by default, so
  the original trigger was unreachable. Chat Input is the durable equivalent
  (same migration approach as #366).
- Chat Input defaults to `minimized = True`; `expandFocusedNode` expands it so the
  on-node run button is present in the DOM before the run click.
