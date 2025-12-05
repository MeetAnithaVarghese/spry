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
import { TaskCell } from "./cell.ts";

export type LsTaskRow = {
  name: string;
  provenance: string;
  language: string;
  descr: string;
  flags: {
    isContent: boolean;
    isInterpolatable: boolean;
    isCapturable: boolean;
  };
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
      header: "Lang",
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

  function lsFlagsField<Row extends LsTaskRow>():
    | Partial<ColumnDef<Row, Row["flags"]>>
    | undefined {
    return {
      header: "Flags",
      defaultColor: gray,
      // deno-fmt-ignore
      format: (v) =>
          `${brightYellow(v.isContent ? " " : "T")} ${brightYellow(v.isInterpolatable ? "I" : " ")} ${yellow(v.isCapturable ? "C" : " ")}`,
    };
  }

  const tasksList = tasks.map((t) => {
    return {
      name: t.taskId(),
      provenance: `${String(t.provenance)}:${t.startLine}`,
      language: t.language,
      deps: (t.taskDeps?.() ?? []).join(", "),
      descr: (String(t.parsedPI?.flags["descr"]) ?? "").replace(
        "undefined",
        "",
      ),
      flags: {
        isContent: t.taskDirective.nature === "CONTENT",
        isCapturable: t.parsedPI?.hasEitherFlagOfType("capture", "C")
          ? true
          : false,
        isInterpolatable: t.parsedPI?.hasEitherFlagOfType("interpolate", "I")
          ? true
          : false,
      },
    } satisfies LsTaskRow;
  });

  await new ListerBuilder<LsTaskRow>()
    .declareColumns(
      "name",
      "provenance",
      "language",
      "deps",
      "descr",
      "error",
      "flags",
    )
    .from(tasksList)
    .field("name", "name", lsTaskIdField())
    .field("flags", "flags", lsFlagsField())
    .field("language", "language", lsLanguageField())
    .field("deps", "deps", { header: "Deps" })
    .field("descr", "descr", { header: "Description" })
    .field("error", "error", { header: "Err" })
    .field("provenance", "provenance", lsColorPathField("Provenance"))
    .build()
    .ls(true);
}
