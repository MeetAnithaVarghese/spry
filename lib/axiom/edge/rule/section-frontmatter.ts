import { Node } from "types/mdast";
import { GraphEdge } from "../orchestrate.ts";
import { GraphEdgesRule, RuleContext, transformRule } from "./governance.ts";

/**
 * sectionFrontmatterRule
 *
 * Watches existing edges (from previous rules). For any edge whose
 * relationship is one of the given container relationships
 * (e.g., "containedInHeading" or "containedInSection") and whose
 * `from` node is a code block with lang `yaml` or `json`, it emits an
 * additional edge:
 *
 *   codeNode --frontmatterRel--> containerNode
 *
 * This marks the code block as the "section frontmatter" for that container.
 */
export function sectionFrontmatterRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  frontmatterRel: Relationship,
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

    // Check if the "from" node is a code cell with yaml/json lang
    type CodeLikeNode = Node & { type?: string; lang?: string | null };

    const from = edge.from as CodeLikeNode;
    if (from.type !== "code") {
      return edge;
    }

    const lang = from.lang?.toLowerCase();
    if (lang !== "yaml" && lang !== "yml" && lang !== "json") {
      return edge;
    }

    // This code block is considered section frontmatter for its container
    const frontmatterEdge = {
      rel: frontmatterRel,
      from: edge.from,
      to: edge.to,
    } as unknown as Edge;

    out.push(frontmatterEdge);
    return out;
  });
}
