# [Spec Name]

**Last validated:** Langflow X.X.x

---

## What this test validates *(required)*
What the test validates in functional terms and why it exists. If it came from a bug, reference the issue.
If it is preventive release coverage, state which feature it protects.
Think: "if this test fails, what broke in the product?"

---

## Tags *(required)*
`@release` `@playground` `@stable`

<!-- If @stable is absent, state the reason here so it is visible without reading PR history.
     Two accepted forms:
       - Utility spec:  _(none — setup helper, not a regression test)_
       - Temporarily removed: handled via GitHub issue #N — no update needed here
     All other new specs must carry @stable. -->

---

## Step by step *(required)*
1. Step 1
2. Step 2
3. Step 3

---

## Validation criterion *(required)*
- What must be true for the test to pass
- Main assertions in human language, not in code

---

## External dependencies *(required)*
<!-- Files from the Langflow repository that, if changed, could break this test.
     This list is read by the monitoring workflow — fill it in carefully. -->

- `src/frontend/...` — description of what this file does and why it impacts the test
- `src/backend/...` — same

---

## What this test does not cover *(optional)*
- Adjacent behaviors that appear related but are intentionally out of scope
- Helps the maintainer distinguish a gap from a conscious decision

---

## Preconditions *(optional)*
- What needs to be configured or running before the test executes

---

## When to review this test *(optional)*
- Specific situations that indicate the test may be outdated, without being a direct break

---

## Notes *(optional)*
- Observations about flakiness, empirical timeouts, workarounds or decisions that a future maintainer would need to understand
