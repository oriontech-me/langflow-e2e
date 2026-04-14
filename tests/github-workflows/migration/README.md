# Migration Test

Testes Python que verificam se o banco de dados do Langflow migra corretamente de `latest` para `nightly`. Executados pelo workflow `.github/workflows/migration-test.yml`, acionado manualmente via `workflow_dispatch`.

## O que o workflow faz

O workflow sobe dois containers Docker sequencialmente contra o mesmo banco PostgreSQL, simulando um upgrade real em produção.

### Fase 1 — Langflow Latest

1. Sobe `langflowai/langflow:latest` com um banco PostgreSQL vazio.
2. Autentica na API e localiza o template de agente nos starter projects.
3. Cria um flow a partir desse template.
4. Cria a variável de ambiente `OPENAI_API_KEY` no Langflow.
5. Executa o flow via API e salva o estado (flow ID, resultados) em `/tmp/migration-test-state.json`.

### Fase 2 — Upgrade para Nightly

6. Para o container `latest` (o banco PostgreSQL permanece intacto).
7. Sobe `langflowai/langflow-nightly:latest` apontando para o mesmo banco — as migrações Alembic rodam automaticamente na inicialização.
8. Aguarda o Langflow ficar disponível (timeout de 180s para dar tempo às migrações).

### Fase 3 — Verificação

Dois scripts verificam que a migração não quebrou nada:

**`verify_migration_api.py`** — verificações via API REST:
- O flow criado na Fase 1 ainda existe pelo mesmo ID.
- Todos os flows aparecem na listagem.
- A variável `OPENAI_API_KEY` foi preservada.
- O flow executa com sucesso no nightly.

**`test_ui_migration.py`** — verificações via Playwright (Chromium):
- O flow abre no editor sem erros de componente.
- O banner "Updates are available" é detectado e reportado.
- Os componentes são atualizados via "Review All → Select All → Update Components".
- O flow executa no Playground da UI.
- O flow executa via API após a atualização dos componentes.

### Fase 4 — Relatório

`generate_report.py` consolida o estado coletado em `/tmp/migration-report.md` com status por fase e step (`PASS` / `FAIL` / `WARN` / `SKIP`).

Em caso de falha, o workflow abre ou atualiza uma issue no repositório com label `migration-test`, incluindo o relatório completo e link para a run.

## Artefatos gerados

| Arquivo | Conteúdo |
|---|---|
| `test-results/` | Traces e screenshots do Playwright |
| `/tmp/migration-report.md` | Relatório consolidado em Markdown |
| `/tmp/langflow-latest.log` | Logs do container latest |
| `/tmp/langflow-nightly.log` | Logs do container nightly |
| `/tmp/migration-test-state.json` | Estado bruto coletado entre as fases |
| `/tmp/latest-digest.txt` | Digest da imagem latest usada |
| `/tmp/nightly-digest.txt` | Digest da imagem nightly usada |

## Como executar manualmente

No GitHub: **Actions → Langflow Migration Test: Latest → Nightly → Run workflow**.

Requer o secret `OPENAI_API_KEY` configurado no repositório (usado para criar a variável no Langflow e executar o flow de agente).

## Dependências Python

```
requests
playwright
pytest
pytest-playwright
```
