import { ensureLanguageByIdOrAlias } from "../../universal/code.ts";
import { EngineTagged, LanguageInitBase } from "../code-shell.ts";

export type SqlInitBase = LanguageInitBase & EngineTagged;
export const sqlLanguage = ensureLanguageByIdOrAlias("sql");
