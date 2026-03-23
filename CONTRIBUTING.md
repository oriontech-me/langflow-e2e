# Contribuindo com o Langflow E2E

Este guia é para quem vai criar, validar ou manter testes neste repositório.

---

## Como criar um novo teste

**1. Escolha a pasta correta**

Localize dentro de `tests/tests-automations/regression/` a pasta que corresponde à área funcional do teste:

| O que você vai testar | Pasta |
|---|---|
| Login, logout, gerenciamento de usuários | `core-functionality/auth/` |
| Execução de flow, importação de JSON | `flow-functionality/` |
| Configuração de model provider | `core-functionality/model-provider/` |
| Canvas, sidebar, sticky notes | `ui-ux/` |
| Endpoints REST | `api/flows/` |
| Upload de arquivos, RAG | `core-functionality/knowledge-ingestion-management/` |
| MCP server ou client | `mcp/server/` ou `mcp/client/` |

**2. Nomeie o arquivo**

O arquivo deve terminar em `.spec.ts` e ter um nome descritivo em kebab-case que identifique o comportamento testado:

```
login-invalid-credentials.spec.ts
agent-model-provider-selection.spec.ts
canvas-add-custom-component.spec.ts
flow-import-json.spec.ts
```

**3. Estrutura básica do arquivo**

```typescript
import { test, expect } from "../../../fixtures";

test.describe("Nome da área ou funcionalidade", () => {
  test("deve [comportamento esperado] quando [condição]", async ({ page }) => {
    await test.step("Descrição do passo 1", async () => {
      // ação
    });

    await test.step("Descrição do passo 2", async () => {
      // asserção
    });
  });
});
```

> Importe sempre de `fixtures` — nunca diretamente do Playwright. A fixture base adiciona monitoramento automático de erros de backend.

**4. Use helpers e pages existentes**

Antes de escrever ações do zero, verifique se já existe um helper ou page object para o que você precisa:

```typescript
// exemplo: navegar até o model provider e selecionar um modelo
import { navigateToModelProvider } from "../../pages/main/model-provider.page";
import { selectProviderAndModel } from "../../helpers/ui/model-provider.helper";
```

**5. Adicione pelo menos uma tag**

Todo teste deve ter uma tag para poder ser filtrado por suite:

```typescript
test("deve configurar o model provider", { tag: ["@components"] }, async ({ page }) => {
```

