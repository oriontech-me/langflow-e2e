# Enterprise — The Audit-Log Screen Sends the Filter It Displays

**Last validated:** Langflow Enterprise 1.13.0 (image built from `IBM-Langflow@bbbec5fb`, OSS `1e829663`)

---

## What this test validates *(required)*

`operator-surfaces.spec.ts` covers the audit **API**: that `?result=deny` narrows, and that every
returned row is a deny. This covers the **screen**, and the two can disagree in ways the API spec
cannot see — a control can filter client-side, or send a parameter the backend ignores, and the
listing looks filtered either way.

The audit log is also the one screen in this console whose *defaults* change what an operator
believes they are looking at, and it owns the control that decides what leaves the instance.

### What moved on 1.13

The screen was redesigned (EE PR 381, LE-2509) and now reads OSS's unified audit feed
(langflow-ai/langflow#15082) instead of `/api/v1/authz/audit`:

```
GET /api/v1/audits?limit=1                                     probe: is the feed available?
GET /api/v1/flows/audits?limit=1, /api/v1/projects/audits?limit=1   per-resource sources (403, see Notes)
GET /api/v1/audits?exclude_action=audit%3Aread&kind=action&since=<7 days ago>&limit=50&include_total=true
```

The `limit=1` reads are availability probes, not listings, and the spec ignores them when it
reads "the query the screen sent".

### The default view narrows three times, and states two

- **Only actions are listed** (`kind=action`): permission checks are excluded, governed by the
  `Include permission checks` checkbox. An operator asking *"was X denied?"* sees no
  authorization decision until they tick it — and authorization decisions are where denials live.
- **A seven-day window is applied**, stated only by the `Time` filter reading *Last 7 days*.
- **The audit log's own reads are excluded** (`exclude_action=audit:read`). No control states
  this one; it keeps the log from filling with the operator's own browsing of it.

None is a defect. All three change what *"the audit log"* means, and the screen's controls are the
only place two of them are stated — so a build that changed what the default hides without
changing what the controls say would be invisible.

### The controls, measured

| Control | Locator | Notes |
|---|---|---|
| Time | `audit-filter-time` (button, name *Time*) | reads *Time: Last 7 days* |
| Resource | `audit-filter-type` (button, name *Resource*) | *Connections & sign-in* sends `resource_type=sso_connection` |
| Result | `audit-filter-result` (button, name *Result*) | *Deny* sends `result=deny`, and on its own drops `kind=action` |
| Include permission checks | `role=checkbox`, that name | unticked by default; ticking drops `kind` |
| Export | `audit-export` | disabled while nothing matches |

The Resource labels are relabellings, not slugs: a screen that sent *Connections & sign-in* would
filter nothing and still look filtered, which is why one pair is pinned rather than assumed.

Rows are `tr[data-testid="audit-row-<event id>"]`. A deny renders its Result cell as **Denied**
(a denied *action* renders *Failed*); the filter option is *Deny*. Each event also renders a
second, attribute-less `<tr>` holding its collapsed details panel, which is empty when collapsed —
so a row is read through its testid, never as "every `<tr>` in the body".

## The export is asserted on its FILE now

On 1.12 the export was an XHR (`/authz/audit?…&size=200`) that the screen's duplicate-request
guard swallowed, so it answered `200` and produced no file (#1639); this spec asserted the request
only, and said it would tighten when that changed. It changed. Since 1.13 `Export` triggers a
**browser download** of

```
GET /api/v1/audits/export?exclude_action=audit%3Aread&result=deny&since=<…>
```

— the active filters, no `limit`, streamed server-side — after a one-row availability read. A
download bypasses the request layer that swallowed it, so #1639 is structurally obsolete, and the
file is now the thing worth asserting:

- named `langflow-audit-<UTC date>.csv`;
- header `timestamp,user_id,actor_type,actor_id,action,resource_type,resource_id,result,details,source,kind,resource_name,operation,error_code,request_id`;
- **every** row's `result` is `deny`, and the denial this run seeded is among them — the file is
  the filtered set, not the page.

The download request is invisible to `page.on("request")`, so the spec waits for the `download`
event and reads the URL from it.

## Tags *(required)*

`@enterprise` `@regression` `@ui-ux`

Same three as the sibling console specs. Not `@authz`: `operator-surfaces` owns the audit API and
its guards; this is the operator screen over it.

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would silently
never run (#1010).

## Step by step *(required)*

1. Authenticate once, require the **RBAC variant**, seed the browser session from the cached
   tokens — as every spec in this directory does — and declare the two per-resource `403`s (see
   Notes).
2. **Defaults.** Arm a listener, open `/admin/audit-logs`, and assert the first listing read
   carries exactly one `kind=action`, `exclude_action=audit:read` and a `since`, while `Time`
   reads *Last 7 days* and the checkbox is unticked.
3. **The checkbox.** Tick `Include permission checks` and assert the next listing read carries no
   `kind`.
4. **The Result filter.** Seed a denial **this run** — a role-less subject creating a flow in a
   project it does not own, which is refused `403` and audited `deny` — pick `Deny`, and assert
   the read carries `result=deny`, **every** `audit-row-*` ends in *Denied* (a permission check)
   or *Failed* (a denied action), and this run's subject is among them.
5. **The label mapping.** Pick *Connections & sign-in* under `Resource` and assert the read
   carries `resource_type=sso_connection`.
6. **The export.** Seed a denial as the shared subject, pick `Deny`, assert `Export` is enabled,
   click it and wait for the download: its URL is `/api/v1/audits/export` carrying `result=deny`
   and no `limit`; the file has the name and header above, every row is a deny, and the shared
   subject's id is among them.

## Validation criterion *(required)*

Fails when a control displays one filter and sends another, when the default view's narrowing
stops matching what the controls report, when a filter is accepted and ignored, or when the export
downloads anything but the filtered set — or nothing at all.

## External dependencies *(required)*

- A Langflow **Enterprise** instance on the RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`. On the 1.13 line the script sets
  `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true`; without it the user creation the seed
  needs answers `503` (#2259).
- A browser that accepts downloads (Playwright's default).
- No LLM provider, no network egress, no licence. **One** unit of the per-IP login budget on a warm
  instance, two on a cold one. The Result-filter test creates a subject unique to this run, which is
  what buys it correctness (see below); the export test seeds through the directory's **shared**
  subject, which is cached across processes and costs nothing after the first run. Making both
  tests create a unique subject doubled the file's login cost against a five-per-minute budget,
  and the repair for a data dependency arrived as a `429`.
- No Langflow **source** paths: the Enterprise frontend is not in `langflow-ai/langflow`, so there
  is none to name. Every sibling under `docs/enterprise/` is in the same position.

## Both filter tests seed, and the seed has to be identifiable

**A filter test that does not seed fails the first time it meets a clean database** (#1663): the
filtered set is empty and `Export` is correctly disabled. A spec that only passes on a dirty
instance is not passing, so both seed, and the export test asserts `Export` is **enabled** before
clicking so an empty set reports itself instead of timing out.

**Present is not enough, and a mutation proved it.** Seeding as the directory's shared subject and
asserting only *every visible row is a deny* stayed green with the seed removed — the shared
subject carries denials from every previous run. So the Result test creates a subject per run and
asserts **this run's denial is among the rows**, and the export asserts the shared subject's id is
in the file.

Seeding requires a write the subject is **refused**, which means naming a destination project it
does not own — a bare `POST /api/v1/flows/` is allowed by the owner override and audited
`owner_override`, not `deny` (#1635). `attemptFlowCreate` makes the destination a required
argument so it cannot be lost again.

## Notes

`GET /api/v1/flows/audits?limit=1` and `GET /api/v1/projects/audits?limit=1` answer **`403`** on
every mount, for the superuser too: they require `flow:audit_read` / `project:audit_read`, and no
built-in Enterprise role grants `audit_read` (EE `src/authz/roles.py`), so with bypass off the
superuser holding `admin` is refused. The screen marks those sources unavailable — by design — yet
its *Resource* filter still offers *Flows* and *Projects*. A product observation recorded in
#2259; declared with `page.expectKnownHttpError()` so a fix surfaces as a stale declaration that
names itself. The `403` is also why the seeded UI session must carry a **refresh token**: the
frontend answers any 401/403 by refreshing, and without one it logged the session out to `/login`
on this screen (a real form-login session refreshes and stays — measured).

The other non-2xx responses the console fires on every page load are covered in the shell spec's
notes, including the measurement trap that the fixture prints `Backend Error` on **stdout**.
