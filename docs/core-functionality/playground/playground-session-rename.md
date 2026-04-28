# Spec: Playground – Session Rename Availability (B2)

**Test file:** `tests/tests-automations/regression/core-functionality/playground/playground-session-rename.spec.ts`

## What this test validates

Verifies the session rename availability rule enforced by the Playground:

```
canRenameSession = !isDefaultSession && hasMessages
```

When `canRenameSession` is false the rename option is not rendered in the DOM at all (not just hidden). Three scenarios are covered:

1. **Default Session** — rename must be absent regardless of message count.
2. **User-created session with no messages** — rename must be absent.
3. **User-created session with messages** — rename must be present and functional: Enter confirms the new name, Escape cancels without changing it.

## Tags

`@stable` `@regression` `@playground`

## Validation criterion

| Test | Criterion |
|---|---|
| Default Session | `rename-session-option` count is 0 after opening the more-menu |
| Session with no messages | `rename-session-option` count is 0 after opening the more-menu of the new session |
| Session with messages | `rename-session-option` is visible; after Enter the new name appears in `session-selector`; after Escape the previous name is preserved |

## External dependencies

- `src/frontend/src/components/core/chatComponents/sessionSelector/session-selector.tsx` — `canRenameSession` logic and `data-testid="rename-session-option"`. Any change to this conditional or to these testids will break the tests.
- Radix `SelectContent` only renders children when the dropdown is open — the more-menu (`[data-testid^="session-"][data-testid$="-more-menu"]`) must be clicked before asserting the absence of `rename-session-option`.

## Last validated

1.10.x
