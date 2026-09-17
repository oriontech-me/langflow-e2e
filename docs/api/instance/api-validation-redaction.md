# 422 validation errors must not echo submitted values (LE-2462)

**File:** `tests/tests-automations/regression/api/instance/api-validation-redaction.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev14`)

Owning issue: #1846 (follow-up of #1841, fix PR #1845). Upstream:
[langflow-ai/langflow#15038](https://github.com/langflow-ai/langflow/pull/15038) — LE-2462,
observation O1.

---

## What this test validates *(required)*

A **security contract of the whole API**, not of one route: a `422` names the field that
failed and never reflects the value that was submitted. Upstream installs
`langflow/api/validation_errors.py` as the app-level `RequestValidationError` handler
(`main.py`, `app.add_exception_handler(RequestValidationError, …)`), replacing FastAPI's
default `jsonable_encoder(exc.errors())`. The default echoed the caller's data back into
proxy logs, browser devtools and error trackers — and for a `type: "missing"` entry it
echoed the **whole enclosing object**, which is how a valid `access_token` could come
back in an error body because a sibling field was absent.

**The suite noticed this only by accident.** #1841's routing test asserted
`input: "batch"` on the slash-less batch `DELETE` and went red when the handler landed;
#1845 removed that assertion deliberately rather than inverting it, because pinning
redaction *there* would couple a routing test to a security property and fail against
`≤ 1.12.x`. That left the contract itself uncovered: **if upstream reverted the handler,
or a new router bypassed it, nothing in the suite would go red.** This spec is that
missing red.

### The contract, measured on `1.13.0.dev14`

Every row below is a request this spec issues. `SENTINEL` is a unique-per-run string of
at least 8 characters (`Redaction-probe-<uuid>`); no row's response contains it.

| Shape | Request | `422` body |
|---|---|---|
| **missing sibling** — the credential-leak case | `POST /api/v1/variables/` `{"value": "<SENTINEL>"}` (`name` and `default_fields` absent) | `{"detail":[{"type":"missing","loc":["body","name"],"msg":"Field required"},{"type":"missing","loc":["body","default_fields"],"msg":"Field required"}]}` — **no `input`**, where the default handler carried `input: {"value": "<SENTINEL>"}` |
| **validator that quotes its value** | `POST /api/v1/flows/` `{"icon": ":<SENTINEL>"}` | `{"type":"value_error","loc":["body","icon"],"msg":"Value error, Invalid emoji. [redacted] is not a valid emoji."}` — the validator's own message is `f"Invalid emoji. {v} is not a valid emoji."`, and the scrub replaced the value with the literal `[redacted]`. **No `ctx`** |
| **non-uuid path param** | `GET /api/v1/flows/<SENTINEL>` | `{"type":"uuid_parsing","loc":["path","flow_id"],"msg":"Input should be a valid UUID, invalid character: found \`R\` at 1"}` — **no `input`, no `ctx`**; pydantic's `ctx: {"error": …}` is input-derived and dropped |
| **schema-derived `ctx` survives** | `GET /api/v1/users/` with `X-Langflow-Operation-ID` longer than 128 | `{"type":"string_too_long","loc":["header","X-Langflow-Operation-ID"],"msg":"String should have at most 128 characters","ctx":{"max_length":128}}` |
| **schema-derived `ctx` survives** | `GET /api/v1/connections?provider=<SENTINEL>` | `{"type":"string_pattern_mismatch","loc":["query","provider"],"msg":"String should match pattern '^[a-z0-9][a-z0-9._-]*$'","ctx":{"pattern":"^[a-z0-9][a-z0-9._-]*$"}}` |

The last two rows are what stops the contract from being satisfied by *"strip
everything"*: a handler that dropped `ctx` wholesale would pass every sentinel-absence
assertion in this file and silently remove the schema information a client needs to fix
its request. The handler's own rule is a keyed allow-list (`_SCHEMA_CTX_KEYS`:
`min_length`, `max_length`, `pattern`, `expected`, `ge`, `lt`, …), applied **only** to
built-in pydantic error types — a custom error keeps no `ctx` at all.

### Two measured boundaries, recorded and deliberately not asserted

- **`MIN_REDACTED_LENGTH` is exactly 8, measured on the wire.** `icon: ":abcdef"` (7
  characters submitted) answers `Invalid emoji. :abcdef is not a valid emoji.`;
  `icon: ":abcdefg"` (8) answers `[redacted]`. The spec pins the **8 side** — an exactly
  8-character value must redact — so a future upstream *raise* of the threshold goes red,
  while a *lower* threshold (strictly better) never does. Asserting the 7-character leak
  would redden the suite for a security improvement.
- **The scrub matches submitted strings verbatim**, so a message quoting a *transformed*
  value is not caught. `uuid_parsing` demonstrates it in the wild: its message quotes the
  offending character (``found `R` at 1``), one character of the sentinel. The full
  sentinel is still absent, which is why every assertion in this spec is over the whole
  sentinel and never over a single character.

### What the handler does not cover, and why nothing here asserts it

