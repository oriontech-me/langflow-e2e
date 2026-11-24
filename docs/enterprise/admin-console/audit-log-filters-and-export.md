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
GET /api/v1/flows/audits?limit=1, /api/v1/projects/audits?limit=1   probe: offer Flows / Projects? (403, see below)
GET /api/v1/audits?exclude_action=audit%3Aread&kind=action&since=<7 days ago>&limit=50&include_total=true
```

The `limit=1` reads are availability probes, not listings, and the spec ignores them when it
reads "the query the screen sent".

### Flows and Projects are read from the unified feed, not from the sources the superuser is refused

The two per-resource probes answer **`403 Permission denied`** to the RBAC superuser on every
mount. That is the product's contract, not a defect (#2263): both routes require
`flow:audit_read` / `project:audit_read`, and Enterprise grants that permission **only through a
custom role** — the *Read audit trail* checkbox in the role editor (Enterprise commit
`c86afb69`, *"let custom roles grant audit trail reads"*, already in the measured build). The
built-in roles, `admin` included, do not carry it, and the Enterprise audit-log docs say owning
the resource is not enough either. Measured: a custom role holding `flow:audit_read` +
`project:audit_read` turns both reads from `403` into `200` for a role-less user, including over a
flow it does not own.

What made #2263 look like a screen defect does not hold, and this spec pins why:

- the probes decide only whether *Flows* and *Projects* are **offered**, and a `403` counts as
  *the route exists* — only `404` / `405` / `422` hide an option (the Enterprise frontend's
  `useResourceAuditSources`). So both stay in the *Resource* filter on purpose;
- picking one reads the **unified feed**, `GET /api/v1/audits?resource_type=flow` (or
  `project`), which is gated on superuser or the delegated-admin role and answers `200`. The
  refused source is never read for the listing. With the resource event store on, the superuser
  filtering *Flows* sees its own `flow:create` — measured.

### The Flows and Projects views list this run's flow and project

Flow and project events come from a **second** audit switch. `LANGFLOW_AUTHZ_AUDIT_ENABLED`
records sign-in, access-control, governance and permission-check events (the table behind
`/api/v1/authz/audit`). The flow and project events (`flow:create`, `project:create`, …) are
written to OSS's resource store only with `LANGFLOW_AUDIT_ENABLED=true`, default `false`. The
Enterprise audit-log docs name only the first switch, so an instance configured from them shows
*Flows* and *Projects* empty for every role, in the screen's ordinary empty state (#2530, LE-3527).

`start-langflow-enterprise.sh` now sets both on the RBAC and bypass variants. Measured on the
same container with only that variable changed: unset, `GET /api/v1/audits?resource_type=flow`
answers `200` with `total: 0` after the superuser creates a flow; set, the superuser's own
`flow:create` is listed (`kind: action`, `result: succeeded`), and the same for `project`. The
listing reads with the screen's own defaults (`kind=action`, the seven-day window, the
`audit:read` exclusion) return it, so it is on the first page the screen shows.

So the test seeds a project and a flow inside it **this run**, reads their `create` events' ids
from the feed, and asserts each one is listed as an `audit-row-<event id>` after picking
*Flows* and *Projects*. Before the screen opens it asserts both events exist in the feed, and
says which switch is missing when they do not: without that, an instance with the store off
fails as "row not visible", which reads as a screen defect.

Turning the store on was measured against the rest of the `@enterprise` lane before it was
committed. Every flow and project write now adds a row to the unified feed, so the export was
re-measured with more than 400 rows in it: since 1.13 the export is a browser download of
`/api/v1/audits/export`, outside the request layer whose duplicate-request guard aborted the
1.12 export past 400 rows (LE-2792), and it downloads the whole set.

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
(a denied *action* renders *Failed*); the filter option is *Deny* (#2265). Each event also renders a
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
   Notes). The declaration is verified in both directions, so a build that hands `audit_read` to
   a built-in role fails naming it.
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
6. **Flows and Projects despite the refused probes.** As the superuser, create a project and a
   flow inside it, and read their `flow:create` / `project:create` event ids from
   `GET /api/v1/audits` — failing with the name of `LANGFLOW_AUDIT_ENABLED` when either is
   missing. Arm a recorder for the per-resource sources before opening the screen. Assert each
   probe answered `403` with `Permission denied`, then pick *Flows* and *Projects* in turn: each
   is offered, each causes a unified-feed read carrying exactly that `resource_type` and
   answering `200`, the row for this run's event (`audit-row-<event id>`) is listed, and the
   per-resource sources receive no read other than the `limit=1` probes. The flow and the
   project are deleted at the end.
7. **The export.** Seed a denial as the shared subject, pick `Deny`, assert `Export` is enabled,
   click it and wait for the download: its URL is `/api/v1/audits/export` carrying `result=deny`
   and no `limit`; the file has the name and header above, every row is a deny, and the shared
   subject's id is among them.

## Validation criterion *(required)*

Fails when a control displays one filter and sends another, when the default view's narrowing
stops matching what the controls report, when a filter is accepted and ignored, or when the export
downloads anything but the filtered set — or nothing at all. Also fails when *Flows* or *Projects*
stops being offered, when picking one reads anything but the unified feed (in particular the
per-resource source the superuser is refused), when the view does not list the flow or project
this run created, or when the built-in `admin` role stops being refused `audit_read` — a
contract change worth noticing either way.

## External dependencies *(required)*

- A Langflow **Enterprise** instance on the RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`. On the 1.13 line the script sets
  `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true`; without it the user creation the seed
  needs answers `503` (#2259). It also sets `LANGFLOW_AUDIT_ENABLED=true`, without which no flow
  or project event is recorded and the Flows/Projects test fails naming the variable (#2530).
  A container started before that change has to be recreated with the script.
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
every mount, for the superuser too, **by design**: `audit_read` is granted only through a custom
role, and with bypass off the superuser holding the built-in `admin` is refused (see *Flows and
Projects are read from the unified feed* above; #2263 closed on that). They are declared with
`page.expectKnownHttpError()` because it is the narrowest hatch the fixture has — the fixture
labels the line *Known backend defect*, which here means *known, expected refusal* — and the
declaration still fails naming itself if a build stops refusing. An earlier version of this note
said the screen marks a refused source unavailable; it does the opposite, and the test asserts it.

The `403` is also why the seeded UI session must carry a **refresh token**: the frontend answers
any 401/403 by refreshing, and without one it logged the session out to `/login` on this screen (a
real form-login session refreshes and stays — measured). So every visit to the screen costs two
refresh round-trips; that is noise, not a functional defect.

The other non-2xx responses the console fires on every page load are covered in the shell spec's
notes, including the measurement trap that the fixture prints `Backend Error` on **stdout**.
