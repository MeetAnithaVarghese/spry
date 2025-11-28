import { toMarkdown } from "mdast-util-to-markdown";
import { Heading, Root, RootContent, Text } from "types/mdast";
import { Node } from "types/unist";
import { selectAll } from "unist-util-select";
import { visit } from "unist-util-visit";
import { defineNodeData } from "../mdast/safe-data.ts";
import { docFrontmatterNDF } from "../plugin/doc/doc-frontmatter.ts";
import { isSemanticDecorator } from "../plugin/node/node-semantic-decorator.ts";

// -----------------------------------------------------------------------------
// Core Types
// -----------------------------------------------------------------------------

export type GraphEdge<Relationship extends string> = {
  readonly rel: Relationship;
  readonly from: Node;
  readonly to: Node;
};

export type Graph<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  readonly root: Root;
  readonly edges: readonly Edge[];
};

export type RuleContext = {
  readonly root: Root;
};

/**
 * Rule:
 *  - Receives the current context and the incoming edge stream.
 *  - Returns the outgoing edges or `false` to drop everything.
 */
export type GraphEdgesRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
> = (ctx: Ctx, incoming: Iterable<Edge>) => Iterable<Edge> | false;

// -----------------------------------------------------------------------------
// Helper: iterable detection
// -----------------------------------------------------------------------------

function isIterable<T>(value: unknown): value is Iterable<T> {
  if (value == null) return false;
  return typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
}

// -----------------------------------------------------------------------------
// Pipeline Engine
// -----------------------------------------------------------------------------

/**
 * Run the rules as a pipeline:
 *
 *   root → rule1 → rule2 → rule3 → ... → final edges
 */
export function* astGraphEdges<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
  Ctx extends RuleContext,
>(
  root: Root,
  init: {
    readonly prepareContext: (root: Root) => Ctx;
    readonly rules: (
      ctx: Ctx,
    ) =>
      | Iterable<
        GraphEdgesRule<Relationship, Ctx, Edge>
      >
      | Generator<
        GraphEdgesRule<Relationship, Ctx, Edge>
      >;
  },
) {
  const { prepareContext, rules: rulesFn } = init;

  const ctx = prepareContext(root);
  const rules = rulesFn(ctx);

  let current: Iterable<Edge> = [];

  for (const rule of rules) {
    const produced = rule(ctx, current);

    if (produced === false) {
      current = [];
      continue;
    }

    current = produced;
  }

  for (const e of current) {
    yield e;
  }
}

// -----------------------------------------------------------------------------
// Rule Builders
// -----------------------------------------------------------------------------

/** Pass-through + append edges produced by builder */
export function augmentRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  build: (ctx: Ctx) => Iterable<Edge> | false,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return (ctx, incoming) => {
    const built = build(ctx);
    if (built === false) return incoming;

    const add: Iterable<Edge> = built;

    function* output(): Iterable<Edge> {
      for (const e of incoming) yield e;
      for (const e of add) yield e;
    }
    return output();
  };
}

/** A rule that emits only its own edges, ignoring incoming ones */
export function sourceRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  build: (ctx: Ctx) => Iterable<Edge> | false,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return (ctx, _incoming) => build(ctx);
}

/** Transform incoming edges (rewrite, expand, or drop) */
export function transformRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  transform: (
    ctx: Ctx,
    edge: Edge,
  ) => Edge | Iterable<Edge> | null | false,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return function* (ctx, incoming): Iterable<Edge> {
    for (const e of incoming) {
      const out = transform(ctx, e);
      if (!out) continue;
      if (isIterable<Edge>(out)) {
        for (const e2 of out) yield e2;
      } else {
        yield out;
      }
    }
  };
}

/** Filter edges via predicate */
export function filterEdgesRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  predicate: (ctx: Ctx, edge: Edge) => boolean,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return transformRule((ctx, edge) => predicate(ctx, edge) ? edge : null);
}

/** Deduplicate edges using a key function */
export function dedupeEdgesRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  keyFn: (edge: Edge) => string,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return function* (_ctx, incoming): Iterable<Edge> {
    const seen = new Set<string>();
    for (const e of incoming) {
      const key = keyFn(e);
      if (seen.has(key)) continue;
      seen.add(key);
      yield e;
    }
  };
}

/** Tap rule for debugging or "watching" and acting on existing stream */
export function tapRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  fn: (ctx: Ctx, edge: Edge) => void,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return function* (ctx, incoming): Iterable<Edge> {
    for (const e of incoming) {
      fn(ctx, e);
      yield e;
    }
  };
}

