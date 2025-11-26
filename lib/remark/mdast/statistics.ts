import type { Code, Root } from "types/mdast";
import type { Node, Parent } from "types/unist";
import { docFrontmatterNDF } from "../plugin/doc/doc-frontmatter.ts";
import { codeFrontmatterNDF } from "../plugin/node/code-frontmatter.ts";
import { codePartialSNDF } from "../plugin/node/code-partial.ts";
import {
  isCodeConsumedAsHeadingFrontmatterNode,
  isHeadingWithFrontmatter,
} from "../plugin/node/heading-frontmatter.ts";
import { hasNodeIdentities } from "../plugin/node/node-identities.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export interface NodeTypeSummary {
  type: string;
  count: number;

  minDepth: number;
  maxDepth: number;

  minStartLine: number | null;
  maxEndLine: number | null;

  /** Number of nodes of this type that have a `data` object */
  dataNodes: number;

  /** Frequency of each `data` key for this node type */
  dataKeyCounts: Record<string, number>;

  /** Nodes of this type that have a string `value` */
  textNodes: number;

  /** Sum of `value.length` for this type */
  totalTextLength: number;

  /** Max `value.length` for this type */
  maxTextLength: number;

  /** Average text length over nodes with `value` (derived) */
  avgTextLength: number;
}

export interface MdastEdge {
  fromIndex: number;
  toIndex: number;
  fromType: string;
  toType: string;
}

export interface PluginMetadataSummary {
  /** Keys present in root-level frontmatter (if any) */
  docFrontmatterKeys: string[];

  /** Headings with `data.frontmatter` (heading frontmatter plugin) */
  headingWithFrontmatter: number;

  /** Nodes that have `data.id` (identities) */
  nodesWithIds: number;

  /** Code nodes with `data.frontmatter` (code frontmatter) */
  codeCellsWithFrontmatter: number;

  /** Code nodes annotated as partials (e.g., annotations.tags includes "partial") */
  codeCellsWithPartials: number;
}

export interface MdastStats {
  /** Total number of nodes in the tree (including root) */
  totalNodes: number;

  /** Global min/max depth across all nodes (root = 0) */
  depth: {
    min: number;
    max: number;
  };

  /** Global count of all nodes that have a `data` object */
  dataNodesTotal: number;

  /** Count of how many times each `data` key appears globally */
  dataKeyCounts: Record<string, number>;

  /** Per-node-type statistics keyed by `node.type` */
  byType: Record<string, NodeTypeSummary>;

  /** Histogram of heading levels (1–6) => count */
  headingDepthHistogram: Record<number, number>;

  /** Graph over the tree: parent→child edges */
  graph: {
    /** number of nodes (same as totalNodes) */
    nodes: number;
    edges: MdastEdge[];
  };

  /** High-level summary of frontmatter / Spry-style plugin metadata */
  pluginMetadata: PluginMetadataSummary;
}

/**
 * Collect rich statistics and structural info from an MDAST tree:
 *
 * - Per-type counts, depths, line ranges
 * - `node.data` usage (global + per type)
 * - Text length stats per type
 * - Heading level histogram
 * - Parent→child edges (a DAG of the tree)
 * - Basic plugin metadata (frontmatter, roles, ids, partial/inject annotations)
 */
