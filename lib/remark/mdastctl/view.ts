/**
 * Shared view-model builders + helpers for mdast trees.
 *
 * - Node traversal & selection (mdastql-based)
 * - Presentation-oriented helpers (summaries, classes)
 * - Unified tree rows for physical/class/schema views
 * - Unified tabular rows for physical "ls" style views
 */

import { basename } from "@std/path";
import type { Heading, Node, Root, RootContent } from "types/mdast";
import {
  collectSectionsFromRoot,
  hasBelongsToSection,
} from "../plugin/doc/doc-schema.ts";
import {
  hasNodeClass,
  type NodeClassMap,
} from "../plugin/node/node-classify.ts";
import { hasNodeIdentities } from "../plugin/node/node-identities.ts";
import { markdownASTs, Yielded } from "./io.ts";

import { selectAll } from "unist-util-select";

// deno-lint-ignore no-explicit-any
type Any = any;

export type MdAstTreeView = "physical" | "class" | "schema";

/**
 * Different strategies for tabular (row-oriented) views.
 *
 * For now:
 *  - "physical"    = depth-first listing of nodes with headingPath, etc.
 *  - "identifiers" = one row per node-identity pair
 */
export type MdAstTabularView = "physical" | "identifiers";

/**
 * Parsed markdown tree with enough metadata for building views.
 *
 * Instances are constructed in `mdast-io.ts` and consumed here
 * by the view builders, and by CLI / web front-ends.
 */
export interface ViewableMarkdownAST {
  readonly provenance: string; // what the user supplied
  readonly root: Root;
  readonly source: string;
  readonly fileRef: (node?: RootContent) => string;
  readonly rootId: string;
  readonly label: string;
  readonly origin: Yielded<Awaited<ReturnType<typeof markdownASTs>>>["origin"];
  readonly mdText: Yielded<Awaited<ReturnType<typeof markdownASTs>>>["mdText"];
}

export async function* viewableMarkdownASTs(
  src: Parameters<typeof markdownASTs>[0],
  options?: Parameters<typeof markdownASTs>[1],
) {
  for await (const md of markdownASTs(src, options)) {
    yield {
      provenance: typeof md.origin.provenance === "string"
        ? md.origin.provenance
        : md.origin.provenance.path,
      root: md.mdastRoot,
      source: md.text,
      fileRef: md.origin.nature === "remote-url"
        ? (() => basename(md.origin.label))
        : ((node) => {
          const file = basename(md.origin.label);
          const line = node?.position?.start?.line;
          if (typeof line !== "number") return file;
          return `${file}:${line}`;
        }),
      rootId: `${md.origin.label}#root`,
      label: md.origin.label,
      origin: md.origin,
      mdText: md.mdText,
    } satisfies ViewableMarkdownAST;
  }
}

export interface TreeRow {
  readonly id: string;
  readonly file: string;
  readonly kind: "heading" | "content";
  readonly label: string;
  readonly type:
    | RootContent["type"]
    | "root"
    | "class-key"
    | "class-value";
  readonly parentId?: string;
  readonly classInfo?: string;
  readonly dataKeys?: string;
  readonly identityInfo?: string;

  /** Which logical view this row belongs to. */
  readonly view?: MdAstTreeView;

  /**
   * For schema view, the nesting level of the section:
   *  - 0 for top-level sections
   *  - 1 for their children, etc.
   */
  readonly schemaLevel?: number;
}

/**
 * Generic tabular row used by `ls`-style views.
 */
export interface TabularRow {
  readonly id: number;
  readonly file: string;
  readonly type: RootContent["type"];
  readonly node: Node;
  readonly depth: number;
  readonly headingPath: string;
  readonly name: string;
  readonly classInfo?: string;
  readonly dataKeys?: string;

  /**
   * For the "identifiers" view:
   *  - supplier → identity supplier name (SUPPLIER)
   *  - identity → identity string (ID)
   */
  readonly supplier?: string;
  readonly identity?: string;
}

export interface BuildMdAstTabularRowsOptions {
  readonly includeDataKeys?: boolean;
  readonly query?: string;
}

// ---------------------------------------------------------------------------
// Node traversal & selection
// ---------------------------------------------------------------------------

export function isParent(
  node: Root | RootContent,
): node is
  | Root & { children: RootContent[] }
  | (RootContent & { children: RootContent[] }) {
  return Array.isArray((node as Any).children);
}

