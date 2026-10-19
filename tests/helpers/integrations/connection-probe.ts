import type { CatalogFlowSpec } from "../flows/build-catalog-flow";
import { applyNodeSpec, CUSTOM_COMPONENT_TYPE } from "../flows/build-custom-component-graph";

/**
 * A network-free oracle for "may THIS run resolve THAT connection" (#2296).
 *
 * A planted connection carries a fake token, so a provider's answer can never prove
 * a resolution was permitted — and calling a real provider would tie the suite to
 * egress and to provider error text. The probe is a `CustomComponent` declaring one
 * `ConnectionRefInput` per handle. For each, it calls
 * `self.resolve_connection(field).get_credential()`, which runs the host's real
 * resolver (identity floor, integration policy, scopes) and stops before any
 * provider adapter exists, and it reports one line per field:
 *
 *   PROBE <field> resolved owner_kind=<user|instance|env> connection_id=<uuid>
 *   PROBE <field> denied code=<error code> reason=<typed reason, may be empty>
 *
 * It never prints the token. It declares no required scopes, so a resolution can
 * only fail on identity or policy.
 *
 * **Public execution never runs it.** Anonymous paths apply the public code policy,
 * which swaps a `CustomComponent`'s code for the server's stock copy (#2196), and a
 * public MCP project refuses a flow with custom code outright. There the oracle is
 * a real read-only connector — see `driveListFlowSpec`.
 */

export interface ProbeTarget {
  /** A Python identifier: the input's name, and the key the output is reported under. */
  field: string;
  /** `<provider>/<name>`. */
  handle: string;
}

export type ProbeOutcome =
  | { state: "resolved"; ownerKind: string; connectionId: string }
  | { state: "denied"; code: string; reason: string };

