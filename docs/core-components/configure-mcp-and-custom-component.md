# Configure an MCP server & Configure a Custom Component — reusable config helpers

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Delivers the two uncovered **helper** items from the QA-CHECKLIST "To implement"
list (the suite's helper inventory):

- **Configure an MCP** → `helpers/mcp/configure-mcp-server.ts`
- **Configure a Custom Component** → `helpers/flows/configure-custom-component.ts`

Each item becomes a **reusable helper** that performs the configuration
end-to-end through the UI, plus a spec that exercises the helper and asserts a
**distinctive observable** proving the configuration actually took effect. The
config flows themselves are already exercised inline by
`mcp/client/mcp-client-regression.spec.ts` (HTTP-form registration, `@stable`)
and `core-components/full-custom-component.spec.ts` (`@stable`); this issue
extracts them into named helpers (per the checklist) and validates them in one
place.

1. **configureMcpServer(page, { name, url })** — from a flow canvas, opens the
   MCP sidebar, adds an MCP server via the **HTTP form tab**, fills name + URL,
   submits. The spec asserts the server appears in the sidebar as an
   `add-component-button-{name}` **and** is persisted (`GET /api/v2/mcp/servers`
   contains it). A dummy unreachable URL (`http://localhost:1/mcp`) is used — the
   test validates *registration/configuration*, not connectivity, so it needs no
   live MCP server and stays deterministic.
2. **configureCustomComponent(page, code)** — adds a Custom Component to the
   canvas, opens its code editor, replaces the scaffold with the given Python
   code, and runs **Check & Save**. The spec asserts the node materializes the
   **code-declared interface** (a display name, input, output handle, and run
   button whose strings exist only in THAT code) — proving Check & Save compiled
   the code into a real component.

If either fails, the corresponding configuration flow regressed — MCP server
registration or custom-component compilation.

---

## Tags *(required)*

- MCP test: `@regression` `@mcp`
- Custom Component test: `@regression` `@components`

**`@stable` withheld initially** — added only after multiple clean `--retries=0`
runs on the fresh nightly (the source specs are already `@stable`; these
helper-validating variants earn it after their own clean runs). MCP is in the
current flaky cluster (#773).

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`; auto-login superuser.
- **`LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`** — the nightly image defaults it to
  `false`, which hides `sidebar-custom-component-button` and 403s custom-component
  creation (#668). The CI service containers and the start scripts set it.
- No LLM / provider key required — both flows are pure UI/config.

---

## Step by step *(required)*

**Test 1 — configure an MCP server (helper: configureMcpServer)**

1. Bootstrap, open a blank flow (capture its id from the creation POST for
   scoped teardown).
2. Pre-clean any leftover server with the test's unique name via
   `DELETE /api/v2/mcp/servers/{name}`.
3. Call `configureMcpServer(page, { name, url: "http://localhost:1/mcp" })`
   (unique name per run).
4. **Validation:**
   - `add-component-button-{name}` is visible in the MCP sidebar, **and**
   - `GET /api/v2/mcp/servers` returns a server whose `name` equals the unique
     name — registered and persisted.

**Test 2 — configure a Custom Component (helper: configureCustomComponent)**

1. Bootstrap, open a blank flow (capture id).
2. Call `configureCustomComponent(page, FULL_COMPONENT_CODE)` — a component that
   declares `display_name "My Full Component"`, input `"My Input"`, output
   `"My Output"` (strings absent from the default scaffold).
3. **Validation:** on the canvas —
   - `title-My Full Component` visible (declared display name),
   - `title-my input` visible (declared input field),
   - `handle-myfullcomponent-shownode-my output-right` visible (declared output
     handle),
   - `button_run_my full component` visible (compiled component is runnable).

---

## Validation criterion *(required)*

- **MCP (T1):** the uniquely-named server the helper configured is present both in
  the sidebar (`add-component-button-{name}`) and in `GET /api/v2/mcp/servers` —
  configuration persisted, not merely a transient UI state.
- **Custom Component (T2):** the node exposes the interface declared *only* in the
  supplied code (display name, input label, output handle, run button) — Check &
  Save compiled THIS code into the node.

## Guarding against false positives *(how)*

- **Unique server name (T1):** keyed on a per-run name in both the UI and API
  assertions, so a stale server from another test cannot satisfy it.
- **Code-only strings (T2):** the asserted testids derive from names that do not
  exist in the default scaffold, so a pass requires the supplied code to have
  compiled — a blank/unmodified component would not render them.
- **Deterministic inputs:** dummy unreachable MCP URL (no live server dependency)
  and a fixed component source (no LLM) — a failure is a real config regression.
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY on each hard
  assertion.

---

## What this test does not cover *(optional)*

- MCP server **execution** (calling a tool) — covered by
  `mcp/client/mcp-client-regression.spec.ts` (JSON/echo) and
  `mcp/server/mcp-server-protocol.spec.ts`.
- MCP **stdio** transport (needs an npx subprocess) — the HTTP form is used for
  determinism.
- Editing/removing an existing custom component; the pink code-button indicator
  (`core-components/customComponentAdd.spec.ts`).
- Running the configured custom component's output (only its declared interface
  is asserted).

---

## External dependencies *(required)*

- `src/frontend/src/.../mcpServerTab` (or equivalent) — the MCP sidebar,
  `sidebar-add-mcp-server-button`, `http-tab`, `http-name-input`,
  `http-url-input`, `add-mcp-server-button`.
- `POST/GET/DELETE /api/v2/mcp/servers` — MCP server registration + persistence.
- Custom Component feature — `sidebar-custom-component-button`,
  `code-button-modal`, the Ace editor, **Check & Save**; requires
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`.

---

## When to review this test *(optional)*

- If the MCP add-server modal / HTTP form testids change.
- If the custom-component code editor or Check & Save flow changes.
- If custom components change their default enable flag or 403 behavior.

---

## Notes *(optional)*

- **Helpers extracted, not duplicated:** the MCP HTTP-form steps mirror the
  `@stable` `mcp-client-regression.spec.ts` HTTP-form test; the custom-component
  steps mirror the `@stable` `full-custom-component.spec.ts`. This spec calls the
  new helpers so the checklist "To implement" helper items point at real,
  test-exercised code.
- **Cleanup:** `afterEach` deletes the created flow by id (scoped, never
  `cleanAllFlows`) and DELETEs the test's MCP server by name — no orphans.
- **Placement:** one spec under `core-components/` (the custom-component home)
  hosts both tests, per #821 which bundles the two helper items; the MCP test
  carries `@mcp`.
