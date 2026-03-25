# [Nome do Spec]

## Objetivo *(obrigatório)*
Validar que o usuário consegue fazer upload de um arquivo, processá-lo e visualizar os vetores gerados.

---

## Passo a passo *(obrigatório)*
1. Acessar a página de Knowledge Base
2. Clicar em "Upload File" e selecionar um `.pdf` válido
3. Aguardar o processamento completar (spinner desaparecer)
4. Navegar para a aba "Vectors"
5. Verificar que os chunks gerados estão listados

---

## Critério de validação *(obrigatório)*
- O arquivo aparece na lista com status `processed`
- A aba "Vectors" exibe ao menos 1 chunk
- Nenhum erro é exibido na interface durante o fluxo

---

## Pré-condições *(opcional)*
- Usuário autenticado com permissão de escrita
- Arquivo `sample.pdf` presente em `fixtures/files/`

---

## Dependências externas *(obrigatório)*
<!-- Arquivos do repositório do Langflow que, se alterados, podem quebrar este teste.
     Esta lista é lida pelo workflow de monitoramento — preencha com atenção. -->

- `src/lfx/src/lfx/components/files_and_knowledge/file.py` — lógica de upload e processamento do File Component
- `src/lfx/src/lfx/components/files_and_knowledge/vector_store.py` — geração e listagem de vetores

---

## Critério de revisão *(opcional)*
- Revisar se o comportamento do spinner ou dos status labels mudar na UI
- Revisar se o formato de resposta da API de vetores for alterado

---

## Notas *(opcional)*
- O processamento pode levar até 10s em ambiente de CI — o teste usa `waitForSelector` com timeout estendido
- Flaky em arquivos maiores que 5MB; manter fixture abaixo desse limite