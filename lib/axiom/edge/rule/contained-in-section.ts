import { toMarkdown } from "mdast-util-to-markdown";
import { Node, RootContent } from "types/mdast";
import { dataBag } from "../../mdast/data-bag.ts";
import { GraphEdge } from "../orchestrate.ts";
import { augmentRule, GraphEdgesRule, RuleContext } from "./governance.ts";

/**
 * Information about a section container node.
 *
 * - nature: "heading" → real mdast heading (depth-based hierarchy)
 *           "section" → pseudo-heading / section marker
 * - label:   plain-text label
 * - mdLabel: markdown-formatted label
 */
export type SectionContainerInfo = {
  readonly nature: "heading" | "section";
  readonly label: string;
  readonly mdLabel: string;
};

export type IsSectionContainer = (
  node: Node,
) => SectionContainerInfo | false;

export type SectionNestingDecision = "child" | "sibling";

export type SectionNestingFn = (args: {
  node: Node;
  info: SectionContainerInfo;
  currentContainer: Node | undefined;
  lastHeadingContainer: Node | undefined;
}) => SectionNestingDecision;

export const headingLikeNodeDataBag = dataBag<
  "isHeadingLikeText",
  boolean,
  Node
>("isHeadingLikeText");

/**
 * Detect a bold single-line paragraph:
 * A paragraph whose meaningful content is:
 *   - a single `strong`, OR
 *   - a `strong` followed by a colon (":").
 *
 * Returns:
 *   {
 *     nature: "section",
 *     label: <plain text stripped>,
 *     mdLabel: <original markdown>
 *   }
 * or false.
 */
export function isBoldSingleLineParagraph(node: RootContent) {
  if (node.type !== "paragraph") return false;

  // Remove pure whitespace nodes
  const meaningfulChildren = node.children.filter(
    (c) => !(c.type === "text" && c.value.trim() === ""),
  );

  if (meaningfulChildren.length === 0) return false;

  // Case 1: only a single strong
  if (meaningfulChildren.length === 1) {
    const only = meaningfulChildren[0];
    if (only.type === "strong") {
      const mdLabel = node.children.map((c) => toMarkdown(c)).join("");
      const label = only.children
        .map((c) => ("value" in c ? c.value : ""))
        .join("")
        .trim();
      return { label, mdLabel };
    }
    return false;
  }

  // Case 2: strong + colon
  if (meaningfulChildren.length === 2) {
    const [first, second] = meaningfulChildren;

    if (
      first.type === "strong" &&
      second.type === "text" &&
      second.value.trim() === ":"
    ) {
      const mdLabel = node.children.map((c) => toMarkdown(c)).join("");
      const label = first.children
        .map((c) => ("value" in c ? c.value : ""))
        .join("")
        .trim();
      return { label, mdLabel };
    }

    return false;
  }

  return false;
}

/**
 * Detect a single-line colon paragraph:
 * A paragraph with exactly one text child whose trimmed value ends with ":".
 *
 * Returns:
 *   {
 *     nature: "section",
 *     label: <text without trailing colon>,
 *     mdLabel: <original markdown>
 *   }
 * or false.
 */
export function isColonSingleLineParagraph(node: RootContent) {
  if (node.type !== "paragraph") return false;
  if (node.children.length !== 1) return false;

  const child = node.children[0];
  if (child.type !== "text") return false;

  const raw = child.value.trimEnd();
  if (!raw.endsWith(":")) return false;

  const mdLabel = raw; // original markdown (no children in this pattern)
  const label = raw.slice(0, -1).trim(); // strip trailing colon

  return { label, mdLabel };
}

