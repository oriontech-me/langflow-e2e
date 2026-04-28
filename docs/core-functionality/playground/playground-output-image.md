# Spec: Playground Output – Image Upload

**Arquivo de teste:** `tests/tests-automations/regression/core-functionality/playground/playground-output-image.spec.ts`

## O que este teste valida

Verifica que o Playground lida corretamente com upload de imagem via chat input:

1. Após anexar uma imagem, um preview compacto aparece na área de input antes do envio.
2. Após enviar a mensagem, a imagem é renderizada na bolha da mensagem do usuário no histórico de chat.

## Tags

`@regression` `@playground`

## Critério de validação

| Teste | Critério |
|---|---|
| Preview compacto no input | `img[alt="chain.png"]` visível dentro de `[data-testid="input-wrapper"]` após `setInputFiles()` |
| Imagem renderizada na mensagem do usuário | `img[src*="/files/images/"]` visível após envio e resposta do bot — o servidor prefixa o nome do arquivo com timestamp, então o seletor usa `src` em vez de `alt` |

## Dependências externas

Nenhuma. O flow usa apenas ChatInput → ChatOutput (echo) — nenhuma API key ou LLM é necessária.

## Última validação

1.10.x
