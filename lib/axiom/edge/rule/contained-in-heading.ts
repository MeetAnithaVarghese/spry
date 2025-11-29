import { Node } from "types/mdast";
import { GraphEdge } from "../orchestrate.ts";
import { augmentRule, GraphEdgesRule, RuleContext } from "./governance.ts";

/**
 * containedInHeadingRule
 *
 * Every node gets:
 *   node --rel--> closest heading
 *
 * You pass the relationship literal (e.g., "containedInHeading")
 * so it stays type-safe with your Relationship union.
 */
export function containedInHeadingRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  rel: Relationship,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return augmentRule<Relationship, Ctx, Edge>((ctx) => {
    const { root } = ctx;
    const edges: Edge[] = [];

    type NodeWithChildren = Node & {
      type?: string;
      depth?: number;
      children?: NodeWithChildren[];
    };

    const headingStack: NodeWithChildren[] = [];

    const currentHeading = (): NodeWithChildren | undefined =>
      headingStack.length ? headingStack[headingStack.length - 1] : undefined;

    const pushEdge = (from: NodeWithChildren, to: NodeWithChildren) => {
      const edge = {
        rel,
        from,
        to,
      } as unknown as Edge;
      edges.push(edge);
    };

    const walk = (node: NodeWithChildren): void => {
      const isHeading = node.type === "heading" &&
        typeof node.depth === "number";

      if (isHeading) {
        const depth = node.depth ?? 1;

        // nearest shallower heading
        let parent: NodeWithChildren | undefined;
        for (let i = depth - 2; i >= 0; i--) {
          if (headingStack[i]) {
            parent = headingStack[i];
            break;
          }
        }
        if (parent) {
          // sub-heading knows its parent heading
          pushEdge(node, parent);
        }

        headingStack[depth - 1] = node;
        headingStack.length = depth;
      } else {
        const h = currentHeading();
        if (h && node !== (root as unknown as NodeWithChildren)) {
          pushEdge(node, h);
        }
      }

      const children = node.children;
      if (Array.isArray(children)) {
        for (const child of children) {
          walk(child);
        }
      }
    };

    const asNodeWithChildren = root as unknown as NodeWithChildren;
    const rootChildren = asNodeWithChildren.children;
    if (Array.isArray(rootChildren)) {
      for (const child of rootChildren) {
        walk(child);
      }
    }

    return edges.length ? edges : false;
  });
}
