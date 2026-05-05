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

`@release` `@playground`

## Validation criterion

| Step | Criterion |
|---|---|
| Initial state | `publish-switch` is not checked |
| After enabling | `publish-switch` is checked; `[data-testid="shareable-playground"] a` is visible |
| URL format | `href` matches `/\/playground\/[0-9a-f-]{36}/` |
| Cleanup | `publish-switch` is not checked after toggling off |

## External dependencies

- `src/frontend/src/components/core/flowToolbarComponent/components/deploy-dropdown.tsx` — `publish-button`, `shareable-playground`, `publish-switch` test IDs and `isPublished` toggle logic. Any rename of these test IDs or change to the `ENABLE_PUBLISH` feature flag will break this test.
- The `publish-switch` uses `e.stopPropagation()` to keep the dropdown open after clicking — if this is removed, the dropdown closes and subsequent assertions will fail.

## Last validated

1.10.x
