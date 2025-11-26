// model.ts
//
// Deno entrypoint for the Spry Graph Viewer.
// - Reads Markdown fixture(s)
// - Runs the Ontology Graphs and Edges rule pipeline
// - Builds a GraphViewerModel (graph-centric JSON)
// - Injects that JSON into index.html and serves it via Deno.serve

import { toMarkdown } from "mdast-util-to-markdown";
import type { Heading, Paragraph, Root, RootContent } from "types/mdast";
import type { Node } from "types/unist";

import {
  astGraphEdges,
  containedInSectionRule,
  createGraphRulesBuilder,
  frontmatterClassificationRule,
  GraphEdge,
  headingText,
  isBoldSingleLineParagraph,
  isColonSingleLineParagraph,
  IsSectionContainer,
  nodeDependencyRule,
  nodesClassificationRule,
  RuleContext,
  sectionFrontmatterRule,
  selectedNodesClassificationRule,
} from "../graph.ts";

import {
  type GraphEdgesTree,
  graphEdgesTree,
  type GraphEdgeTreeNode,
} from "../graph-tree.ts";

import { queryPosixPI } from "../../../universal/posix-pi.ts";
import { codeFrontmatterNDF } from "../../plugin/node/code-frontmatter.ts";
import { markdownASTs } from "../io.ts";

// -----------------------------------------------------------------------------
// Types: GraphViewerModel (what index.js expects)
// -----------------------------------------------------------------------------

type HierarchyNode = {
  readonly nodeId: string;
  readonly level: number;
  readonly rels: readonly string[];
  readonly children: readonly HierarchyNode[];
};

type GraphViewerDocument = {
  readonly id: string;
  readonly label: string;
};

type GraphViewerRelationship = {
  readonly name: string;
  readonly hierarchical: boolean;
  readonly description?: string;
  readonly edgeCount: number;
};

type GraphViewerNode = {
  readonly id: string;
  readonly documentId: string;
  readonly type: string;
  readonly label: string;
  readonly rels: string[];
  readonly path?: string | null;
  readonly mdastIndex?: number;
  readonly language?: string | null;
  readonly source?: string | null;
};

type GraphViewerEdge = {
  readonly id: string;
  readonly documentId: string;
  readonly from: string;
  readonly to: string;
};

type GraphViewerModel = {
  readonly title: string;
  readonly appVersion: string;

  readonly documents: readonly GraphViewerDocument[];
  readonly relationships: readonly GraphViewerRelationship[];

  readonly nodes: Record<string, GraphViewerNode>;
  readonly edges: Record<string, GraphViewerEdge[]>;
  readonly hierarchies: Record<string, Record<string, HierarchyNode[]>>;

  readonly mdastStore: readonly unknown[];

  readonly defaultDocumentId?: string | null;
  readonly defaultRelationshipName?: string | null;
};

// -----------------------------------------------------------------------------
// Relationships & rule context (same as Ontology Graphs and Edges test)
// -----------------------------------------------------------------------------

type Relationship = string;

type WebUiGraphEdge = GraphEdge<Relationship>;
type WebUiRuleCtx = RuleContext;

// The main hierarchical relationship we care about for the tree view.
const HIERARCHICAL_RELS = new Set<Relationship>([
  "containedInSection",
]);

// -----------------------------------------------------------------------------
// Section container callback (headings + heading-like paragraphs)
// -----------------------------------------------------------------------------

const headingLikeSectionContainer: IsSectionContainer = (node: Node) => {
  if (node.type === "heading") {
    return {
      nature: "heading" as const,
      label: headingText(node),
      mdLabel: toMarkdown(node as Heading),
    };
  }

  if (node.type !== "paragraph") return false;

  const candidate = isBoldSingleLineParagraph(node as Paragraph) ??
    isColonSingleLineParagraph(node as Paragraph);

  if (!candidate) return false;

  return {
    nature: "section" as const,
    ...candidate,
  };
};

// -----------------------------------------------------------------------------
// Build the rule pipeline (same as Ontology Graphs and Edges test)
// -----------------------------------------------------------------------------

