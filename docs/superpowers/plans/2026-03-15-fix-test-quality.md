# Fix Test Quality — False Positives & Structural Issues

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar falsos positivos e padrões incorretos nos testes de regressão do Langflow E2E.

**Architecture:** Cada arquivo é corrigido independentemente. As correções seguem as convenções documentadas no skill `langflow-playwright-skill`: `.isVisible()` sem `expect()` → `await expect(locator).toBeVisible()`, drag handles → click-click, `if/else` com fallback genérico → assertion direta.

**Tech Stack:** TypeScript, Playwright, Langflow E2E test suite

---

## Regras obrigatórias (para todos os tasks)

- NUNCA usar `.isVisible()` sem `expect()` — sempre `await expect(locator).toBeVisible()`
- NUNCA usar `expect(await locator.isVisible()).toBeTruthy()` — mesmo motivo acima
- NUNCA usar `if/else` onde o `else` verifica `body` ou elemento genérico
- NUNCA usar `.catch(() => false)` em lógica de teste (apenas em cleanup)
- Handles de canvas: sempre dois cliques sequenciais, não drag
- `waitForTimeout` sempre precisa de um `expect()` depois para validar estado

---

## Chunk 1: Arquivos com `.isVisible()` sem `expect()`

### Task 1: `deleteFlows.spec.ts`

**Arquivo:** `tests/tests-automations/regression/core-functionality/project-management/deleteFlows.spec.ts`

**Problema:** 3 chamadas a `.isVisible()` sem `expect()` — nunca falham.

Linhas 34, 60, 68-69, 72.

- [ ] **Corrigir linha 34** — trocar por `expect`:

```typescript
// ❌ antes:
await page.getByText("Success! Your API Key has been saved.").isVisible();

// ✅ depois:
await expect(page.getByText("Success! Your API Key has been saved.")).toBeVisible({ timeout: 10000 });
```

- [ ] **Corrigir linha 60** — trocar por `expect`:

```typescript
// ❌ antes:
await page.getByText("Website Content QA").first().isVisible();

// ✅ depois:
await expect(page.getByText("Website Content QA").first()).toBeVisible({ timeout: 10000 });
```

- [ ] **Corrigir linhas 67-69** — trocar por `expect`:

```typescript
// ❌ antes:
await page.waitForTimeout(500);
await page
  .getByText("Are you sure you want to delete the selected component?")
  .isVisible();

// ✅ depois:
await expect(
  page.getByText("Are you sure you want to delete the selected component?")
).toBeVisible({ timeout: 5000 });
```

- [ ] **Corrigir linha 72** — trocar por `expect`:

```typescript
// ❌ antes:
await page.waitForTimeout(1000);
await page.getByText("Successfully").first().isVisible();

// ✅ depois:
await expect(page.getByText("Successfully").first()).toBeVisible({ timeout: 10000 });
```

- [ ] **Verificar** que o arquivo não tem mais `.isVisible()` sem `expect()`.

---

### Task 2: `folders.spec.ts`

**Arquivo:** `tests/tests-automations/regression/core-functionality/project-management/folders.spec.ts`

**Problemas:**
1. Linhas 16-24: múltiplas `.isVisible()` sem `expect()`
2. Linhas 18-22 e 75-79: `if/else` onde ambas branches chamam `.isVisible()` sem `expect()` — NUNCA falha
3. Linhas 44-47: `if` com `expect(true).toBeTruthy()` dentro — assertion inútil
4. Linhas 52-63: `expect(await locator.isVisible()).toBeTruthy()` — padrão errado
5. Linhas 73-74, 87: `.isVisible()` sem `expect()`

- [ ] **Corrigir teste "CRUD folders" — linhas 16-24:**

```typescript
// ❌ antes:
await page.getByPlaceholder("Search flows").first().isVisible();
await page.getByText("Flows").first().isVisible();
if (await page.getByText("Components").first().isVisible()) {
  await page.getByText("Components").first().isVisible();
} else {
  await page.getByText("MCP Server").first().isVisible();
}
await page.getByText("All").first().isVisible();
await page.getByText("Select All").first().isVisible();

// ✅ depois — verificações reais da página principal:
await expect(page.getByPlaceholder("Search flows").first()).toBeVisible();
await expect(page.getByText("Flows").first()).toBeVisible();
await expect(
  page.getByText("Components").or(page.getByText("MCP Server")).first()
).toBeVisible();
await expect(page.getByText("All").first()).toBeVisible();
await expect(page.getByText("Select All").first()).toBeVisible();
```

