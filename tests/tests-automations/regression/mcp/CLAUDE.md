# mcp/ — Guide for creating tests

Tests in this folder validate MCP (Model Context Protocol) integration — both consuming external tools/resources (client) and exposing flows as an MCP server.

---

## MCP tests that involve LLM agents

If the MCP test executes an agent (e.g.: agent using an MCP tool), it **must** use the project's model setup.

### Required setup before testing

```bash
npx playwright test tests/collect-models.spec.ts
```

### Load the agent with a configurable provider

```typescript
import { SimpleAgentTemplatePage } from "../../../../pages";
import type { LoadSimpleAgentOptions } from "../../../../pages";

await new SimpleAgentTemplatePage(page).load(options);
// options: { provider: "openai", model: "gpt-4o-mini" }
```

### Configure strategy in .env

```bash
MODEL_TEST_ID=gpt-4o-mini
```

---

## MCP tests without LLM

Tests that only validate MCP server/client configuration (UI, endpoints, modal) **do not** need the model setup. Use the `page` from the fixture directly.

---

## Required tags for this folder

```typescript
{ tag: ["@mcp"] }                        // minimum for all tests in this folder
{ tag: ["@mcp", "@agents"] }             // if the test executes an LLM agent via MCP
{ tag: ["@mcp", "@settings"] }           // if the test navigates the settings page
```

---

## Subfolder structure

| Folder | What to test |
|---|---|
| `client/` | Consuming tools and resources from an external MCP server |
| `server/` | Exposing flows as an MCP server (endpoint, tools, resources) |

---

## Authenticating against the MCP transport

The project transport endpoints (`/api/v1/mcp/project/{id}/streamable` and
`/sse`) accept an **API key and nothing else** — `x-api-key` as a header or as a
query parameter of the same name. Mint one with
`tests/helpers/auth/create-api-key.ts` and delete it in teardown; the
`auto_login` session JWT every other helper uses is **not** a credential here.

Measured on two live nightly containers while fixing #1522 (`initialize` on the
same endpoint, same project):

| Credential on `initialize` | 1.12.0.dev31 | 1.12.0.dev33 |
|---|---|---|
| `Authorization: Bearer <auto_login JWT>` | 200 | **403** |
| `x-api-key: <API key>` | 200 | **200** |
| `Authorization: Bearer <API key>` | 200 | **403** |
| no credential at all | 200 | **403** |

Three things that column pair settles:

- **The 403 is deliberate, not a regression.** The gate in
  `langflow/api/v1/mcp_projects.py` says so in the source: *"AUTO_LOGIN parity
  with the non-MCP entrypoints (`_api_key_security_impl`, `ws_api_key_security`,
  `authenticate_with_credentials`): AUTO_LOGIN alone is not a credential."* Only
  an explicit `LANGFLOW_SKIP_AUTH_AUTO_LOGIN=true` lets a caller with no key
  resolve to the superuser. The product agrees with itself: the JSON the MCP
  Server tab copies for a client carries `"x-api-key": "YOUR_API_KEY"`.
- **The dev31 column is why this was invisible.** That build answered `200` to a
  request carrying *no credential*, so every transport assertion passed without
  exercising auth at all — a spec could not tell a working credential from none.
- **An API key works on both builds**, so keying on it is version-robust and
  needs no lane change.

**We deliberately do not set `LANGFLOW_SKIP_AUTH_AUTO_LOGIN` on any lane or
start script.** The bypass turns off the control these specs exercise, and it is
weakest exactly where it would be most tempting: `mcp-server-install.spec.ts`
asserts that *the URL the UI copies resolves*, which the bypass makes
unconditionally true — including for a user whose real, keyed client would be
refused.

**Registering a Langflow endpoint as an MCP server** (`POST
/api/v2/mcp/servers/{name}`, or the HTTP tab's `http-headers-key-0` /
`popover-anchor-http-headers-value-0` fields) is the same contract seen from the
server side: Langflow connects out to that URL itself, so the stored config must
carry the `x-api-key` header. Without it, `GET
/api/v2/mcp/servers?action_count=true` reports `toolsCount: null` with
`rejected the request with HTTP 403: the configured credential was refused`;
with it, `toolsCount` is a number (measured).

---

## References

- `SimpleAgentTemplatePage` → `tests/pages/SimpleAgentTemplatePage.ts`
- Provider setup → `tests/helpers/provider-setup/`
- Model collection → `tests/collect-models.spec.ts`
