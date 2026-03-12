# Langflow E2E

Testes de regressão end-to-end do [Langflow](https://github.com/langflow-ai/langflow) com Playwright.

O repositório é **independente do código-fonte do Langflow** — os testes apontam para qualquer instância via URL, sem precisar clonar ou buildar o projeto.

---

## Setup

```bash
git clone https://github.com/lice-reis/langflow-e2e.git
cd langflow-e2e
npm install
npx playwright install chromium --with-deps
cp .env.example .env  # ajuste PLAYWRIGHT_BASE_URL se necessário
```

**Pré-requisitos:** Node.js 20+, Playwright 1.57+ (instalado via `npm install`), Docker (opcional).

---

## Subindo o Langflow

```bash
# Docker — nightly (padrão)
./scripts/start-langflow-docker.sh

# Docker — versão específica
LANGFLOW_IMAGE_TAG=1.3.0 ./scripts/start-langflow-docker.sh

# Instância externa (staging, PR branch, local já no ar)
# Apenas defina PLAYWRIGHT_BASE_URL no .env ou na linha de comando
```

> Para testar uma branch específica: faça checkout da branch no repo do Langflow, suba com `uv run langflow run`, e aponte `PLAYWRIGHT_BASE_URL=http://localhost:7860`.

---

## Rodando os testes

```bash
npm test                        # suíte completa
npm run test:core               # somente testes core (obrigatórios para release)
npm run test:extended           # somente testes extended
npm run test:regression         # somente regressão de bugs
npx playwright test --grep "@api"       # por tag
npx playwright test path/ao/arquivo.spec.ts  # arquivo específico
npm run report                  # abre o último relatório HTML
```

---

## Tags disponíveis

| Tag | Quando usar |
|---|---|
| `@release` | Caminho feliz — validação antes de deploy |
| `@regression` | Bugs corrigidos que não podem voltar |
| `@api` | Mudanças em endpoints de backend |
| `@components` | Mudanças em componentes do canvas |
| `@workspace` | Mudanças em flows, pastas ou canvas |
| `@database` | Testes com estado persistido |
| `@mainpage` | Mudanças na página principal |

Todo teste novo deve ter **pelo menos uma tag** e importar de `../../fixtures` (não do Playwright diretamente).

---

## Estrutura

```
tests/
├── core/         # obrigatórios — features, integrations, unit, regression
├── extended/     # complementares — edge cases, regressões complexas
├── pages/        # Page Objects
├── utils/        # funções compartilhadas
└── fixtures.ts   # fixture base com monitoramento automático de erros de backend
```

A `fixtures.ts` intercepta erros `4xx/5xx` e falhas silenciosas de flow em toda execução — se o backend errar mas a UI não mostrar, o teste falha mesmo assim.

---

## Como validar um teste existente

Antes de marcar um cenário como coberto no checklist, o time deve seguir este processo:

**1. Rode o teste isolado com relatório completo**
```bash
PLAYWRIGHT_BASE_URL=http://localhost:7860 npx playwright test caminho/do/teste.spec.ts --reporter=html --trace=on
npx playwright show-report
```
No relatório, verifique se os `test.step()` descritos no código correspondem ao que aconteceu na tela (screenshots + log de rede).

**2. Confirme que os passos do teste estão documentados**

Cada teste deve ter `test.step()` descrevendo o que cada bloco faz. Se não tiver, adicione antes de validar. Exemplo:
```typescript
await test.step("Log in with valid credentials and confirm main page loads", async () => { ... });
await test.step("Reload page and confirm session was cleared — login screen must appear", async () => { ... });
```

**3. Force uma falha para confirmar que não é falso positivo**

Comente ou inverta a asserção principal do teste e rode novamente. O teste **deve falhar**. Se passar mesmo com a asserção quebrada, o cenário não está sendo validado de verdade.

```typescript
// Antes
expect(isLoggedIn).toBeFalsy();

// Para testar: inverta e confirme que falha
expect(isLoggedIn).toBeTruthy(); // deve falhar → reverta depois
```

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

## CI (GitHub Actions)

| Workflow | Gatilho | O que faz |
|---|---|---|
| `nightly.yml` | Diário 03h BRT + manual | Roda tudo contra `langflow-nightly:latest`, abre issue se falhar |
| `manual.yml` | Manual | Roda contra qualquer tag Docker ou URL externa, filtra por suite/tag |
| `file-watcher.yml` | Diário 05h BRT | Monitora mudanças no source do Langflow e abre issue de revisão |

---

## Regression Checklist

Veja [`REGRESSION_CHECKLIST.md`](./REGRESSION_CHECKLIST.md) para o mapa completo de cobertura.

| Símbolo | Significado |
|---|---|
| `[x]` | Automatizado |
| `[ ]` | Não coberto |
| `[~]` | Parcialmente coberto |
| `[!]` | Flaky — precisa estabilizar |
