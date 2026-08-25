# The serving-identity lane

**Last validated:** Langflow 1.12.0.dev38 — the lane's three variants were started and read back on `dev38`; the four-configuration contract below was measured on `dev37` (`langflowai/langflow-nightly@sha256:b672ab7e…`, upstream revision `50340f2a…`) and re-confirmed by the isolation probe on `dev38`. The nightly moved mid-delivery, which is itself the reason the script reads its settings out of the running process rather than trusting the tag.

---

## What this test validates *(required)*

This document specifies **infrastructure, not a test** — the third run lane, its selector, its container variants and the `@serving` tag. It ships no `.spec.ts`; the specs that consume it are #1583. `docs/component-distribution-policy.md` is the precedent for a `docs/` artifact that specifies a mechanism rather than a single test.

What the lane makes assertable is a **cross-user memory boundary**. Langflow 1.12 added serving-plane end-user identity (`langflow-ai/langflow` [#14443](https://github.com/langflow-ai/langflow/pull/14443), [#14550](https://github.com/langflow-ai/langflow/pull/14550)): a trusted gateway header scopes per-user chat memory, so two end users sharing one `session_id` do not read each other's history. The feature is **off by default** and configured entirely by instance-global environment variables — so today that boundary is unreachable from every lane this suite has, and a spec that gated on the settings and skipped would skip everywhere, which is the green all-skip #1010 exists to prevent.

### The measured contract — four configurations

Measured on `1.12.0.dev37`, instance identity asserted first (`GET /api/v1/version` → `package: "Langflow Nightly"`). All six settings exist in the image at their off/fail-closed defaults: `serving_end_user_header=None`, `serving_trust_proxy_headers=False`, `serving_end_user_required=False`, `serving_internal_mcp_hosts=None`, `serving_trace_end_user=False`, `rate_limit_trust_proxy=False`.

| Configuration | No header | `X-End-User-Id: alice` |
|---|---|---|
| **default** — header unset | runs in `S`, persists there | **ignored** — runs in `S`, persists there |
| `HEADER` + `TRUST=true` | `anon::<uuid>`, persists **nothing** | `alice::S`, isolated; bare `S` stays empty |
| `HEADER` + `TRUST=false` | — | `anon::<uuid>`, persists **nothing** |
| … + `REQUIRED=true` | **`401 END_USER_IDENTITY_REQUIRED`** | `200`, `alice::S` |

Two rows are why the lane is worth its cost.

**The isolation is a leak boundary, and it holds on both serving surfaces.** With `TRUST=true`, `alice` and `bob` on one `session_id` resolve to `alice::S` and `bob::S` with two messages each while the bare `S` holds **zero** — on `POST /api/v2/workflows` and on `POST /api/v1/run/{id}` alike, which is #14550's phase 1 ("extends the v2-only session-scoping behavior to all serving APIs"). An anonymous run reports `anon::<uuid>` and writes **zero** rows, verified over the whole flow (`?flow_id=`) rather than only the session it reported.

**`HEADER` set with `TRUST=false` is fail-closed for security and fail-*silent* for operations.** The header is not honoured — no `alice::S` appears — but the request does not fall back to the plain session either: it becomes `anon::<uuid>` and persists nothing, so **naming the header without trusting it silently stops all chat memory instance-wide while every run still answers `200`**. An operator who sets `LANGFLOW_SERVING_END_USER_HEADER` and forgets `LANGFLOW_SERVING_TRUST_PROXY_HEADERS=true` has a working-looking instance that remembers nothing.

A whitespace-only header value is refused `401` under `REQUIRED=true` — blank is not an identity.

---

## Tags *(required)*

The deliverable **defines** a tag rather than carrying one, and where it goes was decided during implementation rather than assumed.

`@serving` is a **lane selector**, and belongs in `CLAUDE.md`'s **cross-cutting** table beside `@destructive` and `@enterprise` — not in the functional one. An earlier draft of this document called it functional, reasoning that the serving plane has no product area to reuse (`@playground` is the chat UI, not the transport that scopes its memory). That reasoning is sound and the conclusion was still wrong: the tag is what `grepInvert` matches on, so it *behaves* as a lane selector, and filing it under "product area — use alongside cross-cutting tags" would have described it as something a spec adds for classification when in fact it decides whether the spec runs at all.

No separate functional tag is needed, because here the lane and the area coincide: a spec that needs this instance is a serving-plane spec by construction. #1583's specs carry `@api @regression @serving` — `@api` for the layer, `@regression` for the upstream fixes they pin, `@serving` for the lane. The environment flag is `PW_SERVING_IDENTITY`, kept distinct from the tag for the same reason `PW_ENTERPRISE` is distinct from `@enterprise`: one selects the run, the other marks the test.

**Parallel, not serial, and that is a decision rather than an inheritance.** The two existing lanes both pin `workers: 1`, for causes that do not apply here: `@enterprise` because the instance runs password-first and Langflow rate-limits `/api/v1/login` per IP, so parallel workers report product assertions as `429`s; `@destructive` because two account wipers erase each other. A serving-identity run has neither — the variant image keeps `auto_login`, and the isolation under test is keyed per `session_id`, so every test owns its own bucket and no test mutates account-wide state. Copying `serial: true` across would have cost roughly 4× wall clock for no measured reason, which is why `lane.ts` records the cause of each lane's serialisation rather than the fact of it.

---

## Step by step *(required)*

**1 — the selector, in `tests/fixtures/lane.ts`.**
`PW_SERVING_IDENTITY=1` selects the lane; every other invocation excludes `@serving` through `grepInvert`, for the reason the file already documents — a CLI `--grep` overrides `config.grep` but leaves `config.grepInvert` in place, so no caller can widen a lane by passing a filter of its own. The lane returns `serial: false`.

**2 — precedence, because three flags can be set at once.**
The three lanes need three different instances, so more than one flag is not an error the config can usefully refuse; one wins and the caller is told. The order is **`@enterprise` > `@serving` > `@destructive`**, by how specialised an instance each demands: Enterprise needs a separate build, serving-identity needs the same image under different configuration, destructive needs only isolation. Announced in a notice, never silent.

**3 — mutual exclusivity stays pinned.**
`lane.test.ts` already asserts a test is selectable by exactly one lane; it gains the third, including the pairs `@serving @destructive` and `@serving @enterprise`, which must be unrunnable in every lane.

**4 — `scripts/start-langflow-serving-identity.sh`.**
Mirrors `start-langflow-docker.sh`'s env block verbatim — every variable there is a decision with an issue behind it (`ALLOW_CUSTOM_COMPONENTS` #668, `A2A_ENABLED` #1240, `SSRF_ALLOWED_HOSTS`, `WORKERS` #773) — plus the serving knobs. It **parameterises all three states** #1583 needs, since a script that hardcoded `TRUST=true` would leave two of that issue's bullets unwritable:

| invocation | `HEADER` | `TRUST` | `REQUIRED` |
|---|---|---|---|
| `./scripts/start-langflow-serving-identity.sh` | `X-End-User-Id` | `true` | `false` |
| `LANGFLOW_SERVING_TRUST=0 …` | `X-End-User-Id` | `false` | `false` |
| `LANGFLOW_SERVING_REQUIRED=1 …` | `X-End-User-Id` | `true` | `true` |

Container `langflow-serving-identity` and port `7893` by default, both overridable (`LANGFLOW_SERVING_CONTAINER`, `LANGFLOW_SERVING_PORT`), clear of `7860` and of Enterprise's `7890`–`7892`. It `docker rm -f`s **only its own name** — never the shared `langflow-e2e-runner`, which `start-langflow-docker.sh` does remove regardless of `LANGFLOW_PORT`, and which is how a parallel session's instance gets destroyed by someone who thought changing the port was enough. Like the Enterprise script it **warns rather than refuses** when a sibling variant is already up: the ceiling is the VM's, not the script's.

**5 — the shadow check, which the plan did not have and the first run demanded.**
The script's own first invocation printed `{"version":"1.12.0","package":"Langflow"}` while its container ran `1.12.0.dev38`: port `7880` was held by an unrelated process on `127.0.0.1`, and a loopback bind beats docker's `0.0.0.0` publish for `localhost` connections — so the container was healthy, `docker port` looked right, and every request went somewhere else. That failure mode has cost this project a whole measurement pass before, and it is silent by construction: each reading looks healthy on its own.

The fix is not a luckier port number — on another box any default can be shadowed. The script already takes **two** readings (`curl` over HTTP, and `docker exec` into the container), so it compares them: if the version answering on `localhost:${PORT}` does not contain the version the container reports, it **exits 1** naming both readings, the `lsof` that finds the impostor, and the override that steps aside without touching the other process. Verified by running against the shadowed port on purpose. Measured occupancy on this box at the time: `7860 7862 7866 7867 7870 7880 7881 7884 7885 7890` — note `7890`, which is the Enterprise script's default, so that script is exposed to the same trap and does not check for it (out of scope here, worth a follow-up).

**6 — `CLAUDE.md`.** Rows for the `@serving` tag and the lane in the tag tables, carrying the measured contract above in the compressed form the file uses.

---

## Validation criterion *(required)*

- `npm run test:units` passes, with `lane.test.ts` covering the third lane: it is selected by `PW_SERVING_IDENTITY`, excluded from every other invocation, returns `serial: false`, and cannot be co-selected with either other lane. Reverting the `serial: false` decision to `true` must fail a test — the decision is pinned, not commented.
- The three script invocations each produce an instance reporting `Langflow Nightly 1.12.0.dev*`, whose `Settings()` reads back exactly the row of the table above. Asserted by reading the settings out of the running container, not by trusting the `-e` flags: an env var Langflow does not bind is silently ignored, which is how a variant that configures nothing looks identical to one that works. **Measured**: all three produced their exact row on `dev38`.
- A shadowed port **fails the script** rather than being reported as a healthy start, naming both disagreeing readings. Verified by pointing it at a port held by another process.
- The script leaves `langflow-e2e-runner` running when it is present — the destructive-by-accident case, checked explicitly.
- No spec runs in this delivery and none should: `npx playwright test --grep @serving` selects **zero** tests until #1583, and with `PW_SERVING_IDENTITY` unset it must select zero even after.

---

## What this does not cover *(and why)*

- **The specs.** #1583. Split for a mechanical reason: `tests/fixtures/**` is suite-wide for `impacted-specs-by-import.mjs`, so touching `lane.ts` resolves to every spec and asks the reviewer to dispatch `manual.yml` — bundling new specs into that PR buries their validation inside a full-suite run. Same order the Enterprise lane selector (#1483) shipped in.
- **`serving_internal_mcp_hosts`** — #14550's phase 4, the outbound MCP allowlist that forwards the identity only to operator-allowlisted internal hosts, fail-closed. A separate surface needing an internal MCP host to point at.
- **`serving_trace_end_user` and the span link** (#14616) — both need an OTLP collector in CI, which this repo does not have: `otlp|opentelemetry` returns zero matches across `tests/`, `docs/`, `scripts/` and `.github/`.
- **A scheduled lane.** Like `@enterprise`, nothing runs `@serving` on a cron, so its specs cannot be `@stable` (#1010). Adding one is a separate decision about CI spend.

---

## Preconditions *(required)*

- Docker, and enough VM headroom for one more Langflow (~1.5 GiB measured).
- No Enterprise container running, if the box is at 8 GiB — the same ceiling `start-langflow-enterprise.sh` warns about.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/services/settings/groups/security.py` — declares `serving_end_user_header`, `serving_trust_proxy_headers` and `serving_end_user_required`, bound from `LANGFLOW_SERVING_*`. Present on both `main` and `release-1.12.0`.
- `src/lfx/src/lfx/workflow/end_user_identity.py` — the resolver that turns the header into the effective scope (`alice::S`, `anon::<uuid>`) and raises the `END_USER_IDENTITY_REQUIRED` refusal. Also on both refs.

  These are cited as paths rather than described in prose because **#1574 landed while this issue was in flight**: the spec-doc dependency guard now resolves against the release lines as well as `main`, so a path that is real on the line the nightly is cut from no longer fails the check. An earlier draft of this section avoided the paths for exactly that reason and said so; the reason expired, and keeping the workaround would have left the doc citing nothing verifiable.
- **Langflow API** — `GET /api/v1/version`, `POST /api/v2/workflows`, `POST /api/v1/run/{id}`, `GET /api/v1/monitor/messages`.
- **`langflowai/langflow-nightly:latest`** — the same image as every other OSS lane; only the configuration differs.
- **No provider key, no model, no external network.**