/**
 * containedInSectionRule
 *
 * Every non-root node gets:
 *   node --rel--> closest "section container"
 *
 * "Section containers" are determined by the user-supplied callback
 * `isSectionContainer(node)`, which may recognize:
 *
 *   - true headings (node.type === "heading")
 *   - heading-like paragraphs (e.g. "**Heading**:" or "Heading:")
 *   - any other structure you want to treat as a container
 *
 * Additionally, for containers whose `nature === "heading"` and which are
 * real mdast headings (with a numeric `depth`), we preserve the original
 * heading hierarchy edges:
 *
 *   childHeading --rel--> parentHeading
 *
 * For containers whose `nature === "section"`, an optional `sectionNesting`
 * callback decides whether a new section becomes:
 *
 *   - a child of the current container ("child")  → new level, or
 *   - a sibling under the last heading ("sibling") → same level.
 *
 * DEFAULT behavior (when `sectionNesting` is omitted) is "sibling":
 * section paragraphs attach under the last heading container when present.
 *
 * Alternative: always nest sections as children (like a “staircase”)
 * If you want the previous “each paragraph starts a deeper level” behavior:
 * ------------------------------------------------------------------------
 * const rule = containedInSectionRule(
 *   "containedInSection" as const,
 *   isSectionContainer,
 *   ({ currentContainer, lastHeadingContainer }) => {
 *     // Prefer child-of-current behavior:
 *     // - If we already have a current container (heading or section), nest under it.
 *     // - Otherwise, fall back to the last heading if there is one.
 *     if (currentContainer) return "child";
 *     if (lastHeadingContainer) return "child";
 *     return "child"; // root-level section if nothing else
 *   },
 * );

 * Hybrid: first section under a heading is child; subsequent ones are siblings
 * Sometimes you might want:
 * - First “section paragraph” under a heading to be a “sub-heading” (child).
 * - Later section paragraphs under that same heading to be siblings of that first one.
 * You can approximate that with some simple state outside the callback:
 * ------------------------------------------------------------------------
 * const seenFirstSectionForHeading = new WeakMap<Node, boolean>();
 * const rule = containedInSectionRule(
 *   "containedInSection" as const,
 *   isSectionContainer,
 *   ({ node, info, currentContainer, lastHeadingContainer }) => {
 *     if (info.nature !== "section" || !lastHeadingContainer) {
 *       // fallback to default sibling semantics
 *       return "sibling";
 *     }
 *
 *     const alreadyHadFirst = seenFirstSectionForHeading.get(lastHeadingContainer);
 *     if (!alreadyHadFirst) {
 *       // mark that this heading has its first "child" section
 *       seenFirstSectionForHeading.set(lastHeadingContainer, true);
 *       return "child";
 *     }
 *
 *     // subsequent sections under same heading become siblings
 *     return "sibling";
 *   },
 * );
 */
export function containedInSectionRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  rel: Relationship,
  isSectionContainer: IsSectionContainer,
  sectionNesting?: SectionNestingFn,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return augmentRule<Relationship, Ctx, Edge>((ctx) => {
    const { root } = ctx;
    const edges: Edge[] = [];

    type NodeWithChildren = Node & {
      type?: string;
      depth?: number;
      children?: NodeWithChildren[];
    };

    // Stack for *heading* containers only (depth-based hierarchy).
    const headingStack: NodeWithChildren[] = [];

    // The current "active" section container (heading or pseudo-section).
    let currentContainer: NodeWithChildren | undefined;

    // The most recent heading container we saw.
    let lastHeadingContainer: NodeWithChildren | undefined;

    const pushEdge = (from: NodeWithChildren, to: NodeWithChildren) => {
      const edge = {
        rel,
        from,
        to,
      } as unknown as Edge;
      edges.push(edge);
    };

    const asNodeWithChildren = root as unknown as NodeWithChildren;

    const walk = (node: NodeWithChildren): void => {
      const containerInfo = isSectionContainer(node);

      if (containerInfo) {
        // This node is a container (heading or section-like).

        if (
          containerInfo.nature === "heading" &&
          node.type === "heading" &&
          typeof node.depth === "number"
        ) {
          const depth = node.depth ?? 1;

          // Nearest shallower heading is the parent.
          let parent: NodeWithChildren | undefined;
          for (let i = depth - 2; i >= 0; i--) {
            if (headingStack[i]) {
              parent = headingStack[i];
              break;
            }
          }

          if (parent) {
            // Child heading knows its parent heading.
            pushEdge(node, parent);
          }

          headingStack[depth - 1] = node;
          headingStack.length = depth;

          // Update last heading container.
          lastHeadingContainer = node;
        } else if (containerInfo.nature === "section") {
          // Section-like containers: decide parent based on callback or default.

          let parent: NodeWithChildren | undefined;

          if (sectionNesting) {
            const decision = sectionNesting({
              node,
              info: containerInfo,
              currentContainer,
              lastHeadingContainer,
            });

            if (decision === "sibling") {
              parent = lastHeadingContainer ?? currentContainer;
            } else {
              // "child"
              parent = currentContainer ?? lastHeadingContainer;
            }
          } else {
            // DEFAULT behavior: "sibling" semantics.
            // Prefer the last heading; if none, fall back to currentContainer.
            parent = lastHeadingContainer ?? currentContainer;
          }

          if (parent && node !== asNodeWithChildren) {
            pushEdge(node, parent);
          }
        }

        // Regardless of nature, this becomes the current container for subsequent nodes.
        currentContainer = node;
      } else {
        // Non-container nodes get attached to the current container
        // (if any), just like "containedInHeadingRule" attached to
        // the current heading.
        if (currentContainer && node !== asNodeWithChildren) {
          pushEdge(node, currentContainer);
        }
      }

      const children = node.children;
      if (Array.isArray(children)) {
        for (const child of children) {
          walk(child);
        }
      }
    };

    const rootChildren = asNodeWithChildren.children;
    if (Array.isArray(rootChildren)) {
      for (const child of rootChildren) {
        walk(child);
      }
    }

    return edges.length ? edges : false;
  });
}
