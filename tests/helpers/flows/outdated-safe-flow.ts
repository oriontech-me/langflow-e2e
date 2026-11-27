// A flow an upgrade repair can update safely (#2567).
//
// The frozen `tests/assets/flows/outdated_flow.json` (#2424) is outdated, but four of
// its five nodes would break on update, so its repair preview reads `manual`. Its OpenAI
// node alone is outdated and safe. This builds a flow from that frozen node plus a
// CURRENT Chat Output from the live catalog, joined by one edge, so a repair preview
// reads `ready` with exactly one node to update.
//
// The graph goes through `buildCatalogFlow`, with the frozen node offered as a catalog
// entry placed before the live categories: the edge's handles then come from the frozen
// node's outputs and the live Chat Output's `input_value`, exactly as the builder makes
// them for any catalog flow, and the frozen node is copied as is (its old code is the
// point).
import { buildCatalogFlow, type CatalogFlowData } from "./build-catalog-flow";

export const OUTDATED_SAFE_CHAT_OUTPUT_ID = "ChatOutput-cur01";

type FixtureNode = { id: string; data: { type: string; node: unknown } };
type FrozenComponent = { template: { code?: { value?: unknown } } };

export interface OutdatedSafeFlow {
  data: CatalogFlowData;
  /** The frozen OpenAI node's id, as in the fixture. */
  openAiNodeId: string;
  /** The frozen node's code: an applied repair replaces it. */
  openAiCode: string;
}

export function buildOutdatedSafeFlow(
  catalog: Record<string, unknown>,
  fixtureData: { nodes: FixtureNode[] },
): OutdatedSafeFlow {
  const openAi = fixtureData.nodes.find((n) => n.data.type === "OpenAIModel");
  if (!openAi) throw new Error("the outdated fixture has no OpenAIModel node");
  const frozen = structuredClone(openAi.data.node) as FrozenComponent;
  const frozenFirst = { __frozen_outdated_fixture: { OpenAIModel: frozen }, ...catalog };
  const data = buildCatalogFlow(frozenFirst, {
    nodes: [
      { id: openAi.id, type: "OpenAIModel" },
      { id: OUTDATED_SAFE_CHAT_OUTPUT_ID, type: "ChatOutput" },
    ],
    edges: [{ source: openAi.id, output: "text_output", target: OUTDATED_SAFE_CHAT_OUTPUT_ID, field: "input_value" }],
  });
  return { data, openAiNodeId: openAi.id, openAiCode: frozen.template.code?.value as string };
}
