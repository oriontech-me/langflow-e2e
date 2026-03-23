# mcp/ — Guia para criação de testes

Testes nesta pasta validam integração MCP (Model Context Protocol) — tanto o consumo de tools/resources externos (client) quanto a exposição de flows como MCP server.

---

## Testes MCP que envolvem agentes LLM

Se o teste MCP executa um agente (ex: agent usando uma tool MCP), **deve** usar o setup de modelos do projeto.

### Setup obrigatório antes de testar

```bash
npx playwright test tests/collect-models.spec.ts
```

### Carregar o agente com provider configurável

```typescript
import { SimpleAgentTemplatePage } from "../../../../pages";
import type { LoadSimpleAgentOptions } from "../../../../pages";

await new SimpleAgentTemplatePage(page).load(options);
// options: { provider: "openai", model: "gpt-4o-mini" }
```

### Configurar strategy no .env

```bash
MODEL_TEST_STRATEGY=model
MODEL_TEST_ID=gpt-4o-mini
```

---

## Testes MCP sem LLM

Testes que validam apenas configuração do MCP server/client (UI, endpoints, modal) **não** precisam do setup de modelos. Use diretamente o `page` da fixture.

---

## Tags obrigatórias para esta pasta

```typescript
{ tag: ["@mcp"] }                        // mínimo para todos os testes desta pasta
{ tag: ["@mcp", "@agents"] }             // se o teste executa um agente LLM via MCP
{ tag: ["@mcp", "@settings"] }           // se o teste navega pela página de configurações
```

---

## Estrutura das subpastas

| Pasta | O que testar |
|---|---|
| `client/` | Consumo de tools e resources de um MCP server externo |
| `server/` | Exposição de flows como MCP server (endpoint, tools, resources) |

---

## Referências

- `SimpleAgentTemplatePage` → `tests/pages/SimpleAgentTemplatePage.ts`
- Setup de providers → `tests/helpers/provider-setup/`
- Coleta de modelos → `tests/collect-models.spec.ts`
