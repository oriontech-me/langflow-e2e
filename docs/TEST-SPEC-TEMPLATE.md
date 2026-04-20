# [Nome do Spec]

**Última validação:** Langflow X.X.x

---

## O que este teste valida *(obrigatório)*
O que o teste valida em termos funcionais e por que existe. Se veio de um bug, referencie a issue.
Se é cobertura preventiva de release, diga qual funcionalidade protege.
Pense: "se este teste falhar, o que quebrou no produto?"

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

## Dependências externas *(obrigatório)*
<!-- Arquivos do repositório do Langflow que, se alterados, podem quebrar este teste.
     Esta lista é lida pelo workflow de monitoramento — preencha com atenção. -->

- `src/frontend/...` — descrição do que este arquivo faz e por que impacta o teste
- `src/backend/...` — idem

---

## O que este teste não cobre *(opcional)*
- Comportamentos adjacentes que parecem relacionados mas estão intencionalmente fora do escopo
- Ajuda o mantenedor a distinguir lacuna de decisão consciente

---

## Pré-condições *(opcional)*
- O que precisa estar configurado ou em execução antes de rodar o teste

---

## Quando revisar este teste *(opcional)*
- Situações específicas que indicam que o teste pode estar desatualizado, sem ser uma quebra direta

---

## Notas *(opcional)*
- Observações sobre flakiness, timeouts empíricos, workarounds ou decisões que um mantenedor futuro precisaria entender
