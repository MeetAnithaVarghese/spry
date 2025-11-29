import { selectAll } from "unist-util-select";
import { GraphEdge } from "../orchestrate.ts";
import { augmentRule, GraphEdgesRule, RuleContext } from "./governance.ts";

/**
 * selectedNodesClassificationRule
 *
 * Apply a selector using `unist-util-select` and attach:
 *   root --rel--> node
 */
export function selectedNodesClassificationRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  selector: string,
  rel: Relationship,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return augmentRule<Relationship, Ctx, Edge>((ctx) => {
    const { root } = ctx;

    const targets = selectAll(selector, root);
    if (!targets.length) return false;

    const edges: Edge[] = [];
    for (const node of targets) {
      const edge = {
        rel,
        from: root,
        to: node,
      } as unknown as Edge;
      edges.push(edge);
    }

    return edges;
  });
}
