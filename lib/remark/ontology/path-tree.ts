// path-tree.ts
//
// Minimal combined ontology tree builder.
//
// - Input: one or more mdast Root nodes that have already been
//   enriched by the documentSchema + node-classify + node-identities plugins.
// - Output: a simple in-memory tree where:
//     * Section nodes are folders (physical schema)
//     * (Optionally) Classification nodes are child folders under sections
//     * Content nodes are mdast nodes that belong at that level
//
// This deliberately ignores the older, more generic `universal/path-tree.ts`
// and the heavier `orchestrate.ts` APIs.

import type { Root, RootContent } from "types/mdast";
import type { Data, Node } from "types/unist";

import {
  collectSectionsFromRoot,
  hasBelongsToSection,
  hasSectionSchema,
  type SectionSchema,
} from "../plugin/doc/doc-schema.ts";

import {
  type Classification,
  type ClassificationNamespace,
  type ClassificationPath,
  type NodeClassMap,
  nodeClassNDF,
  type RootNode,
} from "../plugin/node/node-classify.ts";

import { hasNodeIdentities } from "../plugin/node/node-identities.ts";

/* -------------------------------------------------------------------------- */
/* Tree node types                                                            */
/* -------------------------------------------------------------------------- */

export type CombinedTreeNode =
  | SectionTreeNode
  | ClassificationTreeNode
  | ContentTreeNode;

export interface SectionTreeNode {
  readonly kind: "section";
  readonly label: string;
  readonly section: SectionSchema;
  readonly children: CombinedTreeNode[];
  readonly identityText?: string;
  readonly classText?: string;
}

export interface ClassificationTreeNode {
  readonly kind: "classification";
  readonly label: string;
  readonly namespace: ClassificationNamespace;
  /** Path WITHOUT namespace, e.g. "case", "plan/foo". */
  readonly path: ClassificationPath;
  readonly children: CombinedTreeNode[];
  readonly identityText?: string;
  readonly classText?: string; // "ns:path"
  readonly isNamespaceRoot?: boolean;
}

export interface ContentTreeNode {
  readonly kind: "content";
  readonly label: string;
  readonly node: RootContent;
  readonly identityText?: string;
  readonly classText?: string;
}

/**
 * Top-level tree for a single mdast Root.
 */
