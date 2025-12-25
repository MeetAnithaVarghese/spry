import {
  createLanguageEngine,
  suggestedSuffixFromLanguage,
  toStdinBytes,
  writeTempSource,
} from "../code-shell.ts";
import { SqlInitBase, sqlLanguage } from "./governance.ts";

export type SqliteInit = SqlInitBase & {
  file?: string;
};

export const sqlite3Engine = createLanguageEngine<
  typeof sqlLanguage,
  SqliteInit
>({
  language: sqlLanguage,
  defaultBins: ["sqlite3"],
  capabilities: { stdin: true, file: true },
  preferredMode: "stdin",

  planInvocation: async ({ bin, init, input, runtimeArgs, mode }) => {
    const db = init?.file ?? ":memory:";
    const base = [bin, db, ...(runtimeArgs ?? [])];

    if (mode === "stdin") {
      return { argv: base, stdin: toStdinBytes(input), mode: "stdin" };
    }

    const suffix = suggestedSuffixFromLanguage(input, sqlLanguage, ".sql");
    const sqlFilePath = await writeTempSource(input, suffix);
    return {
      argv: [bin, db, `.read ${sqlFilePath}`, ...(runtimeArgs ?? [])],
      cleanupPaths: [sqlFilePath],
      mode: "file",
    };
  },
});

export function sqliteInit(init: Omit<SqliteInit, "engineId">): SqliteInit {
  return { ...init, engineId: sqlite3Engine.id };
}
