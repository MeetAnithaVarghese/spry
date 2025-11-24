// path-tree-visit.ts
//
// Small helper utilities for walking trees produced by ./path-tree.ts
// in a style similar to `unist-util-visit-parents`.
//
// - Depth-first, pre-order traversal
// - Visitor gets the current node plus its ancestor chain
// - Visitor can signal `skip` (don’t descend into this node’s children)
//   or `exit` (stop the entire traversal)

import type {
  ClassificationTreeNode,
  CombinedTreeNode,
  ContentTreeNode,
  DocumentTree,
  SectionTreeNode,
} from "./path-tree.ts";

/* -------------------------------------------------------------------------- */
/* Basic types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Node kinds exposed by the path-tree.
 */
export type PathTreeNode = CombinedTreeNode;
export type PathTreeSectionNode = SectionTreeNode;
export type PathTreeClassificationNode = ClassificationTreeNode;
export type PathTreeContentNode = ContentTreeNode;

export type PathTreeKind = PathTreeNode["kind"];

/**
 * Action returned by a visitor.
 *
 * - `undefined` → normal traversal into children
 * - `"skip"`    → do not visit this node’s children
 * - `"exit"`    → stop the traversal entirely
 */
export type VisitAction = "skip" | "exit" | void;

/**
 * Generic visitor that can handle any node kind.
 */
export type PathTreeVisitor = (
  node: PathTreeNode,
  ancestors: readonly PathTreeNode[],
) => VisitAction;

/**
 * Visitor that only runs for a specific node kind.
 */
export type PathTreeKindVisitor<K extends PathTreeKind> = (
  node: Extract<PathTreeNode, { kind: K }>,
  ancestors: readonly PathTreeNode[],
) => VisitAction;

/**
 * Any accepted traversal root:
 *
 * - a single DocumentTree
 * - an array of DocumentTrees
 * - an array of SectionTreeNode roots
 */
export type PathTreeRoot =
  | DocumentTree
  | readonly DocumentTree[]
  | readonly SectionTreeNode[];

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

// Type guard: is this a DocumentTree?
// deno-lint-ignore no-explicit-any
function isDocumentTree(value: any): value is DocumentTree {
  return !!value && typeof value === "object" &&
    "root" in value && "sections" in value;
}

/**
 * Normalize any accepted root input into a flat list of section roots.
 */
function normalizeRoots(input: PathTreeRoot): readonly SectionTreeNode[] {
  // Array of document trees?
  if (Array.isArray(input)) {
    if (input.length === 0) return [];
    const first = input[0];
    if (isDocumentTree(first)) {
      // DocumentTree[]
      const docs = input as readonly DocumentTree[];
      return docs.flatMap((d) => d.sections);
    }
    // SectionTreeNode[]
    return input as readonly SectionTreeNode[];
  }

  // Single DocumentTree
  if (isDocumentTree(input)) {
    return input.sections;
  }

  // Fallback (shouldn’t really happen if types are followed)
  return [];
}

/**
 * Depth-first traversal. Returns `true` if traversal should exit early.
 */
function walkNode(
  node: PathTreeNode,
  ancestors: PathTreeNode[],
  visitor: PathTreeVisitor,
): boolean /* exit? */ {
  const action = visitor(node, ancestors);

  if (action === "exit") return true;
  if (action === "skip") return false;

  if (node.kind === "section" || node.kind === "classification") {
    const nextAncestors = [...ancestors, node];
    for (const child of node.children) {
      if (walkNode(child, nextAncestors, visitor)) {
        return true;
      }
    }
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Visit every node in one or more path trees (DocumentTree(s) or section roots),
 * in depth-first, pre-order, passing the node and its ancestors to `visitor`.
 *
 * The visitor may:
 *   - return `undefined` → continue into children
 *   - return `"skip"`    → do not visit this node’s children
 *   - return `"exit"`    → stop traversal entirely
 */
export function visitPathTree(
  root: PathTreeRoot,
  visitor: PathTreeVisitor,
): void {
  const roots = normalizeRoots(root);
  const ancestors: PathTreeNode[] = [];

  for (const r of roots) {
    if (walkNode(r, ancestors, visitor)) {
      break;
    }
  }
}

/**
 * Convenience helper: visit only nodes of a specific `kind`.
 *
 * Example:
 *
 * ```ts
 * visitPathTreeOfKind(tree, "content", (node, ancestors) => {
 *   console.log("content under", ancestors.map(a => a.kind));
 * });
 * ```
 */
export function visitPathTreeOfKind<K extends PathTreeKind>(
  root: PathTreeRoot,
  kind: K,
  visitor: PathTreeKindVisitor<K>,
): void {
  const wrapped: PathTreeVisitor = (node, ancestors) => {
    if (node.kind !== kind) {
      // Still traverse into children for non-matching nodes
      return;
    }
    // Narrowed node type is enforced for caller
    return visitor(node as Extract<PathTreeNode, { kind: K }>, ancestors);
  };

  visitPathTree(root, wrapped);
}
