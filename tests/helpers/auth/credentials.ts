/**
 * Central source of truth for the Langflow superuser credentials used by tests.
 *
 * The password MUST NOT be the legacy default "langflow". Since langflow-nightly
 * 1.11.0.dev29, that value is treated as a disabled legacy default: under
 * LANGFLOW_AUTO_LOGIN=true it is ignored (a random bootstrap password is
 * generated, so a manual Sign In with "langflow" returns 401), and under
 * LANGFLOW_AUTO_LOGIN=false the server refuses to start. See issue #510.
 *
 * The running instance (configured via LANGFLOW_SUPERUSER_PASSWORD) and these
 * tests must agree on the same value, so we read the same env var here with a
 * non-legacy default. The LF_TEST_* fallbacks preserve pre-existing overrides.
 */
export const SUPERUSER_USERNAME =
  process.env.LANGFLOW_SUPERUSER ?? process.env.LF_TEST_USERNAME ?? "langflow";

export const SUPERUSER_PASSWORD =
  process.env.LANGFLOW_SUPERUSER_PASSWORD ??
  process.env.LF_TEST_PASSWORD ??
  "langflow123";
