# playground — Testes do Chat Playground

Testes que validam a interface de chat do Playground: envio de mensagens, histórico, sessão, botão de stop, fullscreen, etc.

---

## Setup padrão do Playground

A maioria dos testes precisa de um flow com ChatInput conectado ao ChatOutput. Padrão:

```typescript
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import { zoomOut } from "../../../../helpers/ui/zoom-out";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";

async function setupChatFlow(page: Page) {
  await awaitBootstrapTest(page);
  await page.getByTestId("blank-flow").click();

  // Adiciona ChatOutput via hover → click
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await page.waitForSelector('[data-testid="input_outputChat Output"]', { timeout: 30000 });
  await page
    .getByTestId("input_outputChat Output")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-chat-output").click();
    });

  await zoomOut(page, 2);

  // Adiciona ChatInput via drag (posição diferente para não sobrepor)
  await page.getByTestId("sidebar-search-input").fill("chat input");
  await page.waitForSelector('[data-testid="input_outputChat Input"]', { timeout: 30000 });
  await page.getByTestId("input_outputChat Input").dragTo(
    page.locator('//*[@id="react-flow-id"]'),
    { targetPosition: { x: 100, y: 100 } },
  );

  await adjustScreenView(page);

  // Conecta ChatInput → ChatOutput
  await page.getByTestId("handle-chatinput-noshownode-chat message-source").click();
  await page.getByTestId("handle-chatoutput-noshownode-inputs-target").click();
}
```

---

## Mockar o backend (sem LLM real)

Para testes que não precisam de resposta real de LLM, mocke o endpoint de run:

```typescript
await page.route("**/api/v1/run/**", async (route: import("@playwright/test").Route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      outputs: [{ outputs: [{ results: { message: { text: "Mock response" } } }] }],
      session_id: "test-session",
    }),
  });
});
```

---

## Seletores principais

| Elemento | Seletor |
|---|---|
| Input do chat | `[data-testid="input-chat-playground"]` |
| Botão enviar | `[data-testid="button-send"]` |
| Mensagem do chat | `[data-testid="div-chat-message"]` |
| Botão Playground | `[data-testid="playground-btn-flow-io"]` |
| Botão Stop | `getByRole("button", { name: "Stop" })` |
| Campo Session ID | `[data-testid="session-id-input"]` (ou similar) |

---

## Armadilhas comuns

### 1. ChatInput e ChatOutput sobrepostos
Se ambos forem adicionados no centro, ficam sobrepostos e os handles não são clicáveis. Use `dragTo` com `targetPosition` para o segundo componente.

### 2. Botão Playground bloqueado pelo painel
Ao fechar o playground, o painel pode cobrir o botão. Use JavaScript click como fallback:
```typescript
await page.evaluate(() => {
  const btn = document.querySelector('[data-testid="playground-btn-flow-io"]') as HTMLElement;
  if (btn) btn.click();
}).catch(() => {});
```

### 3. Usar `.last()` nos seletores
O playground pode ter múltiplos elementos com o mesmo testId. Sempre use `.last()`:
```typescript
await page.getByTestId("input-chat-playground").last().fill("mensagem");
await page.getByTestId("button-send").last().click();
```

### 4. Testes de playground NÃO precisam de --workers=1
Diferente dos testes de agente, os testes de playground podem rodar em paralelo desde que cada um crie seu próprio flow (blank-flow).

---

## Tags

```typescript
{ tag: ["@playground"] }                      // mínimo
{ tag: ["@playground", "@regression"] }       // para regressão de UI
{ tag: ["@playground", "@agents"] }           // quando o flow usa LLM real
```

---

## Quando usar mock vs LLM real

| Situação | Abordagem |
|---|---|
| Testar UI do playground (input, botões, histórico) | Mock o endpoint `/api/v1/run/**` |
| Testar que o agente responde corretamente | LLM real via `SimpleAgentTemplatePage` |
| Testar stop button | LLM real (precisa de latência real para parar) |
