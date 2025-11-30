import { GraphEdge } from "../edge/mod.ts";
import { headingLikeNodeDataBag } from "../edge/rule/mod.ts";
import { GraphEdgesTree, GraphEdgeTreeNode } from "./tree.ts";

// -----------------------------------------------------------------------------
// Text rendering for GraphEdgesTree
// -----------------------------------------------------------------------------

export type GraphEdgesTreeTextOptions<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  /**
   * Produce a label for a node when rendering.
   * Defaults to the label stored on the GraphEdgeTreeNode.
   *
   * `relationship` is the relationship heading currently being rendered,
   * or undefined if called in a no-rels fallback mode.
   */
  readonly label?: (args: {
    node: GraphEdgeTreeNode<Relationship, Edge>;
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[];
    relationship: Relationship | undefined;
  }) => string;

  /**
   * Decide whether to traverse this node's children.
   *
   * If omitted, children are always traversed (subject to shouldEmit for them).
   *
   * `ancestors` is an array from root → parent (excluding the node itself).
   * `relationship` is the current rel whose section we are rendering.
   */
  readonly shouldFollow?: (args: {
    node: GraphEdgeTreeNode<Relationship, Edge>;
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[];
    relationship: Relationship | undefined;
  }) => boolean;

  /**
   * Decide whether this node itself should be printed.
   *
   * If omitted, all nodes are emitted.
   *
   * `ancestors` is an array from root → parent (excluding the node itself).
   * `relationship` is the current rel whose section we are rendering.
   */
  readonly shouldEmit?: (args: {
    node: GraphEdgeTreeNode<Relationship, Edge>;
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[];
    relationship: Relationship | undefined;
  }) => boolean;
};

/**
 * Render a GraphEdgesTree as a multi-line string.
 *
 * When there are relationships present, the output is grouped as:
 *
 *   - <rel1>
 *     rootLabel
 *     ├─ child
 *     └─ ...
 *
 *   - <rel2>
 *     ...
 *
 * If `tree.rels` is empty, it falls back to rendering the forest once
 * without the relationship bullets.
 */
