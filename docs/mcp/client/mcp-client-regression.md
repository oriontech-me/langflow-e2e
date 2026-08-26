# MCP Client – Configure and Execute Tool

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates the full MCP client configuration and tool execution path — without an LLM agent. Covers four scenarios: JSON-based server config with echo tool execution, unreachable HTTP server producing an empty tool dropdown, HTTP form tab server registration, and numeric tool execution (`get-sum`). If these tests fail, users cannot connect external MCP servers or run their tools from within a Langflow flow.

---

## Tags *(required)*

All four tests: `@mcp` `@regression` `@stable`.

Test 2 was quarantined by the #1121 daily triage (`test.fixme` added, `@stable` removed) after three same-signature flakes — dailies 2026-07-16, 2026-07-20 and 2026-07-30 — all of them in the shared "Open a blank flow" entry point, none of them in an MCP assertion. The quarantine is lifted with the entry-point repair described in **Step by step → Entry point** and **Notes → The blank-flow entry point does not always route (#1126)**.

Test 4 (numeric `get-sum`) had `@stable` temporarily removed in the #461 daily-triage PR because it depends on the `npx server-everything` MCP server registering its tools in time, which hard-failed the daily suite on cold startup (#463). The dominant root cause was an upstream Langflow defect — root-owned npm cache, `langflow-ai/langflow#13992` — now fixed in the published nightly (see #638/#552). `@stable` was **re-added** (#463) and the poll budget kept at 120s (raised from 90s) as modest margin for startup.

Test 1 (JSON config → echo tool) shares the same `npx server-everything` dependency and was out of scope for #463; it was promoted later by #947 (PR #954, "promote §13.1 MCP Client remainder to `@stable`"), once that cold-start defect was fixed upstream.

---

## Step by step *(required)*

**Entry point — "Open a blank flow" (shared by all four tests)**

1. Land on the flows list and open the new-flow templates modal
2. Click `blank-flow` and read the created flow's id from `POST /api/v1/flows/` → `201` (the id in the canvas URL is a transient client-side handle on this version and must not be used)
3. Wait up to 10 s for the SPA to route to `/flow/<id>`
4. If it has not routed, probe `GET /api/v1/version`:
   - backend not healthy → fail, attributed as a backend outage, never as an entry-point regression;
   - backend healthy → load `/flow/<id>` directly, wait for `canvas_controls_dropdown`, and report the repair on stdout so the daily's artifact records it (#1126)

**Test 1 — JSON config → echo tool**

1. Open a blank flow
2. Delete any existing `everything` MCP server via API
3. Open add-server modal → JSON tab; fill config for `npx @modelcontextprotocol/server-everything`
4. Save and poll `GET /api/v2/mcp/servers?action_count=true` until `toolsCount` is non-null
5. Add MCPTools component; open dropdown and select `echo-0-option`
6. Fill `popover-anchor-input-message` with `"oi"`; click Run
7. Open output inspection and verify result contains `"oi"`

**Test 2 — Unreachable HTTP server → empty tool dropdown**

1. Open a blank flow; delete any existing `bad-server` via API
2. Open add-server modal → HTTP tab; set name `bad-server`, URL `http://localhost:1/mcp`
3. Save and confirm `add-component-button-bad-server` appears in sidebar
4. Add MCPTools component; wait 5s for backend connection attempt
5. Open tool dropdown and verify zero options are listed

**Test 3 — HTTP form tab registration**

1. Open a blank flow; delete any existing `http-form-server` via API
2. Open add-server modal → HTTP tab; set name `http-form-server`, URL `http://localhost:1/mcp`
3. Save; confirm modal closes and `add-component-button-http-form-server` appears
4. Call `GET /api/v2/mcp/servers` and confirm entry with name `http-form-server` exists

**Test 4 — Numeric tool (`get-sum`)**

1. Open a blank flow; register `everything` server via JSON and poll `toolsCount` non-null
2. Add MCPTools component; open dropdown and select `get-sum-6-option`
3. Fill `float_float_a=3` and `float_float_b=5`; click Run
4. Open output inspection and verify dialog contains `"The sum of 3 and 5 is 8."`

---

## Validation criterion *(required)*

- Test 1: output popover contains `"oi"` after echo tool execution
- Test 2: tool dropdown has zero options after unreachable server is registered
- Test 3: `add-component-button-http-form-server` visible and API confirms server persisted
- Test 4: output dialog contains `"The sum of 3 and 5 is 8."`

---

