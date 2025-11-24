/**
 * @module node-classify
 *
 * Markdown / mdast classification utilities and a remark plugin for attaching
 * structured "classes" to nodes based on selectors, frontmatter, or arbitrary
 * logic.
 *
 * # Overview
 *
 * This module provides:
 *
 * - A lightweight "class map" type (`NodeClassMap`) attached to mdast nodes.
 * - A remark plugin (`nodeClassifier`) that:
 *   - Runs mdastql selectors against the tree.
 *   - Applies user-defined classification rules.
 *   - Optionally builds a catalog of classifications.
 * - Helpers to:
 *   - Build static classifier lists (`staticClassifiers`).
 *   - Materialize a catalog onto `root.data` (`catalogToRootData`).
 *
 * The core idea is to treat Markdown documents as "classifiable" content:
 * headings, paragraphs, code blocks, etc. can be tagged with roles, kinds,
 * tags, or any other classification key/value you need. Once attached, those
 * classes can be used downstream for:
 *
 * - Test/documentation structures (projects, suites, plans, cases, steps).
 * - Automated navigation, TOCs, and document outlines.
 * - Extraction of specific sections (e.g., "test-strategy" sections).
 * - Cross-document catalogs of important nodes.
 * - Code generation / orchestration based on annotated headings or blocks.
 */

import type { Node, Root, RootContent } from "types/mdast";
import type { Plugin } from "unified";

import { selectAll } from "unist-util-select";
import { DataSupplierNode, nodeDataFactory } from "../../mdast/safe-data.ts";

/** mdast node we classify (content nodes only for now). */
export type RootNode = RootContent;

export type ClassificationNamespace = string;
export type ClassificationPath = string;

export type Classification<Baggage extends Record<string, unknown>> = {
  readonly path: ClassificationPath;
  readonly baggage?: Baggage;
};

/**
 * Per-node class map: namespace → list of classifications.
 */
export type NodeClassMap<Baggage extends Record<string, unknown>> = Record<
  ClassificationNamespace,
  Classification<Baggage>[]
>;

export const NODECLASS_KEY = "class" as const;
export type NodeClassKey = typeof NODECLASS_KEY;
export const nodeClassNDF = nodeDataFactory<
  NodeClassKey,
  NodeClassMap<Record<string, unknown>>
>(NODECLASS_KEY);

export type WithClassNode<
  N extends Node,
  Baggage extends Record<string, unknown>,
> = DataSupplierNode<
  N,
  NodeClassKey,
  NodeClassMap<Baggage>
>;

export type ClassifierCatalog = Record<
  ClassificationNamespace,
  Record<ClassificationPath, Node[]>
>;

/**
 * Single classification entry.
 *
 * `path` can be a single path or a list of paths in the same namespace.
 */
export interface ClassificationEntry<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly namespace: ClassificationNamespace;
  readonly path: ClassificationPath | ClassificationPath[];
  readonly baggage?: Baggage;
}

/**
 * Single classifier rule.
 */
export interface NodeClassifierRule {
  readonly nodes: readonly string[] | ((root: Root) => Iterable<Node>);
  readonly classify: (
    found: readonly Node[],
  ) =>
    | false
    | ClassificationEntry
    | Iterator<ClassificationEntry>;
}

/**
 * Options for the nodeClassifier plugin.
 */
export interface NodeClassifierOptions {
  /**
   * Classifiers can be:
   *   - A single function:      (root: Root) => Iterable<NodeClassifierRule>
   *   - An iterable of functions, e.g.:
   *         [
   *           (root) => [...],
   *           (root) => generator()
   *         ]
   */
  readonly classifiers:
    | ((root: Root) => Iterable<NodeClassifierRule>)
    | Iterable<(root: Root) => Iterable<NodeClassifierRule>>;

  readonly catalog?: <CC extends ClassifierCatalog>(
    catalog: CC,
    root: Root,
  ) => void;
}

export function staticClassifiers(
  ...rules: NodeClassifierRule[]
): (root: Root) => Iterable<NodeClassifierRule> {
  return (_root: Root) => rules;
}

export function catalogToRootData(
  fieldName = "classifierCatalog",
): (catalog: ClassifierCatalog, root: Root) => void {
  return (catalog, root) => {
    const anyRoot = root as Root & { data?: Record<string, unknown> };
    if (!anyRoot.data) {
      anyRoot.data = {};
    }
    (anyRoot.data as Record<string, unknown>)[fieldName] = catalog;
  };
}

/**
 * Idempotent helper: upsert a single (path, baggage) into a namespace’s list.
 * If a classification with the same path exists, it is replaced (last wins).
 */
function upsertClassification<Baggage extends Record<string, unknown>>(
  list: Classification<Baggage>[],
  path: string,
  baggage: Baggage | undefined,
): Classification<Baggage>[] {
  let replaced = false;
  const next = list.map((cls) => {
    if (cls.path !== path) return cls;
    replaced = true;
    return baggage
      ? { path, baggage } as Classification<Baggage>
      : { path } as Classification<Baggage>;
  });

  if (!replaced) {
    next.push(
      baggage
        ? { path, baggage } as Classification<Baggage>
        : { path } as Classification<Baggage>,
    );
  }

  return next;
}

/**
 * Manually classify one or more nodes with one or more classification entries.
 *
 * - `nodes` can be a single node or an array of nodes.
 * - `classifiers` can be:
 *     - a single `ClassificationEntry`, or
 *     - an `Iterator<ClassificationEntry>` yielding multiple entries.
 *
 * Idempotent semantics:
 *   - For each node, within a given `namespace`, a given `path` appears
 *     at most once.
 *   - Re-applying the same namespace/path overwrites the existing
 *     classification for that path (including its baggage).
 */
