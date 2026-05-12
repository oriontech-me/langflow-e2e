# Spec: Playground — Shareable URL Generation

**Test file:** `tests/tests-automations/regression/core-functionality/playground/playground-shareable-url.spec.ts`

## What this test validates

Verifies that the Shareable Playground feature generates a valid public URL when publishing is enabled on a flow that contains Chat Input and Chat Output components.

When `isPublished` becomes `true`, Langflow renders a `<a href="/playground/{uuid}">` link inside the Share dropdown. This test confirms:

1. The `publish-switch` starts unchecked (sharing off by default).
2. Clicking the switch transitions it to checked without closing the dropdown (`e.stopPropagation()` is used in the source).
3. A link with a valid `/playground/{uuid}` href appears after enabling.
4. The switch can be toggled back off (cleanup).

## Tags

`@release` `@playground` `@stable`

## Validation criterion

| Step | Criterion |
|---|---|
| Initial state | `publish-switch` is not checked |
| After enabling | `publish-switch` is checked; `[data-testid="shareable-playground"] a` is visible |
| URL format | `href` matches `/\/playground\/[0-9a-f-]{36}/` |
| Cleanup | `publish-switch` is not checked after toggling off |

## External dependencies

- `src/frontend/src/components/core/flowToolbarComponent/components/deploy-dropdown.tsx` — owns the `publish-button`, `shareable-playground`, and `publish-switch` test IDs as well as the `isPublished` toggle. Renaming any of these test IDs or removing the `ENABLE_PUBLISH` feature flag will break this test.
- The `publish-switch` and `shareable-playground` items are gated by `hasIO` (`useFlowStore.hasIO`); the flow under test must contain at least one Chat Input or Chat Output. The setup uses `setupPlayground()` which builds a Chat Input → Chat Output flow, so this contract is satisfied without depending on any starter template.
- The `publish-switch` uses `e.stopPropagation()` to keep the dropdown open after clicking — if this is removed, the dropdown closes and subsequent assertions will fail.

## Last validated

1.10.x
