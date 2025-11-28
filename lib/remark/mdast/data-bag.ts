// lib/remark/mdast/data-bag.ts
//
// Thin VisitFn adapter for mdast/unist trees, so the universal data-bag
// utilities can be used without repeating traversal boilerplate.

import type { Root as MdastRoot } from "types/mdast";
import type { Node } from "types/unist";
import type { DataBagNode, VisitFn } from "../../universal/data-bag.ts";

/**
 * A VisitFn implementation for mdast/unist-style trees:
 * - Visits every node in a depth-first manner.
 * - Treats all nodes as DataBagNode-compatible (they usually have an optional
 *   `data` property in the mdast/remark ecosystem).
 */
export const mdastVisitFn: VisitFn<MdastRoot> = (root, fn) => {
  const walk = (node: Node): void => {
    fn(node as unknown as DataBagNode);

    const maybeChildren = (node as unknown as { children?: Node[] }).children;
    if (Array.isArray(maybeChildren)) {
      for (const child of maybeChildren) {
        walk(child);
      }
    }
  };

  walk(root as unknown as Node);
};
