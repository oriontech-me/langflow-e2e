import type { APIRequestContext } from "@playwright/test";

/**
 * Serving-plane end-user identity: the header, the probe, and the fail-closed
 * guard every `@serving` spec opens with.
 *
 * Langflow 1.12 added a trusted-gateway header that scopes per-user chat memory
 * (`langflow-ai/langflow` #14443, #14550). The feature has FOUR configurations,
 * selected entirely by instance-global environment variables — see
 * `docs/serving/end-user-identity-lane.md` for the measured contract — and each
 * of this area's specs asserts exactly one of them.
 *
 * **The configuration is not readable through any API.** `GET /api/v1/config`
 * returns 35 keys and none of them mentions `serving`, `end_user` or `trust`
 * (measured on `1.12.0.dev38`), and no settings endpoint exposes them either. So
 * a spec cannot read its own precondition; it has to observe it. That is why the
 * guard below runs the flow rather than reading a flag, and why it FAILS instead
 * of skipping: a spec that skipped here would be green on every instance,
 * including the three where its assertions are false (#1010's green all-skip).
 *
 * Same shape and same reason as `requireA2aEnabled` and the Enterprise lane's
 * `requireRbacInstance`: prove the variant is what it claims before measuring
 * the product through it.
 */

/** The header name `scripts/start-langflow-serving-identity.sh` configures. */
export const SERVING_IDENTITY_HEADER = "X-End-User-Id";

/** The refusal code `serving_end_user_required` answers an identity-less request with. */
export const IDENTITY_REQUIRED_CODE = "END_USER_IDENTITY_REQUIRED";

/** The prefix the resolver mints for a request it will not attribute. */
export const ANONYMOUS_SCOPE_PREFIX = "anon::";

/**
 * The four configurations of the contract, plus the verdict for anything else.
 *
 * `unknown` is not a fifth configuration — it is the refusal to guess, and it
 * fails the guard. An unrecognised instance is unknown, not clean (#1012).
 */
export type ServingConfiguration =
  | "default"
  | "trusted"
  | "untrusted"
  | "required"
  | "unknown";

/** One probe run, reduced to what the classification turns on. */
export interface ServingProbeReading {
  status: number;
  /** `session_id` from the response body, when it carried one. */
  sessionId?: string;
  /** `detail.code` from a refusal body, when it carried one. */
  detailCode?: string;
}

/**
 * The pair of readings the verdict needs.
 *
 * Two runs, not one, and that is the crux: an *identified* request is `200` with
 * a scoped session under BOTH `trusted` and `required`. Only the identity-less
 * run separates them — anonymised under `trusted`, refused under `required`. A
 * one-run probe would answer the same for both and let a `required` spec assert
 * its refusals against a container that never refuses.
 */
export interface ServingProbeReadings {
  /** The `session_id` sent on both probe runs. */
  sentSessionId: string;
  /** The identity sent on the identified probe run. */
  probeIdentity: string;
  identified: ServingProbeReading;
  anonymous: ServingProbeReading;
}

export interface ServingVerdict {
  state: ServingConfiguration;
  /** Both readings, in words — the guard's failure message quotes this. */
  reason: string;
}

/**
 * How each reading looked, for the reason string.
 *
 * NOT named `describe`: the `eslint-plugin-playwright` rule
 * `valid-describe-callback` matches any call to a function of that name and
 * reported this helper's two call sites as malformed test suites.
 */
function renderReading(label: string, r: ServingProbeReading): string {
  if (r.status !== 200) {
    return `${label}: HTTP ${r.status}${r.detailCode ? ` code=${r.detailCode}` : ""}`;
  }
  return `${label}: HTTP 200 session_id=${r.sessionId === undefined ? "<absent>" : `"${r.sessionId}"`}`;
}

type Shape = "verbatim" | "scoped" | "anonymous" | "refused" | "other";

/**
 * Classify one reading. Comparison against the scoped form is EXACT — an
 * identity that happens to be a prefix of the session (`alice` sent against
 * session `alice-1`) reports the session verbatim on a default instance, and a
 * `startsWith` test would read that as scoped and call a stock instance trusted.
 */
