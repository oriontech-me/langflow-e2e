// The /api/v1/triggers calls the trigger specs share (#2448).
//
// Every trigger spec before this one carried its own `createTrigger` /
// `triggersOf` / `triggerAction` closure. #2448 adds two more callers — the
// operator API spec and the Settings › Triggers page spec — so the calls and the
// wire types live here instead of in a fourth and fifth copy. The signing half of
// the webhook contract is `sign-webhook.ts` (#2449).
//
// Every function THROWS on an unexpected status, with the status and the body in
// the message, rather than calling `expect`: a helper's expect loses its message
// outside the runner, and the body is the only thing that says why a create was
// refused (a 422 names the field).
//
// Shapes measured on `1.14.0.dev28` against `langflow-ai/langflow@release-1.14.0`
// (`services/database/models/trigger/schemas.py`).

import type { APIRequestContext } from "@playwright/test";

/** `TriggerAction`, in the server's display order. */
export type TriggerAction = "pause" | "resume" | "test" | "reconnect" | "replay" | "delete" | "rotate_secret";

export type TriggerState = "pending" | "active" | "paused" | "expired" | "needs_reconnect" | "error" | "dead";

/** Every key a `TriggerRead` carries — the response is asserted against this exact set. */
export const TRIGGER_READ_KEYS = [
  "admin_paused_at",
  "allowed_actions",
  "binding_target",
  "blocked_actions",
  "concurrency_limit",
  "config",
  "connection_id",
  "created_at",
  "deployment_id",
  "flow_id",
  "flow_name",
  "flow_version_id",
  "id",
  "kind",
  "last_error",
  "last_error_code",
  "last_fired_at",
  "max_attempts",
  "name",
  "next_fire_at",
  "node_id",
  "owner_username",
  "provider",
  "reason",
  "session_policy",
  "state",
  "updated_at",
  "user_id",
] as const;

export interface TriggerRead {
  id: string;
  flow_id: string;
  user_id: string | null;
  name: string;
  kind: string;
  provider: string | null;
  node_id: string | null;
  connection_id: string | null;
  config: Record<string, unknown>;
  state: TriggerState;
  last_error: string | null;
  last_error_code: string | null;
  admin_paused_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  reason: string | null;
  allowed_actions: TriggerAction[];
  blocked_actions: Partial<Record<TriggerAction, string>>;
  flow_name: string | null;
  owner_username: string | null;
  [key: string]: unknown;
}

/** The fields a spec sets on `POST /api/v1/triggers`; the server defaults the rest. */
export interface TriggerCreate {
  flow_id: string;
  name: string;
  kind: string;
  provider?: string;
  /** Any `TriggerState`: the create route writes the row straight into it. */
  state?: TriggerState;
  connection_id?: string;
  node_id?: string;
  config?: Record<string, unknown>;
  /** 1–20; the dispatcher dead-letters an event at this many attempts. */
  max_attempts?: number;
  /** 1–100 events of this trigger in flight at once. */
  concurrency_limit?: number;
  session_policy?: "per_event" | "shared";
  /** `deployment` is stored but not dispatched, and needs `deployment_id`. */
  binding_target?: "flow" | "deployment";
  deployment_id?: string;
  /** A version of THIS trigger's flow; another flow's is a `404`. */
  flow_version_id?: string;
}

/**
 * `TriggerUpdate`: every field optional, and omission leaves it alone. An explicit
 * `null` is how a nullable reference is cleared; the server refuses it on the rest.
 */
export interface TriggerUpdate {
  name?: string;
  config?: Record<string, unknown>;
  connection_id?: string | null;
  binding_target?: "flow" | "deployment";
  deployment_id?: string | null;
  flow_version_id?: string | null;
  session_policy?: "per_event" | "shared";
  concurrency_limit?: number;
  max_attempts?: number;
}

export interface TriggerBulkRequest {
  provider?: string;
  trigger_ids?: string[];
  dry_run?: boolean;
}

export interface TriggerBulkResult {
  action: "pause" | "resume";
  dry_run: boolean;
  matched: number;
  changed: string[];
  unchanged: string[];
  failed: Array<{ trigger_id: string; detail: string }>;
  owners: number;
}

/** `PROVIDER_PATTERN` on `TriggerBase.provider` and on the list and bulk filters. */
export const TRIGGER_PROVIDER_PATTERN = /^[a-z][a-z0-9_-]*$/;
/** `max_length` of the same field. */
export const TRIGGER_PROVIDER_MAX_LENGTH = 64;

/**
 * A provider name no other run uses: `e2eop` + `label` + a per-call discriminator,
 * folded into the server's pattern.
 *
 * A bulk pause or resume by provider is instance-wide across users, so a spec
 * that bulk-acts on a SHARED provider (`google`) would pause every other spec's
 * triggers on it. The create route accepts any provider name that matches the
 * pattern, so a provider unique to the run makes the provider bulk select this
 * run's rows and nothing else.
 */