export interface DocumentTree {
  readonly root: Root;
  readonly sections: SectionTreeNode[];
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function slugLabel(raw: string): string {
  return raw.replace(/[-_]+/g, " ").trim() || raw;
}

function nodeText(n: Node): string {
  const out: string[] = [];
  // deno-lint-ignore no-explicit-any
  const walk = (x: any) => {
    if (!x) return;
    if (typeof x.value === "string") out.push(x.value);
    if (Array.isArray(x.children)) {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Flatten node.data.identities → "supplier:id1,id2 | other:foo"
 */
// deno-lint-ignore no-explicit-any
function identitiesText(n: any): string | undefined {
  if (!n || !hasNodeIdentities(n)) return undefined;
  const ids = n.data.identities;
  const parts: string[] = [];
  for (const [supplier, values] of Object.entries(ids)) {
    if (!values || !values.length) continue;
    parts.push(`${supplier}:${(values as string[]).join(",")}`);
  }
  return parts.length ? parts.join(" | ") : undefined;
}

/**
 * Flatten node classifications → "ns:path | ns2:path2"
 */
// deno-lint-ignore no-explicit-any
function classTextFromNode(n: any): string | undefined {
  if (!n || !nodeClassNDF.is(n as RootNode)) return undefined;
  const classMap = nodeClassNDF.get(n as RootNode) as
    | NodeClassMap<Record<string, unknown>>
    | undefined;
  if (!classMap) return undefined;

  const parts: string[] = [];
  for (const [ns, clsList] of Object.entries(classMap)) {
    for (const cls of clsList) {
      parts.push(`${ns}:${cls.path}`);
    }
  }
  return parts.length ? parts.join(" | ") : undefined;
}

function summarizeContent(node: RootContent): string {
  if (node.type === "heading") {
    return nodeText(node) || "(heading)";
  }
  if (node.type === "paragraph") {
    const txt = nodeText(node);
    return txt ? (txt.length > 60 ? `${txt.slice(0, 59)}…` : txt) : "paragraph";
  }
  if (node.type === "code") {
    const lang = (node as { lang?: string }).lang;
    return lang ? `${lang} code` : "code block";
  }
  const txt = nodeText(node);
  if (txt) return txt.length > 60 ? `${txt.slice(0, 59)}…` : txt;
  return node.type;
}

/**
 * Return all SectionSchema objects this node belongs to (can be 0+).
 */
function sectionsForNode(
  node: RootContent,
  filter?: (ns: string) => boolean,
): SectionSchema[] {
  const result: SectionSchema[] = [];
  if (!node.data) return result;

  if (hasBelongsToSection(node)) {
    const belongs = (node.data as Data & {
      belongsToSection: Record<string, SectionSchema>;
    }).belongsToSection;
    for (const s of Object.values(belongs)) {
      if (!filter || filter(s.namespace)) result.push(s);
    }
  } else if (hasSectionSchema(node)) {
    const cat = (node.data as Data & {
      sectionSchema: Record<string, SectionSchema>;
    }).sectionSchema;
    for (const s of Object.values(cat)) {
      if (!filter || filter(s.namespace)) result.push(s);
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Core builder                                                               */
/* -------------------------------------------------------------------------- */

export interface BuildCombinedTreeOptions {
  /**
   * Optional filter on physical section namespaces (e.g. "prime").
   * If omitted, all namespaces are included.
   */
  readonly sectionNamespaceFilter?: (ns: string) => boolean;

  /**
   * Optional filter on classification namespaces (e.g. "role", "tags").
   * If omitted, all namespaces are included.
   */
  readonly classificationNamespaceFilter?: (
    ns: ClassificationNamespace,
  ) => boolean;

  /**
   * Whether to materialize classifications as virtual folder nodes
   * under each section. Defaults to true.
   */
  readonly includeClassificationFolders?: boolean;

  /**
   * Optional callback to customize labels for classification folders.
   * If it returns undefined, a default slugified label is used.
   */
  readonly classificationLabel?: (args: {
    readonly namespace: ClassificationNamespace;
    /** Path WITHOUT namespace, e.g. "", "plan", "case/foo". */
    readonly path: ClassificationPath;
    /** Path split on "/", empty array when path is "". */
    readonly segments: readonly string[];
    readonly isNamespaceRoot: boolean;
    readonly section: SectionSchema;
    readonly root: Root;
  }) => string | undefined;
}

function sectionLabelMeta(s: SectionSchema): {
  label: string;
  identityText?: string;
  classText?: string;
} {
  // deno-lint-ignore no-explicit-any
  const anyS = s as any;

  if (s.nature === "heading" && anyS.heading) {
    const headingNode = anyS.heading;
    const txt = nodeText(headingNode);
    return {
      label: txt || "(untitled section)",
      identityText: identitiesText(headingNode),
      classText: classTextFromNode(headingNode),
    };
  }

  if (s.nature === "marker") {
    const markerNode = anyS.markerNode ??
      anyS.marker ??
      anyS.anchor ??
      anyS.node ??
      anyS.heading ??
      null;

    if (markerNode) {
      const txt = nodeText(markerNode) || "(marker section)";
      return {
        label: txt,
        identityText: identitiesText(markerNode),
        classText: classTextFromNode(markerNode),
      };
    }

    if (typeof anyS.label === "string" && anyS.label.trim()) {
      return {
        label: anyS.label.trim(),
        identityText: undefined,
        classText: undefined,
      };
    }

    return {
      label: "(marker section)",
      identityText: undefined,
      classText: undefined,
    };
  }

  return {
    label: "(marker section)",
    identityText: undefined,
    classText: undefined,
  };
}

/**
 * Build a combined tree for a SINGLE mdast Root.
 */
export function buildDocumentTree(
  root: Root,
  options: BuildCombinedTreeOptions = {},
): DocumentTree {
  const {
    sectionNamespaceFilter,
    classificationNamespaceFilter,
    includeClassificationFolders = true,
    classificationLabel,
  } = options;

  // 1. Build SectionTreeNodes & parent/child relationships.
  const sections = collectSectionsFromRoot(root).filter((s) =>
    sectionNamespaceFilter ? sectionNamespaceFilter(s.namespace) : true
  );

  const sectionNodeBySchema = new Map<SectionSchema, SectionTreeNode>();

  for (const s of sections) {
    const meta = sectionLabelMeta(s);
    sectionNodeBySchema.set(s, {
      kind: "section",
      label: meta.label,
      section: s,
      children: [],
      identityText: meta.identityText,
      classText: meta.classText,
    });
  }

  const sectionRoots: SectionTreeNode[] = [];
  for (const s of sections) {
    const node = sectionNodeBySchema.get(s)!;
    if (s.parent) {
      const parentNode = sectionNodeBySchema.get(s.parent);
      if (parentNode) parentNode.children.push(node);
      else sectionRoots.push(node);
    } else {
      sectionRoots.push(node);
    }
  }

  // 2. Per-section classification subtree indexes.
  const classIndexBySection = new Map<
    SectionSchema,
    Map<string, ClassificationTreeNode>
  >();

  const getSectionClassIndex = (
    s: SectionSchema,
  ): Map<string, ClassificationTreeNode> => {
    let idx = classIndexBySection.get(s);
    if (!idx) {
      idx = new Map();
      classIndexBySection.set(s, idx);
    }
    return idx;
  };

  const getOrCreateClassificationNode = (
    section: SectionSchema,
    sectionNode: SectionTreeNode,
    namespace: ClassificationNamespace,
    rawPath: ClassificationPath,
  ): ClassificationTreeNode => {
    const idx = getSectionClassIndex(section);
    const segments = rawPath.split("/").filter(Boolean);

    const mkKey = (p: string) => `${namespace}:${p}`;

    // Namespace root node (no path)
    const nsKey = mkKey("");
    let nsNode = idx.get(nsKey);
    if (!nsNode) {
      const label = classificationLabel?.({
        namespace,
        path: "" as ClassificationPath,
        segments: [],
        isNamespaceRoot: true,
        section,
        root,
      }) ?? slugLabel(namespace);

      nsNode = {
        kind: "classification",
        label,
        namespace,
        path: "" as ClassificationPath,
        children: [],
        identityText: undefined,
        classText: undefined,
        isNamespaceRoot: true,
      };
      idx.set(nsKey, nsNode);
      sectionNode.children.push(nsNode);
    }

    let currentParent: SectionTreeNode | ClassificationTreeNode = nsNode;
    let currentPath = "";

    // Each segment adds to currentPath; path is WITHOUT namespace.
    for (const seg of segments) {
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;
      const key = mkKey(currentPath);
      let segNode = idx.get(key);
      if (!segNode) {
        const segLabel = classificationLabel?.({
          namespace,
          path: currentPath as ClassificationPath,
          segments: currentPath.split("/"),
          isNamespaceRoot: false,
          section,
          root,
        }) ?? slugLabel(seg);

        segNode = {
          kind: "classification",
          label: segLabel,
          namespace,
          path: currentPath as ClassificationPath,
          children: [],
          identityText: undefined,
          classText: `${namespace}:${currentPath}`,
          isNamespaceRoot: false,
        };
        idx.set(key, segNode);
        currentParent.children.push(segNode);
      }
      currentParent = segNode;
    }

    return currentParent as ClassificationTreeNode;
  };

  // 3. Walk all mdast nodes, attaching "content" nodes.
  const stack: RootContent[] = (root.children as RootContent[]) ?? [];
  while (stack.length) {
    const node = stack.pop() as RootContent;

    const children = (node as { children?: RootContent[] }).children;
    if (children && children.length) {
      stack.push(...children);
    }

    const owningSections = sectionsForNode(node, sectionNamespaceFilter);
    if (!owningSections.length) continue;

    const isHeading = node.type === "heading";
    const isSectionDef = hasSectionSchema(node);

    const nodeClassText = classTextFromNode(node);
    const nodeIdentText = identitiesText(node);

    let attachedViaClassification = false;

    // 3a. Attach into classification folders (if enabled)
    if (
      includeClassificationFolders &&
      nodeClassNDF.is(node as unknown as RootNode)
    ) {
      const classMap = nodeClassNDF.get(node as unknown as RootNode) as
        | NodeClassMap<Record<string, unknown>>
        | undefined;

      if (classMap) {
        for (const [ns, clsList] of Object.entries(classMap)) {
          const namespace = ns as ClassificationNamespace;
          if (
            classificationNamespaceFilter &&
            !classificationNamespaceFilter(namespace)
          ) {
            continue;
          }

          for (
            const cls of clsList as Classification<
              Record<string, unknown>
            >[]
          ) {
            for (const sec of owningSections) {
              const secNode = sectionNodeBySchema.get(sec);
              if (!secNode) continue;

              const classNode = getOrCreateClassificationNode(
                sec,
                secNode,
                namespace,
                cls.path,
              );

              classNode.children.push({
                kind: "content",
                label: summarizeContent(node),
                node,
                identityText: nodeIdentText,
                classText: nodeClassText,
              });
              attachedViaClassification = true;
            }
          }
        }
      }
    }

    // 3b. Fallback: unclassified nodes attach directly to sections.
    // We intentionally avoid adding headings (section-def nodes) here
    // so they don't show up twice (once as folders, once as content).
    if (!attachedViaClassification && !isHeading && !isSectionDef) {
      for (const sec of owningSections) {
        const secNode = sectionNodeBySchema.get(sec);
        if (!secNode) continue;
        secNode.children.push({
          kind: "content",
          label: summarizeContent(node),
          node,
          identityText: nodeIdentText,
          classText: nodeClassText,
        });
      }
    }
  }

  return { root, sections: sectionRoots };
}

/**
 * Build document trees for multiple mdast roots.
 */
export function buildCombinedTrees(
  roots: readonly Root[],
  options: BuildCombinedTreeOptions = {},
): DocumentTree[] {
  return roots.map((r) => buildDocumentTree(r, options));
}
