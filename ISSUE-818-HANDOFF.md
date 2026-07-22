# Issue #818 — Handoff for a dedicated session

**Goal:** achieve ≥1 clean, non-guarded daily by **modernizing test selectors/steps** that drifted against a nightly node-UI overhaul. This is the entry gate for #773 and the wave's agent/MCP test promotions.

**Branch:** `fix/issue-818-testid-drift-baseline` (off `main`; no spec touched yet — investigation only).

---

## Verdict already established (do not re-investigate from scratch)

The daily's ~29 failures are **UI testid DRIFT**, NOT a Langflow product regression. This **corrects #816/#830** ("product regression, flag upstream"). The nightly restructured the node interaction surface (menu / expand / rename) between `dev40` and `dev46`; our specs still use the old testids. Features work; the DOM changed.

Evidence: of 11 distinct testids that timed out across the failing specs, **10 are gone** from the dev46 frontend (only `add-mcp-server-button` survives → that one is behavior/flow, investigate separately).

**Therefore:**
- ❌ Do NOT flag upstream. ❌ Do NOT remove `@stable`. ❌ Do NOT pin the daily image.
- ✅ DO modernize the selectors/steps to the new DOM (keeps coverage). ✅ Verify each fix against a local nightly.

## Environment (the nightly the daily runs — NOT what the start script pulls)

`scripts/start-langflow-docker.sh` pulls **stable** (`langflow:latest`), not nightly. Start the nightly explicitly:

```bash
docker run -d --rm --name lf-nightly -p 7860:7860 \
  -e LANGFLOW_AUTO_LOGIN=true -e LANGFLOW_SUPERUSER=langflow -e LANGFLOW_SUPERUSER_PASSWORD=langflow123 \
  -e LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true \
  langflowai/langflow-nightly:latest
# wait for: curl -sf http://localhost:7860/api/v1/version
```

Run a spec against it: `PLAYWRIGHT_BASE_URL=http://localhost:7860/ npx playwright test <file> --workers=1 --retries=0`.

## Confirmed mapping — node name/description rename (biggest cluster)

Old flow (our specs) → new flow (dev46), verified live:

| Old | New |
|---|---|
| hover `panel-description` wrapper | **removed** — no hover step |
| `edit-name-description-button` | `node-edit-name-description-button` |
| `inspection-panel-name` | `input-title-<currentName>` (DYNAMIC — scope to the focused node; duplicate node names → strict-mode hazard) |
| `save-name-description-button` | `node-save-name-description-button` |
| description display | `generic-node-desc` (a DIV; the description-EDIT input testid still needs a live check for `edit-name-description-node.spec`) |

New rename sequence: click `generic-node-title-arrangement` → click `node-edit-name-description-button` → fill `input-title-<name>` → click `node-save-name-description-button`.

Also drifted in the node-menu/expand flow: **`expand-button-modal`** (used by the local `expandFocusedNode` helper in `if-else-component-regression.spec.ts`) is gone; `more-options-modal` still opens the menu (`icon-Expand` seen). Map the new expand item live before fixing.

## Remaining clusters to map live (each: reproduce → read live DOM → find new testid)

Timed-out testids still needing their new-name map:
`edit-button-modal`, `expand-button-modal`, `edit-fields-button`, `toggle_bool_use_double_brackets`, `tweaks-button`, `icon-lock`, `div-table_headers`, `canvas_controls_dropdown_toggle_inspector-toggle`.
Plus `add-mcp-server-button` (EXISTS in bundle → not a rename; investigate its flow/behavior separately).

Mapping technique:
- **Static testids:** grep the container bundle — `docker exec lf-nightly sh -c "grep -rhoE '\"TESTID\"' /app/.venv/lib/python3.14/site-packages/langflow/frontend/assets/"`. Reliable only for literal testids.
- **Dynamic testids** (runtime-composed): grep gives false-MISSING → drive the UI with `playwright-cli` and `page.evaluate(() => [...document.querySelectorAll('[data-testid]')].map(e=>e.getAttribute('data-testid')))`.

## Footprint (files using the drifted node-rename testids)

`if-else-component-regression.spec.ts` (8 fails), `edit-name-description-node.spec.ts` (2), `general-bugs-reset-flow-run.spec.ts`, `group.spec.ts`, `langflowShortcuts.spec.ts`. Other clusters live in the agent/*, prompt-template, webhook, api-request, chat-input, auth/logout, mcp-client specs (see the #816 failing-set list).

## Approach (recommended)

1. **Helper-first for leverage:** fix the shared node-UI interaction (rename flow, `expandFocusedNode`, and any node-menu POM/helper) → cascades to many specs. Check `tests/helpers/` + `tests/pages/` for shared node-menu/rename helpers before editing specs one-by-one.
2. Fix cluster → **verify green against local nightly** (`--workers=1 --retries=0`) before moving on.
3. Repeat per cluster until the failing set is empty.
4. **Force-fail** each touched `test()` (repo rule) + **id-scoped flow cleanup** on any spec touched (repo rule — audit `afterEach`/`deleteFlow`).
5. Clean up any flow created during live scouting (DELETE via API; the browser-created "Basic Prompting" starter from the last session may still exist on the local instance).
6. PR only after explicit user authorization.

## Reference material from the investigation session

- Memory: `daily-failures-are-testid-drift.md` (+ `daily-slowdown-verdict.md`, `issue-817-runner-sizing.md`).
- #818 issue comment (2026-07-19) has the verdict + mapping table.
- Non-sharded reference failing set: run `29658914382`; sharded (dev48) reference: run `29674263823`.