- **`ResponseValidationError` is a different exception** and this handler is not
  registered for it (stated in the module docstring, and visible in `main.py` — the only
  `add_exception_handler` for it is `RequestValidationError`). Provoking one requires a
  backend defect, so there is no request this spec could send to observe it. Recorded as a
  boundary, not asserted.
- **Field *names* are not values.** `_submitted_strings()` walks mapping *values* only,
  so a caller that puts a secret in a JSON **key** still sees it in `loc`. That is the
  handler's documented design, not a gap this spec found.

---

## Tags *(required)*

`@api` `@regression` `@stable`

`@stable`: a handful of HTTP requests over the `request` fixture — no browser, no
provider, no model, no run, and the whole file measures under 3 s. Nothing persists:
every write is refused during request validation and never reaches a handler.

`@regression`: the contract is the product change #1841 caught by accident.

---

## Step by step *(required)*

Four tests over the `request` fixture. `beforeAll` takes a token
(`GET /api/v1/auto_login`, via `getAuthToken`) and reads `GET /api/v1/version` once to
resolve the release gate (below); each test then runs its own shapes.

**Test 1 — `a missing field does not echo the object it was missing from`**
1. `POST /api/v1/variables/` with `{"value": "<SENTINEL>"}` → `422`.
2. Every `detail` entry has **no `input`** key, and its key set is a subset of
   `{type, loc, msg, ctx}`.
3. The raw response text does **not** contain `SENTINEL`.
4. The two entries are `missing` on `["body","name"]` and `["body","default_fields"]`,
   with the fixed pydantic template `"Field required"` **unchanged** — the control that
   the body was parsed and refused on the right fields rather than rejected unread.
5. **The response does not depend on what was submitted**: the same request with a
   harmless value in `value` answers a **byte-identical** body.
6. No variable was created: the whole `GET /api/v1/variables/` listing, serialised, does
   not contain the sentinel. Read what that control is and is not — the listing never
   returns values (`value` is `null` on every row, with `has_value` carrying the fact
   instead), so serialising it adds only metadata over a name check. The real evidence
   that nothing persisted is the `422` itself: the request is refused during validation
   and never reaches a handler. The step is the cheap belt to that braces.

**Test 2 — `a validator that quotes its input answers [redacted]`**
1. `POST /api/v1/flows/` with `icon: ":" + SENTINEL` (a leading colon with no trailing
   one is the branch that raises `f"Invalid emoji. {v} is not a valid emoji."`) → `422`.
2. Every entry is `value_error` on `["body","icon"]`, its `msg` **contains the literal
   `[redacted]`** and does **not** contain `SENTINEL`, and it carries **no `ctx`** —
   a custom error's ctx is dropped whole.
3. The raw response text does not contain `SENTINEL`.
4. `icon: ":abcdefg"` — exactly 8 submitted characters — also answers `[redacted]`,
   pinning `MIN_REDACTED_LENGTH`.
5. No flow was created: `GET /api/v1/flows/?header_flows=true` lists nothing named by
   the probe (the flag drops each flow's `data`, taking the listing from ~4.7 MB to
   ~14 KB on a starter-project account — measured).

**Test 3 — `a non-uuid path parameter drops both the value and its input-derived ctx`**
1. `GET /api/v1/flows/<SENTINEL>` → `422`.
2. Every entry is `uuid_parsing` on `["path","flow_id"]` — the control that the sentinel
   really reached the path parser — with **no `input`** and **no `ctx`**.
3. The raw response text does not contain `SENTINEL`.

**Test 4 — `schema-derived ctx survives while the value does not`**
1. `GET /api/v1/users/` with an `X-Langflow-Operation-ID` header of `SENTINEL` padded past
   128 characters → `422`, `string_too_long` on `["header","X-Langflow-Operation-ID"]`,
   `ctx` deep-equal `{max_length: 128}`, no `input`, sentinel absent from the raw text.
2. `GET /api/v1/connections?provider=<SENTINEL>` → `422`,
   `string_pattern_mismatch` on `["query","provider"]`, `ctx.pattern` non-empty and a
   valid regular expression, no `input`, sentinel absent from the raw text.

### The release gate

The handler first shipped in **`1.13.0.dev10`** (#1845 probed it inside the container;
`1.13.0.dev9` was built before the merge, and `1.12.2` still echoes `input`). A dispatch
pinned to an older image would go red on a contract that image never claimed, so
`beforeAll` compares `GET /api/v1/version` → `version` against `1.13.0.dev10` and the
tests `test.skip` with the version named. PEP 440 ordering is respected, so `1.13.0rc1`
and `1.13.0` both count as newer than `1.13.0.dev14`.

The gate is on the **version**, never on the behaviour. A capability probe — *"does this
instance redact?"* — would skip precisely when the contract is broken, which is the
green all-skip #1010 exists to prevent.

