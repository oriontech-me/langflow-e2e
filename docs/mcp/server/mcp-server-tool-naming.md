# MCP Server — every published tool name is callable

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev29`, #1411)

---

## What this test validates *(required)*

QA-CHECKLIST §14.1. A project's MCP server joins `tools/list` to `tools/call` by the
tool **name** and nothing else: a client stores the string the server published and
sends it back. This spec asserts that the round trip holds where the name is
**derived** rather than copied — every name `tools/list` publishes must be accepted
by `tools/call`, and must run the flow it was published for.

`tools/list` derives the name: `sanitize_mcp_name`, truncated to
`MAX_MCP_TOOL_NAME_LENGTH` (**30**), de-duplicated with a `_1`, `_2`… suffix. Until
upstream `langflow-ai/langflow#15179` the call path regenerated it with a different
rule (no 30-cap, no de-duplication), so above 30 characters, or on a collision, the
server advertised a tool it then refused with `Flow with name '…' not found` (#1411,
upstream LE-2657). Three triggers, each a test here:

1. an **action name** longer than 30 characters;
2. **no** action name typed — the MCP Server tab's default is the **flow name**, so a
   flow named over 30 characters reproduces it with nothing typed (the shipped
   starter `Portfolio Website Code Generator` is 32);
3. two flows with the **same** action name — published as `<name>` and `<name>_1`.

If this broke, an MCP client or agent would discover a tool, call it, and get "not
found" for a name the server itself just published — or, worse, run a different flow
than the one it asked for, with no error.

### Measured

| Trigger | on `1.12.3` (#1411) | on `1.13.0.dev29` (this spec) |
|---|---|---|
| 37-char action name | published at 30, call → not found | published at 30, call runs, echoes its input |
| 39-char flow name as action | published at 30, call → not found | published at 30, call runs |
| duplicate action name | `<n>` runs, `<n>_1` → not found | both run; each writes only to its own flow's messages |

The published names themselves did **not** change — #15179 kept the wire format and
made the call path accept it — so the exact published name is asserted too: a fix
that "worked" by publishing the untruncated name would break every client that
already stored the old one.

---

## Tags *(required)*

`@stable` `@api` `@mcp`

---

## Step by step *(required)*

Setup, once: mint an API key (the MCP transport accepts nothing else, #1522).
Per test: create a project, create the passthrough chat flow(s) in it
(`tests/assets/flows/chat-io-ok-trace-fixture.json`, Chat Input → Chat Output), and
`PATCH /api/v1/mcp/project/{id}` to expose them. Then `initialize` the project's
streamable endpoint and `tools/list`.

**Test 1 — an action name over 30 characters**

1. Expose one flow with `action_name` = a ~36-character lowercase snake_case name
2. Assert `tools/list` publishes exactly its first 30 characters
3. `tools/call` that published name with a per-run sentinel; assert
   `isError: false` and the reply echoes the sentinel

**Test 2 — the flow name as the action name (the MCP Server tab default)**

1. Name the flow `Customer Support Ticket Triage <run>` and expose it with that name
   as `action_name`
2. Assert `tools/list` publishes `customer_support_ticket_triage` (sanitized, cut at 30)
3. `tools/call` it; assert the sentinel is echoed

**Test 3 — two flows with the same action name**

1. Expose two flows with the same `action_name` `same_<run>`
2. Assert `tools/list` publishes exactly `same_<run>` and `same_<run>_1`
3. `tools/call` each published name with its own sentinel; assert both succeed and
   echo their own sentinel
4. Read `GET /api/v1/monitor/messages?flow_id=<flow>` for each flow: assert each
   flow holds exactly one of the two sentinels, and that they differ — each published
   name ran a distinct flow, and neither ran the other's

Cleanup (`afterEach`, then `afterAll`): delete the flows, then the project; then the
API key. Failures are collected and asserted, never swallowed.

---

## Validation criterion *(required)*

- every name `tools/list` publishes is accepted by `tools/call` and runs: the reply
  echoes the per-run sentinel sent to it
- the published names are the derived ones: first 30 characters; the sanitized,
  30-capped flow name; `<name>` / `<name>_1`
- duplicate names reach two **different** flows, one each

---

## Guarding against false positives *(how)*

- The published name is asserted **exactly** before it is called, so the call is
  made with the derived name, never with the untruncated one the test wrote.
- Each call carries a unique sentinel and asserts its echo: a canned or cached reply
  cannot pass.
- Test 3's per-flow message check is what tells "both names work" from "both names
  run the same flow" — the second is the silent failure #15179 describes.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/mcp_utils.py` — `handle_list_tools` / `handle_call_tool`, the two halves joined by the name
- `src/lfx/src/lfx/base/mcp/util.py` — `build_mcp_tool_name_map` (the shared derivation, #15179), `get_flow_snake_case`, `sanitize_mcp_name`
- `src/lfx/src/lfx/base/mcp/constants.py` — `MAX_MCP_TOOL_NAME_LENGTH` (30)
- `src/backend/base/langflow/api/v1/mcp_projects.py` — `PATCH /api/v1/mcp/project/{id}` and the streamable transport

---

## What this test does not cover *(optional)*

- a truncated name that collides with another flow's full name (the "wrong flow"
  case #15179 also closes) — covered upstream by its own unit cells
- names that are not snake_case (non-ASCII, punctuation) beyond the spaces and
  capitals of test 2
- the REST listing (`GET /api/v1/mcp/project/{id}`), which reports the stored names,
  not the published ones

---

## Preconditions *(optional)*

- None. No provider key: the flow is a passthrough.

---

## When to review this test *(optional)*

- `MAX_MCP_TOOL_NAME_LENGTH` changes, or the published name format changes (that would
  also break every stored client configuration)
