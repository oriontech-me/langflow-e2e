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
| Agentes LLM, raciocínio, tool calling | `core-functionality/llm-agents/` |
| MCP server ou client | `mcp/server/` ou `mcp/client/` |

> Pastas com `CLAUDE.md` contêm instruções específicas sobre como criar testes naquela área. Leia antes de começar.

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
// navegar para settings
import { SettingsPage } from "../../pages";

// carregar Simple Agent com provider e modelo configurável
import { SimpleAgentTemplatePage } from "../../pages";
await new SimpleAgentTemplatePage(page).load({ provider: "openai", model: "gpt-4o-mini" });
```

**5. Adicione pelo menos uma tag**

Todo teste deve ter uma tag para poder ser filtrado por suite:

```typescript
test("deve configurar o model provider", { tag: ["@model-provider"] }, async ({ page }) => {
```

Veja a tabela de tags disponíveis no [README](./README.md#tags-disponíveis).

**6. Atualize o `QA_CHECKLIST.md` e o `QA-SCENARIOS-GUIDE.md`**

Após criar o teste, localize o item correspondente no `QA_CHECKLIST.md` e marque como `[-]` (automatizado, precisa validar). Somente mude para `[x]` após seguir o processo de validação abaixo.

Adicione também uma entrada no `QA-SCENARIOS-GUIDE.md` descrevendo o cenário em linguagem humana — objetivo, pré-condições, passo a passo e critério de validação. Os dois documentos devem estar sempre sincronizados com os testes existentes.

**7. Crie o arquivo de documentação do spec**

Para cada spec, crie um arquivo `.md` correspondente em `docs/`, espelhando o caminho relativo a partir de `regression/`. Por exemplo:

```
tests/tests-automations/regression/core-functionality/playground/playground-session-id.spec.ts
→ docs/core-functionality/playground/playground-session-id.md
```

Use `docs/TEMPLATE.md` como base. As seções obrigatórias são: **Motivação**, **O que este teste valida**, **Tags**, **Critério de validação** e **Dependências externas**.

> A seção **Dependências externas** lista arquivos do repositório upstream do Langflow que, se alterados, podem quebrar o teste. Ela é lida pelo `file-watcher.yml` para determinar quais testes precisam ser revisados quando o Langflow muda. Preencha com atenção.

---

## Criando testes com LLM (agentes, providers, MCP)

Testes que executam um agente com LLM exigem um setup específico. **Não hardcode provider, API key ou modelo** — use a infraestrutura do projeto.

### Antes de criar o teste: gere os dados

```bash
npx playwright test tests/collect-models.spec.ts
```

Isso valida as API keys de cada provider e coleta os modelos disponíveis na UI, gerando:
- `tests/helpers/provider-setup/data/providers.json`
- `tests/helpers/provider-setup/data/models.json`

### Padrão de parametrização por modelo

O projeto usa um padrão onde cada modelo do `models.json` gera um `test.describe.serial` separado. Veja `agent-component-regression.spec.ts` como referência completa.

Estrutura básica:

```typescript
import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { test, expect } from "../../../../fixtures/fixtures";
import { SimpleAgentTemplatePage, type LoadSimpleAgentOptions } from "../../../../pages";
import { hasProviderEnvKeys, type Provider } from "../../../../helpers/provider-setup";
import type { ProviderRecord } from "../../../../helpers/provider-setup/collect-models";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// Lê providers inativos para exibir como skipped no output
function getProviderSkipReasons(): Map<string, string> {
  const jsonPath = path.resolve(__dirname, "../../../../helpers/provider-setup/data/providers.json");
  if (!fs.existsSync(jsonPath)) return new Map();
  const records = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ProviderRecord[];
  return new Map(
    records.filter((r) => r.status === "inactive").map((r) => [r.provider, `Provider "${r.provider}" inativo — ${r.error}`])
  );
}

// Lê modelos e aplica estratégia do .env
function getTestTargets() {
  const jsonPath = path.resolve(__dirname, "../../../../helpers/provider-setup/data/models.json");
  if (!fs.existsSync(jsonPath)) return [];
  const allModels = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const skipReasons = getProviderSkipReasons();
  // aplicar filtro de strategy (ver agent-component-regression.spec.ts para implementação completa)
  return allModels.map((m: any) => ({
    label: `${m.provider} / ${m.model}`,
    options: { provider: m.provider as Provider, model: m.model },
    skipReason: skipReasons.get(m.provider),
  }));
}

const targets = getTestTargets();

for (const { label, options, skipReason } of targets) {
  const provider = options.provider ?? "openai";

  test.describe.serial(`Meu Teste [${label}]`, () => {
    test("deve ...", { tag: ["@agents"] }, async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");
      test.skip(!hasProviderEnvKeys(provider), `Missing env vars for "${provider}"`);

      try {
        await new SimpleAgentTemplatePage(page).load(options);
      } catch (e: any) {
        if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
        throw e;
      }

      // seu teste aqui
    });
  });
}
```

### Rodando testes de agente

Esta é a etapa mais importante — e a mais ignorada.

Quebre intencionalmente o comportamento que o teste deveria detectar e confirme que o teste **falha**. Se ele continuar passando, a asserção não está validando nada de real.

# Rodar todos os modelos de um provider
MODEL_TEST_PROVIDER=openai \
  npx playwright test caminho/do/teste.spec.ts --workers=1

# Rodar somente um modelo específico
MODEL_TEST_ID=gpt-4o-mini \
  npx playwright test caminho/do/teste.spec.ts --workers=1

# Rodar todos os modelos do JSON (padrão)
npx playwright test caminho/do/teste.spec.ts --workers=1
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
PLAYWRIGHT_BASE_URL=http://localhost:7860 npx playwright test caminho/do/teste.spec.ts --reporter=html --trace=on
npx playwright show-report
```

**2. Confirme que os passos do teste estão documentados**

Cada teste deve ter `test.step()` descrevendo o que cada bloco faz.

**3. Force uma falha para confirmar que não é falso positivo**

Comente ou inverta a asserção principal. O teste **deve falhar**. Se passar mesmo com a asserção quebrada, o cenário não está sendo validado de verdade.

**4. Rode em modo debug para acompanhar passo a passo**

```bash
npx playwright test caminho/do/teste.spec.ts --debug
```

**5. Verifique os logs do terminal**

A fixture base imprime erros de backend automaticamente. Procure por:

- `🚨 Backend Error:` — erro HTTP inesperado
- `🚨 Flow Error Detected` — falha silenciosa na execução de flow

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
| `feat/` | Novo teste, novo helper ou page object | `feat/agent-regression-multi-provider` |
| `fix/` | Correção de teste quebrado ou flaky | `fix/model-provider-selector-flaky` |
| `chore/` | CI, checklist, dependências, refatoração interna | `chore/update-nightly-workflow` |
| `docs/` | Atualização de documentação | `docs/update-contributing` |

---

## Commits

Use o mesmo prefixo da branch seguido de uma descrição no imperativo:

```
feat: add agent regression tests parametrized by model
fix: replace flaky selector in model provider test
chore: update file-watcher monitored paths
```

- Máximo de 72 caracteres na primeira linha
- Português ou inglês — escolha um e mantenha no branch inteiro
- Sem ponto final

---

## Pull Requests

Todo trabalho entra via PR — sem push direto em `main`.

**Processo:**
1. Abra o PR com o branch pronto e o teste validado
2. **Solicite revisão de outro membro da organização** antes de mergear
3. Use **squash merge** para manter o histórico do `main` limpo e linear
4. **Após o merge**, delete o branch local e remoto:
   ```bash
   git checkout main && git pull
   git branch -d <branch>
   git push origin --delete <branch>
   ```

**O que o PR deve comunicar:**
- O que ele adiciona ou corrige
- Como o teste foi validado (os 5 passos do guia)
- Issue relacionada, se vier de um alerta do file-watcher

### Descrevendo um PR de novo teste

A descrição de um PR de teste tem uma responsabilidade diferente da de um PR de feature ou fix: ela precisa comunicar não apenas *o que foi feito*, mas *o que está sendo garantido*. O revisor deve conseguir, sem abrir nenhum arquivo, avaliar se o teste cobre o comportamento correto, se a abordagem é sólida e quais são os limites da cobertura adicionada.

> **Para o revisor:** consulte o `QA-SCENARIOS-GUIDE.md` e localize o cenário correspondente. Verifique se o teste implementado cobre o comportamento especificado — objetivo, pré-condições e critério de validação. Divergências entre a especificação e a implementação devem ser sinalizadas como bloqueantes.

**1. Tabela de testes cobertos**

Liste cada teste com uma descrição do **comportamento do sistema** que ele valida — não os passos de execução, mas a propriedade que quebraria em caso de regressão:

| # | Teste | O que valida |
|---|---|---|
| 1 | `nome do teste` | Descrição do comportamento do sistema que seria detectado se regredisse |
| 2 | `nome do teste` | Descrição do comportamento do sistema que seria detectado se regredisse |

**2. Como cada teste foi construído**

Descreva as decisões de implementação não óbvias. Se o teste usa interceptação de resposta, injeção via API, arquivo de flow pré-construído ou qualquer mecanismo indireto em vez da interação direta pela UI, justifique a escolha — o que torna a abordagem direta inviável ou inadequada para o cenário:

> Ex: o campo X não possui UI editável em condições normais de uso; o teste injeta o valor via interceptação da resposta da API para exercitar o comportamento sem depender de efeitos colaterais externos.

**3. Dependências**

Declare explicitamente o que o teste precisa para executar corretamente:

- PRs ou helpers que devem estar mergeados antes
- Se requer LLM: provider, modelo e variáveis de ambiente necessárias no `.env`
- Modo de execução: `serial` ou paralelo, e por quê
- Presença de `afterEach` de cleanup e o que ele descarta

**4. O que este teste não cobre**

Declare o escopo negativo — comportamentos relacionados que o revisor poderia razoavelmente esperar ver cobertos, mas que estão fora desta PR e por quê:

> Ex: não cobre o comportamento do componente quando a API retorna erro 5xx; não valida a integração com o campo Y, que pertence a outra área funcional.

**5. Limitações conhecidas** *(se houver)*

Registre workarounds, timeouts empíricos, race conditions aceitas ou qualquer decisão que um mantenedor futuro precisaria entender para não introduzir regressões ao modificar o teste:

> Ex: o teste aguarda N ms para garantir o autosave antes de navegar; esse valor é empírico e pode ser insuficiente em ambientes com latência elevada. A solução correta dependeria de um sinal explícito do backend que não está disponível na versão atual.

**6. Atualize o `QA-SCENARIOS-GUIDE.md`**

Para cada novo cenário coberto, adicione uma entrada no `QA-SCENARIOS-GUIDE.md` com:

- **Objetivo** — o que o cenário valida em termos de comportamento do sistema
- **Pré-condições** — o que precisa estar configurado ou em execução
- **Passo a passo** — a sequência de ações que o teste executa
- **Validação** — o critério que determina sucesso ou falha

O guide é a especificação em linguagem humana dos testes automatizados. Mantê-lo atualizado permite que o revisor compare o teste implementado com o comportamento especificado e avalie se a cobertura está correta — sem precisar ler o código.

---

## Manutenção dos testes

### Como o time fica sabendo que um teste precisa ser revisado

O `file-watcher.yml` roda todo dia às 05h BRT e verifica se houve commits no repositório oficial do Langflow nas últimas 24h em caminhos críticos. Quando detecta mudanças, abre automaticamente uma issue neste repositório.

**A issue informa:**
- Qual área funcional mudou
- O comando exato para rodar os testes afetados
- Qual seção do `QA_CHECKLIST.md` revisar

### Áreas monitoradas

| Área | Caminhos monitorados | Tags afetadas |
|---|---|---|
| Routes & Feature Flags | `routes.tsx`, `feature-flags.ts` | todas |
| Authentication | `api/v1/login.py`, `services/auth/` | `@auth` |
| Flow CRUD & Canvas | `api/v1/flows.py`, `FlowPage/` | `@project-management` |
| Flow Execution | `api/v1/endpoints.py`, `processing/` | `@api` |
| Model Providers & LLM | `ModelProvidersPage/`, `providerConstants.ts` | `@model-provider @agents` |
| Agents & Agentic Flows | `agentic/`, `base/agents/` | `@agents` |
| Playground & Chat | `pages/Playground/`, `api/v1/chat.py` | `@playground` |
| Settings & Global Variables | `SettingsPage/`, `api/v1/variable.py` | `@settings` |
| MCP Server | `MCPServersPage/`, `api/v1/mcp.py` | `@mcp` |
| Tracing & Monitoring | `api/v1/traces.py`, `services/tracing/` | `@observability` |
| Database Models | `services/database/models/`, `alembic/` | `@api` |
| Component Input Types | `parameterRenderComponent/`, `inputs/` | `@ui-ux` |

### O que fazer quando chegar uma issue do file-watcher

1. Leia os commits listados na issue
2. Rode os testes indicados na tabela da issue
3. Para cada teste que falhar ou parecer desatualizado, siga o guia de validação acima
4. Atualize os testes necessários e marque o `QA_CHECKLIST.md`
5. Feche a issue
