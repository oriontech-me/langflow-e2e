# [Nome do Spec]

## Objetivo *(obrigatório)*
O que o teste valida em termos funcionais, em uma ou duas frases. Pense: "se este teste falhar, o que quebrou no produto?"

---

## Motivação *(obrigatório)*
Por que este teste existe. Se veio de um bug, referencie a issue. Se é cobertura preventiva de release, diga qual funcionalidade protege.

---

## Tags *(obrigatório)*
`@release` `@playground`

---

## Passo a passo *(obrigatório)*
1. Passo 1
2. Passo 2
3. Passo 3

---

## Critério de validação *(obrigatório)*
- O que deve ser verdade para o teste passar
- Asserções principais em linguagem humana, não em código

---

## O que este teste não cobre *(opcional)*
- Comportamentos adjacentes que parecem relacionados mas estão intencionalmente fora do escopo
- Ajuda o mantenedor a distinguir lacuna de decisão consciente

---

## Pré-condições *(opcional)*
- O que precisa estar configurado ou em execução antes de rodar o teste

---

## Dependências externas *(obrigatório)*
<!-- Arquivos do repositório do Langflow que, se alterados, podem quebrar este teste.
     Esta lista é lida pelo workflow de monitoramento — preencha com atenção. -->

- `src/frontend/...` — descrição do que este arquivo faz e por que impacta o teste
- `src/backend/...` — idem

---

## Quando revisar este teste *(opcional)*
- Situações específicas que indicam que o teste pode estar desatualizado, sem ser uma quebra direta

---

## Notas *(opcional)*
- Observações sobre flakiness, timeouts empíricos, workarounds ou decisões que um mantenedor futuro precisaria entender
