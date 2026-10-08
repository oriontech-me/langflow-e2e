/** Keeps a quoted error readable inside an assertion message. */
const MAX_CHARS = 300;

/**
 * True when a persisted message is the error row Langflow stores for a failed
 * run, rather than a message the flow produced.
 *
 * `category: "error"` is the field the Playground itself reads to render the
 * error card instead of a bot bubble (`chat-message.tsx`); `properties.icon:
 * "error"` is kept as a second signal because both were present on the row
 * measured for #1689.
 */
export function isRunErrorRow(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { category?: unknown; properties?: unknown };
  if (m.category === "error") return true;
  const props = m.properties;
  return typeof props === "object" && props !== null && (props as { icon?: unknown }).icon === "error";
}

/**
 * Names a failed run, or returns `null` when no row of the session is an error
 * row. Meant to be checked BEFORE a per-message assertion such as "every row
 * carries context_id": an error row is a row of the session, so without this a
 * failed run is reported as whatever that assertion checks.
 *
 * Why this exists (#1689): with a drained Anthropic key every agent call
 * answered `400 … credit balance is too low`, Langflow persisted an error row
 * with `context_id: null`, and the context_id specs failed with
 * `message(s) with wrong context_id: [{"sender":"Agent","context_id":null}]`.
 * That was filed as a product defect and took two corrections to retract. The
 * fixture's flow-error gate does not catch this case either: it reads
 * `credit balance is too low` as a provider outage and reports it as
 * unevaluated, by design, so the spec's own assertion is the first thing to fail.
 *
 * Never throws: it runs on the path where a test is already failing, and a
 * throw here would replace the real failure with its own.
 */
export function describeRunErrorRows(messages: readonly unknown[]): string | null {
  try {
    const rows = Array.isArray(messages) ? messages.filter(isRunErrorRow) : [];
    if (rows.length === 0) return null;
    const quoted = rows.map((row) => {
      const r = row as { sender?: unknown; text?: unknown };
      const sender = typeof r.sender === "string" && r.sender !== "" ? r.sender : "unknown sender";
      const text = typeof r.text === "string" ? r.text.trim() : "";
      const shown = text === "" ? "<no error text>" : JSON.stringify(text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text);
      return `[${sender}] ${shown}`;
    });
    return (
      `RUN_ERRORED: the run failed, so the assertion that follows was never reached — ` +
      `${rows.length} error row(s) persisted in the session: ${quoted.join("; ")}`
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `RUN_ERRORED: the session holds error rows that could not be described (${reason})`;
  }
}
