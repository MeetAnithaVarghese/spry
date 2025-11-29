import { Node } from "types/mdast";
import { visit } from "unist-util-visit";
import { GraphEdge } from "../orchestrate.ts";
import { augmentRule, GraphEdgesRule, RuleContext } from "./governance.ts";

/**
 * nodesClassificationRule
 *
 * Predicate-based classification (unist-util-visit compatible callback).
 *
 * For each matching node:
 *   root --rel--> node
 */
export type VisitMatchFn = (
  node: Node,
  index: number | null,
  parent: Node | null,
) => boolean;

export function nodesClassificationRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  rel: Relationship,
  match: VisitMatchFn,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return augmentRule<Relationship, Ctx, Edge>((ctx) => {
    const { root } = ctx;
    const edges: Edge[] = [];

    visit(root as unknown as Node, (node, index, parent) => {
      const nodeIndex: number | null = typeof index === "number" ? index : null;
      const parentNode: Node | null = parent ?? null;

      if (match(node as Node, nodeIndex, parentNode)) {
        const edge = {
          rel,
          from: root,
          to: node as Node,
        } as unknown as Edge;
        edges.push(edge);
      }
    });

    return edges.length ? edges : false;
  });
}
