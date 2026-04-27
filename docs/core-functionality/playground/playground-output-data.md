# Spec: Playground Output – Structured Data

**Arquivo de teste:** `tests/tests-automations/regression/core-functionality/playground/playground-output-data.spec.ts`

## O que este teste valida

Verifica que o Playground renderiza corretamente saídas de dados estruturados gerados pelo componente Mock Data:

1. `data_output` (tipo `JSON`) é serializado via `_serialize_data` e exibido como um bloco de código JSON (`\`\`\`json`) no chat.
2. `dataframe_output` (tipo `Table`) é serializado via `df.to_markdown(index=False)` e exibido como uma tabela Markdown no chat.

## Tags

`@stable` `@release` `@regression` `@playground`

## Critério de validação

| Teste | Critério |
|---|---|
| JSON Data output como code block | Mensagem do chat contém elemento `<code>` e o texto inclui `"records"` (chave raiz do JSON serializado) |
| DataFrame output como tabela Markdown | Mensagem do chat contém elemento `<table>` renderizado pelo react-markdown com remarkGfm |

## Dependências externas

Nenhuma. Os testes usam o componente **Mock Data** nativo do Langflow — nenhuma API key ou LLM é necessário.

## Última validação

1.10.x
