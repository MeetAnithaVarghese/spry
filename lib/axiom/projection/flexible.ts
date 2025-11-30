/**
 * FlexibleProjection: build a reusable, UI-agnostic graph view over Markdown documents.
 *
 * This module projects one or more Markdown files into a normalized graph model
 * (`FlexibleProjection`) that can be consumed by:
 *   - web UIs (graph viewers, explorers, dashboards),
 *   - text / CLI tools, or
 *   - orchestration and business logic that needs a node+edge view of mdast.
 *
 * What it does
 * ------------
 * Given a list of Markdown paths, `flexibleProjectionFromFiles()`:
 *   - Parses each file into an mdast `Root` via `markdownASTs`.
 *   - Runs the edge pipeline (`typicalRules` + `astGraphEdges`) to discover
 *     relationships between mdast nodes (e.g. `containedInSection`, etc.).
 *   - Assigns stable per-document node IDs and builds:
 *       - `documents`: logical documents discovered from the inputs.
 *       - `nodes`: all participating mdast nodes, labeled for display or logging.
 *       - `edges`: graph edges grouped by relationship name.
 *       - `relationships`: aggregate metadata for each relationship type.
 *       - `hierarchies`: tree-shaped views for hierarchical relationships
 *         (currently `containedInSection`), per document.
 *   - Stores the original mdast nodes in `mdastStore` so callers can
 *     dereference back from a `FlexibleProjectionNode` to the underlying AST.
 *
 * How it works
 * ------------
 * For each Markdown document:
 *   - A `docId` is generated (e.g. `doc0`, `doc1`, ...), and a human-friendly
 *     label is derived from the file path or `fileRef`.
 *   - Every mdast node that participates in any edge is assigned a unique ID
 *     within that document and inserted into `nodes`.
 *       - Headings, paragraphs, and code blocks get a `language` and `source`
 *         snippet using `toMarkdown` or the code block contents.
 *       - Node labels are computed via `computeNodeLabel()`, using visible text
 *         only (no JSON dumps) so they are safe for UI and logs.
 *   - The edge pipeline (`typicalRules` + `astGraphEdges`) produces
 *     `TypicalGraphEdge` instances, which are normalized into
 *     `FlexibleProjectionEdge` entries and grouped by relationship name.
 *   - `buildGraphTreeForRoot()` turns hierarchical relationships into
 *     forest-like structures; these are projected into `HierarchyNode`s and
 *     stored in `hierarchies[relationshipName][documentId]`.
 *   - Edge counts per relationship are summarized into
 *     `FlexibleProjectionRelationship` entries.
 *
 * The resulting `FlexibleProjection` is stable and deterministic for a given set
 * of inputs and rule configuration, making it safe for testing, caching, and
 * downstream processing.
 *
 * Usage
 * -----
 * Typical usage in a CLI, web service, or orchestrator:
 *
 *   import { flexibleProjectionFromFiles } from "./projection.ts";
 *
 *   const projection = await flexibleProjectionFromFiles([
 *     "docs/intro.md",
 *     "docs/runbook.md",
 *   ]);
 *
 *   // Example: list all relationships
 *   for (const rel of projection.relationships) {
 *     console.log(rel.name, rel.edgeCount);
 *   }
 *
 *   // Example: inspect all nodes participating in a given relationship
 *   const contained = projection.edges["containedInSection"] ?? [];
 *   for (const edge of contained) {
 *     const from = projection.nodes[edge.from];
 *     const to = projection.nodes[edge.to];
 *     // ... use node labels, types, or mdast indices for further logic
 *   }
 *
 * The `FlexibleProjection` type is intentionally UI-neutral: it can be used as
 * a backing model for different front-ends (web, TUI, tests) as well as
 * for non-UI tasks such as automation, linting, or higher-level orchestration
 * over the Markdown + Axiom edge layer.
 */
