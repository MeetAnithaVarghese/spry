import {
  bold,
  brightYellow,
  cyan,
  gray,
  green,
  red,
  yellow,
} from "jsr:@std/fmt@^1/colors";
import { relative } from "jsr:@std/path@^1";
import { ColumnDef, ListerBuilder } from "../universal/lister-tabular-tui.ts";
import {
  errorOnlyShellEventBus,
  shell,
  verboseInfoShellEventBus,
} from "../universal/shell.ts";
import {
  errorOnlyTaskEventBus,
  executeDAG,
  ok,
  Task,
  TaskExecutionPlan,
  TaskExecutorBuilder,
  verboseInfoTaskEventBus,
} from "../universal/task.ts";
import { matchTaskNature, TaskCell } from "./cell.ts";

export type LsTaskRow = {
  name: string;
  notebook: string;
  language: string;
  descr: string;
  deps?: string;
  error?: unknown;
};

export async function ls<Provenance>(tasks: TaskCell<Provenance>[]) {
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
      format: (v) =>
        v === "head_sql"
          ? green(v)
          : v === "tail_sql"
          ? yellow(v)
          : v === "sqlpage_file_upsert"
          ? brightYellow(v)
          : cyan(v),
    };
  }

  function lsLanguageField<Row extends LsTaskRow>(): Partial<
    ColumnDef<Row, Row["language"]>
  > {
    return {
      header: "Language",
      format: (v) =>
        v === "head_sql"
          ? green(v)
          : v === "tail_sql"
          ? yellow(v)
          : v === "sqlpage_file_upsert"
          ? brightYellow(v)
          : cyan(v),
    };
  }

  const tasksList = tasks.map((t) => {
    return {
      name: t.taskId(),
      notebook: String(t.provenance),
      language: t.language,
      deps: (t.taskDeps?.() ?? []).join(", "),
      descr: (String(t.parsedInfo?.flags["descr"]) ?? "").replace(
        "undefined",
        "",
      ),
    } satisfies LsTaskRow;
  });

  await new ListerBuilder<LsTaskRow>()
    .declareColumns("name", "notebook", "language", "deps", "descr", "error")
    .from(tasksList)
    .field("name", "name", lsTaskIdField())
    .field("language", "language", lsLanguageField())
    .field("deps", "deps")
    .field("descr", "descr")
    .field("error", "error", { header: "Err" })
    .field("notebook", "notebook", lsColorPathField("Notebook"))
    .sortBy("name").sortDir("asc")
    .build()
    .ls(true);
}

export async function executeTasks<T extends Task>(
  plan: TaskExecutionPlan<T>,
  verbose?: false | Parameters<typeof verboseInfoShellEventBus>[0]["style"],
  summarize?: boolean,
) {
  type Context = { runId: string };

  const sh = shell({
    bus: verbose
      ? verboseInfoShellEventBus({ style: verbose })
      : errorOnlyShellEventBus({ style: verbose ? verbose : "rich" }),
  });

  const exec = new TaskExecutorBuilder<Task, Context>()
    .handle(matchTaskNature("TASK"), async (cell, ctx) => {
      await sh.auto(cell.source);
      return ok(ctx);
    })
    .build();

  const summary = await executeDAG(plan, exec, {
    eventBus: verbose
      ? verboseInfoTaskEventBus<T, Context>({ style: verbose })
      : errorOnlyTaskEventBus<T, Context>({
        style: verbose ? verbose : "rich",
      }),
  });
  if (summarize) console.dir({ summary });
  return summary;
}
