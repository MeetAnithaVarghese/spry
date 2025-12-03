#!/usr/bin/env -S deno run -A --node-modules-dir=auto

import { Command, EnumType } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/completions";
import { HelpCommand } from "@cliffy/help";
import {
  blue,
  bold,
  brightRed,
  brightYellow,
  cyan,
  gray,
  green,
  red,
  yellow,
} from "@std/fmt/colors";
import { relative } from "@std/path";
import { Code } from "types/mdast";
import { MarkdownDoc } from "../../markdown/fluent-doc.ts";
import { markdownShellEventBus } from "../../task/mdbus.ts";
import { languageRegistry, LanguageSpec } from "../../universal/code.ts";
import {
  ColumnDef,
  ListerBuilder,
} from "../../universal/lister-tabular-tui.ts";
import {
  errorOnlyShellEventBus,
  ShellBusEvents,
  verboseInfoShellEventBus,
} from "../../universal/shell.ts";
import {
  errorOnlyTaskEventBus,
  executeDAG,
  executionPlan,
  executionSubplan,
  fail,
  ok,
  TaskExecEventMap,
  TaskExecutionPlan,
  verboseInfoTaskEventBus,
} from "../../universal/task.ts";
import { computeSemVerSync } from "../../universal/version.ts";

import {
  captureFactory,
  CaptureSpec,
  gitignorableOnCapture,
} from "../../interpolate/capture.ts";
import { type PartialCollection } from "../../interpolate/partial.ts";
import {
  unsafeInterpFactory,
  UnsafeInterpolationResult,
} from "../../interpolate/unsafe.ts";
import { eventBus } from "../../universal/event-bus.ts";
import { shell } from "../../universal/shell.ts";
import {
  executionPlanVisuals,
  ExecutionPlanVisualStyle,
} from "../../universal/task-visuals.ts";
import { runbooksFromFiles, RunnableTask } from "../projection/playbook.ts";
import * as axiomCLI from "./cli.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export function executeTasksFactory<
  T extends RunnableTask,
  Context extends { readonly runId: string },
  FragmentLocals extends Record<string, unknown> = Record<string, unknown>,
>(
  opts?: {
    partials: PartialCollection<FragmentLocals>;
    shellBus?: ReturnType<typeof eventBus<ShellBusEvents>>;
    tasksBus?: ReturnType<typeof eventBus<TaskExecEventMap<T, Context>>>;
  },
) {
  const td = new TextDecoder();

  const cf = captureFactory<
    RunnableTask,
    {
      readonly interpResult: UnsafeInterpolationResult;
      readonly execResult?: Awaited<
        ReturnType<ReturnType<typeof shell>["auto"]>
      >;
    }
  >({
    isCapturable: (task) =>
      task.spawnableArgs.capture.length ? task.spawnableArgs.capture : false,
    prepareCaptured: (op) => {
      const text = () => {
        if (op.execResult) {
          if (Array.isArray(op.execResult)) {
            return op.execResult.map((er) => td.decode(er.stdout)).join("\n");
          } else {
            return td.decode(op.execResult.stdout);
          }
        } else {
          return op.interpResult.source;
        }
      };
      const json = () => JSON.parse(text());
      return { text, json };
    },
    onCapture: gitignorableOnCapture,
  });

  const { capture, history: captured } = cf;
  const { partials } = opts ?? {};
  const unsafeInterp = unsafeInterpFactory({
    partialsCollec: partials,
    interpCtx: () => ({ captured }),
  });
  const sh = shell({ bus: opts?.shellBus });
  const { interpolateUnsafely } = unsafeInterp;

  const te = new TextEncoder();
  const execute = async (plan: TaskExecutionPlan<T>) =>
    await executeDAG(plan, async (task, ctx) => {
      const interpResult = await interpolateUnsafely({
        task,
        source: task.value,
        interpolate: task.spawnableArgs.interpolate,
      });
      if (interpResult.status) {
        const execResult = task.captureOnly
          ? { // could be "env", "envrc" or other "output-only" tasks
            code: 0,
            success: true,
            stdout: te.encode(interpResult.source),
            stderr: new Uint8Array(),
          }
          : await sh.auto(interpResult.source, undefined, task);
        await capture(task, { interpResult, execResult });
        return ok(ctx);
      } else {
        return fail(ctx, interpResult.error);
      }
    }, { eventBus: opts?.tasksBus });

  return {
    execute,
    sh,
    unsafeInterp,
    capture: cf,
  };
}