import { toMarkdown } from "mdast-util-to-markdown";
import type { Root, RootContent } from "types/mdast";
import type { Node } from "types/unist";
import { astGraphEdges } from "../edge/mod.ts";
import {
  buildGraphTreeForRoot,
  TypicalGraphEdge,
  TypicalRelationship,
  TypicalRuleCtx,
  typicalRules,
} from "../edge/pipeline/typical.ts";
import { markdownASTs, MarkdownEncountered } from "../io/mod.ts";
import { typicalNodeLabel } from "../mdast/node-content.ts";
import { graphEdgesVFileDataBag } from "../mod.ts";
import { type GraphEdgeTreeNode } from "./tree.ts";

// -----------------------------------------------------------------------------
// Types: FlexibleProjection (what index.js expects)
// -----------------------------------------------------------------------------

type HierarchyNode = {
  readonly nodeId: string;
  readonly level: number;
  readonly rels: readonly string[];
  readonly children: readonly HierarchyNode[];
};

export type FlexibleProjectionDocument = {
  readonly id: string;
  readonly label: string;
};

export type FlexibleProjectionRelationship = {
  readonly name: string;
  readonly hierarchical: boolean;
  readonly description?: string;
  readonly edgeCount: number;
};

export type FlexibleProjectionNode = {
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

export type FlexibleProjectionEdge = {
  readonly id: string;
  readonly documentId: string;
  readonly from: string;
  readonly to: string;
};

export type FlexibleProjection = {
  readonly title: string;
  readonly version: string;

  readonly documents: readonly FlexibleProjectionDocument[];
  readonly relationships: readonly FlexibleProjectionRelationship[];

  readonly nodes: Record<string, FlexibleProjectionNode>;
  readonly edges: Record<string, FlexibleProjectionEdge[]>;
  readonly hierarchies: Record<string, Record<string, HierarchyNode[]>>;

  readonly mdastStore: readonly unknown[];

  readonly defaultDocumentId?: string | null;
  readonly defaultRelationshipName?: string | null;
};

// -----------------------------------------------------------------------------
// FlexibleProjection builder
// -----------------------------------------------------------------------------

// The main hierarchical relationship we care about for the tree view.
const HIERARCHICAL_RELS = new Set<TypicalRelationship>([
  "containedInSection",
]);

export async function flexibleProjectionFromFiles(
  markdownPaths: string[],
  encountered?: (projectable: MarkdownEncountered) => void,
): Promise<FlexibleProjection> {
  const documents: FlexibleProjectionDocument[] = [];
  const nodes: Record<string, FlexibleProjectionNode> = {};
  const edgesByRel: Record<string, FlexibleProjectionEdge[]> = {};
  const hierarchies: Record<string, Record<string, HierarchyNode[]>> = {};
  const mdastStore: unknown[] = [];

  const relEdgeCounts = new Map<string, number>();

  const rules = typicalRules();

  let docIndex = 0;

  for await (const projectable of markdownASTs(markdownPaths)) {
    encountered?.(projectable);
    const root = projectable.mdastRoot as Root;

    const docId = `doc${docIndex}`;
    const docLabel = (projectable.file.path as string | undefined) ??
      (projectable.fileRef
        ? (projectable.fileRef(root as never) as string)
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
      const label = typicalNodeLabel(n);

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
    const baseCtx: TypicalRuleCtx = { root };
    const docEdges: TypicalGraphEdge[] = [];
    docEdges.push(
      ...astGraphEdges<TypicalRelationship, TypicalGraphEdge, TypicalRuleCtx>(
        root,
        {
          prepareContext: () => baseCtx,
          rules: () => rules,
        },
      ),
    );
    if (graphEdgesVFileDataBag.is(projectable.file)) {
      docEdges.push(...projectable.file.data.edges);
    }

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
      n: GraphEdgeTreeNode<TypicalRelationship, TypicalGraphEdge>,
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
  const relationships: FlexibleProjectionRelationship[] = [];
  for (const [name, count] of relEdgeCounts.entries()) {
    relationships.push({
      name,
      hierarchical: HIERARCHICAL_RELS.has(name as TypicalRelationship),
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

  const model: FlexibleProjection = {
    title: "Spry Axiom Graph Projection",
    version: "0.1.0",
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