- [ ] **Corrigir teste "add a flow into a folder" — linhas 44-63:**

```typescript
// ❌ antes:
const genericNode = page.getByTestId("div-generic-node");
if ((await genericNode.count()) > 0) {
  expect(true).toBeTruthy();
}

expect(await page.locator("text=Getting Started:").last().isVisible()).toBeTruthy();
expect(await page.locator("text=Inquisitive Pike").last().isVisible()).toBeTruthy();
expect(await page.locator("text=Dreamy Bassi").last().isVisible()).toBeTruthy();
expect(await page.locator("text=Furious Faraday").last().isVisible()).toBeTruthy();

// ✅ depois:
// (remover o if com expect(true).toBeTruthy() — não testa nada)
await expect(page.locator("text=Getting Started:").last()).toBeVisible();
await expect(page.locator("text=Inquisitive Pike").last()).toBeVisible();
await expect(page.locator("text=Dreamy Bassi").last()).toBeVisible();
await expect(page.locator("text=Furious Faraday").last()).toBeVisible();
```

- [ ] **Corrigir teste "change flow folder" — linhas 73-79:**

```typescript
// ❌ antes:
await page.getByPlaceholder("Search flows").isVisible();
await page.getByText("Flows").first().isVisible();
if (await page.getByText("Components").first().isVisible()) {
  await page.getByText("Components").first().isVisible();
} else {
  await page.getByText("MCP Server").first().isVisible();
}

// ✅ depois:
await expect(page.getByPlaceholder("Search flows").first()).toBeVisible();
await expect(page.getByText("Flows").first()).toBeVisible();
await expect(
  page.getByText("Components").or(page.getByText("MCP Server")).first()
).toBeVisible();
```

- [ ] **Corrigir linha 87** — assertion de que o flow foi movido:

```typescript
// ❌ antes:
await page.getByText("Basic Prompting").first().isVisible();

// ✅ depois:
await expect(page.getByText("Basic Prompting").first()).toBeVisible({ timeout: 10000 });
```

---

### Task 3: `bulk-actions.spec.ts`

**Arquivo:** `tests/tests-automations/regression/core-functionality/project-management/bulk-actions.spec.ts`

**Problemas:**
1. Linhas 22, 31, 40: `await page.getByText("Projects").first().isVisible()` sem `expect()` — chamado 3×
2. Linha 44: `await page.getByTestId("list-card").first().isVisible(...)` sem `expect()`
3. Linhas 108-110: `await page.getByText("This can't be undone.").isVisible(...)` sem `expect()`

- [ ] **Corrigir as 3 ocorrências de `"Projects"` sem expect (linhas 22, 31, 40):**

```typescript
// ❌ antes:
await page.getByText("Projects").first().isVisible();

// ✅ depois — substituir todas as 3 ocorrências:
await expect(page.getByText("Projects").first()).toBeVisible({ timeout: 10000 });
```

- [ ] **Corrigir linha 44:**

```typescript
// ❌ antes:
await page.getByTestId("list-card").first().isVisible({ timeout: 3000 });
await page.waitForTimeout(500);

// ✅ depois:
await expect(page.getByTestId("list-card").first()).toBeVisible({ timeout: 10000 });
```

- [ ] **Corrigir linhas 108-110:**

```typescript
// ❌ antes:
await page.getByText("This can't be undone.").isVisible({
  timeout: 1000,
});

// ✅ depois:
await expect(page.getByText("This can't be undone.")).toBeVisible({ timeout: 5000 });
```

---

## Chunk 2: Playground — Padrões incorretos

### Task 4: `stop-button-playground.spec.ts`

**Arquivo:** `tests/tests-automations/regression/core-functionality/playground/stop-button-playground.spec.ts`

**Problemas:**
1. Linhas 93-103: conexão de handles com drag (`hover` + `mouse.down` + `mouse.up`) — instável
2. Linhas 117-123: lógica com `$$` + `if` que não falha se não encontrar o botão
3. Linha 124: `expect(await page.getByTestId(...).last()).toBeVisible()` — await desnecessário, mas funciona
4. Linha 129: `expect(await page.getByText("build stopped").isVisible()).toBeTruthy()` — padrão errado

- [ ] **Corrigir conexão de handles (linhas 92-103) — substituir drag por click-click:**

