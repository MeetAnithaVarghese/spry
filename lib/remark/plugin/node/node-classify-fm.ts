/**
 * @module node-classify-fm
 *
 * Markdown / mdast classification helpers for node-classify remark plugin for
 * attaching structured "classes" to nodes based on frontmatter.
 */
import type { Heading, Root, RootContent } from "types/mdast";

import { assert } from "@std/assert";
import { visit } from "unist-util-visit";

import { docFrontmatterNDF } from "../doc/doc-frontmatter.ts";
import { isHeadingWithFrontmatter } from "./heading-frontmatter.ts";
import { ClassificationEntry, NodeClassifierRule } from "./node-classify.ts";

type Dict = Record<string, unknown>;

function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build classification entries from a single frontmatter entry object.
 *
 * Supported value shapes for each "namespace" key (e.g. `role`, `tag`):
 *
 *   role: project
 *   role: [project, test-plan]
 *
 *   role:
 *     path: project
 *     baggage:
 *       id: proj-123
 *
 *   role:
 *     - path: project
 *       baggage: { id: proj-123 }
 *     - path: test-plan
 *     - another               # just a string path
 *
 * The old string / string[] forms remain supported. Object forms enable
 * optional `baggage` per classification path.
 */
function classificationEntriesFromEntry<
  Baggage extends Dict,
>(e: Dict): ClassificationEntry<Baggage>[] {
  const entries: ClassificationEntry<Baggage>[] = [];

  const collectForNamespace = (namespace: string, raw: unknown) => {
    if (raw == null) return;

    // 1) Simple string → single path, no baggage.
    if (typeof raw === "string") {
      entries.push({ namespace, path: raw });
      return;
    }

    // 2) Array → mixture of strings and objects.
    if (Array.isArray(raw)) {
      const stringPaths: string[] = [];
      const objectItems: Dict[] = [];

      for (const item of raw) {
        if (typeof item === "string") {
          stringPaths.push(item);
        } else if (isPlainObject(item)) {
          objectItems.push(item);
        }
      }

      if (stringPaths.length) {
        entries.push({ namespace, path: stringPaths });
      }

      for (const obj of objectItems) {
        const pathVal = obj.path;
        if (typeof pathVal !== "string") continue;

        const baggageRaw = obj.baggage;
        if (baggageRaw === undefined) {
          entries.push({ namespace, path: pathVal });
        } else {
          entries.push({
            namespace,
            path: pathVal,
            baggage: baggageRaw as Baggage,
          });
        }
      }

      return;
    }

    // 3) Single object { path, baggage? }.
    if (isPlainObject(raw)) {
      const pathVal = raw.path;
      if (typeof pathVal !== "string") return;

      const baggageRaw = raw.baggage;
      if (baggageRaw === undefined) {
        entries.push({ namespace, path: pathVal });
      } else {
        entries.push({
          namespace,
          path: pathVal,
          baggage: baggageRaw as Baggage,
        });
      }

      return;
    }

    // Other shapes are ignored.
  };

  // Nested `class: { ... }` block.
  const classObj = (e as Dict).class;
  if (isPlainObject(classObj)) {
    for (const [key, value] of Object.entries(classObj)) {
      collectForNamespace(key, value);
    }
  }

  // Shorthand keys on the entry itself (except reserved ones).
  for (const [key, value] of Object.entries(e)) {
    if (key === "select" || key === "class") continue;
    collectForNamespace(key, value);
  }

  return entries;
}

/**
 * Helper: build classifiers from document frontmatter and per-heading
 * frontmatter.
 */
export function classifiersFromFrontmatter<
  Baggage extends Dict = Dict,
>(options?: {
  readonly classifiersFromDocFM?: (fm: Dict) => Array<unknown>;
  readonly classifiersFromHeadFM?: (
    fm: Dict,
    node: Heading,
  ) => Array<unknown>;
}): (root: Root) => Iterable<NodeClassifierRule> {
  const {
    classifiersFromDocFM = (fm: Dict) => fm["doc-classify"],
    classifiersFromHeadFM = (fm: Dict) => fm["nature"] ?? fm["doc-classify"],
  } = options ?? {};

  return (root: Root): Iterable<NodeClassifierRule> => {
    if (!docFrontmatterNDF.is(root)) return [];

    const fm = root.data.documentFrontmatter.parsed.fm as Dict;
    const rules: NodeClassifierRule[] = [];

    // ---------------------------------------------------------------------
    // 1) DOCUMENT-LEVEL CLASSIFIERS
    // ---------------------------------------------------------------------
    const rawDoc = classifiersFromDocFM(fm);
    if (Array.isArray(rawDoc)) {
      for (const entry of rawDoc) {
        if (!isPlainObject(entry)) continue;

        const selectRaw = (entry as Dict).select;

        let selectors: string[];
        if (typeof selectRaw === "string") {
          selectors = [selectRaw];
        } else if (
          Array.isArray(selectRaw) &&
          selectRaw.every((s) => typeof s === "string")
        ) {
          selectors = [...selectRaw] as string[];
        } else {
          continue;
        }

        const classEntries = classificationEntriesFromEntry<Baggage>(entry);
        if (!classEntries.length) continue;

        const classify: NodeClassifierRule["classify"] = (found) => {
          if (!found.length) return false;
          if (classEntries.length === 1) return classEntries[0]!;
          return classEntries.values();
        };

        rules.push({
          nodes: selectors,
          classify,
        });
      }
    }

    // ---------------------------------------------------------------------
    // 2) HEADING-LEVEL CLASSIFIERS
    // ---------------------------------------------------------------------
    if (classifiersFromHeadFM) {
      visit(root, "heading", (node) => {
        if (!isHeadingWithFrontmatter(node)) return;

        let rawHeadRules = classifiersFromHeadFM(node.data.headingFM, node);

        if (!Array.isArray(rawHeadRules) && !isPlainObject(rawHeadRules)) {
          return;
        }
        if (isPlainObject(rawHeadRules)) rawHeadRules = [rawHeadRules];
        assert(Array.isArray(rawHeadRules));

        for (const rule of rawHeadRules) {
          if (!isPlainObject(rule)) continue;

          const classEntries = classificationEntriesFromEntry<Baggage>(rule);
          if (!classEntries.length) continue;

          const classify: NodeClassifierRule["classify"] = (found) => {
            if (!found.length) return false;
            if (classEntries.length === 1) return classEntries[0]!;
            return classEntries.values();
          };

          rules.push({
            nodes: (_root: Root) => [node as unknown as RootContent],
            classify,
          });
        }
      });
    }

    return rules;
  };
}