export type LsTaskRow = {
  code: Code;
  name: string;
  origin: string;
  engine: ReturnType<ReturnType<typeof shell>["strategy"]> | {
    engine: "capture-only";
    label: "Capture Only";
    linesOfCode: string[];
  };
  descr: string;
  deps?: string;
  flags: {
    isInterpolated: boolean;
    isSilent: boolean;
    isCaptured: CaptureSpec | false;
    isCaptureOnly: boolean;
    isGitIgnored: boolean;
    hasIssues: boolean;
  };
  graphs: string;
};

function lsFlagsField<Row extends LsTaskRow>():
  | Partial<ColumnDef<Row, Row["flags"]>>
  | undefined {
  return {
    header: "Args",
    defaultColor: gray,
    // deno-fmt-ignore
    format: (v) =>
        `${v.hasIssues ? brightRed("E") : " "} ${brightYellow(v.isInterpolated ? "I" : " ")} ${blue(v.isCaptured ? (v.isCaptured.nature == "relFsPath" ? "CF" : "CM") : "  ")} ${v.isGitIgnored ? "G" : " "} ${v.isGitIgnored ? "S" : " "}`,
  };
}

function lsColorPathField<Row extends LsTaskRow>(
  header: string,
): Partial<ColumnDef<Row, string>> {
  return {
    header,
    format: (supplied) => {
      const p = relative(Deno.cwd(), supplied);
      const i = p.lastIndexOf("/");
      return i < 0 ? bold(p) : gray(p.slice(0, i + 1)) + bold(p.slice(i + 1));
    },
    rules: [{
      when: (_v, r) =>
        "error" in r
          ? ((r.error ? String(r.error)?.trim().length ?? 0 : 0) > 0)
          : false,
      color: red,
    }],
  };
}

function lsTaskIdField<Row extends LsTaskRow>(): Partial<
  ColumnDef<Row, Row["name"]>
> {
  return {
    header: "Name",
    format: (v) => brightYellow(v), // TODO: give per-language color
  };
}

function lsCmdEngineField<Row extends LsTaskRow>(): Partial<
  ColumnDef<Row, Row["engine"]>
> {
  return {
    header: "ENGINE",
    format: (v) => {
      switch (v.engine) {
        case "shebang":
          return green(v.label);
        case "deno-task":
          return cyan(v.label);
        case "capture-only":
          return gray(v.label);
      }
    },
  };
}

export enum VerboseStyle {
  Plain = "plain",
  Rich = "rich",
  Markdown = "markdown",
}

export function informationalEventBuses<T extends RunnableTask, Context>(
  verbose?: VerboseStyle,
) {
  const emitStdOut = (ev: ShellBusEvents<T>["spawn:done"]) =>
    ev.baggage?.spawnableArgs.silent ? false : true;

  if (!verbose) {
    return {
      shellEventBus: errorOnlyShellEventBus<T>({ style: "rich", emitStdOut }),
      tasksEventBus: errorOnlyTaskEventBus<T, Context>({ style: "rich" }),
    };
  }

  switch (verbose) {
    case VerboseStyle.Plain:
      return {
        shellEventBus: verboseInfoShellEventBus({ style: "plain", emitStdOut }),
        tasksEventBus: verboseInfoTaskEventBus<T, Context>({ style: "plain" }),
      };

    case VerboseStyle.Rich:
      return {
        shellEventBus: verboseInfoShellEventBus({ style: "rich", emitStdOut }),
        tasksEventBus: verboseInfoTaskEventBus<T, Context>({ style: "rich" }),
      };

    case VerboseStyle.Markdown: {
      const md = new MarkdownDoc();
      const mdSEB = markdownShellEventBus({ md });
      return {
        mdSEB,
        shellEventBus: mdSEB.bus,
        tasksEventBus: undefined, // TODO: add tasks to markdown
        md,
        emit: () => console.log(md.write()),
      };
    }
  }
}

