---
name: Test Automation
about: E2E test plan — will be read by the LLM for implementation
title: "[Test] should ... when ..."
labels: test-automation
assignees: ""
---

## What to test
<!-- Complete: "should [observable result] when [action or condition]"
     This sentence becomes the test name — be specific.
     Ex: "should display the correct capital when the agent receives a direct question"
         "should clear the history when the user clicks New Chat" -->

---

## Preconditions
<!-- State required before the test begins.
     Ex: user logged in, empty canvas, provider configured with a valid API key. -->

---

## Steps

1.
2.
3.

---

## Expected concrete result
<!-- What specifically should be visible or true at the end?
     Avoid: "the message appears", "the modal opens", "the agent responds".
     Prefer: "the response contains the name of the requested capital",
             "the panel shows at least one tool call with name and result",
             "after New Chat, the previous message does not appear in the new session". -->

---

## Type
- [ ] UI — browser interaction
- [ ] API REST — direct call to endpoints
- [ ] Agent / LLM Provider — involves model execution
- [ ] MCP — server or client integration

---

## Non-obvious behaviors
<!-- Optional. Specific conditions, timing, intermediate states that
     the LLM could not know without human context.
     Ex: "the badge only appears after the first flow execution",
         "the field disappears if the user does not have edit permission". -->

---

## Reference
<!-- Related issue or PR, if any. -->
