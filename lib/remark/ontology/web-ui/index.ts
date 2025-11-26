#!/usr/bin/env -S deno run -A --node-modules-dir=auto
// index.ts
//
// Deno entrypoint for the Spry Graph Viewer.
// - Reads Markdown fixture(s)
// - Runs the Ontology Graphs and Edges rule pipeline
// - Builds a GraphViewerModel (graph-centric JSON)
// - Injects that JSON into index.html and serves it via Deno.serve

import { fromFileUrl } from "@std/path";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Heading, Paragraph, Root, RootContent } from "types/mdast";
import type { Node } from "types/unist";

import {
  astGraphEdges,
  containedInHeadingRule,
  containedInSectionRule,
  createGraphRulesBuilder,
  defineRelationships,
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
};

// -----------------------------------------------------------------------------
// Relationships & rule context (same as Ontology Graphs and Edges test)
// -----------------------------------------------------------------------------

const relationships = defineRelationships(
  "containedInHeading",
  "containedInSection",
  "isImportant",
  "isTask",
  "isSelected",
  "codeDependsOn",
  "frontmatter",
  "role:project",
  "role:strategy",
  "role:plan",
  "role:suite",
  "role:case",
  "role:evidence",
);
type Relationship = (typeof relationships)[number];

type TestEdge = GraphEdge<Relationship>;
type TestCtx = RuleContext;

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
  const builder = createGraphRulesBuilder<Relationship, TestCtx, TestEdge>();

  return builder
    .use(
      containedInHeadingRule<Relationship, TestCtx, TestEdge>(
        "containedInHeading",
      ),
    )
    .use(
      containedInSectionRule<Relationship, TestCtx, TestEdge>(
        "containedInSection",
        headingLikeSectionContainer,
      ),
    )
    .use(
      sectionFrontmatterRule<Relationship, TestCtx, TestEdge>(
        "frontmatter",
        ["containedInHeading"] as Relationship[],
      ),
    )
    .use(
      frontmatterClassificationRule<Relationship, TestCtx, TestEdge>(
        "doc-classify",
      ),
    )
    .use(
      selectedNodesClassificationRule<Relationship, TestCtx, TestEdge>(
        "emphasis",
        "isImportant",
      ),
    )
    .use(
      nodesClassificationRule<Relationship, TestCtx, TestEdge>(
        "isTask",
        (node) => (node as { type?: string }).type === "listItem",
      ),
    )
    .use(
      nodeDependencyRule<Relationship, TestCtx, TestEdge>(
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
  const content = node as RootContent;
  if (!node.type) return "(not a node!)";

  if (content.type === "heading" || content.type === "paragraph") {
    let text = "";
    let depth: number | false = false;

    if (content.type === "heading") {
      const heading = node as Heading;
      text = headingText(heading);
      depth = heading.depth;
    } else if (content.type === "paragraph") {
      text = nodePlainText(node);
    }

    if (text) {
      const depthPart = typeof depth === "number" ? `#${depth} ` : "";
      return `${content.type}:${depthPart}${text}`;
    }
  }

  return JSON.stringify(node);
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

function buildGraphTreeForRoot(_root: Root, edges: TestEdge[]): GraphEdgesTree<
  Relationship,
  TestEdge
> {
  return graphEdgesTree<Relationship, TestEdge>(edges, {
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
    const baseCtx: TestCtx = { root };
    const docEdges: TestEdge[] = [];
    docEdges.push(
      ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
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
      n: GraphEdgeTreeNode<Relationship, TestEdge>,
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

  const model: GraphViewerModel = {
    title: "Spry Graph Viewer",
    appVersion: "0.1.0",
    documents,
    relationships,
    nodes,
    edges: edgesByRel,
    hierarchies,
    mdastStore,
  };

  return model;
}

// -----------------------------------------------------------------------------
// HTML injection + Deno server
// -----------------------------------------------------------------------------

async function buildInjectedHtml(): Promise<string> {
  const htmlTemplate = await Deno.readTextFile(
    fromFileUrl(new URL("./index.html", import.meta.url)),
  );

  const model = await buildGraphViewerModelFromFiles([
    fromFileUrl(
      new URL("../../fixture/test-fixture-01.md", import.meta.url),
    ),
  ]);

  const json = JSON.stringify(model);

  // Replace the placeholder script tag with inline JSON
  const injectedHtml = htmlTemplate.replace(
    /<script type="application\/json" id="web-ui\.model\.json"><\/script>/,
    `<script type="application/json" id="web-ui.model.json">${json}</script>`,
  );

  return injectedHtml;
}

if (import.meta.main) {
  const injectedHtml = await buildInjectedHtml();

  Deno.serve(async (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(injectedHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/index.css" || url.pathname === "/index.js") {
      const path = fromFileUrl(
        new URL("." + url.pathname, import.meta.url),
      );
      const data = await Deno.readTextFile(path);
      const contentType = url.pathname.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";

      return new Response(data, { headers: { "content-type": contentType } });
    }

    return new Response("Not found", { status: 404 });
  });
}
