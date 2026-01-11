// lib/spawn/sql-shell/surveilr.ts
import {
  createLanguageEngine,
  suggestedSuffixFromLanguage,
  toStdinBytes,
  writeTempSource,
} from "../code-shell.ts";
import { SqlInitBase, sqlLanguage } from "./governance.ts";

/**
 * surveilr `shell` command init.
 *
 * Mirrors surveilr CLI options (subset), while still allowing callers to pass
 * additional raw CLI args via runtimeArgs.
 */
export type SurveilrShellInit = SqlInitBase & {
  /** -d, --state-db-fs-path */
  stateDbFsPath?: string;

  /** --sqlite-dyn-extn (repeatable) */
  sqliteDynExtn?: readonly string[];

  /** --sqlpkg [<SQLPKG>] */
  sqlpkg?: string;

  /** --engine <ENGINE> */
  surveilrShellEngine?: "rusqlite" | "duckdb" | "rhai";

  /** --cmd <CMD> */
  cmd?: string;

  /** --no-observability */
  noObservability?: boolean;

  /** --output <OUTPUT> */
  output?: "json" | "line" | "table";

  /** --import-env <IMPORT_ENV> */
  importEnv?: string;

  /** --session-state-table-name */
  sessionStateTableName?: string;

  /** --silent */
  silent?: boolean;

  /** --emit-session-id */
  emitSessionId?: boolean;

  /** --rssd-identifier */
  rssdIdentifier?: string;

  /** --rssd-attach-sql-stmt */
  rssdAttachSqlStmt?: string;

  /** --rssd-no-attach */
  rssdNoAttach?: boolean;
};

function buildsurveilrShellArgs(init?: SurveilrShellInit): string[] {
  const args: string[] = ["shell"];

  const pushFlag = (flag: string, on?: boolean) => {
    if (on) args.push(flag);
  };

  const pushOpt = (flag: string, val?: string) => {
    if (val !== undefined && val !== "") args.push(flag, val);
  };

  // Options
  pushOpt("-d", init?.stateDbFsPath);

  for (const ext of init?.sqliteDynExtn ?? []) {
    pushOpt("--sqlite-dyn-extn", ext);
  }

  // sqlpkg can be a bare flag or an option with value; keep it simple as opt.
  pushOpt("--sqlpkg", init?.sqlpkg);

  if (init?.surveilrShellEngine) {
    if (
      init.surveilrShellEngine === "duckdb" ||
      init.surveilrShellEngine == "rusqlite"
    ) {
      pushOpt("--engine", init.surveilrShellEngine);
    } else {
      console.warn(
        new Error("Unknown surveilr --engine: " + init.surveilrShellEngine),
      );
    }
  }

  pushOpt("--cmd", init?.cmd);

  pushFlag("--no-observability", init?.noObservability);
  pushOpt("--output", init?.output);
  pushOpt("--import-env", init?.importEnv);
  pushOpt("--session-state-table-name", init?.sessionStateTableName);

  pushFlag("--silent", init?.silent);
  pushFlag("--emit-session-id", init?.emitSessionId);

  pushOpt("--rssd-identifier", init?.rssdIdentifier);
  pushOpt("--rssd-attach-sql-stmt", init?.rssdAttachSqlStmt);
  pushFlag("--rssd-no-attach", init?.rssdNoAttach);

  return args;
}

export const surveilrShellEngine = createLanguageEngine<
  typeof sqlLanguage,
  SurveilrShellInit
>({
  language: sqlLanguage,
  defaultBins: ["surveilr"],
  capabilities: { stdin: true, file: true },
  preferredMode: "stdin",

  planInvocation: async ({ bin, init, input, runtimeArgs, mode }) => {
    const base = [bin, ...buildsurveilrShellArgs(init), ...(runtimeArgs ?? [])];

    if (mode === "stdin") {
      // surveilr reads SQL from stdin when no SCRIPTS are provided (or when
      // caller wants to pipe SQL directly).
      return { argv: base, stdin: toStdinBytes(input), mode: "stdin" };
    }

    // file mode: write a temp .sql file and pass as a script path argument
    const suffix = suggestedSuffixFromLanguage(input, sqlLanguage, ".sql");
    const sqlFilePath = await writeTempSource(input, suffix);

    return {
      argv: [...base, sqlFilePath],
      cleanupPaths: [sqlFilePath],
      mode: "file",
    };
  },
});

export function SurveilrShellInit(
  init: Omit<SurveilrShellInit, "engineId">,
): SurveilrShellInit {
  return { ...init, engineId: surveilrShellEngine.id };
}
