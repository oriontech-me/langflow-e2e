## Tipo

<!-- Marque com [x] o tipo desta PR -->

- [ ] `feat` — novo teste ou novo helper/page object
- [ ] `fix` — correção de teste quebrado ou flaky
- [ ] `chore` — CI, checklist, dependências, refatoração interna
- [ ] `docs` — atualização de documentação

---

## O que esta PR faz

<!-- Descreva o que foi adicionado, corrigido ou alterado. Seja direto. -->

---

## Testes cobertos

<!-- Preencha apenas para PRs do tipo feat ou fix que adicionam ou modificam testes.
     Descreva o comportamento do sistema que cada teste valida — não os passos,
     mas a propriedade que quebraria em caso de regressão.
     Apague esta seção se não se aplicar. -->

| # | Teste | O que valida |
|---|---|---|
| 1 | `` | |
| 2 | `` | |

---

## Como os testes foram construídos

<!-- Descreva decisões de implementação não óbvias: uso de interceptação de API,
     injeção de dados, flows pré-construídos, mocks, ou qualquer mecanismo indireto.
     Justifique por que a abordagem direta via UI não era viável ou adequada.
     Apague esta seção se todos os testes interagem diretamente pela UI sem mecanismos especiais. -->

---

## Dependências

<!-- Liste o que precisa estar em ordem para o teste rodar corretamente:
     - PRs ou helpers que devem estar mergeados antes
     - Variáveis de ambiente necessárias (.env), especialmente se usa LLM
     - Modo de execução (serial/paralelo) e justificativa
     - afterEach de cleanup e o que ele descarta
     Apague esta seção se não houver dependências não óbvias. -->

---

## O que esta PR não cobre

<!-- Declare o escopo negativo: comportamentos relacionados que estão fora desta PR e por quê.
     Apague esta seção se o escopo for evidente pelo título e descrição. -->

---

## Limitações conhecidas

<!-- Registre workarounds, timeouts empíricos, race conditions aceitas ou qualquer
     decisão que um mantenedor futuro precisaria entender.
     Apague esta seção se não houver limitações. -->

---

## Issue relacionada

<!-- Preencha se esta PR resolver uma issue gerada pelo file-watcher ou um bug rastreado.
     Caso contrário, apague esta seção. -->

Closes #

---

## Validação

<!-- Para PRs do tipo feat ou fix, descreva como o teste foi validado.
     Para chore e docs, descreva o que foi verificado (ex: tsc passou, nenhum teste quebrou).
     Apague os itens que não se aplicam. -->

- [ ] Rodei o teste isolado com `--trace=on` e verifiquei os steps no relatório
- [ ] Forcei uma falha para confirmar que não é falso positivo
- [ ] Rodei em modo `--debug` e acompanhei passo a passo
- [ ] Confirmei que não há erros de backend (`🚨 Backend Error:`) no output
- [ ] Atualizei o `QA-CHECKLIST.md`
- [ ] Atualizei o `QA-SCENARIOS-GUIDE.md` com o cenário em linguagem humana
