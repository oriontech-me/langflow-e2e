# provider-invalid-auth-error

**Última validação:** Langflow 1.10.x

---

## O que este teste valida *(obrigatório)*

Valida que o Langflow exibe uma mensagem de erro ao usuário quando ele tenta salvar uma API key inválida na tela de configuração de Model Providers (Settings → Model Providers). A chave não deve ser aceita e o provider não deve ser configurado com sucesso.

Protege contra regressões na integração entre o frontend (ProviderConfigurationForm) e o endpoint `POST /api/v1/models/validate-provider`, que valida a credencial contra o provider externo antes de persistir.

---

## Tags *(obrigatório)*

`@stable` `@regression` `@model-provider` `@agents`

---

## Passo a passo *(obrigatório)*

1. Navega para Settings → Model Providers → [provider]
2. Preenche o campo de API key com uma chave inválida (ex: `sk-invalid-openai-key-for-testing-12345`)
3. Clica em "Save Configuration"
4. Aguarda o toast de erro `.error-build-message` com texto correspondente a "Invalid API key"
5. (finally) Restaura a chave válida original do provider

O teste é parametrizado: roda para cada provider que tiver env var configurada (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`).

---

## Critério de validação *(obrigatório)*

- O toast `.error-build-message` deve ficar visível após clicar em Save com chave inválida
- O texto do toast deve corresponder a `/Invalid API key/i`
- O timeout é de 30 segundos pois a validação faz uma chamada HTTP real ao provider externo

---

## Dependências externas *(obrigatório)*

- `src/frontend/src/modals/modelProviderModal/components/ProviderConfigurationForm.tsx` — renderiza o formulário de API key e dispara o toast de erro
- `src/frontend/src/modals/modelProviderModal/hooks/useProviderConfiguration.ts` — lógica de validação, chama o endpoint e gerencia o estado `validationState`
- `src/frontend/src/alerts/error/index.tsx` — componente visual do toast `.error-build-message`
- `src/backend/base/langflow/api/v1/models.py` — endpoint `POST /api/v1/models/validate-provider`
- `src/backend/base/langflow/services/credentials.py` — função `validate_model_provider_key`, que testa a key contra o provider e retorna `"Invalid API key for {provider}"`

---

## O que este teste não cobre *(opcional)*

- Validação de keys com formato correto mas expiradas ou revogadas (comportamento idêntico, mas depende do estado da key no provider)
- Providers além de OpenAI, Anthropic e Google (ex: IBM WatsonX, Ollama)
- Persistência do estado após erro (verificar que a key anterior permanece ativa)

---

## Pré-condições *(opcional)*

- Pelo menos uma env var de provider configurada no `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` ou `GOOGLE_API_KEY`)
- Langflow rodando e acessível via `PLAYWRIGHT_BASE_URL`
- Acesso à internet para que o backend consiga chamar o provider externo durante a validação

---

## Notas *(opcional)*

- O timeout de 30s no `expect` é necessário porque o backend faz `llm.invoke("test")` contra o provider real — a resposta de erro do provider pode levar vários segundos
- O `data-testid` dos providers na sidebar segue o padrão `provider-item-{NomeDoProvider}` (ex: `provider-item-OpenAI`)
