# Auth — Login Rate Limit

**Last validated:** Langflow 1.12.0.dev32 (`langflowai/langflow-nightly:latest`)

---

## What this test validates *(required)*

`POST /api/v1/login` is rate-limited per client, and nothing asserts it. This is
an **OSS** behaviour, not an Enterprise one — `rate_limit_enabled` is on and
`rate_limit_per_minute` is 5 on the nightly image exactly as on an Enterprise
build — so it belongs here, in the lane that actually runs on a schedule.

The limiter is a **security control**: it is what makes credential stuffing
expensive. It is also a control that silently breaks every password-first
consumer if its window or budget changes. Neither direction has a test today,
because the suite reaches Langflow through `auto_login` and almost never posts to
`/api/v1/login` at all.

Measured on `1.12.0.dev32` with `LANGFLOW_WORKERS=1`, on a dedicated instance:
five correct logins answer `200` and the sixth `429`; five wrong ones answer
`401` and the sixth `429`; after the window a correct credential answers `200`
again. The refusal body is
`{"detail": "Too many requests. Please try again later.", "retry_after": "60"}`
and the response carries a `retry-after` header.

Read from the image's own source, which is what the assertions are shaped
around:

- `check_rate_limit(request)` is the **first statement** of the login handler,
  before `authenticate_user`. So **every attempt counts**, successful or not —
  the property that makes the control meaningful, since a limiter that only
  counted failures could be reset by interleaving one good login.
- The refusal carries `detail`, `retry_after` in the body, and a `Retry-After`
  header. A client that cannot learn when to retry treats the limiter as an
  outage.
- The counter is keyed on the client address, and `check_rate_limit` takes an
  optional `scope` so other rate-limited surfaces (public flow builds) get their
  own namespace instead of consuming the login budget.

## Tags *(required)*

`@destructive` `@api` `@auth` `@regression`

`@destructive` is the honest lane, and it costs something worth stating. The
budget is keyed on the **client address**, not the user, so it cannot be
isolated: eight specs in this suite authenticate through `POST /api/v1/login`
(six directly, two through the UI), and exhausting the window would hand them a
`429` — a red whose symptom points nowhere near its cause. Running alone, with
`workers: 1`, is the only way this spec cannot poison a neighbour.

The price: `daily-stable.yml` has no destructive lane, so this does **not** run
on the schedule. It runs in the PR lane's destructive step and on demand. That
is a real loss of the protection this spec exists to give, accepted because a
spec that flakes eight others is worse than one that runs less often.

`@regression` for the recovery assertion: a limiter that never reopens is an
outage of its own, and it is the failure mode a spec is most likely to catch
before users do.

**No `@stable`** — combining it with `@destructive` would mean the daily selects
a test its lane never runs (#1010).

## Step by step *(required)*

`mode: "serial"` — the budget is shared state; two tests spending it
concurrently would each see the other's attempts.

**Test 1 — the limit is reached and the refusal is usable**
1. Post logins until one answers `429`, within a bounded number of attempts.
2. Assert the body carries a `detail` and a `retry_after`, and that the
   `retry-after` **header** agrees with it — read through Playwright's
   `response.headers()`, which lower-cases header names. A case-sensitive read
   of `Retry-After` against a raw header map returns nothing here (uvicorn emits
   it lower-cased), which is how a first probe of this endpoint concluded the
   header was missing when it is present.

**Test 2 — every attempt counts, not only the failures**
1. After the window, interleave a **correct** login among wrong ones.
2. Assert `429` still arrives — a successful login must not reset or bypass the
   counter.

**Test 3 — recovery**
1. After the advertised `retry_after`, a correct credential is accepted again.
2. Assert the response carries an access token, so "accepted" means authenticated
   rather than merely not-refused.

## Validation criterion *(required)*

Fails if the endpoint never refuses within the bounded attempts (the control is
gone), if the refusal omits the retry information (clients cannot comply), if a
successful login resets the counter (brute force becomes free), or if the limiter
does not reopen after its own advertised window (a self-inflicted outage).

## External dependencies *(required)*

- **A dedicated Langflow instance** when run locally. The counter is keyed per
  client address and is instance-global, so exercising it against the shared
  runner spends the budget of everything else pointed at it, including parallel
  work by other people. In CI the destructive lane already provides isolation:
  it runs alone against the job's own service container.
- **`LANGFLOW_AUTO_LOGIN=false`**, so `/api/v1/login` is the real path.
- No LLM provider, no network egress.

## Known limitation: a worker recycle resets the counter

Storage is `memory://` and lives in the worker process, so a worker restart
takes the counter with it. A recycle in the middle of the burst would let the
spec spend its whole attempt budget without ever being refused, and it would
then report that the limit is not being enforced — the wrong cause.

Observed while validating this spec locally: the instance's worker was
`SIGKILL`ed (memory pressure from unrelated containers on the same host), and the
run failed with a transport error rather than an assertion.

This is deliberately **not** worked around with a retry. A retry that swallows
the recycle would also swallow the case where the limiter genuinely disappeared,
which is the defect this spec exists to catch. Instead the failure message names
both causes and points at the instance log. In CI the risk is small: the
destructive lane runs against a fresh service container with room to spare.

## Two things the spec must NOT assert, and why

**An exact attempt count.** Two independent reasons. Storage is `memory://` and
the limiter is built per process, so with `LANGFLOW_WORKERS > 1` each worker
holds its own counter and the observed budget is a multiple of the configured
one, varying with which worker answers. And the window is fixed per minute
rather than sliding per client, so a run that starts midway through a window
that something else already spent from is refused earlier — measured: the same
endpoint refused on the 6th attempt in one round and on the 5th in the next. Asserting "the 6th attempt is refused" would pass on the daily
(`LANGFLOW_WORKERS=1`) and fail anywhere else, as a false red that looks like a
product regression. The assertion is therefore "refused within N attempts",
with N chosen well above the configured limit.

**A hardcoded wait.** The recovery step waits the `retry_after` the server
advertised, not a constant copied from the settings. Pinning 60 s here would turn
a product-side change of the window into a spec failure with a misleading cause.