**The release triple decides; the suffix is consulted only on a tie, and that split is
the whole robustness of the gate.** Langflow has published `1.1.4.post1`, `1.8.0qa1`,
`1.7.0-pre` and a run of `0.5.0b*` alongside the `devN`/`rcN` it ships today, and a gate
that refused any string it could not fully parse would turn each of those into a hard
failure telling the reader to fix *our* gate — the opposite of the skip this exists to
produce. The dangerous direction is forward: a future **`1.13.x.postN` carries the
handler**, so it must **run**, and PEP 440 orders `.postN` *after* the base release,
which is exactly what makes it decidable. So `1.8.0qa1` skips on its triple alone
without the suffix ever being understood, and only a build on the floor's **own**
release with an unreadable suffix (`1.13.0qa1`) is undecidable — reported as **unknown**,
which **fails**, because an unevaluated precondition is unknown, not clean (#1012). A
string with no readable `X.Y.Z` at all fails the same way.

A PEP 440 **local** identifier (`1.13.0.dev14+g1234`, what a `setuptools-scm` build of
the release line emits) is stripped before ordering: it records where a build came from,
never where it sits, and such a build does carry the handler — so it runs rather than
hard-failing.

A failure here aborts the suite rather than reddening four tests: Playwright reports the
first test as failed and the other three as *did not run* when a `beforeAll` throws. The
run is red either way, and the reason names the gate file so nobody files a Langflow bug
for it.

---

## Validation criterion *(required)*

The four tests pass three consecutive times at `--retries=0 --workers=1` against
`langflowai/langflow-nightly:latest`, with:

- the per-run `SENTINEL` absent from the **raw response text** of all five requests — not
  merely `detail[i].input === undefined`, which a renamed field would pass;
- the `[redacted]` literal **present** in the icon message, so the absence is paired with
  a positive control that the scrub fired rather than that the request never carried the
  value;
- `ctx` **absent** on `uuid_parsing` and `value_error`, and **present with its schema key**
  on `string_too_long` and `string_pattern_mismatch` — the pair that a "drop everything"
  handler fails;
- the `missing` entries byte-identical between a sentinel-carrying body and a harmless
  one;
- every entry's key set a subset of `{type, loc, msg, ctx}`, so a field re-added under a
  new name is caught;
- nothing created: no flow carries the probe name, and the serialised variables listing
  does not contain the sentinel anywhere — a superset of a name check, and secondary to
  the `422` itself, which means no handler ran.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/validation_errors.py` — the handler itself: `input` is
  dropped, `_SCHEMA_CTX_KEYS` decides what `ctx` keeps, `MIN_REDACTED_LENGTH` and
  `REDACTED` decide the `msg` scrub. Every assertion in this spec is a property of this
  file.
- `src/backend/base/langflow/main.py` — where it is registered
  (`app.add_exception_handler(RequestValidationError, request_validation_exception_handler)`).
  A route mounted on a sub-application with its own handler would bypass it.
- `src/backend/base/langflow/services/database/models/flow/model.py` — the `icon`
  validator whose message quotes the submitted value; it is the only one found on a
  **request path** that does (others exist deeper in the package — `traces/model.py`
  among them — but no request reaches them as a `422`), and Test 2 is built on it.
- `src/backend/base/langflow/services/database/models/variable/model.py` —
  `VariableCreate`, whose required `name`/`default_fields` produce the `missing` shape.
- `src/backend/base/langflow/api/v1/users.py` — the `X-Langflow-Operation-ID` header with
  `max_length=128`, Test 4's `string_too_long` vehicle.
- `src/backend/base/langflow/api/v1/connections.py` — the `provider` query parameter with
  its `pattern`, Test 4's `string_pattern_mismatch` vehicle.
- `src/backend/base/langflow/api/v1/flows.py` — `POST /api/v1/flows/` and
  `GET /api/v1/flows/{flow_id}`, the routes Tests 2 and 3 drive.
- No provider key, no model, no network egress.

---

## What this test does not cover *(optional)*

- **`ResponseValidationError`** — a different exception, deliberately out of the
  handler's scope and unreachable without a backend defect (see above).
- **Secrets submitted as field *names***, which land in `loc` by design.
- **Every route.** The handler is registered once on the app, so this spec asserts the
  contract on five routes chosen for the *shapes* they produce, not for the routes
  themselves. A future sub-application with its own handler would bypass it and is not
  detected here.
- **`apiCoverage.declare()` is deliberately not called.** The gauge's definition of
  *covered* is that a spec drives an operation on purpose and asserts **that operation's**
  status and body shape (`docs/api/api-surface-coverage-gauge.md`). Here the five routes
  are vehicles for an error-handler contract; declaring them would credit
  `GET /api/v1/users/` and `POST /api/v1/flows/` with coverage this file does not provide.

---

## Preconditions *(optional)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL` on `1.13.0.dev10` or newer
  (older images skip with the version named), auto-login or superuser.

---

## Notes *(optional)*

- `POST /api/v1/flows/` answers **two identical `value_error` entries** for one bad
  `icon`, and `GET /api/v1/flows/<non-uuid>` two identical `uuid_parsing` entries. The
  spec asserts over **every** entry rather than over `detail[0]` or a count, so a
  duplicate-registration change upstream does not redden it.
- The sentinel carries an uppercase letter so the same string also violates the
  `^[a-z0-9][a-z0-9._-]*$` pattern in Test 4 — one value across all four tests, which is
  what makes *"appears nowhere"* a single claim.
