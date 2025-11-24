#!/usr/bin/env -S deno run -A --node-modules-dir=auto
/**
 * @module mdastctl
 *
 * General-purpose CLI for exploring **mdast** trees.
 */

import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { HelpCommand } from "@cliffy/command/help";

import { bold, cyan, gray, magenta, red, yellow } from "@std/fmt/colors";

import type { Code, Heading, Node } from "types/mdast";

import { ListerBuilder } from "../../universal/lister-tabular-tui.ts";
import { TreeLister } from "../../universal/lister-tree-tui.ts";

import {
  buildMdAstTabularRows,
  buildMdAstTreeRows,
  selectNodes,
  type TabularRow,
  type TreeRow,
  viewableMarkdownASTs,
} from "./view.ts";

import { doctor } from "../../universal/doctor.ts";
import { computeSemVerSync } from "../../universal/version.ts";
import { ImportedContentNode } from "../plugin/node/code-import.ts";
import { codeImportInsertsNDF } from "../plugin/node/code-insert.ts";
import { Yielded } from "./io.ts";

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

export class CLI {
  constructor(
    readonly conf?: {
      readonly ensureGlobalFiles?: string[]; // load these markdown files/remotes before CLI arguments or error if not available
      readonly optionalGlobalFiles?: string[]; // TODO: load these if available, skip otherwise
      readonly defaultFiles?: string[]; // load these markdown files/remotes when no CLI arguments given
      readonly cmdName?: string; // the cmd name to show as the CLI entry point in help
    },
  ) {
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  rootCmd() {
    return new Command()
      .name(this.conf?.cmdName ?? "mdastctl.ts")
      .version(() => computeSemVerSync(import.meta.url))
      .description(`query and explore Markdown ASTs (mdast)`)
      .command("help", new HelpCommand())
      .command("completions", new CompletionsCommand())
      .command("mdast", this.mdastCommand())
      .command("doctor", this.doctorCommand());
  }

  doctorCommand() {
    return new Command().name("doctor").description(
      "Show dependencies and their availability",
    ).action(async () => {
      const diags = doctor(["deno --version", "sqlpage --version"]);
      const result = await diags.run();
      diags.render.cli(result);
    });
  }

  protected baseCommand({ examplesCmd }: { examplesCmd: string }) {
    const { cmdName = "mdastctl.ts", defaultFiles } = this.conf ?? {};
    return new Command()
      .example(
        `default ${
          (defaultFiles?.length ?? 0) > 0 ? `(${defaultFiles?.join(", ")})` : ""
        }`,
        `${cmdName} ${examplesCmd}`,
      )
      .example(
        "load md from local fs",
        `${cmdName} ${examplesCmd} ./Qualityfolio.md`,
      )
      .example(
        "load md from remote URL",
        `${cmdName} ${examplesCmd} https://qualityfolio.dev/example.md`,
      )
      .example(
        "load md from multiple",
        `${cmdName} ${examplesCmd} ./Qualityfolio.md https://qualityfolio.dev/example.md local.md`,
      );
  }

  async *viewableMarkdownASTs(
    globalFiles: string[] | undefined,
    positional: string[],
    defaults: string[],
  ) {
    const merged = [
      ...(globalFiles ?? []),
      ...(positional.length ? positional : defaults),
    ];
    if (merged.length > 0) {
      yield* viewableMarkdownASTs(merged);
    }
  }

  mdastCommand() {
    return new Command()
      .name("mdast")
      .description(`query and explore Markdown ASTs (mdast)`)
      .command("ls", this.lsCommand())
      .command("identifiers", this.identifiersCommand())
      .command("tree", this.treeCommand())
      .command("class", this.classCommand())
      .command("schema", this.schemaCommand())
      .command("imports", this.importsCommand())
      .command("md", this.mdCommand());
  }

  // -------------------------------------------------------------------------
  // ls command (tabular "physical" view)
  // -------------------------------------------------------------------------

  /**
   * `ls` – list mdast nodes in a tabular, content-hierarchy-friendly way.
   *
   * - By default: includes every node in the tree.
   * - With `--select <expr>`: only nodes matching that mdastql expression.
   * - With `--data`: adds a DATA column showing `Object.keys(node.data)`.
   * - With automatic node classification (via frontmatter + nodeClassifier),
   *   shows a CLASS column with key:value pairs.
   */
  lsCommand(cmdName = "ls") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(`list mdast nodes in a tabular, content-hierarchy view`)
      .arguments("[paths...:string]")
      .option(
        "--select <query:string>",
        "mdastql selection (default: every node).",
      )
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(
        async (options, ...paths: string[]) => {
          const allRows: TabularRow[] = [];
          for await (
            const viewable of this.viewableMarkdownASTs(
              this.conf?.ensureGlobalFiles,
              paths,
              this.conf?.defaultFiles ?? [],
            )
          ) {
            const rows = buildMdAstTabularRows("physical", viewable, {
              includeDataKeys: !!options.data,
              query: options.select,
            });
            allRows.push(...rows);
          }

          if (allRows.length === 0) {
            console.log(gray("No nodes matched."));
            return;
          }

          const useColor = options.color;

          const builder = new ListerBuilder<TabularRow>()
            .from(allRows)
            .declareColumns(
              "id",
              "file",
              "type",
              "depth",
              "headingPath",
              "name",
              "classInfo",
              "dataKeys",
              "supplier",
              "identity",
            )
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          builder.numeric("id", (r) => r.id, {
            header: "ID",
            defaultColor: yellow,
          });
          builder.field("file", "file", {
            header: "FILE",
            defaultColor: gray,
          });
          builder.field("type", "type", {
            header: "TYPE",
            defaultColor: cyan,
          });
          builder.numeric("depth", (r) => r.depth, {
            header: "DEPTH",
          });
          builder.field("headingPath", "headingPath", {
            header: "HEADING PATH",
            defaultColor: gray,
          });
          builder.field("name", "name", {
            header: "NAME",
            defaultColor: bold,
          });
          builder.field("classInfo", "classInfo", {
            header: "CLASS",
            defaultColor: magenta,
          });

          if (options.data) {
            builder.field("dataKeys", "dataKeys", {
              header: "DATA",
              defaultColor: magenta,
            });
          }

          if (options.data) {
            builder.select(
              "id",
              "file",
              "type",
              "depth",
              "headingPath",
              "name",
              "classInfo",
              "dataKeys",
            );
          } else {
            builder.select(
              "id",
              "file",
              "type",
              "depth",
              "headingPath",
              "name",
              "classInfo",
            );
          }

          const lister = builder.build();
          await lister.ls(true);
        },
      );
  }

