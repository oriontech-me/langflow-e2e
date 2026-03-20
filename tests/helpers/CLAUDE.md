# helpers — Catálogo de utilitários

Todos os helpers ficam nesta pasta. Antes de criar um novo, verifique se já existe algo adequado aqui.

---

## Estrutura

```
helpers/
├── auth/           # Autenticação e criação de usuários
├── flows/          # Manipulação de flows no canvas
├── ui/             # Interações com a interface (zoom, scroll, drag)
├── other/          # Bootstrap e setup geral
├── provider-setup/ # Setup de providers OpenAI, Anthropic, Google
├── filesystem/     # Upload de arquivos
├── api/            # Utilitários para testes de API REST
└── mcp/            # Utilitários para testes MCP
```

---

## auth/

| Helper | O que faz |
|---|---|
| `get-auth-token.ts` | Obtém Bearer token via `/api/v1/auto_login`. Usar em testes `{ request }` |
| `login-langflow.ts` | Faz login via UI (preenche usuário/senha na tela de login) |
| `auth-helpers.ts` | Funções auxiliares de autenticação |
| `add-new-user-and-loggin.ts` | Cria novo usuário via API e loga com ele |

```typescript
// Uso típico em teste de API
const authToken = await getAuthToken(request);
const res = await request.get("/api/v1/flows/", {
  headers: { Authorization: authToken },
});
```

---

## flows/

| Helper | O que faz |
|---|---|
| `add-custom-component.ts` | Clica em `sidebar-custom-component-button` até adicionar um Custom Component |
| `add-legacy-components.ts` | Habilita componentes legados no modal de aviso |
| `clean-all-flows.ts` | Deleta todos os flows via API (útil em teardown) |
| `rename-flow.ts` | Renomeia um flow pelo header da página |
| `run-chat-output.ts` | Clica em `button_run_chat output` e espera `built successfully` |
| `update-old-components.ts` | Clica em "Update All" para atualizar componentes desatualizados |
| `load-simple-agent-with-openai.ts` | Carrega o template Simple Agent com OpenAI |
| `lock-flow.ts` | Bloqueia um flow (ícone de cadeado) |
| `add-flow-to-test-on-empty-langflow.ts` | Adiciona flow de teste via API quando não há flows |

---

## ui/

| Helper | O que faz |
|---|---|
| `adjust-screen-view.ts` | Faz fit-view no canvas. Aceita `{ numberOfZoomOut }` para zoom out extra |
| `zoom-out.ts` | Aplica zoom out N vezes via atalho de teclado |
| `unselect-nodes.ts` | Clica em área vazia do canvas para desselecionar tudo |
| `simulate-drag-and-drop.ts` | Simula drag-and-drop de arquivo para o canvas |
| `go-to-settings.ts` | Navega para Settings via `user_menu_button` → `menu_settings_button` |
| `open-advanced-options.ts` | Abre o painel de opções avançadas de um nó |
| `wait-for-open-modal.ts` | Espera um modal ficar visível |

```typescript
// Uso típico
await adjustScreenView(page);                        // fit-view
await adjustScreenView(page, { numberOfZoomOut: 3 }); // fit-view + zoom out 3x
await zoomOut(page, 2);                               // zoom out 2x
```

---

## other/

| Helper | O que faz |
|---|---|
| `await-bootstrap-test.ts` | Navega para `/` e espera `mainpage_title`. Sempre usar no início do teste |
| `initialGPTsetup.ts` | Chama `adjustScreenView` + `updateOldComponents` + `setupOpenAI` |

```typescript
await awaitBootstrapTest(page);
await awaitBootstrapTest(page, { skipModal: true }); // pula modal de "Get Started"
```

---

## provider-setup/

| Helper | O que faz |
|---|---|
| `setup-openai.ts` | Configura OpenAI no painel de Model Providers |
| `setup-anthropic.ts` | Configura Anthropic no painel de Model Providers |
| `setup-google.ts` | Configura Google Generative AI no painel de Model Providers |
| `collect-models.ts` | Valida providers via API + coleta modelos da UI → `providers.json` / `models.json` |

Todos os setup-*.ts esperam um nó com `data-testid="model_model"` no canvas antes de abrir o painel.

---

## Regras

- **Nunca duplicar lógica** — se o comportamento já existe aqui, importe e use
- **Helpers são stateless** — recebem `page` como parâmetro, não guardam estado
- **Nomes em kebab-case** — `meu-helper.ts`, não `meuHelper.ts`
- **Exportar como função nomeada** — não usar `export default`