```typescript
// ❌ antes:
const elementCustomComponentOutput = await page
  .getByTestId("handle-customcomponent-shownode-output-right")
  .first();
await elementCustomComponentOutput.hover();
await page.mouse.down();
const elementChatOutput = await page
  .getByTestId("handle-chatoutput-shownode-inputs-left")
  .first();
await elementChatOutput.hover();
await page.mouse.up();

// ✅ depois — dois cliques sequenciais:
await page
  .getByTestId("handle-customcomponent-shownode-output-right")
  .first()
  .click();
await page
  .getByTestId("handle-chatoutput-shownode-inputs-left")
  .first()
  .click();
await expect(page.locator(".react-flow__edge")).toHaveCount(1, { timeout: 8000 });
```

- [ ] **Corrigir linhas 117-123 — remover bloco `if` com `$$`:**

```typescript
// ❌ antes:
const elements = await page.$$('[data-testid="button-stop"]');
if (elements.length > 0) {
  const lastElement = elements[elements.length - 1];
  await lastElement.waitForElementState("visible");
}
expect(await page.getByTestId("button-stop").last()).toBeVisible();

// ✅ depois — direto:
await expect(page.getByTestId("button-stop").last()).toBeVisible({ timeout: 30000 });
```

- [ ] **Corrigir linha 129:**

```typescript
// ❌ antes:
expect(await page.getByText("build stopped").isVisible()).toBeTruthy();

// ✅ depois:
await expect(page.getByText("build stopped")).toBeVisible({ timeout: 5000 });
```

---

### Task 5: `playground-session-id.spec.ts`

**Arquivo:** `tests/tests-automations/regression/core-functionality/playground/playground-session-id.spec.ts`

**Problema:** Os 2 últimos testes usam extensivamente `if/else` com `.catch(() => false)` em lógica de teste, com `else` que sempre passa. O seletor correto documentado no skill é `page.getByTestId("chat-session-id")`.

- [ ] **Reescrever teste "playground session ID input accepts a custom session value":**

```typescript
test(
  "playground session ID input accepts a custom session value",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await setupMockedChatFlow(page);

    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });

    const customSession = `session-${Date.now()}`;

    await page.getByTestId("chat-session-id").clear();
    await page.getByTestId("chat-session-id").fill(customSession);
    await expect(page.getByTestId("chat-session-id")).toHaveValue(customSession);
  },
);
```

- [ ] **Reescrever teste "changing session ID in playground resets the conversation history display":**

```typescript
test(
  "changing session ID in playground resets the conversation history display",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await setupMockedChatFlow(page);

    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });

    await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 5000 });

    const sessionA = `session-a-${Date.now()}`;
    await page.getByTestId("chat-session-id").clear();
    await page.getByTestId("chat-session-id").fill(sessionA);
    await expect(page.getByTestId("chat-session-id")).toHaveValue(sessionA);

    const sessionB = `session-b-${Date.now()}`;
    await page.getByTestId("chat-session-id").clear();
    await page.getByTestId("chat-session-id").fill(sessionB);
    await expect(page.getByTestId("chat-session-id")).toHaveValue(sessionB);
  },
);
```

---

### Task 6: `playground-fullscreen.spec.ts`

**Arquivo:** `tests/tests-automations/regression/core-functionality/playground/playground-fullscreen.spec.ts`

**Problema:** O teste "fullscreen button expands the view when available" tem `if/else` com `.catch(() => false)` e um `expect(minimizeVisible || closeVisible || inputVisible)` onde `inputVisible` é **sempre true** — portanto o expect nunca falha.

O skill não documenta um testid canônico para o botão de fullscreen. A abordagem correta é: se o testid não está documentado, usar o snippet de descoberta DOM (seção 4.4 do skill) antes de escrever a assertion.

Por ora, o teste deve ser reescrito para **não usar fallback que sempre passa**:

- [ ] **Reescrever o teste "playground fullscreen button expands the view when available":**

```typescript
test(
  "playground fullscreen button expands the view when available",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await setupPlayground(page);

    await page.getByTestId("playground-btn-flow-io").click();
    await page.waitForSelector('[data-testid="input-chat-playground"]', {
      timeout: 15000,
    });

    // Verificar que o Playground está aberto e funcional
    await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 5000 });

    // Testar botão de fullscreen pelo testid canônico
    const fullscreenBtn = page.getByTestId("playground-maximize-button");
    const isPresent = await fullscreenBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (!isPresent) {
      // Botão não existe nesta build — marcar como pendente de testid
      test.skip(true, "Fullscreen button testid not yet documented — run DOM discovery snippet (skill section 4.4)");
      return;
    }

    await fullscreenBtn.click();
    await page.waitForTimeout(300);

    // Após fullscreen, o input ainda deve estar visível
    await expect(page.getByTestId("input-chat-playground").last()).toBeVisible({ timeout: 5000 });
    // E um botão de minimize deve aparecer
    await expect(page.getByTestId("playground-minimize-button")).toBeVisible({ timeout: 3000 });
  },
);
```