const verboseOpt = [
  "--verbose <style:verboseStyle>",
  "Emit information messages verbosely",
] as const;

const verboseStyle = new EnumType(VerboseStyle);

export const spawnableLangIds = ["shell"] as const;
export type SpawnableLangIds = typeof spawnableLangIds[number];
export const spawnableLangSpecs = spawnableLangIds.map((lid) => {
  const langSpec = languageRegistry.get(lid);
  if (!langSpec) throw new Error("this should never happen");
  return langSpec;
});

export class CLI {
  readonly axiomCLI: axiomCLI.CLI;
  readonly isSpawnable: (
    code: Code,
  ) => LanguageSpec | undefined;

  constructor(
    readonly conf?: {
      readonly defaultFiles?: string[]; // load these markdown files/remotes when no CLI arguments given
      readonly axiomCLI?: axiomCLI.CLI;
      readonly isSpawnable?: CLI["isSpawnable"];
    },
  ) {
    this.isSpawnable = conf?.isSpawnable ??
      ((code) =>
        spawnableLangSpecs.find((lang) =>
          lang.id == code.lang || lang.aliases?.find((a) => a == code.lang)
        ));
    this.axiomCLI = conf?.axiomCLI ??
      new axiomCLI.CLI({ defaultFiles: conf?.defaultFiles });
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  rootCmd() {
    return new Command()
      .name("runbook.ts")
      .version(() => computeSemVerSync(import.meta.url))
      .description(`Spry Runbook operator`)
      .command("help", new HelpCommand())
      .command("completions", new CompletionsCommand())
      .command("axiom", this.axiomCLI.rootCmd())
      .command("ls", this.lsCommand())
      .command("task", this.taskCommand())
      .command("run", this.runCommand());
  }

  protected baseCommand({ examplesCmd }: { examplesCmd: string }) {
    const cmdName = "runbook";
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

  taskCommand() {
    return new Command()
      .name("task")
      .description(`execute a specific cell and dependencies`)
      .type("verboseStyle", verboseStyle)
      .arguments("<taskId> [paths...:string]")
      .option(...verboseOpt)
      .option("--summarize", "Emit summary after execution in JSON")
      .action(
        async (opts, taskId, ...paths: string[]) => {
          const { tasks, partials } = await runbooksFromFiles(
            paths.length ? paths : this.conf?.defaultFiles ?? [],
          );
          if (tasks.find((t) => t.taskId() == taskId)) {
            const ieb = informationalEventBuses<
              typeof tasks[number],
              { runId: string }
            >(opts?.verbose);
            const etf = executeTasksFactory({
              partials,
              shellBus: ieb.shellEventBus,
              tasksBus: ieb.tasksEventBus,
            });
            const runbook = await etf.execute(
              executionSubplan(executionPlan(tasks), [taskId]),
            );
            if (ieb.emit) ieb.emit();
            if (opts.summarize) {
              console.log(runbook);
            }
          } else {
            console.warn(`Task '${taskId}' not found.`);
          }
        },
      );
  }

  runCommand() {
    return new Command()
      .name("run")
      .description(`execute all code cells in markdown documents as a DAG`)
      .type("verboseStyle", verboseStyle)
      .type("visualStyle", new EnumType(ExecutionPlanVisualStyle))
      .arguments("[paths...:string]")
      .option(...verboseOpt)
      .option(
        "--graph <name:string>",
        "Run only the nodes in provided graph(s)",
        {
          collect: true,
        },
      )
      .option("--summarize", "Emit summary after execution in JSON")
      .option("--visualize <style:visualStyle>", "Visualize the DAG")
      .action(
        async (opts, ...paths: string[]) => {
          const { tasks, partials } = await runbooksFromFiles(
            paths.length ? paths : this.conf?.defaultFiles ?? [],
            {
              filter: opts.graph?.length
                ? ((task) =>
                  task.spawnableArgs.graphs?.some((g) =>
                      opts.graph!.includes(g)
                    )
                    ? true
                    : false)
                : ((task) => task.spawnableArgs.graphs?.length ? false : true),
            },
          );
          const plan = executionPlan(tasks);
          if (opts?.visualize) {
            const epv = executionPlanVisuals(plan);
            console.log(epv.visualText(opts.visualize));
          } else {
            const ieb = informationalEventBuses<
              typeof tasks[number],
              { runId: string }
            >(opts?.verbose);
            const etf = executeTasksFactory({
              partials,
              shellBus: ieb.shellEventBus,
              tasksBus: ieb.tasksEventBus,
            });
            const runbook = await etf.execute(plan);
            if (ieb.emit) ieb.emit();
            if (opts.summarize) {
              console.log(runbook);
            }
          }
        },
      );
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
  protected lsCommand(cmdName = "ls") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(`list code cells (tasks) in markdown documents`)
      .arguments("[paths...:string]")
      .option("--no-color", "Show output without using ANSI colors")
      .action(
        async (options, ...paths: string[]) => {
          const sh = shell();
          const { tasks } = await runbooksFromFiles(
            paths.length ? paths : this.conf?.defaultFiles ?? [],
          );
          const lsRows = tasks.map((task) => {
            const { spawnableArgs: args } = task;
            return {
              code: task,
              name: task.taskId(),
              deps: task.taskDeps().join(", "),
              descr: args.description ?? "",
              origin: task.provenance.fileRef(task),
              engine: task.captureOnly
                ? {
                  engine: "capture-only",
                  label: "Capture Only",
                  linesOfCode: [],
                }
                : sh.strategy(task.value),
              flags: {
                isInterpolated: args.interpolate ? true : false,
                isCaptured: args.capture.length > 0 ? args.capture[0] : false,
                isCaptureOnly: task.captureOnly ?? false,
                isGitIgnored: args.capture[0]?.gitignore ? true : false,
                isSilent: args.silent ?? false,
                hasIssues: false,
              },
              graphs: args.graphs ? args.graphs.join(", ") : "",
            } satisfies LsTaskRow;
          });

          if (lsRows.length === 0) {
            console.log(
              gray(
                "No nodes matched (did you supply any valid markdown files?).",
              ),
            );
            return;
          }

          const useColor = options.color;
          const builder = new ListerBuilder<LsTaskRow>()
            .from(lsRows)
            .declareColumns(
              "name",
              "engine",
              "deps",
              "descr",
              "origin",
              "flags",
              "graphs",
            )
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          builder.field("name", "name", lsTaskIdField());
          builder.field("engine", "engine", lsCmdEngineField());
          builder.field("deps", "deps", {
            header: "DEPS",
            defaultColor: yellow,
          });
          builder.field("descr", "descr", { header: "DESCR" });
          builder.field("origin", "origin", lsColorPathField("ORIGIN"));
          builder.field("flags", "flags", lsFlagsField());
          builder.field("graphs", "graphs", {
            header: "GRAPH",
            defaultColor: yellow,
          });
          builder.select(
            "name",
            "deps",
            "graphs",
            "flags",
            "descr",
            "origin",
            "engine",
          );

          const lister = builder.build();
          await lister.ls(true);
        },
      );
  }
}

// ---------------------------------------------------------------------------
// Stand-alone entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await new CLI().run();
}
