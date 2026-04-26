# Loop Component — Renderização, Erro e Iteração

**Última validação:** Langflow 1.10.x

---

## O que este teste valida *(obrigatório)*

Valida três comportamentos fundamentais do componente Loop no canvas do Langflow:

1. **Renderização correta** — o nó aparece no canvas com todos os handles esperados (`inputs-left`, `item-left`, `item-right`, `done-right`) e com os botões de inspeção de output presentes no rodapé do nó.
2. **Caminho de erro sem conexões** — executar o Loop sem nenhuma conexão exibe a notificação "Flow build failed" sem travar a interface; o nó permanece intacto e o botão de run continua acessível.
3. **Iteração real via template** — usando o template "Research Translation Loop", o Loop itera sobre 2 artigos do ArXiv e produz uma resposta agregada no Playground contendo pelo menos 2 menções a "Title", confirmando que o loop completou ambas as iterações.

Se qualquer um destes testes falhar, o componente Loop está quebrado no produto: seja na renderização, no tratamento de erros, ou na execução real do ciclo de iteração.

---

## Tags *(obrigatório)*

`@stable` `@release` `@components` `@templates` `@playground`

---

## Passo a passo *(obrigatório)*

**Teste 1 — renders correctly with all handles and output inspection buttons**
1. Navegar para a home e criar um flow em branco
2. Pesquisar "Loop" na sidebar e adicionar o componente ao canvas via `add-component-button-loop`
3. Ajustar zoom com `adjustScreenView`
4. Verificar que `title-Loop` e `button_run_loop` estão visíveis
5. Verificar os 4 handles: `handle-loopcomponent-shownode-inputs-left`, `handle-loopcomponent-shownode-item-left`, `handle-loopcomponent-shownode-item-right`, `handle-loopcomponent-shownode-done-right`
6. Verificar os botões de inspeção: `output-inspection-item-loopcomponent`, `output-inspection-done-loopcomponent`

**Teste 2 — run without connections shows build failed notification**
1. Criar flow em branco e adicionar o Loop component
2. Chamar `page.allowFlowErrors()` para indicar que erros de flow são esperados
3. Clicar em `button_run_loop`
4. Aguardar e confirmar que aparece o texto "Flow build failed"
5. Verificar que `button_run_loop` ainda está acessível e `title-Loop` ainda está visível com um único nó no canvas

**Teste 3 — Research Translation Loop template: full wiring and iterates over 2 ArXiv papers**
1. Navegar para "All Templates" e aguardar o card `template-research-translation-loop`
2. Clicar no template e aguardar `title-Loop` aparecer
3. Verificar que existem arestas no canvas (confirma wiring do template)
4. Verificar os 4 handles do Loop (mesmo critério do Teste 1)
5. Alterar `int_int_max_results` para `2` (limitar o ArXiv a 2 resultados)
6. Abrir o Playground via `playground-btn-flow-io`
7. Digitar "transformer neural networks" no `input-chat-playground` e enviar
8. Aguardar `chat-message-AI-*` aparecer (timeout 120 s)
9. Extrair o texto da última mensagem AI e contar ocorrências de "title" (case-insensitive); deve ser ≥ 2

---

## Critério de validação *(obrigatório)*

- Todos os 4 handles (`inputs-left`, `item-left`, `item-right`, `done-right`) estão visíveis no nó
- Os 2 botões de inspeção de output (`item`, `done`) estão visíveis no rodapé do nó
- Executar sem conexões produz notificação "Flow build failed" sem crash; nó e botão de run permanecem acessíveis
- O template "Research Translation Loop" carrega com arestas visíveis (wiring intacto)
- A resposta final no Playground contém ≥ 2 ocorrências da palavra "title", confirmando 2 iterações completas do loop

---

## Dependências externas *(obrigatório)*

- `src/lfx/src/lfx/components/flow_controls/loop.py` — implementação do LoopComponent; mudanças nas portas `inputs`, `item`, `done` ou no display name quebram os seletores de handle
- `src/backend/base/langflow/initial_setup/starter_projects/Research Translation Loop.json` — template carregado no Teste 3; renomear ou remover o template quebra o seletor `template-research-translation-loop`
- `src/frontend/src/CustomNodes/GenericNode/components/NodeOutputParameter/` — renderiza os botões de inspeção de output; mudanças no padrão `output-inspection-{port}-{component}` quebram os seletores do Teste 1
- `src/frontend/src/CustomNodes/GenericNode/` — renderiza os handles; padrão `handle-{component}-shownode-{port}-{side}` deve se manter estável

---

## O que este teste não cobre *(opcional)*

- Condição de saída do loop (porta `done` ativada por critério do LLM): coberta separadamente por issue futura no QA-CHECKLIST
- Comportamento com DataFrames muito grandes ou loops de centenas de iterações
- Cancelamento de execução no meio de um loop em andamento
- Modo de execução com modelos que não o padrão do template

---

## Pré-condições *(opcional)*

- Langflow rodando e acessível em `PLAYWRIGHT_BASE_URL`
- Testes 1 e 2 não precisam de API key (sem execução de LLM)
- Teste 3 usa o ArXiv (API pública, sem key), mas o template inclui um modelo LLM — verificar se a instância tem um modelo padrão configurado ou se é necessário um `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` no `.env`
- Os testes rodam em modo `serial` para evitar erros 400 de autosave paralelo ("flow must be unique")

---

## Quando revisar este teste *(opcional)*

- Se o componente Loop for renomeado ou suas portas mudarem de nome
- Se o template "Research Translation Loop" for renomeado, removido ou tiver seu wiring alterado
- Se o padrão de `data-testid` dos handles ou botões de output inspection mudar no frontend

---

## Notas *(opcional)*

- O timeout do Teste 3 é de 120 s para a resposta do LLM — o template faz 2 chamadas sequenciais ao modelo (uma por artigo ArXiv); aumentar `max_results` além de 2 torna o teste mais lento sem ganho de cobertura
- O critério de validação conta ocorrências de "title" (case-insensitive) na resposta agregada: o Parser formata cada artigo como `Title: {titulo}\nSummary: {resumo}`, portanto 2 artigos garantem ≥ 2 "title" no output final
- `allowFlowErrors()` é necessário no Teste 2 para desativar o monitor automático de erros de flow injetado pelo fixture