## External dependencies *(required)*

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/McpSidebarGroup.tsx` — `sidebar-add-mcp-server-button` and component list in sidebar
- `src/frontend/src/modals/addMcpServerModal/index.tsx` — JSON tab, HTTP tab, and save flow; testids `json-tab`, `http-tab`, `http-name-input`, `http-url-input`, `add-mcp-server-button`
- `src/frontend/src/components/core/parameterRenderComponent/components/mcpComponent/index.tsx` — `dropdown_str_tool` on the canvas node
- `src/backend/base/langflow/api/v2/mcp.py` — `GET /api/v2/mcp/servers?action_count=true` and `DELETE /api/v2/mcp/servers/{name}` endpoints
- `src/frontend/src/modals/templatesModal/index.tsx` — the `blank-flow` button every test enters through, and the `addFlow().then(navigate)` chain whose stall #1126 is about
- `src/frontend/src/hooks/flows/use-add-flow.ts` — resolves the promise that chain navigates from; a `201` whose per-mutate `onSuccess` never resolves leaves the app parked on the flows list
- npm package `@modelcontextprotocol/server-everything` — external dependency launched via `npx`

---

## What this test does not cover *(optional)*

- MCP client usage with an LLM agent (covered in `mcp-client-agent.spec.ts`)
- MCP stdio form tab (JSON config covers the same backend path)
- MCP resources and prompts (not currently exposed in MCPTools component UI)

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- `npx` available on the system PATH where Langflow runs
- No LLM or API key required — all tools are synchronous

---

## Notes *(optional)*

- The npx process takes 5–30 seconds to start once the package is cached. Tests 1 and 4 poll `GET /api/v2/mcp/servers?action_count=true` until `toolsCount` is non-null before interacting with the canvas node — Test 1 up to 90s, Test 4 up to 120s. The cold-fetch fragility that de-stabled Test 4 (removed in the #461 triage; re-added in #463) was an upstream Langflow defect (root-owned npm cache, `langflow-ai/langflow#13992`), now fixed in the published nightly.
- Tool dropdown interactions use `page.evaluate((el) => el.click())` instead of Playwright's `.click()` to avoid viewport and overlay constraints.
- The `get-sum` tool option testid is `get-sum-6-option` — index 6 reflects its position in `server-everything`'s tool list and may shift if the package reorders tools in a future release.
- Test 2 uses `page.waitForFunction` to confirm the dropdown is genuinely open before asserting zero options, preventing a false-positive where the evaluate click fails silently.
- **The blank-flow entry point does not always route (#1126).** Three dailies (2026-07-16, 2026-07-20, 2026-07-30) failed Test 2 on `page.waitForURL(/\/flow\//)` *after* `POST /api/v1/flows/` had already answered `201` and the id had been read. In all three the Playwright call log is exactly `waiting for navigation until "load"` with **no `navigated to "…"` line** — Playwright logs that line for every main-frame navigation it observes *before* testing the URL predicate, so the frame emitted no navigation at all for the full 30 s. The stall is therefore terminal, not slow, and waiting longer cannot fix it: measured on nightly 1.12.0.dev39, 6 parallel lanes × 8 blank-flow creations navigated **48/48**, min 39 ms, p50 269 ms, **p95 337 ms**, max 457 ms — the retired 30 s budget was ~90× the p95. Upstream, `navigate()` runs only from the `.then()` of `addFlow()` in `templatesModal/index.tsx` and that chain has no `.catch`, so a creation whose per-mutate `onSuccess` never reaches `resolve(createdFlow.id)` parks the app on the flows list forever — the exact observed state. The cause of that non-resolution is **not** established: forcing the modal to unmount mid-flight (Escape immediately after the click) still navigated 5/5 on 1.12.0.dev39, so the "unmounted observer drops the mutate callback" branch alone does not explain it. The repair is therefore deterministic rather than a longer wait — the id from the `201` is authoritative, so the entry point loads `/flow/<id>` directly — and it is never silent: the recovery prints a `📌 Blank-flow entry repaired (#1126)` line, which Playwright's JSON reporter stores under `results[].stdout`, so a future daily can be searched for it.
- The file runs `test.describe.configure({ mode: "serial" })`, so a failure in this entry point does not cost one test: on the 2026-07-30 daily it also skipped Tests 3 and 4 (the run's only two `skipped`).
- **Cleanup captures every flow the page creates, not just the blank one.** The teardown used to delete a single tracked id — the one `openBlankFlow` returns — which leaves the flow the "New Flow" entry point creates on its own during bootstrap behind (#1002). Measured on 1.12.0.dev39: one clean 4-test run took the instance from **26 to 28** flows, all named `New Flow (N)`. The file therefore uses `trackCreatedFlows` (#1108), armed in `beforeEach` so bootstrap's creation is inside the capture window, with `{ strict: true }` to keep the pre-existing behaviour that a failed delete fails the teardown rather than logging (#547).
