import { isNodeDecorator } from "../../remark/node-decorator.ts";
import { GraphEdge } from "../orchestrate.ts";
import { GraphEdgesRule, RuleContext, transformRule } from "./governance.ts";

/**
 * sectionSemanticIdRule
 *
 * Watches existing edges (from previous rules). For any edge whose
 * relationship is one of the given container relationships
 * (e.g., "containedInHeading" or "containedInSection") and whose
 * `from` node is a `decorator` type with decorator name `id`,
 * it creates another relationship like:
 *
 *   semanticDecorator --semanticIdRel--> containerNode
 *
 * This marks the code block as the "section frontmatter" for that container.
 */
export function sectionSemanticIdRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  semanticIdRel: Relationship,
  containerRels: readonly Relationship[],
): GraphEdgesRule<Relationship, Ctx, Edge> {
  const containerRelSet = new Set<Relationship>(containerRels);

  return transformRule<Relationship, Ctx, Edge>((_ctx, edge) => {
    // Always keep the original edge
    const out: Edge[] = [edge];

    // Is this one of the container relationships we care about?
    if (!containerRelSet.has(edge.rel)) {
      return edge;
    }

    if (isNodeDecorator(edge.from) && edge.from.name == "id") {
      // This semantic decorator block is considered section ID for its container
      const ssemanticIdEdge = {
        rel: semanticIdRel,
        from: edge.from,
        to: edge.to,
      } as unknown as Edge;

      out.push(ssemanticIdEdge);
    }

    return out;
  });
}
