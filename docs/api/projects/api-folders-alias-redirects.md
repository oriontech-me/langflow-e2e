# API Folders — the legacy alias, seven redirects (`/api/v1/folders`)

**File:** `tests/tests-automations/regression/api/projects/api-folders-alias-redirects.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1707 (Wave 7 — OSS API coverage, `folders` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

`/api/v1/folders` is not a second implementation — since the rename it is a router of
**pure redirects** onto `/api/v1/projects`, hidden from `/openapi.json`
(`include_in_schema=False`) and therefore invisible to any schema-derived coverage
count. Seven operations, none of them asserted anywhere in this repo, and the whole
contract is: **`307`, and a `location:` that maps onto the right twin**.

Measured on `1.13.0.dev0`, all seven:

| Alias | Status | `location:` |
|---|---|---|
| `GET /api/v1/folders/` | `307` | `/api/v1/projects/` |
| `POST /api/v1/folders/` | `307` | `/api/v1/projects/` |
| `GET /api/v1/folders/{folder_id}` | `307` | `/api/v1/projects/{id}` |
| `PATCH /api/v1/folders/{folder_id}` | `307` | `/api/v1/projects/{id}` |
| `DELETE /api/v1/folders/{folder_id}` | `307` | `/api/v1/projects/{id}` |
| `GET /api/v1/folders/download/{folder_id}` | `307` | `/api/v1/projects/download/{id}` |
| `POST /api/v1/folders/upload/` | `307` | `/api/v1/projects/upload/` |

There is **no** `PUT /api/v1/folders/{id}`: the projects family has one, the alias does
not, and the verb answers `405`. The baseline records 7 here against 8 there for that
reason.

**Why `307` and not `301`/`302` is the assertion.** A `307` preserves the method **and
the body**; a `302` is where clients turn a `POST` into a `GET`. Every pre-rename
client — and `helpers/filesystem/clean-old-folders.ts` in this repo — still calls the
alias. A "cleanup" that downgraded the status, or dropped one of the seven routes,
would break those callers silently, and nothing today would fail.

**The query string is part of the contract too.** `GET /folders/{id}` rebuilds the
target URL by hand, forwarding `is_component`, `is_flow`, `search`, `page` and `size`
when present — so an alias call with pagination must land on a target URL that still
carries it. That hand-built forwarding is exactly the kind of code that loses a
parameter in a refactor.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

`@stable`: three requests per assertion at most, no fixture beyond one project, no
provider.

---

## Step by step *(required)*

One test over the `request` fixture, declaring all seven operations through
`apiCoverage`. Every call sets **`maxRedirects: 0`** — the default follows the
redirect and would assert the *target's* answer, which is precisely what this file
must not do. One project is created for the id-bearing routes and deleted in
`afterEach`.

**Test — `every folders route is a 307 onto its projects twin, and the alias has no PUT`**
1. Create a project (its id is the `{folder_id}` for four of the seven).
2. For each of the seven aliases: issue it with `maxRedirects: 0` and assert
   `status() === 307` and `headers().location` **exactly equal** to the twin path.
3. `GET /api/v1/folders/{id}?is_flow=true&search=probe&page=2&size=5` → `307` with a
   `location` that carries all four parameters (the hand-built forwarding).
4. `PUT /api/v1/folders/{id}` → `405` — the verb the alias does not have.
5. Follow one of them for real (`POST /api/v1/folders/` with a body, default
   `maxRedirects`) and assert it lands on `201` with a created project — proof the
   `307` preserved the method and the body, and not merely the header.

Step 5's project is pushed for cleanup like any other.

---

## Validation criterion *(required)*

The test passes three consecutive times at `--retries=0 --workers=1`, with all seven
`location` values asserted as **exact strings** (a substring match would accept a
redirect to the wrong id), the query-forwarding case asserted on all four parameters,
the missing `PUT` asserted as `405`, the followed `POST` asserted as a real `201`, and
the declared coverage — all seven `/api/v1/folders` operations — matching what the
fixture recorded. Zero projects left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/folders.py` — the redirect router, the whole
  subject of this file.
- `src/backend/base/langflow/api/v1/projects.py` — the twin every route points at.
- No provider key, no model, no network egress.
