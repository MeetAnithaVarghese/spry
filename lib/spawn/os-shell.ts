/**
 * os-shell.ts
 *
 * OS command-line shell engines for code-shell.ts.
 *
 * This module defines one or more LanguageEngines that know how to execute shell
 * programs (bash/sh/zsh/fish/PowerShell/cmd) via a consistent invocation model.
 *
 * Design goals:
 * - Keep orchestration in code-shell.ts (mode selection, argv/stdin planning)
 * - Keep process spawning in shell.ts
 * - Provide engine identity tagging (EngineTagged.engineId) for catalog safety
 * - Make it easy for factory.ts to parse YAML and bind a named entry via `using()`
 *
 * Execution modes:
 * - stdin:  shell reads program from stdin (script body piped)
 * - file:   program written to temp file and executed
 * - eval:   program passed via engine-specific “-c/-Command” mode
 *
 * Notes:
 * - “OS shell” here means command-line shells across platforms (POSIX shells
 *   and Windows shells). It is not limited to POSIX semantics.
 * - Some shells differ materially (PowerShell is object-based; cmd is legacy);
 *   this module provides pragmatic defaults that work for common scripting.
 */

import { ensureLanguageByIdOrAlias } from "../universal/code.ts";
import {
  createLanguageEngine,
  defineLanguageInitCatalog,
  type EngineTagged,
  type LanguageInitBase,
  suggestedSuffixFromLanguage,
  toStdinBytes,
  writeTempSource,
} from "./code-shell.ts";

/* -------------------------------- Governance ------------------------------- */

export type OsShellInitBase = LanguageInitBase & EngineTagged & {
  /**
   * Optional descriptive name of the shell (for catalogs / diagnostics only).
   * Execution is determined by the engine used, not this string.
   */
  shell?: string;
};

/**
 * We treat OS shell scripts as a “language” (like SQL) for orchestration.
 * This assumes your code.ts registry has an entry for "shell" (or an alias).
 *
 * If your registry uses a different id/alias, change this to match.
 */
export const shellLanguage = ensureLanguageByIdOrAlias("shell");

/* ------------------------------ Shared utilities --------------------------- */

function normalizeArgvProgramInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof Uint8Array) return new TextDecoder().decode(input);
  return String(input ?? "");
}

function encodeProgram(
  input: { kind: "text"; text: string } | {
    kind: "bytes";
    bytes: Uint8Array;
  },
): Uint8Array {
  return input.kind === "bytes"
    ? input.bytes
    : new TextEncoder().encode(input.text);
}

/* ------------------------------ POSIX shell engines ------------------------ */

export type PosixShellInit = OsShellInitBase & {
  /**
   * Extra argv passed before mode flags (e.g. ["-l"] for login shells).
   * Prefer runtimeArgs in the spawn request when possible.
   */
  flags?: readonly string[];
};

/**
 * Generic POSIX-ish shell engine builder.
 *
 * Implements:
 * - eval:  <bin> ...flags ...runtimeArgs -c <program> -- ...programArgs
 * - stdin: <bin> ...flags ...runtimeArgs -s -- ...programArgs   (program piped)
 * - file:  <bin> ...flags ...runtimeArgs <tempfile> ...programArgs
 */
function createPosixShellEngine(
  init: {
    bins: readonly string[];
    label: string;
    preferredMode?: "stdin" | "eval" | "file";
  },
) {
  return createLanguageEngine<typeof shellLanguage, PosixShellInit>({
    language: shellLanguage,
    defaultBins: init.bins,
    capabilities: { stdin: true, file: true, eval: true },
    preferredMode: init.preferredMode ?? "stdin",

    planInvocation: async (
      { bin, init: cfg, input, runtimeArgs, programArgs, mode },
    ) => {
      const flags = cfg?.flags ?? [];
      const rt = runtimeArgs ?? [];
      const pa = programArgs ?? [];

      if (mode === "eval") {
        const programText = normalizeArgvProgramInput(
          input.kind === "bytes" ? input.bytes : input.text,
        );
        return {
          argv: [bin, ...flags, ...rt, "-c", programText, "--", ...pa],
          mode: "eval",
        };
      }

      if (mode === "stdin") {
        return {
          argv: [bin, ...flags, ...rt, "-s", "--", ...pa],
          stdin: toStdinBytes(input),
          mode: "stdin",
        };
      }

      const suffix = suggestedSuffixFromLanguage(input, shellLanguage, ".sh");
      const scriptPath = await writeTempSource(input, suffix);
      return {
        argv: [bin, ...flags, ...rt, scriptPath, ...pa],
        cleanupPaths: [scriptPath],
        mode: "file",
      };
    },
  });
}

export const shEngine = createPosixShellEngine({
  bins: ["sh"],
  label: "sh",
  preferredMode: "stdin",
});

export const bashEngine = createPosixShellEngine({
  bins: ["bash"],
  label: "bash",
  preferredMode: "stdin",
});

export const zshEngine = createPosixShellEngine({
  bins: ["zsh"],
  label: "zsh",
  preferredMode: "stdin",
});

export const fishEngine = createPosixShellEngine({
  bins: ["fish"],
  label: "fish",
  preferredMode: "stdin",
});

export function posixShellInit(
  engineId: object,
  init: Omit<PosixShellInit, "engineId">,
): PosixShellInit {
  return { ...init, engineId };
}

