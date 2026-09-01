# Enterprise — The Audit-Log Screen Sends the Filter It Displays

**Last validated:** Langflow Enterprise 1.12.0 (image built 2026-08-27 from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`operator-surfaces.spec.ts` covers the audit **API**: that `?result=deny` narrows, and that every
returned row is a deny. This covers the **screen**, and the two can disagree in ways the API spec
cannot see — a control can filter client-side, or send a parameter the backend ignores, and the
listing looks filtered either way.

The audit log is also the one screen in this console whose *defaults* change what an operator
believes they are looking at, and it owns the control that decides what leaves the instance.

### The default view narrows twice

```
GET /api/v1/authz/audit?exclude_event=authorization_decision&since=<7 days ago>&page=1&size=50
```

- **Permission checks are excluded**, governed by the `Include permission checks` checkbox. An
  operator asking *"was X denied?"* sees nothing about authorization decisions until they tick it
  — and authorization decisions are where denials live.
- **A seven-day window is applied**, stated only as `Time range` reading *Last 7 days*.

Neither is a defect. Both change what *"the audit log"* means, and the screen's own controls are
the only place either is stated — so a build that changed what the default hides without changing
what the controls say would be invisible.

### The labels are not the API's values

`Event type` offers *All events, Provider administration, Connections & sign-in, Admin recovery,
Flows, Projects, Deployments, Provider Accounts, Voice, Variables*. Picking *Connections &
sign-in* sends `resource_type=sso_connection`. The mapping is a relabelling, not a slug — a screen
that sent its own label would filter nothing and still look filtered, which is why one pair is
pinned rather than assumed.

## Why the export is asserted on its request and not on its file

This is the load-bearing decision in this spec, and it is not a concession.

**Measured** on this build: `Export CSV` fires
`GET /api/v1/authz/audit?…&page=1&size=200`, is answered `200`, and **produces no file** — 0 of
12 attempts across fresh browser contexts, each logging exactly one
`Duplicate request: /api/v1/authz/audit`. Filed as **#1639**. Not an environment artefact: the
same setup produced a real 118-row CSV twice earlier the same day, so downloads work and this
path stopped producing one.

Asserting the download would therefore pin a defect, and asserting it *loosely enough to pass*
would pin nothing. The request layer is where the properties worth protecting actually live, and
both were measured from the successful capture:

- the export **honours the active filter** — filtered to `Deny`, its request carried `result=deny`;
- the export is **not page-scoped** — 118 rows for a screen showing 50, via `size=200`.

Those hold regardless of #1639, and they are what a regression would take away. This is also the
rule this suite has now learned twice in one week: **assert the event, not a downstream state a
race or a dedupe can swallow** (the same correction the delete-dialog test and the entitlements
declaration each needed). When the download is fixed, the assertion tightens and #1639 is the
pointer for doing it.

## Tags *(required)*

`@enterprise` `@regression` `@ui-ux`

Same three as the sibling console specs. Not `@authz`: `operator-surfaces` owns the audit API and
its guards; this is the operator screen over it.

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would silently
never run (#1010).

## Step by step *(required)*

1. Authenticate once, require the **RBAC variant**, seed the browser session from the cached
   token — as every spec in this directory does.
2. **Defaults.** Arm a listener, open `/admin-ee/audit-logs`, and assert the first audit request
   carries `exclude_event=authorization_decision` and a `since`, while `Time range` reads
   *Last 7 days* and the checkbox is unticked.
3. **The checkbox.** Tick `Include permission checks` and assert the next request no longer
   carries `exclude_event`.
4. **The Result filter.** Seed a denial **this run** — a role-less subject creating a flow in a
   project it does not own, which is refused `403` and audited `deny` — then tick the checkbox
   (denials are authorization decisions, excluded by default), pick `Deny`, and assert the
   request carries `result=deny` **and every visible row's Result cell reads Deny**.
5. **The label mapping.** Pick *Connections & sign-in* and assert the request carries
   `resource_type=sso_connection`.
6. **The export.** With a filter active, click `Export CSV` and assert its request carries that
   filter and a `size` greater than the page size. No assertion on the file (#1639).

## Validation criterion *(required)*

Fails when a control displays one filter and sends another, when the default view's narrowing
stops matching what the controls report, when a filter is accepted and ignored, or when the export
requests the visible page instead of the filtered set.

## External dependencies *(required)*

- A Langflow **Enterprise** instance on the RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`.
- A browser.
- No LLM provider, no network egress, no licence. **One** unit of the per-IP login budget, spent
  by the Result-filter test: it creates a subject unique to this run rather than reusing the
  directory's shared one. That cost buys correctness — see below.
- No Langflow **source** paths: the Enterprise frontend is not in `langflow-ai/langflow`, so there
  is none to name. Every sibling under `docs/enterprise/` is in the same position.

## The seed has to be identifiable, not merely present

The seeded denial is deliberately produced by this run rather than found in the container. A
filter assertion over rows the container happened to carry passes for reasons that have nothing to
do with the filter, and on a fresh instance would have nothing to assert over at all.

**That was not enough, and a mutation proved it.** The first version seeded as the directory's
shared subject and asserted only that *every visible row is a deny*. Removing the seed's effect
left the test **green** — the shared subject has denials on this container from every previous
run, so the rows were there regardless and the seed was decorative.

So the subject is created per run, which is what makes its username impossible to pre-exist, and
the test asserts **this run's denial is among the rows the filter returned** as well as every row
being a deny. With the seed removed the test now fails naming the username it could not find.

One trap met while falsifying it, worth recording because it produced a passing mutation for the
wrong reason: pointing the seed at the subject's *own* project — intended to yield an
`owner_override` instead of a `deny` — **also passed**, because `getProjectOwnedBy` attempts
`POST /api/v1/projects/` as that subject first, is refused `403`, and that refusal is itself an
audited denial for the same username. The mutation seeded the very thing it meant to remove. The
clean mutation is to remove the seeding step outright.

Seeding it requires a write the subject is **refused**, which since the 2026-08-27 build means
naming a destination project the subject does not own — a bare `POST /api/v1/flows/` is allowed by
the owner override and audited `owner_override`, not `deny` (#1635). This is exactly the
dependency that kept this spec blocked, and `attemptFlowCreate` makes the destination a required
argument so it cannot be lost again.

The three non-2xx responses the console fires on every page load — `auto_login` `403`, `refresh`
`401`, `store/tags` `500` — are covered in the shell spec's notes, including the measurement trap
that the fixture prints `Backend Error` on **stdout**.
