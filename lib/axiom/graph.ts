import { Root } from "types/mdast";
import { Node } from "types/unist";
import {
  astGraphEdges,
  GraphEdge,
  TypicalGraphEdge,
  TypicalRelationship,
  TypicalRuleCtx,
  typicalRules,
} from "./edge/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type Graph<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  readonly root: Root;
  readonly edges: readonly Edge[];
};

export function graph(root: Root) {
  const graph: Graph<TypicalRelationship, TypicalGraphEdge> = {
    root,
    edges: Array.from(
      astGraphEdges<TypicalRelationship, TypicalGraphEdge, TypicalRuleCtx>(
        root,
        {
          prepareContext: () => ({ root }),
          rules: () => typicalRules(),
        },
      ),
    ),
  };

  return {
    ...graph,

    // just some convenience methods
    rels: new Set(graph.edges.map((e) => e.rel)),
    relCounts: graph.edges.reduce(
      (acc, e) => ((acc[e.rel] = (acc[e.rel] ?? 0) + 1), acc),
      {} as Record<Any, number>,
    ),
  };
}

// -----------------------------------------------------------------------------
// Visual Debugging: Graphviz DOT Export
// -----------------------------------------------------------------------------

/**
 * Turn a Graph into a Graphviz DOT string for visual debugging.
 *
 * Nodes are given synthetic IDs but labeled with a best-effort string:
 *   - `node.type` if present
 *   - otherwise "node".
 * The root is labeled "root".
 */
export function graphToDot<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(
  graph: Graph<Relationship, Edge>,
  options?: {
    graphName?: string;
  },
): string {
  const { root, edges } = graph;
  const name = options?.graphName ?? "G";

  const nodeIds = new Map<Node, string>();
  let nextId = 0;

  function getId(node: Node): string {
    const existing = nodeIds.get(node);
    if (existing) return existing;
    const id = `n${nextId++}`;
    nodeIds.set(node, id);
    return id;
  }

  function labelFor(node: Node): string {
    if (node === root) return "root";
    const typed = node as { type?: unknown };
    if (typeof typed.type === "string") return typed.type;
    return "node";
  }

  const lines: string[] = [];
  lines.push(`digraph ${name} {`);

  // Collect nodes from edges
  for (const edge of edges) {
    getId(edge.from);
    getId(edge.to);
  }

  // Emit node declarations
  for (const [node, id] of nodeIds.entries()) {
    const label = labelFor(node).replace(/"/g, '\\"');
    lines.push(`  ${id} [label="${label}"];`);
  }

  // Emit edges
  for (const edge of edges) {
    const fromId = getId(edge.from);
    const toId = getId(edge.to);
    const relLabel = String(edge.rel).replace(/"/g, '\\"');
    lines.push(`  ${fromId} -> ${toId} [label="${relLabel}"];`);
  }

  lines.push("}");
  return lines.join("\n");
}
