#!/usr/bin/env -S deno run -A --node-modules-dir=auto

// cli.ts
//
// Spry Graph Viewer CLI
// - Reads Markdown fixture(s)
// - Builds a GraphViewerModel via buildGraphViewerModelFromFiles()
// - Shows the containedInSection hierarchy in a TUI tree

import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/completions";
import { HelpCommand } from "@cliffy/help";
import { bold, gray, magenta, yellow } from "@std/fmt/colors";

import { ListerBuilder } from "../../../universal/lister-tabular-tui.ts";
import { TreeLister } from "../../../universal/lister-tree-tui.ts";
import { computeSemVerSync } from "../../../universal/version.ts";

import type { Node, Position } from "types/unist";
import { headingLikeTextDef } from "../graph.ts";
import * as webUI from "../web-ui/service.ts";
import { buildGraphViewerModelFromFiles } from "../web-ui/view.ts";

type GraphViewerModel = Awaited<
  ReturnType<typeof buildGraphViewerModelFromFiles>
>;

type HierarchyRow = {
  readonly id: string;
  readonly parentId?: string;
  readonly label: string;
  readonly type: string;
  readonly dataKeys?: string;
  readonly fileRef?: string;
};

// We only need the parts of HierarchyNode that are relevant for this CLI.
type HierarchyNode = {
  nodeId: string;
  children: HierarchyNode[];
};

type PositionedNode = Node & { position?: Position };
type DataNode = Node & { data?: Record<string, unknown> };

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function resolveMarkdownPaths(
  positional: string[],
  defaultFiles: string[] | undefined,
): string[] {
  if (positional.length > 0) return positional;
  if (defaultFiles && defaultFiles.length > 0) return defaultFiles;
  return [];
}

/**
 * Build flat rows suitable for TreeLister from the GraphViewerModel
 * for a single hierarchical relationship (e.g., "containedInSection").
 *
 * `includeNodeType` controls which mdast node.type values are rendered as rows.
 * Nodes whose type does not satisfy `includeNodeType(type)` are skipped, but
 * their children are still traversed and attached to the nearest visible
 * ancestor.
 */
