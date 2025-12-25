// lib/spawn/function-shell.ts
import { ensureLanguageByIdOrAlias } from "../universal/code.ts";
import {
  createLanguageEngine,
  type EngineTagged,
  type LanguageInitBase,
  toStdinBytes,
} from "./code-shell.ts";

export type FunctionInitBase = LanguageInitBase & EngineTagged;

/**
 * A FunctionEngine is a LanguageEngine that executes in-process (no spawning).
 * For now, it mirrors input to stdout and always succeeds.
 */
function createFunctionEngine<const LangId extends string>(langId: LangId) {
  const language = ensureLanguageByIdOrAlias(langId);

  return createLanguageEngine<typeof language, FunctionInitBase>({
    language,
    // Not used for in-process execution; keep a sentinel for symmetry.
    defaultBins: [`<function:${langId}>`],
    // Capabilities exist so mode selection works; all modes are effectively ok.
    capabilities: { stdin: true, file: true, eval: true },
    preferredMode: "stdin",

    // Required by interface, but unused because execute() is present.
    planInvocation: ({ bin }) => ({ argv: [bin], mode: "stdin" }),

    execute: ({ input, mode }) => {
      const stdout = toStdinBytes(input);
      return {
        code: 0,
        success: true,
        stdout,
        stderr: new Uint8Array(),
        argv: [`function:${langId}:${mode}`],
      };
    },
  });
}

// These correspond to LanguageSpec ids in lib/universal/code.ts
export const envEngine = createFunctionEngine("env");
export const envrcEngine = createFunctionEngine("envrc");

export function envInit(
  init: Omit<FunctionInitBase, "engineId"> = {},
): FunctionInitBase {
  return { ...init, engineId: envEngine.id };
}

export function envrcInit(
  init: Omit<FunctionInitBase, "engineId"> = {},
): FunctionInitBase {
  return { ...init, engineId: envrcEngine.id };
}
