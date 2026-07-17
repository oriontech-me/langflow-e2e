# Bug: Clicking "Logout" does not terminate the session (user stays authenticated; no redirect to login)

**Jira:** [LE-1850](https://datastax.jira.com/browse/LE-1850)
**Component:** Langflow — frontend, auth / user menu ("Logout")
**Backend endpoint (works):** `POST /api/v1/logout` → 200
**Found on:** `langflowai/langflow-nightly:latest` — `1.11.0.dev46` (`main_version` 1.11.0)
**Severity:** High (security-relevant — a user who clicks Logout remains authenticated; the session survives reload)
**Type:** Frontend regression (Logout action does not clear the session / is not wired to the logout endpoint)

---

## Summary

With `LANGFLOW_AUTO_LOGIN=false`, clicking **Logout** in the user menu does **not**
end the session:

- the page **stays on the main page** (no redirect to `/login`);
- a **reload keeps the user authenticated** (the session survives, which under
  `AUTO_LOGIN=false` should be impossible without a valid session);
- the network shows **no `POST /api/v1/logout`** call fired by the Logout click;
  instead the app runs `GET /api/v1/auto_login → 403` (correct for auto-login
  off) immediately followed by `POST /api/v1/refresh → 200`, which
  **silently re-authenticates** the user.

The backend logout endpoint itself is healthy — `POST /api/v1/logout` returns
`200` when called directly — so the defect is on the **frontend**: the Logout
control does not invoke logout / does not clear the auth state, and the refresh
flow then restores the session.

Under `AUTO_LOGIN=true` the same broken post-logout path is masked (auto-login
re-auths anyway). Under a test that mocks `GET /api/v1/auto_login → 500` to
simulate auto-login off, the broken path instead trips the frontend **error
boundary** ("Sorry, we found an unexpected error!").

---

## Environment

- Langflow Nightly `1.11.0.dev46`, Docker (`langflowai/langflow-nightly:latest`).
- `LANGFLOW_AUTO_LOGIN=false`, superuser `langflow` / `langflow123`.

---

## Reproduction (real, no test mock)

```bash
docker run -d --name langflow-authfalse -p 7861:7860 \
  -e LANGFLOW_AUTO_LOGIN=false -e LANGFLOW_SUPERUSER=langflow \
  -e LANGFLOW_SUPERUSER_PASSWORD=langflow123 -e LANGFLOW_DEACTIVATE_TRACING=true \
  langflowai/langflow-nightly:latest
# wait: curl -s localhost:7861/api/v1/version
```

1. Open `http://localhost:7861/` → login page ("sign in to langflow").
2. Log in with `langflow` / `langflow123` → the main page loads.
3. Open the user menu → click **Logout**.
4. **Expected:** redirect to `/login`, login form shown.
   **Actual:** stays on the main page, no redirect.
5. Reload the page.
   **Expected (AUTO_LOGIN=false):** falls back to the login page.
   **Actual:** still authenticated on the main page.

### Network evidence (after the Logout click)

- `GET /api/v1/auto_login` → **403** (correct — auto-login is off)
- `POST /api/v1/refresh` → **200** (re-authenticates the session)
- **no** `POST /api/v1/logout` is fired by the click

### Backend is healthy (control)

```
POST /api/v1/login   → 200 (returns access_token)
POST /api/v1/logout  → 200   # called directly with the token — works
```

So the logout endpoint works; the frontend Logout action does not use it / does
not clear the session.

---

## Impact on the E2E suite

The three `@stable` auth specs in
`tests/tests-automations/regression/core-functionality/auth/logout-flow.spec.ts`
(lines 31, 82, 126) hard-fail deterministically on `1.11.0.dev46` (clean,
single-worker) — each waits for the post-logout login page and times out. They
correctly catch this regression (assertions are not weakened). Tracked in #808;
they recurred on the 07-02 (clean) and 07-17 dailies.

---

## Suggested fix direction

Ensure the user-menu **Logout** action calls `POST /api/v1/logout` (or otherwise
invalidates the access + refresh tokens) and clears the client auth state /
redirects to `/login`, so the subsequent `auto_login → 403` is not silently
undone by `POST /api/v1/refresh`.

---

## Notes

- Root cause localized to the **frontend** by observation (backend 200, no
  frontend logout call, refresh re-auths); the exact frontend change/commit was
  not traced here.
- Confirmed live during the #808 investigation on `1.11.0.dev46`.