/** Final rule receiving all edges and returning a new stream */
export function finalizeRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  fn: (ctx: Ctx, edges: Iterable<Edge>) => Iterable<Edge>,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return (ctx, incoming) => fn(ctx, incoming);
}

// -----------------------------------------------------------------------------
// GraphRulesBuilder (fluent API)
// -----------------------------------------------------------------------------

export interface GraphRulesBuilder<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
> {
  /** Use a pre-built rule directly */
  use(
    rule: GraphEdgesRule<Relationship, Ctx, Edge>,
  ): this;

  /** Add a source rule (ignores incoming edges) */
  source(
    build: (ctx: Ctx) => Iterable<Edge> | false,
  ): this;

  /** Add an augment rule (passes through + adds edges) */
  augment(
    build: (ctx: Ctx) => Iterable<Edge> | false,
  ): this;

  /** Add a transform rule */
  transform(
    transformFn: (
      ctx: Ctx,
      edge: Edge,
    ) => Edge | Iterable<Edge> | null | false,
  ): this;

  /** Add a filter rule */
  filter(
    predicate: (ctx: Ctx, edge: Edge) => boolean,
  ): this;

  /** Add a dedupe rule */
  dedupe(
    keyFn: (edge: Edge) => string,
  ): this;

  /** Add a tap rule (for logging/debugging) */
  tap(
    fn: (ctx: Ctx, edge: Edge) => void,
  ): this;

  /** Add a finalize rule */
  finalize(
    fn: (ctx: Ctx, edges: Iterable<Edge>) => Iterable<Edge>,
  ): this;

  /** Build the rules array compatible with astGraphEdges */
  build(): GraphEdgesRule<Relationship, Ctx, Edge>[];
}

export function createGraphRulesBuilder<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(): GraphRulesBuilder<Relationship, Ctx, Edge> {
  const rules: GraphEdgesRule<Relationship, Ctx, Edge>[] = [];

  const api: GraphRulesBuilder<Relationship, Ctx, Edge> = {
    use(rule) {
      rules.push(rule);
      return this;
    },

    source(build) {
      rules.push(sourceRule<Relationship, Ctx, Edge>(build));
      return this;
    },

    augment(build) {
      rules.push(augmentRule<Relationship, Ctx, Edge>(build));
      return this;
    },

    transform(transformFn) {
      rules.push(transformRule<Relationship, Ctx, Edge>(transformFn));
      return this;
    },

    filter(predicate) {
      rules.push(filterEdgesRule<Relationship, Ctx, Edge>(predicate));
      return this;
    },

    dedupe(keyFn) {
      rules.push(dedupeEdgesRule<Relationship, Ctx, Edge>(keyFn));
      return this;
    },

    tap(fn) {
      rules.push(tapRule<Relationship, Ctx, Edge>(fn));
      return this;
    },

    finalize(fn) {
      rules.push(finalizeRule<Relationship, Ctx, Edge>(fn));
      return this;
    },

    build() {
      return [...rules];
    },
  };

  return api;
}

// -----------------------------------------------------------------------------
// DOMAIN RULES
// -----------------------------------------------------------------------------

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

export const headingLikeTextDef = defineNodeData("isHeadingLikeText" as const)<
  boolean
>();

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

/**
 * sectionSemanticIdRule
 *
 * Watches existing edges (from previous rules). For any edge whose
 * relationship is one of the given container relationships
 * (e.g., "containedInHeading" or "containedInSection") and whose
 * `from` node is a `semantic-decorator` type with decorator name `id`,
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

    if (isSemanticDecorator(edge.from) && edge.from.name == "id") {
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
/**
 * selectedNodesClassificationRule
 *
 * Apply a selector using `unist-util-select` and attach:
 *   root --rel--> node
 */
export function selectedNodesClassificationRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  selector: string,
  rel: Relationship,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return augmentRule<Relationship, Ctx, Edge>((ctx) => {
    const { root } = ctx;

    const targets = selectAll(selector, root);
    if (!targets.length) return false;

    const edges: Edge[] = [];
    for (const node of targets) {
      const edge = {
        rel,
        from: root,
        to: node,
      } as unknown as Edge;
      edges.push(edge);
    }

    return edges;
  });
}

