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

## References

- `SimpleAgentTemplatePage` → `tests/pages/SimpleAgentTemplatePage.ts`
- Provider setup → `tests/helpers/provider-setup/`
- Model collection → `tests/collect-models.spec.ts`