function buildHierarchyRowsForRelationship(
  model: GraphViewerModel,
  relName: string,
  includeNodeType: (node: Node) => boolean,
): HierarchyRow[] {
  const rows: HierarchyRow[] = [];

  const hierByDoc = model.hierarchies?.[relName] ?? {};
  const documents = model.documents;
  const nodes = model.nodes;
  const mdastStore = model.mdastStore;

  const docLabelById = new Map<string, string>();
  for (const d of documents) {
    docLabelById.set(d.id, d.label);
  }

  for (const [docId, forest] of Object.entries(hierByDoc)) {
    const docLabel = docLabelById.get(docId) ??
      documents.find((d) => d.id === docId)?.label ??
      docId;

    // Document root row
    const docRowId = `${docId}#root`;
    rows.push({
      id: docRowId,
      parentId: undefined,
      label: bold(docLabel),
      type: "document",
    });

    const emit = (node: HierarchyNode, parentId: string) => {
      const gvNode = nodes[node.nodeId];

      const type = gvNode?.type ?? "unknown";
      const label = gvNode?.label ?? node.nodeId;

      let dataKeys: string | undefined;
      let fileRef: string | undefined;

      // Only render this node if its mdast type is allowed.
      // Children are always traversed and attach to the nearest
      // visible ancestor (thisParentId).
      let thisParentId = parentId;

      if (
        gvNode &&
        typeof gvNode.mdastIndex === "number" &&
        Array.isArray(mdastStore)
      ) {
        const mdNode = mdastStore[gvNode.mdastIndex] as
          & DataNode
          & PositionedNode;

        // node.data keys
        if (mdNode.data && typeof mdNode.data === "object") {
          const keys = Object.keys(mdNode.data);
          if (keys.length > 0) {
            dataKeys = keys.join(", ");
          }
        }

        // fileRef-style "file:line:column"
        const pos = mdNode.position?.start;
        if (docLabel) {
          if (pos?.line != null) {
            const col = pos.column ?? 1;
            fileRef = `${docLabel}:${pos.line}:${col}`;
          } else {
            fileRef = docLabel;
          }
        }

        if (includeNodeType(mdNode)) {
          const rowId = `${docId}:${node.nodeId}:${rows.length}`;

          rows.push({
            id: rowId,
            parentId,
            label,
            type,
            dataKeys,
            fileRef,
          });

          thisParentId = rowId;
        }
      }

      if (Array.isArray(node.children)) {
        for (const ch of node.children) {
          emit(ch, thisParentId);
        }
      }
    };

    if (Array.isArray(forest)) {
      const hierarchyForest = forest as unknown as HierarchyNode[];
      for (const rootNode of hierarchyForest) {
        emit(rootNode, docRowId);
      }
    }
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

export class CLI {
  readonly webUiCLI: webUI.CLI;

  constructor(
    readonly conf?: {
      readonly defaultFiles?: string[];
      readonly mdastCLI?: webUI.CLI;
    },
  ) {
    this.webUiCLI = conf?.mdastCLI ??
      new webUI.CLI({ defaultFiles: conf?.defaultFiles });
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  rootCmd() {
    return new Command()
      .name("graph-cli")
      .version(() => computeSemVerSync(import.meta.url))
      .description("Spry Graph Viewer CLI")
      .command("help", new HelpCommand())
      .command("completions", new CompletionsCommand())
      .command("web-ui", this.webUiCLI.docCommand())
      .command("ls", this.lsCommand());
  }

  protected baseCommand({ examplesCmd }: { examplesCmd: string }) {
    const cmdName = "ls";
    const { defaultFiles } = this.conf ?? {};
    return new Command()
      .example(
        `default ${
          (defaultFiles?.length ?? 0) > 0 ? `(${defaultFiles?.join(", ")})` : ""
        }`,
        `${cmdName} ${examplesCmd}`,
      )
      .example(
        "load md from local fs",
        `${cmdName} ${examplesCmd} ./runbook.md`,
      )
      .example(
        "load md from remote URL",
        `${cmdName} ${examplesCmd} https://SpryMD.org/runbook.md`,
      )
      .example(
        "load md from multiple",
        `${cmdName} ${examplesCmd} ./runbook.d https://qualityfolio.dev/runbook.md another.md`,
      );
  }

  /**
   * `ls` command:
   * - builds GraphViewerModel from markdown sources
   * - shows the `containedInSection` hierarchy as a tree
   * - by default shows only heading + code nodes
   * - `-n, --node <type>` adds more mdast node.type values (e.g., paragraph)
   */
  lsCommand(cmdName = "graph") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description("browse containedInSection hierarchy as a tree")
      .arguments("[paths...:string]")
      .option(
        "-n, --node <nodeType:string>",
        "Additional mdast node.type to include (e.g. paragraph). May be repeated.",
        { collect: true },
      )
      .option("--no-color", "Show output without ANSI colors")
      .action(
        async (
          options: {
            node?: string | string[];
            color?: boolean;
          },
          ...paths: string[]
        ) => {
          const markdownPaths = resolveMarkdownPaths(
            paths,
            this.conf?.defaultFiles,
          );

          if (markdownPaths.length === 0) {
            console.log(
              gray(
                "No markdown paths provided and no default files configured.",
              ),
            );
            return;
          }

          const model = await buildGraphViewerModelFromFiles(markdownPaths);

          // Default types: heading + code
          const baseTypes = new Set<string>(["heading", "code"]);

          const extraTypes = new Set<string>(
            Array.isArray(options.node)
              ? options.node
              : options.node
              ? [options.node]
              : [],
          );

          const includeNodeType = (node: Node): boolean =>
            baseTypes.has(node.type) || extraTypes.has(node.type) ||
            headingLikeTextDef.factory.is(node);

          const relName = "containedInSection";
          const rows = buildHierarchyRowsForRelationship(
            model,
            relName,
            includeNodeType,
          );

          if (!rows.length) {
            console.log(
              gray(
                `No hierarchy found for relationship ${relName}.`,
              ),
            );
            return;
          }

          const useColor = options.color;

          const base = new ListerBuilder<HierarchyRow>()
            .from(rows)
            .declareColumns("label", "type", "fileRef", "dataKeys")
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          base.field("label", "label", {
            header: "NAME",
            defaultColor: (s: string) => s,
          });
          base.field("type", "type", {
            header: "TYPE",
            defaultColor: gray,
          });
          base.field("fileRef", "fileRef", {
            header: "FILE",
            defaultColor: magenta,
          });
          base.field("dataKeys", "dataKeys", {
            header: "DATA",
            defaultColor: yellow,
          });

          base.select("label", "type", "fileRef", "dataKeys");

          const treeLister = TreeLister.wrap(base)
            .from(rows)
            .byParentChild({ idKey: "id", parentIdKey: "parentId" })
            .treeOn("label")
            .dirFirst(true);

          await treeLister.ls(true);
        },
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Stand-alone entrypoint                                                     */
/* -------------------------------------------------------------------------- */

if (import.meta.main) {
  await new CLI().run();
}
