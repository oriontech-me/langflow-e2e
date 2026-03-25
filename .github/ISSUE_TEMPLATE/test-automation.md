---
name: Test Automation
about: Planejamento de um novo teste automatizado para a suíte E2E
title: "[Test] "
labels: test-automation
assignees: ""
---

## Descrição
<!-- O que esse teste valida? Do ponto de vista do usuário, em 1–3 frases. -->

---

## Área
<!-- Marque a área de produto coberta pelo teste -->

- [ ] auth
- [ ] flows / canvas
- [ ] playground
- [ ] agents / LLM
- [ ] mcp
- [ ] files
- [ ] settings
- [ ] templates
- [ ] ui-ux
- [ ] api

---

## Classificação do teste

**Esse teste deve rodar antes de todo deploy/release?**
- [ ] Sim — cobre um caminho feliz crítico para o produto funcionar
- [ ] Não — cobre um cenário secundário ou específico

**Esse teste foi motivado por um bug identificado?**
- [ ] Sim — link para a issue ou PR de correção: ________________
- [ ] Não — cobertura preventiva de um fluxo ainda não automatizado

---

## Pré-condições
<!-- O que precisa ser verdadeiro antes do teste começar?
     Ex: usuário logado, canvas sem flows, provider com API key configurada. -->

---

## Passos
<!-- Sequência de ações do usuário. Linguagem natural — não precisa ser código. -->

1.
2.
3.

---

## Comportamento esperado
<!-- O que deve acontecer ao final dos passos?
     Descreva o que o usuário vê ou recebe — é daqui que sai a asserção principal do teste. -->

---

## Contexto de implementação
<!-- Preencha o que souber. Essas informações ajudam a LLM a escolher os
     helpers, page objects e seletores corretos sem precisar adivinhar. -->

**Tipo de teste**
- [ ] UI (interação com o browser)
- [ ] API REST (chamada direta aos endpoints)
- [ ] Agente / Provider LLM (envolve OpenAI, Anthropic, Google etc.)
- [ ] MCP (server ou client)

**Envolve provider externo de LLM?**
- [ ] Sim — provider(s): ________________
- [ ] Não

**Envolve upload ou leitura de arquivo?**
- [ ] Sim — tipo de arquivo: ________________
- [ ] Não

**Elementos de UI relevantes**
<!-- Descreva os componentes visíveis: botões, modais, campos, painéis.
     Ex: "modal de configuração de modelo com dropdown de provider",
         "botão Run na toolbar superior do canvas". -->

**Edge cases ou comportamentos não óbvios**
<!-- Algo que só acontece em condição específica, ou que costuma enganar.
     Ex: "o badge de erro só aparece após o flow ser executado pelo menos uma vez",
         "o elemento some se o usuário não tiver permissão de edição". -->