function shapeOf(r: ServingProbeReading, sentSessionId: string, identity: string): Shape {
  if (r.status === 401 && r.detailCode === IDENTITY_REQUIRED_CODE) return "refused";
  if (r.status !== 200 || typeof r.sessionId !== "string" || r.sessionId === "") return "other";
  if (r.sessionId === sentSessionId) return "verbatim";
  if (r.sessionId === `${identity}::${sentSessionId}`) return "scoped";
  if (r.sessionId.startsWith(ANONYMOUS_SCOPE_PREFIX)) return "anonymous";
  // A scope that is neither ours nor anonymous — someone else's, or a shape this
  // helper has not been taught. Deliberately not `scoped`.
  return "other";
}

/**
 * PURE, and it cannot throw.
 *
 * The layering is the same one `component-catalog-drift.ts` records: the verdict
 * is a pure function and the I/O lives in its caller, because that is what makes
 * "the guard always reaches a named verdict" a testable property instead of a
 * claim. A throw in here would surface as an unattributed error from a helper
 * whose entire job is to attribute.
 */
export function classifyServingConfiguration(r: ServingProbeReadings): ServingVerdict {
  const identified = shapeOf(r.identified, r.sentSessionId, r.probeIdentity);
  const anonymous = shapeOf(r.anonymous, r.sentSessionId, r.probeIdentity);
  const reason = `${renderReading("identified", r.identified)}; ${renderReading("identity-less", r.anonymous)}`;

  // The header changed nothing, on both paths: no header is configured.
  if (identified === "verbatim" && anonymous === "verbatim") {
    return { state: "default", reason };
  }
  // Named but not trusted: the identity is discarded AND the plain session is
  // not used as a fallback — every request becomes its own anonymous scope.
  if (identified === "anonymous" && anonymous === "anonymous") {
    return { state: "untrusted", reason };
  }
  if (identified === "scoped") {
    if (anonymous === "anonymous") return { state: "trusted", reason };
    if (anonymous === "refused") return { state: "required", reason };
  }
  return { state: "unknown", reason };
}

/** The invocation that produces each configuration, quoted in the guard's failure. */
const HOW_TO_GET_THERE: Record<Exclude<ServingConfiguration, "unknown">, string> = {
  default: "./scripts/start-langflow-docker.sh (any instance with no LANGFLOW_SERVING_* variable set)",
  trusted: "./scripts/start-langflow-serving-identity.sh",
  untrusted: "LANGFLOW_SERVING_TRUST=0 ./scripts/start-langflow-serving-identity.sh",
  required: "LANGFLOW_SERVING_REQUIRED=1 ./scripts/start-langflow-serving-identity.sh",
};

export interface RunWorkflowOptions {
  flowId: string;
  sessionId: string;
  /** Omit to send no identity header at all — not the same as sending a blank one. */
  identity?: string;
  inputValue?: string;
}

export interface WorkflowRunReading extends ServingProbeReading {
  /** The parsed body, for callers that assert on more than the session. */
  body: Record<string, unknown>;
}

/**
 * `POST /api/v2/workflows` in `mode=sync`, reduced to the readings these specs
 * assert on. `mode=sync` because the session scope is decided at submit time and
 * a synchronous reply removes any need to poll — the job-lifecycle race
 * `api/flows/workflows-v2-job-lifecycle.spec.ts` pins is a different surface and
 * does not touch `session_id` on the submit reply.
 */
