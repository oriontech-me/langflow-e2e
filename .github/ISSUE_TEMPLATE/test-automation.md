---
name: Test Automation
about: Planejamento de teste E2E — será lido pela LLM para implementação
title: "[Test] deve ... quando ..."
labels: test-automation
assignees: ""
---

## O que testar
<!-- Complete: "deve [resultado observável] quando [ação ou condição]"
     Essa frase vira o nome do teste — seja específico.
     Ex: "deve exibir a capital correta quando o agente recebe uma pergunta direta"
         "deve limpar o histórico quando o usuário clica em New Chat" -->

---

## Pré-condições
<!-- Estado necessário antes do teste começar.
     Ex: usuário logado, canvas vazio, provider configurado com API key válida. -->

---

## Passos

1.
2.
3.

---

## Resultado concreto esperado
<!-- O que especificamente deve estar visível ou verdadeiro ao final?
     Evite: "a mensagem aparece", "o modal abre", "o agente responde".
     Prefira: "a resposta contém o nome da capital solicitada",
              "o painel exibe pelo menos um tool call com nome e resultado",
              "após New Chat, a mensagem anterior não aparece na nova sessão". -->

---

## Tipo
- [ ] UI — interação com o browser
- [ ] API REST — chamada direta aos endpoints
- [ ] Agente / Provider LLM — envolve execução de modelo
- [ ] MCP — integração server ou client

---

## Comportamentos não óbvios
<!-- Opcional. Condições específicas, timing, estados intermediários que
     a LLM não conseguiria saber sem contexto humano.
     Ex: "o badge só aparece após a primeira execução do flow",
         "o campo some se o usuário não tiver permissão de edição". -->

---

## Referência
<!-- Issue ou PR relacionado, se houver. -->
