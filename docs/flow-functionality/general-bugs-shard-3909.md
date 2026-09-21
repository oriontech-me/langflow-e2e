# Spec: An empty project's "New Flow" call to action creates a flow in that project and opens it

**Test file:** `tests/tests-automations/regression/flow-functionality/general-bugs-shard-3909.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev19`)

---

## What this test validates

Regression guard for upstream `langflow-ai/langflow#3909` (*"Button 'Start Here' not
working"*, 2024-09-25): the call to action an **empty project** shows must create a new
flow and open its canvas, as the header's New Flow button does.

On 1.13 that call to action is `new_project_btn_empty_page` ("New Flow") on the
*Empty project* page. The test creates a project, opens its (empty) page and asserts
that clicking the call to action:

1. creates a flow **inside that project** — the `POST /api/v1/flows/` it triggers answers
   201 with `folder_id` equal to the new project's id — and navigates to that flow's
   canvas;
2. leads, through the welcome panel's *Browse more* and the template gallery, to the
   **Basic Prompting** template opened on the canvas with its four components (Chat
   Input, Prompt Template, Language Model, Chat Output) — the inherited test's own end
   state;
3. leaves that template flow **in the new project**: `GET /api/v1/projects/{id}` lists
   **exactly one** flow, and its name is the template's — `Basic Prompting`, or
   `Basic Prompting (N)` when the client's uniquifier had to disambiguate (see
   *The name is the client's, not the contract* below).

The project, not the default one, is the point: a call to action that created the flow
somewhere else, or created nothing, is the #3909 regression.

---

## Tags

`@stable` `@release` `@regression` `@mainpage` `@ui-ux`

`@regression` because it pins a previously fixed product bug; `@ui-ux` is the functional
area (the empty-state call to action).

---

## Step by step

1. Register the flow tracker (`trackCreatedFlows`) before the first navigation, so every
   flow the page creates — the call to action's flow and the template's — is deleted
   id-scoped in `afterEach`, after leaving the editor. The project is deleted by id.
2. Create a project over the API (`createProjectViaApi`, unique name) and open its page,
   `/all/folder/<projectId>`, behind the page-entry barrier on `mainpage_title`.
3. Assert `new_project_btn_empty_page` is visible.
4. Click `new_project_btn_empty_page`. Assert the `POST /api/v1/flows/` it triggers answers
   201 and carries `folder_id` = the project id in its request body, that the page
   navigates to a `/flow/` URL, and that `GET /api/v1/projects/{projectId}` then lists
   exactly one flow.
5. Go past the welcome panel to the template gallery (`dismissWelcomeOverlayAndWaitForModal`),
   click `side_nav_options_all-templates`, then the **Basic Prompting** heading.
6. Assert the canvas shows `button_run_chat input`, `button_run_prompt template`,
   `button_run_language model` and `button_run_chat output`.
7. Assert `GET /api/v1/projects/{projectId}` lists **exactly one** flow whose name is
   the template's, allowing the client-side uniquifier's ` (N)` suffix.

---

## Validation criterion

| Claim | Observable |
|---|---|
| The call to action is offered on the project's empty page | `new_project_btn_empty_page` visible on `/all/folder/<projectId>` |
| It creates a flow in that project | the `POST /api/v1/flows/` it triggers → 201 with `folder_id` = project id; the project then lists exactly 1 flow |
| It opens that flow | the page navigates to a `/flow/` URL |
| The template opens on the canvas | the four `button_run_*` testids visible |
| The template flow lives in the project | `GET /api/v1/projects/{projectId}` → `flows` is **exactly one** flow whose `name` matches `/^Basic Prompting(?: \(\d+\))?$/` |

The test fails if the call to action does nothing (the original #3909 bug), creates the
flow outside the project, or does not open the canvas; or if the template picked from
there does not land in the project — either because the project ends up with no flow, or
with a flow that is not the template's, or because the placeholder is left behind
alongside it.

### The name is the client's, not the contract

The last row deliberately does **not** pin the exact string `Basic Prompting`, and that
is a *narrowing of the claim to what the product guarantees*, not a loosened assertion.
Picking a template renames the call to action's placeholder flow **in place** and the
**frontend** uniquifies the name against the whole flow store minus the examples — not
against the project:

```js
// built frontend bundle, read from the container (identical on 1.13.0.dev16 and dev19)
function iyt(e, t) {
  const o = t.filter(c => c.id !== e.id).map(c => c.name);
  let s = e.name, a = 1;
  for (; o.includes(s); ) s = `${e.name} (${a})`, a++;
  return s;
}
// called as: iyt({...currentFlow, name: template.name}, allFlows.minus(examples))
```

So **any** user flow named `Basic Prompting` anywhere on the instance — and
`awaitBootstrapTest` plus ~14 specs create exactly that name — makes this flow land as
`Basic Prompting (1)`. The backend imposes no such rule: `POST /api/v1/flows/` accepts a
duplicate name unsuffixed (201). The suffix is therefore correct client behaviour whose
input this test does not control on a shared instance, while *the template landing in
this project* is the behaviour #3909 is about.

The rest of the row is **stricter** than what it replaced. `flows` *containing*
`Basic Prompting` was satisfied by any flow of that name sitting in the project, and said
nothing about how many flows were there; the project is created by this test, so
**exactly one** flow whose name is the template's pins both that the template landed and
that the placeholder did not survive alongside it (the leak #1911 removed).

---

## External dependencies

- `src/frontend/src/pages/MainPage/pages/emptyFolder/index.tsx` — the *Empty project* page
  and `new_project_btn_empty_page`
- `src/frontend/src/routes.tsx` — the `all/folder/:folderId` route the test opens
- `src/frontend/src/components/core/flowBuilderWelcome/flow-builder-welcome.tsx` — the
  welcome panel and `flow-builder-welcome-browse-more`
- `src/backend/base/langflow/api/v1/flows.py` — `POST /api/v1/flows/` (`folder_id`)
- `src/backend/base/langflow/api/v1/projects.py` — `GET /api/v1/projects/{id}` (`flows`)
- The Basic Prompting starter template, as registered by the image

---

## What this test does not cover

- Creating, renaming and deleting projects — `core-functionality/project-management/folder-crud.spec.ts`.
- The template gallery itself and the graph a template instantiates —
  `core-functionality/templates/templates-gallery.spec.ts` and
  `core-functionality/templates/templates-instantiate.spec.ts`.
- Leaving the gallery without picking a template (the placeholder flow then stays).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`. No provider key: the Basic Prompting
  components render without one, and nothing runs.

---

## Notes

- **Daily #5 / issue #1955 — verdict `test-defect`, measured, not argued.** The step 7
  assertion hard-failed 3/3 on the VM lane at `1.13.0.dev19` and on Actions run
  `35536482026` at `1.13.0.dev18`, both receiving `["Basic Prompting (1)"]`. The issue's
  prime suspect — a product change between `dev16` and `dev18` — is **refuted** by
  measurement: one variable, two builds. `1.13.0.dev19` fresh → passed (10.9 s); the same
  container after seeding **one user flow** named `Basic Prompting` into a *different*
  project → failed with the CI's exact array. `1.13.0.dev16` → passed (12.4 s); the same
  instance after the same seed → failed with the same array. The same build produces both
  outcomes, so the discriminator is instance state, not the build — confirmed by reading
  the `dev16` bundle, where the instance-wide uniquifier quoted above is already present.
  Pre-fix baseline on the seeded instance: **5/5 failures, 0 voided**, so this was never a
  flake. One earlier probe was void and is recorded as such: seeding into the folder that
  holds `Basic Prompting` on a fresh instance looked cross-project, but that is the hidden
  **examples** folder, whose ids the uniquifier excludes by construction.
- **Wave 9 T2 triage, issue #1911 — outcome PROMOTE.** Row in
  `docs/triage/inherited-spec-triage.md`: T2,
  `flow-functionality/general-bugs-shard-3909.spec.ts`, 0/3 green.
- **Why it failed (drift, not product).** Measured on `1.13.0.dev16`: it died at
  `add-project-button` (20 s). The button exists — on the home page. The test reached it
  through `awaitBootstrapTest` **without** `skipModal`, which since 1.10 opens the
  templates modal by clicking the header's New Flow, and that click navigates to a freshly
  created flow; closing the modal left the page on that flow's canvas, where the project
  sidebar is not rendered.
- **Why the project is created over the API.** The sidebar is not a dependable entry
  either: on an instance with no flow at all the home page renders its *Start building*
  state with no project sidebar — measured, `add-project-button` absent on a fresh
  `1.13.0.dev16` container — and that is exactly the state a PR lane's fresh instance
  can be in. Project creation through the sidebar is `folder-crud.spec.ts`'s subject;
  this test needs a project and opens it by its route.
- **Why DELETE was not available.** No `@stable` test clicks the empty project's call to
  action and asserts what it creates: `awaitBootstrapTest` clicks it on an empty default
  project as setup (a helper path, not an assertion), and `folder-deletion-integrity`'s
  `@destructive` test only asserts it is visible.
- Hardening for the promotion: (a) the inherited file deleted nothing — **3 flows leaked
  per run** on an empty project, and when it passed it also left its project behind; the
  flows are tracked from the first navigation and deleted by id, and the project by id;
  (b) it skipped whenever `OPENAI_API_KEY` was unset although nothing consumes the key —
  the gate is gone, so the test now runs where it used to skip; (c) the flow's project
  was never asserted — the new server-side checks are what tie the call to action to the
  project; (d) the text waits (`text=new flow`, `text=playground`, `text=share`) became
  testid and request assertions.