/**
 * Depth-first walk over mdast, exposing:
 *   - node (RootContent)
 *   - parent
 *   - depth (0 for root children, 1 for their children, etc.)
 *   - index within parent.children
 */
export function walkTree(
  root: Root,
  fn: (
    node: RootContent,
    ctx: {
      parent: Root | (RootContent & { children?: RootContent[] });
      depth: number;
      index: number;
    },
  ) => void,
): void {
  const children = root.children ?? [];

  const visitChildren = (
    parent: Root | (RootContent & { children?: RootContent[] }),
    depth: number,
  ): void => {
    if (!parent.children) return;
    parent.children.forEach((child, index) => {
      fn(child, { parent, depth, index });
      if (isParent(child)) {
        visitChildren(child, depth + 1);
      }
    });
  };

  children.forEach((child, index) => {
    fn(child, { parent: root, depth: 0, index });
    if (isParent(child)) {
      visitChildren(child, 1);
    }
  });
}

/**
 * unist-util-select-backed selection helper.
 *
 * - If query is undefined → returns every node in depth-first order.
 * - If query is provided  → returns unist-util-select matches.
 */
export function selectNodes(
  root: Root,
  query: string | undefined,
) {
  if (!query) {
    const out: RootContent[] = [];
    walkTree(root, (node) => out.push(node));
    return out;
  }
  return selectAll(query, root);
}

