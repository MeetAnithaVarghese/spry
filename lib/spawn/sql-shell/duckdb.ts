import {
  createLanguageEngine,
  suggestedSuffixFromLanguage,
  toStdinBytes,
  writeTempSource,
} from "../code-shell.ts";
import { SqlInitBase, sqlLanguage } from "./governance.ts";

export type DuckDbInit = SqlInitBase & {
  /** Database path; use ":memory:" for transient in-memory database. */
  file?: string;
};

export const duckdbEngine = createLanguageEngine<
  typeof sqlLanguage,
  DuckDbInit
>(
  {
    language: sqlLanguage,
    defaultBins: ["duckdb"],
    capabilities: { stdin: true, file: true },
    preferredMode: "stdin",

    planInvocation: async ({ bin, init, input, runtimeArgs, mode }) => {
      const db = init?.file ?? ":memory:";
      const base = [bin, db, ...(runtimeArgs ?? [])];

      if (mode === "stdin") {
        // DuckDB CLI supports non-interactive usage by redirecting stdin:
        //   duckdb < script.sql
        // and also supports explicit :memory: database.
        return { argv: base, stdin: toStdinBytes(input), mode: "stdin" };
      }

      const suffix = suggestedSuffixFromLanguage(input, sqlLanguage, ".sql");
      const sqlFilePath = await writeTempSource(input, suffix);
      return {
        // DuckDB CLI supports `.read <file>` as a dot command.
        argv: [bin, db, `.read ${sqlFilePath}`, ...(runtimeArgs ?? [])],
        cleanupPaths: [sqlFilePath],
        mode: "file",
      };
    },
  },
);

export function duckdbInit(init: Omit<DuckDbInit, "engineId">): DuckDbInit {
  return { ...init, engineId: duckdbEngine.id };
}
