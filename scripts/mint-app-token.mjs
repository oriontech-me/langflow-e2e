#!/usr/bin/env node
// Mint a GitHub App installation token for the QA VM (#2518), with no dependency.
//
// The destination takes no SSH and caps a personal token at 7 days, so the VM's lasting
// credential is a GitHub App's (#2490). An installation token expires one hour after it
// is minted, so the VM cannot HOLD one: it holds the App's private key and mints a fresh
// token before each use. This is that minting.
//
//   GITHUB_APP_ID=… GITHUB_APP_INSTALLATION_ID=… GITHUB_APP_PRIVATE_KEY_FILE=… \
//   ISSUE_HOST=github.ibm.com node scripts/mint-app-token.mjs
//
// Prints the token, and only the token, on stdout. Every diagnostic goes to stderr and
// names its cause, because the four ways this fails need four different hands:
//
//   exit 2  configuration: an input is missing, the key file is unreadable, or it is not
//           an RSA private key in PEM. Nothing was sent.
//   exit 3  the destination refused: a bad App id or key (401), an installation that does
//           not exist or does not belong to the App (404), a suspended App (403), or this
//           machine's clock off far enough that the JWT is not yet or no longer valid.
//   exit 4  no answer: DNS, a refused or timed-out connection, a 5xx, or a body that is
//           not a token. The same request may succeed later.
//
// Inputs (environment):
//   GITHUB_APP_ID                 the App's numeric id (the JWT's `iss`)
//   GITHUB_APP_INSTALLATION_ID    the installation on the destination organisation
//   GITHUB_APP_PRIVATE_KEY_FILE   the App's private key, PEM (PKCS#1 or PKCS#8)
//   GITHUB_APP_API_URL            the REST base; default from ISSUE_HOST:
//                                 https://api.github.com for github.com, else
//                                 https://<host>/api/v3 (GitHub Enterprise Server)
//   ISSUE_HOST                    the destination host, as the lane file names it
//   GITHUB_APP_TIMEOUT_MS         per-request budget (default 15000)
import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export class MintError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The REST base for a destination host, or the explicit override. */
export function apiBase(env) {
  if (env.GITHUB_APP_API_URL) return env.GITHUB_APP_API_URL.replace(/\/+$/, "");
  const host = (env.ISSUE_HOST || "").trim();
  if (!host) throw new MintError(2, "no destination: set ISSUE_HOST (the lane file's) or GITHUB_APP_API_URL");
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) throw new MintError(2, `ISSUE_HOST='${host}' is not a host name`);
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

/**
 * The App's JWT: RS256 over {iat, exp, iss}. `iat` is backdated 60 s and `exp` is 9
 * minutes out, inside GitHub's 10-minute ceiling, so a clock a little off either way
 * still mints — GitHub's own recommendation for both.
 */
export function appJwt(appId, pem, nowS = Math.floor(Date.now() / 1000)) {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch (err) {
    throw new MintError(2, `the private key could not be read as PEM (${err.message.split("\n")[0]})`);
  }
  if (key.asymmetricKeyType !== "rsa") throw new MintError(2, `the private key is ${key.asymmetricKeyType}, and a GitHub App key is RSA`);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowS - 60, exp: nowS + 540, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(key))}`;
}

/** The inputs, validated before anything is sent. */
export function readInputs(env) {
  const appId = (env.GITHUB_APP_ID || "").trim();
  const installation = (env.GITHUB_APP_INSTALLATION_ID || "").trim();
  const keyFile = (env.GITHUB_APP_PRIVATE_KEY_FILE || "").trim();
  const missing = [["GITHUB_APP_ID", appId], ["GITHUB_APP_INSTALLATION_ID", installation], ["GITHUB_APP_PRIVATE_KEY_FILE", keyFile]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new MintError(2, `missing: ${missing.join(", ")}`);
  if (!/^\d+$/.test(appId)) throw new MintError(2, `GITHUB_APP_ID='${appId}' is not a numeric App id`);
  if (!/^\d+$/.test(installation)) throw new MintError(2, `GITHUB_APP_INSTALLATION_ID='${installation}' is not a numeric installation id`);
  let pem;
  try {
    pem = readFileSync(keyFile, "utf8");
  } catch (err) {
    throw new MintError(2, `the private key file ${keyFile} cannot be read (${err.code || err.message})`);
  }
  return { appId, installation, pem, base: apiBase(env) };
}

/** Why a refusal happened, in words a person can act on. */
export function explainRefusal(status, body, serverDate, nowMs = Date.now()) {
  const message = typeof body?.message === "string" ? body.message : "";
  const skewS = serverDate ? Math.round((nowMs - Date.parse(serverDate)) / 1000) : NaN;
  if (/claim \('(iat|exp)'\)|issued at|expiration time/i.test(message) || (status === 401 && Math.abs(skewS) > 60)) {
    const by = Number.isFinite(skewS) ? `: this clock is ${Math.abs(skewS)} s ${skewS > 0 ? "ahead of" : "behind"} the destination's` : "";
    return `the destination rejected the JWT's time claims — the clock is off${by} (${message || `HTTP ${status}`}). Fix the clock (timedatectl / chrony), not the key.`;
  }
  if (status === 401) return `the destination refused the App's JWT (401: ${message || "no message"}): the App id or the private key is wrong, or the key was revoked.`;
  if (status === 404) return `the installation was not found (404: ${message || "no message"}): the installation id is wrong, or it is not this App's.`;
  if (status === 403) return `the destination forbade the token (403: ${message || "no message"}): the App may be suspended, or not allowed on this organisation.`;
  return `the destination refused the request (HTTP ${status}: ${message || "no message"}).`;
}

/** Mint one installation token. Resolves to { token, expiresAt }, or throws a MintError. */
export async function mint(env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const { appId, installation, pem, base } = readInputs(env);
  const jwt = appJwt(appId, pem, Math.floor(nowMs / 1000));
  const url = `${base}/app/installations/${installation}/access_tokens`;
  const timeoutMs = Number(env.GITHUB_APP_TIMEOUT_MS) > 0 ? Number(env.GITHUB_APP_TIMEOUT_MS) : 15000;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "langflow-e2e-vm" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // fetch wraps the socket's error: its code sits in `cause`, or in the first of an
    // AggregateError's when several addresses were tried.
    const c = err?.cause;
    const cause = c?.code || c?.errors?.[0]?.code || (err?.name === "TimeoutError" ? "timed out" : "") || c?.message || err?.message || String(err);
    throw new MintError(4, `no answer from ${base} (${cause}): the network or the destination, not the key`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 201 && body && typeof body.token === "string" && body.token) return { token: body.token, expiresAt: body.expires_at || "" };
  if (res.status === 201) throw new MintError(4, `the destination answered 201 with no token in its body`);
  if (res.status >= 500) throw new MintError(4, `the destination answered HTTP ${res.status}: try again later`);
  throw new MintError(3, explainRefusal(res.status, body, res.headers.get("date"), nowMs));
}

const isMain = () => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};

if (process.argv[1] && isMain()) {
  mint(process.env).then(
    ({ token, expiresAt }) => {
      process.stdout.write(`${token}\n`);
      process.stderr.write(`[mint-app-token] minted an installation token${expiresAt ? `, expires ${expiresAt}` : ""}\n`);
    },
    (err) => {
      process.stderr.write(`[mint-app-token] ${err.message}\n`);
      process.exitCode = err instanceof MintError ? err.code : 4;
    },
  );
}