function markNodesContainingSelected(
  root: Root,
  selected: Set<Node>,
): WeakMap<RootContent, boolean> {
  const map = new WeakMap<RootContent, boolean>();

  const visitNode = (node: RootContent): boolean => {
    let has = selected.has(node);
    if (isParent(node)) {
      if (node.children) {
        for (const child of node.children) {
          if (visitNode(child)) has = true;
        }
      }
    }
    map.set(node, has);
    return has;
  };

  for (const child of root.children ?? []) {
    visitNode(child);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export type MdastNode = Root | RootContent;

export function nodeToPlainText(node: MdastNode): string {
  const chunks: string[] = [];

  const recur = (n: MdastNode): void => {
    if ((n as Any).value && typeof (n as Any).value === "string") {
      chunks.push((n as Any).value as string);
    }
    if (Array.isArray((n as Any).children)) {
      for (const c of (n as Any).children as RootContent[]) {
        recur(c);
      }
    }
  };

  recur(node);
  return chunks.join("").replace(/\s+/g, " ").trim();
}

export function headingText(h: Heading): string {
  const text = nodeToPlainText(h);
  return text || "(untitled)";
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function summarizeNode(node: RootContent): string {
  switch (node.type) {
    case "heading":
      return headingText(node as Heading);
    case "paragraph":
      return truncate(nodeToPlainText(node), 60);
    case "code": {
      return node.lang ? truncate(`\`${node.lang}\` code`, 60) : "code";
    }
    case "list":
      return "list";
    case "listItem":
      return truncate(nodeToPlainText(node), 60) || "list item";
    case "thematicBreak":
      return "hr";
    case "leafDirective" as Any:
      return `${(node as Any).name}:${nodeToPlainText(node)}`;
    default:
      return truncate(nodeToPlainText(node) || node.type, 60);
  }
}

export function formatNodeClasses(
  node: RootContent,
): string | undefined {
  if (!hasNodeClass(node)) return undefined;

  // We don’t care about the specific baggage shape here, just that it’s an object.
  const classMap = node.data.class as NodeClassMap<Record<string, unknown>>;

  const parts: string[] = [];

  for (const [namespace, classifications] of Object.entries(classMap)) {
    if (!Array.isArray(classifications) || classifications.length === 0) {
      continue;
    }

    const rendered: string[] = [];

    for (const cls of classifications) {
      const path = cls.path;
      const baggage = cls.baggage;

      // No baggage → just the path.
      if (!baggage || typeof baggage !== "object") {
        rendered.push(path);
        continue;
      }

      const entries = Object.entries(baggage);
      if (entries.length === 0) {
        rendered.push(path);
        continue;
      }

      // Compact baggage rendering: key=value pairs.
      const bagStr = entries
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",");

      rendered.push(`${path}{${bagStr}}`);
    }

    if (rendered.length > 0) {
      parts.push(`${namespace}:${rendered.join(",")}`);
    }
  }

  return parts.length ? parts.join(" ") : undefined;
}

export function formatNodeIdentities(
  node: RootContent,
): string | undefined {
  const data = (node as Any).data;
  if (!data || typeof data !== "object") return undefined;
  const ids = (data as Any).identities as
    | Record<string, string[] | undefined>
    | undefined;
  if (!ids || typeof ids !== "object") return undefined;

  const entries = Object.entries(ids).filter(
    ([, v]) => Array.isArray(v) && v.length > 0,
  ) as [string, string[]][];

  if (entries.length === 0) return undefined;

  const multipleSuppliers = entries.length > 1;
  const parts: string[] = [];

  for (const [supplier, list] of entries) {
    if (!Array.isArray(list) || list.length === 0) continue;
    if (multipleSuppliers) {
      for (const id of list) {
        parts.push(`${supplier}:${id}`);
      }
    } else {
      for (const id of list) {
        parts.push(id);
      }
    }
  }

  return parts.length ? parts.join(", ") : undefined;
}

// ---------------------------------------------------------------------------
// Unified tree rows
// ---------------------------------------------------------------------------

export interface BuildMdAstTreeRowsOptions {
  readonly includeDataKeys?: boolean;

  /**
   * For "physical" view:
   *   - if provided, we compute which tree nodes contain any of these.
   */
  readonly selectedNodes?: Node[];

  /**
   * For "physical" view:
   *   - if true and `selectedNodes` is provided, we prune the tree to only
   *     nodes whose subtree contains at least one selected node, plus
   *     all ancestors up to the file root.
   */
  readonly pruneToSelection?: boolean;
}

/**
 * Unified builder for tree rows.
 *
 * - "physical" → file → heading → content
 * - "class"    → file → class key → class value → node
 * - "schema"   → file → section → section children + nodes
 */
export function buildMdAstTreeRows(
  view: MdAstTreeView,
  pmt: ViewableMarkdownAST,
  opts: BuildMdAstTreeRowsOptions = {},
): TreeRow[] {
  switch (view) {
    case "physical":
      return buildPhysicalTreeRows(pmt, opts);
    case "class":
      return buildClassTreeRows(pmt, opts);
    case "schema":
      return buildSchemaTreeRows(pmt, opts);
    default:
      // exhaustive check
      throw new Error(`Unknown MdAstTreeView: ${view satisfies never}`);
  }
}

// ---------------------------------------------------------------------------
// Tabular view(s)
// ---------------------------------------------------------------------------

/**
 * Decide whether a node should appear as its own tabular row, for
 * default "physical" ls-style output.
 */
function shouldEmitNodeForTabular(
  node: RootContent,
  parent: Root | (RootContent & { children?: RootContent[] }),
  hasQuery: boolean,
): boolean {
  // If user provided --select, be literal: show whatever mdastql returned.
  if (hasQuery) return true;

  // Always skip raw text as its own row; parents already summarize it.
  if (node.type === "text") return false;

  // Paragraphs directly under list items are just wrappers for bullet text.
  if (node.type === "paragraph" && parent.type === "listItem") {
    return false;
  }

  // Inline-only wrappers are usually not helpful as standalone rows.
  if (
    node.type === "strong" ||
    node.type === "emphasis" ||
    node.type === "delete" ||
    node.type === "link" ||
    node.type === "linkReference"
  ) {
    return false;
  }

  return true;
}

/**
 * Unified builder for tabular rows.
 *
 * Currently supports:
 *  - "physical"    → depth-first listing with heading path.
 *  - "identifiers" → one row per node-identity pair.
 */
export function buildMdAstTabularRows(
  view: MdAstTabularView,
  pmt: ViewableMarkdownAST,
  opts: BuildMdAstTabularRowsOptions = {},
): TabularRow[] {
  switch (view) {
    case "physical":
      return buildPhysicalTabularRows(pmt, opts);
    case "identifiers":
      return buildIdentifierTabularRows(pmt, opts);
    default:
      throw new Error(`Unknown MdAstTabularView: ${view satisfies never}`);
  }
}

/**
 * `physical` tabular view – used by the `ls` command:
 *
 * - Every node (by default) or only mdastql-selected nodes (`--select`).
 * - Each row includes:
 *   - file
 *   - type
 *   - depth (tree depth)
 *   - headingPath (path of ancestor headings like "Intro → Examples")
 *   - name (human summary)
 *   - CLASS (flattened `data.class` as key:value pairs)
 *   - DATA (CSV of node.data keys if requested)
 */
function buildPhysicalTabularRows(
  pmt: ViewableMarkdownAST,
  opts: BuildMdAstTabularRowsOptions = {},
): TabularRow[] {
  const { root, fileRef } = pmt;
  const { includeDataKeys, query } = opts;
  const selected = selectNodes(root, query);
  const selectedSet = new Set(selected);

  const rows: TabularRow[] = [];
  let id = 1;

  // Track heading hierarchy by depth to build headingPath strings
  const headingStack: (string | undefined)[] = [];
  const hasQuery = !!query;

  walkTree(root, (node, { depth, parent }) => {
    // Maintain heading stack for *all* nodes so descendants get correct paths
    if (node.type === "heading") {
      const hd = (node.depth ?? 1) | 0;
      const label = headingText(node as Heading);
      if (hd > 0) {
        headingStack.splice(hd - 1);
        headingStack[hd - 1] = label;
      }
    }

    // Only consider nodes selected by mdastql (or all if no query).
    if (!selectedSet.has(node)) return;

    // Apply de-duplication / noise filtering for default ls.
    if (!shouldEmitNodeForTabular(node, parent, hasQuery)) return;

    const headingPath = headingStack.filter(Boolean).join(" → ");
    const name = node.type === "heading"
      ? `h${node.depth ?? "?"}: ${headingText(node as Heading)}`
      : summarizeNode(node);

    const classInfo = formatNodeClasses(node);

    const dataKeys = includeDataKeys && node.data
      ? Object.keys(node.data).join(", ")
      : undefined;

    rows.push({
      id: id++,
      file: fileRef(node),
      type: node.type,
      node,
      depth,
      headingPath,
      name,
      classInfo,
      dataKeys,
    });
  });

  return rows;
}

/**
 * `identifiers` tabular view – one row per (node, supplier, identity) tuple:
 *
 * - Only nodes with identities (`hasNodeIdentities`) are included.
 * - Each row includes:
 *   - SUPPLIER (supplier)
 *   - ID (identity)
 *   - file, type, depth, headingPath, name, classInfo, dataKeys
 */
function buildIdentifierTabularRows(
  pmt: ViewableMarkdownAST,
  opts: BuildMdAstTabularRowsOptions = {},
): TabularRow[] {
  const { root, fileRef } = pmt;
  const { includeDataKeys, query } = opts;
  const selected = selectNodes(root, query);
  const selectedSet = new Set(selected);

  const rows: TabularRow[] = [];
  let id = 1;

  const headingStack: (string | undefined)[] = [];

  walkTree(root, (node, { depth }) => {
    if (node.type === "heading") {
      const hd = (node.depth ?? 1) | 0;
      const label = headingText(node as Heading);
      if (hd > 0) {
        headingStack.splice(hd - 1);
        headingStack[hd - 1] = label;
      }
    }

    if (!selectedSet.has(node)) return;
    if (!hasNodeIdentities(node)) return;

    const headingPath = headingStack.filter(Boolean).join(" → ");
    const name = node.type === "heading"
      ? `h${node.depth ?? "?"}: ${headingText(node as Heading)}`
      : summarizeNode(node);

    const classInfo = formatNodeClasses(node);
    const dataKeys = includeDataKeys && node.data
      ? Object.keys(node.data).join(", ")
      : undefined;

    const identities = node.data.identities;
    for (const [supplier, ids] of Object.entries(identities)) {
      if (!ids) continue;
      for (const identity of ids) {
        rows.push({
          id: id++,
          file: fileRef(node),
          type: node.type,
          node,
          depth,
          headingPath,
          name,
          classInfo,
          dataKeys,
          supplier,
          identity,
        });
      }
    }
  });

  return rows;
}

// ---------------------------------------------------------------------------
// View: physical (file → headings → content)
// ---------------------------------------------------------------------------

function buildPhysicalTreeRows(
  pmt: ViewableMarkdownAST,
  opts: BuildMdAstTreeRowsOptions,
): TreeRow[] {
  const { root, fileRef, label, provenance, rootId } = pmt;
  const { includeDataKeys, selectedNodes, pruneToSelection } = opts;

  const rows: TreeRow[] = [];
  let counter = 0;

  // Selection support
  const selectedSet = selectedNodes && selectedNodes.length > 0
    ? new Set(selectedNodes)
    : undefined;
  const containsSelected = selectedSet
    ? markNodesContainingSelected(root, selectedSet)
    : undefined;

  // Synthetic file root row
  rows.push({
    id: rootId,
    file: fileRef(),
    kind: "heading",
    type: "root",
    label,
    parentId: undefined,
    classInfo: undefined,
    dataKeys: undefined,
    identityInfo: undefined,
    view: "physical",
  });

  type StackEntry = { depth: number; id: string };
  const stack: StackEntry[] = [{ depth: 0, id: rootId }];

  const children = root.children ?? [];

  // Map row.id -> underlying top-level node (or null for synthetic root)
  const rowNode = new Map<string, RootContent | null>();
  rowNode.set(rootId, null);

  for (const child of children) {
    if (child.type === "heading") {
      const hd = (child.depth ?? 1) | 0;

      while (stack.length > 1 && stack[stack.length - 1]?.depth >= hd) {
        stack.pop();
      }

      const parentId = stack[stack.length - 1]?.id;
      const id = `${provenance}#h${counter++}`;

      const dataKeys = includeDataKeys && child.data
        ? Object.keys(child.data).join(",")
        : undefined;

      const classInfo = formatNodeClasses(child);
      const identityInfo = formatNodeIdentities(child);

      rows.push({
        id,
        file: fileRef(child),
        kind: "heading",
        type: "heading",
        label: headingText(child as Heading),
        parentId,
        classInfo,
        dataKeys,
        identityInfo,
        view: "physical",
      });

      rowNode.set(id, child);
      stack.push({ depth: hd, id });
    } else {
      const parentId = stack[stack.length - 1]?.id ?? rootId;
      const id = `${provenance}#n${counter++}`;

      const dataKeys = includeDataKeys && child.data
        ? Object.keys(child.data).join(", ")
        : undefined;

      const classInfo = formatNodeClasses(child);
      const identityInfo = formatNodeIdentities(child);

      rows.push({
        id,
        file: fileRef(child),
        kind: "content",
        type: child.type,
        label: summarizeNode(child),
        parentId,
        classInfo,
        dataKeys,
        identityInfo,
        view: "physical",
      });

      rowNode.set(id, child);
    }
  }

  if (!selectedSet || !pruneToSelection) {
    return rows;
  }

  // Determine which rows are directly "hit" by selection
  const prelim = new Set<string>();
  for (const [id, node] of rowNode.entries()) {
    if (!node) continue; // synthetic root; handle later
    if (containsSelected?.get(node)) {
      prelim.add(id);
    }
  }

  if (prelim.size === 0) {
    // Nothing matched in this file; keep only synthetic root
    return rows.filter((r) => r.id === rootId);
  }

  // Close upwards over ancestors: include all parents up to the file root
  const byId = new Map<string, TreeRow>(rows.map((r) => [r.id, r]));
  const allowed = new Set<string>();
  const stackIds = [...prelim];

  while (stackIds.length) {
    const id = stackIds.pop()!;
    if (allowed.has(id)) continue;
    allowed.add(id);
    const row = byId.get(id);
    if (row?.parentId && !allowed.has(row.parentId)) {
      stackIds.push(row.parentId);
    }
  }

  // Always include the synthetic root
  allowed.add(rootId);

  return rows.filter((r) => allowed.has(r.id));
}

// ---------------------------------------------------------------------------
// View: class (file → class key → class value → nodes)
// ---------------------------------------------------------------------------

interface ClassNodeInfo {
  readonly node: RootContent;
  readonly classKey: string; // namespace
  readonly classValue: string; // path
}

function buildClassIndex(
  root: Root,
): Map<string, Map<string, ClassNodeInfo[]>> {
  const index = new Map<string, Map<string, ClassNodeInfo[]>>();

  const visit = (node: RootContent) => {
    if (!hasNodeClass(node)) return;

    const classMap = node.data.class as NodeClassMap<Record<string, unknown>>;

    for (const [namespace, classifications] of Object.entries(classMap)) {
      if (!Array.isArray(classifications) || classifications.length === 0) {
        continue;
      }

      let byValue = index.get(namespace);
      if (!byValue) {
        byValue = new Map<string, ClassNodeInfo[]>();
        index.set(namespace, byValue);
      }

      for (const cls of classifications) {
        const path = cls.path;

        let bucket = byValue.get(path);
        if (!bucket) {
          bucket = [];
          byValue.set(path, bucket);
        }

        bucket.push({
          node,
          classKey: namespace,
          classValue: path,
        });
      }
    }
  };

  const walk = (node: RootContent) => {
    visit(node);
    const children = (node as Any).children as RootContent[] | undefined;
    if (Array.isArray(children)) {
      for (const c of children) walk(c);
    }
  };

  for (const child of root.children ?? []) {
    walk(child);
  }

  return index;
}

function buildClassTreeRows(
  pmt: ViewableMarkdownAST,
  opts: BuildMdAstTreeRowsOptions,
): TreeRow[] {
  const { root, fileRef, label, provenance, rootId } = pmt;
  const { includeDataKeys } = opts;

  const index = buildClassIndex(root);
  if (index.size === 0) {
    return [];
  }

  const rows: TreeRow[] = [];
  let counter = 0;

  // Synthetic file root row
  rows.push({
    id: rootId,
    file: fileRef(),
    kind: "heading",
    type: "root",
    label,
    parentId: undefined,
    classInfo: undefined,
    dataKeys: undefined,
    identityInfo: undefined,
    view: "class",
  });

  const classKeys = Array.from(index.keys()).sort();

  for (const classKey of classKeys) {
    const byValue = index.get(classKey)!;
    const classKeyId = `${provenance}#cls:${classKey}`;

    rows.push({
      id: classKeyId,
      file: fileRef(),
      kind: "heading",
      type: "class-key",
      label: classKey,
      parentId: rootId,
      classInfo: undefined,
      dataKeys: undefined,
      identityInfo: undefined,
      view: "class",
    });

    const values = Array.from(byValue.keys()).sort();

    for (const value of values) {
      const infos = byValue.get(value)!;
      const valueId = `${provenance}#cls:${classKey}=${value}`;

      rows.push({
        id: valueId,
        file: fileRef(),
        kind: "heading",
        type: "class-value",
        label: value,
        parentId: classKeyId,
        classInfo: `${classKey}:${value}`,
        dataKeys: undefined,
        identityInfo: undefined,
        view: "class",
      });

      for (const info of infos) {
        const node = info.node;
        const nodeId = `${provenance}#cls:${classKey}=${value}#n${counter++}`;

        const dataKeysForNode = includeDataKeys && node.data
          ? Object.keys(node.data).join(", ")
          : undefined;

        const classInfoForNode = formatNodeClasses(node);
        const identityInfoForNode = formatNodeIdentities(node);

        rows.push({
          id: nodeId,
          file: fileRef(node),
          kind: "content",
          type: node.type,
          label: summarizeNode(node),
          parentId: valueId,
          classInfo: classInfoForNode,
          dataKeys: dataKeysForNode,
          identityInfo: identityInfoForNode,
          view: "class",
        });
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// View: schema (file → section → section children + nodes)
// ---------------------------------------------------------------------------

function buildSchemaTreeRows(
  pmt: ViewableMarkdownAST,
  opts: BuildMdAstTreeRowsOptions,
): TreeRow[] {
  const { root, label, fileRef, provenance, rootId } = pmt;
  const { includeDataKeys } = opts;

  const sections = collectSectionsFromRoot(root);
  const primeSections = sections.filter((s) => s.namespace === "prime");
  if (primeSections.length === 0) return [];

  const rows: TreeRow[] = [];

  // synthetic file root row
  rows.push({
    id: rootId,
    file: fileRef(),
    kind: "heading",
    type: "root",
    label,
    parentId: undefined,
    classInfo: undefined,
    dataKeys: undefined,
    identityInfo: undefined,
    view: "schema",
    schemaLevel: undefined,
  });

  const rootChildren = (root.children ?? []) as RootContent[];
  let counter = 0;
  const sectionId = new WeakMap<Any, string>();

  // collect all section start nodes so we don't also show them as plain nodes
  const sectionStartNodes = new Set<RootContent>();
  for (const s of primeSections) {
    if (s.nature === "heading" && s.heading) {
      sectionStartNodes.add(s.heading as RootContent);
    } else if (s.nature === "marker" && s.markerNode) {
      sectionStartNodes.add(s.markerNode as RootContent);
    }
  }

  const getIdForSection = (s: Any): string => {
    const existing = sectionId.get(s);
    if (existing) return existing;
    const id = `${provenance}#sec:${counter++}`;
    sectionId.set(s, id);
    return id;
  };

  const belongingNodesForSection = (s: Any) =>
    rootChildren
      .map((n, idx) => ({ n, idx }))
      .filter(({ n }) =>
        hasBelongsToSection(n) &&
        (n.data as Any).belongsToSection?.["prime"] === s &&
        !sectionStartNodes.has(n)
      )
      .sort((a, b) => a.idx - b.idx);

  const summarizeSectionLabel = (s: Any): string => {
    const base = (() => {
      if (s.nature === "heading") {
        const text = nodeToPlainText(
          (s.heading as MdastNode | undefined) ??
            (s.markerNode as MdastNode | undefined) ??
            (s.parentNode as MdastNode),
        );
        const depth = s.depth ?? "?";
        return `heading depth=${depth} "${text || ""}"`;
      }

      if (s.nature === "marker") {
        const kind = s.markerKind ?? "marker";

        const hasTitle = typeof s.title === "string" &&
          s.title.trim().length > 0;
        if (hasTitle) {
          const title = s.title.trim();
          return `marker kind=${kind} "${title}"`;
        }

        const srcNode: MdastNode = (s.markerNode as MdastNode | undefined) ??
          (s.heading as MdastNode | undefined) ??
          (s.parentNode as MdastNode);

        const rawText = srcNode ? nodeToPlainText(srcNode) : "";
        const value = truncate(
          rawText.replace(/\s+/g, " ").trim() || kind,
          40,
        );
        return `marker ${kind}=${value}`;
      }

      return String(s.nature ?? "section");
    })();

    const ns = s.namespace ?? "prime";
    const childrenCount = Array.isArray(s.children) ? s.children.length : 0;
    const range = `[${s.startIndex ?? "?"}, ${s.endIndex ?? "?"})`;

    return `${base} ns=${ns} children=${childrenCount} ${range}`;
  };

  const emitSection = (s: Any, parentId: string, level: number) => {
    const id = getIdForSection(s);
    const rawLabel = summarizeSectionLabel(s);

    const sectionNode: RootContent | undefined = s.nature === "heading"
      ? (s.heading as RootContent | undefined)
      : s.nature === "marker"
      ? (s.markerNode as RootContent | undefined)
      : undefined;

    const sectionDataKeys = includeDataKeys && sectionNode?.data
      ? Object.keys(sectionNode.data).join(", ")
      : undefined;

    const sectionClassInfo = sectionNode
      ? formatNodeClasses(sectionNode)
      : undefined;

    const sectionIdentityInfo = sectionNode
      ? formatNodeIdentities(sectionNode)
      : undefined;

    rows.push({
      id,
      file: sectionNode ? fileRef(sectionNode) : fileRef(),
      kind: "heading",
      type: "heading",
      label: rawLabel,
      parentId,
      classInfo: sectionClassInfo,
      dataKeys: sectionDataKeys,
      identityInfo: sectionIdentityInfo,
      view: "schema",
      schemaLevel: level,
    });

    const sectionChildren: Any[] = Array.isArray(s.children) ? s.children : [];
    const belonging = belongingNodesForSection(s);

    type ChildEntry =
      | { kind: "section"; section: Any; order: number }
      | { kind: "node"; node: RootContent; order: number };

    const entries: ChildEntry[] = [];

    for (const childSec of sectionChildren) {
      entries.push({
        kind: "section",
        section: childSec,
        order: childSec.startIndex ?? 0,
      });
    }

    for (const { n, idx } of belonging) {
      entries.push({
        kind: "node",
        node: n,
        order: idx,
      });
    }

    entries.sort((a, b) => a.order - b.order);

    for (const entry of entries) {
      if (entry.kind === "section") {
        emitSection(entry.section, id, level + 1);
      } else {
        const node = entry.node;
        const nodeId = `${provenance}#secnode:${counter++}`;

        const dataKeys = includeDataKeys && node.data
          ? Object.keys(node.data).join(", ")
          : undefined;
        const classInfo = formatNodeClasses(node);
        const identityInfo = formatNodeIdentities(node);

        rows.push({
          id: nodeId,
          file: fileRef(node),
          kind: "content",
          type: node.type,
          label: summarizeNode(node),
          parentId: id,
          classInfo,
          dataKeys,
          identityInfo,
          view: "schema",
          schemaLevel: level + 1,
        });
      }
    }
  };

  const roots = primeSections.filter((s) => !s.parent);
  for (const s of roots) {
    emitSection(s, rootId, 0);
  }

  return rows;
}