export function shInit(init: Omit<PosixShellInit, "engineId">): PosixShellInit {
  return posixShellInit(shEngine.id, init);
}
export function bashInit(
  init: Omit<PosixShellInit, "engineId">,
): PosixShellInit {
  return posixShellInit(bashEngine.id, init);
}
export function zshInit(
  init: Omit<PosixShellInit, "engineId">,
): PosixShellInit {
  return posixShellInit(zshEngine.id, init);
}
export function fishInit(
  init: Omit<PosixShellInit, "engineId">,
): PosixShellInit {
  return posixShellInit(fishEngine.id, init);
}

/* ------------------------------ PowerShell engine -------------------------- */

export type PowerShellInit = OsShellInitBase & {
  /**
   * When true, adds -NoProfile and -NonInteractive for predictable automation.
   * Default true.
   */
  harden?: boolean;

  /**
   * If true, bypasses execution policy (Windows). Default true.
   */
  bypassExecutionPolicy?: boolean;

  /**
   * Optional additional flags.
   */
  flags?: readonly string[];
};

/**
 * PowerShell (pwsh) invocation strategies:
 * - eval:  pwsh -Command <program>
 * - stdin: pwsh -Command -   (script piped via stdin)
 * - file:  pwsh -File <temp.ps1>
 */
export const pwshEngine = createLanguageEngine<
  typeof shellLanguage,
  PowerShellInit
>(
  {
    language: shellLanguage,
    defaultBins: ["pwsh", "powershell"],
    capabilities: { stdin: true, file: true, eval: true },
    preferredMode: "stdin",

    planInvocation: async (
      { bin, init, input, runtimeArgs, programArgs, mode },
    ) => {
      const harden = init?.harden ?? true;
      const bypass = init?.bypassExecutionPolicy ?? true;
      const flags = init?.flags ?? [];
      const rt = runtimeArgs ?? [];
      const pa = programArgs ?? [];

      const base = [
        bin,
        ...(harden ? ["-NoProfile", "-NonInteractive"] : []),
        ...(bypass ? ["-ExecutionPolicy", "Bypass"] : []),
        ...flags,
        ...rt,
      ];

      if (mode === "eval") {
        const programText = normalizeArgvProgramInput(
          input.kind === "bytes" ? input.bytes : input.text,
        );
        // Program args are exposed via $args in PowerShell; we append them after --.
        return {
          argv: [...base, "-Command", programText, "--", ...pa],
          mode: "eval",
        };
      }

      if (mode === "stdin") {
        // -Command - reads commands from stdin.
        return {
          argv: [...base, "-Command", "-", "--", ...pa],
          stdin: encodeProgram(input),
          mode: "stdin",
        };
      }

      const suffix = suggestedSuffixFromLanguage(input, shellLanguage, ".ps1");
      const scriptPath = await writeTempSource(input, suffix);
      return {
        argv: [...base, "-File", scriptPath, ...pa],
        cleanupPaths: [scriptPath],
        mode: "file",
      };
    },
  },
);

export function pwshInit(
  init: Omit<PowerShellInit, "engineId">,
): PowerShellInit {
  return { ...init, engineId: pwshEngine.id };
}

/* ------------------------------ Windows cmd.exe engine --------------------- */

export type CmdInit = OsShellInitBase & {
  /**
   * Optional additional cmd.exe switches (rare).
   * Example: ["/Q"].
   */
  flags?: readonly string[];
};

/**
 * cmd.exe strategies:
 * - eval:  cmd /C <program>
 * - stdin: (not well-defined for cmd scripting) implemented as eval with piped content
 * - file:  cmd /C <temp.cmd>  (or .bat)
 */
export const cmdEngine = createLanguageEngine<typeof shellLanguage, CmdInit>({
  language: shellLanguage,
  defaultBins: ["cmd"],
  capabilities: { file: true, eval: true, stdin: true },
  preferredMode: "eval",

  planInvocation: async (
    { bin, init, input, runtimeArgs, programArgs, mode },
  ) => {
    const flags = init?.flags ?? [];
    const rt = runtimeArgs ?? [];
    const pa = programArgs ?? [];

    const base = [bin, ...flags, ...rt];

    if (mode === "eval" || mode === "stdin") {
      // cmd's stdin scripting is messy; treat stdin as "eval" by decoding.
      const programText = normalizeArgvProgramInput(
        input.kind === "bytes" ? input.bytes : input.text,
      );
      return { argv: [...base, "/C", programText, ...pa], mode: "eval" };
    }

    const suffix = suggestedSuffixFromLanguage(input, shellLanguage, ".cmd");
    const scriptPath = await writeTempSource(input, suffix);
    return {
      argv: [...base, "/C", scriptPath, ...pa],
      cleanupPaths: [scriptPath],
      mode: "file",
    };
  },
});

export function cmdInit(init: Omit<CmdInit, "engineId">): CmdInit {
  return { ...init, engineId: cmdEngine.id };
}

/* ------------------------------ Catalog helpers ---------------------------- */

/**
 * Optional helper for defining typed OS-shell catalogs (mirrors sql-shell usage).
 */
export function defineOsShellCatalog<
  const M extends Record<string, OsShellInitBase>,
>(
  m: M,
): M {
  return defineLanguageInitCatalog(m);
}