function buildRules() {
  const builder = createGraphRulesBuilder<
    Relationship,
    WebUiRuleCtx,
    WebUiGraphEdge
  >();

  return builder
    .use(
      containedInSectionRule<Relationship, WebUiRuleCtx, WebUiGraphEdge>(
        "containedInSection",
        headingLikeSectionContainer,
      ),
    )
    .use(
      sectionFrontmatterRule<Relationship, WebUiRuleCtx, WebUiGraphEdge>(
        "frontmatter",
        ["containedInSection"] as Relationship[],
      ),
    )
    .use(
      frontmatterClassificationRule<Relationship, WebUiRuleCtx, WebUiGraphEdge>(
        "doc-classify",
      ),
    )
    .use(
      selectedNodesClassificationRule<
        Relationship,
        WebUiRuleCtx,
        WebUiGraphEdge
      >(
        "emphasis",
        "isImportant",
      ),
    )
    .use(
      nodesClassificationRule<Relationship, WebUiRuleCtx, WebUiGraphEdge>(
        "isTask",
        (node) => (node as { type?: string }).type === "listItem",
      ),
    )
    .use(
      nodeDependencyRule<Relationship, WebUiRuleCtx, WebUiGraphEdge>(
        "codeDependsOn",
        (node): boolean => node.type === "code",
        (node, name): boolean => {
          if (!codeFrontmatterNDF.is(node)) return false;
          return node.data.codeFM.pi.pos[0] === name;
        },
        (node) => {
          if (!codeFrontmatterNDF.is(node)) return false;
          const qf = queryPosixPI(node.data.codeFM.pi);
          const deps = qf.getTextFlagValues("dep");
          return deps.length > 0 ? deps : false;
        },
      ),
    )
    .build();
}

// -----------------------------------------------------------------------------
// Node label helper (similar to graph-tree's defaultNodeLabel)
// -----------------------------------------------------------------------------

