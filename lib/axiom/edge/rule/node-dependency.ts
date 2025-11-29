import { Node } from "types/mdast";
import { GraphEdge } from "../orchestrate.ts";
import { augmentRule, GraphEdgesRule, RuleContext } from "./governance.ts";

/**
 * nodeDependencyRule
 *
 * For each "target node" (identified by isTarget(node)):
 *   1. Call nodeDeps(node) → string | string[] | false
 *   2. If not false, build isDep(name) from the dependency list
 *   3. Compare this dependency list against *all* code nodes by calling isNamedDep(node, name)
 *
 * Emits edges:
 *   sourceCode --rel--> targetCode
 */
export function nodeDependencyRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  rel: Relationship,
  isTarget: (node: Node) => boolean,
  isNamedDep: (node: Node, name: string) => boolean,
  nodeDeps: (node: Node) => string | string[] | false,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return augmentRule<Relationship, Ctx, Edge>((ctx) => {
    const { root } = ctx;

    type NodeWithChildren = Node & { children?: NodeWithChildren[] };

    const rootNode = root as unknown as NodeWithChildren;

    // Collect all code nodes
    const targets: NodeWithChildren[] = [];
    function collect(n: NodeWithChildren): void {
      if (isTarget(n)) targets.push(n);
      if (Array.isArray(n.children)) {
        for (const c of n.children) collect(c);
      }
    }
    collect(rootNode);

    if (targets.length < 2) return false;

    const edges: Edge[] = [];

    for (const source of targets) {
      const deps = nodeDeps(source);
      if (deps === false) continue;

      const depNames = Array.isArray(deps) ? deps : [deps];
      if (depNames.length === 0) continue;

      for (const target of targets) {
        if (target === source) continue;

        // If this target satisfies ANY dependency name
        if (depNames.some((name) => isNamedDep(target, name))) {
          edges.push({
            rel,
            from: source,
            to: target,
          } as unknown as Edge);
        }
      }
    }

    return edges.length ? edges : false;
  });
}