export function classifyNode<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  nodes: RootNode | RootNode[],
  classifiers:
    | ClassificationEntry<Baggage>
    | Iterator<ClassificationEntry<Baggage>>,
): void {
  const targets: RootNode[] = Array.isArray(nodes) ? nodes : [nodes];

  // Normalize classifiers into a concrete array so we can re-use them.
  const entries: ClassificationEntry<Baggage>[] = [];

  const isSingleEntry = (
    c:
      | ClassificationEntry<Baggage>
      | Iterator<ClassificationEntry<Baggage>>,
  ): c is ClassificationEntry<Baggage> =>
    "namespace" in (c as ClassificationEntry<Baggage>) &&
    "path" in (c as ClassificationEntry<Baggage>);

  if (isSingleEntry(classifiers)) {
    entries.push(classifiers);
  } else {
    let step = classifiers.next();
    while (!step.done) {
      entries.push(step.value);
      step = classifiers.next();
    }
  }

  if (entries.length === 0) return;

  for (const node of targets) {
    const anyNode = node as RootContent & {
      data?:
        | (RootContent["data"] & {
          class?: NodeClassMap<Baggage>;
        })
        | undefined;
    };

    if (!anyNode.data) {
      anyNode.data = {} as RootContent["data"];
    }

    const data = anyNode.data as RootContent["data"] & {
      class?: NodeClassMap<Baggage>;
    };

    if (!data.class || typeof data.class !== "object") {
      data.class = {} as NodeClassMap<Baggage>;
    }

    const classMap = data.class as NodeClassMap<Baggage>;

    for (const entry of entries) {
      const { namespace, path, baggage } = entry;
      const paths = Array.isArray(path) ? path : [path];

      let list = classMap[namespace] ?? [];
      for (const p of paths) {
        list = upsertClassification(list, p, baggage);
      }
      classMap[namespace] = list;
    }
  }
}

/**
 * remark plugin: classify nodes based on either:
 *   - unist-util-select selector strings (NodeClassifierRule.nodes as string[]), or
 *   - a function that directly returns nodes to classify.
 *
 * It delegates the per-node mutation semantics to `classifyNode` so that
 * plugin usage and manual usage behave identically.
 */
export const nodeClassifier: Plugin<[NodeClassifierOptions], Root> = (
  options,
) => {
  const { classifiers, catalog: catalogCallback } = options;

  return (root: Root) => {
    // Normalize classifiers into an array of functions
    const classifierFns: Array<(root: Root) => Iterable<NodeClassifierRule>> =
      typeof classifiers === "function"
        ? [classifiers]
        : Array.from(classifiers);

    // Expand all functions → rules
    const rules: NodeClassifierRule[] = [];
    for (const fn of classifierFns) {
      const produced = fn(root);
      for (const rule of produced) {
        rules.push(rule);
      }
    }

    const catalog: ClassifierCatalog | undefined = catalogCallback
      ? {}
      : undefined;

    if (rules.length === 0 && !catalog) return;

    const isSingleEntry = (
      r: ClassificationEntry | Iterator<ClassificationEntry>,
    ): r is ClassificationEntry =>
      "namespace" in (r as ClassificationEntry) &&
      "path" in (r as ClassificationEntry);

    const updateCatalog = (
      catalog: ClassifierCatalog,
      entries: readonly ClassificationEntry[],
      nodes: readonly Node[],
    ) => {
      for (const entry of entries) {
        const { namespace, path } = entry;
        const paths = Array.isArray(path) ? path : [path];

        for (const p of paths) {
          const byNs = catalog[namespace] ?? (catalog[namespace] = {});
          const bucket = byNs[p] ?? (byNs[p] = []);
          for (const node of nodes) {
            if (!bucket.includes(node)) {
              bucket.push(node);
            }
          }
        }
      }
    };

    const runRuleOnNodes = (
      foundNodes: readonly Node[],
      classify: NodeClassifierRule["classify"],
    ) => {
      if (!foundNodes.length) return;

      const result = classify(foundNodes);
      if (!result) return;

      const entries: ClassificationEntry[] = [];

      if (
        isSingleEntry(
          result as ClassificationEntry | Iterator<ClassificationEntry>,
        )
      ) {
        entries.push(result as ClassificationEntry);
      } else {
        let step = (result as Iterator<ClassificationEntry>).next();
        while (!step.done) {
          entries.push(step.value);
          step = (result as Iterator<ClassificationEntry>).next();
        }
      }

      if (!entries.length) return;

      // Apply to nodes via shared helper.
      classifyNode(
        foundNodes as RootNode[],
        (function* () {
          yield* entries;
        })(),
      );

      // Update catalog if enabled.
      if (catalog) {
        updateCatalog(catalog, entries, foundNodes);
      }
    };

    for (const rule of rules) {
      const { nodes, classify } = rule;

      // Case 1: nodes is an array of mdastql selector strings.
      if (Array.isArray(nodes)) {
        if (nodes.length === 0) continue;

        for (const selectorText of nodes) {
          const selectorNodes = selectAll(selectorText, root);
          if (!selectorNodes.length) continue;

          runRuleOnNodes(selectorNodes, classify);
        }

        continue;
      }

      // Case 2: nodes is a function returning Iterable<RootContent>.
      if (typeof nodes === "function") {
        const iterable = nodes(root);
        const foundNodes = Array.from(iterable);
        if (!foundNodes.length) continue;

        runRuleOnNodes(foundNodes, classify);
        continue;
      }
    }

    // After all classification, invoke catalog callback if any.
    if (catalog && catalogCallback) {
      catalogCallback(catalog, root);
    }
  };
};

export default nodeClassifier;