export function collectMdastStats(root: Root): MdastStats {
  const byType = new Map<string, NodeTypeSummary>();

  let totalNodes = 0;
  let globalMinDepth = Infinity;
  let globalMaxDepth = -Infinity;

  let dataNodesTotal = 0;
  const globalDataKeyCounts = new Map<string, number>();

  // For graph edges
  const edges: MdastEdge[] = [];
  const nodesArray: Node[] = [];

  // Heading depth histogram (heading.depth 1–6)
  const headingDepthHistogram = new Map<number, number>();

  // Plugin-ish metadata
  const docFrontmatterKeys = new Set<string>();
  let headingWithFrontmatter = 0;
  let codeCellConsumedAsHeadingWithFrontmatter = 0;
  let nodesWithIds = 0;
  let codeCellsWithFrontmatter = 0;
  let codeCellsWithPartials = 0;

  function isParent(node: Node): node is Parent {
    return Array.isArray((node as Parent).children);
  }

  // Inspect root frontmatter before traversal
  if (docFrontmatterNDF.is(root)) {
    const fm = root.data.documentFrontmatter.parsed.fm;
    if (fm && typeof fm === "object") {
      for (const key of Object.keys(fm)) {
        docFrontmatterKeys.add(key);
      }
    }
  }

  function ensureTypeSummary(
    type: string,
    depth: number,
    startLine: number | null,
    endLine: number | null,
  ): NodeTypeSummary {
    let entry = byType.get(type);
    if (!entry) {
      entry = {
        type,
        count: 0,
        minDepth: depth,
        maxDepth: depth,
        minStartLine: startLine,
        maxEndLine: endLine,
        dataNodes: 0,
        dataKeyCounts: {},
        textNodes: 0,
        totalTextLength: 0,
        maxTextLength: 0,
        avgTextLength: 0, // filled later
      };
      byType.set(type, entry);
    }
    return entry;
  }

  function updateTypeStats(node: Node, depth: number) {
    const type = node.type;
    const startLine = node.position?.start?.line ?? null;
    const endLine = node.position?.end?.line ?? null;

    const entry = ensureTypeSummary(type, depth, startLine, endLine);

    entry.count += 1;

    // Depth
    if (depth < entry.minDepth) entry.minDepth = depth;
    if (depth > entry.maxDepth) entry.maxDepth = depth;

    // Line ranges
    if (startLine != null) {
      if (entry.minStartLine == null || startLine < entry.minStartLine) {
        entry.minStartLine = startLine;
      }
    }
    if (endLine != null) {
      if (entry.maxEndLine == null || endLine > entry.maxEndLine) {
        entry.maxEndLine = endLine;
      }
    }

    // node.data + plugin-ish metadata
    const data: Any = (node as Any).data;
    if (data && typeof data === "object") {
      entry.dataNodes += 1;
      dataNodesTotal += 1;

      for (const key of Object.keys(data)) {
        // Per-type
        entry.dataKeyCounts[key] = (entry.dataKeyCounts[key] ?? 0) + 1;
        // Global
        globalDataKeyCounts.set(key, (globalDataKeyCounts.get(key) ?? 0) + 1);
      }

      if (hasNodeIdentities(node)) {
        nodesWithIds++;
      }

      if (isHeadingWithFrontmatter(node)) {
        headingWithFrontmatter += 1;
      }

      if (node.type === "code") {
        const code = node as Code;
        if (isCodeConsumedAsHeadingFrontmatterNode(code)) {
          codeCellConsumedAsHeadingWithFrontmatter++;
        }

        if (codeFrontmatterNDF.is(code)) {
          codeCellsWithFrontmatter++;
        }

        if (codePartialSNDF.is(code)) {
          codeCellsWithPartials++;
        }
      }
    }

    // Text length stats (nodes with string `value`)
    const anyNode = node as Any;
    if (typeof anyNode.value === "string") {
      const len = anyNode.value.length;
      entry.textNodes += 1;
      entry.totalTextLength += len;
      if (len > entry.maxTextLength) entry.maxTextLength = len;
    }

    // Heading level histogram (for mdast 'heading' nodes with `depth`)
    if (type === "heading") {
      const hDepth = (node as Any).depth;
      if (typeof hDepth === "number") {
        headingDepthHistogram.set(
          hDepth,
          (headingDepthHistogram.get(hDepth) ?? 0) + 1,
        );
      }
    }
  }

  /**
   * Depth-first traversal, assigning a stable index to each node and recording
   * parent→child edges.
   */
  function walk(node: Node, depth: number, parentIndex: number | null): void {
    const index = nodesArray.length;
    nodesArray.push(node);

    totalNodes += 1;

    if (depth < globalMinDepth) globalMinDepth = depth;
    if (depth > globalMaxDepth) globalMaxDepth = depth;

    updateTypeStats(node, depth);

    if (parentIndex != null) {
      const parentType = nodesArray[parentIndex].type;
      edges.push({
        fromIndex: parentIndex,
        toIndex: index,
        fromType: parentType,
        toType: node.type,
      });
    }

    if (isParent(node)) {
      for (const child of node.children) {
        walk(child, depth + 1, index);
      }
    }
  }

  walk(root as Node, 0, null);

  // Finalize per-type avgTextLength and convert maps to plain objects
  const byTypeRecord: Record<string, NodeTypeSummary> = {};
  for (const [type, summary] of byType.entries()) {
    const avg = summary.textNodes > 0
      ? summary.totalTextLength / summary.textNodes
      : 0;
    summary.avgTextLength = avg;
    byTypeRecord[type] = summary;
  }

  const globalKeyCountsObj: Record<string, number> = {};
  for (const [k, v] of globalDataKeyCounts.entries()) {
    globalKeyCountsObj[k] = v;
  }

  const headingHistObj: Record<number, number> = {};
  for (const [level, count] of headingDepthHistogram.entries()) {
    headingHistObj[level] = count;
  }

  const stats: MdastStats = {
    totalNodes,
    depth: {
      min: globalMinDepth === Infinity ? 0 : globalMinDepth,
      max: globalMaxDepth === -Infinity ? 0 : globalMaxDepth,
    },
    dataNodesTotal,
    dataKeyCounts: globalKeyCountsObj,
    byType: byTypeRecord,
    headingDepthHistogram: headingHistObj,
    graph: {
      nodes: nodesArray.length,
      edges,
    },
    pluginMetadata: {
      docFrontmatterKeys: Array.from(docFrontmatterKeys).sort(),
      headingWithFrontmatter,
      nodesWithIds,
      codeCellsWithFrontmatter,
      codeCellsWithPartials,
    },
  };

  return stats;
}