Veja a tabela de tags disponíveis no [README](./README.md#tags-disponíveis).

**6. Atualize o `QA_CHECKLIST.md`**

Após criar o teste, localize o item correspondente no checklist e marque como `[-]` (automatizado, precisa validar). Somente mude para `[x]` após seguir o processo de validação abaixo.

---

## Como validar um teste

Antes de marcar um cenário como coberto no checklist, siga este processo:

**1. Rode o teste isolado com relatório completo**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:7860 npx playwright test caminho/do/teste.spec.ts --reporter=html --trace=on
npx playwright show-report
```

No relatório, verifique se os `test.step()` descritos no código correspondem ao que aconteceu na tela (screenshots + log de rede).

**2. Confirme que os passos do teste estão documentados**

Cada teste deve ter `test.step()` descrevendo o que cada bloco faz. Se não tiver, adicione antes de validar:

```typescript
await test.step("Log in with valid credentials and confirm main page loads", async () => { ... });
await test.step("Reload page and confirm session was cleared — login screen must appear", async () => { ... });
```

**3. Force uma falha para confirmar que não é falso positivo**

Esta é a etapa mais importante — e a mais ignorada.

Quebre intencionalmente o comportamento que o teste deveria detectar e confirme que o teste **falha**. Se ele continuar passando, a asserção não está validando nada de real.

```typescript
// Antes
expect(isLoggedIn).toBeFalsy();

// Para testar: inverta e confirme que falha
expect(isLoggedIn).toBeTruthy(); // deve falhar → reverta depois
```

Para testes de agente, a forma de forçar falha depende do comportamento validado:

| O que o teste valida | Como forçar a falha |
|---|---|
| Resposta contém conteúdo específico | Trocar o prompt por um que não produza esse conteúdo |
| Parâmetro afeta o comportamento (ex: `max_tokens`) | Comentar a linha que define o parâmetro no teste |
| `system_prompt` é respeitado | Não preencher o campo de instructions |
| Memória é retida entre mensagens | Desconectar o Memory component do flow |
| Tool result aparece no reasoning panel | Remover a tool do agente antes de executar |
| New Chat limpa a sessão | Não clicar em New Chat antes de perguntar |
| Streaming é progressivo | Mockar a resposta como não-streaming via `page.route()` |

> Se o teste passar em todos esses cenários de quebra, ele é um **falso positivo** e não deve ser mergeado.

**4. Rode em modo debug para acompanhar passo a passo**

```bash
PLAYWRIGHT_BASE_URL=http://localhost:7860 npx playwright test caminho/do/teste.spec.ts --debug
```

O Playwright Inspector abre e você avança ação por ação, vendo o estado da página em cada momento.

**5. Verifique os logs do terminal**

A fixture base imprime erros de backend automaticamente. Após rodar, procure no output por:

- `🚨 Backend Error:` — erro HTTP inesperado
- `🚨 Flow Error Detected` — falha silenciosa na execução de flow

Se aparecer algum desses e o teste passar mesmo assim, revise o teste.

**6. Atualize o checklist**

Só marque `[x]` após confirmar os 5 passos acima. Se a cobertura for parcial, use `[~]`.

---

## Antipadrões de falso positivo

Os padrões abaixo produzem testes que **nunca falham** — independentemente do estado da aplicação. São os erros mais comuns ao criar testes E2E e os mais difíceis de detectar em revisão de código.

### `|| true` — asserção matematicamente impossível de falhar

```typescript
// ❌ ERRADO — passa sempre, não valida nada
expect(hasResponse || hasSteps || true).toBe(true);
expect(claudeVisible || manageBtnVisible || true).toBe(true);
```

Um teste com `|| true` na asserção é um placeholder disfarçado. Se você encontrar esse padrão no codebase, reescreva a asserção ou remova o teste.

### `catch(() => false)` sem justificativa — soft check silencioso

```typescript
// ❌ PROBLEMÁTICO sem contexto — passa mesmo se o elemento nunca aparecer
const isVisible = await element.isVisible({ timeout: 3000 }).catch(() => false);
if (isVisible) {
  await expect(outroElemento).toBeVisible();
}
```

O padrão `catch(() => false)` é **aceitável apenas quando o comportamento é genuinamente opcional**. Nesse caso, documente a intenção com um comentário explicando por que o check é soft:

```typescript
// ✅ CORRETO — soft check intencional e documentado
// header-icon só aparece quando o agente usa tools.
// Modelos que respondem diretamente sem tools não geram este ícone — comportamento esperado.
const usedTools = await page.getByTestId("header-icon").last()
  .isVisible({ timeout: 3000 }).catch(() => false);
if (usedTools) {
  await expect(page.getByTestId("duration-display").last()).toBeVisible();
}
```

Se o comportamento **não** é opcional, use uma asserção direta:

```typescript
// ✅ CORRETO — asserção direta para comportamento obrigatório
await expect(page.getByTestId("div-chat-message").last()).toBeVisible({ timeout: 30000 });
const responseText = await page.getByTestId("div-chat-message").last().innerText();
expect(responseText.trim().length).toBeGreaterThan(1);
```

### Asserção de presença sem validação de conteúdo

```typescript
// ❌ FRACO — confirma que o elemento existe, mas não que contém o dado correto
await expect(page.getByTestId("div-chat-message").last()).toBeVisible();

// ✅ MELHOR — valida que o conteúdo é o esperado
const response = await page.getByTestId("div-chat-message").last().innerText();
expect(response).toContain("Paris"); // para "what is the capital of France?"
```

### Hardcode de provider em testes de agente

```typescript
// ❌ ERRADO — testa apenas Anthropic, ignora OpenAI, Google, WatsonX, Ollama
await page.getByText("Anthropic").click();
await page.getByTestId("popover-anchor-input-api_key").fill(process.env.ANTHROPIC_API_KEY);

// ✅ CORRETO — parametrizado pela infraestrutura de providers do projeto
for (const { label, options, skipReason } of getTestTargets()) {
  test.describe.serial(`Meu Teste [${label}]`, () => {
    test("deve ...", async ({ page }) => {
      await new SimpleAgentTemplatePage(page).load(options);
    });
  });
}
```

Veja `agent-component-regression.spec.ts` e o `CLAUDE.md` da pasta `llm-agents/` para o padrão completo.

---

## Branches

Use o padrão `<tipo>/<descrição-curta>` em kebab-case:

| Tipo | Quando usar | Exemplo |
|---|---|---|
| `feat/` | Novo teste, novo helper ou page object | `feat/flow-import-json` |
| `fix/` | Correção de teste quebrado ou flaky | `fix/model-provider-selector-flaky` |
| `chore/` | CI, checklist, dependências, refatoração interna | `chore/update-nightly-workflow` |
| `docs/` | Atualização de documentação | `docs/update-contributing` |

A descrição deve identificar o que muda, não quem mudou ou quando.

---

## Commits

Use o mesmo prefixo da branch seguido de uma descrição no imperativo:

```
feat: add test for login with invalid credentials
fix: replace flaky selector in model provider test
chore: update file-watcher monitored paths
```

- Máximo de 72 caracteres na primeira linha
- Português ou inglês — escolha um e mantenha no branch inteiro
- Sem ponto final

Para mudanças pequenas e relacionadas, agrupe em um único commit. Não crie um commit por linha editada.

---

## Pull Requests

Todo trabalho entra via PR — sem push direto em `main`.

**Processo:**
1. Abra o PR com o branch pronto e o teste validado (seguindo o guia acima)
2. **Solicite revisão de outro membro da organização** antes de mergear — se não houver resposta em tempo razoável, registre o motivo no PR
3. Use **squash merge** para manter o histórico do `main` limpo e linear
4. **Após o merge**, delete o branch local e remoto:
   ```bash
   git checkout main && git pull
   git branch -d <branch>
   git push origin --delete <branch>
   ```

> A revisão de código é a prática esperada no projeto. Quando não for possível obtê-la, registre no PR o contexto que justificou a decisão — isso transforma uma exceção em aprendizado para o time.

**O que o PR deve comunicar:**
- O que ele adiciona ou corrige
- Como o teste foi validado (os 5 passos do guia)
- Issue relacionada, se vier de um alerta do file-watcher

O template de PR já está configurado no repositório e preenche esses campos automaticamente ao abrir um PR no GitHub.

---

## Manutenção dos testes

### Como o time fica sabendo que um teste precisa ser revisado

O maior risco em testes E2E não é o teste que falha — é o teste que **passa mas não valida mais o comportamento correto**, porque o Langflow mudou e o teste não acompanhou.

O `file-watcher.yml` roda todo dia às 05h BRT e verifica se houve commits no repositório oficial do Langflow nas últimas 24h em caminhos críticos. Quando detecta mudanças, abre automaticamente uma issue neste repositório.

**A issue informa:**
- Qual área funcional mudou (ex: "Model Providers & LLM")
- O comando exato para rodar os testes afetados (ex: `npx playwright test --grep "@components|@api"`)
- Qual seção do `QA_CHECKLIST.md` revisar
- Os commits das últimas 24h para leitura humana

**Exemplo de issue gerada após mudança em model providers:**
> | Area | Run these tests | Checklist |
> |---|---|---|
> | Model Providers & LLM | `npx playwright test --grep "@components\|@api"` | ÁREA 8 — LLM Providers + ÁREA 7 — Templates |

### Áreas monitoradas

| Área | Caminhos monitorados | Tags afetadas |
|---|---|---|
| Routes & Feature Flags | `routes.tsx`, `feature-flags.ts` | todas |
| Authentication | `api/v1/login.py`, `services/auth/`, `LoginPage/`, `authStore.ts` | `@release @api` |
| Flow CRUD & Canvas | `api/v1/flows.py`, `FlowPage/`, `flowStore.ts` | `@workspace @release` |
| Flow Execution | `api/v1/endpoints.py`, `processing/`, `api/v1/chat.py` | `@release @api` |
| Model Providers & LLM | `ModelProvidersPage/`, `modelProviderModal/`, `providerConstants.ts`, `api/v1/models.py` | `@components @api` |
| Agents & Agentic Flows | `agentic/`, `base/agents/`, `MainPage/` | `@components @release` |
| Playground & Chat | `pages/Playground/`, `playgroundStore.ts`, `api/v1/chat.py` | `@workspace @release` |
| Settings & Global Variables | `SettingsPage/`, `api/v1/variable.py` | `@api @release` |
| MCP Server | `MCPServersPage/`, `api/v1/mcp.py`, `agentic/mcp/` | `@components` |
| Tracing & Monitoring | `api/v1/traces.py`, `services/tracing/` | `@api` |
| Database Models | `services/database/models/`, `alembic/` | `@database @release` |
| Component Input Types | `parameterRenderComponent/`, `CustomNodes/`, `inputs/` | `@components` |

### O que fazer quando chegar uma issue do file-watcher

1. Leia os commits listados na issue — identifique se é uma mudança de comportamento, renomeação de elemento, novo endpoint, etc.
2. Rode os testes indicados na tabela da issue
3. Para cada teste que falhar ou parecer desatualizado, siga o guia de validação acima
4. Atualize os testes necessários e marque o `QA_CHECKLIST.md`
5. Feche a issue

> **Importante:** uma issue do file-watcher não significa que os testes vão falhar — significa que o time precisa verificar ativamente. Mudanças sutis de UI (renomear um botão, mover um elemento) podem não quebrar o teste, mas invalidar o que ele está testando.