export async function runWorkflowV2(
  request: APIRequestContext,
  headers: Record<string, string>,
  { flowId, sessionId, identity, inputValue = "ping" }: RunWorkflowOptions,
): Promise<WorkflowRunReading> {
  const res = await request.post("/api/v2/workflows", {
    headers: {
      ...headers,
      ...(identity === undefined ? {} : { [SERVING_IDENTITY_HEADER]: identity }),
    },
    data: { flow_id: flowId, input_value: inputValue, session_id: sessionId, mode: "sync" },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const detail = body.detail as { code?: unknown } | undefined;
  return {
    status: res.status(),
    sessionId: typeof body.session_id === "string" ? body.session_id : undefined,
    detailCode: typeof detail?.code === "string" ? detail.code : undefined,
    body,
  };
}

/**
 * `POST /api/v1/run/{id}` — the other serving surface. #14550's phase 1 extends
 * the v2-only scoping to all serving APIs, so v1 is where a partial rollout
 * would come undone, and it is the surface deployed integrations actually call.
 *
 * It authenticates with `x-api-key`, not a bearer token, which is why the specs
 * mint one.
 */
export async function runFlowV1(
  request: APIRequestContext,
  apiKey: string,
  { flowId, sessionId, identity, inputValue = "ping" }: RunWorkflowOptions,
): Promise<WorkflowRunReading> {
  const res = await request.post(`/api/v1/run/${flowId}`, {
    headers: {
      "x-api-key": apiKey,
      ...(identity === undefined ? {} : { [SERVING_IDENTITY_HEADER]: identity }),
    },
    data: {
      input_value: inputValue,
      session_id: sessionId,
      output_type: "chat",
      input_type: "chat",
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const detail = body.detail as { code?: unknown } | undefined;
  return {
    status: res.status(),
    sessionId: typeof body.session_id === "string" ? body.session_id : undefined,
    detailCode: typeof detail?.code === "string" ? detail.code : undefined,
    body,
  };
}

/**
 * How many messages `GET /api/v1/monitor/messages` holds for a query.
 *
 * `query` is the raw query string (`session_id=…` or `flow_id=…`). The
 * `flow_id=` form is the one that means **nowhere**: asserting only the session
 * a run reported confirms it did not write *there* while saying nothing about
 * whether it wrote somewhere else, which is exactly what a scoping bug does.
 *
 * A non-list body is `-1`, never `0` — an unreadable count must not read as an
 * empty one.
 */
export async function countMessages(
  request: APIRequestContext,
  headers: Record<string, string>,
  query: string,
): Promise<number> {
  const res = await request.get(`/api/v1/monitor/messages?${query}`, { headers });
  if (!res.ok()) return -1;
  const body = await res.json().catch(() => null);
  return Array.isArray(body) ? body.length : -1;
}

/**
 * Probe the instance with two runs and classify. `flowId` should be a flow the
 * caller owns and will delete — under `trusted` the identified probe run
 * persists two rows into `<identity>::<probe session>`, so a spec that asserts
 * flow-wide counts must not share this flow with them.
 */
export async function probeServingConfiguration(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
): Promise<ServingVerdict> {
  const sentSessionId = `serving-probe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const probeIdentity = "serving-probe-identity";
  const identified = await runWorkflowV2(request, headers, {
    flowId,
    sessionId: sentSessionId,
    identity: probeIdentity,
  });
  const anonymous = await runWorkflowV2(request, headers, { flowId, sessionId: sentSessionId });
  return classifyServingConfiguration({
    sentSessionId,
    probeIdentity,
    identified,
    anonymous,
  });
}

/**
 * Fail-closed precondition: throw unless the instance is in `expected`.
 *
 * The message names the state observed, both readings behind it, and the exact
 * invocation that produces the state the caller needs — because the four
 * configurations are four different mistakes with one symptom (a spec asserting
 * the wrong row), and "wrong container" without the reading sends the reader
 * back to re-run the probe by hand.
 */
export async function requireServingConfiguration(
  request: APIRequestContext,
  headers: Record<string, string>,
  flowId: string,
  expected: Exclude<ServingConfiguration, "unknown">,
): Promise<void> {
  const { state, reason } = await probeServingConfiguration(request, headers, flowId);
  if (state === expected) return;

  const found =
    state === "unknown"
      ? "an unrecognised state — no row of the contract matches these readings"
      : `the "${state}" configuration (produced by: ${HOW_TO_GET_THERE[state]})`;

  throw new Error(
    `This spec asserts the "${expected}" serving-identity configuration, but the instance ` +
      `under test is in ${found}. Observed — ${reason}. ` +
      `Start the instance this spec needs with: ${HOW_TO_GET_THERE[expected]} ` +
      "(the configuration is not exposed by any API, so it is probed by running the flow; " +
      "see docs/serving/end-user-identity-lane.md for the four-configuration contract).",
  );
}
