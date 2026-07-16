/**
 * Shared NDJSON build-event reader for the §9.1 build event-delivery specs
 * (direct-response, polling-response). The `POST /api/v1/build/{flow_id}/flow`
 * response body is `application/x-ndjson`: one JSON build event per line.
 *
 * Extracted from the duplicated per-spec copies (issue #703) so every
 * build-event-delivery spec shares a single definition.
 */

export interface BuildEvent {
  event?: string;
  data?: { text?: string; sender?: string; sender_name?: string };
  /** Present only on the two-step job path's shell response, never on a direct event. */
  job_id?: string;
}

/** Parses an NDJSON body into one object per non-empty line. */
export function parseNdjson(body: string): BuildEvent[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}
