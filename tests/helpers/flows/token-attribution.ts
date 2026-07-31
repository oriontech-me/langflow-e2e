// The token attribution sidecar (issue #1197).
//
// A trace 404s the moment its flow is deleted — measured, not assumed (design §2,
// S4) — so the only place a spec's token consumption can be named is INSIDE
// `cleanup()`, immediately before the DELETE. That is a hostile place for code to
// live, and the constraints below are not stylistic:
//
//   - it must NEVER throw. `cleanup()` promises to fail a teardown only under
//     `{ strict: true }`, and never over telemetry;
//   - it must not poll. One request per captured flow. A trace that has not landed
//     yet is missed, and its tokens fall to the poller or to the summary's
//     `unattributed` bucket — which is counted and named, never hidden;
//   - it must be inert by default. With `TOKENS_ATTRIB` unset (every local run,
//     every PR lane) it makes no request and touches no file.
import fs from "node:fs";
import type { APIRequestContext } from "@playwright/test";

export interface RecordTokenAttributionOptions {
  request: APIRequestContext;
  /** The flow ids about to be deleted. */
  flowIds: string[];
  /** The test's title (leaf or full chain — the summary keys on `file` + `test`). */
  test: string;
  /** The spec file, as the run payload reports it. */
  file: string;
  /** Output JSONL path. Defaults to `process.env.TOKENS_ATTRIB`; unset ⇒ inert. */
  out?: string;
  /** Auth header, when the caller already has one. */
  headers?: Record<string, string>;
}

export interface TokenAttributionResult {
  recorded: number;
  /** One entry per flow whose traces could not be read or written, with the reason. */
  skipped: string[];
}

export async function recordTokenAttribution({
  request,
  flowIds,
  test,
  file,
  out = process.env.TOKENS_ATTRIB,
  headers,
}: RecordTokenAttributionOptions): Promise<TokenAttributionResult> {
  const result: TokenAttributionResult = { recorded: 0, skipped: [] };
  if (!out || !flowIds?.length) return result;

  for (const flowId of flowIds) {
    try {
      const res = await request.get(`/api/v1/monitor/traces?flow_id=${flowId}`, { headers });
      const body = (await res.json()) as { traces?: Array<{ id?: string }> };
      const lines = (body?.traces ?? [])
        .map((t) => t?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((id) => JSON.stringify({ trace_id: id, flow_id: flowId, test, file }));
      if (!lines.length) continue;
      // appendFileSync, not a stream: parallel workers share this file, and a single
      // sub-4KB append is what keeps their lines from interleaving.
      fs.appendFileSync(out, `${lines.join("\n")}\n`);
      result.recorded += lines.length;
    } catch (error) {
      result.skipped.push(`${flowId}: ${(error as Error)?.message?.split("\n")[0] ?? String(error)}`);
    }
  }
  return result;
}