export function graphEdgesTreeText<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(
  tree: GraphEdgesTree<Relationship, Edge>,
  options: GraphEdgesTreeTextOptions<Relationship, Edge> = {},
): string {
  const rels = tree.rels as Relationship[];
  const roots = Array.from(tree.roots);

  const labelFn = options.label ??
    ((args: {
      node: GraphEdgeTreeNode<Relationship, Edge>;
      ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[];
      relationship: Relationship | undefined;
    }) => args.node.label);

  const shouldFollowOpt = options.shouldFollow;
  const shouldEmitOpt = options.shouldEmit;

  const lines: string[] = [];

  const shouldFollow = (
    node: GraphEdgeTreeNode<Relationship, Edge>,
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[],
    relationship: Relationship | undefined,
  ): boolean =>
    shouldFollowOpt ? shouldFollowOpt({ node, ancestors, relationship }) : true;

  const shouldEmit = (
    node: GraphEdgeTreeNode<Relationship, Edge>,
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[],
    relationship: Relationship | undefined,
  ): boolean =>
    shouldEmitOpt ? shouldEmitOpt({ node, ancestors, relationship }) : true;

  // ---------------------------------------------------------------------------
  // Helper: "no rels" fallback → render forest once, no bullets
  // ---------------------------------------------------------------------------
  if (!rels.length) {
    const rel: Relationship | undefined = undefined;

    const renderNode = (
      node: GraphEdgeTreeNode<Relationship, Edge>,
      ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[],
      prefix: string,
      isLast: boolean,
    ): void => {
      const follow = shouldFollow(node, ancestors, rel);
      const emit = shouldEmit(node, ancestors, rel);

      if (!emit && !follow) return;

      const connector = prefix ? (isLast ? "└─ " : "├─ ") : "";

      if (emit) {
        lines.push(
          `${prefix}${connector}${
            labelFn({ node, ancestors, relationship: rel })
          }`,
        );
      }

      if (!follow) return;

      const childPrefix = prefix + (isLast ? "   " : "│  ");
      const children = node.children;
      const lastIndex = children.length - 1;
      const nextAncestors = [...ancestors, node];

      children.forEach((child, index) => {
        renderNode(child, nextAncestors, childPrefix, index === lastIndex);
      });
    };

    roots.forEach((rootNode, index) => {
      const isLastRoot = index === roots.length - 1;
      renderNode(rootNode, [], "", isLastRoot);
      if (!isLastRoot) lines.push("");
    });

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // With relationships: bullet per relationship + tree under each
  // ---------------------------------------------------------------------------

  // Cache: does this node or any descendant participate in `rel`?
  const hasRelCache = new Map<
    Relationship,
    Map<GraphEdgeTreeNode<Relationship, Edge>, boolean>
  >();

  const nodeHasRel = (
    node: GraphEdgeTreeNode<Relationship, Edge>,
    rel: Relationship,
  ): boolean => {
    let cacheForRel = hasRelCache.get(rel);
    if (!cacheForRel) {
      cacheForRel = new Map();
      hasRelCache.set(rel, cacheForRel);
    }

    const cached = cacheForRel.get(node);
    if (cached !== undefined) return cached;

    // A node participates in `rel` if its incoming rels contain it,
    // or if any descendant participates.
    const own = node.rels.includes(rel);
    if (own) {
      cacheForRel.set(node, true);
      return true;
    }

    for (const child of node.children) {
      if (nodeHasRel(child, rel)) {
        cacheForRel.set(node, true);
        return true;
      }
    }

    cacheForRel.set(node, false);
    return false;
  };

  // Render a forest for a single relationship, returning only its lines (no bullet).
  const renderForestForRel = (rel: Relationship): string[] => {
    const out: string[] = [];

    const renderNode = (
      node: GraphEdgeTreeNode<Relationship, Edge>,
      ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[],
      prefix: string,
      isLast: boolean,
      hasPrintedAncestor: boolean,
    ): void => {
      if (!nodeHasRel(node, rel)) return;

      const follow = shouldFollow(node, ancestors, rel);
      const emit = shouldEmit(node, ancestors, rel);

      if (!emit && !follow) return;

      // Non-emitted nodes are "transparent": they don't change prefix,
      // but their children still inherit the current prefix.
      if (emit) {
        const connector = hasPrintedAncestor ? (isLast ? "└─ " : "├─ ") : ""; // first printed node under a root already has its line

        const linePrefix = hasPrintedAncestor ? prefix : "";
        out.push(
          `${linePrefix}${connector}${
            labelFn({
              node,
              ancestors,
              relationship: rel,
            })
          }`,
        );
      }

      if (!follow) return;

      const children = node.children.filter((child) => nodeHasRel(child, rel));
      if (!children.length) return;

      const nextAncestors = [...ancestors, node];

      const nextHasPrintedAncestor = hasPrintedAncestor || emit;

      const childPrefix = emit && nextHasPrintedAncestor
        ? prefix + (isLast ? "   " : "│  ")
        : prefix;

      const lastIndex = children.length - 1;
      children.forEach((child, index) => {
        renderNode(
          child,
          nextAncestors,
          childPrefix,
          index === lastIndex,
          nextHasPrintedAncestor,
        );
      });
    };

    roots.forEach((rootNode) => {
      if (!nodeHasRel(rootNode, rel)) return;

      const ancestors: GraphEdgeTreeNode<Relationship, Edge>[] = [];
      const emitRoot = shouldEmit(rootNode, ancestors, rel);
      const followRoot = shouldFollow(rootNode, ancestors, rel);

      if (!emitRoot && !followRoot) return;

      if (emitRoot) {
        out.push(
          labelFn({
            node: rootNode,
            ancestors,
            relationship: rel,
          }),
        );
      }

      if (followRoot) {
        const children = rootNode.children.filter((child) =>
          nodeHasRel(child, rel)
        );
        const lastIndex = children.length - 1;

        children.forEach((child, index) => {
          renderNode(
            child,
            [rootNode],
            "",
            index === lastIndex,
            /* hasPrintedAncestor */ emitRoot,
          );
        });
      }
    });

    return out;
  };

  // Bullet per relationship + indented tree under each.
  rels.forEach((rel, relIndex) => {
    const relLines = renderForestForRel(rel);
    if (!relLines.length) {
      return;
    }

    lines.push(`- ${String(rel)}`);
    for (const line of relLines) {
      lines.push(`  ${line}`);
    }

    if (relIndex < rels.length - 1) {
      lines.push("");
    }
  });

  return lines.join("\n");
}

export function headingsTreeText<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(tree: GraphEdgesTree<Relationship, Edge>, emitColors?: boolean) {
  return graphEdgesTreeText(tree, {
    shouldEmit: ({ node }) =>
      // deno-lint-ignore no-explicit-any
      (node.node as any).type === "heading" ||
      headingLikeNodeDataBag.is(node.node),
    // still follow through non-heading nodes to reach deeper headings
    shouldFollow: () => true,
    label: ({ node }) => {
      const base = node.label; // whatever graphEdgesTree() stored
      const level = node.level;

      if (emitColors) {
        // Example simple coloring by level with ANSI (or your own scheme)
        const colors = [
          "\x1b[1m", // bold for level 0
          "\x1b[36m", // cyan
          "\x1b[33m", // yellow
          "\x1b[32m", // green
          "\x1b[35m", // magenta
          "\x1b[34m", // blue
        ];
        const color = colors[Math.min(level, colors.length - 1)];
        const reset = "\x1b[0m";

        return `${color}${base}${reset}`;
      }

      return base;
    },
  });
}
