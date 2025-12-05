import { Node } from "types/unist";
import { GraphEdge } from "../edge/mod.ts";
import { typicalNodeLabel } from "../mdast/node-content.ts";

// -----------------------------------------------------------------------------
// Tree node + tree types
// -----------------------------------------------------------------------------

export type GraphEdgeTreeNode<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  readonly node: Node;
  /**
   * The edge that connects this node to its parent in the tree (null for roots).
   */
  readonly edge: Edge | null;
  /**
   * All relationships that connect this node to its parent (i.e., from parent → this node)
   * across the edges used to build the hierarchy.
   */
  readonly rels: readonly Relationship[];
  readonly label: string;
  readonly level: number;
  readonly children: readonly GraphEdgeTreeNode<Relationship, Edge>[];
};

export type GraphEdgesTree<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  readonly rels: Relationship[];
  readonly edges: Iterable<Edge>;
  readonly roots: Iterable<GraphEdgeTreeNode<Relationship, Edge>>;
};

// -----------------------------------------------------------------------------
// Options for building the tree
// -----------------------------------------------------------------------------

export type GraphEdgesTreeOptions<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  /**
   * Relationships to consider as hierarchical.
   *
   * - If omitted or empty, *all* relationships in edges are considered and
   *   used for the hierarchy (like the old buildHierarchyTrees with a single rel).
   *
   * - If provided and has > 0 entries, the FIRST relationship in this array
   *   is treated as the PRIMARY structural relationship. The tree shape
   *   (parent/child links) is derived only from edges with that relationship.
   *
   *   All other relationships in this array are tracked per-node (node.rels)
   *   and in tree.rels, and are available for text rendering / filtering,
   *   but they do NOT change the hierarchy.
   */
  readonly relationships?: readonly Relationship[];

  /**
   * Given an edge, return the parent/child pair for the tree,
   * or null/false to ignore this edge for hierarchy purposes.
   *
   * Defaults to:
   *   child = edge.from
   *   parent = edge.to
   *
   * i.e. the same semantics as buildHierarchyTrees.
   */
  readonly resolveHierarchy?: (
    edge: Edge,
  ) => { parent: Node; child: Node } | null | false;

  /**
   * Optionally override the level (depth) for a node.
   * defaultLevel is computed as:
   *   root: 0
   *   child: parent.level + 1
   */
  readonly nodeLevel?: (args: {
    node: Node;
    edge: Edge | null; // edge from parent → this node (null for roots)
    parent: GraphEdgeTreeNode<Relationship, Edge> | null;
    defaultLevel: number;
  }) => number;

  /**
   * Produce a label for a node in the tree.
   * Defaults to a simple best-effort label based on `node.type` (and heading text).
   */
  readonly nodeLabel?: (args: {
    node: Node;
    edge: Edge | null; // edge from parent → this node (null for roots)
    parent: GraphEdgeTreeNode<Relationship, Edge> | null;
    level: number;
  }) => string;
};

// -----------------------------------------------------------------------------
// Core: build a hierarchy from edges
// -----------------------------------------------------------------------------

function defaultResolveHierarchy<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(edge: Edge): { parent: Node; child: Node } {
  // Same semantics as buildHierarchyTrees:
  //   child --rel--> parent  (i.e. from = child, to = parent)
  return { parent: edge.to, child: edge.from };
}

export function graphEdgesTree<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(
  inputEdges: Iterable<Edge>,
  options: GraphEdgesTreeOptions<Relationship, Edge> = {},
): GraphEdgesTree<Relationship, Edge> {
  const {
    relationships,
    resolveHierarchy = defaultResolveHierarchy,
    // Wrap defaultNodeLabel so the param type matches the options type
    nodeLabel = (args) => typicalNodeLabel(args.node),
    nodeLevel,
  } = options;

  const edges = Array.from(inputEdges);

  const relationshipsArr = relationships ? [...relationships] : undefined;
  const primaryRel = relationshipsArr?.[0];

  const relFilter = relationshipsArr && relationshipsArr.length
    ? new Set<Relationship>(relationshipsArr)
    : undefined;

  // Track which rels actually contributed (even if not structural).
  const usedRels = new Set<Relationship>();

  type ParentInfo = { parent: Node; via: Edge };
  type ChildInfo = { child: Node; via: Edge };

  // These define the STRUCTURAL hierarchy (only primaryRel or all rels if none specified).
  const parentByNode = new Map<Node, ParentInfo>();
  const childrenByNode = new Map<Node, ChildInfo[]>();

  // Track all incoming relationships per node (not just the structural ones).
  const incomingRelsByNode = new Map<Node, Set<Relationship>>();

  for (const edge of edges) {
    // Filter by relationships if provided
    if (relFilter && !relFilter.has(edge.rel)) continue;

    const resolved = resolveHierarchy(edge);
    if (!resolved) continue;

    const { parent, child } = resolved;

    usedRels.add(edge.rel);

    // Decide whether this edge contributes to the structural hierarchy
    const isStructural = !primaryRel || edge.rel === primaryRel;

    if (isStructural) {
      parentByNode.set(child, { parent, via: edge });

      let children = childrenByNode.get(parent);
      if (!children) {
        children = [];
        childrenByNode.set(parent, children);
      }

      if (!children.some((c) => c.child === child && c.via === edge)) {
        children.push({ child, via: edge });
      }

      // Ensure child is present in the children map (even if it has no children itself).
      if (!childrenByNode.has(child)) {
        childrenByNode.set(child, []);
      }
    }

    // Record incoming relationship for this child node (for all rels, not just structural)
    let rels = incomingRelsByNode.get(child);
    if (!rels) {
      rels = new Set<Relationship>();
      incomingRelsByNode.set(child, rels);
    }
    rels.add(edge.rel);
  }

  if (childrenByNode.size === 0) {
    return {
      rels: [],
      edges,
      roots: [],
    };
  }

  // Roots: nodes that participate structurally (as parent or child) but have no parent.
  const allNodes = new Set<Node>([
    ...childrenByNode.keys(),
    ...parentByNode.keys(),
  ]);

  const roots: Node[] = [];
  for (const node of allNodes) {
    if (!parentByNode.has(node)) {
      roots.push(node);
    }
  }

  const buildTree = (
    node: Node,
    parent: GraphEdgeTreeNode<Relationship, Edge> | null,
    edgeFromParent: Edge | null,
  ): GraphEdgeTreeNode<Relationship, Edge> => {
    const defaultLevel = parent ? parent.level + 1 : 0;
    const level = nodeLevel
      ? nodeLevel({ node, edge: edgeFromParent, parent, defaultLevel })
      : defaultLevel;

    const relsSet = incomingRelsByNode.get(node);
    const rels = relsSet ? Array.from(relsSet) : [];

    const label = nodeLabel({
      node,
      edge: edgeFromParent,
      parent,
      level,
    });

    const childInfos = childrenByNode.get(node) ?? [];

    const self: GraphEdgeTreeNode<Relationship, Edge> = {
      node,
      edge: edgeFromParent,
      rels,
      label,
      level,
      children: [],
    };

    const childNodes = childInfos.map(({ child, via }) =>
      buildTree(child, self, via)
    );

    return {
      ...self,
      children: childNodes,
    };
  };

  const rootNodes = roots.map((rootNode) => buildTree(rootNode, null, null));

  return {
    rels: Array.from(usedRels),
    edges,
    roots: rootNodes,
  };
}