function computeNodeLabel(node: Node): string {
  const type = (node as { type?: string }).type ?? "unknown";

  // Headings: "heading:#2 My title"
  if (type === "heading") {
    const heading = node as Heading;
    const text = headingText(heading) || "(heading)";
    const depthPart = typeof heading.depth === "number"
      ? `#${heading.depth} `
      : "";
    return `heading:${depthPart}${text}`;
  }

  // Paragraphs: "paragraph:First few words…"
  if (type === "paragraph") {
    const text = nodePlainText(node) || "(paragraph)";
    return `paragraph:${truncate(text, 80)}`;
  }

  // Code blocks: "code:yaml @id mdast-io-project"
  if (type === "code") {
    const c = node as Node & { lang?: string | null; value?: string };
    const lang = c.lang ? c.lang.toLowerCase() : "";
    const firstLine = (c.value ?? "").split(/\r?\n/, 1)[0] ?? "";
    const langPart = lang ? `${lang} ` : "";
    const textPart = firstLine ? truncate(firstLine, 60) : "(code)";
    return `code:${langPart}${textPart}`;
  }

  // Lists and list items: "list", "- First list item…"
  if (type === "listItem" || type === "list") {
    const text = nodePlainText(node);
    if (text) {
      const prefix = type === "listItem" ? "- " : "list:";
      return `${prefix}${truncate(text, 80)}`;
    }
    return type;
  }

  // Fallback: type + truncated visible text, never JSON
  const text = nodePlainText(node);
  if (text) {
    return `${type}:${truncate(text, 80)}`;
  }
  return type;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

// Flatten visible text from a node (ignores formatting)
function nodePlainText(node: Node): string {
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

// -----------------------------------------------------------------------------
// Build GraphEdgesTree for one markdown Root using `containedInSection`
// -----------------------------------------------------------------------------

function buildGraphTreeForRoot(
  _root: Root,
  edges: WebUiGraphEdge[],
): GraphEdgesTree<
  Relationship,
  WebUiGraphEdge
> {
  return graphEdgesTree<Relationship, WebUiGraphEdge>(edges, {
    relationships: ["containedInSection"],
  });
}

// -----------------------------------------------------------------------------
// GraphViewerModel builder
// -----------------------------------------------------------------------------

export async function buildGraphViewerModelFromFiles(
  markdownPaths: string[],
): Promise<GraphViewerModel> {
  const documents: GraphViewerDocument[] = [];
  const nodes: Record<string, GraphViewerNode> = {};
  const edgesByRel: Record<string, GraphViewerEdge[]> = {};
  const hierarchies: Record<string, Record<string, HierarchyNode[]>> = {};
  const mdastStore: unknown[] = [];

  const relEdgeCounts = new Map<string, number>();

  const rules = buildRules();

  let docIndex = 0;

  for await (const viewable of markdownASTs(markdownPaths)) {
    const root = viewable.mdastRoot as Root;

    const docId = `doc${docIndex}`;
    const docLabel = (viewable.file.path as string | undefined) ??
      (viewable.fileRef
        ? (viewable.fileRef(root as never) as string)
        : `Document ${docIndex + 1}`);

    documents.push({ id: docId, label: docLabel });

    // Per-document node & mdast index mapping
    const nodeIdByNode = new WeakMap<Node, string>();
    let nodeIdByNodeSize = 0;

    const ensureNodeId = (n: Node): string => {
      const existing = nodeIdByNode.get(n);
      if (existing) return existing;

      const nodeId = `${docId}-n${nodeIdByNodeSize}`;
      nodeIdByNode.set(n, nodeId);
      nodeIdByNodeSize++;

      // store mdast node
      const mdastIndex = mdastStore.length;
      mdastStore.push(n);

      const type = (n as { type?: string }).type ?? "unknown";
      const label = computeNodeLabel(n);

      let language: string | null = null;
      let source: string | null = null;

      if (type === "code") {
        const c = n as Node & { lang?: string | null; value?: string };
        language = c.lang ?? null;
        source = c.value ?? null;
      } else if (type === "heading" || type === "paragraph") {
        language = "markdown";
        source = toMarkdown(n as RootContent);
      }

      nodes[nodeId] = {
        id: nodeId,
        documentId: docId,
        type,
        label,
        rels: [],
        path: null,
        mdastIndex,
        language,
        source,
      };

      return nodeId;
    };

    // Run rules on this document
    const baseCtx: WebUiRuleCtx = { root };
    const docEdges: WebUiGraphEdge[] = [];
    docEdges.push(
      ...astGraphEdges<Relationship, WebUiGraphEdge, WebUiRuleCtx>(root, {
        prepareContext: () => baseCtx,
        rules: () => rules,
      }),
    );

    // Process edges: group by relationship, connect nodes, count rels
    for (const e of docEdges) {
      const relName = String(e.rel);
      const fromId = ensureNodeId(e.from);
      const toId = ensureNodeId(e.to);

      if (!edgesByRel[relName]) edgesByRel[relName] = [];
      const edgeId = `${docId}:${relName}:${fromId}->${toId}`;

      edgesByRel[relName].push({
        id: edgeId,
        documentId: docId,
        from: fromId,
        to: toId,
      });

      // Count edges per relationship
      relEdgeCounts.set(relName, (relEdgeCounts.get(relName) ?? 0) + 1);

      // Track rel participation on both nodes
      const fromNode = nodes[fromId];
      const toNode = nodes[toId];
      if (fromNode && !fromNode.rels.includes(relName)) {
        fromNode.rels.push(relName);
      }
      if (toNode && !toNode.rels.includes(relName)) {
        toNode.rels.push(relName);
      }
    }

    // Build hierarchy for containedInSection (or any other hierarchical rels)
    const tree = buildGraphTreeForRoot(root, docEdges);

    const toHierarchyNode = (
      n: GraphEdgeTreeNode<Relationship, WebUiGraphEdge>,
    ): HierarchyNode => ({
      nodeId: ensureNodeId(n.node),
      level: n.level,
      rels: [...n.rels],
      children: n.children.map(toHierarchyNode),
    });

    for (const rel of HIERARCHICAL_RELS) {
      const relName = String(rel);
      if (!hierarchies[relName]) hierarchies[relName] = {};

      const forest: HierarchyNode[] = [];
      for (const rootNode of tree.roots) {
        forest.push(toHierarchyNode(rootNode));
      }

      hierarchies[relName][docId] = forest;
    }

    docIndex++;
  }

  // Build relationships list from counts
  const relationships: GraphViewerRelationship[] = [];
  for (const [name, count] of relEdgeCounts.entries()) {
    relationships.push({
      name,
      hierarchical: HIERARCHICAL_RELS.has(name as Relationship),
      edgeCount: count,
      description: undefined,
    });
  }

  // Sort relationships alphabetically for a stable UI
  relationships.sort((a, b) => a.name.localeCompare(b.name));

  const defaultDocumentId = documents.length > 0 ? documents[0].id : null;

  const defaultRelationshipName =
    relationships.find((r) => r.hierarchical)?.name ??
      (relationships[0]?.name ?? null);

  const model: GraphViewerModel = {
    title: "Spry Graph Viewer",
    appVersion: "0.1.0",
    documents,
    relationships,
    nodes,
    edges: edgesByRel,
    hierarchies,
    mdastStore,
    defaultDocumentId,
    defaultRelationshipName,
  };

  return model;
}