/**
 * frontmatterClassificationRule
 *
 * Reads a frontmatter record (e.g. parsed YAML) and a key such as "doc-classify",
 * expecting an array of entries:
 *
 *   doc-classify:
 *     - select: heading[depth="1"]
 *       role: project
 *     - select: heading[depth="2"]
 *       role: strategy
 *     - select: heading[depth="3"]
 *       role: plan
 *     - select: heading[depth="4"]
 *       role: suite
 *     - select: heading[depth="5"]
 *       role: case
 *     - select: heading[depth="6"]
 *       role: evidence
 *
 * For each entry:
 *   - `select` is a unist-util-select selector
 *   - every other key/value pair (e.g., role: project) generates a relationship:
 *       rel = `${key}:${value}`
 *   - It wraps `selectedNodesClassificationRule` to emit:
 *       root --rel--> node
 *     for each node matched by `select`.
 */
export function frontmatterClassificationRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  frontmatterKey: string,
  frontmatter?: Record<string, unknown> | null | undefined,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return augmentRule<Relationship, Ctx, Edge>((ctx) => {
    if (!frontmatter && docFrontmatterNDF.is(ctx.root)) {
      frontmatter = ctx.root.data.documentFrontmatter.parsed.fm;
    }
    if (!frontmatter) return false;

    const raw = frontmatter[frontmatterKey];
    if (!Array.isArray(raw)) return false;

    const allEdges: Edge[] = [];

    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;

      const rec = entry as Record<string, unknown>;
      const selectorValue = rec["select"];
      if (typeof selectorValue !== "string") continue;
      const selector = selectorValue.trim();
      if (!selector) continue;

      // For each non-`select` key, generate a relationship `${key}:${value}`
      for (const [k, v] of Object.entries(rec)) {
        if (k === "select") continue;
        if (
          typeof v !== "string" &&
          typeof v !== "number" &&
          typeof v !== "boolean"
        ) {
          continue;
        }

        const rel = `${k}:${String(v)}` as Relationship;

        // Wrap selectedNodesClassificationRule and run it immediately
        const rule = selectedNodesClassificationRule<Relationship, Ctx, Edge>(
          selector,
          rel,
        );

        const result = rule(ctx, []);
        if (result && isIterable<Edge>(result)) {
          for (const e of result) {
            allEdges.push(e);
          }
        }
      }
    }

    return allEdges.length ? allEdges : false;
  });
}

/**
 * nodesClassificationRule
 *
 * Predicate-based classification (unist-util-visit compatible callback).
 *
 * For each matching node:
 *   root --rel--> node
 */
export type VisitMatchFn = (
  node: Node,
  index: number | null,
  parent: Node | null,
) => boolean;

export function nodesClassificationRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  rel: Relationship,
  match: VisitMatchFn,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return augmentRule<Relationship, Ctx, Edge>((ctx) => {
    const { root } = ctx;
    const edges: Edge[] = [];

    visit(root as unknown as Node, (node, index, parent) => {
      const nodeIndex: number | null = typeof index === "number" ? index : null;
      const parentNode: Node | null = parent ?? null;

      if (match(node as Node, nodeIndex, parentNode)) {
        const edge = {
          rel,
          from: root,
          to: node as Node,
        } as unknown as Edge;
        edges.push(edge);
      }
    });

    return edges.length ? edges : false;
  });
}

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

// -----------------------------------------------------------------------------
// Typed Relationships Helper
// -----------------------------------------------------------------------------

/**
 * Define a fixed set of relationship literals in a type-safe way.
 *
 * Example:
 *   const rels = defineRelationships("containedInHeading", "isTask", "isImportant");
 *   type Relationship = (typeof rels)[number];
 */
export function defineRelationships<const R extends readonly string[]>(
  ...relationships: R
): R {
  return relationships;
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

// -----------------------------------------------------------------------------
// Node content helpers
// -----------------------------------------------------------------------------

// Helper: extract heading text for assertions
export function headingText(node: Node): string {
  const heading = node as Heading;
  if (heading.type !== "heading") return "";
  const parts: string[] = [];
  for (const child of heading.children ?? []) {
    const textNode = child as Text;
    if (textNode.type === "text" && typeof textNode.value === "string") {
      parts.push(textNode.value);
      break;
    }
  }
  return parts.join("");
}

// Helper: flatten visible text from a node (ignores formatting)
export function nodePlainText(node: Node): string {
  if (node.type === "root") return "root";

  const parts: string[] = [];

  function walk(n: Node) {
    if (
      (n as { value?: unknown }).value &&
      (n as { type?: string }).type === "text"
    ) {
      // deno-lint-ignore no-explicit-any
      parts.push(String((n as any).value));
    }
    const anyN = n as { children?: Node[] };
    if (Array.isArray(anyN.children)) {
      for (const c of anyN.children) walk(c);
    }
  }

  walk(node);
  return parts.join("");
}