  importsCommand(cmdName = "imports") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(`list imported mdast nodes`)
      .arguments("[paths...:string]")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(
        async (options, ...paths: string[]) => {
          const makeInsert = (
            viewable: Yielded<ReturnType<typeof this.viewableMarkdownASTs>>,
            n: ImportedContentNode<Code>,
          ) => ({
            importedCode: n,
            file: viewable.fileRef(n),
            lang: n.lang ?? "?",
            meta: n.meta ?? "?",
            dataKeys: Object.keys(n.data).join(", "),
          });

          const inserts: Array<ReturnType<typeof makeInsert>> = [];
          for await (
            const viewable of this.viewableMarkdownASTs(
              this.conf?.ensureGlobalFiles,
              paths,
              this.conf?.defaultFiles ?? [],
            )
          ) {
            const cii = codeImportInsertsNDF.collectNodes<Code>(viewable.root);
            inserts.push(
              ...cii.flatMap((i) =>
                i.data.importInserts.nodes.map((n) => makeInsert(viewable, n))
              ),
            );
          }

          // 3. `inserts` is fully typed here
          if (inserts.length === 0) {
            console.log(gray("No imported nodes found."));
            return;
          }

          const useColor = options.color;

          const builder = new ListerBuilder<typeof inserts[number]>()
            .from(inserts)
            .declareColumns("file", "lang", "meta", "dataKeys")
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          builder.field("file", "file", {
            header: "FILE",
            defaultColor: gray,
          });
          builder.field("lang", "lang", {
            header: "LANG",
            defaultColor: cyan,
          });
          builder.field("meta", "meta", {
            header: "META",
            defaultColor: yellow,
          });
          // builder.field("imported", "imported", {
          //   header: "IMPORTED",
          //   defaultColor: brightYellow,
          // });
          // builder.field("isRefToBinary", "isRefToBinary", {
          //   header: "BIN?",
          //   defaultColor: brightYellow,
          // });
          // builder.field("isContentAcquired", "isContentAcquired", {
          //   header: "📃?",
          //   defaultColor: brightYellow,
          // });
          builder.field("dataKeys", "dataKeys", {
            header: "DATA",
            defaultColor: magenta,
          });
          builder.select("lang", "meta", "file", "dataKeys");

          const lister = builder.build();
          await lister.ls(true);
        },
      );
  }

  // -------------------------------------------------------------------------
  // identifiers command (tabular "identifiers" view)
  // -------------------------------------------------------------------------

  /**
   * `identifiers` – list mdast node identities in a tabular view.
   *
   * - Only nodes with identities are included.
   * - One row per (node, SUPPLIER, ID) tuple.
   * - Includes the same physical columns as `ls` plus SUPPLIER and ID.
   */
  identifiersCommand(cmdName = "identifiers") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(
        `list mdast node identifiers (one row per SUPPLIER / ID pair)`,
      )
      .arguments("[paths...:string]")
      .option(
        "--select <query:string>",
        "mdastql selection (default: every node with identities).",
      )
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(
        async (options, ...paths: string[]) => {
          const allRows: TabularRow[] = [];
          for await (
            const viewable of this.viewableMarkdownASTs(
              this.conf?.ensureGlobalFiles,
              paths,
              this.conf?.defaultFiles ?? [],
            )
          ) {
            const rows = buildMdAstTabularRows("identifiers", viewable, {
              includeDataKeys: !!options.data,
              query: options.select,
            });
            allRows.push(...rows);
          }

          if (allRows.length === 0) {
            console.log(gray("No nodes with identifiers to show."));
            return;
          }

          const useColor = options.color;

          const builder = new ListerBuilder<TabularRow>()
            .from(allRows)
            .declareColumns(
              "id",
              "file",
              "type",
              "depth",
              "headingPath",
              "name",
              "classInfo",
              "dataKeys",
              "supplier",
              "identity",
            )
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          builder.numeric("id", (r) => r.id, {
            header: "ROW",
            defaultColor: yellow,
          });
          builder.field("file", "file", {
            header: "FILE",
            defaultColor: gray,
          });
          builder.field("type", "type", {
            header: "TYPE",
            defaultColor: cyan,
          });
          builder.numeric("depth", (r) => r.depth, {
            header: "DEPTH",
          });
          builder.field("headingPath", "headingPath", {
            header: "HEADING PATH",
            defaultColor: gray,
          });
          builder.field("name", "name", {
            header: "NAME",
            defaultColor: bold,
          });
          builder.field("supplier", "supplier", {
            header: "SUPPLIER",
            defaultColor: cyan,
          });
          builder.field("identity", "identity", {
            header: "ID",
            defaultColor: yellow,
          });
          builder.field("classInfo", "classInfo", {
            header: "CLASS",
            defaultColor: magenta,
          });

          if (options.data) {
            builder.field("dataKeys", "dataKeys", {
              header: "DATA",
              defaultColor: magenta,
            });
          }

          const ids: Array<keyof TabularRow & string> = [
            "id",
            "file",
            "supplier",
            "identity",
            "name",
            "type",
            "depth",
            "classInfo",
          ];
          if (options.data) ids.push("dataKeys");
          // deno-lint-ignore no-explicit-any
          builder.select(...ids as any);

          const lister = builder.build();
          await lister.ls(true);
        },
      );
  }

  // -------------------------------------------------------------------------
  // tree command
  // -------------------------------------------------------------------------

  treeCommand(cmdName = "tree") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(`heading/content hierarchy (per file)`)
      .arguments("[paths...:string]")
      .option("--select <query:string>", "mdastql selection to focus the tree.")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const allRows: TreeRow[] = [];

        for await (
          const viewable of this.viewableMarkdownASTs(
            this.conf?.ensureGlobalFiles,
            paths,
            this.conf?.defaultFiles ?? [],
          )
        ) {
          const selectedNodes = options.select
            ? selectNodes(viewable.root, options.select)
            : undefined;

          const rows = buildMdAstTreeRows("physical", viewable, {
            includeDataKeys: !!options.data,
            selectedNodes,
            pruneToSelection: !!options.select,
          });
          allRows.push(...rows);
        }

        if (allRows.length === 0) {
          console.log(gray("No headings or content to show."));
          return;
        }

        const useColor = options.color;

        const base = new ListerBuilder<TreeRow>()
          .from(allRows)
          .declareColumns(
            "label",
            "type",
            "file",
            "identityInfo",
            "classInfo",
            "dataKeys",
          )
          .requireAtLeastOneColumn(true)
          .color(useColor)
          .header(true)
          .compact(false);

        base.field("label", "label", {
          header: "NAME",
          defaultColor: bold,
        });
        base.field("type", "type", {
          header: "TYPE",
          defaultColor: gray,
        });
        base.field("file", "file", {
          header: "FILE",
          defaultColor: gray,
        });
        base.field("identityInfo", "identityInfo", {
          header: "IDENTITY",
          defaultColor: yellow,
        });
        base.field("classInfo", "classInfo", {
          header: "CLASS",
          defaultColor: magenta,
        });
        if (options.data) {
          base.field("dataKeys", "dataKeys", {
            header: "DATA",
            defaultColor: magenta,
          });
        }

        if (options.data) {
          base.select(
            "label",
            "type",
            "identityInfo",
            "classInfo",
            "file",
            "dataKeys",
          );
        } else {
          base.select("label", "type", "identityInfo", "classInfo", "file");
        }

        const treeLister = TreeLister.wrap(base)
          .from(allRows)
          .byParentChild({ idKey: "id", parentIdKey: "parentId" })
          .treeOn("label")
          .dirFirst(true);

        await treeLister.ls(true);
      });
  }

  // -------------------------------------------------------------------------
  // class command
  // -------------------------------------------------------------------------

  classCommand(cmdName = "class") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(
        `show classification hierarchy per file (class key → value → nodes)`,
      )
      .arguments("[paths...:string]")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const allRowsRaw: TreeRow[] = [];

        for await (
          const viewable of this.viewableMarkdownASTs(
            this.conf?.ensureGlobalFiles,
            paths,
            this.conf?.defaultFiles ?? [],
          )
        ) {
          const rows = buildMdAstTreeRows("class", viewable, {
            includeDataKeys: !!options.data,
          });
          allRowsRaw.push(...rows);
        }

        if (allRowsRaw.length === 0) {
          console.log(gray("No classified nodes to show."));
          return;
        }

        // Apply CLI-specific coloring to labels
        const allRows: TreeRow[] = allRowsRaw.map((row) => {
          let label = row.label;
          if (row.type === "root") {
            label = bold(label);
          } else if (row.type === "class-key") {
            label = cyan(label);
          } else if (row.type === "class-value") {
            label = magenta(label);
          }
          return { ...row, label };
        });

        const useColor = options.color;

        const base = new ListerBuilder<TreeRow>()
          .from(allRows)
          .declareColumns(
            "label",
            "identityInfo",
            "classInfo",
            "type",
            "file",
            "dataKeys",
          )
          .requireAtLeastOneColumn(true)
          .color(useColor)
          .header(true)
          .compact(false);

        // Identity color so pre-colored labels are preserved
        base.field("label", "label", {
          header: "NAME",
          defaultColor: (s) => s,
        });
        base.field("identityInfo", "identityInfo", {
          header: "IDENTITY",
          defaultColor: yellow,
        });
        base.field("classInfo", "classInfo", {
          header: "CLASS",
          defaultColor: gray,
        });
        base.field("type", "type", {
          header: "TYPE",
          defaultColor: gray,
        });
        base.field("file", "file", {
          header: "FILE",
          defaultColor: gray,
        });
        if (options.data) {
          base.field("dataKeys", "dataKeys", {
            header: "DATA",
            defaultColor: magenta,
          });
        }

        if (options.data) {
          base.select(
            "label",
            "identityInfo",
            "classInfo",
            "type",
            "file",
            "dataKeys",
          );
        } else {
          base.select("label", "identityInfo", "classInfo", "type", "file");
        }

        const treeLister = TreeLister.wrap(base)
          .from(allRows)
          .byParentChild({ idKey: "id", parentIdKey: "parentId" })
          .treeOn("label")
          .dirFirst(true);

        await treeLister.ls(true);
      });
  }

  // -------------------------------------------------------------------------
  // schema command
  // -------------------------------------------------------------------------

  schemaCommand(cmdName = "schema") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(
        `show section schema hierarchy (per file) using documentSchema plugin`,
      )
      .arguments("[paths...:string]")
      .option("--data", "Include node.data keys as a DATA column.")
      .option("--no-color", "Show output without using ANSI colors")
      .action(async (options, ...paths: string[]) => {
        const allRows: TreeRow[] = [];

        for await (
          const viewable of this.viewableMarkdownASTs(
            this.conf?.ensureGlobalFiles,
            paths,
            this.conf?.defaultFiles ?? [],
          )
        ) {
          const baseRows = buildMdAstTreeRows("schema", viewable, {
            includeDataKeys: !!options.data,
          });

          if (baseRows.length === 0) continue;

          // Apply CLI-specific coloring and icons
          const rows = baseRows.map((row) => {
            let label = row.label;

            if (row.type === "root") {
              label = bold(`📁 ${label}`);
            } else if (row.kind === "heading") {
              const schemaLevel = row.schemaLevel ?? 0;
              const base = `📁 ${label}`;
              if (schemaLevel === 0) {
                label = cyan(base);
              } else if (schemaLevel === 1) {
                label = yellow(base);
              } else {
                label = magenta(base);
              }
            } else {
              label = `📄 ${gray(label)}`;
            }

            return { ...row, label };
          });

          allRows.push(...rows);
        }

        if (allRows.length === 0) {
          console.log(gray("No sections to show."));
          return;
        }

        const useColor = options.color;

        const base = new ListerBuilder<TreeRow>()
          .from(allRows)
          .declareColumns(
            "label",
            "type",
            "file",
            "identityInfo",
            "classInfo",
            "dataKeys",
          )
          .requireAtLeastOneColumn(true)
          .color(useColor)
          .header(true)
          .compact(false);

        // preserve pre-colored labels (sections by level, nodes gray)
        base.field("label", "label", {
          header: "NAME",
          defaultColor: (s) => s,
        });
        base.field("type", "type", {
          header: "TYPE",
          defaultColor: gray,
        });
        base.field("file", "file", {
          header: "FILE",
          defaultColor: gray,
        });
        base.field("identityInfo", "identityInfo", {
          header: "IDENTITY",
          defaultColor: yellow,
        });
        base.field("classInfo", "classInfo", {
          header: "CLASS",
          defaultColor: magenta,
        });
        base.field("dataKeys", "dataKeys", {
          header: "DATA",
          defaultColor: magenta,
        });

        if (options.data) {
          base.select(
            "label",
            "identityInfo",
            "classInfo",
            "type",
            "file",
            "dataKeys",
          );
        } else {
          base.select("label", "identityInfo", "classInfo", "file");
        }

        const treeLister = TreeLister.wrap(base)
          .from(allRows)
          .byParentChild({ idKey: "id", parentIdKey: "parentId" })
          .treeOn("label")
          .dirFirst(true);

        await treeLister.ls(true);
      });
  }

  // -------------------------------------------------------------------------
  // md command
  // -------------------------------------------------------------------------

  mdCommand(cmdName = "md") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(`run mdastql and print the selected nodes as Markdown`)
      .arguments("[paths...:string]")
      .option(
        "--select <query:string>",
        "mdastql selection (required - which nodes to emit as Markdown).",
      )
      .option(
        "--section",
        "When selected nodes are headings, emit the entire section " +
          "(from that heading down to before the next heading of same/higher depth).",
      )
      .action(async (options, ...paths: string[]) => {
        if (!options.select) {
          console.error(red("md: --select <query> is required"));
          Deno.exit(1);
        }

        const allChunks: string[] = [];
        const sectionMode = !!options.section;

        for await (
          const { root, nodeSrcText, source } of this.viewableMarkdownASTs(
            this.conf?.ensureGlobalFiles,
            paths,
            this.conf?.defaultFiles ?? [],
          )
        ) {
          const nodes = selectNodes(root, options.select);

          if (!sectionMode) {
            // Simple mode: just slice each selected node from source
            for (const node of nodes) {
              const snippet = nodeSrcText.sliceForNode(node);
              if (snippet) allChunks.push(snippet);
            }
            continue;
          }

          // SECTION mode: expand selected headings into sections.
          const headings: Heading[] = [];
          const nonHeadingNodes: Node[] = [];

          for (const node of nodes) {
            if (node.type === "heading") {
              headings.push(node as Heading);
            } else {
              nonHeadingNodes.push(node);
            }
          }

          const sectionRanges = nodeSrcText.sectionRangesForHeadings(headings);
          if (sectionRanges.length > 0) {
            // We have at least one bona fide section in this file: emit only sections.
            for (const r of sectionRanges) {
              allChunks.push(source.slice(r.start, r.end));
            }
          } else {
            // No usable sections: fall back to per-node snippets for all selected nodes.
            for (const node of nodes) {
              const snippet = nodeSrcText.sliceForNode(node);
              if (snippet) allChunks.push(snippet);
            }
          }
        }

        if (allChunks.length === 0) {
          console.log(gray("No nodes matched; nothing to print."));
          return;
        }

        console.log(allChunks.join("\n\n"));
      });
  }
}

// ---------------------------------------------------------------------------
// Stand-alone entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await new CLI().run();
}