export function runProvider(label = ""): string {
  const discriminator = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // The label gives way to the discriminator, never the reverse: cutting the
  // discriminator would let two runs with one long label share a provider.
  const budget = TRIGGER_PROVIDER_MAX_LENGTH - "e2eop".length - discriminator.length;
  const folded = label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, budget);
  const provider = `e2eop${folded}${discriminator}`;
  if (!TRIGGER_PROVIDER_PATTERN.test(provider)) {
    throw new Error(`runProvider produced "${provider}", which the server's provider pattern refuses`);
  }
  return provider;
}

/**
 * The list order, `created_at desc, id desc`, as a comparator.
 *
 * `created_at` has second precision (measured: rows created in one burst share
 * it), so the id decides most ties — a spec asserting "newest first" by creation
 * order would be wrong half the time. Both columns compare as strings: the
 * timestamps share one format, and a UUID's hex digits sort the same with or
 * without its fixed-position dashes, which is how both SQLite (`CHAR(32)`) and
 * PostgreSQL (`uuid`) order them.
 */
export function newestFirst(
  a: Pick<TriggerRead, "created_at" | "id">,
  b: Pick<TriggerRead, "created_at" | "id">,
): number {
  const at = (a.created_at ?? "").localeCompare(b.created_at ?? "");
  if (at !== 0) return -at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

async function read<T>(label: string, res: { status(): number; text(): Promise<string> }, expected: number): Promise<T> {
  const text = await res.text();
  if (res.status() !== expected) {
    throw new Error(`${label} answered ${res.status()}, expected ${expected}: ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** `POST /api/v1/triggers` → `201`. The trigger is owned by the flow's owner. */
export async function createTrigger(
  request: APIRequestContext,
  headers: Record<string, string>,
  data: TriggerCreate,
): Promise<TriggerRead> {
  const res = await request.post("/api/v1/triggers", { headers, data });
  return read<TriggerRead>(`POST /api/v1/triggers (${data.kind}, ${data.state ?? "pending"})`, res, 201);
}

/** `GET /api/v1/triggers/{id}` → `200`. Single-object responses carry `flow_name: null`. */
export async function getTrigger(
  request: APIRequestContext,
  headers: Record<string, string>,
  triggerId: string,
): Promise<TriggerRead> {
  return read<TriggerRead>(`GET /api/v1/triggers/${triggerId}`, await request.get(`/api/v1/triggers/${triggerId}`, { headers }), 200);
}

/** `GET /api/v1/triggers` with the given query (`flow_id`, `scope`, `provider`, `state`, `limit`, `offset`) → `200`. */
export async function listTriggers(
  request: APIRequestContext,
  headers: Record<string, string>,
  query: Record<string, string | number> = {},
): Promise<TriggerRead[]> {
  const res = await request.get("/api/v1/triggers", { headers, params: query });
  return read<TriggerRead[]>(`GET /api/v1/triggers ${JSON.stringify(query)}`, res, 200);
}

/** `PATCH /api/v1/triggers/{id}` → `200` (#2303). */
export async function updateTrigger(
  request: APIRequestContext,
  headers: Record<string, string>,
  triggerId: string,
  data: TriggerUpdate,
): Promise<TriggerRead> {
  const res = await request.patch(`/api/v1/triggers/${triggerId}`, { headers, data });
  return read<TriggerRead>(`PATCH /api/v1/triggers/${triggerId} ${JSON.stringify(data)}`, res, 200);
}

/** `DELETE /api/v1/triggers/{id}` → `204` with no body (#2303). */
export async function deleteTrigger(
  request: APIRequestContext,
  headers: Record<string, string>,
  triggerId: string,
): Promise<void> {
  await read<undefined>(`DELETE /api/v1/triggers/${triggerId}`, await request.delete(`/api/v1/triggers/${triggerId}`, { headers }), 204);
}

/**
 * `POST /api/v1/triggers/{id}/pin` → `200` (#2303). `null` unpins. The body is
 * always sent: the field is required, so an empty body is a `422`, never an unpin.
 */
export async function pinTrigger(
  request: APIRequestContext,
  headers: Record<string, string>,
  triggerId: string,
  flowVersionId: string | null,
): Promise<TriggerRead> {
  const route = `/api/v1/triggers/${triggerId}/pin`;
  const res = await request.post(route, { headers, data: { flow_version_id: flowVersionId } });
  return read<TriggerRead>(`POST ${route} ${flowVersionId}`, res, 200);
}

/** `POST /api/v1/triggers/{id}/{enable|disable}` → `200`. */
export async function setTriggerEnabled(
  request: APIRequestContext,
  headers: Record<string, string>,
  triggerId: string,
  enabled: boolean,
): Promise<TriggerRead> {
  const route = `/api/v1/triggers/${triggerId}/${enabled ? "enable" : "disable"}`;
  return read<TriggerRead>(`POST ${route}`, await request.post(route, { headers }), 200);
}

/** `POST /api/v1/triggers/bulk/{pause|resume}` as a superuser → `200`. */
export async function bulkTriggers(
  request: APIRequestContext,
  headers: Record<string, string>,
  action: "pause" | "resume",
  body: TriggerBulkRequest,
): Promise<TriggerBulkResult> {
  const route = `/api/v1/triggers/bulk/${action}`;
  return read<TriggerBulkResult>(`POST ${route} ${JSON.stringify(body)}`, await request.post(route, { headers, data: body }), 200);
}