const FIELD = /^[a-z_][a-z0-9_]*$/;
const HANDLE = /^google\/[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** The probe's Python source. Throws on a field or handle that would not round-trip. */
export function probeComponentCode(targets: ProbeTarget[]): string {
  if (targets.length === 0) throw new Error("a probe needs at least one target");
  const fields = new Set<string>();
  for (const { field, handle } of targets) {
    if (!FIELD.test(field)) throw new Error(`probe field is not a Python identifier: ${field}`);
    if (fields.has(field)) throw new Error(`duplicate probe field: ${field}`);
    fields.add(field);
    // Only google today: the probe's inputs declare `provider="google"`, and a
    // mismatched handle is refused by the input's own validator, not by the resolver.
    if (!HANDLE.test(handle)) throw new Error(`probe handle is not a google handle: ${handle}`);
  }
  const inputs = targets
    .map(
      ({ field, handle }) =>
        `        ConnectionRefInput(name="${field}", display_name="${field}", provider="google", value="${handle}"),\n`,
    )
    .join("");
  const order = targets.map(({ field }) => `"${field}"`).join(", ");
  return (
    "from lfx.custom.custom_component.component import Component\n" +
    "from lfx.inputs.inputs import ConnectionRefInput\n" +
    "from lfx.io import MessageTextInput, Output\n" +
    "from lfx.schema.message import Message\n\n\n" +
    "class CustomComponent(Component):\n" +
    '    display_name = "Probe"\n' +
    '    description = "connection resolution probe (#2296)"\n' +
    '    icon = "code"\n' +
    '    name = "CustomComponent"\n\n' +
    "    inputs = [\n" +
    '        MessageTextInput(name="in_text", display_name="in_text", required=False),\n' +
    inputs +
    "    ]\n\n" +
    "    outputs = [\n" +
    '        Output(display_name="Output", name="output", method="build_output"),\n' +
    "    ]\n\n" +
    "    async def build_output(self) -> Message:\n" +
    "        lines = []\n" +
    `        for field in (${order},):\n` +
    "            try:\n" +
    "                credential = await self.resolve_connection(field).get_credential()\n" +
    '                lines.append(f"PROBE {field} resolved owner_kind={credential.owner_kind} connection_id={credential.connection_id}")\n' +
    "            except Exception as error:\n" +
    "                code = getattr(error, \"code\", type(error).__name__)\n" +
    "                reason = getattr(error, \"reason\", \"\")\n" +
    '                lines.append(f"PROBE {field} denied code={code} reason={reason}")\n' +
    '        return Message(text="\\n".join(lines))\n'
  );
}

/**
 * Every probe line in `text`, by field. Tolerant of where the text came from: a
 * response body JSON-escapes the newlines (`\n` arrives as backslash + n), so each
 * token is matched by its own shape rather than by "up to the next whitespace" —
 * a UUID, a lowercase code, an owner kind — and an escaped separator can never be
 * swallowed into a value.
 *
 * The same field seen twice (a stream repeats the final message) must agree, or
 * this throws: two different answers for one run is not something to pick from.
 */
export function parseProbeOutput(text: string): Record<string, ProbeOutcome> {
  const outcomes: Record<string, ProbeOutcome> = {};
  const line =
    /PROBE ([a-z_][a-z0-9_]*) (?:resolved owner_kind=(user|instance|env) connection_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|denied code=([A-Za-z][A-Za-z0-9-]*) reason=([a-z-]*))/g;
  for (const match of text.matchAll(line)) {
    const [, field, ownerKind, connectionId, code, reason] = match;
    const outcome: ProbeOutcome = ownerKind
      ? { state: "resolved", ownerKind, connectionId }
      : { state: "denied", code, reason };
    const seen = outcomes[field];
    if (seen && JSON.stringify(seen) !== JSON.stringify(outcome)) {
      throw new Error(`probe field ${field} reported twice, differently: ${JSON.stringify(seen)} vs ${JSON.stringify(outcome)}`);
    }
    outcomes[field] = outcome;
  }
  return outcomes;
}

/** Chat Input → Probe → Chat Output, for `createCatalogFlow`. */
export function probeFlowSpec(targets: ProbeTarget[]): CatalogFlowSpec {
  const code = probeComponentCode(targets);
  return {
    nodes: [
      { id: "ChatInput-probe", type: "ChatInput" },
      {
        id: "CustomComponent-probe",
        type: CUSTOM_COMPONENT_TYPE,
        configure: (component) => {
          // The echo spec gives the node its Message output and the `in_text` field;
          // the code is then replaced with the probe's.
          applyNodeSpec(component, { id: "Probe", kind: "echo", fields: ["in_text"] });
          const template = component.template as Record<string, { value?: unknown }>;
          template.code = { ...template.code, value: code };
        },
      },
      { id: "ChatOutput-probe", type: "ChatOutput" },
    ],
    edges: [
      { source: "ChatInput-probe", output: "message", target: "CustomComponent-probe", field: "in_text" },
      { source: "CustomComponent-probe", output: "output", target: "ChatOutput-probe", field: "input_value" },
    ],
  };
}

/** The read-only connector the anonymous paths are judged by. */
export const DRIVE_LIST_TYPE = "ext:google:GoogleDriveListComponent@official";

/**
 * The hint `ConnectionNotAuthorizedError` carries for reason `anonymous-principal`
 * (`lfx/integrations/errors.py`). The typed reason is not sent to an anonymous
 * client; this hint is its one-to-one stand-in.
 */
export const ANONYMOUS_PRINCIPAL_HINT =
  "Use an authenticated run route; public and A2A executions cannot resolve connections.";

/**
 * The message every non-`provider` reason of `ConnectionNotAuthorizedError` carries.
 * It is all a public MCP tool call and a public A2A run surface (no code, no hint),
 * so on those two paths the typed reason is not observable from outside — only that
 * the principal was refused.
 */
export const NOT_AUTHORIZED_MESSAGE = "This execution principal is not authorized to use the requested connection.";

/**
 * One Drive *List Files* node bound to `handle`. Only `connection` is required, and
 * the action only READS — a wrongly permitted resolution could not write anything
 * with a fake token, which is what makes it safe to aim at the public paths.
 */
export function driveListFlowSpec(handle: string): CatalogFlowSpec {
  return { nodes: [{ id: "DriveList-oracle", type: DRIVE_LIST_TYPE, values: { connection: handle } }], edges: [] };
}