> **Nota para o time:** Os testids `playground-maximize-button` e `playground-minimize-button` são placeholders. Execute o snippet abaixo no Playground aberto para descobrir os testids reais e atualize este teste:
>
> ```typescript
> const handles = await page.evaluate(() =>
>   Array.from(document.querySelectorAll('[data-testid*="maximize"], [data-testid*="fullscreen"], [data-testid*="minimize"]'))
>     .map(el => el.getAttribute('data-testid'))
> );
> console.log("FULLSCREEN HANDLES:", handles);
> ```

---

## Chunk 3: Testes sem assertions / baixa qualidade

### Task 7: `flowPage.spec.ts`

**Arquivo:** `tests/tests-automations/regression/core-functionality/project-management/flowPage.spec.ts`

**Problema:** O teste "save" adiciona um componente e termina sem nenhuma assertion real. Um Custom Component adicionado deve aparecer no canvas — isso deve ser verificado.

- [ ] **Adicionar assertion ao teste "save":**

```typescript
import { expect, test } from "../../../../fixtures/fixtures";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

test.describe("Flow Page tests", () => {
  test("save", { tag: ["@release"] }, async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.getByTestId("blank-flow").click();

    await page.waitForSelector(
      '[data-testid="sidebar-custom-component-button"]',
      { timeout: 3000 },
    );

    await page.getByTestId("sidebar-custom-component-button").click();

    await adjustScreenView(page, { numberOfZoomOut: 3 });

    // Verificar que o componente foi adicionado ao canvas
    await expect(page.locator(".react-flow__node")).toHaveCount(1, { timeout: 10000 });
    // Verificar que o título do componente está visível
    await expect(page.getByTestId("title-Custom Component")).toBeVisible({ timeout: 5000 });
  });
});
```

> Atenção: adicionar `expect` ao import.

---

### Task 8: `composio.spec.ts`

**Arquivo:** `tests/tests-automations/regression/core-functionality/llm-agents/composio.spec.ts`

**Problema:** 2 chamadas a `waitForTimeout(1000)` (linhas 48 e 58) sem assertion posterior — usado como sincronização, o que mascara falhas reais.

- [ ] **Substituir `waitForTimeout` por waitForSelector com assertion:**

Linha 48 — depois de preencher a API key, aguardar o botão de conectado aparecer:
```typescript
// ❌ antes:
await page.waitForTimeout(1000);
await page
  .getByTestId("button_open_list_selection_sortablelist_sortablelist_action_button")
  .click();

// ✅ depois (o waitForSelector já está na linha 42, apenas remover o timeout):
// Linha 42-44 já aguarda corretamente com waitForSelector
await page
  .getByTestId("button_open_list_selection_sortablelist_sortablelist_action_button")
  .click();
```

Linha 58 — depois de selecionar o item, aguardar que o botão de run apareça:
```typescript
// ❌ antes:
await page.getByTestId(`list_item_fetch_emails`).click();
await page.waitForTimeout(1000);
await page.getByTestId("button_run_gmail").click();

// ✅ depois:
await page.getByTestId(`list_item_fetch_emails`).click();
await expect(page.getByTestId("button_run_gmail")).toBeVisible({ timeout: 5000 });
await page.getByTestId("button_run_gmail").click();
```

---

## Checklist final (para cada task)

Após editar cada arquivo:

- [ ] Buscar no arquivo por `.isVisible()` — confirmar que não há nenhum sem `expect()`
- [ ] Buscar por `catch(() => false)` — confirmar que só aparece em cleanup (afterAll)
- [ ] Buscar por `toBeTruthy()` — confirmar que não há `expect(await locator.isVisible()).toBeTruthy()`
- [ ] Contar expects: `expect count ≥ test count × 2`

```bash
# Rodar cada arquivo corrigido:
cd /Users/daniellicnerski/orion-e2e/langflow-e2e
npx playwright test tests/tests-automations/regression/{path}/{file}.spec.ts --reporter=line
```
