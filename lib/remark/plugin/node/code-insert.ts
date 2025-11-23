/**
 * Final stage of the code-import pipeline.
 *
 * This plugin consumes the metadata produced by `resolveImportSpecs`
 * (from code-import.ts) and performs the actual transformation of the
 * Markdown document:
 *
 *   • For each spec block with `importSpecs` attached:
 *        – Generates new code nodes via `prepareCodeNodes`
 *        – Attaches provenance metadata (`generated`)
 *        – Inserts or replaces the original spec node
 *
 * The module therefore acts as the “inserter” while code-import.ts acts
 * as the “analyzer”.
 *
 * Together, they form a two-stage pipeline:
 *
 *    1. resolveImportSpecs  → detects + parses import logic
 *    2. insertCodeImportNodes → materializes + inserts new nodes
 *
 * This keeps concerns clean:
 *   - Parsing/import resolution never mutates the tree
 *   - Insertion logic is isolated and explicit
 */
import type { Code, Data, Node, Root } from "types/mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
// Adjust this import to wherever you export it:
import { flexibleNodeIssues } from "../../mdast/issue.ts";
import { DataSupplierNode, nodeDataFactory } from "../../mdast/safe-data.ts";
import {
  codeGenNDF,
  codeImportSpecsNDF,
  ImportedContentNode,
  prepareCodeNodes,
} from "./code-import.ts";

export const codeGenImportIssues = flexibleNodeIssues("issues");

export type CodeImportInserts = { readonly nodes: ImportedContentNode<Code>[] };

export const CODEINSERTS_KEY = "importInserts" as const;
export type CodeImportInsertsKey = typeof CODEINSERTS_KEY;
export const codeImportInsertsNDF = nodeDataFactory<
  CodeImportInsertsKey,
  CodeImportInserts
>(CODEINSERTS_KEY);

export type CodeImportInsertsNode<N extends Node = Code & { data: Data }> =
  DataSupplierNode<N, CodeImportInsertsKey, CodeImportInserts>;

export interface CodeImportInsertOptions {
  readonly retainAfterInjections?: (code: Code) => boolean;
  readonly readLocalFsTextIntoValue?: (code: Code) => boolean;
}

/**
 * remark plugin that *inserts* generated code nodes for each import-spec block.
 *
 * Workflow:
 *   1. locate every `code` node that has `importSpecs` (added by resolveImportSpecs)
 *   2. run `prepareCodeNodes()` to create imported `code` nodes
 *   3. attach provenance to generated nodes via `codeGenNDF`
 *   4. attach summary insert metadata (`importInserts`)
 *   5. mutate the AST:
 *        • if retainAfterInjections(node) is true → keep original block
 *          and insert generated nodes immediately after it
 *        • else → replace the original block entirely with the generated nodes
 *
 * The plugin batches mutations and applies them bottom-up to avoid
 * index shifting during traversal.
 *
 * @param options Optional configuration:
 *   - retainAfterInjections: decides whether the original spec block is kept
 *   - readLocalFsTextIntoValue: determines if local files are read into node.value
 *
 * @returns A unified-compatible transformer that mutates the MDAST.
 */
export const insertCodeImportNodes: Plugin<[CodeImportInsertOptions?], Root> = (
  options,
) => {
  return (tree: Root) => {
    const {
      readLocalFsTextIntoValue = () => true,
      retainAfterInjections = () => true,
    } = options ?? {};

    const mutations: {
      // deno-lint-ignore no-explicit-any
      parent: any;
      index: number;
      injected: Code[];
      mode: "retain-after-injections" | "remove-before-injections";
    }[] = [];

    visit(tree, "code", (code: Code, index, parent) => {
      if (parent == null || index == null) return;
      if (!codeImportSpecsNDF.is(code)) return;

      const { importSpecs: specs } = code.data;
      const imported: ImportedContentNode[] = [];
      const mode = retainAfterInjections == undefined
        ? "retain-after-injections" as const
        : (retainAfterInjections(code)
          ? "retain-after-injections" as const
          : "remove-before-injections" as const);

      for (
        const g of prepareCodeNodes(code, specs, {
          readLocalFsTextIntoValue: readLocalFsTextIntoValue(code),
        })
      ) {
        imported.push(codeGenNDF.attach(g.generated, {
          importedFrom: code,
          provenance: g.provenance,
          strategy: g.strategy,
          isContentAcquired: g.isContentAcquired,
        }));
      }

      if (imported.length) {
        codeImportInsertsNDF.attach(code, { nodes: imported });
        mutations.push({ parent, index, injected: imported, mode });
      }
    });

    // Apply mutations after traversal, from right to left.
    mutations.sort((a, b) => b.index - a.index);

    for (const { parent, index, injected, mode } of mutations) {
      if (mode === "remove-before-injections") {
        // Replace spec node with injected nodes
        parent.children.splice(index, 1, ...injected);
      } else {
        // retain-after-injections: keep spec; insert injected nodes after it
        parent.children.splice(index + 1, 0, ...injected);
      }
    }

    return tree;
  };
};
